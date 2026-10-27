import { describe, it, expect, vi } from 'vitest';
import {
  TRAP_NOTICE_FOOTER,
  TRAP_STATS_BUTTON,
  bumpTrapNotice,
  putUpTrapNotice,
  readTrapCount,
  trapNoticeMessage,
} from '../trap-notice.js';

// The trap channel warning keeps its count in itself: found among the pins
// by its count button, read off the button, and written back one higher.

type FakePin = {
  id: string;
  authorId: string;
  embed: { footer: string; description: string } | null;
  buttons: { customId: string; label: string }[];
};

function fakeApi(pins: FakePin[] | null) {
  return {
    getBotUserId: vi.fn(async () => 'bot'),
    listPinnedMessages: vi.fn(async () => pins),
    postMessage: vi.fn(async () => 'new'),
    editMessage: vi.fn(async (_channel: string, _id: string, _payload: unknown) => 'ok' as const),
    pinMessage: vi.fn(async () => 'ok' as const),
    deleteMessage: vi.fn(async () => true),
  };
}

const notice = (count: number, authorId = 'bot'): FakePin => ({
  id: 'warning',
  authorId,
  embed: { footer: '', description: '' },
  buttons: [{ customId: TRAP_STATS_BUTTON, label: `Soft bans: ${count}` }],
});

type Sent = { embeds: { title: string; description: string }[]; components: { components: { label: string; custom_id: string }[] }[] };
const label = (payload: unknown) => (payload as Sent).components[0]?.components[0]?.label;
const editedLabel = (api: ReturnType<typeof fakeApi>) => label((api.editMessage.mock.calls.at(-1) as unknown[])[2]);

describe('trap channel warning', () => {
  it('reads as the owner asked, with the count on a button that opens the stats', () => {
    const message = trapNoticeMessage('softban', 9);
    expect(message.embeds[0]?.title).toBe('DO NOT SEND MESSAGES IN THIS CHANNEL');
    expect(message.embeds[0]?.description).toContain('**a soft ban**');
    expect(message.components[0]?.components[0]).toMatchObject({ custom_id: TRAP_STATS_BUTTON, label: 'Soft bans: 9' });
    expect(readTrapCount('Soft bans: 9')).toBe(9);
    expect(readTrapCount('no number here')).toBe(0);
  });

  it('counts on from a warning pinned before the button, rewriting it in the new look', async () => {
    const old: FakePin = {
      id: 'warning',
      authorId: 'bot',
      embed: { footer: TRAP_NOTICE_FOOTER, description: 'Anything posted here is deleted.\n\n**Soft ban count:** 7' },
      buttons: [],
    };
    const api = fakeApi([old]);
    await bumpTrapNotice(api as never, 'trap', 'softban');
    expect(editedLabel(api)).toBe('Soft bans: 8');
  });

  it('is posted and pinned in a new trap channel at 0', async () => {
    const api = fakeApi([]);
    expect(await putUpTrapNotice(api as never, 'trap', 'softban')).toBe('ok');
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    expect(api.pinMessage).toHaveBeenCalledWith('trap', 'new', expect.any(String));
  });

  it('counts one more on the pinned warning, ignoring a lookalike someone else posted', async () => {
    const api = fakeApi([notice(50, 'someone'), notice(9)]);
    await bumpTrapNotice(api as never, 'trap', 'softban');
    expect(api.editMessage).toHaveBeenCalledWith('trap', 'warning', expect.anything());
    expect(editedLabel(api)).toBe('Soft bans: 10');
  });

  it('counts catches at the same moment one after another', async () => {
    let count = 3;
    const api = fakeApi(null);
    api.listPinnedMessages.mockImplementation(async () => [notice(count)]);
    api.editMessage.mockImplementation(async (_channel: string, _id: string, payload: unknown) => {
      count = readTrapCount(label(payload) ?? '');
      return 'ok' as const;
    });
    await Promise.all([bumpTrapNotice(api as never, 'trap', 'softban'), bumpTrapNotice(api as never, 'trap', 'softban')]);
    expect(count).toBe(5);
  });

  it('puts a deleted warning back at 1, but posts nothing when the pins cannot be read', async () => {
    const gone = fakeApi([]);
    await bumpTrapNotice(gone as never, 'trap', 'softban');
    expect(gone.postMessage).toHaveBeenCalledTimes(1);
    expect(label((gone.postMessage.mock.calls[0] as unknown[])[1])).toBe('Soft bans: 1');

    const unreadable = fakeApi(null);
    await bumpTrapNotice(unreadable as never, 'trap', 'softban');
    expect(unreadable.postMessage).not.toHaveBeenCalled();
  });
});

describe('trap stats button', () => {
  it('answers only its own custom_id', async () => {
    const { isTrapStatsButton } = await import('../commands.js');
    expect(isTrapStatsButton(TRAP_STATS_BUTTON)).toBe(true);
    expect(isTrapStatsButton('trap:statsx')).toBe(false);
    expect(isTrapStatsButton('guide:link')).toBe(false);
    expect(isTrapStatsButton(undefined)).toBe(false);
  });
});
