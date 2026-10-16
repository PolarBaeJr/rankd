import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXPORT_TABLES,
  NON_FK_PLAYER_TABLES,
  NOT_ABOUT_PLAYERS,
  DROPPED_TABLES,
  MIGRATION_SCRATCH_TABLES,
  PLAYER_EXPORT_COLUMNS,
  PLAYER_WITHHELD_COLUMNS,
  TABLES_CONSIDERED,
  DISCLOSURE_RECIPIENTS,
} from '../data-export/registry';
import { assembleMemberExport, type ExportClient } from '../data-export/assemble';

// A TABLE ABSENT FROM THE MEMBER DATA EXPORT IS INVISIBLE, AND THAT IS THE
// WHOLE HAZARD.
//
// The export's defence is not that it includes everything; it is that it
// ENUMERATES ITS WITHHOLDINGS. That defence is only as good as the list of
// tables it was built against. A migration adding a table that holds personal
// information does not break anything: the route keeps returning 200, the file
// keeps looking complete, and the only symptom is a statutory access response
// that silently omits a table. Nothing in a code review reliably catches that,
// because the reviewer is looking at the migration and not at a registry in
// another app.
//
// So the truth comes from the MIGRATIONS and the claim from the registry, and
// the assertion that matters is a TOTAL PARTITION: every table the parser finds
// must land in exactly one bucket. Not "every FK table is handled" -- five
// tables in this schema name a member with NO foreign key (email_suppressions,
// passkey_challenges, discord_role_revocations, tournament_bonus_grants,
// console_passkey_grace), so an FK-derived list is incomplete by construction
// and would have missed all five.
//
// WHY THIS PARSES SQL AS TEXT, and the limits of that. The alternative is
// packages/shared/src/types/database.gen.ts, which is STALE -- the console's
// deleted-identity.test.ts carries a hardcoded workaround adding `exec_bio`
// back because 00130 landed and the types were never regenerated. Inheriting
// that workaround would mean inheriting the staleness it papers over. Reading
// the migrations is crude, it cannot see DDL built with EXECUTE format(...), and
// it says nothing about whether a migration has been APPLIED (nothing in this
// repository tracks that). It does check that somebody wrote the statement
// down, which is the part a code review can catch. Same technique and same
// caveat as realtime-publication.test.ts next door.

const MIGRATIONS = join(__dirname, '../../../../../supabase/migrations');
const EXPORT_DIR = join(__dirname, '../data-export');
const REPO_ROOT = join(__dirname, '../../../../..');

function migrationSql(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      // Comments first, ALWAYS. Every migration in this repo carries long
      // prose headers, and those headers contain the literal strings
      // "CREATE TABLE" and "DROP COLUMN" -- 00073:170 discusses "the role that
      // ran CREATE TABLE", 00117:87 begins a sentence "CREATE TABLE hands
      // `authenticated` SELECT ...", 00131:88 tabulates "anon: CREATE TABLE in
      // public". Without this line the parser invents three tables called
      // `and`, `hands` and `in`, and they fail the partition forever.
      sql: readFileSync(join(MIGRATIONS, name), 'utf8').replace(/--[^\n]*/g, ''),
    }));
}

const SCRATCH = new Set<string>(MIGRATION_SCRATCH_TABLES);

/**
 * Every table any migration creates, minus every table any migration drops.
 *
 * THE SUBTRACTION IS NOT OPTIONAL. Six tables in this history were created and
 * later dropped -- club_expenses and other_income (00159:217-218),
 * event_feedback (00176:512), tournament_fees and reinstatement_fees
 * (00095:287-288) and season_snapshots (00162:131). A create-only scan demands
 * a disposition for all six, and the only way to satisfy it is to invent
 * dispositions for tables that do not exist.
 */
function liveTables(): Map<string, string> {
  const created = new Map<string, string>();
  const dropped = new Set<string>();
  for (const { name, sql } of migrationSql()) {
    const flat = sql.replace(/\s+/g, ' ');
    // TEMP/TEMPORARY/UNLOGGED are matched so that the scratch tables below are
    // recognised and excluded BY NAME rather than by being invisible to the
    // regex. 00134:382 is a CREATE TEMP TABLE; if the parser could not see it,
    // the DROP at 00134:376 would still match and the table would land in the
    // dropped set by accident rather than by decision.
    for (const m of flat.matchAll(
      /CREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-zA-Z_]\w*)/gi,
    )) {
      const table = m[1] as string;
      if (!SCRATCH.has(table) && !created.has(table)) created.set(table, name);
    }
    for (const m of flat.matchAll(
      /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-zA-Z_]\w*)/gi,
    )) {
      const table = m[1] as string;
      if (!SCRATCH.has(table)) dropped.add(table);
    }
  }
  for (const table of dropped) created.delete(table);
  return created;
}

/**
 * Every column anywhere in the migrations that carries a foreign key to
 * `players`, by table.
 *
 * FOLLOWS `ALTER TABLE ... ADD COLUMN`, NOT ONLY CREATE TABLE BODIES. Four real
 * cases in this history would otherwise be missed: session_attendance.marked_by
 * (00008:16), club_expenses.paid_by and .reimbursed_by (00077:78-80) and
 * disputes.claimed_by (00188:243). All four are officer columns, which is to
 * say all four are the columns the export must NOT ship raw.
 *
 * WHY IT WALKS BACKWARDS FROM `REFERENCES` instead of matching a column
 * definition forwards. The definitions come in too many shapes to enumerate:
 * `player1_id UUID NOT NULL REFERENCES players(id)` (a digit in the name, which
 * `[a-z_]+` silently drops), `player_id uuid PRIMARY KEY REFERENCES
 * public.players(id)` split across two lines in player_discord_links
 * (00165:78-80), and `ADD COLUMN marked_by UUID REFERENCES players(id)` as the
 * second clause of a three-clause ALTER. Finding the REFERENCES first and then
 * looking left for the nearest clause boundary handles all of them.
 */
function playerForeignKeys(): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();
  for (const { sql } of migrationSql()) {
    const flat = sql.replace(/\s+/g, ' ');
    for (const stmt of flat.split(';')) {
      const create = stmt.match(
        /CREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-zA-Z_]\w*)\s*\(/i,
      );
      const alter = stmt.match(
        /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?([a-zA-Z_]\w*)/i,
      );
      const table = create
        ? (create[1] as string)
        : alter && /ADD\s+COLUMN/i.test(stmt)
          ? (alter[1] as string)
          : null;
      if (!table || SCRATCH.has(table)) continue;

      for (const ref of stmt.matchAll(/REFERENCES\s+(?:public\.)?players\s*\(/gi)) {
        const before = stmt.slice(0, ref.index);
        let cut = Math.max(before.lastIndexOf(','), before.lastIndexOf('('));
        // An `ADD COLUMN` later than the last comma wins: in a multi-clause
        // ALTER the nearest comma sits before the words "ADD COLUMN", so
        // without this the column name comes back as "ADD".
        const addColumn = [
          ...before.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?/gi),
        ].pop();
        if (addColumn && addColumn.index + addColumn[0].length - 1 > cut) {
          cut = addColumn.index + addColumn[0].length - 1;
        }
        const column = before.slice(cut + 1).trim().match(/^([a-z_]\w*)/i);
        if (!column) continue;
        if (!byTable.has(table)) byTable.set(table, new Set());
        byTable.get(table)!.add((column[1] as string).toLowerCase());
      }
    }
  }
  return byTable;
}

/** Every column `players` actually has, from CREATE TABLE plus every ALTER. */
function playerColumns(): Set<string> {
  const cols = new Set<string>();
  for (const { sql } of migrationSql()) {
    const flat = sql.replace(/\s+/g, ' ');
    for (const stmt of flat.split(';')) {
      const create = stmt.match(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?players\s*\(([\s\S]*)$/i,
      );
      if (create) {
        // Split the body on commas at paren depth zero so that a
        // CHECK (x IN ('a','b')) constraint does not read as three columns.
        let depth = 0;
        let current = '';
        const clauses: string[] = [];
        for (const ch of create[1] as string) {
          if (ch === '(') depth++;
          else if (ch === ')') {
            if (depth === 0) break;
            depth--;
          }
          if (ch === ',' && depth === 0) {
            clauses.push(current);
            current = '';
            continue;
          }
          current += ch;
        }
        clauses.push(current);
        for (const clause of clauses) {
          const m = clause.trim().match(/^([a-z_]\w*)\s+\S/i);
          if (!m) continue;
          const name = (m[1] as string).toLowerCase();
          if (['primary', 'unique', 'check', 'constraint', 'foreign', 'exclude'].includes(name)) {
            continue;
          }
          cols.add(name);
        }
      }
      const alter = stmt.match(
        /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?players\s+([\s\S]*)$/i,
      );
      if (alter) {
        for (const m of (alter[1] as string).matchAll(
          /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]\w*)/gi,
        )) {
          cols.add((m[1] as string).toLowerCase());
        }
        for (const m of (alter[1] as string).matchAll(
          /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_]\w*)/gi,
        )) {
          cols.delete((m[1] as string).toLowerCase());
        }
      }
    }
  }
  return cols;
}

describe('the parser sees the schema it claims to', () => {
  // FLOORS, on the same reasoning realtime-publication.test.ts gives for its
  // own: every assertion below this point passes vacuously over an empty list,
  // so a regex that silently stops matching would make the guard fail in
  // exactly the way the thing it guards fails.
  it('finds the tables', () => {
    const live = liveTables();
    expect(live.size).toBeGreaterThanOrEqual(60);
    expect([...live.keys()]).toContain('players');
    expect([...live.keys()]).toContain('reliability_metrics');
  });

  it('invents no tables out of the migrations\' prose', () => {
    // The three the comment stripper exists for. `and` comes from 00073:170,
    // `hands` from 00117:87, `in` from 00131:88 -- all three inside `--`
    // comments discussing CREATE TABLE.
    const live = [...liveTables().keys()];
    for (const notATable of ['and', 'hands', 'in']) {
      expect(live, `${notATable} is prose, not a table`).not.toContain(notATable);
    }
  });

  it('subtracts the six tables that were created and then dropped', () => {
    const live = [...liveTables().keys()];
    for (const gone of Object.keys(DROPPED_TABLES)) {
      expect(live, `${gone} was dropped and must not need a disposition`).not.toContain(gone);
    }
    expect(Object.keys(DROPPED_TABLES)).toHaveLength(6);
  });

  it('excludes the three migration scratch tables by name', () => {
    // A NAMED LIST, not a regex accident: a leading-underscore regex would
    // also exclude a real table somebody named badly and nothing would say so.
    const live = [...liveTables().keys()];
    for (const scratch of MIGRATION_SCRATCH_TABLES) {
      expect(live).not.toContain(scratch);
    }
    expect(MIGRATION_SCRATCH_TABLES).toHaveLength(3);
  });

  it('follows ALTER TABLE ADD COLUMN, not only CREATE TABLE bodies', () => {
    // The four real cases. All four are officer columns, which is to say the
    // ones the export must never ship raw, so a parser that misses them
    // misses precisely the columns worth catching.
    const fks = playerForeignKeys();
    expect(fks.get('session_attendance'), 'session_attendance.marked_by, 00008:16').toContain(
      'marked_by',
    );
    expect(fks.get('disputes'), 'disputes.claimed_by, 00188:243').toContain('claimed_by');
    expect(fks.get('club_expenses'), 'club_expenses.paid_by, 00077:78').toContain('paid_by');
    expect(fks.get('club_expenses'), 'club_expenses.reimbursed_by, 00077:80').toContain(
      'reimbursed_by',
    );
  });

  it('reads a column name that contains a digit', () => {
    // `player1_id UUID NOT NULL REFERENCES players(id)`. A `[a-z_]+` column
    // pattern drops both halves of every doubles pair in the schema and looks
    // healthy doing it.
    const pairs = playerForeignKeys().get('tournament_pairs');
    expect(pairs).toContain('player1_id');
    expect(pairs).toContain('player2_id');
  });

  it('reads a REFERENCES split across lines', () => {
    // player_discord_links puts `REFERENCES public.players(id)` on the line
    // after the column name (00165:78-80).
    expect(playerForeignKeys().get('player_discord_links')).toContain('player_id');
  });
});

describe('every table in the schema is considered for the member data export', () => {
  it('partitions the whole schema, with nothing left over', () => {
    // THE ASSERTION THAT MAKES THE FEATURE STAY CORRECT. Four buckets, and
    // every live table in exactly one of them. A new table is in none, so it
    // fails here by name rather than being quietly missing from a statutory
    // access response.
    const fks = playerForeignKeys();
    const unpartitioned: string[] = [];
    for (const [table, migration] of liveTables()) {
      const buckets = [
        fks.has(table),
        table in NON_FK_PLAYER_TABLES,
        table in NOT_ABOUT_PLAYERS,
        table in DROPPED_TABLES,
      ].filter(Boolean).length;
      if (buckets !== 1) unpartitioned.push(`${table} (added in ${migration}, in ${buckets} buckets)`);
    }
    expect(
      unpartitioned,
      'new table(s) not considered for the member data export: classify each as player-referencing (add it to EXPORT_TABLES), NON_FK_PLAYER_TABLES, NOT_ABOUT_PLAYERS or DROPPED_TABLES',
    ).toEqual([]);
  });

  it('gives every player-referencing table a disposition and a reason', () => {
    const missing: string[] = [];
    for (const table of playerForeignKeys().keys()) {
      if (table in DROPPED_TABLES) continue;
      const entry = EXPORT_TABLES[table];
      if (!entry) missing.push(`${table} (no registry entry)`);
      else if (!entry.why.trim()) missing.push(`${table} (no why)`);
    }
    expect(
      missing,
      'a table with a foreign key to players holds personal information by construction',
    ).toEqual([]);
  });

  it('records every player-referencing column the migrations declare', () => {
    // The registry's playerColumns is what the assembler filters on. A column
    // it does not know about is a column the export never matches, so a member
    // marked by a new officer column would be missing rows with nothing
    // anywhere to say so.
    const drifted: string[] = [];
    for (const [table, columns] of playerForeignKeys()) {
      if (table in DROPPED_TABLES) continue;
      const known = new Set(EXPORT_TABLES[table]?.playerColumns ?? []);
      for (const column of columns) {
        if (!known.has(column)) drifted.push(`${table}.${column}`);
      }
    }
    expect(drifted, 'player-referencing column(s) missing from the registry').toEqual([]);
  });

  it('names the seven tables that reference a member with no foreign key', () => {
    // WHY THE PARTITION HAS TO BE TOTAL, in seven concrete cases. An FK-only
    // scan finds none of them and every one holds personal information.
    expect(Object.keys(NON_FK_PLAYER_TABLES).sort()).toEqual([
      'club_change_drafts',
      'club_change_entries',
      'console_passkey_grace',
      'discord_role_revocations',
      'email_suppressions',
      'passkey_challenges',
      'tournament_bonus_grants',
    ]);
    for (const table of Object.keys(NON_FK_PLAYER_TABLES)) {
      expect(playerForeignKeys().has(table), `${table} should have no player FK`).toBe(false);
      expect(EXPORT_TABLES[table], `${table} needs a disposition`).toBeDefined();
    }
  });

  it('pins tables_considered against the registry', () => {
    expect(TABLES_CONSIDERED).toBe(Object.keys(EXPORT_TABLES).length);
  });
});

describe('every column on players is classified', () => {
  it('leaves no column in neither list', () => {
    // A new column on `players` is the likeliest way for this export to go
    // quietly incomplete, because `players` is the one table where the export
    // names its columns rather than taking the row. So a new column fails a
    // test instead of silently missing.
    const exported = new Set<string>(PLAYER_EXPORT_COLUMNS);
    const withheld = new Set<string>(PLAYER_WITHHELD_COLUMNS);
    const unclassified = [...playerColumns()].filter(
      (c) => !exported.has(c) && !withheld.has(c),
    );
    expect(
      unclassified.sort(),
      'new players column(s): add each to PLAYER_EXPORT_COLUMNS or PLAYER_WITHHELD_COLUMNS',
    ).toEqual([]);
  });

  it('claims no column players does not have', () => {
    const actual = playerColumns();
    const phantom = [...PLAYER_EXPORT_COLUMNS, ...PLAYER_WITHHELD_COLUMNS].filter(
      (c) => !actual.has(c),
    );
    expect(phantom, 'column(s) in the registry that players does not have').toEqual([]);
  });

  it('withholds banned_by, which is the officer and not the member', () => {
    // The only players-to-players foreign key on the table, and therefore the
    // whole of the third-party problem on it.
    expect(playerForeignKeys().get('players')).toContain('banned_by');
    expect(PLAYER_WITHHELD_COLUMNS).toContain('banned_by');
  });

  it('exports ban_reason, because the app already shows it to the banned member', () => {
    // THE TIE-BREAK CASE, settled by the product rather than by argument.
    // getAccountStanding() folds ban_reason verbatim into the suspension
    // detail and standing-banner.tsx renders that detail on every page, so a
    // banned member is already told why. Exporting it changes nothing about
    // what they can see. If either of those two things stops being true, this
    // assertion is the place to reopen the question.
    expect(PLAYER_EXPORT_COLUMNS).toContain('ban_reason');
    const standing = readFileSync(
      join(__dirname, '../../../../../packages/shared/src/utils/account-standing.ts'),
      'utf8',
    );
    expect(standing, 'account-standing.ts no longer quotes ban_reason').toContain(
      'Your account is suspended for',
    );
    const banner = readFileSync(join(__dirname, '../../components/standing-banner.tsx'), 'utf8');
    expect(banner, 'standing-banner.tsx no longer renders the detail').toContain('standing.detail');
  });
});

describe('no withheld column can be exported by accident', () => {
  it('keeps the two lists on players disjoint', () => {
    const exported = new Set<string>(PLAYER_EXPORT_COLUMNS);
    const overlap = PLAYER_WITHHELD_COLUMNS.filter((c) => exported.has(c));
    expect(overlap, 'withheld column(s) also in the export allowlist').toEqual([]);
  });

  it('keeps the two lists on every other table disjoint', () => {
    const overlap: string[] = [];
    for (const [table, entry] of Object.entries(EXPORT_TABLES)) {
      const allowed = new Set<string>(entry.columns ?? []);
      for (const column of entry.withheldColumns ?? []) {
        if (allowed.has(column)) overlap.push(`${table}.${column}`);
      }
    }
    expect(overlap).toEqual([]);
  });
});

describe('the export modules cannot turn a failed read into an empty one', () => {
  // THE DEFECT THIS SCAN EXISTS FOR, and it has already shipped four times in
  // this repo. A denied PostgREST read arrives as an EMPTY LIST, not an error,
  // so `const { data } = await ...` followed by `data ?? []` produces a
  // perfectly well-formed file that is missing a table. The calendar route's
  // own header records one instance: a `?? []` there "turned the refusal into
  // a valid, empty calendar".
  //
  // In an export this is worse than a bug, because the output is a statutory
  // record of what the club holds. A partial file must be structurally
  // impossible, not merely unlikely.
  function exportSources(): { file: string; text: string }[] {
    return readdirSync(EXPORT_DIR)
      .filter((f) => /\.ts$/.test(f))
      .map((f) => ({ file: f, text: readFileSync(join(EXPORT_DIR, f), 'utf8') }));
  }

  it('finds the export modules at all', () => {
    expect(exportSources().map((s) => s.file).sort()).toEqual([
      'assemble.ts',
      'project.ts',
      'registry.ts',
    ]);
  });

  it('contains no `?? []` or `|| []` fallback', () => {
    const offenders: string[] = [];
    for (const { file, text } of exportSources()) {
      // Comment lines are excluded so that this file's own prose, and the
      // prose in the modules explaining the rule, do not trip it.
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/(\?\?|\|\|)\s*\[\s*\]/.test(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'an empty-array fallback turns a refused read into a valid, incomplete export',
    ).toEqual([]);
  });

  it('destructures `error` at every read', () => {
    const offenders: string[] = [];
    for (const { file, text } of exportSources()) {
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        // A destructure that names `data` and not `error`. `const { data: x }`
        // counts, because renaming does not make the error checked.
        const m = line.match(/(?:const|let)\s*\{\s*data\b[^}]*\}\s*=/);
        if (m && !/\berror\b/.test(m[0])) offenders.push(`${file}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders, 'a read whose error is never looked at').toEqual([]);
  });

  it('never folds an id list into an `.or()`', () => {
    // THE 8,192-BYTE REQUEST LINE, and the one way the shared chunker cannot
    // save you from it. `selectInChunks` sizes its batches at 110 ids because
    // that is what ONE `.in()` list costs (measured: 215 ids reach PostgREST,
    // 220 get a 414). Folding several `.in()` lists into a single `.or()`
    // multiplies the line by the number of columns, so a full chunk sails past
    // the limit and comes back 414 -- which is not a short list the chunker can
    // concatenate, it is a failed read.
    //
    // The draw-match filter was written that way first: four entry columns
    // times 110 uuids is roughly 24KB on one line. It is four separate `.in()`
    // reads now. This is the assertion that stops the next one.
    const offenders: string[] = [];
    for (const { file, text } of exportSources()) {
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/\.or\(/.test(line) && /\.in\./.test(line)) {
          offenders.push(`${file}:${i + 1} ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'an `.or()` carrying an `.in.()` list overruns the request line and 414s',
    ).toEqual([]);
  });

  it('never reads cron_config', () => {
    // It holds reminder_secret and holds nothing about any member. Never read
    // from here, filtered or not. The scan is for the READ rather than for the
    // name, because the registry names the table in order to say it is never
    // read, and a name-only scan would fail on that sentence.
    for (const { file, text } of exportSources()) {
      expect(text, `${file} must not read cron_config`).not.toMatch(
        /\.from\(\s*['"]cron_config['"]/,
      );
    }
  });
});

// ============================================================
// THE ASSEMBLER, AGAINST A STUB
// ============================================================
// FIXTURES ARE SHAPES, COUNTS AND COLUMN NAMES ONLY. THE REPO IS PUBLIC, so
// there is no member data in anything committed here: the synthetic values are
// in the style of the console's deleted-identity.test.ts FULL_ROW -- a made-up
// name and `member@example.invalid`.
//
// THE ONE UUID THAT MATTERS IS THE SENTINEL. Every third-party player column in
// every fixture below holds the same fixed value, and the assertion is that it
// appears NOWHERE in the serialised document. That checks the projection rule
// -- "never a uuid, never a name" -- MECHANICALLY rather than by review, which
// matters because the rule is applied at about twenty separate sites and a
// twenty-first added later would otherwise ship raw and look fine.

const PLAYER_ID = '11111111-1111-4111-8111-111111111111';
const AUTH_ID = '22222222-2222-4222-8222-222222222222';

/** Every other member, everywhere. Must never reach the output. */
const SENTINEL = 'deadbeef-0000-4000-8000-000000000000';
/** An address wedged inside an audit payload, the way production rows hold one. */
const PAYLOAD_EMAIL = 'leaked@example.invalid';

type StubRow = Record<string, unknown>;

const FIXTURES: Record<string, StubRow[]> = {
  players: [
    {
      id: PLAYER_ID,
      user_id: AUTH_ID,
      email: 'member@example.invalid',
      phone: '+16045550101',
      first_name: 'Kiera',
      last_name: 'Tan',
      full_name: 'Kiera Tan',
      handle: 'kiera',
      member_code: 1234,
      status: 'active',
      role: 'player',
      is_banned: true,
      ban_reason: 'Repeated no-shows',
      banned_by: SENTINEL,
      permission_grants: ['sessions.read'],
      notification_preferences: { email: true },
      avatar_url: 'https://cdn.example.invalid/a.jpg',
    },
  ],
  ratings: [{ id: 'r1', player_id: PLAYER_ID, singles_elo: 1500 }],
  reliability_metrics: [{ id: 'm1', player_id: PLAYER_ID, no_shows: 2 }],
  season_final_ratings: [{ id: 'sf1', player_id: PLAYER_ID, singles_elo: 1480 }],
  session_attendance: [
    { id: 'sa1', session_id: 'sess-1', player_id: PLAYER_ID, status: 'present', marked_by: SENTINEL },
  ],
  session_rsvp: [{ id: 'rsvp1', session_id: 'sess-1', player_id: PLAYER_ID, intent: 'going' }],
  club_event_signups: [{ event_id: 'cev-1', player_id: PLAYER_ID, created_at: '2026-09-20T18:00:00Z' }],
  club_events: [
    {
      id: 'cev-1',
      title: 'Club social',
      kind: 'social',
      starts_at: '2026-10-02T02:00:00Z',
      ends_at: null,
      location: 'Gym',
      status: 'published',
      created_by: SENTINEL,
    },
  ],
  waiver_acceptances: [
    { id: 'w1', player_id: PLAYER_ID, document: 'waiver', user_agent: 'Mozilla/5.0 (fake)' },
  ],
  event_waiver_acceptances: [{ id: 'ew1', player_id: PLAYER_ID, tournament_id: 'trn-1' }],
  announcement_reads: [{ id: 'ar1', player_id: PLAYER_ID, announcement_id: 'ann-1' }],
  notifications: [{ id: 'n1', player_id: PLAYER_ID, title: 'Match confirmed' }],
  digest_deliveries: [{ week_start: '2026-09-14', player_id: PLAYER_ID, outcome: 'sent' }],
  email_suppressions: [
    { email: 'member@example.invalid', reason: 'bounce', detail: { bounceType: 'Permanent' } },
  ],
  player_discord_links: [{ player_id: PLAYER_ID, discord_user_id: '900000000000000001' }],
  feedback_reports: [{ id: 'f1', player_id: PLAYER_ID, kind: 'bug', body: 'The badge is stuck.' }],
  head_to_head_stats: [
    {
      id: 'h2h1',
      player_a_id: SENTINEL,
      player_b_id: PLAYER_ID,
      player_a_wins: 3,
      player_b_wins: 5,
      player_a_points: 60,
      player_b_points: 71,
      total_matches: 8,
    },
  ],
  partnership_stats: [
    { id: 'ps1', player_a_id: PLAYER_ID, player_b_id: SENTINEL, matches_played: 4, wins: 3 },
  ],
  data_api_predictions: [
    {
      id: 'dp1',
      consumer_id: 'consumer-1',
      key_id: 'key-1',
      format: 'doubles',
      side1_p1: SENTINEL,
      side1_p2: SENTINEL,
      side2_p1: PLAYER_ID,
      side2_p2: SENTINEL,
      side1_win_probability: 0.64,
      model: 'WITHHELD-MODEL-NAME',
      made_at: '2026-10-08T18:00:00Z',
    },
  ],
  match_participants: [
    { id: 'mp1', match_id: 'match-1', player_id: PLAYER_ID, team_side: 'a', rating_delta: 12 },
    { id: 'mp2', match_id: 'match-1', player_id: SENTINEL, team_side: 'b', rating_delta: -12 },
  ],
  matches: [
    {
      id: 'match-1',
      submitted_by: SENTINEL,
      confirmed_by: PLAYER_ID,
      forfeit_player_id: SENTINEL,
      score_summary: '21-15, 21-18',
    },
  ],
  match_games: [{ id: 'g1', match_id: 'match-1', game_number: 1, side_a_score: 21 }],
  challenges: [
    { id: 'ch-1', created_by: PLAYER_ID, note: 'Court 3 if it is free', status: 'accepted' },
    { id: 'ch-2', created_by: SENTINEL, note: 'THEIR PRIVATE NOTE', status: 'pending' },
  ],
  challenge_participants: [
    { id: 'cp1', challenge_id: 'ch-1', player_id: PLAYER_ID, role: 'challenger' },
    { id: 'cp2', challenge_id: 'ch-1', player_id: SENTINEL, role: 'opponent' },
  ],
  tournament_participants: [
    {
      id: 'tp-1',
      event_id: 'ev-1',
      player_id: PLAYER_ID,
      status: 'no_show',
      final_position: 5,
      checked_in_by: SENTINEL,
      added_by: SENTINEL,
    },
  ],
  tournament_pairs: [
    {
      id: 'pair-1',
      event_id: 'ev-1',
      player1_id: PLAYER_ID,
      player2_id: SENTINEL,
      pair_name: 'The Smashers',
      checked_in_by: SENTINEL,
      added_by: SENTINEL,
    },
  ],
  tournament_matches: [
    {
      id: 'tm-1',
      event_id: 'ev-1',
      participant_a_id: 'tp-1',
      participant_b_id: SENTINEL,
      pair_a_id: 'pair-1',
      pair_b_id: SENTINEL,
      winner_participant_id: SENTINEL,
      winner_pair_id: null,
      loser_participant_id: 'tp-1',
      loser_pair_id: SENTINEL,
      result_entered_by: SENTINEL,
      ready_player_ids: [PLAYER_ID, SENTINEL],
    },
  ],
  registration_imports: [
    {
      id: 'ri-1',
      binding_id: 'rif-1',
      key_id: SENTINEL,
      response_id: 'resp-1',
      submitted_at: '2026-10-01T18:00:00Z',
      payload_hash: 'abc',
      result: [{ item: 1, status: 'pending' }],
      submitter_player_id: PLAYER_ID,
      submitter_name: null,
      submitter_email: null,
      superseded_by: null,
      created_at: '2026-10-01T18:00:01Z',
      updated_at: '2026-10-01T18:00:01Z',
    },
  ],
  registration_import_entries: [
    {
      id: 'rie-1',
      import_id: 'ri-1',
      item: 1,
      tournament_event_id: 'ev-1',
      club_event_id: null,
      entrant_id: PLAYER_ID,
      requested_partner_id: SENTINEL,
      partner_email: PAYLOAD_EMAIL,
      partner_name: 'Typed Partner',
      status: 'undone',
      undone_by: SENTINEL,
      undone_at: '2026-10-02T18:00:00Z',
    },
    {
      id: 'rie-2',
      import_id: 'ri-other',
      item: 1,
      tournament_event_id: 'ev-1',
      club_event_id: null,
      entrant_id: SENTINEL,
      requested_partner_id: PLAYER_ID,
      status: 'awaiting_partner',
      undone_by: null,
    },
  ],
  tournament_event_waitlist: [
    {
      id: 'wl-1',
      event_id: 'ev-1',
      player_id: PLAYER_ID,
      status: 'removed',
      joined_at: '2026-09-20T18:00:00Z',
      resolved_at: '2026-09-21T18:00:00Z',
      resolved_by: SENTINEL,
      reason: null,
      promoted_participant_id: null,
    },
  ],
  legacy_tournament_participants: [
    { id: 'ltp1', tournament_id: 'trn-1', player_id: PLAYER_ID, partner_id: SENTINEL, placement: 3 },
  ],
  tournament_bonus_grants: [
    { id: 'bg1', event_id: 'ev-1', kind: 'rating', subject_id: PLAYER_ID, applied_delta: 10 },
  ],
  tournament_audit_log: [
    {
      id: 'tal1',
      performed_by: PLAYER_ID,
      action: 'withdraw',
      details: { status: 'withdrawn', email: PAYLOAD_EMAIL },
    },
  ],
  walkovers: [
    {
      id: 'wo-1',
      match_id: 'match-1',
      reported_by: PLAYER_ID,
      forfeit_player_id: SENTINEL,
      admin_confirmed_by: SENTINEL,
    },
  ],
  disputes: [
    {
      id: 'd-1',
      match_id: 'match-1',
      opened_by: PLAYER_ID,
      description: 'The third game was never played.',
      resolved_by: SENTINEL,
      claimed_by: SENTINEL,
      resolution_note: 'OFFICER VERDICT TEXT',
    },
    {
      id: 'd-2',
      match_id: 'match-1',
      opened_by: SENTINEL,
      description: 'THEIR ACCOUNT OF EVENTS',
      resolved_by: SENTINEL,
      claimed_by: null,
      resolution_note: 'OFFICER VERDICT TEXT TWO',
    },
  ],
  club_fees: [
    { id: 'cf-1', player_id: PLAYER_ID, amount_cents: 4000, marked_by: SENTINEL },
    { id: 'cf-2', player_id: SENTINEL, amount_cents: 4000, marked_by: PLAYER_ID },
  ],
  fee_submissions: [
    {
      id: 'fs-1',
      club_fee_id: 'cf-1',
      player_id: PLAYER_ID,
      reference: 'SYNTH0001',
      screenshot_path: `${AUTH_ID}/synthetic.png`,
      status: 'rejected',
      reject_reason: 'Synthetic reason',
      reviewed_by: SENTINEL,
    },
    // Somebody else's receipt that the requester reviewed as an officer. Must
    // not appear at all.
    { id: 'fs-2', club_fee_id: 'cf-2', player_id: SENTINEL, reference: 'SYNTH0002', reviewed_by: PLAYER_ID },
  ],
  club_ledger: [
    {
      id: 'cl-1',
      paid_by: PLAYER_ID,
      amount_cents: 2500,
      description: 'Shuttles',
      marked_by: SENTINEL,
      reimbursed_by: SENTINEL,
    },
    {
      id: 'cl-2',
      paid_by: SENTINEL,
      amount_cents: 9900,
      description: 'COURT RENTAL FOR THE WHOLE CLUB',
      marked_by: PLAYER_ID,
      reimbursed_by: null,
    },
  ],
  audit_logs: [
    {
      id: 'al-1',
      target_type: 'player',
      target_id: PLAYER_ID,
      actor_id: SENTINEL,
      action_type: 'player_banned',
      reason: 'Repeated no-shows',
      old_value: { status: 'active', email: PAYLOAD_EMAIL, first_name: 'Kiera' },
      new_value: { status: 'suspended' },
    },
    {
      id: 'al-2',
      target_type: 'player',
      target_id: SENTINEL,
      actor_id: PLAYER_ID,
      action_type: 'player_approved',
      reason: 'MY REASON ABOUT ANOTHER MEMBER',
      old_value: { email: PAYLOAD_EMAIL },
      new_value: null,
    },
  ],
  announcements: [{ id: 'ann-1', title: 'Season opener', author_id: PLAYER_ID }],
  sessions: [{ id: 'sess-1', name: 'Tuesday drop-in', date: '2026-09-15', host_player_id: SENTINEL }],
  tournaments: [
    { id: 'trn-1', name: 'Fall Open', start_date: '2026-10-01', created_by: SENTINEL },
  ],
  tournament_events: [{ id: 'ev-1', tournament_id: 'trn-1', event_type: 'MS' }],
  discord_role_revocations: [{ discord_user_id: '900000000000000001', queued_at: '2026-09-01' }],
  passkey_credentials: [
    {
      id: 'pk1',
      player_id: PLAYER_ID,
      credential_id: 'CRED-ID-THAT-IS-A-CROSS-SITE-IDENTIFIER',
      public_key: 'PUBLIC-KEY-MATERIAL',
      counter: 42,
      nickname: 'Phone',
    },
  ],
  push_subscriptions: [
    {
      id: 'push1',
      player_id: PLAYER_ID,
      endpoint: 'https://fcm.example.invalid/send/UNGUESSABLE-PATH-SEGMENT',
      p256dh_key: 'P256DH-KEY-MATERIAL',
      auth_key: 'AUTH-KEY-MATERIAL',
    },
  ],
  calendar_feed_tokens: [
    { player_id: PLAYER_ID, token: 'aaaabbbbccccddddeeeeffff000011112222333344445555', created_at: '2026-01-01' },
  ],
  discord_link_tokens: [
    { token_hash: 'TOKEN-HASH-MATERIAL', consumed_by: PLAYER_ID, discord_user_id: '9000001' },
  ],
  // Counted and withheld tables are only ever head-counted, so one row each is
  // enough to prove the count is not hardcoded to zero.
  legal_documents: [{ id: 'ld1', updated_by: PLAYER_ID }],
  platform_settings: [{ key: 'elo', updated_by: PLAYER_ID }],
  permission_baselines: [{ id: 'pb1', created_by: PLAYER_ID }],
  event_waiver_templates: [{ id: 'ewt1', updated_by: PLAYER_ID }],
  discord_outbox: [{ id: 'do1', requested_by: PLAYER_ID }],
  passkey_challenges: [{ id: 'pc1', user_id: AUTH_ID, challenge_hash: 'CHALLENGE-HASH' }],
  console_passkey_grace: [{ user_id: AUTH_ID, started_at: '2026-09-20T00:00:00Z' }],
  varsity_notes: [{ id: 'vn1', player_id: PLAYER_ID, note: 'TRAINER NOTE TEXT', author_id: SENTINEL }],
  match_admin_notes: [{ match_id: 'match-1', note: 'OFFICER MATCH NOTE', author_id: SENTINEL }],
  tournament_participant_notes: [
    { participant_id: 'tp-1', note: 'OFFICER PARTICIPANT NOTE', author_id: SENTINEL },
  ],
  tournament_pair_notes: [{ pair_id: 'pair-1', note: 'OFFICER PAIR NOTE', author_id: SENTINEL }],
  tournament_match_notes: [{ match_id: 'tm-1', note: 'OFFICER DRAW NOTE', author_id: SENTINEL }],
  walkover_admin_notes: [{ walkover_id: 'wo-1', note: 'OFFICER WALKOVER VERDICT', author_id: SENTINEL }],
};

/**
 * A query builder that honours `.eq()` and ignores the rest.
 *
 * WHY ONLY `.eq()`. Honouring it is what lets the fixtures exercise BOTH halves
 * of the asymmetric reads -- audit_logs about-you against audit_logs by-you,
 * a fee recorded against you against a fee you recorded for somebody else -- by
 * putting the requester's id in one column and the sentinel in the other.
 * Ignoring `.in()` and `.or()` is the CONSERVATIVE direction for the sentinel
 * scan: more rows come back than a real database would return, so every
 * projection site runs and has the chance to leak.
 */
class StubQuery {
  private readonly predicates: ((row: StubRow) => boolean)[] = [];
  private from = 0;
  private to: number | null = null;

  constructor(
    private readonly rows: StubRow[],
    private readonly head: boolean,
    private readonly fail: string | null,
  ) {}

  eq(column: string, value: unknown) {
    this.predicates.push((row) => row[column] === value);
    return this;
  }
  neq() {
    return this;
  }
  in() {
    return this;
  }
  or() {
    return this;
  }
  range(from: number, to: number) {
    this.from = from;
    this.to = to;
    return this;
  }

  private matched(): StubRow[] {
    return this.rows.filter((row) => this.predicates.every((p) => p(row)));
  }

  then(resolve: (value: any) => unknown) {
    if (this.fail) {
      return resolve({ data: null, error: { message: this.fail }, count: null });
    }
    const matched = this.matched();
    if (this.head) return resolve({ data: null, error: null, count: matched.length });
    const sliced = this.to === null ? matched : matched.slice(this.from, this.to + 1);
    return resolve({ data: sliced, error: null, count: null });
  }
}

function stubClient(
  fixtures: Record<string, StubRow[]> = FIXTURES,
  failOn: string | null = null,
): ExportClient {
  return {
    from(table: string) {
      const rows = fixtures[table] ?? [];
      return {
        select(_columns: string, options?: any) {
          return new StubQuery(rows, options?.head === true, failOn === table ? 'refused' : null);
        },
      };
    },
  };
}

describe('the assembler reads every table the registry registers', () => {
  it('puts every export and project table into the document', async () => {
    // REGISTERED-BUT-NEVER-READ IS OTHERWISE INVISIBLE. The registry would
    // carry a disposition and a `why`, the manifest would carry a row count of
    // zero, and the member would read "this table holds nothing about you" for
    // a table nobody ever asked about. Same bug class as the purge suite's
    // "writes every column it claims to erase".
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.failures)).toBe(true);
    if (!result.ok) return;

    const missing = Object.entries(EXPORT_TABLES)
      .filter(([, e]) => e.disposition === 'export' || e.disposition === 'project')
      .map(([table]) => table)
      .filter((table) => !(table in result.document.data));
    expect(missing, 'registered table(s) that the assembler never reads').toEqual([]);
  });

  it('puts nothing into the document that the registry does not register', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const unregistered = Object.keys(result.document.data).filter((t) => !(t in EXPORT_TABLES));
    expect(unregistered, 'table(s) in the output with no disposition or reason').toEqual([]);
  });

  it('counts every registered table in the manifest, including the zeros', async () => {
    // "Absent from the output" and "present, no rows" have to be
    // distinguishable, or the file cannot be read as an answer.
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    expect(Object.keys(result.document.manifest.tables).sort()).toEqual(
      Object.keys(EXPORT_TABLES).sort(),
    );
    for (const [table, entry] of Object.entries(result.document.manifest.tables)) {
      expect(typeof entry.rows, `${table} has no row count`).toBe('number');
      expect(entry.why.length, `${table} has no reason`).toBeGreaterThan(0);
      expect(entry.disposition).toBe(EXPORT_TABLES[table]!.disposition);
    }
    expect(result.document.manifest.tables_considered).toBe(TABLES_CONSIDERED);
  });

  it('declares every withheld table with a row count, so the stakes are visible', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const pending = Object.entries(EXPORT_TABLES)
      .filter(([, e]) => e.disposition === 'withheld_pending_owner_decision')
      .map(([table]) => table);
    // Six note tables, and the owner needs a number against each one.
    expect(pending.sort()).toEqual([
      'match_admin_notes',
      'tournament_match_notes',
      'tournament_pair_notes',
      'tournament_participant_notes',
      'varsity_notes',
      'walkover_admin_notes',
    ]);
    for (const table of pending) {
      const entry = result.document.withheld.find((w) => w.what === table);
      expect(entry, `${table} is missing from the withheld stanza`).toBeDefined();
      expect(typeof entry!.rows, `${table} is withheld with no row count`).toBe('number');
      expect(entry!.rows, `${table} count came back zero from a one-row fixture`).toBe(1);
    }
  });
});

describe('no third party survives into the file', () => {
  it('never emits another member\'s uuid, anywhere', async () => {
    // THE HIGHEST-VALUE ASSERTION IN THIS FILE. Every third-party player
    // column in every fixture holds SENTINEL. A projection site that ships a
    // raw uuid -- or a new site added later that forgets to project at all --
    // fails here, mechanically, without anybody having to notice it in review.
    //
    // A uuid is the thing to guard rather than a name because it is JOINABLE:
    // it appears in /leaderboard/[playerId] URLs and in every table in the
    // schema, so one leaked uuid turns this file into a lookup key for
    // somebody else's record.
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const serialised = JSON.stringify(result.document);
    expect(serialised, 'a third-party player uuid reached the output').not.toContain(SENTINEL);
    // And the pseudonyms really were allocated, so the assertion above is not
    // passing because the projection dropped everything on the floor.
    expect(serialised).toContain('member_1');
    expect(result.document.manifest.pseudonyms_allocated).toBeGreaterThan(0);
  });

  it('exports the member\'s own waitlist rows with the officer as a role', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const rows = result.document.data.tournament_event_waitlist as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('resolved_by');
    expect(rows[0]).toHaveProperty('resolved_by_role');
    expect(rows[0]!.status).toBe('removed');
  });

  it('exports form entries without the other member or anything typed about a partner', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const rows = result.document.data.registration_import_entries as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.id, r.you_are])).toEqual([
      ['rie-1', 'the entrant'],
      ['rie-2', 'the named partner'],
    ]);
    for (const row of rows) {
      for (const column of ['entrant_id', 'requested_partner_id', 'undone_by', 'partner_email', 'partner_name']) {
        expect(row, column).not.toHaveProperty(column);
      }
    }
    expect(rows[0]!.undone_by_role).toBeTruthy();
    expect(rows[1]).not.toHaveProperty('import_id');
    const imports = result.document.data.registration_imports as Array<Record<string, unknown>>;
    expect(imports).toHaveLength(1);
    expect(imports[0]).not.toHaveProperty('key_id');
  });

  it('exports predictions with the member\'s side first and the model withheld', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const rows = result.document.data.data_api_predictions as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.my_side_win_probability).toBe(0.36);
    expect(rows[0]!.partner).toMatch(/^member_\d+$/);
    expect(rows[0]!.opponents).toHaveLength(2);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('WITHHELD-MODEL-NAME');
    expect(serialised).not.toContain('consumer-1');
    expect(serialised).not.toContain('key-1');
  });

  it('never emits a jsonb payload key outside the allowlist', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const serialised = JSON.stringify(result.document);
    expect(serialised, 'an audit payload email reached the output').not.toContain(PAYLOAD_EMAIL);
    // `first_name` is checked against the PAYLOAD and not against the whole
    // file, because the member's own first name is exported in full from their
    // players row -- that is where it belongs. What must not happen is a NAME
    // travelling inside an audit payload, where nothing says whose it is.
    const about = result.document.data.audit_logs!.find((r) => r.id === 'al-1')!;
    const payload = about.old_value as Record<string, unknown>;
    expect(Object.keys(payload), 'an audit payload name reached the output').not.toContain(
      'first_name',
    );
    // The allowlisted half of the same payload did come through, so the filter
    // is filtering rather than emptying.
    expect(payload.status).toBe('active');
  });

  it('withholds the other member\'s words and keeps the requester\'s own', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const serialised = JSON.stringify(result.document);
    for (const theirs of [
      'THEIR PRIVATE NOTE',
      'THEIR ACCOUNT OF EVENTS',
      'OFFICER VERDICT TEXT',
      'MY REASON ABOUT ANOTHER MEMBER',
      'COURT RENTAL FOR THE WHOLE CLUB',
    ]) {
      expect(serialised, `${theirs} is not the requester's information`).not.toContain(theirs);
    }
    // Their own words, on their own rows, do come through.
    expect(serialised).toContain('Court 3 if it is free');
    expect(serialised).toContain('The third game was never played.');
    expect(serialised).toContain('Repeated no-shows');
  });

  it('never emits credential material', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const serialised = JSON.stringify(result.document);
    for (const secret of [
      'PUBLIC-KEY-MATERIAL',
      'CRED-ID-THAT-IS-A-CROSS-SITE-IDENTIFIER',
      'P256DH-KEY-MATERIAL',
      'AUTH-KEY-MATERIAL',
      'TOKEN-HASH-MATERIAL',
      'CHALLENGE-HASH',
      // The calendar feed token, which would make the downloaded file a live
      // unauthenticated feed link (00013:11-15).
      'aaaabbbbccccddddeeeeffff000011112222333344445555',
      // The unguessable half of a push endpoint: those three together ARE the
      // sending credential for that browser.
      'UNGUESSABLE-PATH-SEGMENT',
    ]) {
      expect(serialised, `${secret} reached the output`).not.toContain(secret);
    }
    // The metadata around them did come through, so this is a redaction and
    // not a missing read.
    expect(result.document.data.passkey_credentials).toHaveLength(1);
    expect(result.document.data.passkey_credentials![0]!.nickname).toBe('Phone');
    expect(result.document.data.push_subscriptions![0]!.endpoint).toBe(
      'https://fcm.example.invalid/[withheld]',
    );
  });

  it('never emits the officers\' private notes, only their count', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const serialised = JSON.stringify(result.document);
    for (const note of [
      'TRAINER NOTE TEXT',
      'OFFICER MATCH NOTE',
      'OFFICER PARTICIPANT NOTE',
      'OFFICER PAIR NOTE',
      'OFFICER DRAW NOTE',
      'OFFICER WALKOVER VERDICT',
    ]) {
      expect(serialised, `${note} is withheld pending the owner's decision`).not.toContain(note);
    }
  });

  it('rewrites the pair-stats tables requester-relative', async () => {
    // The CHECK (player_a_id < player_b_id) trap, from the output side. The
    // fixture puts the requester in the B slot for head-to-head and the A slot
    // for partnerships, exactly as uuid ordering does in production, and both
    // rows must come out with the member's own numbers under `my_`.
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const h2h = result.document.data.head_to_head_stats![0]!;
    expect(h2h.my_wins, 'the requester is in the B slot in this fixture').toBe(5);
    expect(h2h.their_wins).toBe(3);
    expect(h2h.other_member).toMatch(/^member_\d+$/);
    expect(h2h).not.toHaveProperty('player_a_id');
    expect(h2h).not.toHaveProperty('player_b_id');
    const partnership = result.document.data.partnership_stats![0]!;
    expect(partnership.other_member).toMatch(/^member_\d+$/);
    expect(partnership.matches_played).toBe(4);
  });

  it('lists the requester\'s own e-transfer receipts and not the ones they reviewed', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const receipts = result.document.data.fee_submissions!;
    expect(receipts.map((r) => r.id)).toEqual(['fs-1']);
    expect(receipts[0]).toMatchObject({ reference: 'SYNTH0001', status: 'rejected', screenshot_held: true });
    expect(receipts[0]).not.toHaveProperty('reviewed_by');
    expect(receipts[0]).not.toHaveProperty('screenshot_path');
    expect(JSON.stringify(result.document)).not.toContain('SYNTH0002');
  });

  it('filters ready_player_ids down to the requester alone', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    if (!result.ok) throw new Error(result.failures.join('; '));
    const draw = result.document.data.tournament_matches![0]!;
    expect(draw).not.toHaveProperty('ready_player_ids');
    expect(draw.you_were_marked_ready).toBe(true);
  });
});

describe('a partial file is structurally impossible', () => {
  it('fails the whole request when any read fails', async () => {
    // NOT "skip that table". A failed read means one table is missing, and a
    // file missing a table is worse than no file: it looks like a complete
    // answer to a statutory request. The failure list comes back instead of a
    // document.
    const result = await assembleMemberExport(stubClient(FIXTURES, 'notifications'), PLAYER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.join(' ')).toContain('notifications');
    expect(result).not.toHaveProperty('document');
  });

  it('fails when a guaranteed-row table comes back empty', async () => {
    // ZERO ROWS IN `ratings` IS BROKEN, NOT EMPTY. UNIQUE player_id (00001:189)
    // means exactly one row exists per member, so an empty answer is a refused
    // read -- and a refused PostgREST read arrives as an empty list, never an
    // error. Without this assertion the file would ship a member with no
    // rating and no indication anything went wrong.
    const result = await assembleMemberExport(
      stubClient({ ...FIXTURES, ratings: [] }),
      PLAYER_ID,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.join(' ')).toContain('ratings: expected exactly 1 row');
  });

  it('fails when the members own row is missing', async () => {
    const result = await assembleMemberExport(stubClient({ ...FIXTURES, players: [] }), PLAYER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.join(' ')).toContain('players: expected exactly 1 row');
  });
});

describe('the route authenticates and nothing more', () => {
  const ROUTE = join(__dirname, '../../app/api/account/export/route.ts');

  it('does not call requirePlayer', () => {
    // THE ONE BEHAVIOURAL REQUIREMENT MOST LIKELY TO BE "FIXED" BY A LATER
    // HAND, because an unguarded route looks like an oversight. It is not.
    // requirePlayer() throws for pending_approval, suspended, is_banned and a
    // deletion-pending account, which is exactly the population that files
    // access requests: a banned member wanting to read the ban_reason written
    // about them is the archetypal applicant. Standing withholds the CONTROLS,
    // not the information.
    const src = readFileSync(ROUTE, 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code, 'the export must not be gated on standing').not.toContain('requirePlayer');
    expect(code, 'it still has to be the signed-in member').toContain('getCurrentPlayer');
  });

  it('assembles over the service-role client', () => {
    // The whole mechanism argument rests on it: several tables holding the
    // member's own information have zero `authenticated` grants, so an
    // RLS-scoped export is incomplete by construction and silently so. The
    // assembler takes the client as a parameter for testability, which means
    // the route is the only place this can be checked.
    const src = readFileSync(ROUTE, 'utf8');
    expect(src).toContain('createServiceRoleClient()');
    expect(src).toContain('assembleMemberExport');
  });

  it('refuses to be cached, by Next or by Cloudflare', () => {
    // A cached export is a cross-member data leak, not a performance bug.
    const src = readFileSync(ROUTE, 'utf8');
    expect(src).toContain("export const dynamic = 'force-dynamic'");
    expect(src).toContain('no-store');
    expect(src).toContain('X-Robots-Tag');
    expect(src).toContain('Content-Disposition');
  });

  it('files a receipt with a fixed action type', () => {
    const src = readFileSync(ROUTE, 'utf8');
    expect(src).toContain('logMemberAudit');
    expect(src).toContain("actionType: 'data_export_downloaded'");
  });
});

// A PROCESSOR THE CLUB FORGOT IT USES IS THE SAME CLASS OF BUG AS A TABLE THE
// REGISTRY FORGOT, AND IT IS EASIER TO INTRODUCE.
//
// Adding a table takes a migration, which the partition assertion above already
// catches. Adding a data processor takes one `npm install` and one import, and
// nothing anywhere would notice that member information started flowing to a
// new organisation. The access response would still enumerate fifty tables and
// still be wrong, in the one direction a member cannot check.
//
// So the truth here is the DEPENDENCY MANIFESTS and the claim is
// DISCLOSURE_RECIPIENTS. A processor SDK present in any workspace must be
// either named to members or recorded as inert, with the reason.
describe('every third-party processor is disclosed to the member', () => {
  // Package name fragment -> the organisation as named in DISCLOSURE_RECIPIENTS.
  // Keyed by fragment because the SDKs are scoped inconsistently (`@sentry/*`,
  // bare `resend`, `posthog-js` AND `posthog-node`).
  const PROCESSOR_SDKS: Record<string, string> = {
    resend: 'Resend',
    '@sentry/': 'Sentry',
    'discord.js': 'Discord',
    posthog: 'PostHog',
  };

  // NOT a general escape hatch: an entry here asserts the SDK ships but is
  // provably switched off in production, and it must say how that is known.
  const INERT_IN_PRODUCTION: Record<string, string> = {
    PostHog:
      'Gated on NEXT_PUBLIC_POSTHOG_KEY, which is not set in prod. lib/posthog.ts and lib/actions/_shared.ts both short-circuit when it is absent, so neither the browser nor the server client is constructed.',
  };

  const WORKSPACE_ROOTS = ['apps/player', 'apps/admin', 'apps/bot', 'packages/shared'];

  /**
   * THE ROOTS THAT RESOLVED ARE RETURNED ALONGSIDE THE TEXT, AND THE CALLER
   * ASSERTS ALL FOUR. An earlier version swallowed a missing path on the
   * grounds that repo layout is another test's business. That reasoning is
   * wrong here in a specific way: this guard concludes "not shipped" from the
   * ABSENCE of a string, so a manifest that fails to load is indistinguishable
   * from a dependency that is not there. If `apps/bot` moved, `discord.js`
   * would go undetected, Discord's disclosure would stop being guarded, and
   * the suite would stay green while checking three workspaces instead of
   * four. A guard that reads fewer inputs than it thinks must fail, not pass.
   */
  const workspaceManifests = () => {
    const found: string[] = [];
    const out: string[] = [];
    for (const r of WORKSPACE_ROOTS) {
      try {
        out.push(readFileSync(join(REPO_ROOT, r, 'package.json'), 'utf8'));
        found.push(r);
      } catch {
        // Recorded by its absence from `found`, and asserted on below.
      }
    }
    return { text: out.join('\n'), found };
  };

  it('reads every workspace manifest it claims to check', () => {
    expect(
      workspaceManifests().found,
      'workspace manifest(s) did not load, so the processor check below is silently reading fewer manifests than it believes',
    ).toEqual(WORKSPACE_ROOTS);
  });

  it('names every shipped processor, or records it as inert with a reason', () => {
    const { text: manifests } = workspaceManifests();
    const named = new Set(DISCLOSURE_RECIPIENTS.map((r) => r.organisation));

    const undisclosed: string[] = [];
    for (const [fragment, org] of Object.entries(PROCESSOR_SDKS)) {
      // Match only inside a dependency position, so a mention in a description
      // or a script name does not count as shipping the SDK.
      if (!new RegExp(`"[^"]*${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"\\s*:\\s*"`).test(manifests)) {
        continue;
      }
      // "Google" and "Cloudflare" have no SDK, so they are never reached here;
      // they are infrastructure and are listed unconditionally.
      const disclosed = [...named].some((n) => n.startsWith(org));
      if (!disclosed && !INERT_IN_PRODUCTION[org]) undisclosed.push(org);
    }

    expect(
      undisclosed,
      'processor SDK(s) shipped but not disclosed in DISCLOSURE_RECIPIENTS, and not recorded as inert in production',
    ).toEqual([]);
  });

  it('states something checkable for every recipient', () => {
    expect(DISCLOSURE_RECIPIENTS.length).toBeGreaterThan(0);
    for (const r of DISCLOSURE_RECIPIENTS) {
      expect(r.organisation.trim(), 'recipient with no organisation').not.toBe('');
      // A member has to be able to tell whether the claim is true of them, so
      // "what" carries the weight and a placeholder defeats the point.
      expect(r.what.trim().length, `${r.organisation}: "what" too thin to check`).toBeGreaterThan(40);
      expect(r.why.trim().length, `${r.organisation}: "why" too thin to check`).toBeGreaterThan(40);
    }
  });

  it('carries the recipients into the assembled document', async () => {
    const result = await assembleMemberExport(stubClient(), PLAYER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.disclosure_recipients).toEqual(DISCLOSURE_RECIPIENTS);
  });
});

describe('tables with column-level grants', () => {
  it('never asks for * on data_api_consumers, which 00241 refuses to service_role', async () => {
    // STAGING CAUGHT THIS, NOT A TEST. 00241 grants service_role SELECT on
    // named columns of data_api_consumers only, withholding player_ref_salt.
    // PostgREST checks every column a select list names even for a head-only
    // count, so `select('*', { head: true })` came back 403, and one failed
    // read fails the whole export by design. Every member's export on staging
    // returned 503. This stub refuses '*' on that table the way Postgres does.
    const base = stubClient();
    const client: ExportClient = {
      from(table: string) {
        const inner = base.from(table);
        return {
          select(columns: string, options?: any) {
            if (table === 'data_api_consumers' && columns.trim() === '*') {
              return new StubQuery([], options?.head === true, 'permission denied for table data_api_consumers');
            }
            return inner.select(columns, options);
          },
        };
      },
    };
    const result = await assembleMemberExport(client, PLAYER_ID);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.failures)).toBe(true);
  });
});
