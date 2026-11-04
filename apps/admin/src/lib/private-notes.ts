// THE REST OF THE EXEC'S OWN WORDS, AND WHO MAY SEE THEM.
//
// The sibling of lib/match-note.ts, which did this for `matches.admin_note`
// under migration 00117. That was the first such column looked at, not the only
// one. 00118 moves the four that remained:
//
//   tournament_participants.notes  withdrawal / DQ reason for a singles entry
//   tournament_pairs.notes         the same, for a doubles entry
//   tournament_matches.notes       void / double-no-show / restore reason
//   walkovers.admin_notes          the reason a walkover was confirmed/rejected
//
// ONE MODULE, NOT FOUR. match-note.ts is shaped around a single table and reads
// well for it; four copies of it would be four places for the missing-table
// predicate and the "who may read" rule to drift apart. What differs per table
// is data — the table name, the key column, the capabilities — so it is held as
// data, and the three functions below are shared.
//
// WHY NOT FOLD match-note.ts IN HERE TOO. It is reachable from /matches, this
// module is reachable from /tournaments, /walkovers and /players, and merging
// them would make every one of those pages import the others' constants for
// nothing. The one thing that genuinely must not be duplicated — the
// missing-table predicate — is shared instead: match-note.ts's
// isMissingNoteTableError now delegates to isMissingTableError below.

import { permits, type AccessLevel, type Capability, type Permissions } from './permissions';
// Deep path, not the barrel, for the same reason the type-only import below is
// type-only: this module is unit-tested without a request, and the barrel drags
// in the email sender and its Resend/Supabase clients. query-chunks is pure.
import { selectInChunks } from '@badminton/shared/src/utils/query-chunks';
// TYPE-ONLY, and it has to stay that way — the same constraint match-note.ts
// documents. supabase-server.ts reaches for next/headers and the passkey cookie
// machinery at import time; a value import here would drag all of it into the
// unit tests, which have no request to read cookies from. `import type` is
// erased entirely.
import type { createAdminClient } from './supabase-server';

/**
 * "PostgREST/Postgres has never heard of this table."
 *
 * Lifted out of match-note.ts so both modules answer it the same way, and
 * PARAMETERISED ON THE TABLE NAME, which is the one line that could not simply
 * be imported: the original's message backstop reads
 * `message.includes(MATCH_ADMIN_NOTE_TABLE)`, so importing it unchanged would
 * have silently failed the codeless-error case for all four tables here — the
 * exact kind of near-miss reuse that is worse than duplication.
 *
 * THIS IS A DIFFERENT FAMILY FROM 00116's, and copying that predicate would
 * miss it. `isUnknownColumnError` in lib/actions/sessions.ts swallows PGRST204
 * and 42703 — a missing COLUMN on a table that exists. Here the whole TABLE is
 * absent, which PostgREST answers out of its schema cache as PGRST205, or as
 * PGRST202 on a client whose reader predates that code, and which Postgres
 * itself raises as 42P01 (undefined_table) if the statement gets past the cache.
 *
 * EVERYTHING ELSE IS THE CALLER'S PROBLEM, and that is the point of naming
 * codes at all. A blanket catch would mean that once 00118 is applied a genuine
 * failure — a constraint, a connection, a permission — still ends in a green
 * toast, and the exec walks away believing a reason was recorded that was not.
 */
export function isMissingTableError(
  error: { code?: string | null; message?: string | null } | null | undefined,
  table: string,
): boolean {
  if (!error) return false;
  if (error.code === 'PGRST205' || error.code === 'PGRST202' || error.code === '42P01') return true;
  // Backstop for a client that surfaces the message without a code — the same
  // shape isUnknownColumnError uses, and for the same reason.
  const message = error.message ?? '';
  return message.includes(table) && /schema cache|does not exist/i.test(message);
}

/** One private-note table: where it lives and what column keys it. */
export interface PrivateNoteTable {
  /** The table 00118 creates. */
  readonly table: string;
  /** Its primary key, which is also the parent's id. */
  readonly key: string;
  /**
   * WHO MAY READ ONE: WHOEVER MAY AUTHOR ONE — 00117's rule, applied per table
   * rather than pooled. See the block comment below each entry.
   */
  readonly capabilities: readonly Capability[];
}

// WHY EACH SET IS WHAT IT IS.
//
// The rule is 00117's: the read is gated on the UNION of the capabilities that
// gate the writes which AUTHOR the text. Any single choice out of a union would
// leave an exec who wrote a note unable to read it back — a void-only officer
// typing a reason into the dialog and then finding the console silent about it.
//
// THE PAGE CAPABILITIES WERE THE OBVIOUS ALTERNATIVE AND ARE ALL WRONG, for the
// reason `matches.page` was wrong in 00117: `tournaments.page` and
// `walkovers.page` are the READ of the screen, held by anyone allowed merely to
// look, which is a strictly wider audience than the authors — and it is that
// wider audience this change exists to exclude. They still apply as the outer
// gate, because these sets are consulted on pages that already required them;
// the note set narrows within a page the viewer is already on, it never widens.
//
// NO NEW CAPABILITY IS MINTED. A new string is a vocabulary migration (the
// CHECK constraints on players.permission_grants / permission_revokes and
// permission_baselines.capabilities enumerate every legal value), plus a place
// in EDITOR_OFFERABLE, plus a decision about each baseline — all to re-answer a
// question the existing strings already answer.

/**
 * Withdrawal / disqualification reasons, singles.
 *
 * A ONE-ELEMENT UNION, and that is not an oversight: exitDrawImpl is the only
 * writer of this text, on all four of its exported entry points (withdraw and
 * disqualify, participant and pair), and every one of them is gated on this one
 * capability. Written as an array anyway so it reads as the same rule as the
 * other three rather than as a special case.
 */
export const PARTICIPANT_NOTES: PrivateNoteTable = {
  table: 'tournament_participant_notes',
  key: 'participant_id',
  capabilities: ['tournaments.draw.exit.write'],
};

/** The same text, the same single author capability, the doubles table. */
export const PAIR_NOTES: PrivateNoteTable = {
  table: 'tournament_pair_notes',
  key: 'pair_id',
  capabilities: ['tournaments.draw.exit.write'],
};

/**
 * Void / double-no-show / restore / walkover reasons.
 *
 * FOUR WRITERS, FOUR CAPABILITIES, and no one of them covers the others:
 * voidMatchImpl requires `tournaments.results.void.write` (or, from the court
 * card, a helper row on the match's court, 00310), recordDoubleNoShow
 * `…doublenoshow.write`, unvoidMatch `…unvoid.write`, enterWalkover
 * `…walkover.write`. The restore panel quotes the void reason back at whoever
 * is restoring, so an unvoid-only officer must be able to read what a void-only
 * officer wrote — which is the union, exactly.
 *
 * The walkover reason joined this list last and from a different direction: the
 * other three were moved off `tournament_matches.notes` by 00118, while the
 * walkover's sentence sat in `walkover_reason` — a column no sweep scoped by
 * the word "note" ever looked at — and was broadcast on every bracket channel
 * until it was moved here. It is written from the same dialog as the other
 * three and read from the same summary line, so it belongs in the same table
 * rather than in a fifth one.
 */
export const TOURNAMENT_MATCH_NOTES: PrivateNoteTable = {
  table: 'tournament_match_notes',
  key: 'match_id',
  capabilities: [
    'tournaments.results.void.write',
    'tournaments.results.doublenoshow.write',
    'tournaments.results.unvoid.write',
    'tournaments.results.walkover.write',
  ],
};

/**
 * Walkover verdicts.
 *
 * Confirm and reject write the same column from two different dialogs behind
 * two different capabilities, and /walkovers lists both outcomes together — so
 * a reject-only officer looking at that list must be able to read the confirmed
 * rows' notes, and vice versa.
 */
export const WALKOVER_NOTES: PrivateNoteTable = {
  table: 'walkover_admin_notes',
  key: 'walkover_id',
  capabilities: ['walkovers.confirm.write', 'walkovers.reject.write'],
};

/**
 * May this viewer read the notes in this table?
 *
 * A UNION, for the reason above: the rule is "you may read what you may write",
 * and most of these have more than one writer. An admin passes before any set
 * is consulted — permits() short-circuits on the level.
 */
export function canReadPrivateNotes(
  level: AccessLevel | null,
  permissions: Permissions,
  spec: PrivateNoteTable,
): boolean {
  if (level === null) return false;
  return spec.capabilities.some((c) => permits(level, permissions, c));
}

/**
 * The notes for the parent rows on screen, keyed by parent id.
 *
 * Returns an EMPTY MAP for a database without the table, so every page that
 * calls this renders normally when the console is deployed ahead of 00118. Any
 * other error is thrown, where the page's own error handling can see it.
 *
 * The caller is responsible for the capability check. It is not done in here on
 * purpose — the same reasoning match-note.ts gives: this takes a Supabase
 * client, and a function that both authorises and fetches invites a call site
 * that passes the check it wants.
 */
export async function fetchPrivateNotes(
  // THE CLIENT'S OWN TYPE, not a structural "anything with .from()". A minimal
  // shape reads better and does not compile — match-note.ts records what
  // happens when you try. The tests pass a stub through `as never`, which is
  // the honest way to say "this is a fake".
  client: ReturnType<typeof createAdminClient>,
  spec: PrivateNoteTable,
  parentIds: string[],
): Promise<Map<string, string>> {
  if (parentIds.length === 0) return new Map();

  // Chunked. The parent ids here are match ids for a whole draw — 127 of them
  // for a 128 entrant event, already over the per-request budget — and `.in()`
  // is a query-string filter the proxy refuses past 8 KB.
  const { data, error } = await selectInChunks(parentIds, (ids) =>
    client.from(spec.table).select(`${spec.key}, note`).in(spec.key, ids) as never,
  );

  if (error) {
    if (isMissingTableError(error, spec.table)) return new Map();
    throw new Error(error.message ?? `Failed to read ${spec.table}`);
  }

  // THROUGH `unknown`, and the double cast is load-bearing rather than lazy.
  // PostgREST's client parses the select string IN THE TYPE SYSTEM, and it can
  // only do that for a string literal. `${spec.key}, note` is a template, so
  // the parse fails and `data` comes back as ParserError<…>[] — a type with no
  // index signature, which tsc then refuses to compare with Record<string,
  // string>[] ("neither type sufficiently overlaps"). match-note.ts never met
  // this because its select is the literal 'match_id, note'; the price of one
  // module serving four tables is that the column name is a variable.
  //
  // What the cast asserts is exactly what the query asks for and what the
  // migration guarantees: two text columns, `<parent>_id` and `note`, both NOT
  // NULL. The `!`s below are the same assertion at the row level.
  const rows = (data ?? []) as unknown as Record<string, string>[];
  return new Map(rows.map((row) => [row[spec.key]!, row.note!]));
}

/**
 * What a note write did. Three outcomes, not two.
 *
 * The two-way version — "null means fine" — collapses "written" and "the table
 * is not there yet" into one answer, and the callers need them apart: the audit
 * row must not claim a note it does not have, and the exec must not be nagged
 * about a migration they cannot run from the console. 00117 arrived at the same
 * three and this is deliberately the same shape.
 *
 *   recorded: true             the row is in the database (or was deleted,
 *                              for an empty note — see writePrivateNote).
 *   recorded: false, no error  00118 has not been applied here. Silent: the
 *                              reason is not LOST, because every caller writes
 *                              the same text to its audit row, and there is
 *                              nothing the person clicking the button could do
 *                              about it.
 *   error                      a real failure. Loud, always.
 */
export interface NoteWriteResult {
  recorded: boolean;
  error: string | null;
}

/**
 * Record — or clear — an exec's free text about one parent row.
 *
 * A SEPARATE STATEMENT, NEVER FOLDED INTO THE PARENT WRITE. That is the whole
 * reason this exists rather than a `notes:` line in each of the six updates it
 * replaces: 00118 is applied by hand, so this console can be — and routinely is
 * — deployed against a database that has never heard of these tables. Written
 * as part of the parent update, an absent table would fail the WHOLE statement
 * and `if (error) throw` would turn withdrawing a player into a red toast for
 * the sake of an annotation nobody asked about.
 *
 * IT NEVER THROWS, AND THE try/catch IS WHAT MAKES THAT TRUE RATHER THAN
 * NEARLY TRUE. Every caller runs this AFTER its parent write has already
 * committed, and the audit row comes after this. Throwing here would skip the
 * audit and leave the club with an unaudited destructive act — no record of who
 * withdrew an entry or why. 00117 shipped that bug and then fixed it; this
 * function is written so the same mistake cannot be made at six new call sites.
 *
 * Inspecting `error` alone is NOT enough for that guarantee. PostgREST failures
 * arrive as a resolved `{ error }`, but the layers under it do not: supabase-js
 * REJECTS on a transport failure — a dropped connection, a DNS blip, an aborted
 * fetch — and a rejection here would skip the audit just as effectively as a
 * `throw` would. A note is advisory; the audit row is not, so the catch is
 * deliberately total, and what it catches is reported as a real error rather
 * than quietly as "not recorded".
 *
 * AN EMPTY NOTE DELETES THE ROW rather than storing ''. The columns being
 * replaced were nullable and two of the call sites wrote `reason ?? null` and
 * `reason || null` — clearing was reachable and meant "there is no longer a
 * reason here". A row whose `note` is NOT NULL cannot represent that, so the
 * absence of a row does, which is the same convention 00117 chose ("no note is
 * the absence of a row").
 *
 * UPSERT, because one parent has one note — the parent id is the primary key.
 * A restore reason overwrites the void reason it replaces, exactly as the
 * single column did.
 */
export async function writePrivateNote(
  client: ReturnType<typeof createAdminClient>,
  spec: PrivateNoteTable,
  parentId: string,
  note: string | null | undefined,
  authorId: string,
): Promise<NoteWriteResult> {
  const text = (note ?? '').trim();

  try {
    const { error } = text
      ? await client.from(spec.table).upsert(
          {
            [spec.key]: parentId,
            note: text,
            author_id: authorId,
            // Sent explicitly as well as by trigger: the trigger fires on
            // UPDATE, and the INSERT half of an upsert would otherwise keep the
            // default.
            updated_at: new Date().toISOString(),
          },
          { onConflict: spec.key },
        )
      : await client.from(spec.table).delete().eq(spec.key, parentId);

    if (!error) return { recorded: true, error: null };
    if (isMissingTableError(error, spec.table)) return { recorded: false, error: null };
    return { recorded: false, error: error.message ?? 'The note could not be saved.' };
  } catch (thrown) {
    // Reported as a real error, not as a silent "not recorded": a transport
    // failure is not the pre-migration state, and the caller logs it to Sentry.
    return {
      recorded: false,
      error: thrown instanceof Error ? thrown.message : 'The note could not be saved.',
    };
  }
}
