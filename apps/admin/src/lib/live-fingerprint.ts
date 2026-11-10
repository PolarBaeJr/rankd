// THE CHANGE PROBE BEHIND QUIET REFRESH (lib/quiet-refresh.ts). Server side
// only, and NOT 'use server'. A short hash of the rows a live page is drawn
// from: the page renders it, the probe route re-reads it, and the client
// refreshes only when the two differ.
//
// A HASH OF THE ROWS, NOT count plus max(updated_at). tournament_participants
// and tournament_pairs have no updated_at at all, so a check-in or a seed
// would never move one, and nothing maintains updated_at on tournament_matches
// (00138, 00213), so a saved score would not either. The rows are small and
// only the hash leaves the server.
//
// Each caller asks its page's own gate first; these functions ask none.
//
// A NULL RESULT MEANS UNKNOWN: a read failed, so nothing can be said about
// whether the page is current. The client treats it as changed (quiet-refresh.ts,
// probeRefreshDue), so a failing probe still refreshes, only less often.
//
// Every read keyed on a list of ids is chunked (the 8,192-byte request line),
// and every one that can return many rows is paged (db-max-rows, 1,000), so a
// big tournament cannot hash a silently short list and read as unchanged.

import { createHash } from 'node:crypto';
import { selectAllInChunks, selectInChunks } from '@badminton/shared/src/utils/query-chunks';
import { readMyCourts } from './court-helpers';
import type { createAdminClient } from './supabase-server';

type AdminClient = ReturnType<typeof createAdminClient>;
type Read = PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** Null when any read failed: unknown, which the client reads as changed. */
async function hashReads(reads: Read[]): Promise<string | null> {
  const results = await Promise.all(reads);
  if (results.some((r) => r.error)) return null;
  return createHash('sha256').update(JSON.stringify(results.map((r) => r.data ?? null))).digest('hex').slice(0, 32);
}

/** A read that needs ids from an earlier one: the earlier failure, or the later read. */
async function readAfter(first: Read, next: (data: unknown) => Read): Promise<Awaited<Read>> {
  const earlier = await first;
  return earlier.error ? earlier : next(earlier.data);
}

const ids = (data: unknown) => ((data ?? []) as { id: string }[]).map((row) => row.id);

/**
 * What the event page shows: the tournament, its events and courts, this
 * event's entries, matches and their private notes, the waiver acceptances,
 * the Form entries, and the linked club event's sign-ups. Not the roster or
 * player names.
 */
export async function readEventFingerprint(client: AdminClient, tournamentId: string, eventId: string): Promise<string | null> {
  return hashReads([
    client.from('tournaments').select('*').eq('id', tournamentId).maybeSingle(),
    client.from('tournament_events').select('*').eq('tournament_id', tournamentId).order('id'),
    readAfter(
      client.from('tournament_matches').select('*').eq('event_id', eventId).order('id'),
      async (matches) => {
        const notes = await selectInChunks(ids(matches), (batch) =>
          client.from('tournament_match_notes').select('*').in('match_id', batch).order('match_id'),
        );
        return notes.error ? notes : { data: [matches, notes.data], error: null };
      },
    ),
    client.from('event_waiver_acceptances').select('player_id, waiver_hash, accepted_at').eq('tournament_id', tournamentId).order('player_id').order('accepted_at'),
    client.from('registration_import_entries').select('*').eq('tournament_event_id', eventId).order('id'),
    readAfter(
      client.from('club_events').select('id').eq('tournament_event_id', eventId).order('id'),
      (clubEvents) =>
        selectAllInChunks(ids(clubEvents), (batch, from, to) =>
          client.from('club_event_signups').select('player_id, created_at').in('event_id', batch).order('player_id').order('created_at').range(from, to),
        ),
    ),
    client.from('tournament_participants').select('*').eq('event_id', eventId).order('id'),
    client.from('tournament_pairs').select('*').eq('event_id', eventId).order('id'),
    client.from('tournament_event_waitlist').select('*').eq('event_id', eventId).order('id'),
    client.from('tournament_category_requests').select('*').eq('event_id', eventId).order('id'),
    client.from('tournament_courts').select('*').eq('tournament_id', tournamentId).order('id'),
    client.from('tournament_court_helpers').select('*').eq('tournament_id', tournamentId).order('id'),
    // Not paged: the live matches of one tournament are a handful at most.
    client
      .from('tournament_matches')
      .select('id, event_id, court_id, status, tournament_events!inner(tournament_id)')
      .eq('tournament_events.tournament_id', tournamentId)
      .eq('status', 'live')
      .order('id'),
  ]);
}

/** What My courts shows this person: their helper rows, and per tournament its courts, staged events, entries and matches. */
export async function readMyCourtsFingerprint(client: AdminClient, playerId: string): Promise<string | null> {
  let mine;
  try {
    mine = await readMyCourts(client, playerId);
  } catch {
    return null;
  }
  const tournamentIds = [...new Set(mine.map((row) => row.tournament_id))].sort();
  const helperRows = { data: mine.map((row) => `${row.tournament_id}:${row.court_id}`).sort(), error: null };
  if (tournamentIds.length === 0) return hashReads([Promise.resolve(helperRows)]);
  const { data: events, error } = await selectAllInChunks<{ id: string }>(tournamentIds, (batch, from, to) =>
    client
      .from('tournament_events')
      .select('*')
      .in('tournament_id', batch)
      .eq('format', 'staged')
      .order('id')
      .range(from, to),
  );
  if (error) return null;
  const eventIds = (events ?? []).map((e) => e.id);
  return hashReads([
    Promise.resolve(helperRows),
    Promise.resolve({ data: events, error: null }),
    selectAllInChunks(tournamentIds, (batch, from, to) =>
      client.from('tournament_courts').select('*').in('tournament_id', batch).order('id').range(from, to),
    ),
    // Not chunked or paged: an inner-join filter on the live matches, a
    // handful at most, across the few tournaments this person helps at.
    client
      .from('tournament_matches')
      .select('id, event_id, court_id, status, tournament_events!inner(tournament_id)')
      .in('tournament_events.tournament_id', tournamentIds)
      .eq('status', 'live')
      .order('id'),
    selectAllInChunks(eventIds, (batch, from, to) =>
      client.from('tournament_matches').select('*').in('event_id', batch).order('id').range(from, to),
    ),
    selectAllInChunks(eventIds, (batch, from, to) =>
      client.from('tournament_participants').select('*').in('event_id', batch).order('id').range(from, to),
    ),
    selectAllInChunks(eventIds, (batch, from, to) =>
      client.from('tournament_pairs').select('*').in('event_id', batch).order('id').range(from, to),
    ),
  ]);
}
