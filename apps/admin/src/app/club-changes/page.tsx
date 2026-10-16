export const dynamic = 'force-dynamic';
import { PageHeader } from '@badminton/ui';
import { clubToday, readFeatureFlags } from '@badminton/shared';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { formatDraft, type ClubChangeDraft } from '@/lib/club-change-format';
import { ClubChangesBoard, type BoardEntry, type BoardLine } from './club-changes-board';

// CLUB CHANGES (00286). Saving a rating setting, an account rule, a member page
// switch, a club link or an officer role leaves a plain-language line here.
// An admin rewords, deletes or adds lines, lets them pile up, and posts one or
// the whole bundle. Posted entries show on the members' What's new page, and
// can also go out as a club announcement, which the bot relays to Discord.
//
// changelog.page is in no baseline, so this is admin-only, and the page asks
// again here rather than leaning on the route map. The officer names beside a
// line are a roster read, so they are fetched only for a players.read holder.

const DRAFT_COLUMNS =
  'id, source, subject, field, from_value, to_value, text_override, override_to_value, first_actor_id, last_actor_id, revision, created_at, changed_at';

function dateLabel(iso: string): string {
  return new Date(`${clubToday(new Date(iso))}T00:00:00Z`).toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default async function ClubChangesPage() {
  const viewer = await requireCapability('changelog.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(level, viewer);
  const can = (capability: Capability) => permits(level, permissions, capability);
  const canPost = can('changelog.post.write');
  const canAnnounce = can('announcements.create.write');
  const canReadRoster = can('players.read');

  const db = createAdminClient();
  const [draftsRead, entriesRead, features] = await Promise.all([
    db.from('club_change_drafts').select(DRAFT_COLUMNS).order('created_at'),
    db
      .from('club_change_entries')
      .select('id, title, intro, lines, posted_by, posted_at, announcement_id')
      .order('posted_at', { ascending: false })
      .limit(20),
    readFeatureFlags(db),
  ]);

  // Before 00286 the tables do not exist. Say so rather than draw an empty page.
  if (draftsRead.error || entriesRead.error) {
    return (
      <div>
        <PageHeader eyebrow="System" title="Club changes" sub="Changes to how the club runs, posted to members." watermark="C" />
        <p className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 text-[13px] text-[var(--text-muted)]">
          Club changes could not be read. If this is a new install, run migration 00286 first.
        </p>
      </div>
    );
  }

  const drafts = (draftsRead.data ?? []) as ClubChangeDraft[];
  const entries = (entriesRead.data ?? []) as {
    id: string;
    title: string | null;
    intro: string | null;
    lines: unknown;
    posted_by: string | null;
    posted_at: string;
    announcement_id: string | null;
  }[];

  const actorIds = new Set<string>();
  for (const row of drafts) if (row.last_actor_id) actorIds.add(row.last_actor_id);
  for (const row of entries) if (row.posted_by) actorIds.add(row.posted_by);
  const names = new Map<string, string>();
  if (canReadRoster && actorIds.size > 0) {
    const { data } = await db.from('players').select('id, full_name').in('id', [...actorIds]);
    for (const row of (data ?? []) as { id: string; full_name: string | null }[]) {
      if (row.full_name) names.set(row.id, row.full_name);
    }
  }

  const lines: BoardLine[] = [];
  for (const row of drafts) {
    const formatted = formatDraft(row);
    // A first save that only wrote the defaults changed nothing. It is never
    // shown, and goes with the next post.
    if (formatted.noOp) continue;
    lines.push({
      id: row.id,
      revision: row.revision,
      source: row.source,
      group: formatted.group,
      text: formatted.text,
      autoText: formatted.autoText,
      known: formatted.known,
      reworded: row.source !== 'manual' && row.text_override !== null,
      staleRewording: formatted.staleRewording,
      changedOn: dateLabel(row.changed_at),
      by: row.last_actor_id ? names.get(row.last_actor_id) ?? null : null,
    });
  }

  const posted: BoardEntry[] = entries.map((row) => ({
    id: row.id,
    title: row.title,
    intro: row.intro,
    lines: Array.isArray(row.lines) ? row.lines.filter((l): l is string => typeof l === 'string') : [],
    postedOn: dateLabel(row.posted_at),
    by: row.posted_by ? names.get(row.posted_by) ?? null : null,
    announced: row.announcement_id !== null,
  }));

  const announceBlocked = !canAnnounce
    ? 'You cannot post announcements, so this cannot go out as one.'
    : !features.announcements
      ? 'Announcements are switched off for members, so this would not reach the website or Discord.'
      : null;

  return (
    <div>
      <PageHeader
        eyebrow="System"
        title="Club changes"
        sub="Edits to ratings, account rules, member pages, club links and officer roles collect here. Reword them, then post one or all of them to members."
        watermark="C"
      />
      <ClubChangesBoard lines={lines} entries={posted} canPost={canPost} announceBlocked={announceBlocked} />
    </div>
  );
}
