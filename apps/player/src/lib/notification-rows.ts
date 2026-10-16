// Derivations behind the /notifications screen.
//
// Lives in apps/player rather than packages/shared for the same reason
// feed-activity.ts does: these are the shapes this one screen needs, and the
// brief for it forbids touching the shared packages.
//
// Everything here is pure and takes `now` as an argument rather than reading
// the clock, so "today" can be tested rather than hoped for.
//
// WHAT THE DATA ACTUALLY CARRIES. A `notifications` row is
// (type, title, body, read_flag, metadata, created_at) — see 00001_schema.sql.
// There is no actor column and no numeric payload anywhere in `metadata`:
// every producer writes only foreign keys (challenge_id, match_id, session_id,
// event_id, tournament_id, announcement_id, walkover_id, flagged_player_id).
// So nothing here tries to name the person a notification is about or to put a
// rating delta beside it — neither is derivable, and guessing would be worse
// than leaving it out.

import { isUuid } from '@badminton/shared';
import { clubDayKey, shiftDayKey } from './feed-activity';

export type NotificationMetadata = Record<string, unknown> | null | undefined;

/** Which token a row's type reads in. Deliberately a small closed set: these
 *  map onto --red / --win / --gold / --mute and nothing else. */
export type NotificationTone = 'red' | 'win' | 'gold' | 'mute';

export interface NotificationAction {
  href: string;
  /** Verb on the affordance. Short enough to sit in a 44px slot at 390px. */
  label: string;
}

/** The whole `notification_type` enum as of 00001_schema.sql, mapped to the
 *  micro-caps label a row leads its detail line with and the tone it reads in.
 *
 *  EIGHT OF THESE STILL HAVE NO PRODUCER, AND ALL EIGHT ARE KEPT ON PURPOSE.
 *  Audited against every writer of `notifications` in the tree — the two
 *  notifyPlayers helpers (apps/player/src/lib/actions/_shared.ts,
 *  apps/admin/src/lib/notify.ts), the tournament one in
 *  apps/admin/src/lib/tournament-actions/_internal.ts, seven edge functions
 *  under supabase/functions, and the one trigger INSERT in 00004_triggers.sql.
 *  Between them those write thirteen of the twenty-one values. The other eight
 *  are NOT vestigial: each names something the product genuinely does and
 *  simply never tells the member about in-app.
 *
 *    result_confirmed   confirmMatchResult() sends notifyMatchConfirmed(), an
 *                       EMAIL. No row is written, so the bell stays silent.
 *    dispute_opened     disputeMatchResult() emails the admins — its own Sentry
 *                       tag is literally `email: 'dispute_opened'`.
 *    dispute_resolved   resolveDispute() (admin actions/disputes.ts) writes an
 *                       audit_log entry and nothing the member can see.
 *    rank_changed       a ratings recalculation already counts rank movements
 *                       (see /ratings' "22 rank changes" aside).
 *    walkover_confirmed confirmWalkover() exists and audit-logs under exactly
 *                       this name; the challenge reaches status
 *                       'walkover_confirmed' in 00003/00049 too.
 *    opponent_withdrew  reportWalkover() notifies on REPORT
 *                       (walkover_reported); the withdrawal itself never lands.
 *    tournament_match_ready
 *    tournament_checkin_open
 *                       both are carried in the notificationType union of
 *                       tournament-actions/_internal.ts as unwired hooks — no
 *                       call site passes either, but check-in and bracket
 *                       advancement are both real, shipped features.
 *
 *  So the gap is a MISSING PRODUCER in eight places, not dead weight here, and
 *  deleting the branches below would delete the landing spot rather than the
 *  problem. They are also not removable from the enum in any case:
 *  `ALTER TYPE … DROP VALUE` does not exist in Postgres, and rebuilding the
 *  type would rewrite every historical `notifications` row.
 *
 *  Independent of all that, the map has to stay total: rows of these types can
 *  already exist in the table, and a screen that only handles what is currently
 *  written is a screen that breaks the day someone wires the rest up. */
const TYPES: Record<string, { label: string; tone: NotificationTone }> = {
  challenge_received: { label: 'Challenge', tone: 'red' },
  challenge_accepted: { label: 'Challenge', tone: 'win' },
  challenge_rejected: { label: 'Challenge', tone: 'mute' },
  challenge_expired: { label: 'Challenge', tone: 'mute' },
  challenge_cancelled: { label: 'Challenge', tone: 'mute' },
  result_pending: { label: 'Result', tone: 'gold' },
  result_confirmed: { label: 'Result', tone: 'win' },
  dispute_opened: { label: 'Dispute', tone: 'red' },
  dispute_resolved: { label: 'Dispute', tone: 'win' },
  rank_changed: { label: 'Rank', tone: 'gold' },
  session_reminder: { label: 'Session', tone: 'mute' },
  walkover_reported: { label: 'Walkover', tone: 'gold' },
  walkover_confirmed: { label: 'Walkover', tone: 'win' },
  opponent_withdrew: { label: 'Walkover', tone: 'mute' },
  admin_alert: { label: 'Alert', tone: 'red' },
  general: { label: 'Update', tone: 'mute' },
  tournament_bracket_published: { label: 'Tournament', tone: 'gold' },
  tournament_match_ready: { label: 'Tournament', tone: 'gold' },
  tournament_match_result: { label: 'Tournament', tone: 'win' },
  tournament_event_completed: { label: 'Tournament', tone: 'win' },
  tournament_checkin_open: { label: 'Tournament', tone: 'red' },
};

/**
 * The micro-caps word a row's detail line leads with.
 *
 * An unrecognised type is turned into something readable rather than dropped:
 * `type` is an enum in Postgres, but the column is read here as a plain string
 * and a future migration adding a value must not blank out the row.
 */
export function notificationLabel(type: string): string {
  const known = TYPES[type];
  if (known) return known.label;
  const humanised = (type ?? '').replace(/_/g, ' ').trim();
  return humanised.length > 0 ? humanised : 'Update';
}

/** Tone for an unrecognised type is 'mute' — neutral, never alarming. */
export function notificationTone(type: string): NotificationTone {
  return TYPES[type]?.tone ?? 'mute';
}

/**
 * The sentence a row leads with.
 *
 * `body` over `title`, because `title` is the category ("New Challenge") and
 * `body` is the sentence with the name in it ("Hannah Kim has challenged
 * you!"). `title` is NOT NULL, so there is always something to show.
 */
export function notificationHeadline(n: { title: string; body?: string | null }): string {
  const body = n.body?.trim();
  return body && body.length > 0 ? body : n.title;
}

function str(metadata: NotificationMetadata, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Where a row's affordance goes, or null when there is nowhere honest to send
 * the member. A button that lands on a 404 — or on a list page that does not
 * mention the thing the notification is about — is worse than no button, so
 * every branch below resolves to a route that exists in apps/player/src/app.
 *
 * `metadata` is expected to have already had `tournament_id` back-filled where
 * only `event_id` was written (see the page) — this function does not query.
 */
export function notificationAction(type: string, metadata: NotificationMetadata): NotificationAction | null {
  const challengeId = str(metadata, 'challenge_id');
  const tournamentId = str(metadata, 'tournament_id');
  const eventId = str(metadata, 'event_id');
  const announcementId = str(metadata, 'announcement_id');
  const sessionId = str(metadata, 'session_id');
  const sessionLink: NotificationAction = {
    href: sessionId && isUuid(sessionId) ? `/feed?s=${sessionId}` : '/feed',
    label: 'View',
  };

  // /challenges/[id] is the one page that shows a challenge, the result
  // submitted against it and any dispute on it — so every challenge-shaped
  // notification lands there.
  const challenge = (label: string): NotificationAction | null =>
    challengeId ? { href: `/challenges/${challengeId}`, label } : null;

  // The event page needs BOTH ids in the route. With only a tournament id the
  // tournament page is still the right, existing destination; with neither
  // there is nothing to link to.
  const event = (label: string): NotificationAction | null => {
    if (tournamentId && eventId) return { href: `/tournaments/${tournamentId}/events/${eventId}`, label };
    if (tournamentId) return { href: `/tournaments/${tournamentId}`, label };
    return null;
  };

  switch (type) {
    case 'challenge_received':
      return challenge('Reply');
    case 'result_pending':
      return challenge('Confirm');
    case 'challenge_accepted':
    case 'challenge_rejected':
    case 'challenge_expired':
    case 'challenge_cancelled':
    case 'result_confirmed':
    case 'dispute_opened':
    case 'dispute_resolved':
    case 'walkover_reported':
    case 'walkover_confirmed':
    case 'opponent_withdrew':
      return challenge('View');

    case 'rank_changed':
      // No per-rank page; /my-stats is where a member's standing lives.
      return { href: '/my-stats', label: 'View' };

    case 'session_reminder':
      // There is no page per session: the schedule on /feed is the
      // destination, scrolled to the session's card when the id is a real one.
      return sessionLink;

    case 'tournament_checkin_open':
      return tournamentId && eventId
        ? { href: `/tournaments/${tournamentId}/events/${eventId}/checkin`, label: 'Check in' }
        : { href: '/tournaments/checkin', label: 'Check in' };

    case 'tournament_bracket_published':
    case 'tournament_match_ready':
    case 'tournament_match_result':
    case 'tournament_event_completed':
      return event('View');

    case 'admin_alert':
      // Addressed to the exec and actioned in the admin console. Its metadata
      // is a match / walkover / flagged-player id, none of which the player app
      // has a page for. No button.
      return null;

    case 'general':
      // A carrier type: three unrelated producers use it (announcements,
      // tournament registration, challenge reminders) and only the metadata
      // says which. Read the metadata, not the type.
      if (announcementId) return { href: '/announcements', label: 'Read' };
      // A rejected e-transfer receipt, or an exec's reminder to pay (00248).
      if (str(metadata, 'kind') === 'fee_submission_rejected' || str(metadata, 'kind') === 'fee_payment_reminder') {
        return { href: '/membership', label: 'View' };
      }
      // A form response used this member's email (00283). The entry waits for
      // them, so the link goes to the page where they confirm it or say it
      // was not them. Checked before the tournament link, which the same row
      // also carries.
      if (str(metadata, 'kind') === 'registration_import_confirm') {
        const entryId = str(metadata, 'entry_id');
        return entryId && isUuid(entryId)
          ? { href: `/registrations/${entryId}`, label: 'Confirm' }
          : { href: '/notifications', label: 'View' };
      }
      if (challengeId) return { href: `/challenges/${challengeId}`, label: 'View' };
      if (tournamentId) return event('View');
      if (sessionId) return sessionLink;
      return null;

    default:
      // Unrecognised type. The row still renders — headline and detail line —
      // it just gets no affordance, because we do not know where one would go.
      return null;
  }
}

export type NotificationBucket = 'today' | 'week' | 'earlier';

const BUCKET_LABEL: Record<NotificationBucket, string> = {
  today: 'TODAY',
  week: 'EARLIER THIS WEEK',
  earlier: 'EARLIER',
};

/**
 * Which age bucket a notification falls in, in CLUB time.
 *
 * UTC would be wrong here in a way that is invisible in the morning and obvious
 * at night: from about 5pm in Vancouver the UTC date is already tomorrow, so a
 * notification that just arrived would be filed under a day that has not
 * started. clubDayKey/shiftDayKey (shared with the feed river) do the day
 * arithmetic on America/Vancouver calendar keys instead.
 *
 * The buckets are age, not read state — the mockup's first group reads "NEW",
 * but grouping by age while styling by read state means an unread row can sit
 * under yesterday, and calling that group "NEW" would be a lie.
 */
export function notificationBucket(createdAt: string, now: Date, timeZone: string): NotificationBucket {
  const todayKey = clubDayKey(now.toISOString(), timeZone);
  const key = clubDayKey(createdAt, timeZone);
  // `>=` rather than `===` so a row with a clock-skewed future timestamp still
  // lands at the top of the list instead of in "earlier".
  if (key >= todayKey) return 'today';
  if (key >= shiftDayKey(todayKey, -6)) return 'week';
  return 'earlier';
}

export interface NotificationSection<T> {
  key: NotificationBucket;
  label: string;
  items: T[];
}

/**
 * Groups notifications into age buckets, newest first, dropping empty buckets.
 * Sorting is done here rather than assumed so the grouping is correct whatever
 * order the caller's query returned.
 */
export function groupNotificationsByAge<T extends { created_at: string }>(
  items: T[],
  now: Date,
  timeZone: string,
): NotificationSection<T>[] {
  const buckets: Record<NotificationBucket, T[]> = { today: [], week: [], earlier: [] };

  for (const item of [...items].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    buckets[notificationBucket(item.created_at, now, timeZone)].push(item);
  }

  return (['today', 'week', 'earlier'] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: BUCKET_LABEL[key], items: buckets[key] }));
}

/**
 * The header eyebrow. Counting is the caller's job — it must come from an exact
 * COUNT over the whole table, not from the 50 rows this screen fetches, or a
 * member with 60 unread would read "50 UNREAD" here and 60 on the bell.
 */
export function unreadEyebrow(unreadCount: number): string {
  if (unreadCount <= 0) return 'ALL CAUGHT UP';
  return `${unreadCount} UNREAD`;
}

export interface NotificationKindCount {
  /** The micro-caps label, i.e. whatever notificationLabel() returned. */
  kind: string;
  /**
   * 'mute' when the rows behind this label do not agree on a tone.
   *
   * A label covers several types — "Challenge" is challenge_received (red),
   * challenge_accepted (win) and three mute ones — so painting a mixed group
   * with whichever tone happened to arrive first would be a claim about the
   * group that the rows do not make.
   */
  tone: NotificationTone;
  count: number;
}

/**
 * How many of each kind are on screen, commonest first.
 *
 * Deliberately counts the rows it is handed and nothing else: the caller's list
 * is capped at 50, so this is a summary OF THE LIST and never of the table. Any
 * surface showing it has to say so, or it reads as an all-time total.
 *
 * Ties break alphabetically so the order is stable between renders rather than
 * dependent on which notification happened to arrive first.
 */
export function summariseByKind(rows: Array<{ kind: string; tone: NotificationTone }>): NotificationKindCount[] {
  const seen = new Map<string, { tone: NotificationTone; mixed: boolean; count: number }>();

  for (const row of rows) {
    const entry = seen.get(row.kind);
    if (!entry) {
      seen.set(row.kind, { tone: row.tone, mixed: false, count: 1 });
      continue;
    }
    entry.count += 1;
    if (entry.tone !== row.tone) entry.mixed = true;
  }

  return [...seen.entries()]
    .map(([kind, entry]) => ({ kind, tone: entry.mixed ? ('mute' as const) : entry.tone, count: entry.count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}
