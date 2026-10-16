import { describe, expect, it } from 'vitest';
import {
  groupNotificationsByAge,
  notificationAction,
  notificationBucket,
  notificationHeadline,
  notificationLabel,
  notificationTone,
  summariseByKind,
  unreadEyebrow,
} from '@/lib/notification-rows';

const TZ = 'America/Vancouver';

/** Every value of the `notification_type` enum, mirrored BY HAND from
 *  00001_schema.sql — nothing cross-checks the two, so a migration that adds a
 *  value has to add it here as well. Until it does, the new type is covered
 *  only by the unrecognised-type cases below, which is the point of those. */
const ENUM_TYPES = [
  'challenge_received',
  'challenge_accepted',
  'challenge_rejected',
  'challenge_expired',
  'challenge_cancelled',
  'result_pending',
  'result_confirmed',
  'dispute_opened',
  'dispute_resolved',
  'rank_changed',
  'session_reminder',
  'walkover_reported',
  'walkover_confirmed',
  'opponent_withdrew',
  'admin_alert',
  'general',
  'tournament_bracket_published',
  'tournament_match_ready',
  'tournament_match_result',
  'tournament_event_completed',
  'tournament_checkin_open',
];

/** Routes that exist under apps/player/src/app. An action href must match one
 *  of these once its dynamic segments are collapsed. */
const PLAYER_ROUTES = [
  '/announcements',
  '/challenges',
  '/challenges/[id]',
  '/challenges/new',
  '/exec',
  '/feed',
  '/fees',
  '/leaderboard',
  '/leaderboard/[playerId]',
  '/membership',
  '/my-stats',
  '/notifications',
  '/registrations/[entryId]',
  '/settings',
  '/tournaments',
  '/tournaments/[id]',
  '/tournaments/[id]/events/[eventId]',
  '/tournaments/[id]/events/[eventId]/checkin',
  '/tournaments/checkin',
];

/** Collapses concrete ids back to their route pattern so an href can be checked
 *  against the route table above. */
function routePattern(href: string): string {
  // The query string is not part of the route.
  const parts = (href.split('?')[0] ?? href).split('/');
  if (parts[1] === 'challenges' && parts[2]) return '/challenges/[id]';
  if (parts[1] === 'leaderboard' && parts[2]) return '/leaderboard/[playerId]';
  if (parts[1] === 'registrations' && parts[2]) return '/registrations/[entryId]';
  if (parts[1] === 'tournaments' && parts[2] && parts[2] !== 'checkin') {
    if (parts[3] === 'events' && parts[4]) {
      return parts[5] === 'checkin'
        ? '/tournaments/[id]/events/[eventId]/checkin'
        : '/tournaments/[id]/events/[eventId]';
    }
    return '/tournaments/[id]';
  }
  return parts.join('/');
}

describe('notificationLabel / notificationTone', () => {
  it('names and tones every value of the notification_type enum', () => {
    for (const type of ENUM_TYPES) {
      expect(notificationLabel(type), type).not.toBe(type.replace(/_/g, ' '));
      expect(['red', 'win', 'gold', 'mute'], type).toContain(notificationTone(type));
    }
  });

  it('humanises an unrecognised type rather than dropping the row', () => {
    expect(notificationLabel('season_rolled_over')).toBe('season rolled over');
    expect(notificationTone('season_rolled_over')).toBe('mute');
  });

  it('never returns an empty label, even for junk', () => {
    expect(notificationLabel('')).toBe('Update');
    expect(notificationLabel('   ')).toBe('Update');
    expect(notificationLabel(undefined as unknown as string)).toBe('Update');
  });
});

describe('notificationHeadline', () => {
  it('prefers the body, which is the sentence with the name in it', () => {
    expect(notificationHeadline({ title: 'New Challenge', body: 'Hannah Kim has challenged you!' })).toBe(
      'Hannah Kim has challenged you!',
    );
  });

  it('falls back to the title when there is no body', () => {
    expect(notificationHeadline({ title: 'New Challenge', body: null })).toBe('New Challenge');
    expect(notificationHeadline({ title: 'New Challenge', body: '  ' })).toBe('New Challenge');
    expect(notificationHeadline({ title: 'New Challenge' })).toBe('New Challenge');
  });
});

describe('notificationAction', () => {
  it('sends every challenge-shaped type to the challenge page', () => {
    const meta = { challenge_id: 'c1' };
    for (const type of [
      'challenge_received',
      'challenge_accepted',
      'challenge_rejected',
      'challenge_expired',
      'challenge_cancelled',
      'result_pending',
      'result_confirmed',
      'dispute_opened',
      'dispute_resolved',
      'walkover_reported',
      'walkover_confirmed',
      'opponent_withdrew',
    ]) {
      expect(notificationAction(type, meta)?.href, type).toBe('/challenges/c1');
    }
  });

  it('labels the two types that ask for something with the thing they ask for', () => {
    expect(notificationAction('challenge_received', { challenge_id: 'c1' })?.label).toBe('Reply');
    expect(notificationAction('result_pending', { challenge_id: 'c1' })?.label).toBe('Confirm');
    expect(notificationAction('challenge_accepted', { challenge_id: 'c1' })?.label).toBe('View');
  });

  it('drops the action when the id it needs is missing rather than linking to a broken route', () => {
    expect(notificationAction('challenge_received', {})).toBeNull();
    expect(notificationAction('challenge_received', null)).toBeNull();
    expect(notificationAction('result_pending', { challenge_id: 42 })).toBeNull();
    expect(notificationAction('tournament_match_result', { event_id: 'e1' })).toBeNull();
  });

  it('gives admin_alert no action — the player app has no page for what it points at', () => {
    expect(notificationAction('admin_alert', { match_id: 'm1' })).toBeNull();
    expect(notificationAction('admin_alert', { walkover_id: 'w1' })).toBeNull();
    expect(notificationAction('admin_alert', { flagged_player_id: 'p1', no_show_count: 3 })).toBeNull();
  });

  it('reads general from its metadata, since three producers share the type', () => {
    expect(notificationAction('general', { announcement_id: 'a1' })).toEqual({
      href: '/announcements',
      label: 'Read',
    });
    expect(notificationAction('general', { challenge_id: 'c1' })?.href).toBe('/challenges/c1');
    expect(notificationAction('general', { tournament_id: 't1' })?.href).toBe('/tournaments/t1');
    expect(notificationAction('general', { session_id: 's1' })?.href).toBe('/feed');
    expect(notificationAction('general', {})).toBeNull();
  });

  it('sends fee notices to /membership', () => {
    expect(notificationAction('general', { kind: 'fee_submission_rejected', fee_submission_id: 'f1' })).toEqual({
      href: '/membership',
      label: 'View',
    });
    expect(notificationAction('general', { kind: 'fee_payment_reminder' })).toEqual({
      href: '/membership',
      label: 'View',
    });
    expect(notificationAction('general', { kind: 'something_else' })).toBeNull();
  });

  it('sends a form entry waiting for its member to the confirm page, never on a bad id', () => {
    const entryId = '11111111-2222-4333-8444-555555555555';
    expect(
      notificationAction('general', {
        kind: 'registration_import_confirm',
        entry_id: entryId,
        tournament_id: 't1',
        event_id: 'e1',
      }),
    ).toEqual({ href: `/registrations/${entryId}`, label: 'Confirm' });
    expect(
      notificationAction('general', { kind: 'registration_import_confirm', entry_id: '../admin' }),
    ).toEqual({ href: '/notifications', label: 'View' });
  });

  it('uses the event route when both ids are present and the tournament route when only one is', () => {
    expect(notificationAction('tournament_bracket_published', { tournament_id: 't1', event_id: 'e1' })?.href).toBe(
      '/tournaments/t1/events/e1',
    );
    expect(notificationAction('tournament_event_completed', { tournament_id: 't1' })?.href).toBe('/tournaments/t1');
  });

  it('points check-in at the event check-in screen, falling back to the scanner', () => {
    expect(notificationAction('tournament_checkin_open', { tournament_id: 't1', event_id: 'e1' })).toEqual({
      href: '/tournaments/t1/events/e1/checkin',
      label: 'Check in',
    });
    expect(notificationAction('tournament_checkin_open', {})?.href).toBe('/tournaments/checkin');
  });

  it('sends the standing-shaped types to the pages that show them', () => {
    expect(notificationAction('rank_changed', {})?.href).toBe('/my-stats');
    expect(notificationAction('session_reminder', { session_id: 's1' })?.href).toBe('/feed');
  });

  it('scrolls the schedule to the session when the id is a real uuid', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    expect(notificationAction('session_reminder', { session_id: id })?.href).toBe(`/feed?s=${id}`);
    expect(notificationAction('general', { session_id: id })?.href).toBe(`/feed?s=${id}`);
  });

  it('gives an unrecognised type no action and does not throw', () => {
    expect(notificationAction('season_rolled_over', { challenge_id: 'c1' })).toBeNull();
    expect(notificationAction('', null)).toBeNull();
    expect(notificationAction('anything', { nested: { deep: true } })).toBeNull();
  });

  it('only ever links to a route that exists', () => {
    const metadatas = [
      {},
      { challenge_id: 'c1' },
      { announcement_id: 'a1' },
      { session_id: 's1' },
      { session_id: '33333333-3333-4333-8333-333333333333' },
      { tournament_id: 't1' },
      { tournament_id: 't1', event_id: 'e1' },
      { event_id: 'e1' },
      { match_id: 'm1', challenge_id: 'c1' },
      { kind: 'fee_submission_rejected' },
      { kind: 'fee_payment_reminder' },
      { kind: 'registration_import_confirm', entry_id: '11111111-2222-4333-8444-555555555555' },
    ];
    for (const type of [...ENUM_TYPES, 'a_type_nobody_has_written_yet']) {
      for (const metadata of metadatas) {
        const action = notificationAction(type, metadata);
        if (!action) continue;
        expect(PLAYER_ROUTES, `${type} ${JSON.stringify(metadata)} -> ${action.href}`).toContain(
          routePattern(action.href),
        );
        expect(action.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('notificationBucket', () => {
  // 2026-08-11T02:00Z is 2026-08-10 at 19:00 in Vancouver (PDT, UTC-7). In UTC
  // "today" would already be the 11th, so a notification stamped an hour ago
  // would be filed under a day that has not begun yet.
  const eveningInVancouver = new Date('2026-08-11T02:00:00Z');

  it('treats a Vancouver evening as still being today', () => {
    expect(notificationBucket('2026-08-11T01:00:00Z', eveningInVancouver, TZ)).toBe('today');
    expect(notificationBucket('2026-08-10T16:00:00Z', eveningInVancouver, TZ)).toBe('today');
  });

  it('files yesterday and the rest of the week under the week bucket', () => {
    // 2026-08-09 12:00 Vancouver.
    expect(notificationBucket('2026-08-09T19:00:00Z', eveningInVancouver, TZ)).toBe('week');
    // 2026-08-04 is exactly six club days before 2026-08-10 — still the week.
    expect(notificationBucket('2026-08-04T19:00:00Z', eveningInVancouver, TZ)).toBe('week');
  });

  it('files anything older than six club days under earlier', () => {
    expect(notificationBucket('2026-08-03T19:00:00Z', eveningInVancouver, TZ)).toBe('earlier');
    expect(notificationBucket('2025-01-01T19:00:00Z', eveningInVancouver, TZ)).toBe('earlier');
  });

  it('holds up across the winter offset too', () => {
    // 2026-12-05T01:00Z is 2026-12-04 at 17:00 in Vancouver (PST, UTC-8).
    const winterEvening = new Date('2026-12-05T01:00:00Z');
    expect(notificationBucket('2026-12-05T00:30:00Z', winterEvening, TZ)).toBe('today');
    expect(notificationBucket('2026-12-03T20:00:00Z', winterEvening, TZ)).toBe('week');
  });

  it('keeps a clock-skewed future row at the top rather than in earlier', () => {
    expect(notificationBucket('2026-08-12T19:00:00Z', eveningInVancouver, TZ)).toBe('today');
  });
});

describe('groupNotificationsByAge', () => {
  const now = new Date('2026-08-11T02:00:00Z'); // 2026-08-10 19:00 Vancouver

  it('orders newest first and drops empty buckets', () => {
    const sections = groupNotificationsByAge(
      [
        { created_at: '2026-08-09T19:00:00Z', id: 'b' },
        { created_at: '2026-08-11T01:00:00Z', id: 'a' },
      ],
      now,
      TZ,
    );
    expect(sections.map((s) => s.key)).toEqual(['today', 'week']);
    expect(sections.map((s) => s.label)).toEqual(['TODAY', 'EARLIER THIS WEEK']);
    expect(sections[0]?.items.map((i) => i.id)).toEqual(['a']);
  });

  it('sorts within a bucket rather than trusting the caller', () => {
    const sections = groupNotificationsByAge(
      [
        { created_at: '2026-08-10T18:00:00Z', id: 'older' },
        { created_at: '2026-08-11T01:00:00Z', id: 'newer' },
      ],
      now,
      TZ,
    );
    expect(sections[0]?.items.map((i) => i.id)).toEqual(['newer', 'older']);
  });

  it('interleaves read and unread — the grouping is age, not read state', () => {
    const sections = groupNotificationsByAge(
      [
        { created_at: '2026-08-11T01:00:00Z', id: 'read', read_flag: true },
        { created_at: '2026-08-11T00:00:00Z', id: 'unread', read_flag: false },
      ],
      now,
      TZ,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.items.map((i) => i.id)).toEqual(['read', 'unread']);
  });

  it('returns nothing for an empty list', () => {
    expect(groupNotificationsByAge([], now, TZ)).toEqual([]);
  });
});

describe('unreadEyebrow', () => {
  it('counts', () => {
    expect(unreadEyebrow(4)).toBe('4 UNREAD');
    expect(unreadEyebrow(1)).toBe('1 UNREAD');
  });

  it('says so when there is nothing to read', () => {
    expect(unreadEyebrow(0)).toBe('ALL CAUGHT UP');
    expect(unreadEyebrow(-1)).toBe('ALL CAUGHT UP');
  });
});

describe('summariseByKind', () => {
  it('counts each kind, commonest first', () => {
    expect(
      summariseByKind([
        { kind: 'Session', tone: 'mute' },
        { kind: 'Challenge', tone: 'red' },
        { kind: 'Challenge', tone: 'red' },
        { kind: 'Challenge', tone: 'red' },
      ]),
    ).toEqual([
      { kind: 'Challenge', tone: 'red', count: 3 },
      { kind: 'Session', tone: 'mute', count: 1 },
    ]);
  });

  it('breaks ties alphabetically so the order is stable between renders', () => {
    expect(
      summariseByKind([
        { kind: 'Tournament', tone: 'gold' },
        { kind: 'Alert', tone: 'red' },
        { kind: 'Result', tone: 'gold' },
      ]).map((k) => k.kind),
    ).toEqual(['Alert', 'Result', 'Tournament']);
  });

  it('mutes a kind whose rows disagree about tone rather than picking the first', () => {
    // "Challenge" covers challenge_received (red) and challenge_accepted (win).
    // Neither is the colour of the group.
    expect(
      summariseByKind([
        { kind: 'Challenge', tone: 'red' },
        { kind: 'Challenge', tone: 'win' },
      ]),
    ).toEqual([{ kind: 'Challenge', tone: 'mute', count: 2 }]);
  });

  it('keeps a unanimous tone however many rows share it', () => {
    expect(
      summariseByKind([
        { kind: 'Tournament', tone: 'gold' },
        { kind: 'Tournament', tone: 'gold' },
        { kind: 'Tournament', tone: 'gold' },
      ]),
    ).toEqual([{ kind: 'Tournament', tone: 'gold', count: 3 }]);
  });

  it('summarises nothing as nothing', () => {
    expect(summariseByKind([])).toEqual([]);
  });
});
