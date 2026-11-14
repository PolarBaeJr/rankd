export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { formatDateTime, isUuid } from '@badminton/shared';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { releaseFlagOn } from '@/lib/release-flags';
import { loadRenderedSetsForEvent, loadSocialEvent } from '@/lib/social-posts/sets';
import { loadPublicEntryNames } from '@/lib/social-posts/names';
import { resultsLine, type TopEntry } from '@/lib/event-results-post';
import { SocialPostsView } from './social-posts-view';

// SOCIAL POSTS FOR ONE EVENT (00333): the sets the teams and the draw made,
// and the results line once the event is finalized. Linked from the Marketing
// notices. The social_posts switch off is a 404, as is the image route.

export default async function SocialPostsPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  if (!(await releaseFlagOn('social_posts'))) notFound();
  await requireCapability('announcements.socialposts.read');
  if (!isUuid(eventId)) notFound();

  const adminClient = createAdminClient();
  const event = await loadSocialEvent(adminClient, eventId);
  if (!event) notFound();

  const [rendered, resultsRow] = await Promise.all([
    loadRenderedSetsForEvent(adminClient, event),
    adminClient.from('event_results_posts').select('top').eq('event_id', eventId).maybeSingle(),
  ]);

  // A failed read must not read as "no results yet".
  if (resultsRow.error) throw new Error(`The results post could not be read: ${resultsRow.error.message}`);
  let line: string | null = null;
  const top = (resultsRow.data?.top ?? null) as TopEntry[] | null;
  if (Array.isArray(top) && top.length > 0) {
    line = resultsLine(event.name, top, await loadPublicEntryNames(adminClient, eventId, event.doubles));
  }

  return (
    <SocialPostsView
      eventName={event.name}
      eventHref={`/tournaments/${event.tournament_id}/events/${event.id}`}
      resultsLine={line}
      sets={rendered.map(({ set, pages }) => ({
        id: set.id,
        kind: set.kind,
        createdAt: formatDateTime(set.created_at),
        superseded: set.superseded_at !== null,
        caption: set.caption,
        slides: pages.length,
        entries: set.entry_ids.length,
      }))}
    />
  );
}
