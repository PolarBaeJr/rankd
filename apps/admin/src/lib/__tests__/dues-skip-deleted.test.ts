import { describe, it, expect, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { DELETED_PLAYER_EMAIL_PATTERN, loadDuesRoster } from '../dues-roster';
import { loadOutstandingMembers } from '../fee-submissions';
import { getOutstandingClubFees } from '../fees-outstanding';

// A completed deletion switches the account off but leaves its status, so on
// prod three "Deleted Player" rows sat on the dues list as Unpaid
// (2026-10-24). Each list of who owes dues must ask the database to skip them;
// this records every call made on the players query and checks it did.

type Call = { method: string; args: unknown[] };

function recordingClient() {
  const playerQueries: Call[][] = [];
  const client = {
    from(table: string) {
      const calls: Call[] = [];
      if (table === 'players') playerQueries.push(calls);
      const builder: Record<string, unknown> = new Proxy(
        {},
        {
          get(_target, prop: string) {
            // Awaiting the builder resolves to an empty result.
            if (prop === 'then') {
              return (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
            }
            return (...args: unknown[]) => {
              calls.push({ method: prop, args });
              return builder;
            };
          },
        },
      );
      return builder;
    },
    storage: { from: () => ({}) },
  };
  return { client, playerQueries };
}

function skipsDeleted(calls: Call[]): boolean {
  return calls.some(
    (call) =>
      call.method === 'not' &&
      call.args[0] === 'email' &&
      call.args[1] === 'like' &&
      call.args[2] === DELETED_PLAYER_EMAIL_PATTERN,
  );
}

const season = {
  id: 'season-1',
  name: 'Fall',
  start_date: '2026-09-01',
  end_date: '2026-12-15',
  competitive_fee_cents: 4000,
  recreational_fee_cents: 3000,
};

describe('every list of who owes dues skips deleted members', () => {
  it('matches the email a deletion leaves behind', () => {
    // Mirrors anonymizedPlayerFields in supabase/functions/_shared/anonymize.ts.
    const left = 'deleted+f7ab3f91-ace8-40b5-8697-ad91831d7d02@deleted.invalid';
    const asRegex = new RegExp(`^${DELETED_PLAYER_EMAIL_PATTERN.replace(/[+.]/g, '\\$&').replace('%', '.*')}$`);
    expect(asRegex.test(left)).toBe(true);
    expect(asRegex.test('someone@sfu.ca')).toBe(false);
  });

  it('the dues roster on /fees', async () => {
    const { client, playerQueries } = recordingClient();
    await loadDuesRoster(client as never, season);
    expect(playerQueries.length).toBeGreaterThan(0);
    expect(playerQueries.every(skipsDeleted)).toBe(true);
  });

  it('the outstanding members list', async () => {
    const { client, playerQueries } = recordingClient();
    await loadOutstandingMembers(client as never, season as never, new Date('2026-10-24T00:00:00Z'));
    expect(playerQueries.length).toBeGreaterThan(0);
    expect(skipsDeleted(playerQueries[0]!)).toBe(true);
  });

  it('the outstanding total', async () => {
    const { client, playerQueries } = recordingClient();
    await getOutstandingClubFees(client as never, season as never);
    expect(playerQueries.length).toBeGreaterThan(0);
    expect(playerQueries.every(skipsDeleted)).toBe(true);
  });
});
