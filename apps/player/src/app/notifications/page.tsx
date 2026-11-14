import { createServerSupabaseClient, getViewer } from '@/lib/supabase-server';
import { CLUB_TIMEZONE, formatRelativeTime } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { Fragment } from 'react';
import { BellOff } from 'lucide-react';
import { PageHeader } from '@badminton/ui';
import { MarkAllRead, NotificationRow } from './actions';
import { CopyTextButton } from './CopyTextButton';
import {
  groupNotificationsByAge,
  notificationAction,
  notificationCopyText,
  notificationHeadline,
  notificationLabel,
  notificationTone,
  summariseByKind,
  unreadEyebrow,
  type NotificationMetadata,
} from '@/lib/notification-rows';

/** The list query's cap. Named because the aside has to say when it bit. */
const LIST_LIMIT = 50;

type NotificationRecord = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_flag: boolean;
  metadata: NotificationMetadata;
  created_at: string;
};

function metadataOf(n: { metadata: NotificationMetadata }): Record<string, unknown> {
  return n.metadata && typeof n.metadata === 'object' ? n.metadata : {};
}

export default async function NotificationsPage() {
  const { player } = await getViewer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  // Two queries, not one. The list is capped at 50 rows; the eyebrow's count is
  // an exact COUNT over the whole table, so it agrees with the bell in the top
  // bar (layout.tsx runs the same query) instead of quietly maxing out at 50.
  const [listResult, countResult] = await Promise.all([
    supabase
      .from('notifications')
      .select('id, type, title, body, read_flag, metadata, created_at')
      .eq('player_id', player.id)
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT),
    supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('player_id', player.id)
      .eq('read_flag', false),
  ]);

  const all = (listResult.data ?? []) as NotificationRecord[];
  const unreadCount = countResult.count ?? 0;

  // KEPT ON PURPOSE, for rows already in the table.
  //
  // Tournament result notifications used to be written with { match_id,
  // event_id } and no tournament_id, while the event route needs both ids. The
  // producer now writes tournament_id (apps/admin/.../tournament-actions/
  // results.ts), so newly written rows do not need this — but every result
  // notification written before that fix is still sitting in `notifications`
  // with only an event_id, and there is no backfill migration for them. Delete
  // this and a member's tournament history quietly loses its links.
  //
  // It costs one batched lookup and only when there is actually something to
  // resolve: `orphanEventIds` is empty for rows that carry both ids, and the
  // query is skipped entirely. As the old rows age out it becomes free by
  // itself, which is the right way for it to go.
  const orphanEventIds = [
    ...new Set(
      all
        .map(metadataOf)
        .filter((m) => typeof m.event_id === 'string' && typeof m.tournament_id !== 'string')
        .map((m) => m.event_id as string),
    ),
  ];
  const tournamentByEvent = new Map<string, string>();
  if (orphanEventIds.length > 0) {
    const { data: events } = await supabase
      .from('tournament_events')
      .select('id, tournament_id')
      .in('id', orphanEventIds);
    for (const e of events ?? []) {
      if (e.tournament_id) tournamentByEvent.set(e.id as string, e.tournament_id as string);
    }
  }

  const rows = all.map((n) => {
    const base = metadataOf(n);
    const eventId = typeof base.event_id === 'string' ? base.event_id : null;
    const metadata =
      eventId && typeof base.tournament_id !== 'string' && tournamentByEvent.has(eventId)
        ? { ...base, tournament_id: tournamentByEvent.get(eventId) }
        : base;

    return {
      id: n.id,
      created_at: n.created_at,
      isRead: n.read_flag,
      headline: notificationHeadline(n),
      kind: notificationLabel(n.type),
      tone: notificationTone(n.type),
      when: formatRelativeTime(n.created_at),
      action: notificationAction(n.type, metadata),
      copyText: notificationCopyText(metadata),
    };
  });

  const sections = groupNotificationsByAge(rows, new Date(), CLUB_TIMEZONE);

  // The aside's two breakdowns. Both are counted off `rows` — the notifications
  // actually rendered below — and off nothing else. There is no actor column
  // and no number in `metadata` (see notification-rows.ts), so a summary of who
  // or how much is not derivable and is not attempted; what IS derivable is how
  // many of each kind and each age are on the screen.
  const kinds = summariseByKind(rows);
  const listIsCapped = all.length >= LIST_LIMIT;

  return (
    // One container around the header AND the body. That is the whole fix: the
    // two used to size independently, so on a wide display the title ran the
    // full viewport while the river was capped and pinned to the left of it.
    <div data-screen-label="Notifications" className="notif-screen">
      <PageHeader
        eyebrow={unreadEyebrow(unreadCount)}
        title="Notifications"
        className="notif-header"
        actions={<MarkAllRead disabled={unreadCount === 0} />}
      />

      {rows.length === 0 ? (
        <div className="card-base">
          <div className="empty">
            <BellOff size={40} className="text-[var(--mute)]" style={{ display: 'block', margin: '0 auto 12px' }} />
            No notifications yet. When something happens, it&apos;ll land here.
          </div>
        </div>
      ) : (
        <div className="notif-wide">
          <div className="notif-list">
            {sections.map((section) => (
              <div key={section.key} id={`notif-${section.key}`} className="notif-section">
                <div className="notif-group">{section.label}</div>
                {section.items.map((row) => (
                  <Fragment key={row.id}>
                    <NotificationRow id={row.id} isRead={row.isRead} href={row.action?.href ?? null}>
                      <div className="notif-body">
                        <div className="notif-headline">{row.headline}</div>
                        <div className="notif-detail">
                          <span className="notif-kind" data-tone={row.tone}>
                            {row.kind}
                          </span>
                          {' · '}
                          {row.when}
                        </div>
                      </div>
                      {/* A span, not a <Button>: the whole row is already the click
                          target, and a button inside a button (or inside a link) is
                          invalid markup that React complains about on hydration.
                          Rows with nowhere to go get nothing here rather than a
                          control that does not work. */}
                      {row.action && <span className="notif-cta">{row.action.label}</span>}
                    </NotificationRow>
                    {row.copyText && <CopyTextButton text={row.copyText} />}
                  </Fragment>
                ))}
              </div>
            ))}
          </div>

          {/* The supporting column. It indexes the river rather than decorating
              it: every figure here is a count of rows that are on this screen,
              and the jump links go to the section headings beside it. It is
              display:none below 1101px — on a phone it would sit underneath
              fifty rows, indexing a list the member has already scrolled past. */}
          <aside className="notif-aside" aria-label="What is in this list">
            <div className="notif-aside-head">By age</div>
            <ul className="notif-index">
              {sections.map((section) => (
                <li key={section.key}>
                  <a className="notif-index-row" href={`#notif-${section.key}`}>
                    <span className="notif-index-label">{section.label}</span>
                    <span className="notif-index-count">{section.items.length}</span>
                  </a>
                </li>
              ))}
            </ul>

            <div className="notif-aside-head">By kind</div>
            <ul className="notif-index">
              {kinds.map((kind) => (
                <li key={kind.kind} className="notif-index-row">
                  <span className="notif-index-label">
                    <i className="notif-dot" data-tone={kind.tone} aria-hidden />
                    {kind.kind}
                  </span>
                  <span className="notif-index-count">{kind.count}</span>
                </li>
              ))}
            </ul>

            {/* Says what the numbers above are OVER. They count the rows on
                screen; the unread figure in the header is an exact COUNT over
                every notification the member has. Without this line the two
                disagree and neither looks trustworthy. */}
            <p className="notif-aside-note">
              {listIsCapped
                ? `Counted over the ${LIST_LIMIT} most recent notifications, which is everything shown here.`
                : `Counted over all ${rows.length} notification${rows.length === 1 ? '' : 's'} shown here.`}{' '}
              The unread figure above counts every one you have.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
