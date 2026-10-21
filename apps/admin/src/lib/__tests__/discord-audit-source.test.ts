import { describe, it, expect, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { logAdminAudit } from '../audit';
import { discordActorStore } from '../discord-actor-store';

function recordingClient() {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { error: null };
      },
    }),
  };
  return { inserted, client: client as never };
}

const entry = {
  actor_id: 'exec-1',
  action_type: 'session_archived',
  target_type: 'session',
  target_id: '11111111-2222-4333-8444-555555555555',
};

describe('logAdminAudit and Discord console commands', () => {
  it("stamps source 'discord' into new_value inside the actor store", async () => {
    const { inserted, client } = recordingClient();
    const original = { ...entry, new_value: { status: 'closed' } };
    await discordActorStore.run({ playerId: 'exec-1', discordUserId: '1234567890' }, () =>
      logAdminAudit(client, original),
    );
    expect(inserted[0]!.new_value).toEqual({ status: 'closed', source: 'discord' });
    expect(inserted[0]!.actor_id).toBe('exec-1');
    // The caller's object is left alone.
    expect(original.new_value).toEqual({ status: 'closed' });
  });

  it('gives a row with no new_value one that names the source', async () => {
    const { inserted, client } = recordingClient();
    await discordActorStore.run({ playerId: 'exec-1', discordUserId: '1234567890' }, () =>
      logAdminAudit(client, { ...entry, old_value: { name: 'x' } }),
    );
    expect(inserted[0]!.new_value).toEqual({ source: 'discord' });
  });

  it('changes nothing outside the store', async () => {
    const { inserted, client } = recordingClient();
    await logAdminAudit(client, { ...entry, new_value: { status: 'closed' } });
    expect(inserted[0]!.new_value).toEqual({ status: 'closed' });
  });
});
