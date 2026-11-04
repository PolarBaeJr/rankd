import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00315: CHECK-IN KEEPS GOING AFTER THE DRAW, AND THE DRAW TAKES ONLY WHO IS HERE.
 *
 * publish_stage_draw's stage-1 field follows drawField, and the undo of a
 * check-in or a no-show is taken from check-in until the event is completed.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');
// Up to 00315 only: 00318 restates all three behind the check_in_after_draw
// kill switch, and release-flag-migration.test.ts holds that version.
const migrationFiles = () => readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f) && f < '00316').sort();

/** The latest CREATE of a function across the directory, body bounded by its own dollar tag. */
function latestBody(name: string): { file: string; body: string } | null {
  let found: { file: string; body: string } | null = null;
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const head = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = head.exec(sql)) !== null) {
      const open = /\bAS\s+(\$[a-z_]*\$)/i.exec(sql.slice(match.index));
      if (!open) continue;
      const bodyStart = match.index + open.index + open[0].length;
      const bodyEnd = sql.indexOf(open[1]!, bodyStart);
      if (bodyEnd !== -1) found = { file, body: sql.slice(bodyStart, bodyEnd) };
    }
  }
  return found;
}

const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const migration = () => readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith('00315_'))!), 'utf8');

describe('00315: publish_stage_draw', () => {
  const latest = latestBody('publish_stage_draw');
  const code = stripComments(latest?.body ?? '');

  it('is restated last by 00315', () => {
    expect(latest?.file).toMatch(/^00315_/);
  });

  it('counts only the checked-in as the field once anybody has checked in, for pairs and players', () => {
    expect(code.match(/v_uses_checkin := EXISTS/g)).toHaveLength(2);
    expect(code.match(/status::TEXT = 'checked_in' OR \(NOT v_uses_checkin AND status::TEXT = 'registered'\)/g)).toHaveLength(4);
  });

  it('still refuses a drawn entrant who has left, by registered or checked_in', () => {
    expect(code.match(/status::TEXT IN \('registered', 'checked_in'\)\);/g)).toHaveLength(2);
    expect(code).toContain("'entrant_left'");
  });
});

describe('00315: the undo past the draw', () => {
  for (const name of ['set_field_entry_status', 'set_pair_member_check_in']) {
    const latest = latestBody(name);
    const code = stripComments(latest?.body ?? '');

    it(`${name} is restated last by 00315`, () => {
      expect(latest?.file).toMatch(/^00315_/);
    });

    it(`${name} refuses the undo only before check-in opens`, () => {
      expect(code).not.toContain("v_status <> 'checkin'");
      expect(code).toMatch(/IF v_status = 'registration' THEN\s+RETURN jsonb_build_object\('ok', FALSE, 'reason', 'event_status'/);
      expect(code).toContain("'event_completed'");
      expect(code).toContain("'not_undoable'");
    });

    it(`${name} keeps the self check-in window and the field lock`, () => {
      expect(code).toContain("'checkin_window_closed'");
      expect(code).toContain("pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text))");
    });
  }
});

describe('00315: grants and text', () => {
  const sql = migration();

  it('keeps every function service_role only', () => {
    for (const sig of [
      'publish_stage_draw(uuid, smallint, uuid, boolean, uuid[], jsonb, jsonb)',
      'set_field_entry_status(uuid, boolean, text, uuid)',
      'set_pair_member_check_in(uuid, smallint, boolean, uuid)',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });

  it('has no top-level COMMIT and no em dash', () => {
    expect(sql).not.toMatch(/^COMMIT;/m);
    expect(sql).not.toContain('\u2014');
  });
});
