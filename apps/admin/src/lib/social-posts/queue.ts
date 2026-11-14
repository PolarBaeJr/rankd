import { stageGroupLabel } from '@badminton/shared';
import type { createAdminClient } from '../supabase-server';
import { releaseFlagOn } from '../release-flags';
import { notifyPlayers } from '../notify';
import { loadMarketingRecipients } from '../marketing-recipients';
import { adminBaseUrl } from '../base-path';
import { buildCaption, readSocialHashtags, type SocialSetKind } from './caption';
import { loadSocialEvent, SET_COLUMNS, type DrawGroup, type SocialEvent, type SocialSetRow } from './sets';

type AdminClient = ReturnType<typeof createAdminClient>;

// QUEUEING SOCIAL POSTS (social_posts). Nothing here posts anywhere: a set is
// a row of ids and a caption, and the Marketing holders are told it is ready.
//
// TEAMS. The first confirmed run makes "Meet the teams", the full set. Every
// later run that adds teams makes "New teams" with only those, and a fresh
// full set that supersedes the old one. Runs within BATCH_MINUTES of an open
// "New teams" set append to it and send no second notice, so a desk adding
// three teams by hand in a row is one post, not three. Lazy batching: no job.
//
// THE DRAW. Each draw makes one set of its groups, or of its first round, and
// supersedes the draw set before it.
//
// Called after the change it describes is committed, and never allowed to
// fail it: the callers wrap it.

export const BATCH_MINUTES = 10;

const ACTIVE_PAIR = '("withdrawn","disqualified")';

interface Notice {
  kind: SocialSetKind;
  count: number;
}

async function notifyReady(adminClient: AdminClient, event: SocialEvent, setId: string, notice: Notice): Promise<boolean> {
  const recipients = await loadMarketingRecipients(adminClient);
  const what =
    notice.kind === 'draw'
      ? 'The draw slides'
      : notice.kind === 'teams_new'
        ? `New teams slides (${notice.count})`
        : 'Meet the teams slides';
  const { delivered } = await notifyPlayers(adminClient, recipients, {
    type: 'general',
    title: `Social posts: ${event.name}`,
    body: `${what} for ${event.name} are ready to post.`,
    metadata: {
      kind: 'social_posts_ready',
      event_id: event.id,
      tournament_id: event.tournament_id,
      set_id: setId,
      console_url: `${adminBaseUrl('')}/announcements/social/${event.id}`,
    },
  });
  return delivered.length > 0;
}

async function insertSet(
  adminClient: AdminClient,
  row: { event_id: string; kind: SocialSetKind; entry_ids: string[]; groups?: DrawGroup[] | null; caption: string },
): Promise<string> {
  const { data, error } = await adminClient
    .from('event_social_post_sets')
    .insert({ ...row, groups: (row.groups ?? null) as never })
    .select('id')
    .single();
  if (error || !data) throw new Error(`The social post set was not saved: ${error?.message ?? 'no row'}`);
  return data.id;
}

async function supersede(adminClient: AdminClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await adminClient
    .from('event_social_post_sets')
    .update({ superseded_at: new Date().toISOString() })
    .in('id', ids);
  if (error) throw new Error(`The older social post set was not marked superseded: ${error.message}`);
}

async function markNotified(adminClient: AdminClient, id: string): Promise<void> {
  await adminClient.from('event_social_post_sets').update({ notified_at: new Date().toISOString() }).eq('id', id);
}

export interface QueueOutcome {
  created: SocialSetKind[];
  appendedTo: string | null;
  notified: boolean;
}

const NOTHING: QueueOutcome = { created: [], appendedTo: null, notified: false };

/**
 * After teams are confirmed, added, edited or split. `newPairIds` are the
 * teams this change made; empty refreshes the full set only, silently.
 */
export async function queueTeamSocialPosts(
  adminClient: AdminClient,
  eventId: string,
  newPairIds: readonly string[],
  now: Date = new Date(),
): Promise<QueueOutcome> {
  if (!(await releaseFlagOn('social_posts'))) return NOTHING;
  const event = await loadSocialEvent(adminClient, eventId);
  if (!event || !event.doubles) return NOTHING;

  const [pairsRes, setsRes, hashtags] = await Promise.all([
    adminClient.from('tournament_pairs').select('id, created_at').eq('event_id', eventId).not('status', 'in', ACTIVE_PAIR),
    adminClient.from('event_social_post_sets').select(SET_COLUMNS).eq('event_id', eventId).is('superseded_at', null),
    readSocialHashtags(adminClient),
  ]);
  if (pairsRes.error) throw new Error(`The teams could not be read: ${pairsRes.error.message}`);
  if (setsRes.error) throw new Error(`The social post sets could not be read: ${setsRes.error.message}`);
  const allPairIds = ((pairsRes.data ?? []) as Array<{ id: string; created_at: string | null }>)
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id.localeCompare(b.id))
    .map((pair) => pair.id);
  const open = (setsRes.data ?? []) as unknown as SocialSetRow[];
  const full = open.filter((set) => set.kind === 'teams_full');
  const added = newPairIds.filter((id) => allPairIds.includes(id));
  const caption = (kind: SocialSetKind) =>
    buildCaption({ kind, eventName: event.name, date: event.date, time: event.time, venue: event.venue, hashtags });

  if (full.length === 0) {
    if (allPairIds.length === 0) return NOTHING;
    const id = await insertSet(adminClient, { event_id: eventId, kind: 'teams_full', entry_ids: allPairIds, caption: caption('teams_full') });
    const notified = await notifyReady(adminClient, event, id, { kind: 'teams_full', count: allPairIds.length });
    if (notified) await markNotified(adminClient, id);
    return { created: ['teams_full'], appendedTo: null, notified };
  }

  const outcome: QueueOutcome = { created: [], appendedTo: null, notified: false };
  if (added.length > 0) {
    const cutoff = now.getTime() - BATCH_MINUTES * 60_000;
    const recent = open
      .filter((set) => set.kind === 'teams_new' && new Date(set.created_at).getTime() >= cutoff)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (recent) {
      const merged = [...recent.entry_ids, ...added.filter((id) => !recent.entry_ids.includes(id))];
      const { error } = await adminClient.from('event_social_post_sets').update({ entry_ids: merged }).eq('id', recent.id);
      if (error) throw new Error(`The new teams set was not updated: ${error.message}`);
      outcome.appendedTo = recent.id;
    } else {
      const id = await insertSet(adminClient, { event_id: eventId, kind: 'teams_new', entry_ids: added, caption: caption('teams_new') });
      outcome.created.push('teams_new');
      outcome.notified = await notifyReady(adminClient, event, id, { kind: 'teams_new', count: added.length });
      if (outcome.notified) await markNotified(adminClient, id);
    }
  }

  // The full set, always current. Superseded rather than edited, so a full set
  // somebody has already posted still reads as what they posted.
  const current = full[0]!;
  const unchanged = current.entry_ids.length === allPairIds.length && current.entry_ids.every((id, index) => id === allPairIds[index]);
  if (!unchanged) {
    await supersede(adminClient, full.map((set) => set.id));
    if (allPairIds.length > 0) {
      await insertSet(adminClient, { event_id: eventId, kind: 'teams_full', entry_ids: allPairIds, caption: caption('teams_full') });
      outcome.created.push('teams_full');
    }
  }
  return outcome;
}

interface DrawMatchRow {
  stage: number | null;
  pool_number: number | null;
  group_number: number | null;
  round_number: number | null;
  bracket_position: number | null;
  participant_a_id: string | null;
  participant_b_id: string | null;
  pair_a_id: string | null;
  pair_b_id: string | null;
}

/** The newest stage's groups, or its first round as match lines. Pure. */
export function drawGroupsFrom(rows: readonly DrawMatchRow[], doubles: boolean): { groups: DrawGroup[]; shape: 'groups' | 'bracket' } {
  if (rows.length === 0) return { groups: [], shape: 'bracket' };
  const latest = Math.max(...rows.map((row) => row.stage ?? 0));
  const stageRows = rows.filter((row) => (row.stage ?? 0) === latest);
  const sides = (row: DrawMatchRow) => (doubles ? [row.pair_a_id, row.pair_b_id] : [row.participant_a_id, row.participant_b_id]);

  if (stageRows.some((row) => row.group_number !== null)) {
    const keyed = new Map<string, { pool: number; group: number; ids: string[] }>();
    for (const row of stageRows) {
      if (row.group_number === null) continue;
      const pool = row.pool_number ?? 1;
      const key = `${pool}:${row.group_number}`;
      const entry = keyed.get(key) ?? { pool, group: row.group_number, ids: [] };
      for (const id of sides(row)) if (id && !entry.ids.includes(id)) entry.ids.push(id);
      keyed.set(key, entry);
    }
    const entries = [...keyed.values()].sort((a, b) => a.pool - b.pool || a.group - b.group);
    const pools = new Set(entries.map((entry) => entry.pool)).size;
    const groupsPerPool = Math.max(...entries.map((entry) => entries.filter((other) => other.pool === entry.pool).length));
    return {
      shape: 'groups',
      groups: entries.map((entry) => ({ title: stageGroupLabel({ pools, groupsPerPool }, entry.pool, entry.group), entry_ids: entry.ids })),
    };
  }

  const firstRound = Math.min(...stageRows.map((row) => row.round_number ?? 1));
  const ids = stageRows
    .filter((row) => (row.round_number ?? 1) === firstRound)
    .sort((a, b) => (a.bracket_position ?? 0) - (b.bracket_position ?? 0))
    .flatMap((row) => sides(row).map((id) => id ?? ''));
  return { shape: 'bracket', groups: [{ title: 'First round', entry_ids: ids, versus: true }] };
}

/** After a draw is published. */
export async function queueDrawSocialPosts(adminClient: AdminClient, eventId: string): Promise<QueueOutcome> {
  if (!(await releaseFlagOn('social_posts'))) return NOTHING;
  const event = await loadSocialEvent(adminClient, eventId);
  if (!event) return NOTHING;

  const [matchesRes, openRes, hashtags] = await Promise.all([
    adminClient
      .from('tournament_matches')
      .select('stage, pool_number, group_number, round_number, bracket_position, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
      .eq('event_id', eventId),
    adminClient.from('event_social_post_sets').select('id').eq('event_id', eventId).eq('kind', 'draw').is('superseded_at', null),
    readSocialHashtags(adminClient),
  ]);
  if (matchesRes.error) throw new Error(`The draw could not be read: ${matchesRes.error.message}`);
  if (openRes.error) throw new Error(`The social post sets could not be read: ${openRes.error.message}`);
  const { groups, shape } = drawGroupsFrom((matchesRes.data ?? []) as unknown as DrawMatchRow[], event.doubles);
  if (groups.length === 0) return NOTHING;

  await supersede(adminClient, ((openRes.data ?? []) as Array<{ id: string }>).map((set) => set.id));
  const entryIds = [...new Set(groups.flatMap((group) => group.entry_ids).filter(Boolean))];
  const id = await insertSet(adminClient, {
    event_id: eventId,
    kind: 'draw',
    entry_ids: entryIds,
    groups,
    caption: buildCaption({ kind: 'draw', drawShape: shape, eventName: event.name, date: event.date, time: event.time, venue: event.venue, hashtags }),
  });
  const notified = await notifyReady(adminClient, event, id, { kind: 'draw', count: entryIds.length });
  if (notified) await markNotified(adminClient, id);
  return { created: ['draw'], appendedTo: null, notified };
}
