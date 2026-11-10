#!/usr/bin/env bash
# Applies every migration in supabase/migrations to an EMPTY database, in
# version order, then runs every supabase/tests/*.sql file against the result.
#
# No other automated check executes SQL: elsewhere the migrations, their
# in-file DO $verify$ blocks and the supabase/tests harnesses are only read
# as text, and a migration that reads correctly can still behave wrongly.
#
# Target: a throwaway supabase/postgres container (the image the stacks run),
# reached over TCP. Never point it at a real database: the tests roll back,
# but the migrations and the bootstrap do not.
#
#   docker run -d --name zero-db -p 54399:5432 -e POSTGRES_PASSWORD=postgres \
#     public.ecr.aws/supabase/postgres:17.6.1.167
#   DB_PORT=54399 .github/ci/migrations-from-zero.sh
#
# Environment: DB_HOST (127.0.0.1), DB_PORT (5432), DB_PASSWORD (postgres).
#
# Wrapping follows scripts/db-migrate.sh exactly: a file with a top-level
# COMMIT manages its own transaction, any other file is applied with
# --single-transaction, and ON_ERROR_STOP is always on. Unlike the runner, no
# schema_migrations row is written; nothing here reads them.
set -euo pipefail

cd "$(dirname "$0")/../.."

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
export PGPASSWORD="${DB_PASSWORD:-postgres}"

run_psql() { # role database [psql args...]
  local role="$1" database="$2"
  shift 2
  psql -X -q -h "$DB_HOST" -p "$DB_PORT" -U "$role" -d "$database" -v ON_ERROR_STOP=1 "$@"
}

# Refuse anything that already holds the schema: an empty database is the
# whole premise, and a real one must never be written to by this script.
if [ "$(run_psql postgres postgres -tAc "SELECT to_regclass('public.players') IS NOT NULL;")" = "t" ]; then
  echo "FATAL: public.players already exists on $DB_HOST:$DB_PORT. This script only runs against an empty database." >&2
  exit 1
fi

echo "== bootstrap (stand-ins for the storage and auth services)"
run_psql supabase_admin postgres --single-transaction -f .github/ci/from-zero-bootstrap.sql

echo "== migrations"
applied=0
# LC_ALL=C puts 00161_ before 00161b_, the order the manifest uses.
while IFS= read -r file; do
  if grep -qiE '^[[:space:]]*COMMIT[[:space:]]*;' "$file"; then
    wrap=()
  else
    wrap=(--single-transaction)
  fi
  # The ${wrap[@]+...} form expands an empty array safely under set -u on bash 3.2.
  if ! output="$(run_psql postgres postgres ${wrap[@]+"${wrap[@]}"} -f "$file" 2>&1)"; then
    echo "FAILED: $(basename "$file")" >&2
    echo "$output" >&2
    exit 1
  fi
  applied=$((applied + 1))
done < <(find supabase/migrations -maxdepth 1 -name '*.sql' | LC_ALL=C sort)
echo "applied $applied migrations"

echo "== supabase/tests"
# Files that build their own schema from nothing instead of testing the
# migrated one. Each gets a fresh, empty database of its own.
standalone_tests=" 00110_checkin_equivalence.sql "
failed=0
passed=0
while IFS= read -r test; do
  name="$(basename "$test")"
  database=postgres
  if [[ "$standalone_tests" == *" $name "* ]]; then
    database="standalone_${name%%_*}"
    run_psql supabase_admin postgres -c "DROP DATABASE IF EXISTS $database" -c "CREATE DATABASE $database OWNER postgres"
  fi
  if output="$(run_psql postgres "$database" -f "$test" 2>&1)"; then
    echo "PASS $name"
    passed=$((passed + 1))
  else
    echo "FAIL $name" >&2
    echo "$output" | grep -E 'ERROR|DETAIL|CONTEXT' >&2 || echo "$output" >&2
    failed=$((failed + 1))
  fi
done < <(find supabase/tests -maxdepth 1 -name '*.sql' | LC_ALL=C sort)

echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
