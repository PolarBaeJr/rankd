// Migration 00296, read as text. What matters: only the service role reaches
// the table and the function; a deleted event or binding nulls its column and
// never takes the row; nothing points at a player; and the job reads
// cron_config by key, never the whole table (it holds reminder_secret).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(__dirname, '..', '..', '..', '..', '..', 'supabase', 'migrations', '00296_the_console_makes_the_forms.sql'),
  'utf8',
);
// Comments say what the code does not, so they are left out of the checks.
const CODE = SQL.replace(/--.*$/gm, '');

describe('00296', () => {
  it('runs in one transaction and reloads PostgREST', () => {
    expect(CODE).toMatch(/^\s*BEGIN;/m);
    expect(CODE).toMatch(/^\s*COMMIT;/m);
    expect(CODE).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });

  it('gives the table to the service role alone, with RLS on', () => {
    expect(CODE).toMatch(/ALTER TABLE public\.managed_registration_forms ENABLE ROW LEVEL SECURITY/);
    expect(CODE).toMatch(
      /REVOKE ALL ON public\.managed_registration_forms FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(CODE).toMatch(/GRANT SELECT, INSERT, UPDATE ON public\.managed_registration_forms TO service_role;/);
    expect(CODE).not.toMatch(/GRANT[^;]*managed_registration_forms[^;]*TO[^;]*\b(anon|authenticated)\b/);
    expect(CODE).not.toMatch(/GRANT[^;]*DELETE[^;]*managed_registration_forms/);
  });

  it('nulls a deleted target or binding instead of taking the row', () => {
    for (const ref of ['club_events', 'tournaments', 'registration_import_forms']) {
      expect(CODE).toMatch(new RegExp(`REFERENCES public\\.${ref}\\(id\\) ON DELETE SET NULL`));
    }
    expect(CODE).not.toMatch(/ON DELETE CASCADE/);
    // The target check must let a nulled target stand, or the delete itself fails.
    const check = CODE.slice(CODE.indexOf('managed_registration_forms_one_target'));
    expect(check.slice(0, check.indexOf('),'))).toMatch(/num_nonnulls\(club_event_id, tournament_id\) <= 1/);
    expect(CODE).not.toMatch(/club_event_id\s+uuid[^,]*NOT NULL/);
    expect(CODE).not.toMatch(/tournament_id\s+uuid[^,]*NOT NULL/);
  });

  it('points at no player', () => {
    expect(CODE).not.toMatch(/REFERENCES public\.players/);
    expect(CODE).not.toMatch(/REFERENCES auth\.users/);
  });

  it('the accepting check is the service role\'s, definer and pinned', () => {
    expect(CODE).toMatch(
      /REVOKE ALL ON FUNCTION public\.registration_form_accepting\(text, uuid, boolean\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(CODE).toMatch(/GRANT EXECUTE ON FUNCTION public\.registration_form_accepting\(text, uuid, boolean\) TO service_role;/);
    const fn = CODE.slice(CODE.indexOf('FUNCTION public.registration_form_accepting'));
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path TO 'public', 'pg_temp'/);
  });

  it('the job reads cron_config by key only', () => {
    const reads = CODE.match(/FROM cron_config[^)]*/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read).toMatch(/WHERE key = '/);
    expect(CODE).toMatch(/\/api\/cron\/managed-form-sync/);
  });
});
