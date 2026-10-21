import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDITABLE_COLUMNS, WITHHELD_COLUMNS, auditablePlayer } from '../auditable-player';

// FIX-LIST #17 — "deletion leaves identity in four places".
//
// The four are: auth.audit_log_entries (730 prod rows carrying the real email
// in payload.actor_username), public.audit_logs.old_value (26 prod rows holding
// an address), the deletion_requested_at tombstone, and free text nobody swept.
// The first is `auth`-schema and unreachable from the app — migration 00155
// hands it over. The tombstone is deliberately kept and the purge job says why.
// This file covers the two halves that ARE app code:
//
//   1. The purge jobs' anonymising field list, which had been missing
//      `exec_photo_url` and `handle` — a photo of the person and the one name
//      they chose, both public, both promised erased.
//   2. The four admin actions that wrote a whole `select('*')` player row into
//      a permanent audit table.
//
// The pinning tests are the point. Both halves failed the same way — a list
// maintained by hand fell behind the table it describes — so the tests check
// the lists against the table rather than against a fixture.

const REPO = join(__dirname, '../../../../..');
const ANONYMIZE = join(REPO, 'supabase/functions/_shared/anonymize.ts');
const GEN_TYPES = join(REPO, 'packages/shared/src/types/database.gen.ts');

/** Every column `players` actually has, read from the generated types. */
function playerColumns(): string[] {
  const src = readFileSync(GEN_TYPES, 'utf8');
  const start = src.indexOf('      players: {');
  expect(start, 'players table not found in database.gen.ts').toBeGreaterThan(-1);
  const seg = src.slice(start, start + 8000);
  const row = seg.slice(seg.indexOf('Row: {'), seg.indexOf('Insert: {'));
  const cols = [...row.matchAll(/^\s{10}([a-z_]+):/gm)].map((m) => m[1] as string);
  expect(cols.length).toBeGreaterThan(30);
  // 00130 added exec_bio and the generated types have not been regenerated
  // since. It is a real column — both purge jobs write it — so it counts.
  return cols.includes('exec_bio') ? cols : [...cols, 'exec_bio'];
}

/** The list the purge jobs erase, read from the file both of them import. */
function identityColumns(): string[] {
  const src = readFileSync(ANONYMIZE, 'utf8');
  const block = src.slice(src.indexOf('export const IDENTITY_COLUMNS'));
  const arr = block.slice(block.indexOf('['), block.indexOf(']'));
  return [...arr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
}

describe('a purged member keeps nothing that says who they were', () => {
  it('erases the exec photo and the handle, not only the avatar and the bio', () => {
    // The two the hand-maintained lists had missed. `exec_photo_url` is a
    // photograph on /exec that survived 00130's careful bio split; `handle` is
    // "the member's ONE chosen name" (00092), public and searchable, so leaving
    // it attached to a row now called Deleted Player defeats the whole erasure.
    const identity = identityColumns();
    expect(identity).toContain('exec_photo_url');
    expect(identity).toContain('handle');
    expect(identity).toContain('avatar_url');
    expect(identity).toContain('bio');
    expect(identity).toContain('exec_bio');
  });

  it('writes every column it claims to erase', () => {
    // The list and the update are two things in one file, and a name in the
    // list that is not in the update erases nothing.
    const src = readFileSync(ANONYMIZE, 'utf8');
    const body = src.slice(src.indexOf('export function anonymizedPlayerFields'));
    for (const col of identityColumns()) {
      expect(body, `${col} is listed as identity but never written`).toMatch(
        new RegExp(`\\b${col}:`),
      );
    }
  });

  it('never writes full_name, which is generated', () => {
    // Writing it raises "column full_name can only be updated to DEFAULT" and
    // takes the whole UPDATE down — after the auth user has already been
    // deleted. The prod copy of purge-deleted-accounts once had exactly this.
    const src = readFileSync(ANONYMIZE, 'utf8');
    const body = src.slice(src.indexOf('export function anonymizedPlayerFields'));
    expect(body).not.toMatch(/\bfull_name:/);
  });

  it('is the only place either purge job decides what to erase', () => {
    // Both jobs used to carry their own copy, which is how the two missing
    // columns went unnoticed through two careful reviews of one of them.
    for (const job of ['purge-deleted-accounts', 'purge-inactive-accounts']) {
      const src = readFileSync(join(REPO, `supabase/functions/${job}/index.ts`), 'utf8');
      expect(src, `${job} should import the shared field list`).toContain(
        "from '../_shared/anonymize.ts'",
      );
      expect(src, `${job} should not hand-build the anonymising update`).not.toMatch(
        /first_name:\s*'Deleted'/,
      );
    }
  });
});

describe('an audit row records standing, not identity', () => {
  const FULL_ROW = {
    id: 'p1', email: 'kiera@example.org', phone: '+16045550101',
    first_name: 'Kiera', last_name: 'Tan', full_name: 'Kiera Tan',
    display_name: 'Kiera', handle: 'kiera', avatar_url: 'https://cdn/a.jpg',
    exec_photo_url: 'https://cdn/e.jpg', bio: 'I play left-handed.',
    exec_bio: 'VP Competitive since 2024.', user_id: 'u1',
    notification_preferences: { email: true },
    status: 'active', role: 'player', is_banned: true, ban_reason: 'No-shows',
    is_exec: false, active_flag: true, fee_exempt: false,
  };

  it('drops every identifying field', () => {
    const kept = auditablePlayer(FULL_ROW);
    const serialised = JSON.stringify(kept);
    for (const value of ['kiera@example.org', '+16045550101', 'Kiera', 'Tan',
                         'cdn/a.jpg', 'cdn/e.jpg', 'left-handed', 'VP Competitive']) {
      expect(serialised, `${value} survived into the audit row`).not.toContain(value);
    }
    expect(kept).not.toHaveProperty('email');
    expect(kept).not.toHaveProperty('user_id');
  });

  it('keeps what the act was actually about', () => {
    // Without this, "drops everything" would pass and the audit trail would be
    // useless — an exec reading why somebody was banned needs the ban.
    const kept = auditablePlayer(FULL_ROW);
    expect(kept).toMatchObject({
      id: 'p1', status: 'active', role: 'player',
      is_banned: true, ban_reason: 'No-shows', active_flag: true,
    });
  });

  it('leaves absent keys absent rather than inventing nulls', () => {
    expect(auditablePlayer({ id: 'p1', status: 'active' })).toEqual({ id: 'p1', status: 'active' });
    expect(auditablePlayer(null)).toBeNull();
  });

  it('classifies every column the players table has', () => {
    // The pin. A new column on `players` is neither kept nor withheld until
    // somebody decides which, and this fails until they do — which is the
    // check that was missing when exec_photo_url was added.
    const classified = new Set<string>([...AUDITABLE_COLUMNS, ...WITHHELD_COLUMNS]);
    const unclassified = playerColumns().filter((c) => !classified.has(c));
    expect(unclassified, 'new players column(s) not classified in auditable-player.ts').toEqual([]);
  });

  it('agrees with the purge about what identity is', () => {
    // Two lists in two apps describing the same idea. They may differ in
    // exactly one way: full_name is identity but cannot be WRITTEN, so the
    // purge erases it via first_name/last_name instead of naming it.
    const withheld = new Set<string>(WITHHELD_COLUMNS);
    const purgeOnly = identityColumns().filter((c) => !withheld.has(c));
    expect(purgeOnly, 'the purge erases something the audit row still keeps').toEqual([]);

    const auditOnly = [...WITHHELD_COLUMNS].filter((c) => !identityColumns().includes(c));
    expect(auditOnly.sort()).toEqual(['full_name', 'notification_preferences']);
  });
});

describe('no admin action writes a raw player row to the audit log', () => {
  const SITES = ['actions/players.ts', 'actions/permissions.ts'];

  it('every audit write of a player row goes through auditablePlayer', () => {
    // The scan is what stops a fifth site. `select('*')` on players is the
    // shape that makes this easy to get wrong, and it is used at all four.
    //
    // What it looks for is the row passed WHOLE — `oldPlayer` with nothing
    // after it. `oldPlayer?.waiver_reset_at` is a named field the caller chose
    // and is not this bug; a first version of this scan flagged it, which is
    // the false positive that would have made the test noise rather than a
    // gate.
    const offenders: string[] = [];
    for (const rel of SITES) {
      const src = readFileSync(join(__dirname, '..', rel), 'utf8');
      for (const m of src.matchAll(/old_value:\s*([^\n]+)/g)) {
        const value = m[1] ?? '';
        if (/\boldPlayer\b(?!\s*\??\.)/.test(value) && !value.includes('auditablePlayer(')) {
          offenders.push(`${rel}: ${value.trim()}`);
        }
      }
    }
    expect(
      offenders,
      'a whole player row is being written to audit_logs — wrap it in auditablePlayer()',
    ).toEqual([]);
  });
});

describe('a purged member keeps no artifact that was only ever theirs', () => {
  /**
   * Every `player_id`-keyed table in the schema, read from the migrations
   * rather than from a list somebody maintains.
   */
  function playerKeyedTables(): string[] {
    const dir = join(REPO, 'supabase/migrations');
    const found = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const src = readFileSync(join(dir, file), 'utf8');
      for (const m of src.matchAll(
        /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\n\)\s*;/gi,
      )) {
        if (/^\s*player_id\b/m.test(m[2] ?? '')) found.add(m[1] as string);
      }
    }
    expect(found.size, 'no player_id tables parsed, the regex has rotted').toBeGreaterThan(20);
    return [...found].sort();
  }

  /**
   * A named list from _shared/anonymize.ts.
   *
   * Ends the slice on `] as const` rather than on the first `]`. The comments
   * in that file cite route paths, and `/api/calendar/[token]` closed the array
   * early: the parser returned the first four tables, silently, and the pin
   * below passed for the wrong reason. Exactly the failure these tests exist to
   * make loud, so the fix is pinned by the length assertion too.
   */
  function sharedList(name: string): string[] {
    const src = readFileSync(ANONYMIZE, 'utf8');
    const block = src.slice(src.indexOf(`export const ${name}`));
    const end = block.indexOf('] as const');
    expect(end, `${name} should be a list ending in "] as const"`).toBeGreaterThan(-1);
    // Drop comment lines before matching rather than anchoring on layout: one
    // of these lists is multi-line with a comment per entry and the other is a
    // single line, so any rule about where a name sits is wrong for one of them.
    const arr = block
      .slice(block.indexOf('['), end)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    const names = [...arr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
    expect(names.length, `${name} parsed as empty`).toBeGreaterThan(0);
    return names;
  }

  // Why each player-keyed table the purge does NOT clear is allowed to stay.
  //
  // A reason per table, rather than a bare allowlist, because the two bugs this
  // file exists for were both "nobody looked at that one". Writing the sentence
  // is the review. Most of these come down to one of two things: the row is
  // also somebody ELSE's record, or it is a record the club has to keep.
  const KEPT: Record<string, string> = {
    announcement_reads: 'the club\'s record of who has seen a notice; no identity in the row',
    challenge_participants: 'a challenge has two players and the row is both their record',
    club_event_signups: 'who signed up for a club event, the operational record of that event like session_rsvp',
    club_fees: 'a financial record, kept for the same reason a receipt is',
    digest_deliveries: 'the delivery key that stops a digest sending twice; activity, not identity',
    event_feedback: 'written about a club event, and part of the record of that event',
    event_waiver_acceptances: 'legal evidence, per tournament',
    fee_submissions: 'the club\'s record of a payment it confirmed or refused; the screenshot is erased by _shared/fee-proofs.ts and its path nulled, a form upload (00288) found by the member\'s email too',
    legacy_tournament_participants: 'shared competitive history',
    match_participants: 'a match has two to four players',
    ratings: 'derived from matches other members played, and their Elo depends on it',
    reinstatement_fees: 'a financial record of a reinstatement the club processed',
    reliability_metrics: 'derived attendance, referenced by other members\' no-show handling',
    season_final_ratings: 'historical standings that other members appear in',
    season_snapshots: 'historical standings, and the input to season comparisons',
    session_attendance: 'who was at a session, which is every attendee\'s record',
    session_rsvp: 'the club\'s operational record of a session',
    tournament_fees: 'a financial record of an entry the member paid for',
    tournament_event_waitlist: 'the queue order of an event, which decided who else got a place',
    club_event_waitlist: 'the queue order of a club event, which decided who else got a place',
    tournament_participants: 'shared competitive history, draws and results',
    // NOT SETTLED, and deliberately recorded as unsettled rather than quietly
    // kept. `varsity_notes.note` is free text an exec wrote ABOUT this member,
    // so it is plainly information about the person, and an argument for
    // clearing it is easy to make. It is kept for now because the club runs
    // under Campus Recreation: FIPPA brings a records retention schedule with it,
    // and under a schedule deleting early is its own breach. Erasing on a guess
    // is the one move that cannot be undone. See docs/design/open-issues.md
    // Part 10.6.
    varsity_notes: 'OPEN: free text about the member, held pending the records-schedule answer',
    waiver_acceptances: 'legal evidence, and the reason the table is append-only',
  };

  it('classifies every player-keyed table as cleared, unlinked or kept', () => {
    // THE PIN, and the check that was missing when player_discord_links was
    // added. A new table keyed on player_id is neither cleared nor justified
    // until somebody says which, and this fails until they do.
    const handled = new Set<string>([
      ...sharedList('PERSONAL_ARTIFACT_TABLES'),
      ...sharedList('DELINKED_TABLES'),
      ...Object.keys(KEPT),
    ]);
    const unclassified = playerKeyedTables().filter((t) => !handled.has(t));
    expect(
      unclassified,
      'new player_id table(s): add to PERSONAL_ARTIFACT_TABLES, DELINKED_TABLES, or KEPT with a reason',
    ).toEqual([]);
  });

  it('gives every kept table a real reason', () => {
    for (const [table, reason] of Object.entries(KEPT)) {
      expect(reason.length, `${table} needs a reason, not a placeholder`).toBeGreaterThan(20);
    }
  });

  it('clears the Discord link and the calendar token', () => {
    // The two that re-identify a purged member. The Discord link maps the row
    // to a live snowflake anyone holding it can read through; the calendar token
    // IS the authentication for that member's feed.
    const cleared = sharedList('PERSONAL_ARTIFACT_TABLES');
    expect(cleared).toContain('player_discord_links');
    expect(cleared).toContain('calendar_feed_tokens');
    expect(cleared).toContain('push_subscriptions');
    expect(cleared).toContain('passkey_credentials');
  });

  it('does not clear a table that belongs to a second member', () => {
    // The inverse failure, and the more damaging one: clearing session
    // attendance or match participation would rewrite other members' history
    // and silently change their Elo. Nothing in the shared lists may name a
    // table justified as shared.
    const cleared = new Set<string>([
      ...sharedList('PERSONAL_ARTIFACT_TABLES'),
      ...sharedList('DELINKED_TABLES'),
    ]);
    const overlap = Object.keys(KEPT).filter((t) => cleared.has(t));
    expect(overlap, 'a table is both kept and cleared, so one of the two is wrong').toEqual([]);
  });

  it('is the only place either purge job decides which tables to touch', () => {
    for (const job of ['purge-deleted-accounts', 'purge-inactive-accounts']) {
      const src = readFileSync(join(REPO, `supabase/functions/${job}/index.ts`), 'utf8');
      expect(src, `${job} should iterate the shared table list`).toContain(
        'for (const table of PERSONAL_ARTIFACT_TABLES)',
      );
      expect(src, `${job} should honour the declared SET NULL`).toContain(
        'for (const table of DELINKED_TABLES)',
      );
      // The shape the shared list replaced. A reintroduced literal is how the
      // lists drifted apart the first time.
      expect(src, `${job} should not name artifact tables inline`).not.toMatch(
        /from\('push_subscriptions'\)/,
      );
    }
  });

  it('erases payment screenshots while the auth folder is still known', () => {
    // fee-proofs is keyed on the AUTH user id (00248's upload policy), which
    // is gone once deleteUser runs and the row is anonymised.
    for (const job of ['purge-deleted-accounts', 'purge-inactive-accounts']) {
      const src = readFileSync(join(REPO, `supabase/functions/${job}/index.ts`), 'utf8');
      const erase = src.indexOf('eraseFeeProofs(supabase, player.id, player.user_id)');
      expect(erase, `${job} should erase fee proofs`).toBeGreaterThan(-1);
      expect(erase, `${job} erases fee proofs after deleting the auth user`).toBeLessThan(
        src.indexOf('supabase.auth.admin.deleteUser'),
      );
    }
  });

  it('erases a form upload (00288) by the member or their email, before the email is scrubbed', () => {
    // A screenshot a Google Form collected sits under forms/, outside the
    // member's folder, and may name them only by the email they typed. That
    // email is gone once the purge anonymises the row, which is why the
    // erasure runs first (pinned above) and reads it itself.
    const src = readFileSync(join(REPO, 'supabase/functions/_shared/fee-proofs.ts'), 'utf8');
    expect(src).toContain(".from('players')");
    expect(src).toContain("['submitter_player_id', playerId]");
    expect(src).toContain("['submitter_email', email]");
    expect(src).toContain('.eq(`registration_imports.${column}`, value)');
    expect(src).toContain(".eq('manual_email', email)");
    expect(src).toMatch(/from\('registration_import_receipts'\)\s*\.update\(\{ storage_path: null \}\)/);
  });

  it('scrubs the audit trails once after the loop, never inside it', () => {
    // scrub_deleted_identity() takes no arguments and finds its work by two
    // predicates that only hold once the loop has finished: an auth row whose
    // actor is gone from auth.users, and a players row with user_id NULL and a
    // deleted+ sentinel email. Called per player before the anonymising update
    // it matches nothing, scrubs nothing, and reports success.
    for (const job of ['purge-deleted-accounts', 'purge-inactive-accounts']) {
      const src = readFileSync(join(REPO, `supabase/functions/${job}/index.ts`), 'utf8');
      expect(src, `${job} should call the scrub`).toContain("rpc('scrub_deleted_identity')");
      const loopStart = src.indexOf('for (const player of');
      const loopEnd = src.indexOf('\n  }\n', loopStart);
      const insideLoop = src.slice(loopStart, loopEnd);
      expect(
        insideLoop,
        `${job} calls scrub_deleted_identity inside the per-player loop, where it matches nothing`,
      ).not.toContain('scrub_deleted_identity');
    }
  });
});

describe('a purged member leaves no typed name or address anywhere', () => {
  // The pin above only sees a column literally named `player_id`, and the
  // Google Form import (00283, 00284) stored people somewhere it never looks:
  // under their TYPED name and email, with no player id at all, on rows made
  // before they were a member or by somebody naming them as a partner. A
  // deletion left every one of them in place until 00285. This pin is over the
  // columns themselves, so the next table that keeps a typed person fails here
  // until somebody decides what a deletion does to it.

  const MIGRATIONS = join(REPO, 'supabase/migrations');

  /** A column that can hold a person's typed name or address. */
  const IDENTITY_SHAPED =
    /^(email|[a-z0-9_]+_email|full_name|first_name|last_name|display_name|[a-z0-9_]+_name)$/;

  /**
   * Every text column of that shape the migrations leave in the schema:
   * CREATE TABLE bodies, ADD COLUMN, DROP COLUMN, RENAME, and DROP TABLE,
   * replayed in file order. Comments are stripped first, because 00283's
   * headers name the very columns this is looking for.
   */
  function identityShapedColumns(): string[] {
    const tables = new Map<string, Set<string>>();
    const statement =
      /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\n\)\s*;|ALTER TABLE(?: IF EXISTS)?(?: ONLY)?\s+(?:public\.)?([a-z_0-9]+)([\s\S]*?);|DROP TABLE(?: IF EXISTS)?\s+(?:public\.)?([a-z_0-9]+)/gi;
    const textType = '(?:text|varchar|citext|character varying)\\b';
    const columnLine = new RegExp(`^\\s*([a-z_0-9]+)\\s+${textType}`, 'i');
    const addColumn = new RegExp(`ADD COLUMN(?: IF NOT EXISTS)?\\s+([a-z_0-9]+)\\s+${textType}`, 'gi');
    for (const file of readdirSync(MIGRATIONS).filter((f) => /^\d+.*\.sql$/.test(f)).sort()) {
      const src = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
      for (const m of src.matchAll(statement)) {
        if (m[1]) {
          const cols = tables.get(m[1]) ?? new Set<string>();
          for (const line of (m[2] ?? '').split('\n')) {
            const col = line.match(columnLine);
            if (col) cols.add(col[1] as string);
          }
          tables.set(m[1], cols);
        } else if (m[3]) {
          const cols = tables.get(m[3]) ?? new Set<string>();
          const body = m[4] ?? '';
          for (const added of body.matchAll(addColumn)) cols.add(added[1] as string);
          for (const dropped of body.matchAll(/DROP COLUMN(?: IF EXISTS)?\s+([a-z_0-9]+)/gi)) {
            cols.delete(dropped[1] as string);
          }
          for (const renamed of body.matchAll(/RENAME COLUMN\s+([a-z_0-9]+)\s+TO\s+([a-z_0-9]+)/gi)) {
            if (cols.delete(renamed[1] as string)) cols.add(renamed[2] as string);
          }
          const renamedTable = body.match(/^\s*RENAME TO\s+([a-z_0-9]+)/i);
          tables.delete(m[3]);
          tables.set(renamedTable ? (renamedTable[1] as string) : m[3], cols);
        } else if (m[5]) {
          tables.delete(m[5]);
        }
      }
    }
    const found: string[] = [];
    for (const [table, cols] of tables) {
      for (const col of cols) if (IDENTITY_SHAPED.test(col)) found.push(`${table}.${col}`);
    }
    expect(found.length, 'no identity-shaped columns parsed, the parser has rotted').toBeGreaterThan(20);
    return found.sort();
  }

  /** The body of 00285's scrub, the function the purge trigger calls. */
  function scrubBody(): string {
    const file = readdirSync(MIGRATIONS).find((f) => f.startsWith('00285_'));
    expect(file, '00285 is missing').toBeDefined();
    const src = readFileSync(join(MIGRATIONS, file as string), 'utf8');
    const start = src.indexOf('CREATE OR REPLACE FUNCTION public.scrub_registration_identity(');
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('$function$;', start));
  }

  // The players row itself: anonymizedPlayerFields, pinned by the first
  // describe in this file. full_name is generated from first and last.
  const ANONYMISED = [
    'players.display_name',
    'players.email',
    'players.first_name',
    'players.full_name',
    'players.last_name',
  ];

  // Rewritten by scrub_registration_identity (00285) when the purge's marker
  // lands on players.email, matched on the address the member had. Each is
  // checked against the function body below.
  const SCRUBBED: Record<string, string> = {
    'registration_imports.submitter_name': 'their own form response from before they joined, nulled',
    'registration_imports.submitter_email': 'their own form response from before they joined, nulled',
    'registration_import_entries.external_name': 'their entry as a non-member, nulled; the entry stays',
    'registration_import_entries.external_email': 'their entry as a non-member, nulled; the entry stays',
    'registration_import_entries.partner_name': 'somebody else naming them by their address, nulled',
    'registration_import_entries.partner_email': 'somebody else naming them by their address, nulled',
    'club_event_external_signups.full_name': 'their guest place, kept as a place under Deleted Player',
    'club_event_external_signups.email': 'their guest place, given a per-row deleted.invalid address',
    'guest_waiver_invites.email': 'per-row deleted.invalid address, and cancelled if unsent so it is never mailed',
    'club_fees.manual_name': 'a named fee the claim could not move, kept under Deleted Player',
    'club_fees.manual_email': 'a named fee the claim could not move, nulled or given a per-row placeholder',
    'tournament_pairs.external1_name': 'the external team the import entered, the slot that was them',
    'tournament_pairs.external2_name': 'the external team the import entered, the slot that was them',
    'tournament_pairs.pair_name': 'rebuilt only when it is the default "A / B" of the two names',
  };

  // Left in place on purpose, with the reason.
  const KEPT: Record<string, string> = {
    'guest_waiver_signings.full_name':
      'a signed guest waiver is legal evidence, kept permanently and never joined to an account (privacy policy section 6)',
    'guest_waiver_signings.email':
      'a signed guest waiver is legal evidence, kept permanently and never joined to an account (privacy policy section 6)',
    'email_suppressions.email':
      'the addresses the mail provider refused; dropping one would mail a dead or unwilling address again',
    'discord_signup_drafts.first_name': 'pre-account scratch with no player id, deleted within 30 minutes (00281)',
    'discord_signup_drafts.last_name': 'pre-account scratch with no player id, deleted within 30 minutes (00281)',
    'discord_signup_drafts.display_name': 'pre-account scratch with no player id, deleted within 30 minutes (00281)',
    'discord_signup_drafts.email': 'pre-account scratch with no player id, deleted within 30 minutes (00281)',
  };

  // Shaped like a person's name and are not one.
  const NOT_A_PERSON: Record<string, string> = {
    'discord_club_events.synced_name': 'the club event title last pushed to Discord',
    'discord_tournament_events.synced_name': 'the tournament event title last pushed to Discord',
    'discord_guild_roles.role_name': 'a Discord role in the bot\'s role mapping',
    'discord_server_roles.role_name': 'a Discord role discovered on a server',
    'tournament_matches.round_name': 'a bracket round such as "Quarterfinal"',
  };

  const classified = (): string[] => [
    ...ANONYMISED,
    ...Object.keys(SCRUBBED),
    ...Object.keys(KEPT),
    ...Object.keys(NOT_A_PERSON),
  ];

  it('classifies every column that can hold a typed name or address', () => {
    const handled = new Set<string>(classified());
    const unclassified = identityShapedColumns().filter((c) => !handled.has(c));
    expect(
      unclassified,
      'new name or email column(s): scrub them on purge (00285 shows how), or add to KEPT or NOT_A_PERSON with a reason',
    ).toEqual([]);
  });

  it('lists nothing that no longer exists', () => {
    // The inverse, so a dropped or renamed column cannot leave a stale entry
    // that makes the classification look more complete than it is.
    const present = new Set(identityShapedColumns());
    expect(classified().filter((c) => !present.has(c))).toEqual([]);
  });

  it('really writes every column it says it scrubs', () => {
    // Declared is not done: the import's SET NULL columns were declared
    // delinked, and the purge's UPDATE has never fired a single one of them.
    const body = scrubBody();
    for (const qualified of Object.keys(SCRUBBED)) {
      const [table, col] = qualified.split('.') as [string, string];
      expect(body.indexOf(`UPDATE ${table}`), `the scrub never updates ${table}`).toBeGreaterThan(-1);
      expect(body, `the scrub never writes ${qualified}`).toMatch(new RegExp(`\\b${col} = `));
    }
  });

  it('leaves the players columns to the purge itself', () => {
    for (const qualified of ANONYMISED.filter((c) => c !== 'players.full_name')) {
      expect(identityColumns()).toContain(qualified.split('.')[1]);
    }
  });

  it('gives every scrubbed, kept or not-a-person column a real reason', () => {
    for (const [col, reason] of Object.entries({ ...SCRUBBED, ...KEPT, ...NOT_A_PERSON })) {
      expect(reason.length, `${col} needs a reason, not a placeholder`).toBeGreaterThan(20);
    }
  });
});
