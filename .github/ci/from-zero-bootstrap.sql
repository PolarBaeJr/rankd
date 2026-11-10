-- ============================================================
-- Bootstrap for applying the migrations to an empty database.
--
-- The supabase/postgres image ships the roles, the auth schema's core tables
-- and the auth.uid()/auth.role() helpers. The storage tables and
-- auth.identities are created by the storage and auth services in a real
-- stack, and those services do not run in CI. This file creates stand-ins
-- with the columns the migrations reference, so that a migration that adds a
-- bucket or a storage policy can apply. It is not a copy of either service's
-- schema, and nothing outside CI should run it.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS storage;
GRANT USAGE ON SCHEMA storage TO postgres, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL UNIQUE,
  owner              uuid,
  owner_id           text,
  public             boolean DEFAULT false,
  avif_autodetection boolean DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id        text REFERENCES storage.buckets (id),
  name             text,
  owner            uuid,
  owner_id         text,
  metadata         jsonb,
  user_metadata    jsonb,
  version          text,
  path_tokens      text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name, '/'))[1:greatest(cardinality(string_to_array(name, '/')) - 1, 0)]
$$;
CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name, '/'))[cardinality(string_to_array(name, '/'))]
$$;
CREATE OR REPLACE FUNCTION storage.extension(name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT reverse(split_part(reverse(storage.filename(name)), '.', 1))
$$;

GRANT ALL ON ALL TABLES IN SCHEMA storage TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA storage TO anon, authenticated;

CREATE TABLE IF NOT EXISTS auth.identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     text NOT NULL,
  user_id         uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  identity_data   jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider        text NOT NULL,
  email           text GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED,
  last_sign_in_at timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE (provider_id, provider)
);
GRANT ALL ON auth.identities TO postgres, service_role;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

-- The database-webhooks schema a full stack creates. 00131 revokes anon's
-- grants on its three relations; it holds no rows anywhere.
CREATE SCHEMA IF NOT EXISTS supabase_functions;
CREATE TABLE IF NOT EXISTS supabase_functions.migrations (
  version     text PRIMARY KEY,
  inserted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS supabase_functions.hooks (
  id                bigserial PRIMARY KEY,
  hook_table_id     integer NOT NULL,
  hook_name         text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  request_id        bigint
);
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_functions_admin') THEN
    CREATE ROLE supabase_functions_admin NOLOGIN NOINHERIT;
  END IF;
END
$roles$;
GRANT supabase_functions_admin TO postgres;
ALTER SCHEMA supabase_functions OWNER TO supabase_functions_admin;
ALTER TABLE supabase_functions.migrations OWNER TO supabase_functions_admin;
ALTER TABLE supabase_functions.hooks OWNER TO supabase_functions_admin;
GRANT USAGE ON SCHEMA supabase_functions TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA supabase_functions TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA supabase_functions TO postgres, anon, authenticated, service_role;
