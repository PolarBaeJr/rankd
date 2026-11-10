import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The staging snapshot copies prod's members into staging and scrubs them.
// Source-text pins on the parts that fail OPEN when they are wrong: the file
// mode of the dumps, the wipe on failure, and the scrub's newer tables. The
// script is not part of every checkout, so this skips without it.

const SCRIPT = join(__dirname, '../../../../..', 'scripts/prod-to-dev-snapshot.sh');
const present = existsSync(SCRIPT);
const src = present ? readFileSync(SCRIPT, 'utf8') : '';

/** True when some occurrence of `guard` is followed directly by `statement`. */
function guardedBy(guard: string, statement: string): boolean {
  for (let at = src.indexOf(guard); at !== -1; at = src.indexOf(guard, at + 1)) {
    if (src.slice(at + guard.length).trimStart().startsWith(statement)) return true;
  }
  return false;
}
const tableGuard = (table: string) => `to_regclass('public.${table}') IS NOT NULL THEN`;
const columnGuard = (table: string, column: string) => `table_name = '${table}' AND column_name = '${column}') THEN`;

describe.skipIf(!present)('the staging snapshot script', () => {
  it('sets umask 077 before it creates any directory or file', () => {
    const umask = src.search(/^umask 077$/m);
    expect(umask, 'no umask 077').toBeGreaterThan(-1);
    expect(umask).toBeLessThan(src.search(/^\s*mkdir /m));
    expect(umask).toBeLessThan(src.indexOf('mktemp'));
  });

  it('refuses one database under two names', () => {
    expect(src).toContain('if [ "$PROD_CONTAINER" = "$DEV_CONTAINER" ]; then');
    expect(src).toContain('SELECT system_identifier FROM pg_control_system();');
    expect(src.indexOf('pg_control_system')).toBeLessThan(src.indexOf('pg_dump -U postgres'));
  });

  it('wipes one table per psql call on failure, each guarded, and counts every failure', () => {
    const wipeCalls = [...src.matchAll(/-c \\\s*\n\s*"([^"]*TRUNCATE[^"]*)"/g)].map((m) => m[1]!);
    expect(wipeCalls.length, 'no wipe call found').toBeGreaterThan(0);
    for (const call of wipeCalls) {
      expect(call.match(/TRUNCATE/g), call).toHaveLength(1);
      expect(call, call).toContain('to_regclass(');
    }
    expect(src).toMatch(/\|\| wipe_failed=1/);
    for (const table of [
      'public.players',
      'auth.identities',
      'auth.users',
      'public.guest_waiver_signings',
      'public.email_suppressions',
      'public.discord_signup_drafts',
      'public.club_event_external_signups',
      'public.guest_waiver_invites',
      'public.registration_import_receipts',
      'public.registration_import_entries',
      'public.registration_imports',
      'public.registration_import_forms',
    ]) {
      expect(src, table).toMatch(new RegExp(`^\\s*wipe_table ${table.replace('.', '\\.')}$`, 'm'));
    }
  });

  it('reports a failed wipe as a failure, not as "holds no real data"', () => {
    const wiped = src.indexOf('holds no real data');
    const check = src.lastIndexOf('if [ "$wipe_failed" = "0" ]', wiped);
    expect(check, 'the success alert is not behind wipe_failed').toBeGreaterThan(-1);
    expect(src.slice(check, wiped)).not.toMatch(/\bfi\b/);
  });

  it('scrubs each newer table inside a guard', () => {
    for (const [table, statement] of [
      ['discord_signup_drafts', 'DELETE FROM public.discord_signup_drafts;'],
      ['discord_feedback_posts', "UPDATE public.discord_feedback_posts SET synced_summary = 'scrubbed'"],
      ['discord_match_posts', "UPDATE public.discord_match_posts SET synced_summary = 'scrubbed'"],
      ['event_feedback', 'UPDATE public.event_feedback SET comment = NULL'],
      ['tournament_category_requests', "UPDATE public.tournament_category_requests SET reason = 'scrubbed'"],
      ['tournament_event_waitlist', 'UPDATE public.tournament_event_waitlist SET reason = NULL'],
      ['data_api_keys', 'UPDATE public.data_api_keys'],
      ['data_api_consumers', 'UPDATE public.data_api_consumers SET player_ref_salt = DEFAULT;'],
      ['cron_config', 'DELETE FROM public.cron_config\n     WHERE key NOT IN'],
    ] as const) {
      expect(guardedBy(tableGuard(table), statement), table).toBe(true);
    }
    expect(
      guardedBy(columnGuard('tournaments', 'suspension_reason'), 'EXECUTE $q$UPDATE public.tournaments SET suspension_reason = NULL'),
    ).toBe(true);
    expect(
      guardedBy(columnGuard('players', 'exec_photo_url'), 'EXECUTE $q$UPDATE public.players SET exec_photo_url = NULL'),
    ).toBe(true);
    expect(src).toContain("SET key_hash = 'staging-scrubbed-' || id::text");
    expect(src).toContain('UPDATE public.data_api_consumers SET player_ref_salt = DEFAULT;');
    expect(src).toContain("WHERE key NOT IN ('admin_url', 'reminder_secret', 'discord_bot_url', 'discord_service_secret');");
  });

  it('has no em dash', () => {
    expect(src).not.toContain('\u2014');
  });
});
