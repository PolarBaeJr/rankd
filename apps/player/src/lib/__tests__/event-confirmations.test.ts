import { describe, expect, it, vi, beforeEach } from 'vitest';

// The member's pending "Confirm your place" rows (00325): filtered by their own
// id, the deadline worked out in club time, and a missing table is nothing.

let result: { data: unknown; error: { code?: string; message: string } | null };
const filters: Array<[string, unknown]> = [];
const query = {
  select: () => query,
  eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
  in: () => query,
  then: (resolve: (v: unknown) => void) => resolve(result),
};
vi.mock('../supabase-server', () => ({ createServiceRoleClient: () => ({ from: () => query }) }));
const captureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureException }));

const { loadMyPendingConfirmations } = await import('../event-confirmations');

beforeEach(() => {
  filters.length = 0;
  captureException.mockClear();
});

describe('loadMyPendingConfirmations', () => {
  it('reads only the caller and puts the deadline 24 hours before a 10:00 start', async () => {
    result = {
      data: [{
        event_id: 'e1',
        status: 'pending',
        event: {
          id: 'e1', tournament_id: 't1', event_type: 'mens_singles', confirm_deadline_hours: 24,
          tournament: { name: 'Fall Open', start_date: '2026-11-21', starts_time: '10:00', status: 'published' },
        },
      }],
      error: null,
    };
    const rows = await loadMyPendingConfirmations('p1', 'e1');
    expect(filters).toEqual([['player_id', 'p1'], ['event_id', 'e1']]);
    expect(rows).toEqual([{ eventId: 'e1', tournamentId: 't1', tournamentName: 'Fall Open', eventType: 'mens_singles', deadlineAt: '2026-11-20T17:00:00.000Z' }]);
  });

  it('is empty before the migration and reports anything else', async () => {
    result = { data: null, error: { code: '42P01', message: 'missing' } };
    expect(await loadMyPendingConfirmations('p1')).toEqual([]);
    expect(captureException).not.toHaveBeenCalled();
    result = { data: null, error: { code: 'XX000', message: 'boom' } };
    expect(await loadMyPendingConfirmations('p1')).toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
