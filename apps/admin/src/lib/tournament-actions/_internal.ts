// Internal helpers for the tournament server actions. NOT a 'use server'
// module — these aren't async actions exposed to the client, just utilities
// imported by the per-domain action files.
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  calculateEloUpdate,
  getKFactor,
  getMarginMultiplier,
  resolvedFormatWeight,
  eventEloMultiplier,
  isDoublesEvent,
  isOutOfEvent,
  isOpenMatch,
  forfeitOutcome,
  OPEN_MATCH_STATUSES,
  snakeGroupAssignment,
  tallyRoundRobin,
  rankRoundRobin,
  shuffleWithRng,
  getStandardSeedPositions,
  resolveEventWaiverText,
  screenForEventWaiver,
  eventWaiverRefusal,
  unpairedDrawRefusal,
  phaseValueFor,
  resolveMatchShape,
  ExpectedError,
  parseFormatConfig,
  stageAt,
  stageMatchRules,
  stagedMatchRated,
  ensureEntryFees,
} from '@badminton/shared';
// By SUBPATH, never through the barrel — eventWaiverHash uses node:crypto and
// the barrel is imported by client components in both apps.
import { eventWaiverHash } from '@badminton/shared/src/utils/event-waiver';
import { formSignedWaivers } from '@badminton/shared';
import type {
  TournamentEventType,
  RatingSettings,
  SeedBy,
  EventMatchShape,
  MatchShapeOverride,
  AcceptedEventWaiver,
  EventWaiverEntry,
} from '@badminton/shared';

// The tournament engine rates matches in TypeScript while challenges are rated
// by apply_match_result in SQL. Both must read the SAME knobs or the identical
// scoreline moves ratings differently depending on where it was played — the
// cross-engine hazard the rounding comment in the Elo engine already warns
// about. This is the TS half of migration 00041.
//
// Fetched per call rather than cached: finalising an event is not a hot path,
// and a cache is how a mid-tournament settings change ends up applying to some
// matches and not others.
export async function getRatingSettings(
  adminClient: ReturnType<typeof createAdminClient>,
): Promise<RatingSettings | null> {
  const { data, error } = await adminClient
    .from('platform_settings')
    .select('value')
    .eq('key', 'rating_defaults')
    .maybeSingle();
  // A MISSING row legitimately means "no overrides configured" and falls back to
  // the shared constants. A FAILED READ does not: it is indistinguishable from
  // that at the call site, so the K-factors, bounds and sweep multiplier the
  // whole rating is computed from would quietly become the code defaults — and
  // the wrong delta would then be written as a real, reversible result. Live
  // settings already differ from the constants (singles_k_established is 36, not
  // 48), so this is a visible corruption, not a theoretical one.
  if (error) {
    throw new Error(`Could not read rating settings: ${error.message}`);
  }
  return (data?.value as RatingSettings | null) ?? null;
}

export { requireCapability } from '../actions/_shared';

// ============================================================
// Batched writes
// ============================================================

/**
 * A labelled PostgREST write, ready to be run as part of a batch.
 * The label is what an exec reads when the batch fails, so name the row.
 */
export type LabelledWrite = readonly [label: string, write: PromiseLike<unknown>];

export interface WriteFailure {
  label: string;
  message: string;
}

export interface SettledWrites {
  /** Every write that did not land, in input order. */
  failures: WriteFailure[];
  /** Per-input-index: did this write actually land? Parallel to the input array. */
  landed: boolean[];
}

function writeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.length > 0 ? message : 'unknown database error';
}

/**
 * Run independent writes in parallel and report, per write, whether it landed.
 *
 * This exists because `Promise.allSettled` on its own is a trap here. A
 * supabase-js PostgrestBuilder RESOLVES with `{ data, error }` and only rejects
 * on a transport failure — `.throwOnError()` is opt-in and is used nowhere in
 * this repo. So an RLS denial, a check-constraint violation or any other
 * Postgres error arrives as a FULFILLED promise carrying `error`, and the
 * `if (r.status === 'rejected')` idiom this replaces threw every one of them
 * away. That is how a tournament result could report "saved" while one player's
 * rating never moved: no Sentry event, no audit row, no toast.
 *
 * Inspecting `{ error }` rather than switching every builder to
 * `.throwOnError()` is deliberate: it catches BOTH shapes (a rejected transport
 * failure and a resolved Postgres error) in one place, and it needs no change
 * at the ~40 call sites that build the writes.
 */
export async function settleWrites(writes: readonly LabelledWrite[]): Promise<SettledWrites> {
  const settled = await Promise.allSettled(writes.map(([, write]) => Promise.resolve(write)));
  const failures: WriteFailure[] = [];
  const landed = settled.map((result, i) => {
    const label = writes[i]![0];
    if (result.status === 'rejected') {
      failures.push({ label, message: writeErrorMessage(result.reason) });
      return false;
    }
    const value = result.value as { error?: unknown; data?: unknown } | null;
    const error = value?.error;
    if (error) {
      failures.push({ label, message: writeErrorMessage(error) });
      return false;
    }
    // A CONDITIONAL UPDATE THAT MATCHED NOTHING IS NOT A SUCCESS.
    //
    // PostgREST reports "no error" for an UPDATE whose WHERE clause selected
    // zero rows, so a write racing against a status change, a withdrawal or a
    // concurrent edit came back clean and was recorded as landed — which for
    // the placement-bonus ledger means the player is marked paid and skipped by
    // every future retry.
    //
    // Only writes that asked for their rows back can be checked, which is why
    // this looks at `data` rather than assuming it. A builder without .select()
    // returns data: null and keeps the old behaviour, so the ~40 call sites
    // that do not care are unaffected; the ones that do opt in by selecting.
    if (Array.isArray(value?.data) && value.data.length === 0) {
      failures.push({ label, message: 'matched no rows' });
      return false;
    }
    return true;
  });
  return { failures, landed };
}

/**
 * Turn a partial batch failure into a thrown error the caller has to deal with.
 *
 * Nothing is reported to Sentry here on purpose. Every caller either throws out
 * of a server action (Next's instrumentation captures it) or is wrapped in
 * runAction (which captures it), so capturing here as well would file every
 * one of these twice.
 */
/**
 * Await one write and throw unless it landed.
 *
 * The batched settleWrites path above covers writes that are independent of one
 * another. Draw generation is full of writes that are NOT — seed a match, read
 * back where its winner routes, advance the bye into that slot, mark the next
 * match ready — and those were written as bare `await`s with no destructuring
 * at all. A PostgrestBuilder RESOLVES on a Postgres error, so `await` on its own
 * is not error handling: an RLS denial, a constraint violation or a missing
 * column sailed straight past, generation carried on, the event was marked
 * generated, and the admin was told the draw was published. The bracket had a
 * hole in it and nothing said so.
 */
export async function mustWrite(
  label: string,
  write: PromiseLike<{ error?: unknown; data?: unknown }>,
): Promise<void> {
  const result = await write;
  if (result?.error) {
    throw new Error(`${label} failed: ${writeErrorMessage(result.error)}`);
  }
  // Only meaningful when the caller asked for its rows back with .select();
  // without it PostgREST returns data: null and this cannot distinguish a
  // conditional update that matched nothing from one that worked.
  if (Array.isArray(result?.data) && result.data.length === 0) {
    throw new Error(`${label} failed: matched no rows`);
  }
}

export function assertWritesSucceeded(action: string, failures: readonly WriteFailure[]): void {
  if (failures.length === 0) return;
  const detail = failures.map(f => `${f.label} (${f.message})`).join('; ');
  throw new Error(
    `${action}: ${failures.length} database write(s) failed and the change is incomplete — ${detail}`,
  );
}

// Revalidate both the tournament page and the event detail page so admin UIs
// reflect mutations immediately. Pass eventId whenever it is in scope.
export function revalidateEventPaths(tournamentId: string, eventId?: string) {
  revalidatePath(`/tournaments/${tournamentId}`);
  if (eventId) revalidatePath(`/tournaments/${tournamentId}/events/${eventId}`);
}

// Throws when the tournament is suspended. Called by mutating tournament
// actions before they touch data; corrective actions (void/edit/undo,
// lock/unlock draw) intentionally skip this gate.
//
// A FAILED READ IS A REFUSAL, NOT A PASS. This discarded its error, so
// `data` came back null and `data?.suspended_at` was undefined — meaning the
// one thing that could stop a write on a suspended tournament treated "I
// could not find out" as "carry on". Suspension is the club's emergency
// stop; a gate that opens whenever the database hiccups is not a gate.
//
// TWO THINGS THIS DOES NOT MEAN, both checked against the call sites rather
// than assumed:
//
//   * It is not a new failure mode for a missing tournament.
//     `tournament_events.tournament_id` is NOT NULL REFERENCES tournaments
//     ON DELETE CASCADE (00001:667), and all twenty call sites derive the id
//     from a row they already read — none takes it from user input. A row
//     that is genuinely absent here is a corrupted read, and refusing is the
//     right answer to that too.
//
//   * The header comment above is accurate per call site and NOT accurate
//     under composition, which is worth stating because it changes what a
//     throw costs. Three paths reach a guarded action after committing:
//     finalizeEvent -> applyPlacementBonuses (held and reported, the event
//     stays finalised), autoPairWaitingEntrants' loop (earlier pairs stay
//     paired, that pair is refused by name), and completeTournamentWithEvents
//     (aborts part-way through the tournament). All three are the intended
//     behaviour of an emergency stop that cannot confirm itself, and none
//     leaves a half-written row — they leave a completed step and a
//     refused one.
export async function assertTournamentNotSuspended(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string
) {
  const { data, error } = await adminClient.from('tournaments')
    .select('suspended_at, suspension_reason')
    .eq('id', tournamentId)
    .single();
  if (error) {
    throw new Error(
      `Could not check whether this tournament is suspended (${error.message}), so nothing was changed.`
    );
  }
  if (!data) {
    throw new Error('Could not check whether this tournament is suspended: it no longer exists.');
  }
  if (data.suspended_at) {
    const reason = data.suspension_reason;
    throw new Error(`Tournament is suspended${reason ? `: ${reason}` : ''}. Resume it to continue.`);
  }
}

// ============================================================
// Event waivers — the hard block on taking part
// ============================================================
// An exec may add anybody to a tournament; that is deliberate and unchanged,
// because somebody joining on the morning of an event has to be able to get
// onto the sheet. What they may not do is PLAY without having accepted the
// tournament's event waiver, and check-in is where that is enforced.
//
// WHY THIS READ IS NOT GATED ON `tournaments.draw.waivers.read`. That capability
// gates the roster's DISPLAY of waiver state — an exec looking up who has
// signed. This is the enforcement read, run by check-in itself on the way to
// deciding whether a write is allowed at all. Gating enforcement on a
// display permission would mean an officer who lacks that permission could
// check in unsigned entrants, which is precisely backwards: the narrower
// somebody's access, the MORE the rule would relax.

/** Everything the screening needs, loaded once for a whole tournament. */
export interface TournamentWaiverContext {
  /** null when this tournament has no waiver — every entry then passes. */
  requiredHash: string | null;
  acceptances: AcceptedEventWaiver[];
}

/**
 * Load a tournament's waiver requirement and every acceptance recorded against
 * it, in two reads, regardless of how many entrants are being screened.
 *
 * A FAILED READ IS NOT "NOBODY SIGNED". Treating an error as an empty
 * acceptance list would refuse an entire field at the door because Postgres
 * hiccuped, so it throws and the caller reports that nothing was changed. The
 * opposite default — treating an error as "no waiver required" — would be worse
 * still: it would silently disable the gate.
 */
export async function loadTournamentWaiverContext(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
): Promise<TournamentWaiverContext> {
  const { data: tournament, error: tournamentError } = await adminClient
    .from('tournaments')
    .select('waiver_text')
    .eq('id', tournamentId)
    .maybeSingle();
  if (tournamentError) {
    Sentry.captureException(tournamentError);
    throw new Error('Could not check this tournament’s event waiver. Nothing was changed — try again.');
  }

  const text = resolveEventWaiverText(tournament);
  if (!text) return { requiredHash: null, acceptances: [] };

  // The hash is always taken from the SERVER's copy of the text, never from
  // anything a client sent — the same rule registerForEvent follows.
  const requiredHash = eventWaiverHash(text);

  const { data: acceptances, error: acceptancesError } = await adminClient
    .from('event_waiver_acceptances')
    .select('player_id, waiver_hash, accepted_at')
    .eq('tournament_id', tournamentId);
  if (acceptancesError) {
    Sentry.captureException(acceptancesError);
    throw new Error('Could not check who has signed the event waiver. Nothing was changed — try again.');
  }

  // The Form's waiver counts too, for a club event run as this tournament.
  let formSigned: AcceptedEventWaiver[];
  try {
    formSigned = await formSignedWaivers(adminClient, tournamentId, requiredHash);
  } catch (err) {
    Sentry.captureException(err);
    throw err;
  }

  return { requiredHash, acceptances: [...((acceptances ?? []) as AcceptedEventWaiver[]), ...formSigned] };
}

/**
 * Refuse outright — for the paths that check in exactly ONE entry, where there
 * is nothing to partition and the exec pressed a button next to a name.
 */
export async function assertEventWaiverSigned(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  entry: EventWaiverEntry,
): Promise<void> {
  const { requiredHash, acceptances } = await loadTournamentWaiverContext(adminClient, tournamentId);
  const { blocked } = screenForEventWaiver([entry], requiredHash, acceptances);
  // ExpectedError, not Error: Next.js redacts errors thrown out of a server
  // action in production, and a redacted message at the check-in desk is the
  // unexplained refusal this whole design is trying not to create.
  if (blocked.length > 0) throw new ExpectedError(eventWaiverRefusal(blocked));
}

/**
 * THE SECOND ENFORCEMENT POINT: the draw.
 *
 * Check-in is the obvious place to stop an unsigned entrant, and it is not
 * sufficient on its own. Bracket generation seeds from
 * `status IN ('registered','checked_in')` — it does NOT require a check-in — so
 * an unsigned member an exec added lands in the draw, is handed an opponent and
 * a court, and plays, having passed no gate at all. "Must not be able to take
 * part" has to hold here too or it does not hold.
 *
 * REFUSES WHOLE rather than partitioning, which is the opposite of what
 * bulkCheckIn does, and deliberately. Check-in is a queue of people arriving one
 * at a time, where excluding somebody costs them a wait. A draw is a single
 * structure: quietly generating it without three of the field produces a
 * bracket that LOOKS complete, with byes where people should be, and the exec
 * finds out when somebody turns up for a match that was never created. Better to
 * refuse, name them, and let the exec chase the signatures or withdraw them.
 *
 * Screened from the FIELD as built rather than from the event's rows, so a
 * pool-seeded bracket is covered by the same call — its field is promoted from
 * another event and would otherwise never be looked at.
 */
export async function assertDrawFieldEventWaiverSigned(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  entryIds: readonly string[],
  doubles: boolean,
): Promise<void> {
  if (entryIds.length === 0) return;
  const { requiredHash, acceptances } = await loadTournamentWaiverContext(adminClient, tournamentId);
  if (!requiredHash) return;

  const { data: rows, error } = doubles
    ? await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)')
      .in('id', entryIds as string[])
    : await adminClient.from('tournament_participants')
      .select('id, player_id, player:players!player_id(full_name)')
      .in('id', entryIds as string[]);
  // A failed read must not read as "everybody has signed".
  if (error) {
    Sentry.captureException(error);
    throw new Error('Could not check who has signed the event waiver. The draw was not generated — try again.');
  }

  const entries: EventWaiverEntry[] = (rows ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const name = (embed: unknown, fallback: string) => {
      const one = Array.isArray(embed) ? embed[0] : embed;
      return (one as { full_name?: string | null } | null)?.full_name || fallback;
    };
    return {
      id: r.id as string,
      // An external team (00269) has no member ids and no account to sign with, so
      // it has no members to screen and passes, as an entry with none does.
      members: doubles
        ? [
          { id: r.player1_id as string | null, name: name(r.player1, r.player1_id as string) },
          { id: r.player2_id as string | null, name: name(r.player2, r.player2_id as string) },
        ].filter((m): m is { id: string; name: string } => m.id != null)
        : [{ id: r.player_id as string, name: name(r.player, 'This player') }],
    };
  });

  const { blocked } = screenForEventWaiver(entries, requiredHash, acceptances);
  if (blocked.length === 0) return;
  throw new ExpectedError(
    `${eventWaiverRefusal(blocked)} The draw was not generated — get their signatures, or take them out of the event first.`,
  );
}

/**
 * THE THIRD HARD BLOCK ON A DRAW: nobody may still be waiting for a partner.
 *
 * Since 00102 a doubles event can hold tournament_participants rows — people
 * who entered without a partner and are waiting to be given one. Both bracket
 * generators seed a doubles event from tournament_pairs and only from there, so
 * an event with three formed pairs and two loose people would produce a
 * perfectly valid-looking three-team draw and silently leave two members out.
 *
 * REFUSING IS THE ONLY DEFENSIBLE ANSWER of the three. Auto-pairing them at
 * draw time assigns partners nobody agreed to at the moment it is hardest to
 * change, and dropping them silently is the failure this exists to prevent —
 * the exec finds out when somebody turns up for a match that was never created.
 * So the draw stops and NAMES them, with both remedies, which is what lets an
 * exec fix it in the ten seconds they have. Same shape, and the same reasoning,
 * as assertDrawFieldEventWaiverSigned above.
 *
 * Singles events return immediately: their entrants ARE participant rows.
 */
export async function assertNobodyLeftUnpaired(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  doubles: boolean,
): Promise<void> {
  if (!doubles) return;

  const { data: loose, error } = await adminClient
    .from('tournament_participants')
    .select('player_id, status, player:players!player_id(full_name)')
    .eq('event_id', eventId)
    .in('status', ['registered', 'checked_in']);
  // A failed read must not read as "everybody is paired" — that is exactly the
  // silent omission this function exists to make impossible.
  if (error) {
    Sentry.captureException(error);
    throw new Error('Could not check whether anyone is still waiting for a partner. The draw was not generated — try again.');
  }
  if (!loose || loose.length === 0) return;

  const names = loose.map((row) => {
    const embed = (row as Record<string, unknown>).player;
    const one = Array.isArray(embed) ? embed[0] : embed;
    return (one as { full_name?: string | null } | null)?.full_name || 'A member';
  });
  throw new ExpectedError(unpairedDrawRefusal(names));
}

/**
 * The members of a pair, in a shape screenForEventWaiver understands, from the
 * embedded player rows the pair selects already carry. Falls back to the id so
 * a missing name degrades to something unhelpful rather than to a crash — the
 * refusal still names two distinct people.
 */
export function pairWaiverMembers(pair: {
  player1_id: string | null;
  player2_id: string | null;
  player1?: { full_name?: string | null } | { full_name?: string | null }[] | null;
  player2?: { full_name?: string | null } | { full_name?: string | null }[] | null;
}): { id: string; name: string }[] {
  const name = (embed: unknown, fallback: string) => {
    const row = Array.isArray(embed) ? embed[0] : embed;
    return (row as { full_name?: string | null } | null)?.full_name || fallback;
  };
  // An external team (00269) has no members to screen.
  if (pair.player1_id == null || pair.player2_id == null) return [];
  return [
    { id: pair.player1_id, name: name(pair.player1, pair.player1_id) },
    { id: pair.player2_id, name: name(pair.player2, pair.player2_id) },
  ];
}

/**
 * PUSH THE SIGNATURE AT THE MEMBER, the moment an exec adds them.
 *
 * Being added must ACTIVELY ask for the signature, not wait to be noticed at
 * the door. Three things carry that, and the notification is only one of them:
 *
 *   1. this notification (and a push, for anyone who opted into tournaments),
 *   2. a blocking panel on the tournament page, which a member who never opens
 *      a notification still cannot miss, and
 *   3. check-in, which refuses regardless of whether either was read.
 *
 * Layer 3 is the one that is load-bearing. 1 and 2 exist so that nobody has to
 * find out at the door.
 *
 * TYPE `general`, DELIBERATELY. Eight of the twenty-one notification_type
 * values have no producer anywhere and are dead letters; `general` has three
 * live producers and metadata-driven routing, and `tournament_id` in its
 * metadata is exactly the key notificationAction() reads to send the tap to
 * /tournaments/<id> — which is where the panel that takes the signature lives.
 * A new enum value would need an ALTER TYPE, a TYPES entry and a routing branch
 * to arrive at the same page.
 *
 * Best-effort by construction: notifyPlayers reports to Sentry and never
 * throws, because the member IS added and an action that reported failure would
 * send the exec looking for a person already on the sheet.
 */
export async function notifyEventWaiverRequired(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  tournamentName: string,
  playerIds: string[],
): Promise<void> {
  if (playerIds.length === 0) return;
  const body =
    `You have been entered in ${tournamentName}, which has an event waiver. ` +
    'Read and accept it before you turn up — you cannot be checked in until you do.';

  // IMPORTED LAZILY, and that is not an optimisation. ../notify begins with
  // `import 'server-only'`, and this module is imported DIRECTLY by two vitest
  // suites (tournament-recovery, tournament-write-integrity) which run outside
  // Next's resolver and cannot resolve that package. A static import here fails
  // both of them at load time, before a single assertion runs — so the
  // dependency is taken at call time, where only Next ever stands.
  //
  // ../notify rather than this module's own leaner notifyPlayers because this
  // is the one tournament notification where PUSH earns its place: acting on it
  // before you set off is the difference between signing at home and being
  // turned away at the door. It also honours the per-category opt-in, which the
  // local helper knows nothing about.
  const { notifyPlayers: notifyPlayersWithPush } = await import('../notify');
  await notifyPlayersWithPush(
    adminClient,
    playerIds,
    {
      type: 'general',
      title: 'Event waiver needed',
      body,
      metadata: { tournament_id: tournamentId, kind: 'event_waiver_required' },
    },
    { title: 'Event waiver needed', body, url: `/tournaments/${tournamentId}` },
    'tournaments',
  );
}

/**
 * Who among a freshly added group still owes a signature, and the tournament's
 * name for the message. Returns an empty list when the tournament has no waiver
 * — the common case, and one read rather than a notification nobody needs.
 *
 * Swallows its own failures. Every caller runs this AFTER the entrant is
 * committed, so a failure here must cost a notification, never the add.
 */
export async function unsignedAmong(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  playerIds: string[],
): Promise<{ unsigned: string[]; tournamentName: string }> {
  if (playerIds.length === 0) return { unsigned: [], tournamentName: '' };
  try {
    const { data: tournament } = await adminClient
      .from('tournaments')
      .select('name, waiver_text')
      .eq('id', tournamentId)
      .maybeSingle();
    const text = resolveEventWaiverText(tournament);
    if (!text) return { unsigned: [], tournamentName: '' };

    const requiredHash = eventWaiverHash(text);
    const { data: acceptances } = await adminClient
      .from('event_waiver_acceptances')
      .select('player_id, waiver_hash, accepted_at')
      .eq('tournament_id', tournamentId)
      .in('player_id', playerIds);

    const { blocked } = screenForEventWaiver(
      playerIds.map((id) => ({ id, members: [{ id, name: id }] })),
      requiredHash,
      (acceptances ?? []) as AcceptedEventWaiver[],
    );
    return {
      unsigned: blocked.map((entry) => entry.id),
      tournamentName: (tournament?.name as string) ?? 'a tournament',
    };
  } catch (err) {
    Sentry.captureException(err);
    return { unsigned: [], tournamentName: '' };
  }
}

// The tournament-format -> engine-format mapping that used to live here is now
// inside resolvedFormatWeight (packages/shared/src/elo/engine.ts), so the
// console can show the weight this function used to be the only caller of.

// ============================================================
// Notification helper
// ============================================================

export async function notifyPlayers(
  adminClient: ReturnType<typeof createAdminClient>,
  rawPlayerIds: ReadonlyArray<string | null | undefined>,
  title: string,
  body: string,
  metadata?: Record<string, unknown>,
  notificationType: 'general' | 'tournament_bracket_published' | 'tournament_match_ready' | 'tournament_match_result' | 'tournament_event_completed' | 'tournament_checkin_open' = 'general'
) {
  // An external team (00269) has no player ids; there is nobody to notify.
  const playerIds = rawPlayerIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (playerIds.length === 0) return;
  try {
    const rows = playerIds.map(pid => ({
      player_id: pid,
      type: notificationType,
      title,
      body,
      metadata: metadata ?? {},
    }));
    const { error } = await adminClient.from('notifications').insert(rows);
    if (error) throw error;
  } catch (err) {
    // Notifications are best-effort — never let a failure break the parent action.
    Sentry.captureException(err);
  }
}

// Pull the event/tournament context from a joined select on the UPDATE itself
// so participant/pair status mutations don't need a second round-trip just to
// figure out which paths to revalidate.
export const participantContextSelect = 'event_id, event:tournament_events(tournament_id)' as const;
export const pairContextSelect = 'event_id, event:tournament_events(tournament_id)' as const;

export function extractEventContext(row: { event_id?: unknown; event?: unknown } | null): { tid: string; eventId: string } | null {
  if (!row) return null;
  const eventId = row.event_id as string | undefined;
  const tid = (row.event as { tournament_id?: string } | null)?.tournament_id;
  if (!eventId || !tid) return null;
  return { tid, eventId };
}

// Field on a match row holding one side's entry, for the discipline in play.
//
// Lives here rather than in results.ts because both the winner route and the
// loser route (00080) have to resolve a side to the same column name. Two
// copies of this two-line function is how a loser ends up written into
// participant_a_id on a doubles event.
export function entrySideField(side: 'a' | 'b', doubles: boolean): string {
  if (doubles) return side === 'a' ? 'pair_a_id' : 'pair_b_id';
  return side === 'a' ? 'participant_a_id' : 'participant_b_id';
}

/**
 * The two ways a match can feed another one.
 *
 * `winner` has always existed. `loser` arrives with the third-place playoff
 * (00080) and is deliberately the same shape, because every rule that protects
 * the winner route has to protect this one too — a semi-final that has already
 * put its loser into a played third-place match is exactly as un-voidable as one
 * that has put its winner into a played final.
 */
export const MATCH_ROUTES = ['winner', 'loser'] as const;
export type MatchRoute = (typeof MATCH_ROUTES)[number];

/** Read one route off a match row: where it sends that side, and to which slot. */
export function routeOf(
  match: Record<string, unknown>,
  route: MatchRoute,
): { nextId: string; side: 'a' | 'b' } | null {
  const nextId = match[`${route}_to_match_id`] as string | null;
  if (!nextId) return null;
  return { nextId, side: match[`${route}_to_position`] === 'a' ? 'a' : 'b' };
}

/** The entry a decided match sent along `route`, or null if it has none. */
export function routedEntryId(
  match: Record<string, unknown>,
  route: MatchRoute,
  doubles: boolean,
): string | null {
  const field = route === 'winner'
    ? (doubles ? 'winner_pair_id' : 'winner_participant_id')
    : (doubles ? 'loser_pair_id' : 'loser_participant_id');
  return (match[field] as string | null) ?? null;
}

// Moved to packages/shared (draw-order.ts) so the staged draw builds knockouts
// the same way; re-exported here for the existing importers.
export { getStandardSeedPositions };

// ============================================================
// Drawing the seeds — randomised WITHIN tiers, never across them
// ============================================================
//
// "REGENERATE DRAW DOESNT CHANGE ANYTHING", and it followed from the design.
// Placement is a pure function of the sorted field against
// getStandardSeedPositions, so the same entrants with the same seeds always
// produced a byte-identical bracket. Pressing the button twice was a no-op the
// exec had no way to tell apart from a bug.
//
// The answer is the one real tournaments use: the seeds are not POSITIONS, they
// are TIERS, and the draw is made at random within each tier.
//
//   * Seeds 1 and 2 go to opposite ends. Fixed, never drawn.
//   * Seeds 3-4 are drawn into the two remaining half-brackets, one each.
//   * Seeds 5-8 into the four remaining quarters, one each.
//   * 9-16 into the eighths, and so on — every band is a power of two.
//   * Everyone below the last full band is, in effect, unseeded: they are one
//     large band and are drawn at random into whatever is left.
//
// The invariant that survives is the entire reason seeding exists: two entrants
// of the same tier can never meet before the round their tier implies. Seeds 1
// and 2 not before the final, 1-4 not before the semis, 1-8 not before the
// quarters.
//
// WHY THIS IS SAFE, stated as the argument rather than as a hope. The bands are
// exactly [1,1], [2,2], [3,4], [5,8], [9,16] ..., so the union of every band up
// to and including [2^(k-1)+1, 2^k] is precisely {1..2^k}. Permuting within
// bands therefore maps {1..2^k} onto itself for every k. getStandardSeedPositions
// already places ranks 1..2^k one per sub-bracket of size B/2^k; a permutation
// of that set can only ever reshuffle which of those sub-brackets each one gets,
// never put two of them in the same one. The separation is preserved by
// construction, not by luck — and draw-randomisation.test.ts proves it over
// thousands of draws anyway.

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit PRNG.
 *
 * Deliberately NOT Math.random. A draw made from a recorded seed can be
 * reproduced and explained months later ("here is the seed, here is the same
 * bracket"); a draw made from Math.random can only be asserted. The seed is
 * written into the bracket_generated audit row, which is why no schema change
 * was needed for reproducibility — see generateSingleEliminationBracketImpl.
 */
export function makeDrawRng(seed: number): () => number {
  // >>> 0 keeps the state an unsigned 32-bit int through every step, which is
  // what the algorithm is defined over; a negative or fractional seed would
  // otherwise walk a different (and much worse) state space.
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh unsigned 32-bit draw seed. The only entropy in the whole feature. */
export function newDrawSeed(): number {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/**
 * The seeding tiers, as [firstRank, lastRank] pairs covering 1..count.
 *
 * The last band is clipped to the field, so a 6-entry field's bands are
 * [1,1], [2,2], [3,4], [5,6] — the 5-8 band exists but only two people are in
 * it, and they are drawn between themselves.
 */
export function seedTierBands(count: number): Array<[number, number]> {
  const bands: Array<[number, number]> = [];
  if (count < 1) return bands;
  bands.push([1, 1]);
  let lo = 2;
  let size = 1;
  while (lo <= count) {
    const hi = Math.min(lo + size - 1, count);
    bands.push([lo, hi]);
    lo += size;
    size *= 2;
  }
  return bands;
}

/**
 * The tier bands, cut so that no band straddles rank `reserveTop`.
 *
 * WHY A PROMISE HAS TO BE A TIER BOUNDARY (00124). seed_skip_count is a promise
 * about SEEDS — "the top N skip round one" — but the byes are a property of
 * RANKS: they fall on ranks 1..B-E, and drawWithinTiers is free to move an
 * entrant anywhere inside their band. When the promised prefix ends in the
 * MIDDLE of a band, those two facts disagree. A 5-entry field has 3 byes and
 * bands [1,1], [2,2], [3,4], so a promise of 3 is accepted by the generator's
 * ceiling check and then broken by the draw half the time: seed 4 takes rank 3
 * and its bye while seed 3 plays round one. A 20-entry field is the version the
 * club will actually see — 12 byes, band [9,16] straddling the bye line, so a
 * promise of 9 can leave four promised seeds playing round one.
 *
 * The fix is to say what the promise means: an exec who typed a number has
 * declared that the top N are NOT interchangeable with the rest of their tier,
 * so the draw treats N as a tier boundary of its own.
 *
 * THIS CANNOT BREAK THE SEPARATION INVARIANT, and the argument is the same one
 * the band comment above makes. Separation survives because permuting within a
 * band maps {1..2^k} onto itself for every k; cutting a band into two
 * CONTIGUOUS sub-ranges and shuffling each within itself is still a permutation
 * that maps each band's set onto itself, so it is a strictly smaller group of
 * permutations than the one already proved safe. Nothing can cross a boundary
 * that was not crossable before.
 *
 * `reserveTop` of 0 — every event that never sets seed_skip_count — returns
 * seedTierBands unchanged, so the default draw is byte-identical.
 */
export function seedTierBandsReserving(count: number, reserveTop: number): Array<[number, number]> {
  const bands = seedTierBands(count);
  // Total in its own right: callers outside the generator (the randomisation
  // tests, the group-draw tests) pass whatever they like, and a reserve past
  // the end of the field cuts nothing.
  const cut = Math.min(Math.max(Math.trunc(reserveTop) || 0, 0), count);
  if (cut === 0) return bands;
  const out: Array<[number, number]> = [];
  for (const [lo, hi] of bands) {
    if (lo <= cut && cut < hi) out.push([lo, cut], [cut + 1, hi]);
    else out.push([lo, hi]);
  }
  return out;
}

/**
 * Draw the field: shuffle the entrants within each seeding tier.
 *
 * `entries` must already be in seeding order (rank 1 first) — the caller sorts
 * it by seed, or auto-seeds it by rating, before getting here. The returned
 * array is the DRAW order: index i is the entrant who will be placed at the
 * standard bracket position for rank i+1.
 *
 * THIS SHUFFLES ENTRANTS WITHIN AN INDEX RANGE, NOT RANKS BETWEEN POSITIONS,
 * and the difference is what keeps the byes where they belong. A field of N in
 * a bracket of B has B-N empty ranks, and they are always the LAST ones — which
 * is exactly what puts the byes on the top seeds. Permuting rank-slots instead
 * would let an empty rank move up inside the band it shares with real
 * entrants: a 5-entry draw could hand seed 4 a bye while seed 1 played, which
 * is not a draw, it is a favour. Shuffling the array leaves the tail empty by
 * construction, and the bye-placement test asserts it over many iterations.
 *
 * `reserveTop` is seed_skip_count (00124) and defaults to 0, which is what
 * every draw that made no promise passes. See seedTierBandsReserving for why a
 * promise that ends mid-band has to cut the band, and why cutting is safe.
 */
export function drawWithinTiers<T>(
  entries: readonly T[],
  rng: () => number,
  reserveTop = 0,
): T[] {
  const drawn = [...entries];
  for (const [lo, hi] of seedTierBandsReserving(drawn.length, reserveTop)) {
    // Fisher-Yates over [lo-1, hi-1] inclusive. A one-member band (seeds 1 and
    // 2, and a clipped final band with a single occupant) has nothing to swap.
    for (let i = hi - 1; i > lo - 1; i--) {
      const j = lo - 1 + Math.floor(rng() * (i - (lo - 1) + 1));
      const tmp = drawn[i]!;
      drawn[i] = drawn[j]!;
      drawn[j] = tmp;
    }
  }
  return drawn;
}

// ============================================================
// Assigning a field into groups (00106)
// ============================================================

/** Everything group assignment needs to know about one entry. */
export type GroupCandidate = {
  id: string;
  seed: number | null;
  /** Rating, the fallback ordering when nobody has been seeded. */
  elo: number;
  group: number | null;
};

/** A copy in id order: the canonical order a seeded shuffle starts from. */
export function inIdOrder<T extends { id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The order the field is dealt into groups in — best first.
 *
 * SEEDS FIRST, THEN RATING, AND THE FALLBACK IS THE POINT. The round-robin
 * generator reads its field ordered by seed_number and — unlike the knockout
 * generator, which auto-seeds by Elo before it draws — never assigns one. A
 * round-robin event can therefore reach group assignment with every seed NULL,
 * at which point "serpentine by seed" is serpentine by whatever order Postgres
 * felt like returning, which is not balanced at all. That is the exact failure
 * the format exists to avoid, arrived at silently.
 *
 * So an unseeded field falls back to rating, mirroring what the knockout path
 * has always done. A PARTIALLY seeded field puts the seeded entrants first in
 * seed order and the rest behind them by rating, because an exec who seeded the
 * top four and left the rest meant those four to be the top four.
 */
export function seedingOrderForGroups<T extends GroupCandidate>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.seed != null && b.seed != null) return a.seed - b.seed;
    if (a.seed != null) return -1;
    if (b.seed != null) return 1;
    return b.elo - a.elo;
  });
}

/**
 * Decide which group every entry belongs to.
 *
 * THREE CASES, AND ONLY ONE OF THEM DEALS THE WHOLE FIELD:
 *
 *   * Nothing assigned yet (or `reassignAll`) — serpentine by seed over the
 *     entire field. This is what the Assign Groups button does.
 *   * Some assigned, some not — the assigned ones are LEFT ALONE and the rest
 *     go into whichever group is currently smallest. This is what happens when
 *     somebody enters after the groups were drawn: re-dealing the field would
 *     silently undo an exec's hand-placement, which is the one thing an
 *     override has to survive.
 *   * All assigned — nothing to do, and the returned map still names every
 *     entry so the caller can write it back idempotently.
 *
 * A group number outside 1..groupCount counts as unassigned. It can only come
 * from group_count having been lowered after the fact, and leaving it would put
 * somebody in a group that no longer exists.
 *
 * `rng` is passed for seeding_method = 'random': the field is shuffled instead
 * of put in seed order, so the serpentine deals a random field. Seeds and
 * ratings are ignored. The field is put in id order first so the same rng
 * always deals the same groups, whatever order the rows were read in.
 */
export function planGroupAssignment<T extends GroupCandidate>(
  entries: readonly T[],
  groupCount: number,
  opts?: { reassignAll?: boolean; rng?: () => number },
): Map<string, number> {
  const ordered = opts?.rng
    ? shuffleWithRng(inIdOrder(entries), opts.rng)
    : seedingOrderForGroups(entries);
  const out = new Map<string, number>();
  if (groupCount < 2) {
    for (const e of ordered) out.set(e.id, 1);
    return out;
  }

  const keep = opts?.reassignAll
    ? new Map<string, number>()
    : new Map(
        ordered
          .filter((e) => e.group != null && e.group >= 1 && e.group <= groupCount)
          .map((e) => [e.id, e.group as number]),
      );

  if (keep.size === 0) {
    const plan = snakeGroupAssignment(ordered.length, groupCount);
    ordered.forEach((e, i) => out.set(e.id, plan[i]!));
    return out;
  }

  const counts = new Array<number>(groupCount).fill(0);
  for (const g of keep.values()) counts[g - 1]!++;

  for (const e of ordered) {
    const kept = keep.get(e.id);
    if (kept != null) { out.set(e.id, kept); continue; }
    // Smallest group wins; ties go to the lowest number so the result does not
    // depend on how Array.prototype behaves at equal values.
    let pick = 0;
    for (let g = 1; g < groupCount; g++) if (counts[g]! < counts[pick]!) pick = g;
    counts[pick]!++;
    out.set(e.id, pick + 1);
  }
  return out;
}

// ============================================================
// Drawing a GROUP-seeded field (00106)
// ============================================================
//
// WHY THIS IS NOT drawWithinTiers, AND WHY drawWithinTiers IS NOT TOUCHED.
//
// drawWithinTiers shuffles inside the SEEDING bands [1,1], [2,2], [3,4],
// [5,8] ... — the powers of two the bracket's own geometry is built from. Those
// bands are exactly right when the seeding order is a rating order, because
// then the band boundaries are the only thing that separation depends on.
//
// They are WRONG for a group stage, and the failure is not hypothetical.
// Qualification order puts every group WINNER first and every RUNNER-UP after
// them, so with 3 groups of 2 qualifiers the winners hold ranks 1-3 and the
// runners-up 4-6 — while seedTierBands(6) yields [1,1], [2,2], [3,4], [5,6].
// Band [3,4] STRADDLES the boundary: shuffling it can draw a runner-up above a
// group winner, which is precisely the outcome brackets.ts already refuses to
// let a pool-seeded draw produce. Every group count that is not a power of two,
// and every qualifiers-per-group above 2, has the same straddle somewhere.
//
// So the tiers a group-seeded draw is shuffled within are the QUALIFICATION
// tiers — winners among themselves, runners-up among themselves, thirds among
// themselves — and nothing else. That is the coin flip that is genuinely a
// choice: "winner of A plays runner-up of B" is decided by the format, but
// WHICH B is not decided by anything the groups played, so drawing it is more
// honest than fixing it to whichever group happens to be numbered lowest.
//
// drawWithinTiers keeps its exact signature and keeps serving the ordinary
// rating-seeded path, which is what the randomised-draw work built it for.

/**
 * Shuffle within each contiguous run of entries sharing a tier.
 *
 * `entries` must already be grouped by tier — which qualificationOrder
 * guarantees, since it emits depth-major. Runs are detected rather than
 * computed from a band table, so a tier that is short (a group with fewer
 * finishers than the rest) needs no special case: it is simply a shorter run.
 *
 * `reserveTop` is seed_skip_count (00124), and it cuts a run the same way
 * seedTierBandsReserving cuts a band, for the same reason and with the same
 * safety argument — a run split into two contiguous halves still permutes the
 * run's own set onto itself, so no qualifier can cross a tier that they could
 * not cross before. It is needed HERE as well as there because
 * seed_skip_count's CHECK only excludes round_robin: a pool_to_bracket event
 * with two or more groups reaches its knockout through this shuffle, and a
 * promise landing mid-run breaks identically. Two groups with five qualifiers
 * order as [W-A, W-B, R-A, R-B, T-A]: three byes, and a promise of 3 lands
 * inside the runners-up run, so the third bye is a coin flip between R-A and
 * R-B when it was promised to whichever of them the seeding put third.
 *
 * This cuts against the header above — "which B is a question the group stage
 * never asked" — only at the default, which is where that argument lives. An
 * exec who typed a number has answered the question for the top N, and the cut
 * bites nowhere else: `reserveTop` of 0 leaves every run whole.
 */
export function drawWithinQualificationTiers<T>(
  entries: readonly T[],
  tierOf: (entry: T) => number,
  rng: () => number,
  reserveTop = 0,
): T[] {
  const drawn = [...entries];
  const cut = Math.min(Math.max(Math.trunc(reserveTop) || 0, 0), drawn.length);
  let start = 0;
  for (let i = 1; i <= drawn.length; i++) {
    if (i < drawn.length && tierOf(drawn[i]!) === tierOf(drawn[start]!) && i !== cut) continue;
    // Fisher-Yates over [start, i-1]. A one-member run has nothing to swap.
    for (let j = i - 1; j > start; j--) {
      const k = start + Math.floor(rng() * (j - start + 1));
      const tmp = drawn[j]!;
      drawn[j] = drawn[k]!;
      drawn[k] = tmp;
    }
    start = i;
  }
  return drawn;
}

/**
 * How many round-one matches this draw order would put two group-mates in.
 *
 * Evaluated on the BRACKET PLACEMENT, not on adjacent array indices. Rank r is
 * seated at whichever bracket position getStandardSeedPositions sends it to, and
 * round one pairs positions (0,1), (2,3), ... — so ranks 1 and 2 are never
 * adjacent in the bracket even though they are adjacent in this array.
 *
 * A slot with a bye on the other side is never a conflict: nobody plays it.
 */
export function sameGroupRound1Conflicts<T>(
  drawn: readonly T[],
  bracketSize: number,
  groupOf: (entry: T) => number | null,
): number {
  const positions = getStandardSeedPositions(bracketSize);
  let conflicts = 0;
  for (let pos = 0; pos < bracketSize; pos += 2) {
    const a = drawn[positions[pos]! - 1];
    const b = drawn[positions[pos + 1]! - 1];
    if (!a || !b) continue;
    const ga = groupOf(a);
    const gb = groupOf(b);
    if (ga != null && ga === gb) conflicts++;
  }
  return conflicts;
}

/**
 * Draw a group-seeded field so that no two group-mates meet in round one.
 *
 * THE CONSTRAINT IS THE ONE THING GROUPS ADD TO A DRAW. Two entrants out of the
 * same group have just played each other, sometimes minutes earlier; pairing
 * them again in round one wastes the group stage's whole result for both of
 * them and hands the rest of the draw a free half.
 *
 * ENFORCED BY REDRAWING, NOT BY SWAPPING. A repair pass that swaps two entrants
 * to fix a clash has to prove it did not create another one, and has to prove it
 * stayed inside its tier — two invariants to maintain by hand. Redrawing from a
 * fresh RNG value preserves both by construction: every attempt is a valid draw
 * of exactly the same shape, and the constraint is a filter over valid draws
 * rather than an edit to an invalid one.
 *
 * IT CAN BE UNSATISFIABLE, so there are two guards and neither is a loop that
 * hopes:
 *
 *   * A PIGEONHOLE PRE-CHECK. Round one has a fixed number of CONTESTED matches
 *     — fixed because byes always fall on the last ranks, so which positions get
 *     two real entrants does not depend on the permutation. Each contested match
 *     can hold at most one entrant from any one group, and the bye slots can
 *     hold the rest. If some group brings more qualifiers than
 *     (contested matches + bye slots), no arrangement can separate them. The
 *     realistic version of this is not exotic: withdrawals can leave a bracket
 *     whose field is mostly one group.
 *   * A BOUNDED ATTEMPT COUNT for everything the pigeonhole cannot see.
 *
 * When neither succeeds the FALLBACK IS THE BEST DRAW SEEN, not a refusal.
 * Refusing would mean an exec cannot generate a knockout at all because of a
 * scheduling nicety, on a day when the courts are already booked. The caller
 * records `same_group_round_1` in the audit row so the compromise is written
 * down rather than merely tolerated.
 *
 * `reserveTop` MAKES 'unavoidable' VERY SLIGHTLY MORE LIKELY, AND THAT IS THE
 * TRADE, stated here so the next person to see `same_group_round_1:
 * 'unavoidable'` on an event that also carries a seed_skip_count does not go
 * looking for a second bug.
 *
 * The reserve never creates a clash by itself — the ranks it pins are bye
 * ranks, and a bye is never a conflict. What it does is shrink the pool the
 * attempt loop can draw from: when the promise ends inside a run that reaches
 * past the bye line, only the members above the promise can still reach the
 * CONTESTED ranks, so an arrangement that needed a now-pinned qualifier down
 * there is no longer reachable and the loop can exhaust where it used to
 * succeed. An explicit promise outranks a scheduling nicety, the audit row
 * already records the compromise, and the pigeonhole pre-check is untouched
 * because it was always necessary and never sufficient.
 */
export function drawAvoidingSameGroupRound1<T>(
  entries: readonly T[],
  opts: {
    bracketSize: number;
    tierOf: (entry: T) => number;
    groupOf: (entry: T) => number | null;
    seed: number;
    maxAttempts?: number;
    /**
     * seed_skip_count (00124). Passed to EVERY call of the shuffle below —
     * both the infeasible early return and the attempt loop — because a
     * promise that only holds on the happy path is not a promise, and the
     * infeasible branch is the one nobody looks at.
     */
    reserveTop?: number;
  },
): { entries: T[]; conflicts: number; attempts: number; feasible: boolean } {
  const { bracketSize, tierOf, groupOf, seed } = opts;
  const maxAttempts = opts.maxAttempts ?? 64;
  const reserveTop = opts.reserveTop ?? 0;

  // Contested = both slots hold a real entrant. entries.length is the field, so
  // ranks above it are empty and their matches are byes or nothing at all.
  const positions = getStandardSeedPositions(bracketSize);
  let contested = 0;
  let byeSlots = 0;
  for (let pos = 0; pos < bracketSize; pos += 2) {
    const a = positions[pos]! <= entries.length;
    const b = positions[pos + 1]! <= entries.length;
    if (a && b) contested++;
    else if (a || b) byeSlots++;
  }

  const perGroup = new Map<number, number>();
  for (const e of entries) {
    const g = groupOf(e);
    if (g != null) perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
  }
  const biggest = perGroup.size === 0 ? 0 : Math.max(...perGroup.values());
  const feasible = biggest <= contested + byeSlots;

  let best: T[] = [...entries];
  let bestConflicts = sameGroupRound1Conflicts(best, bracketSize, groupOf);
  let attempts = 0;

  if (!feasible) {
    // Still DRAW it — the tier shuffle is wanted regardless — but do not spend
    // 64 attempts chasing an arrangement that provably does not exist.
    const drawn = drawWithinQualificationTiers(entries, tierOf, makeDrawRng(seed), reserveTop);
    return {
      entries: drawn,
      conflicts: sameGroupRound1Conflicts(drawn, bracketSize, groupOf),
      attempts: 1,
      feasible: false,
    };
  }

  while (attempts < maxAttempts) {
    // A DIFFERENT SEED EACH ATTEMPT, derived from the recorded one. Re-running
    // generation with the audit row's draw_seed reproduces this same sequence
    // and therefore the same bracket, which is the property the randomised draw
    // was built to have and this must not break.
    const drawn = drawWithinQualificationTiers(entries, tierOf, makeDrawRng((seed + attempts * 0x9e3779b1) >>> 0), reserveTop);
    attempts++;
    const conflicts = sameGroupRound1Conflicts(drawn, bracketSize, groupOf);
    if (conflicts < bestConflicts || attempts === 1) {
      best = drawn;
      bestConflicts = conflicts;
    }
    if (conflicts === 0) return { entries: drawn, conflicts: 0, attempts, feasible: true };
  }

  return { entries: best, conflicts: bestConflicts, attempts, feasible: true };
}

// ============================================================
// Elo Integration
// ============================================================

export async function applyTournamentMatchElo(matchId: string) {
  const adminClient = createAdminClient();

  // Every read below is error-checked, and that is load-bearing rather than
  // tidiness. This function runs AFTER the result row has been written, so
  // returning quietly on a failed read reports the match as rated when nothing
  // was — and the caller's compensation never fires, because nothing threw. A
  // transient read failure would leave exactly the decided-but-unrated match
  // undoDecidedResult exists to prevent.
  const { data: match, error: matchErr } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (matchErr) {
    throw new Error(`Could not read match ${matchId} to rate it — ${matchErr.message}`);
  }
  if (!match || match.status === 'voided' || match.is_bye) return;

  // Idempotency backstop: a populated elo_snapshot means this match's delta was
  // already applied. Re-applying would overwrite the snapshot and strand the
  // first delta with no way to reverse it, so refuse instead. Callers that
  // legitimately re-rate a match (editMatchResult) reverse the snapshot first,
  // which clears it.
  if (match.elo_snapshot) return;

  const event = match.event as Record<string, unknown>;
  // An external event (00269) is unrated: its teams have no ratings rows. The
  // tournament_matches_external_unrated trigger refuses the snapshot as a backstop.
  if (event.external_event === true) return;
  // An unrated staged event or stage (00272). The same trigger refuses the
  // snapshot as the backstop.
  if (!stagedMatchRated(event as { rated?: boolean | null; format_config?: unknown }, match.stage)) return;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  // THE MATCH'S OWN SHAPE, falling back to the event's (00108). A draw whose
  // rounds are played to different lengths has to rate them differently or the
  // whole ladder is cosmetic: a first-round game to 11 would move ratings by as
  // much as a best-of-3 final. derivedFormatWeight already says exactly that —
  // (target / 21) x (1.25 for a best-of) — so a game to 11 lands at ~0.52 and
  // the final at 1.25 with no new formula and no new setting.
  const shape = resolveMatchShape(match as MatchShapeOverride, event as unknown as EventMatchShape);
  // A typed format has no entry in the weight table, so its weight is derived
  // from the shape the same way 00031 derives it for custom challenges. Without
  // this, a pool played at 1 game to 15 would move ratings as if it were the
  // event's fallback enum — usually best of 3 to 21, worth 2.5x as much.
  //
  // BOTH LINES NOW COME OUT OF THE ENGINE rather than being spelled out here,
  // because the console prints them: the bracket tab shows each round's weight
  // under the round's shape, and Event Settings shows the whole ladder. A
  // display derived from a second copy of this arithmetic would be wrong on
  // exactly the rounds the two branches disagree about (a game to 11 is 0.52
  // typed and 0.50 inherited), which is the sort of number nobody re-checks.
  const eloMultiplier = eventEloMultiplier(event.elo_multiplier);
  const formatWeight = resolvedFormatWeight(shape);

  // What this match does to one player's ratings row. Everything except
  // participant_id is required by apply_tournament_match_rating; only the four
  // rating fields end up in the persisted snapshot.
  //
  // The statistics travel with the delta because the tournament path used to
  // move singles_elo/doubles_elo and NOTHING else — no matches_played, no
  // wins/losses, no points, no games, no streak, and the provisional flag never
  // cleared. Since the placement K-factor is chosen FROM matches_played, a
  // tournament regular stayed on the provisional K forever and their stats
  // disagreed with their own rating. Live aggregates already show the gap.
  const ratingEntries: Array<{
    player_id: string;
    before: number;
    after: number;
    delta: number;
    won: boolean;
    points_scored: number;
    points_allowed: number;
    games_won: number;
    games_lost: number;
    /** Singles only — doubles has no per-player participant row to stamp. */
    participant_id?: string;
  }> = [];
  const snapshotDiscipline: 'singles' | 'doubles' = doubles ? 'doubles' : 'singles';

  const ratingSettings = await getRatingSettings(adminClient);

  // Margin-of-victory scaling, the other half of the knob-sharing this file
  // already claims to do. apply_match_result passes
  // get_margin_multiplier(games_won, games_lost) for every challenge; this path
  // passed nothing, so marginMultiplier defaulted to 1.0 and the identical 2-0
  // moved ratings 15% LESS in a tournament than as a challenge.
  //
  // Computed once for the match rather than per side: getMarginMultiplier is
  // symmetric in (won, lost) — a sweep is a sweep for whoever was on the
  // receiving end — so 2-0 and 0-2 both return the sweep value and 2-1 / 1-2
  // both return 1.0. The SQL side evaluates it per participant and gets the
  // same number; doing it once here removes any way to get the orientation
  // wrong. A walkover carries no scores at all, so total games is 0 and the
  // multiplier is 1.0 — which is what the SQL walkover branch does too.
  const matchScores = (match.scores as Array<{ a: number; b: number }> | null) ?? [];
  const gamesA = matchScores.filter(g => g.a > g.b).length;
  const gamesB = matchScores.filter(g => g.b > g.a).length;
  const marginMultiplier = getMarginMultiplier(
    gamesA,
    gamesB,
    ratingSettings?.sweep_margin_multiplier ?? undefined,
  );

  // The same per-side figures apply_match_result reads off match_participants
  // for a challenge. Doubles gives both players of a pair the pair's totals,
  // which is what match_participants holds for a doubles team.
  //
  // A walkover carries no scores at all, so every figure here is 0 — again
  // matching the challenge path, where a walkover has no match_games rows.
  const pointsA = matchScores.reduce((n, g) => n + g.a, 0);
  const pointsB = matchScores.reduce((n, g) => n + g.b, 0);
  const statsForSide = (isSideA: boolean) => ({
    points_scored: isSideA ? pointsA : pointsB,
    points_allowed: isSideA ? pointsB : pointsA,
    games_won: isSideA ? gamesA : gamesB,
    games_lost: isSideA ? gamesB : gamesA,
  });

  if (doubles) {
    // For doubles, update both players in winning and losing pairs
    const winnerId = match.winner_pair_id;
    const loserId = match.loser_pair_id;
    if (!winnerId || !loserId) return;

    // Fetch both pairs in parallel.
    const [
      { data: winnerPair, error: winnerPairErr },
      { data: loserPair, error: loserPairErr },
    ] = await Promise.all([
      adminClient.from('tournament_pairs')
        .select('player1_id, player2_id, combined_elo')
        .eq('id', winnerId).single(),
      adminClient.from('tournament_pairs')
        .select('player1_id, player2_id, combined_elo')
        .eq('id', loserId).single(),
    ]);

    // Both ids came off the match row above, so a pair that cannot be read is a
    // failure, not the unopposed case — that one is caught by the null check on
    // the ids themselves. Returning here would report the match as rated.
    if (winnerPairErr || loserPairErr || !winnerPair || !loserPair) {
      throw new Error(
        `Could not read the pairs in match ${matchId} to rate it — ` +
        `${winnerPairErr?.message ?? loserPairErr?.message ?? 'a pair row is missing'}`,
      );
    }

    const winnerElo = winnerPair.combined_elo ?? 400;
    const loserElo = loserPair.combined_elo ?? 400;

    // Single batched ratings fetch for all 4 players
    const allPlayerIds = [winnerPair.player1_id, winnerPair.player2_id, loserPair.player1_id, loserPair.player2_id];
    const { data: ratings, error: ratingsErr } = await adminClient.from('ratings')
      .select('player_id, doubles_elo, doubles_provisional, doubles_matches_played')
      .in('player_id', allPlayerIds);

    // A failed ratings read used to fall through to the `?? 400` defaults below,
    // which would rate four established players as if they were all on the floor
    // rating — and write that as a real, reversible delta.
    if (ratingsErr) {
      throw new Error(`Could not read current ratings to rate match ${matchId} — ${ratingsErr.message}`);
    }

    const computeFor = (playerId: string, opponentElo: number, won: boolean) => {
      const rating = ratings?.find(r => r.player_id === playerId);
      const before = rating?.doubles_elo ?? 400;
      const k = getKFactor('doubles', rating?.doubles_provisional ?? true, rating?.doubles_matches_played, ratingSettings);
      const result = calculateEloUpdate({
        playerRating: before,
        opponentRating: opponentElo,
        kFactor: k,
        formatWeight,
        eventMultiplier: eloMultiplier,
        marginMultiplier,
        bounds: { min: ratingSettings?.min_elo, max: ratingSettings?.max_elo },
        won,
      });
      return { playerId, before, newRating: result.newRating, delta: result.delta };
    };

    // Which physical side of the match the winning pair occupies, so the points
    // and games attach to the right players.
    const winnerIsA = winnerId === match.pair_a_id;
    const winnerStats = statsForSide(winnerIsA);
    const loserStats = statsForSide(!winnerIsA);

    ratingEntries.push(
      ...[
        computeFor(winnerPair.player1_id, loserElo, true),
        computeFor(winnerPair.player2_id, loserElo, true),
      ].map(c => ({
        player_id: c.playerId, before: c.before, after: c.newRating, delta: c.delta,
        won: true, ...winnerStats,
      })),
      ...[
        computeFor(loserPair.player1_id, winnerElo, false),
        computeFor(loserPair.player2_id, winnerElo, false),
      ].map(c => ({
        player_id: c.playerId, before: c.before, after: c.newRating, delta: c.delta,
        won: false, ...loserStats,
      })),
    );
  } else {
    // Singles
    const winnerId = match.winner_participant_id;
    const loserId = match.loser_participant_id;
    if (!winnerId || !loserId) return;

    // Fetch both participants in parallel
    const [
      { data: winnerP, error: winnerPErr },
      { data: loserP, error: loserPErr },
    ] = await Promise.all([
      adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', winnerId).single(),
      adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', loserId).single(),
    ]);

    // As for pairs above: both ids came off the match row, so this is a failure
    // and not the unopposed case.
    if (winnerPErr || loserPErr || !winnerP || !loserP) {
      throw new Error(
        `Could not read the participants in match ${matchId} to rate it — ` +
        `${winnerPErr?.message ?? loserPErr?.message ?? 'a participant row is missing'}`,
      );
    }

    // Single batched ratings fetch
    const { data: ratings, error: ratingsErr } = await adminClient.from('ratings')
      .select('player_id, singles_elo, singles_provisional, singles_matches_played')
      .in('player_id', [winnerP.player_id, loserP.player_id]);

    // Without this, a failed read falls through to elo_before / 400 below and
    // rates the match off registration-time or floor ratings.
    if (ratingsErr) {
      throw new Error(`Could not read current ratings to rate match ${matchId} — ${ratingsErr.message}`);
    }

    const winnerRating = ratings?.find(r => r.player_id === winnerP.player_id);
    const loserRating = ratings?.find(r => r.player_id === loserP.player_id);

    const winnerElo = winnerRating?.singles_elo ?? winnerP.elo_before ?? 400;
    const loserElo = loserRating?.singles_elo ?? loserP.elo_before ?? 400;

    const winK = getKFactor('singles', winnerRating?.singles_provisional ?? true, winnerRating?.singles_matches_played, ratingSettings);
    const loseK = getKFactor('singles', loserRating?.singles_provisional ?? true, loserRating?.singles_matches_played, ratingSettings);

    const winResult = calculateEloUpdate({
      playerRating: winnerElo,
      opponentRating: loserElo,
      kFactor: winK,
      formatWeight,
      eventMultiplier: eloMultiplier,
      marginMultiplier,
      bounds: { min: ratingSettings?.min_elo, max: ratingSettings?.max_elo },
      won: true,
    });

    const loseResult = calculateEloUpdate({
      playerRating: loserElo,
      opponentRating: winnerElo,
      kFactor: loseK,
      formatWeight,
      eventMultiplier: eloMultiplier,
      marginMultiplier,
      bounds: { min: ratingSettings?.min_elo, max: ratingSettings?.max_elo },
      won: false,
    });

    const winnerIsA = winnerId === match.participant_a_id;
    const winnerStats = statsForSide(winnerIsA);
    const loserStats = statsForSide(!winnerIsA);

    ratingEntries.push(
      {
        player_id: winnerP.player_id, before: winnerElo,
        after: winResult.newRating, delta: winResult.delta,
        won: true, ...winnerStats, participant_id: winnerId,
      },
      {
        player_id: loserP.player_id, before: loserElo,
        after: loseResult.newRating, delta: loseResult.delta,
        won: false, ...loserStats, participant_id: loserId,
      },
    );
  }

  if (ratingEntries.length === 0) return;

  // ONE transaction for every write this match causes: each player's Elo AND
  // match statistics, the singles participants' elo_after/elo_change, and the
  // reversal snapshot.
  //
  // These used to be four-plus separate PostgREST round trips with the snapshot
  // written last. A failure on that final write left the ladder moved with
  // nothing recording by how much — and undoMatchResult, voidMatch and
  // editMatchResult all reverse from the snapshot, so the half-state could not
  // be repaired from the club app at all. The old code's own error message said
  // "the applied deltas must be corrected by hand". Postgres now guarantees the
  // pairing instead of the error message apologising for it.
  //
  // The RPC also re-checks elo_snapshot IS NULL under a row lock, so two desks
  // entering the same result at once cannot both apply a delta.
  const { error: rpcError } = await adminClient.rpc('apply_tournament_match_rating', {
    p_match_id: matchId,
    p_discipline: snapshotDiscipline,
    p_entries: ratingEntries,
  });

  if (rpcError) {
    // Nothing landed — the whole call rolled back — so this is safe to retry
    // and safe to leave alone. That is the entire point of the change.
    throw new Error(
      `Elo update for match ${matchId} failed and NOTHING was applied — ${rpcError.message}`,
    );
  }
}

/**
 * Undo everything a rated tournament match did: each player's Elo delta and
 * match statistics, the reliability counter, the singles participants'
 * elo_after/elo_change, and the snapshot itself.
 *
 * The whole reversal is ONE transaction inside
 * reverse_tournament_match_rating (00078). It used to be a batch of PostgREST
 * read-modify-writes here, and that shape carried a defect no amount of care in
 * TypeScript could close: the ratings came off the ladder in one round trip and
 * the REDUCED snapshot went back in another. When the second one failed, the
 * ORIGINAL snapshot survived on a match whose deltas were already gone — so the
 * next void/undo/edit reversed the same entries a second time. Since 00070 the
 * statistics travel with the Elo, so a double reverse also strips a
 * matches_played, a win, and a set of points and games the match never added.
 * The floors at 0 made that quieter, not rarer.
 *
 * That is also why the old partial-reversal machinery is gone rather than
 * ported. Keeping the un-reversed entries on the snapshot and retrying the
 * remainder was the mitigation for a batch that could half-land; nothing can
 * half-land now, so there is never a remainder.
 *
 * Reversing is therefore idempotent: the snapshot is cleared in the same
 * transaction as the deltas, and a match with no snapshot has nothing to undo,
 * so the RPC returns quietly. A retry after an unclear outcome is safe.
 *
 * The statistics half is not optional. editMatchResult reverses the snapshot and
 * then RE-rates the match, so a reversal that left matches_played/wins/points
 * behind would add a second set of counts on every correction; undo and void
 * would leave a result in the statistics that no longer exists.
 *
 * Two figures still cannot be reversed unconditionally, and the SQL handles both:
 *   - best_*_streak is a high-water mark. It is never written on the way back
 *     out, exactly as it is never written on the way in.
 *   - current_*_streak is restored EXACTLY when the match being undone is still
 *     the player's most recent rated one — 00078 stores the streak before and
 *     after, and compares the stored "after" with what is in the row. Before
 *     that, undoing a win by a player who had been on -3 left them on 0 rather
 *     than -3. If a later match has moved the streak since, the old
 *     step-toward-zero applies instead, because rewinding to the stored value
 *     would erase that later match.
 */
export async function reverseEloSnapshot(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
) {
  const { error } = await adminClient.rpc('reverse_tournament_match_rating', {
    p_match_id: matchId,
  });

  // Nothing landed — the whole call rolled back — so the snapshot is still on
  // the match and a retry reverses it once. Callers turn this into a refusal:
  // a void or an undo that could not hand the rating back has not happened.
  if (error) {
    throw new Error(
      `Elo reversal for match ${matchId} failed and NOTHING was reversed — ${error.message}`,
    );
  }
}

/**
 * Put a match back the way it was found, then rethrow, after its rating failed.
 *
 * Both entry points write the result row BEFORE rating it — they have to, since
 * applyTournamentMatchElo reads the winner and loser off the row. So an RPC
 * failure used to leave a match decided but UNRATED, and nothing could retry it:
 * enterMatchResult refuses anything that is not pending/ready/live, and the
 * withdrawal cascade skips matches that are no longer open. The ratings were
 * never applied — 00070 made that atomic — but the result was, and the pair
 * could not be completed by any action in the console.
 *
 * Undoing the result write restores the only state a retry can start from.
 * Advancement has deliberately not happened yet at either call site (rating runs
 * first, precisely so a later match is rated against the rating an earlier one
 * left behind), so there is nothing downstream to unwind here.
 *
 * Every field either writer touches is restored from the row as it was read,
 * rather than nulled: `status` in particular can legitimately be pending, ready
 * or live, and guessing would decide the bracket's state on the caller's behalf.
 */
export async function undoDecidedResult(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
  prior: Record<string, unknown>,
  cause: unknown,
): Promise<never> {
  const restore = {
    status: prior.status ?? 'ready',
    scores: prior.scores ?? null,
    time_exceeded: prior.time_exceeded ?? false,
    winner_participant_id: prior.winner_participant_id ?? null,
    loser_participant_id: prior.loser_participant_id ?? null,
    winner_pair_id: prior.winner_pair_id ?? null,
    loser_pair_id: prior.loser_pair_id ?? null,
    walkover_winner: prior.walkover_winner ?? null,
    walkover_reason: prior.walkover_reason ?? null,
    result_entered_by: prior.result_entered_by ?? null,
    result_entered_at: prior.result_entered_at ?? null,
    updated_at: new Date().toISOString(),
  };

  const detail = cause instanceof Error ? cause.message : String(cause);

  // `elo_snapshot IS NULL` is the whole safety of this write, and it is a
  // condition on the row rather than on anything this request remembers.
  //
  // The rating did not necessarily fail to happen just because THIS request saw
  // it fail. Two desks can both read a playable match, both write a result and
  // both compute against a null snapshot; the first RPC commits and the second
  // is refused with "already rated". A response can also be lost after Postgres
  // committed. In both cases the match IS rated, and restoring it to playable
  // would leave a rated match open for entry — Elo, statistics and the
  // reliability count all applied, with the idempotency guard then refusing
  // every attempt to re-enter it. Strictly worse than the gap this closes.
  //
  // count: 'exact' because PostgREST reports "matched no rows" as success. The
  // filter is the guard; the count is how we find out the guard fired.
  const { error, count } = await adminClient.from('tournament_matches')
    .update(restore, { count: 'exact' })
    .eq('id', matchId)
    .is('elo_snapshot', null);

  // The compensating write is itself a PostgREST write and can fail too. That
  // lands back in exactly the state this function exists to prevent, so say so
  // instead of reporting the rating error alone — an exec reading "rating
  // failed, try again" would try again and be refused.
  if (error) {
    throw new Error(
      `${detail} — and match ${matchId} could not be put back into a retryable state (${error.message}). ` +
      `It is now recorded as decided but UNRATED and must be corrected by hand.`,
    );
  }

  if (count === 0) {
    throw new Error(
      `${detail} — but match ${matchId} is already rated, so the result was left in place. ` +
      `Another desk most likely entered it at the same moment; reload before entering it again.`,
    );
  }

  throw cause;
}

// ============================================================
// Walkovers, advancement, and late withdrawals
// ============================================================

export type DrawExitStatus = 'withdrawn' | 'disqualified';

// Written onto a match forfeited automatically, so the opponent's walkover
// says why rather than just appearing.
//
// `as const satisfies`, not `: Record<…, string>` — the literal types are what
// make these assignable to PublicWalkoverReason below, and the `satisfies` half
// still fails the build if a DrawExitStatus is ever added without a sentence.
export const FORFEIT_REASON = {
  withdrawn: 'Opponent withdrew from the event',
  disqualified: 'Opponent was disqualified',
} as const satisfies Record<DrawExitStatus, string>;

/**
 * What a manually entered walkover puts on the MATCH ROW.
 *
 * The exec types a sentence into the walkover panel. Until now that sentence
 * went straight into `tournament_matches.walkover_reason`, which is the exact
 * shape 00117 / 00118 / 00125 exist to undo — and worse here than at most of
 * those sites, because 00113 publishes `tournament_matches` to
 * supabase_realtime and REPLICATION IGNORES COLUMN GRANTS. Every phone watching
 * the bracket received the payload. The four sweeps that closed the others were
 * scoped by the word "note" and never reached a column called `reason`.
 *
 * So the row now carries a bounded phrase and the exec's own words go to
 * `tournament_match_notes`, beside the void and no-show reasons written from
 * the same dialog. This is 00135's `court` decision in reverse: broadcasting
 * *that* it was a walkover is the feature, so the fact stays public — bounded,
 * not privatised — while the sentence behind it does not.
 */
export const DESK_WALKOVER_REASON = 'Walkover awarded by the desk';

/**
 * The complete vocabulary of `tournament_matches.walkover_reason`.
 *
 * Exported so a migration's CHECK constraint and a test can both be written
 * against one list rather than three copies of it. NULL is also legal on the
 * column and always has been — a walkover recorded before this existed.
 */
export const PUBLIC_WALKOVER_REASONS = [
  FORFEIT_REASON.withdrawn,
  FORFEIT_REASON.disqualified,
  DESK_WALKOVER_REASON,
] as const;

export type PublicWalkoverReason = (typeof PUBLIC_WALKOVER_REASONS)[number];

/**
 * The mechanical half of a walkover: stamp the result on the match, rate it,
 * and advance the winner. Shared by the admin's manual walkover entry and by
 * the forfeit cascade a late withdrawal triggers, so both write an identical
 * match row — including the elo_snapshot that undo/edit reverse. A second
 * hand-rolled forfeit path would be a second set of rating invariants.
 *
 * Always rated. Every caller reaches here only on a live event: a walkover
 * recorded earlier could not be rated at all, and it would count as a result,
 * which blocks regenerating the draw — the remedy that belongs at that stage.
 *
 * applyTournamentMatchElo now THROWS when a rating write fails, and that
 * propagates: through advanceWinner's cascade, and out of the
 * forfeitOpenMatchesForEntry loop that a withdrawal or disqualification runs.
 * So a late withdrawal can now fail partway with some forfeits already
 * recorded, and withdrawParticipant reports ok:false instead of a tidy
 * { forfeited, unresolved }. That is the point: the alternative is a cascade
 * that says it forfeited eight matches while silently rating none of them.
 */
export async function recordWalkover(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
  winnerPosition: 'a' | 'b',
  // BOUNDED, and typed rather than commented so a caller cannot hand this the
  // exec's free text again. Whatever arrives here is broadcast — see
  // PUBLIC_WALKOVER_REASONS.
  publicReason: PublicWalkoverReason,
  enteredBy: string,
) {
  const matchId = match.id as string;

  const winnerId = (doubles
    ? (winnerPosition === 'a' ? match.pair_a_id : match.pair_b_id)
    : (winnerPosition === 'a' ? match.participant_a_id : match.participant_b_id)) as string | null;
  const loserId = (doubles
    ? (winnerPosition === 'a' ? match.pair_b_id : match.pair_a_id)
    : (winnerPosition === 'a' ? match.participant_b_id : match.participant_a_id)) as string | null;

  const winnerField = doubles ? 'winner_pair_id' : 'winner_participant_id';
  const loserField = doubles ? 'loser_pair_id' : 'loser_participant_id';

  // Checked, not fired and forgotten: supabase-js resolves with { error } rather
  // than rejecting, so an unchecked write here reported a walkover that the
  // bracket never actually recorded — and then rated and advanced off it.
  //
  // Conditional on the status the caller read, for the same reason
  // enterMatchResult's write is: it makes recording a result a compare-and-swap,
  // so a walkover cannot be stamped over a result another desk entered between
  // that read and this write. The count is the only way to tell, since PostgREST
  // reports "matched no rows" as success.
  const { error: writeError, count } = await adminClient.from('tournament_matches').update({
    status: 'walkover',
    walkover_winner: winnerPosition,
    walkover_reason: publicReason,
    [winnerField]: winnerId,
    [loserField]: loserId,
    result_entered_by: enteredBy,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { count: 'exact' })
    .eq('id', matchId)
    .eq('status', match.status as string);

  if (writeError) {
    throw new Error(`Could not record the walkover on match ${matchId}: ${writeError.message}`);
  }

  if (count === 0) {
    throw new Error(
      `Match ${matchId} changed while the walkover was being recorded — it is no longer ${String(match.status)}. Nothing was written.`,
    );
  }

  // Rate BEFORE advancing. Advancing can cascade into another forfeit further
  // up the bracket, and a player's later matches must be rated against the
  // rating their earlier ones left them on, not the other way round.
  //
  // A failure here would otherwise leave a forfeited-but-unrated match that no
  // action can retry: the cascade skips anything that is no longer open, and
  // manual walkover entry refuses anything already decided. Take the walkover
  // back off so the retry has something to act on.
  try {
    await applyTournamentMatchElo(matchId);
  } catch (err) {
    await undoDecidedResult(adminClient, matchId, match, err);
  }

  // 'skip', not 'refuse': this is also the withdrawal cascade's path, and it is
  // looping over one player's open matches. A throw here would leave the
  // forfeits it already committed with the rest undone.
  if (winnerId) await advanceWinner(adminClient, match, doubles, winnerId, enteredBy, 'skip');
  // A forfeited semi-final still produces a loser, and they still belong in the
  // third-place playoff — where settleAdvancedMatch will notice they have
  // withdrawn (that is usually WHY this was a walkover) and forfeit that match
  // to the other semi-finalist once both slots are filled. Skipping the route
  // here instead would leave the playoff permanently half-empty.
  await advanceLoser(adminClient, match, doubles, loserId, enteredBy, 'skip');
}

/**
 * What to do when the match we would advance INTO has already been decided.
 *
 * 'refuse' is for a human entering a result: they are about to be told their
 * bracket cannot absorb this, and stopping is the only honest answer.
 *
 * 'skip' is for the withdrawal cascade, which loops over one player's open
 * matches. Throwing there would leave the forfeits it had already committed
 * with the rest undone, which is a worse draw than the one it was repairing.
 */
type DecidedTargetPolicy = 'refuse' | 'skip';

/**
 * Move `entryId` into the match this one feeds along `route`, then decide that
 * match's state. Callers used to inline this; the withdrawal cascade needs the
 * exact same rule, and a slot filled by a slightly different one is how a
 * bracket ends up disagreeing with itself.
 */
async function routeEntry(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
  entryId: string,
  enteredBy: string,
  route: MatchRoute,
  onDecided: DecidedTargetPolicy,
) {
  const target = routeOf(match, route);
  if (!target) return;

  // Read the target BEFORE touching it. A decided match must not have a slot
  // rewritten underneath its result: that is the corruption at the end of
  // void -> hand-place a substitute -> play the downstream -> restore and
  // replay. The slot write used to happen first and settleAdvancedMatch then
  // dragged a completed, rated match back to `ready`; re-entering it kept the
  // old snapshot, so the new occupants were never rated while the old ones kept
  // the delta.
  const { data: targetRow } = await adminClient.from('tournament_matches')
    .select('status')
    .eq('id', target.nextId)
    .single();

  const targetStatus = targetRow?.status as string | undefined;
  if (targetStatus && targetStatus !== 'pending' && targetStatus !== 'ready') {
    if (onDecided === 'refuse') {
      throw new ExpectedError(
        'The next match has already been played, so this result cannot be advanced into it. ' +
        'Void or undo that match first, then enter this one again.',
      );
    }
    // The withdrawal cascade must not stop half way — it is looping over one
    // player's open matches and the ones already forfeited are committed. Leave
    // the decided match alone and record that the draw needs a human.
    Sentry.captureException(new Error(
      `Could not advance into match ${target.nextId}: it is already ${targetStatus}. The draw may need manual repair.`,
    ));
    return;
  }

  await adminClient.from('tournament_matches')
    .update({ [entrySideField(target.side, doubles)]: entryId })
    .eq('id', target.nextId);

  await settleAdvancedMatch(adminClient, target.nextId, doubles, enteredBy);
}

export async function advanceWinner(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
  winnerId: string,
  enteredBy: string,
  onDecided: DecidedTargetPolicy = 'refuse',
) {
  await routeEntry(adminClient, match, doubles, winnerId, enteredBy, 'winner', onDecided);
}

/**
 * Send a semi-final's LOSER into the third-place playoff (00080).
 *
 * `loserId` is nullable and that is the whole point of the guard below: a BYE
 * has no losing side, and a walkover awarded to the only entry present has no
 * loser either. Routing "null" would write an empty slot over one the other
 * semi-final had already filled, or — worse, before the null check — would look
 * to a later reader like a phantom entry standing in a real playoff. A
 * third-place match that keeps one side empty is the honest outcome: the
 * bracket's existing recovery panel offers "advance unopposed", which is
 * unrated, and nobody collects Elo for a playoff nobody contested.
 *
 * Called AFTER advanceWinner at every call site, for the same reason
 * advanceWinner is called after rating: advancement can cascade into another
 * forfeit, and the ordering keeps that cascade deterministic.
 */
export async function advanceLoser(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
  loserId: string | null,
  enteredBy: string,
  onDecided: DecidedTargetPolicy = 'refuse',
) {
  if (!loserId) return;
  await routeEntry(adminClient, match, doubles, loserId, enteredBy, 'loser', onDecided);
}

/**
 * A match becomes READY once both slots are filled — but only if both
 * occupants are still in the event. Someone who withdrew after the draw was
 * published is still sitting in their slot, so without this check the arriving
 * winner is shown a live match against a player who is not coming. That is the
 * half of a late withdrawal the withdrawal itself cannot fix: at the time they
 * pulled out their next opponent was still TBD.
 */
async function settleAdvancedMatch(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
  doubles: boolean,
  enteredBy: string,
) {
  const { data: next } = await adminClient.from('tournament_matches')
    .select('*')
    .eq('id', matchId)
    .single();
  if (!next) return;

  const aId = (doubles ? next.pair_a_id : next.participant_a_id) as string | null;
  const bId = (doubles ? next.pair_b_id : next.participant_b_id) as string | null;
  if (!aId || !bId) return;

  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const { data: entries } = await adminClient.from(table)
    .select('id, status')
    .in('id', [aId, bId]);

  const statusOf = (id: string) => entries?.find(e => e.id === id)?.status as string | undefined;
  const aOut = isOutOfEvent(statusOf(aId));
  const bOut = isOutOfEvent(statusOf(bId));

  // Exactly one side gone → the other walks over. Both gone is a draw an admin
  // has to unpick by hand, so it still surfaces as READY rather than silently
  // awarding a win to someone who is also not playing.
  if (aOut !== bOut) {
    const goneStatus = statusOf(aOut ? aId : bId) as DrawExitStatus;
    await recordWalkover(adminClient, next, doubles, aOut ? 'b' : 'a', FORFEIT_REASON[goneStatus], enteredBy);
    return;
  }

  // Belt and braces: never drag a DECIDED match back to ready. routeEntry
  // refuses to write into a decided target before it gets here, so this should
  // be unreachable — but this is the single line that every advancement path
  // funnels through, and it was the last step of a sequence that silently
  // destroyed a result (see routeEntry). Silent rather than throwing: the
  // withdrawal cascade calls this in a loop, and one throw mid-loop would leave
  // half the forfeits committed.
  // A staged knockout row learns its sides here, so this is where its head
  // starts are snapshotted (00272).
  const starts = next.stage != null ? await stagedHeadStarts(adminClient, next, doubles, aId, bId) : {};
  await adminClient.from('tournament_matches')
    .update({ status: 'ready', ...starts })
    .eq('id', matchId)
    .in('status', ['pending', 'ready']);
}

async function stagedHeadStarts(
  adminClient: ReturnType<typeof createAdminClient>,
  match: { event_id: string; stage: number | null },
  doubles: boolean,
  aId: string,
  bId: string,
): Promise<{ handicap_a?: number; handicap_b?: number }> {
  const { data: event } = await adminClient.from('tournament_events')
    .select('format_config').eq('id', match.event_id).maybeSingle();
  const cfg = parseFormatConfig(event?.format_config);
  const stage = cfg ? stageAt(cfg, match.stage) : undefined;
  if (!cfg || !stage) return {};
  let catA: string | null = null;
  let catB: string | null = null;
  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, team_category').in('id', [aId, bId]);
    catA = pairs?.find(p => p.id === aId)?.team_category ?? null;
    catB = pairs?.find(p => p.id === bId)?.team_category ?? null;
  }
  const rules = stageMatchRules(cfg, stage, catA, catB);
  return { handicap_a: rules.startA, handicap_b: rules.startB };
}

/**
 * The head starts a staged row WOULD be given now, from its two sides'
 * current categories (00279), without writing them. null when a side is empty
 * or the row's stage is not in the config. What "Apply the current head start"
 * compares a played match's recorded starts against.
 */
export async function currentStagedHeadStarts(
  adminClient: ReturnType<typeof createAdminClient>,
  match: {
    event_id: string;
    stage: number | null;
    pair_a_id?: string | null;
    pair_b_id?: string | null;
    participant_a_id?: string | null;
    participant_b_id?: string | null;
  },
  doubles: boolean,
): Promise<{ handicap_a: number; handicap_b: number } | null> {
  if (match.stage == null) return null;
  const aId = (doubles ? match.pair_a_id : match.participant_a_id) ?? null;
  const bId = (doubles ? match.pair_b_id : match.participant_b_id) ?? null;
  if (!aId || !bId) return null;
  const starts = await stagedHeadStarts(adminClient, match, doubles, aId, bId);
  if (starts.handicap_a == null || starts.handicap_b == null) return null;
  return { handicap_a: starts.handicap_a, handicap_b: starts.handicap_b };
}

/**
 * Re-read a staged row's sides and snapshot their head starts again (00272):
 * 0-0 while a side is empty, the stage's matrix once both are known. Called by
 * every writer that sets a side by hand or re-routes one, so the starts a
 * score is judged by always belong to the two entries now in the match.
 * A legacy row (stage NULL) is left alone.
 *
 * `onlyOpen` writes only while the row is still pending or ready, and a row
 * that has moved on meanwhile is skipped rather than refused: a category
 * change must not touch a match already on court.
 */
export async function refreshStagedHandicaps(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
  doubles: boolean,
  opts?: { onlyOpen?: boolean },
): Promise<void> {
  const { data: m, error } = await adminClient.from('tournament_matches')
    .select('id, event_id, stage, pair_a_id, pair_b_id, participant_a_id, participant_b_id')
    .eq('id', matchId)
    .maybeSingle();
  if (error) throw new Error(`Could not read match ${matchId} to set its head starts: ${error.message}`);
  if (!m || m.stage == null) return;
  const aId = (doubles ? m.pair_a_id : m.participant_a_id) as string | null;
  const bId = (doubles ? m.pair_b_id : m.participant_b_id) as string | null;
  const starts = aId && bId
    ? await stagedHeadStarts(adminClient, m, doubles, aId, bId)
    : { handicap_a: 0, handicap_b: 0 };
  if (starts.handicap_a == null) return;
  if (opts?.onlyOpen) {
    const { error: writeError } = await adminClient.from('tournament_matches')
      .update(starts).eq('id', matchId).in('status', ['pending', 'ready']);
    if (writeError) throw new Error(`Setting the head starts of match ${matchId} failed: ${writeError.message}`);
    return;
  }
  await mustWrite(
    `Setting the head starts of match ${matchId}`,
    adminClient.from('tournament_matches').update(starts).eq('id', matchId).select('id'),
  );
}

/**
 * Forfeit every still-playable match belonging to `entryId` to its opponent.
 * Called when an entry is withdrawn or disqualified after the draw exists —
 * bracket generation only ever saw a point-in-time snapshot of who was in, so
 * without this the entry stays seeded and their matches stay READY.
 *
 * Finished matches are left exactly as they are: a walkover cannot rewrite a
 * result that was actually played, and a first-round bye is unrated, so it
 * carries no Elo to unwind.
 */
export async function forfeitOpenMatchesForEntry(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  entryId: string,
  doubles: boolean,
  // Bounded for the same reason recordWalkover's is — this value ends up on the
  // published match row. Every caller passes a FORFEIT_REASON entry.
  reason: PublicWalkoverReason,
  enteredBy: string,
): Promise<{ forfeited: number; unresolved: number }> {
  const { data: candidates } = await adminClient.from('tournament_matches')
    .select('id, round_number, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
    .eq('event_id', eventId)
    .in('status', [...OPEN_MATCH_STATUSES])
    .order('round_number', { ascending: true });

  let forfeited = 0;
  let unresolved = 0;

  for (const candidate of candidates ?? []) {
    if (!forfeitOutcome(candidate, entryId, doubles)) continue;

    // Re-read before acting: an earlier forfeit in this loop advances an
    // opponent, which can settle a later match on this very list.
    const { data: match } = await adminClient.from('tournament_matches')
      .select('*')
      .eq('id', candidate.id)
      .single();
    if (!match || !isOpenMatch(match.status as string) || match.is_bye) continue;

    const outcome = forfeitOutcome(match, entryId, doubles);
    if (!outcome) continue;

    // Opponent slot still TBD — there is nobody to award the walkover to.
    // settleAdvancedMatch forfeits it the moment the feeder match resolves.
    if (!outcome.winnerId) { unresolved++; continue; }

    await recordWalkover(adminClient, match, doubles, outcome.winnerSide, reason, enteredBy);
    forfeited++;
  }

  return { forfeited, unresolved };
}

/**
 * Forfeit the open matches of everyone who is no longer in the event.
 *
 * Run when an event goes live. Between the draw being published and the first
 * serve, a withdrawal deliberately does NOT touch the bracket — nothing has
 * been played, so the honest remedy is to regenerate the draw without them,
 * and a walkover recorded then would be unrated AND would block that
 * regeneration. Go-live is the moment that stops being true: the draw is now
 * the draw, and a forfeit finally carries the Elo it is supposed to.
 */
export async function forfeitOutOfEventEntries(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  doubles: boolean,
  enteredBy: string,
): Promise<{ forfeited: number; unresolved: number }> {
  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const { data: entries } = await adminClient.from(table)
    .select('id, status')
    .eq('event_id', eventId)
    .in('status', ['withdrawn', 'disqualified']);

  let forfeited = 0;
  let unresolved = 0;

  for (const entry of entries ?? []) {
    const outcome = await forfeitOpenMatchesForEntry(
      adminClient,
      eventId,
      entry.id,
      doubles,
      FORFEIT_REASON[entry.status as DrawExitStatus],
      enteredBy,
    );
    forfeited += outcome.forfeited;
    unresolved += outcome.unresolved;
  }

  return { forfeited, unresolved };
}

// ============================================================
// Round Robin Standings (utility)
// ============================================================

// seedBy picks the FIRST sort key only — see sortStandings. It exists so that
// pool-to-bracket seeding and the leaderboard tally the same figures from the
// same query and differ only in how the finished table is read.
//
// TWO ORDERS, ONE TALLY (00106). Everything above the final sort is identical
// for a flat round robin and a group stage — the same matches, the same
// withdrawal rule, the same figures — because a group stage IS a round robin
// that happens to be partitioned. Only the last step differs:
//
//   * group_count NULL or 1 -> sortStandings, exactly as before. Not a special
//     case of the group path, and not routed through it: the flat behaviour is
//     the untouched one.
//   * group_count >= 2 -> qualificationOrder, which reads the event as winners,
//     then runners-up, then thirds. Every row also comes back carrying `group`
//     and `groupRank`, which is what lets the bracket generator shuffle within
//     qualification tiers and keep group-mates apart in round one.
//
// WHAT THIS CHANGES FOR A FINALISED GROUP STAGE, stated rather than left to be
// discovered: finalize.ts assigns final_position from this list's order, so a
// group stage's positions become 1..G for the group winners (best record
// first), G+1..2G for the runners-up, and so on. Positions stay UNIQUE — one
// 1st, one 2nd — so the placement-bonus ledger pays exactly the same number of
// people it always did. The alternative, a flat ranking across groups by raw
// wins, is the one that is actually wrong here: it compares records built
// against different opposition over different numbers of fixtures.
export async function computeRoundRobinStandings(eventId: string, seedBy: SeedBy = 'wins') {
  const adminClient = createAdminClient();

  // THE SAME RULE AS THE PAIRS READ BELOW, applied to the two reads this
  // function opens with. Both used to discard their error, and both feed the
  // tally: an unreadable event returned `[]`, and unreadable matches left
  // every entry on zero. Either way the caller was handed a standings table
  // that looked settled and said the wrong thing — finalize.ts assigns
  // final_position straight off this list, so "no finishers" and "everybody
  // drew" are both writable outcomes.
  //
  // A genuinely absent event still returns `[]`. That is a real state (the
  // event was deleted underneath the caller) and it is what the callers
  // already handle; only the error case changes.
  const { data: event, error: eventError } = await adminClient
    .from('tournament_events').select('*').eq('id', eventId).single();
  if (eventError && eventError.code !== 'PGRST116') {
    throw new Error(`Could not read this event: ${eventError.message}`);
  }
  if (!event) return [];

  const doubles = isDoublesEvent(event.event_type);
  const groupCount = (event as { group_count?: number | null }).group_count ?? 1;
  const grouped = groupCount >= 2;

  // Get all completed matches.
  //
  // THE POOL'S MATCHES ONLY, ON A POOL-TO-BRACKET EVENT (00107). Both phases
  // live in this one event, so an unfiltered tally would fold the knockout's
  // results back into the pool table — the champion would gain wins in the
  // standings that decided who qualified, and finalizeEvent (which ranks the
  // non-qualifiers off this same list) would rank them against a table that had
  // moved underneath it. phaseValueFor returns null for the other two formats,
  // whose matches all carry phase NULL, so this is exactly the old query there.
  const poolPhase = phaseValueFor(event.format as string, 'pool');
  let matchQuery = adminClient.from('tournament_matches')
    .select('*')
    .eq('event_id', eventId)
    .in('status', ['completed', 'walkover']);
  if (poolPhase) matchQuery = matchQuery.eq('phase', poolPhase);
  const { data: matches, error: matchesError } = await matchQuery;
  if (matchesError) {
    throw new Error(`Could not read this event's results: ${matchesError.message}`);
  }

  // EVERY entry, including the ones that left. They are filtered out of the
  // final ordering further down, not out of the tally.
  //
  // Excluding them here quietly deleted real results. The loop below skips any
  // match whose two ids are not both in this map, so when somebody withdrew
  // mid-event, the games they had already PLAYED vanished from the standings —
  // their opponents' genuine wins and losses among them — while every one of
  // those matches stayed in the global Elo and in the players' match records.
  // Positions and round-robin points were then computed from a different set of
  // results than the ratings were, and nothing said so.
  let entries: Array<{ id: string; name: string; out: boolean; group: number | null }> = [];
  if (doubles) {
    const { data: pairs, error: pairsError } = await adminClient.from('tournament_pairs')
      .select('id, pair_name, status, group_number')
      .eq('event_id', eventId);
    // THROWN, NOT SWALLOWED. A failed read and an empty event are not the same
    // fact, and `?? []` made them indistinguishable — which is exactly how a
    // broken embed presented itself as "this pool has no finishers" instead of
    // as an error naming the column it could not resolve.
    if (pairsError) throw new Error(`Could not read this event's pairs: ${pairsError.message}`);
    entries = (pairs ?? []).map(p => ({
      id: p.id,
      name: p.pair_name ?? 'Unnamed',
      out: isOutOfEvent(p.status as string),
      group: (p as { group_number?: number | null }).group_number ?? null,
    }));
  } else {
    const { data: participants, error: participantsError } = await adminClient.from('tournament_participants')
      // THE FK IS NAMED, and it has to be. tournament_participants has THREE
      // foreign keys to players — player_id, added_by and checked_in_by — so a
      // bare `players(...)` embed is ambiguous, and PostgREST answers an
      // ambiguous embed with an ERROR and no rows rather than picking one.
      //
      // supabase-js resolves rather than rejects on that, so `data` came back
      // null, `(participants ?? [])` turned it into an empty list, and the
      // standings came out EMPTY for every singles round robin — surfacing as
      // "the round robin has no finishers to seed the knockout from" on an
      // event with eighteen checked-in players and thirty-two played matches.
      // Pre-existing; it took a singles pool actually reaching the seeding step
      // to run this line at all.
      .select('id, status, group_number, player:players!tournament_participants_player_id_fkey(full_name)')
      .eq('event_id', eventId);
    if (participantsError) {
      throw new Error(`Could not read this event's entrants: ${participantsError.message}`);
    }
    entries = (participants ?? []).map(p => ({
      id: p.id,
      name: ((p.player as unknown as Record<string, unknown>)?.full_name as string) ?? 'Unknown',
      out: isOutOfEvent(p.status as string),
      group: (p as { group_number?: number | null }).group_number ?? null,
    }));
  }
  // The tally and the order live in @badminton/shared (tallyRoundRobin,
  // rankRoundRobin) so they are testable without a database and so the admin
  // round-robin table reads the same order this returns. A withdrawn entry's
  // results still count towards everyone else's record; the entry itself does
  // not take a placing. An external event (00269) drops head-to-head and game
  // difference from the order; see rankRoundRobin.
  //
  // groupRank is carried on BOTH shapes so callers never have to branch on
  // which one they got. A flat round robin has one implicit group, so its
  // groupRank is just the finishing place, which is what it means.
  const tallied = tallyRoundRobin(entries, (matches ?? []).map(m => ({
    status: m.status as string,
    sideA: doubles ? m.pair_a_id : m.participant_a_id,
    sideB: doubles ? m.pair_b_id : m.participant_b_id,
    winner: doubles ? m.winner_pair_id : m.winner_participant_id,
    scores: (m.scores as Array<{ a: number; b: number }> | null) ?? null,
  })));
  return rankRoundRobin(tallied, {
    seedBy,
    grouped,
    external: (event as { external_event?: boolean }).external_event === true,
  });
}

/**
 * Refuse to publish a draw that a late entry has already made wrong.
 *
 * Audit F-004, the draw half. A generator reads the field, spends 40+ sequential
 * round trips seeding and inserting matches, and only then moves the event out
 * of `registration`. A member entering anywhere in that window is admitted —
 * enter_tournament_event (00185) sees a status that is still open, and is
 * right to — and then does not appear in the bracket. The result is an entrant
 * who is in the event and in no match, which the draw page has no way to render
 * and the exec no way to repair except by hand.
 *
 * The entry side cannot fix this alone: the two operations are separate
 * transactions, and the lock the RPC takes on the event row is released long
 * before the generator gets to the end.
 *
 * SO THIS IS A FENCE, NOT A LOCK. Count the field again just before the publish
 * and refuse if it grew. Nothing has been published at that point, the matches
 * that were inserted are replaceable (that is what Generate already does on an
 * event that has a draw), and the exec is told the one thing they need to know
 * instead of finding out from a member on the day.
 *
 * `expected` is the size the draw was actually built from. Pool-seeded events
 * pass their own subset and are exempted by the caller — their field comes from
 * another event's standings, so a new entry here was never going to be in it.
 */
export async function assertFieldDidNotGrow(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  doubles: boolean,
  expected: number,
): Promise<void> {
  const { data, error } = await adminClient
    .from(doubles ? 'tournament_pairs' : 'tournament_participants')
    .select('id')
    .eq('event_id', eventId)
    .in('status', ['registered', 'checked_in']);

  // A failed re-count must not read as "nobody arrived". It is the same
  // silently-permissive shape as every other discarded read in this audit.
  if (error) throw new Error(`Could not re-check the field before publishing: ${writeErrorMessage(error)}`);

  const now = (data ?? []).length;
  if (now > expected) {
    const arrived = now - expected;
    throw new ExpectedError(
      `${arrived} ${arrived === 1 ? 'entry' : 'entries'} arrived while this draw was being built, so it would have left `
      + `${arrived === 1 ? 'somebody' : 'people'} out. Nothing was published — press Generate again to include `
      + `${arrived === 1 ? 'them' : 'everyone'}.`,
    );
  }
}

/**
 * WHAT THE FENCED FIELD RPCS RETURN.
 *
 * The fenced field RPCs — set_field_entry_status, remove_field_entry and
 * bulk_check_in_field (00201), the six seeding, grouping and finalisation
 * writers added by 00209 — all answer in the same shape: `ok`, a machine-readable `reason` when it is
 * false, and the event context they read UNDER the field lock. The context is
 * not a convenience — a caller that revalidates from a row it read before the
 * write is reading state the write may have moved.
 */
export interface FencedFieldResult {
  ok: boolean;
  reason?: string;
  already?: boolean;
  entry_status?: string;
  event_status?: string;
  event_id?: string;
  tournament_id?: string;
  checked_in?: number;
  /** auto_seed_field_by_rating, clear_field_seeds, set_field_groups. */
  seeded?: number;
  cleared?: number;
  assigned?: number;
  group_count?: number;
  /** How many entries arrived or left between the caller's read and the fence. */
  arrived?: number;
  left?: number;
  /** set_field_groups / set_field_entry_group, when fixtures already exist. */
  matches?: number;
  /** complete_event_under_field_lock. */
  incomplete?: number;
  /** Entries that held a placing they WON and had left the event (00211). */
  winners?: string;
  /** Matches whose recorded result moved while the ladder was being computed (00213). */
  matches_moved?: string;
}

/**
 * Turn a fenced RPC's refusal into the sentence the exec should read.
 *
 * The refusals these RPCs make are the SAME refusals their callers make a
 * moment earlier — that is the point of 00201: the caller's copy is a fast,
 * friendly one made outside the lock, and this one is made under it. So a
 * refusal arriving here is not normally a mistake by the exec; it is the race
 * being caught. The messages say so where that helps, and stay identical to
 * the caller's where the distinction would not mean anything to them.
 *
 * `notFound` is per-call because "Participant not found" and "Pair not found"
 * are different sentences at the desk.
 */
export function fencedRefusal(result: FencedFieldResult | null, notFound: string): never {
  if (!result) {
    throw new Error('Could not read this entry. Nothing was changed — try again.');
  }
  switch (result.reason) {
    case 'entry_not_found':
      throw new ExpectedError(notFound);
    case 'event_not_found':
      throw new ExpectedError('This entry is not attached to an event.');
    case 'draw_locked':
      throw new ExpectedError('Draw is locked. Unlock it before making changes.');
    case 'event_completed':
      throw new ExpectedError('This event is finished — void the affected matches instead.');
    case 'event_status':
      throw new ExpectedError(
        `The event moved to "${result.event_status ?? 'another status'}" while this was being saved, so the change was not applied. Reload the page to see where it stands.`,
      );
    case 'entry_status':
      throw new ExpectedError(
        `This entry is "${result.entry_status ?? 'in another state'}" and cannot be checked in. Reload the page to see where it stands.`,
      );
    case 'not_undoable':
      throw new ExpectedError(
        `This entry is "${result.entry_status ?? 'in another state'}", so there is no check-in or no-show to undo. Reload the page to see where it stands.`,
      );
    // ---- 00209: the seeding, grouping and finalisation fences ----------
    case 'not_a_group_stage':
      throw new ExpectedError('This event is not split into groups. Set a group count on the event first.');
    case 'group_out_of_range':
      throw new ExpectedError(`Group must be between 1 and ${result.group_count ?? 1}.`);
    case 'fixtures_exist':
      throw new ExpectedError(
        'The fixtures for this event have already been generated, so its groups are fixed. Regenerate the round robin if the groups really have to change.',
      );
    // The two arrival races. Both say what happened and what to press, because
    // the exec did nothing wrong — somebody else's write landed first.
    case 'field_changed':
      throw new ExpectedError(
        result.arrived
          ? `${result.arrived} ${result.arrived === 1 ? 'entry' : 'entries'} arrived while this was being prepared, so it would have left `
            + `${result.arrived === 1 ? 'somebody' : 'people'} out. Nothing was changed — press it again to include `
            + `${result.arrived === 1 ? 'them' : 'everyone'}.`
          : 'The entry list changed while this was being prepared, so nothing was changed. Reload the page and try again.',
      );
    case 'matches_incomplete':
      throw new ExpectedError(
        `${result.incomplete ?? 'Some'} match(es) were still incomplete when this event was about to be finalised, so it was left live. Reload to see which.`,
      );
    default:
      throw new ExpectedError('That change could not be saved. Reload the page and try again.');
  }
}

// ============================================================
// The waitlist (00278)
// ============================================================

/** The waitlist functions are unknown to this database: 00278 is pending. */
export function isWaitlistMissing(error: { code?: string } | null | undefined): boolean {
  return !!error && ['42883', 'PGRST202', '42P01', 'PGRST205'].includes(error.code ?? '');
}

/** What fill_event_from_waitlist reports back. */
export interface WaitlistFillResult {
  ok: boolean;
  reason?: string;
  cap?: number;
  event_status?: string;
  tournament_id?: string;
  event_id?: string;
  promoted?: Array<{ player_id: string; participant_id: string; waitlist_id: string }>;
  skipped?: Array<{ player_id: string; waitlist_id: string; reason: string }>;
}

/**
 * Settle what a promotion wrote: the entry fee for everybody promoted, and one
 * audit row. Never throws, because the promotion has already committed.
 */
export async function settleWaitlistPromotions(
  adminClient: ReturnType<typeof createAdminClient>,
  result: WaitlistFillResult | null | undefined,
  actorId: string,
  automatic: boolean,
): Promise<number> {
  const promoted = result?.promoted ?? [];
  const tournamentId = result?.tournament_id;
  if (promoted.length === 0 || !tournamentId) return 0;
  const playerIds = promoted.map((p) => p.player_id);
  await ensureEntryFees(adminClient, tournamentId, playerIds);
  await logAudit(adminClient, {
    tournament_id: tournamentId,
    event_id: result?.event_id,
    action: 'waitlist_promote',
    performed_by: actorId,
    details: { player_ids: playerIds, automatic },
  });
  return promoted.length;
}

/**
 * After an action frees a place in an event, hand it to the head of the
 * waitlist, when the event has one set to promote automatically.
 *
 * A SEPARATE STEP THAT NEVER FAILS THE ACTION. The place was freed by a write
 * that has already committed, so a failure here (00278 not applied yet, the
 * read failing, the fill refusing) is logged and the action still succeeds.
 * The settings are read on their own, never added to an existing select, so a
 * database without the columns is simply "no waitlist".
 */
export async function fillFromWaitlistAfterFree(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  actorId: string,
): Promise<number> {
  try {
    const { data: ev, error: evError } = await adminClient
      .from('tournament_events')
      .select('waitlist_enabled, waitlist_auto_promote')
      .eq('id', eventId)
      .maybeSingle();
    if (evError) {
      if (!['42703', 'PGRST204'].includes(evError.code ?? '')) Sentry.captureException(evError);
      return 0;
    }
    const settings = ev as { waitlist_enabled?: boolean; waitlist_auto_promote?: boolean } | null;
    if (!settings?.waitlist_enabled || !settings.waitlist_auto_promote) return 0;

    const { data, error } = await adminClient.rpc('fill_event_from_waitlist', {
      p_event_id: eventId,
      p_actor: actorId,
      p_waitlist_id: null,
    });
    if (error) {
      Sentry.captureException(new Error(
        isWaitlistMissing(error)
          ? `Waitlist fill skipped, migration 00278 is not applied: ${error.message}`
          : `Waitlist fill failed: ${error.message}`,
      ));
      return 0;
    }
    return await settleWaitlistPromotions(adminClient, data as WaitlistFillResult | null, actorId, true);
  } catch (err) {
    Sentry.captureException(err);
    return 0;
  }
}
