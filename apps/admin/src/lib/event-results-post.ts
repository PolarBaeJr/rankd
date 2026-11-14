import {
  isDoublesEvent,
  ordinal,
  TOURNAMENT_EVENT_TYPE_LABELS,
  type Json,
  type TournamentEventType,
} from '@badminton/shared';
import type { createAdminClient } from './supabase-server';
import { releaseFlagOn } from './release-flags';
import { notifyPlayers } from './notify';
import { loadMarketingRecipients } from './marketing-recipients';
import { loadPublicEntryNames } from './social-posts/names';
import { adminBaseUrl } from './base-path';

type AdminClient = ReturnType<typeof createAdminClient>;

// THE TOP 4, ANNOUNCED (results_post). Called by finalizeEvent once the event
// is completed, inside its held-failure pattern, so nothing here can undo a
// finalize.
//
// ONE ANNOUNCEMENT PER EVENT. event_results_posts remembers it, and a
// re-finalize edits that row; the 00170 relay sees updated_at move and edits
// the Discord message. An announcement an officer deleted stays deleted.
//
// Written through the service client, not createAnnouncement: that action
// asks announcements.create.write and an active season, and the officer
// finalizing holds neither necessarily. Short and factual, by the owner:
// "<Event> results: 1st ..., 2nd ..., 3rd ..., 4th ...". Ties are kept, so an
// event with no playoff for third lists two 3rds.

export const RESULTS_POST_PLACES = 4;
const EVERGREEN_DAYS = 14;

export interface TopEntry {
  position: number;
  entry_id: string;
}

export function resultsLine(eventName: string, top: ReadonlyArray<TopEntry>, names: ReadonlyMap<string, string>): string {
  const places = top.map((entry) => `${ordinal(entry.position)} ${names.get(entry.entry_id) ?? 'A member'}`);
  return `${eventName} results: ${places.join(', ')}`;
}

export function sameTop(a: ReadonlyArray<TopEntry>, b: ReadonlyArray<TopEntry>): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => entry.position === b[index]!.position && entry.entry_id === b[index]!.entry_id);
}

export interface ResultsPostOutcome {
  posted: 'off' | 'nothing_placed' | 'created' | 'updated' | 'kept_deleted';
  notified: number;
}

export async function postEventResults(
  adminClient: AdminClient,
  eventId: string,
  actorId: string,
): Promise<ResultsPostOutcome> {
  if (!(await releaseFlagOn('results_post'))) return { posted: 'off', notified: 0 };

  const { data: event, error: eventError } = await adminClient
    .from('tournament_events')
    .select('id, tournament_id, event_type, tournament:tournaments(name)')
    .eq('id', eventId)
    .single();
  if (eventError || !event) throw new Error(`The event could not be read: ${eventError?.message ?? 'not found'}`);
  const doubles = isDoublesEvent(event.event_type);
  const tournament = (Array.isArray(event.tournament) ? event.tournament[0] : event.tournament) as { name?: string } | null;
  const label = TOURNAMENT_EVENT_TYPE_LABELS[event.event_type as TournamentEventType] ?? event.event_type;
  const eventName = tournament?.name ? `${tournament.name} ${label}` : label;

  const placed = doubles
    ? await adminClient.from('tournament_pairs').select('id, final_position')
      .eq('event_id', eventId).not('final_position', 'is', null).lte('final_position', RESULTS_POST_PLACES)
    : await adminClient.from('tournament_participants').select('id, final_position')
      .eq('event_id', eventId).not('final_position', 'is', null).lte('final_position', RESULTS_POST_PLACES);
  if (placed.error) throw new Error(`The placings could not be read: ${placed.error.message}`);
  const top: TopEntry[] = ((placed.data ?? []) as Array<{ id: string; final_position: number }>)
    .map((row) => ({ position: row.final_position, entry_id: row.id }))
    .sort((a, b) => a.position - b.position || a.entry_id.localeCompare(b.entry_id));
  if (top.length === 0) return { posted: 'nothing_placed', notified: 0 };

  const names = await loadPublicEntryNames(adminClient, eventId, doubles);
  const line = resultsLine(eventName, top, names);
  const title = `${eventName} results`;

  const { data: existing, error: existingError } = await adminClient
    .from('event_results_posts')
    .select('event_id, announcement_id, top, marketing_notified_at')
    .eq('event_id', eventId)
    .maybeSingle();
  if (existingError) throw new Error(`The results post could not be read: ${existingError.message}`);

  const changed = !existing || !sameTop((existing.top as unknown as TopEntry[]) ?? [], top);
  const notifiedBefore = existing?.marketing_notified_at ?? null;
  const now = new Date().toISOString();
  let posted: ResultsPostOutcome['posted'];
  let announcementId: string | null;
  if (!existing) {
    const { data: season } = await adminClient.from('seasons').select('id').eq('active_flag', true).maybeSingle();
    const { data: announcement, error: insertError } = await adminClient
      .from('announcements')
      .insert({
        title,
        body: line,
        type: 'event',
        status: 'published',
        send_push: false,
        pinned: false,
        target_audience: 'all',
        author_id: actorId,
        season_id: season?.id ?? null,
        all_seasons: !season?.id,
        expires_at: season?.id ? null : new Date(Date.now() + EVERGREEN_DAYS * 86_400_000).toISOString(),
      })
      .select('id')
      .single();
    if (insertError || !announcement) {
      throw new Error(`The results announcement was not posted: ${insertError?.message ?? 'no row'}`);
    }
    announcementId = announcement.id;
    const { error: rowError } = await adminClient.from('event_results_posts').insert({
      event_id: eventId,
      announcement_id: announcementId,
      top: top as unknown as Json,
      posted_at: now,
      updated_at: now,
    });
    if (rowError) throw new Error(`The results post was not recorded: ${rowError.message}`);
    posted = 'created';
  } else {
    announcementId = existing.announcement_id;
    if (announcementId) {
      const { error: updateError } = await adminClient
        .from('announcements')
        .update({ title, body: line })
        .eq('id', announcementId);
      if (updateError) throw new Error(`The results announcement was not updated: ${updateError.message}`);
      posted = 'updated';
    } else {
      posted = 'kept_deleted';
    }
    const { error: rowError } = await adminClient
      .from('event_results_posts')
      .update({ top: top as unknown as Json, updated_at: now })
      .eq('event_id', eventId);
    if (rowError) throw new Error(`The results post was not recorded: ${rowError.message}`);
  }

  // THE MARKETING NOTICE: the first time, and again only when the top 4
  // itself changed, so a re-finalize that moved nobody does not repeat it.
  if (!changed && notifiedBefore) return { posted, notified: 0 };

  const recipients = await loadMarketingRecipients(adminClient);
  const metadata: Record<string, unknown> = {
    kind: 'event_results_handoff',
    event_id: eventId,
    tournament_id: event.tournament_id,
    copy_text: line,
  };
  if (await releaseFlagOn('social_posts')) {
    metadata.console_url = `${adminBaseUrl('')}/announcements/social/${eventId}`;
  }
  const { delivered } = await notifyPlayers(adminClient, recipients, {
    type: 'general',
    title: `Results to post: ${eventName}`,
    body: line,
    metadata,
  });
  if (delivered.length > 0) {
    await adminClient.from('event_results_posts').update({ marketing_notified_at: now }).eq('event_id', eventId);
  }
  return { posted, notified: delivered.length };
}
