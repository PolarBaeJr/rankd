import { describe, it, expect } from 'vitest';
import { buildCalendarPageData, type CalendarPageInput } from '../calendar-page-data';

const BASE: CalendarPageInput = {
  sessions: [
    { id: 's1', name: 'Club night', date: '2026-10-20', start_time: '19:00:00', status: 'open', season_id: 'fall' },
    { id: 's2', name: null, date: '2026-10-06', start_time: null, status: 'closed', season_id: 'fall' },
  ],
  clubEvents: [
    {
      id: 'e1',
      title: 'Pub night',
      kind: 'social',
      location: null,
      starts_at: '2026-10-22T02:00:00Z',
      ends_at: null,
      status: 'published',
    },
  ],
  tournaments: [
    { id: 't1', name: 'Fall Open', start_date: '2026-10-24', end_date: '2026-10-25', status: 'active', suspended_at: null },
  ],
  activeSeason: { id: 'fall', start_date: '2026-09-08', end_date: '2026-12-05' },
  todayISO: '2026-10-19',
  isMineSession: (id) => id === 's1',
  signedUpEvents: new Set(['e1']),
  sessionHref: (id) => (id === 's1' ? `/feed?s=${id}` : null),
  sessionsOn: true,
  eventsOn: true,
  tournamentsOn: true,
};

describe('buildCalendarPageData', () => {
  it('puts every kind on the grid in day order, tournaments one item per day', () => {
    const { calendarItems } = buildCalendarPageData(BASE);
    expect(calendarItems.map((i) => i.key)).toEqual([
      'session:s2',
      'session:s1',
      'club_event:e1',
      'tournament:t1:2026-10-24',
      'tournament:t1:2026-10-25',
    ]);
  });

  it('links a session only where the page says it has somewhere to go', () => {
    const { calendarItems } = buildCalendarPageData(BASE);
    const byKey = new Map(calendarItems.map((i) => [i.key, i]));
    expect(byKey.get('session:s1')?.href).toBe('/feed?s=s1');
    expect(byKey.get('session:s2')?.href).toBeNull();
    expect(byKey.get('club_event:e1')?.href).toBe('/events/e1');
  });

  it('keeps the feed behaviour when handed an in-page anchor', () => {
    const { calendarItems } = buildCalendarPageData({ ...BASE, sessionHref: (id) => `#session-${id}` });
    expect(calendarItems.find((i) => i.id === 's1')?.href).toBe('#session-s1');
  });

  it('marks what is mine', () => {
    const { calendarItems } = buildCalendarPageData(BASE);
    expect(calendarItems.filter((i) => i.mine).map((i) => i.id)).toEqual(['s1', 'e1']);
  });

  it('bounds the months to the term and opens on this month', () => {
    const { monthKeys, months, initialIndex } = buildCalendarPageData(BASE);
    expect(monthKeys).toEqual(['2026-09', '2026-10', '2026-11', '2026-12']);
    expect(months).toHaveLength(4);
    expect(monthKeys[initialIndex]).toBe('2026-10');
  });

  it('names only the switched-on kinds in the legend', () => {
    expect(buildCalendarPageData(BASE).legend).toEqual(['open', 'closed', 'club', 'tournament']);
    expect(buildCalendarPageData({ ...BASE, sessionsOn: false, tournamentsOn: false }).legend).toEqual(['club']);
  });
});
