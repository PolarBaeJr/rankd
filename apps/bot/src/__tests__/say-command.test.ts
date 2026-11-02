import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /say posts arbitrary words in the club's own voice, and Discord has no undo.
//
// THREE THINGS ARE THE WHOLE SAFETY MODEL, and none of them announces itself.
//
// Mentions are OFF unless the exec asked for them, and an unreadable custom_id
// resolves to off — a message that should have pinged and did not is a
// follow-up, a ping nobody asked for has already buzzed every phone in the
// server and cannot be taken back.
//
// The channel survives only in the custom_id, because a modal submit echoes
// back nothing else from the first interaction. Lose it and the words go
// nowhere.
//
// And every use writes an audit entry QUOTING the message, so a message that is
// later deleted is still readable. A bot that can speak for the club with no
// record of who moved its mouth is the thing worth not building.

const { postMessage, postAuditEntry, loadConfig } = vi.hoisted(() => ({
  postMessage: vi.fn(),
  postAuditEntry: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    postMessage = postMessage;
  },
}));
vi.mock('../audit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audit.js')>()),
  postAuditEntry,
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig,
}));

import { COMMAND_DEFINITIONS, dispatch, handleSayModal, isSayModal } from '../commands.js';
import { buildAuditEmbed } from '../audit.js';

// `permissions` is what Discord computed for the caller, recomputed on the
// submit. '8' is ADMINISTRATOR, which is how a small server usually runs.
const CONTEXT = {
  discordUserId: '424242',
  guildId: 'g1',
  channelId: 'here-1',
  permissions: '8',
};

interface Modal {
  type: number;
  data: { custom_id?: string; title?: string; content?: string; flags?: number; components?: unknown[] };
}

function open(options: { name: string; value: string | boolean }[] = []): Promise<Modal> {
  return dispatch('say', options as never, CONTEXT) as unknown as Promise<Modal>;
}

function body(text: string) {
  return [{ type: 1, components: [{ type: 4, custom_id: 'body', value: text }] }];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'tok';
  postMessage.mockResolvedValue('m1');
  postAuditEntry.mockResolvedValue(true);
  loadConfig.mockResolvedValue({ registry: new Map([['g1', {}]]), auditChannelId: 'audit-1' });
});

afterEach(() => {
  delete process.env.DISCORD_BOT_TOKEN;
});

describe('/say command definition', () => {
  const def = COMMAND_DEFINITIONS.find((c) => c.name === 'say');

  it('is exec-only and refuses DMs', () => {
    expect(def).toBeDefined();
    // Same flag /announce carries. Discord's command-list filter is not
    // authorization, but it is the gate this command deliberately relies on:
    // there is no app call here to hang a capability check on.
    expect(def?.default_member_permissions).toBe(
      COMMAND_DEFINITIONS.find((c) => c.name === 'announce')?.default_member_permissions
    );
    expect(def?.dm_permission).toBe(false);
  });

  it('offers only text and announcement channels', () => {
    const channel = def?.options?.find((o) => o.name === 'channel');
    // A category or voice channel is offered by an unrestricted picker and then
    // 400s on the post.
    expect(channel?.channel_types).toEqual([0, 5]);
    expect(channel?.required).toBeFalsy();
  });
});

describe('opening the modal', () => {
  it('defaults to the channel the command was typed in', async () => {
    const modal = await open();
    expect(modal.type).toBe(9);
    expect(modal.data.custom_id).toBe('say:here-1:0');
  });

  it('uses the picked channel when there is one', async () => {
    const modal = await open([{ name: 'channel', value: 'chosen-9' }]);
    expect(modal.data.custom_id).toBe('say:chosen-9:0');
  });

  it('carries the ping flag across the gap', async () => {
    const modal = await open([{ name: 'ping', value: true }]);
    expect(modal.data.custom_id).toBe('say:here-1:1');
  });

  it('refuses rather than opening a modal with nowhere to post', async () => {
    const modal = (await dispatch('say', [] as never, {
      discordUserId: '1',
      guildId: 'g1',
      channelId: null,
    })) as unknown as Modal;
    expect(modal.type).toBe(4);
    expect(modal.data.flags).toBe(64);
  });

  it('recognises its own modal and no one else\'s', () => {
    expect(isSayModal('say:c1:0')).toBe(true);
    expect(isSayModal('announce:info:000')).toBe(false);
    expect(isSayModal(undefined)).toBe(false);
  });
});

describe('submitting the modal', () => {
  it('posts the words verbatim with mentions silenced', async () => {
    await handleSayModal('say:c1:0', body('  Doors open at 7. @everyone  '), CONTEXT);
    expect(postMessage).toHaveBeenCalledWith('c1', {
      content: 'Doors open at 7. @everyone',
      allowed_mentions: { parse: [] },
    });
  });

  it('opens mentions up only when the exec asked', async () => {
    // Asking means @everyone, on purpose: notifying the club is what the
    // command is for, and who may ask is settled before this point by the
    // integration allowlist and the permission mask.
    await handleSayModal('say:c1:1', body('gym is closed'), CONTEXT);
    expect(postMessage.mock.calls[0][1]).toMatchObject({
      allowed_mentions: { parse: ['users', 'roles', 'everyone'] },
    });
  });

  it('refuses a submit carrying no permissions, and posts nothing', async () => {
    // DEFENCE IN DEPTH, not the gate: Discord's allowlist decides who sees the
    // command and the Ed25519 check makes a forged submit impossible. What this
    // catches is a mask Discord recomputed to nothing, which is what an exec
    // who lost access while the modal sat open now arrives with.
    const reply = await handleSayModal('say:c1:0', body('hello'), {
      ...CONTEXT,
      permissions: null,
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect((reply as Modal).data.content).toContain('Nothing was posted');
  });

  it('fails closed on a custom_id it cannot read', async () => {
    // A build that changed the format under a modal somebody still has open.
    await handleSayModal('say:c1:', body('hello'), CONTEXT);
    expect(postMessage.mock.calls[0][1]).toMatchObject({ allowed_mentions: { parse: [] } });
  });

  it('records who said it, where, and what', async () => {
    await handleSayModal('say:c1:1', body('hello club'), CONTEXT);
    expect(postAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      'audit-1',
      expect.objectContaining({
        kind: 'say',
        discordUserId: '424242',
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm1',
        body: 'hello club',
        pinged: true,
      })
    );
  });

  it('still reports success when the audit entry cannot be written', async () => {
    // The message is already out. Telling the exec it was not would be false,
    // and they would post it twice.
    loadConfig.mockRejectedValue(new Error('no config'));
    const reply = await handleSayModal('say:c1:0', body('hello'), CONTEXT);
    expect((reply as Modal).data.content).toContain('Posted');
  });

  it('says nothing was posted when Discord refuses', async () => {
    postMessage.mockResolvedValue(null);
    const reply = await handleSayModal('say:c1:0', body('hello'), CONTEXT);
    expect((reply as Modal).data.content).toContain('Nothing was posted');
    expect(postAuditEntry).not.toHaveBeenCalled();
  });

  it('refuses an empty message', async () => {
    const reply = await handleSayModal('say:c1:0', body('   '), CONTEXT);
    expect(postMessage).not.toHaveBeenCalled();
    expect((reply as Modal).data.content).toContain('nothing to post');
  });
});

describe('the audit entry', () => {
  const NOW = new Date('2026-09-09T12:00:00.000Z');

  it('quotes every line, so a multi-line message cannot break out of the quote', () => {
    const embed = buildAuditEmbed(
      {
        kind: 'say',
        discordUserId: '424242',
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm1',
        body: 'line one\n@everyone line two',
        pinged: false,
      },
      NOW
    );
    expect(embed.description).toContain('> line one\n> @everyone line two');
    expect(embed.fields?.[0].value).toBe('https://discord.com/channels/g1/c1/m1');
  });

  it('says when mentions were allowed', () => {
    const embed = buildAuditEmbed(
      { kind: 'say', discordUserId: '1', guildId: 'g1', channelId: 'c1', messageId: 'm1', body: 'hi', pinged: true },
      NOW
    );
    expect(embed.description).toContain('with mentions allowed');
  });

  it('states the remainder rather than truncating silently', () => {
    const long = 'x'.repeat(2000);
    const embed = buildAuditEmbed(
      { kind: 'say', discordUserId: '1', guildId: 'g1', channelId: 'c1', messageId: 'm1', body: long, pinged: false },
      NOW
    );
    expect(embed.description).toContain('2000 characters were posted');
  });

  it('omits the jump link rather than building a broken one', () => {
    const embed = buildAuditEmbed(
      { kind: 'say', discordUserId: '1', guildId: null, channelId: 'c1', messageId: 'm1', body: 'hi', pinged: false },
      NOW
    );
    expect(embed.fields).toBeUndefined();
  });
});
