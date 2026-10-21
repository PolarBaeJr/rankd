import { describe, it, expect, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { getOrCreateCalendarFeedToken } from '../calendar-feed-token';

// A calendar_feed_tokens stub: `reads` answers successive maybeSingle() calls,
// `insertError` decides whether the insert is refused.
function fakeClient(reads: ({ token: string } | null)[], insertError: { message: string } | null = null) {
  const inserted: Record<string, unknown>[] = [];
  let readIndex = 0;
  const client = {
    from: (table: string) => {
      expect(table).toBe('calendar_feed_tokens');
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: reads[readIndex++] ?? null, error: null }),
        insert: async (row: Record<string, unknown>) => {
          inserted.push(row);
          return { error: insertError };
        },
      };
      return builder;
    },
  };
  return { client: client as never, inserted };
}

describe('getOrCreateCalendarFeedToken', () => {
  it('returns the existing token without writing', async () => {
    const { client, inserted } = fakeClient([{ token: 'existing' }]);
    expect(await getOrCreateCalendarFeedToken(client, 'p1')).toBe('existing');
    expect(inserted).toEqual([]);
  });

  it('creates a 48-hex token on first use', async () => {
    const { client, inserted } = fakeClient([null]);
    const token = await getOrCreateCalendarFeedToken(client, 'p1');
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(inserted).toEqual([{ player_id: 'p1', token }]);
  });

  it('returns the winner of a unique-violation race', async () => {
    const { client } = fakeClient([null, { token: 'raced' }], { message: 'duplicate key' });
    expect(await getOrCreateCalendarFeedToken(client, 'p1')).toBe('raced');
  });

  it('throws when the insert fails and there is still no row', async () => {
    const { client } = fakeClient([null, null], { message: 'boom' });
    await expect(getOrCreateCalendarFeedToken(client, 'p1')).rejects.toThrow('Could not create calendar feed link');
  });
});
