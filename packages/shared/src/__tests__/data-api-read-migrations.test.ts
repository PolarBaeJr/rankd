import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_API_SCOPES } from '../utils/data-api-key';

// 00264 TO 00267, 00270 AND 00277, READ OFF DISK. The data API's read surface is a set
// of SECURITY DEFINER functions, which run as their owner and so bypass every
// grant and policy the reader role would otherwise meet. What they return is
// therefore the whole privacy boundary, and these properties pin it: a later
// edit that widens a grant, reads around the one match gate or selects a
// free-text column fails here before it reaches a database.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const scopes = migration('00264_');
const predictions = migration('00282_');
const formImport = migration('00283_');
const history = migration('00265_');
const schedule = migration('00266_');
const header = migration('00267_');
const external = migration('00270_');
const staged = migration('00277_');
const both = `${history}\n${schedule}\n${header}\n${external}\n${staged}`;

/**
 * The body of one CREATE FUNCTION, from its header to the closing tag. The
 * LAST definition, since that is the one a database ends up with.
 */
function functionBody(name: string): string {
  const start = both.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThan(-1);
  const end = both.indexOf('$function$;', start);
  return both.slice(start, end);
}

/** SQL with comments, COMMENT ON statements and the verify blocks removed. */
function code(sql: string): string {
  return sql
    .replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, '')
    .replace(/DO \$verify\$[\s\S]*?\$verify\$;/g, '')
    .replace(/--[^\n]*/g, '');
}

const PUBLIC_FUNCTIONS: Record<string, string> = {
  data_api_active_season: 'uuid',
  data_api_matches:
    'uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean, text, timestamptz, int, int',
  data_api_match_by_ref: 'uuid, text',
  data_api_player_published: 'uuid, text',
  data_api_head_to_head: 'uuid, text, text, text, uuid',
  data_api_player_seasons: 'uuid, text',
  data_api_rating_history: 'uuid, text, text, uuid, timestamptz, timestamptz, int, int',
  data_api_seasons: 'uuid, uuid',
  data_api_season_standings: 'uuid, uuid',
  data_api_season_header: 'uuid, uuid',
  data_api_tournaments: 'uuid, uuid, uuid',
  data_api_tournament_events: 'uuid, uuid',
  data_api_tournament_entrants: 'uuid, uuid',
  data_api_tournament_draw: 'uuid, uuid',
  data_api_tournament_events_v2: 'uuid, uuid',
  data_api_tournament_entrants_v2: 'uuid, uuid',
  data_api_tournament_draw_v2: 'uuid, uuid',
  data_api_sessions: 'uuid, timestamptz, timestamptz',
  data_api_club_events: 'uuid, timestamptz, timestamptz',
};

const INTERNAL_FUNCTIONS: Record<string, string> = {
  data_api_published_player: 'uuid',
  data_api_visible_season: 'uuid',
  data_api_match_ref: 'uuid, text, uuid',
  data_api_resolve_ref: 'uuid, text',
  data_api_tournament_match_players: 'uuid',
  data_api_tournament_match_publishable: 'uuid',
  data_api_match_rows: '',
  data_api_sides: 'uuid, jsonb, boolean',
  data_api_external_ref: 'uuid, uuid',
  data_api_draw_side: 'uuid, uuid, text',
};

describe('00264, 00282 and 00283: the scope vocabulary', () => {
  // 00283 restates the CHECK with `registrations:write`, so it is the one a
  // database ends up with.
  it('admits exactly DATA_API_SCOPES, in order', () => {
    const check = /ADD CONSTRAINT data_api_keys_scope_vocabulary\s+CHECK \(scopes <@ ARRAY\[([^\]]+)\]/.exec(formImport);
    expect(check).not.toBeNull();
    const admitted = [...check![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(admitted).toEqual([...DATA_API_SCOPES]);
  });

  it('leaves the not-empty constraint alone', () => {
    expect(code(scopes)).not.toContain('data_api_keys_scope_not_empty');
  });
});

describe('00265 to 00277: every data API read function', () => {
  const all = { ...PUBLIC_FUNCTIONS, ...INTERNAL_FUNCTIONS };

  for (const [name, args] of Object.entries(all)) {
    it(`${name} is SECURITY DEFINER with a pinned search_path`, () => {
      const body = functionBody(name);
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
    });

    it(`${name} is revoked from PUBLIC, anon and authenticated`, () => {
      expect(both).toContain(`REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC, anon, authenticated;`);
    });
  }

  for (const [name, args] of Object.entries(PUBLIC_FUNCTIONS)) {
    it(`${name} is granted to data_api_reader and nobody else`, () => {
      // 00270 recreates three of them and grants again, so a function may be
      // granted more than once, but always the same thing to the same role.
      const grants = [...both.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\) TO (\\w+);`, 'g'))];
      expect(grants.length).toBeGreaterThan(0);
      expect([...new Set(grants.map((g) => `${g[1]} TO ${g[2]}`))]).toEqual([`${args} TO data_api_reader`]);
    });

    it(`${name} takes the consumer id first`, () => {
      expect(functionBody(name)).toMatch(new RegExp(`FUNCTION public\\.${name}\\(\\s*p_consumer_id uuid`));
    });
  }

  for (const name of Object.keys(INTERNAL_FUNCTIONS)) {
    it(`${name} is granted to nobody`, () => {
      expect(code(both)).not.toMatch(new RegExp(`GRANT[^;]*public\\.${name}\\(`));
    });
  }

  it('grants nothing on any table or view', () => {
    expect(code(both)).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i);
  });

  it('uses the built-in sha256, never pgcrypto', () => {
    expect(code(both)).not.toMatch(/\bdigest\s*\(|pgcrypto|extensions\./i);
  });
});

describe('the one gate', () => {
  const MATCH_READERS = [
    'data_api_matches',
    'data_api_match_by_ref',
    'data_api_head_to_head',
    'data_api_player_seasons',
    'data_api_rating_history',
    'data_api_seasons',
    'data_api_season_standings',
  ];

  for (const name of MATCH_READERS) {
    it(`${name} reads matches only through data_api_match_rows()`, () => {
      const body = code(functionBody(name));
      expect(body).toContain('data_api_match_rows()');
      expect(body).not.toMatch(/\bFROM\s+(public\.)?(matches|match_participants|tournament_matches)\b/i);
      expect(body).not.toMatch(/\bJOIN\s+(public\.)?(matches|match_participants|tournament_matches)\b/i);
    });
  }

  it('the gate keeps a club match only when every participant is published', () => {
    const body = code(functionBody('data_api_match_rows'));
    expect(body).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM match_participants[\s\S]*?NOT data_api_published_player/);
    expect(body).toContain('data_api_tournament_match_publishable(tm.id)');
    expect(body.match(/data_api_visible_season\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  for (const name of ['data_api_tournament_draw', 'data_api_tournament_draw_v2']) {
    it(`${name} withholds a slot the gate would drop`, () => {
      const body = code(functionBody(name));
      expect(body).toContain('data_api_tournament_match_publishable');
      expect(body).toMatch(/withheld/);
    });
  }

  it('the history test is the two privacy controls and the approval check', () => {
    const body = code(functionBody('data_api_published_player'));
    expect(body).toContain('p.hide_from_leaderboard = FALSE');
    expect(body).toContain('p.deletion_requested_at IS NULL');
    expect(body).toContain("p.status <> 'pending_approval'");
  });

  it('the standings keep 00241\'s roster test', () => {
    const body = code(functionBody('data_api_season_standings'));
    for (const clause of [
      'p.active_flag = TRUE',
      "p.status NOT IN ('pending_approval', 'suspended')",
      'p.hide_from_leaderboard = FALSE',
      'p.deletion_requested_at IS NULL',
    ]) {
      expect(body).toContain(clause);
    }
  });
});

describe('00270: external teams', () => {
  it('every function 00270 drops is recreated and revoked in the same file', () => {
    const dropped = [...external.matchAll(/DROP FUNCTION IF EXISTS public\.(\w+)\(([^)]*)\);/g)];
    expect(dropped.length).toBeGreaterThan(0);
    for (const [, name, args] of dropped) {
      expect(external).toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
      expect(external).toContain(`REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC, anon, authenticated;`);
    }
  });

  it('an external ref is tagged apart from player and match refs', () => {
    const body = code(functionBody('data_api_external_ref'));
    expect(body).toContain("':x:'");
    expect(body).toContain('sha256(');
  });

  for (const name of ['data_api_tournament_draw', 'data_api_tournament_draw_v2']) {
    it(`${name} still withholds by the match gate outside an external event`, () => {
      const body = code(functionBody(name));
      expect(body).toMatch(/NOT te\.external_event AND NOT data_api_tournament_match_publishable\(tm\.id\)/);
      expect(body).toContain("tm.status = 'disputed'");
    });
  }

  it('the match gate is not touched, so external matches stay out of history', () => {
    expect(code(external)).not.toContain('FUNCTION public.data_api_match_rows(');
    expect(code(external)).not.toContain('FUNCTION public.data_api_tournament_match_publishable(');
  });
});

describe('00277: staged draws', () => {
  it('never reads format_config whole, only a path into it', () => {
    const uses = [...code(staged).matchAll(/format_config/g)];
    expect(uses.length).toBeGreaterThan(0);
    expect(code(staged)).not.toMatch(/format_config(?!\s*(->|#>))/);
  });

  it('never names a stage\'s courts or a court id', () => {
    expect(code(staged)).not.toContain("'courts'");
    expect(code(staged)).not.toMatch(/court_id/i);
  });

  it('withholds the head starts of a withheld slot', () => {
    const body = code(functionBody('data_api_tournament_draw_v2'));
    expect(body).toContain('CASE WHEN x.withheld THEN NULL ELSE tm.handicap_a::int END');
    expect(body).toContain('CASE WHEN x.withheld THEN NULL ELSE tm.handicap_b::int END');
  });

  it('changes nothing in the match gate but the bracket keys', () => {
    const before = code(history.slice(history.indexOf('CREATE OR REPLACE FUNCTION public.data_api_match_rows(')))
      .split('$function$;')[0];
    const after = code(functionBody('data_api_match_rows'));
    const added = "'is_third_place', tm.is_third_place,\n      'stage', tm.stage,\n      'match_label', tm.match_label,\n      'handicap_a', tm.handicap_a,\n      'handicap_b', tm.handicap_b\n";
    expect(after).toBe(before!.replace("'is_third_place', tm.is_third_place\n", added));
  });
});

describe('no identity, no free text', () => {
  // Columns that name a member, or that hold text a person wrote. None may be
  // selected by any function in these files. Comments that name them as NOT
  // served are stripped before the scan.
  const FORBIDDEN = [
    'full_name',
    'first_name',
    'last_name',
    'display_name',
    'email',
    'phone',
    'discord_id',
    'discord_username',
    'avatar_url',
    'student_number',
    'member_code',
    'notes',
    'walkover_reason',
    'suspension_reason',
    'cancelled_reason',
    'pair_name',
    'court',
    'description',
    'waiver_text',
    'external1_name',
    'external2_name',
    // The form import (00283, 00284) keeps typed names and emails for people
    // who are not members. No read function may serve any of them.
    'manual_name',
    'manual_email',
    'submitter_name',
    'submitter_email',
    'external_name',
    'external_email',
    'partner_name',
    'partner_email',
    'registration_imports',
    'registration_import_entries',
    'registration_import_forms',
    'guest_waiver_invites',
    'club_event_external_signups',
  ];

  for (const column of FORBIDDEN) {
    it(`never reads ${column}`, () => {
      expect(code(both)).not.toMatch(new RegExp(`\\b${column}\\b`, 'i'));
    });
  }

  it('never returns a raw player id from a public function', () => {
    for (const name of Object.keys(PUBLIC_FUNCTIONS)) {
      const header = functionBody(name).split('AS $function$')[0]!;
      expect(header, name).not.toMatch(/\bplayer_id\b|\bplayer1_id\b|\bplayer2_id\b/);
    }
  });
});

describe('00282: predictions', () => {
  const sql = code(predictions);

  function body(name: string): string {
    const start = predictions.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} is not defined`).toBeGreaterThan(-1);
    return predictions.slice(start, predictions.indexOf('$function$;', start));
  }

  const GRANTED: Record<string, [string, string]> = {
    data_api_write_predictions: ['text, jsonb', 'data_api_reader'],
    data_api_delete_predictions: ['text, jsonb', 'data_api_reader'],
    get_matchup_prediction: ['text, uuid[], uuid[]', 'authenticated'],
    get_my_predictions: ['', 'authenticated'],
  };

  for (const [name, [args, role]] of Object.entries(GRANTED)) {
    it(`${name} is SECURITY DEFINER, revoked from everyone and granted to ${role} alone`, () => {
      expect(body(name)).toContain('SECURITY DEFINER');
      expect(body(name)).toContain("SET search_path TO 'public', 'pg_temp'");
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC, anon, authenticated;`);
      const grants = [...sql.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\) TO (\\w+);`, 'g'))];
      expect(grants.map((g) => `${g[1]} TO ${g[2]}`)).toEqual([`${args} TO ${role}`]);
    });
  }

  it('grants the ref map and the purge trigger to nobody', () => {
    expect(sql).not.toMatch(/GRANT[^;]*public\.data_api_ref_map\(/);
    expect(sql).not.toMatch(/GRANT[^;]*public\.data_api_predictions_forget_player\(/);
  });

  it('lets no client role touch the table, and service_role only read it', () => {
    expect(sql).toContain('REVOKE ALL ON public.data_api_predictions FROM PUBLIC, anon, authenticated, service_role;');
    const grants = [...sql.matchAll(/GRANT\s+(\w+)\s+ON\s+public\.data_api_predictions\s+TO\s+(\w+)/g)];
    expect(grants.map((g) => `${g[1]} TO ${g[2]}`)).toEqual(['SELECT TO service_role']);
  });

  it('takes the key HASH in the write and the delete, never a consumer id', () => {
    for (const name of ['data_api_write_predictions', 'data_api_delete_predictions']) {
      expect(body(name)).toMatch(new RegExp(`FUNCTION public\\.${name}\\(p_key_hash text,`));
      expect(body(name)).toContain("'predictions:write' = ANY");
      expect(body(name)).toContain('revoked_at IS NULL');
    }
  });

  it('re-checks that every named player is published in both member reads', () => {
    expect(body('get_matchup_prediction')).toContain('data_api_published_player(');
    expect(body('get_my_predictions')).toContain('data_api_published_player(');
  });

  it('answers a member only for a matchup they play in', () => {
    const matchup = body('get_matchup_prediction');
    expect(matchup).toContain('get_player_id(auth.uid())');
    expect(matchup).toContain('me.id IS NOT NULL');
    expect(matchup).toContain('me.id = ANY (s.a || s.b)');
    const mine = body('get_my_predictions');
    expect(mine).toContain('get_player_id(auth.uid())');
    expect(mine).toContain('me.id IN (d.side1_p1, d.side1_p2, d.side2_p1, d.side2_p2)');
  });

  it('never tells a member which consumer made a prediction', () => {
    for (const name of ['get_matchup_prediction', 'get_my_predictions']) {
      const header = body(name).split('AS $function$')[0]!;
      expect(header, name).not.toMatch(/consumer|key_id/);
    }
  });

  it('writes an audit row for the write and for the delete', () => {
    expect(body('data_api_write_predictions')).toContain("'data_api_predictions_written'");
    expect(body('data_api_delete_predictions')).toContain("'data_api_predictions_deleted'");
  });
});

describe('00282: predictions never feed ratings, and the purge reaches them', () => {
  // A later migration restating merge_players_disposable carries the four
  // (table, column) rows, so those are allowed anywhere. Anything else naming
  // the table outside 00282 is something reading predictions, and nothing may.
  // 00283 restates the two write functions to route their key check through
  // data_api_write_key; their bodies, and its precondition that the table
  // exists, are the only other places the name may appear.
  it('is the only migration that names the table, outside the merge guard rows', () => {
    const withoutRestatedWrites = (source: string) =>
      source
        .replace(
          /CREATE OR REPLACE FUNCTION public\.data_api_(?:write|delete)_predictions\([\s\S]*?\n\$function\$;/g,
          '',
        )
        .replace(/to_regclass\('public\.data_api_predictions'\)/g, '');
    const naming = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && !f.startsWith('00282_'))
      .filter((f) =>
        withoutRestatedWrites(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
          .replace(/\('data_api_predictions',\s*'side[12]_p[12]'\)/g, '')
          .includes('data_api_predictions'),
      );
    expect(naming).toEqual([]);
  });

  it('00283 changes only the key check of the two write functions', () => {
    const bodyOf = (source: string, fn: string) => {
      const start = source.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf('\n$function$;', start));
    };
    for (const fn of ['data_api_write_predictions', 'data_api_delete_predictions']) {
      const restated = bodyOf(formImport, fn);
      expect(restated).toContain("FROM data_api_write_key(p_key_hash, 'predictions:write')");
      expect(restated).toContain('data_api_predictions');
    }
  });

  it('keeps all sixteen disposable rows from 00279 and adds the four side columns', () => {
    const rows = (source: string) => {
      const start = source.lastIndexOf('CREATE OR REPLACE FUNCTION public.merge_players_disposable()');
      expect(start).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf('$function$;', start));
      return [...body.matchAll(/\('([a-z0-9_]+)',\s*'([a-z0-9_]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`).sort();
    };
    const before = rows(migration('00279_'));
    expect(before).toHaveLength(16);
    expect(rows(predictions)).toEqual(
      [
        ...before,
        'data_api_predictions.side1_p1',
        'data_api_predictions.side1_p2',
        'data_api_predictions.side2_p1',
        'data_api_predictions.side2_p2',
      ].sort(),
    );
    expect(predictions).toContain('merge_players_disposable()) <> 20');
  });

  // The trigger deletes a member's predictions when the purge anonymises them,
  // keyed on the email the purge writes. If anonymize.ts changes its marker
  // and this does not, predictions outlive the account.
  it('keys the purge trigger on the email marker anonymize.ts writes', () => {
    const anonymize = readFileSync(
      join(__dirname, '../../../../supabase/functions/_shared/anonymize.ts'),
      'utf8',
    );
    expect(anonymize).toContain('email: `deleted+${playerId}@deleted.invalid`');
    expect(predictions).toContain("NEW.email LIKE 'deleted+%@deleted.invalid'");
  });
});
