import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('server-only', () => ({}));

const flags: Record<string, boolean> = {};
vi.mock('../release-flags', () => ({
  getReleaseFlags: vi.fn(async () => new Proxy({}, { get: (_target, id: string) => flags[id] !== false })),
}));

import { defaultCutoff, followStartWithCheckinCutoff } from '../checkin-cutoff-follow';

interface EventRow { id: string; status: string; checkin_closes_at: string | null; external_event: boolean }

/** A client that serves the event read and records the one update. */
function fakeClient(events: EventRow[]) {
  const updates: { values: Record<string, unknown>; ids: string[] }[] = [];
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: async (_column: string, statuses: string[]) => ({
            data: events.filter((event) => statuses.includes(event.status)),
            error: null,
          }),
        }),
      }),
      update: (values: Record<string, unknown>) => ({
        in: async (_column: string, ids: string[]) => {
          updates.push({ values, ids });
          return { error: null };
        },
      }),
    }),
  };
  return { client: client as never, updates };
}

// 2026-11-15 at 18:00 club time is 01:00 UTC on the 16th (-07:00 all winter).
const SUNDAY = { start_date: '2026-11-15', starts_time: '18:00:00', checkin_closes_at: null };
const MONDAY = { start_date: '2026-11-16', starts_time: '18:00:00', checkin_closes_at: null };
const MONDAY_CUTOFF = '2026-11-17T00:45:00.000Z';
const SUNDAY_CUTOFF = '2026-11-16T00:45:00.000Z';

describe('the default check-in close follows the start', () => {
  beforeEach(() => {
    for (const key of Object.keys(flags)) delete flags[key];
  });

  it('works the default out 15 minutes before the start, club time', () => {
    expect(defaultCutoff(MONDAY)).toBe(MONDAY_CUTOFF);
    expect(defaultCutoff({ start_date: '2026-11-16', starts_time: null })).toBeNull();
  });

  it('moves a close still on the old default when the date moves', async () => {
    const { client, updates } = fakeClient([
      { id: 'mixed', status: 'registration', checkin_closes_at: '2026-11-17T00:45:00+00:00', external_event: false },
    ]);
    expect(await followStartWithCheckinCutoff(client, 't1', MONDAY, SUNDAY)).toBe(1);
    expect(updates).toEqual([{ values: { checkin_closes_at: SUNDAY_CUTOFF }, ids: ['mixed'] }]);
  });

  it('leaves a close an exec set by hand, and an event already drawn', async () => {
    const { client, updates } = fakeClient([
      { id: 'by-hand', status: 'registration', checkin_closes_at: '2026-11-17T00:30:00+00:00', external_event: false },
      { id: 'drawn', status: 'in_progress', checkin_closes_at: MONDAY_CUTOFF, external_event: false },
    ]);
    expect(await followStartWithCheckinCutoff(client, 't1', MONDAY, SUNDAY)).toBe(0);
    expect(updates).toEqual([]);
  });

  it('stamps the default once a start time is added, as creation would have', async () => {
    const { client, updates } = fakeClient([
      { id: 'mixed', status: 'checkin', checkin_closes_at: null, external_event: false },
    ]);
    const noTime = { ...MONDAY, starts_time: null };
    expect(await followStartWithCheckinCutoff(client, 't1', noTime, MONDAY)).toBe(1);
    expect(updates[0]?.values).toEqual({ checkin_closes_at: MONDAY_CUTOFF });
  });

  it('does nothing while the switch is off', async () => {
    flags.checkin_cutoff_default = false;
    const { client, updates } = fakeClient([
      { id: 'mixed', status: 'registration', checkin_closes_at: MONDAY_CUTOFF, external_event: false },
    ]);
    expect(await followStartWithCheckinCutoff(client, 't1', MONDAY, SUNDAY)).toBe(0);
    expect(updates).toEqual([]);
  });
});
