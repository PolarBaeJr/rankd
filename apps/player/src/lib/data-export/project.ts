// PROJECTING A THIRD PARTY OUT OF A ROW THAT IS ALSO ABOUT THE REQUESTER.
//
// THE RULE, applied at every site in the assembler: the requester's own fields
// come through verbatim, and every other member is reduced to a stable
// per-export opaque pseudonym (`member_1`, `member_2`, ...) or a role-level
// descriptor. NEVER A UUID AND NEVER A NAME.
//
// WHY A UUID IS THE THING TO WORRY ABOUT, rather than the name. A name is
// already semi-public in this club -- the leaderboard shows it. A player uuid
// is a JOINABLE IDENTIFIER across the whole rest of the app: it appears in
// /leaderboard/[playerId] URLs, in every realtime filter, and in every table in
// the schema. Handing one out turns this export from a record of the
// requester's information into a lookup key for somebody else's. The pseudonym
// is deliberately per-export and meaningless outside the one file, so
// `member_3` in one member's download has nothing to do with `member_3` in
// another's.
//
// NO I/O HERE either, for the same reason as the registry: the coverage test
// imports this file to check the projection mechanically.

import { AUDIT_JSONB_ALLOWLIST } from './registry';

/**
 * What the export calls a member who is not the requester.
 *
 * `you` is the requester. Everybody else is `member_N` in first-seen order.
 * The allocator is constructed with the requester's OWN ids, so a projection
 * site that forgets which id it is holding gets `you` back rather than leaking
 * a pseudonym for the requester themselves.
 *
 * `selfIds` is a set rather than one id because the second namespace needs it:
 * the assembler allocates a separate `entrant_N` allocator over tournament
 * ENTRY ids, and the requester owns several of those.
 */
export interface PseudonymAllocator {
  /** null in, null out: a nullable officer column stays nullable. */
  forMember(id: string | null | undefined): string | null;
  /** How many distinct other members (or entries) the file mentions. */
  count(): number;
}

export function createPseudonymAllocator(
  selfIds: Iterable<string>,
  prefix = 'member',
): PseudonymAllocator {
  const mine = new Set<string>(selfIds);
  const assigned = new Map<string, string>();
  return {
    forMember(id) {
      if (!id) return null;
      if (mine.has(id)) return 'you';
      const existing = assigned.get(id);
      if (existing) return existing;
      const pseudonym = `${prefix}_${assigned.size + 1}`;
      assigned.set(id, pseudonym);
      return pseudonym;
    },
    count() {
      return assigned.size;
    },
  };
}

/**
 * What the export calls the officer in an officer column.
 *
 * NOT A PSEUDONYM, on purpose. `marked_by`, `checked_in_by`, `resolved_by`,
 * `banned_by` and their siblings are somebody acting in a club ROLE, and the
 * fact the requester is entitled to is "an officer did this", not "this
 * particular officer did this". A pseudonym would be worse than a descriptor
 * here: it is stable within the file, so `member_4` appearing as the officer on
 * six different rows tells the requester those six acts were the same person,
 * which is a fact about that person and not about them.
 *
 * It is also honest about what the export knows. Naming the ROLE ("a trainer",
 * "a president") would need a read of the officer's own row, which is a read of
 * another member's record to put a label in this one.
 */
export const OFFICER_DESCRIPTOR = 'a club officer';

export function officerDescriptor(id: string | null | undefined): string | null {
  return id ? OFFICER_DESCRIPTOR : null;
}

/** Keep only the named columns. A column absent from the row stays absent. */
export function pickColumns<T extends Record<string, unknown>>(
  row: T,
  columns: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    if (column in row) out[column] = row[column];
  }
  return out;
}

/** Drop the named columns, keep the rest. */
export function dropColumns<T extends Record<string, unknown>>(
  row: T,
  columns: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (!columns.includes(key)) out[key] = row[key];
  }
  return out;
}

const AUDIT_KEEP = new Set<string>(AUDIT_JSONB_ALLOWLIST);

/**
 * An `audit_logs.old_value` / `new_value` / `tournament_audit_log.details`
 * payload, reduced to the keys an export may carry.
 *
 * THE PAYLOAD IS THE DANGEROUS PART OF AN AUDIT ROW, not the row. Four console
 * actions wrote whole `select('*')` player rows into these columns and some
 * production rows still hold a real email address -- the reason
 * apps/admin/src/lib/auditable-player.ts exists at all. Nothing in a payload
 * says WHICH member it describes, so a payload cannot be trusted to be the
 * requester's own row even on a row whose target is the requester.
 *
 * ALLOWLIST, NOT DENYLIST, for the same asymmetry auditable-player.ts records:
 * a denylist that misses a new identity column leaks it silently and forever;
 * an allowlist that misses a new standing column leaves a key out of one
 * stanza, which is visible the first time anybody reads it.
 *
 * NON-OBJECT PAYLOADS ARE DROPPED WHOLE. A bare string or number gives the
 * filter nothing to work with -- there is no key to match, so there is no way
 * to tell an elo number from an email address -- and guessing is exactly what
 * an allowlist exists to avoid. The withheld stanza says so.
 */
export function filterAuditPayload(payload: unknown): Record<string, unknown> | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== 'object' || Array.isArray(payload)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    // Nested objects are dropped rather than recursed. A nested object under an
    // allowlisted key is not a standing column, it is a structure nobody has
    // classified, and recursing would let a whole player row through under any
    // key at all.
    if (!AUDIT_KEEP.has(key)) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * A push endpoint, cut back to the push service it points at.
 *
 * The two keys and the full endpoint TOGETHER are the credential that lets any
 * holder send a notification to that browser. The keys are withheld outright;
 * the endpoint is truncated rather than dropped because "you have a
 * subscription with Google's push service" is a fact about the member's own
 * account that the host alone conveys, and the unguessable path is the part
 * that makes it a credential.
 */
export function truncateEndpoint(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    return `${new URL(endpoint).origin}/[withheld]`;
  } catch {
    // An endpoint the URL parser refuses is not something to echo back into the
    // file on the off chance it is harmless.
    return '[withheld]';
  }
}

/**
 * A `head_to_head_stats` or `partnership_stats` row, rewritten so that the
 * numbers are the requester's.
 *
 * THE TRAP THIS EXISTS FOR. Both tables carry `CHECK (player_a_id <
 * player_b_id)` -- 00001:509 for head_to_head_stats, 00001:527 for
 * partnership_stats -- so which slot the requester occupies is decided by uuid
 * ordering and is therefore effectively random per opponent. A naive
 * `.eq('player_a_id', me)` returns roughly HALF the rows and looks perfectly
 * healthy doing it, which is why the assembler queries both columns with
 * `.or()` and every row then comes through here.
 *
 * The a/b columns never ship. `mine`/`theirs` is what the member asked for
 * anyway, and it cannot be got wrong silently the way a raw pair of columns can.
 */
/**
 * A data_api_predictions row (00282), rewritten so the requester's side comes
 * first. The stored row is in a canonical order (side1 holds the smaller first
 * uuid), so which side the member is on is effectively random, the same trap
 * as the pair-stats tables. The consumer, key and model never ship.
 */
export function rewritePredictionRelative(
  row: Record<string, unknown>,
  selfId: string,
  pseudonyms: PseudonymAllocator,
): Record<string, unknown> {
  const side1 = [row.side1_p1, row.side1_p2] as (string | null)[];
  const side2 = [row.side2_p1, row.side2_p2] as (string | null)[];
  const selfIsSide1 = side1.includes(selfId);
  const mine = selfIsSide1 ? side1 : side2;
  const theirs = selfIsSide1 ? side2 : side1;
  const p = Number(row.side1_win_probability);
  return {
    format: row.format,
    // Four places, as stored (numeric(5,4)), so 1 - p carries no float noise.
    my_side_win_probability: selfIsSide1 ? p : Number((1 - p).toFixed(4)),
    partner: pseudonyms.forMember(mine.find((id) => id && id !== selfId) ?? null),
    opponents: theirs.filter((id): id is string => !!id).map((id) => pseudonyms.forMember(id)),
    made_at: row.made_at,
    updated_at: row.updated_at,
  };
}

export function rewriteRequesterRelative(
  row: Record<string, unknown>,
  selfId: string,
  pseudonyms: PseudonymAllocator,
  /** Column name pairs, `[aColumn, bColumn, outputKey]`. */
  pairs: readonly [string, string, string][],
  /** Columns that are the same for both sides and come through as they are. */
  shared: readonly string[],
): Record<string, unknown> {
  const selfIsA = row.player_a_id === selfId;
  const otherId = (selfIsA ? row.player_b_id : row.player_a_id) as string | null;
  const out: Record<string, unknown> = {
    other_member: pseudonyms.forMember(otherId),
  };
  for (const [aColumn, bColumn, key] of pairs) {
    out[`my_${key}`] = selfIsA ? row[aColumn] : row[bColumn];
    out[`their_${key}`] = selfIsA ? row[bColumn] : row[aColumn];
  }
  for (const column of shared) {
    if (column in row) out[column] = row[column];
  }
  return out;
}
