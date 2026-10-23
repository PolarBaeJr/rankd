import { describe, it, expect, vi } from 'vitest';
import { TRAP_NOTICE_FOOTER, bumpTrapNotice, putUpTrapNotice, readTrapCount, trapNoticeEmbed } from '../trap-notice.js';

// The trap channel warning keeps its count in itself: found among the pins
// by its footer, read, and written back one higher.

function fakeApi(pins: { id: string; authorId: string; embed: { footer: string; description: string } | null }[] | null) {
  return {
    getBotUserId: vi.fn(async () => 'bot'),
    listPinnedMessages: vi.fn(async () => pins),
    postMessage: vi.fn(async () => 'new'),
    editMessage: vi.fn(async (_channel: string, _id: string, _payload: unknown) => 'ok' as const),
    pinMessage: vi.fn(async () => 'ok' as const),
    deleteMessage: vi.fn(async () => true),
  };
}

const notice = (count: number, authorId = 'bot') => ({
  id: 'warning',
  authorId,
  embed: { footer: TRAP_NOTICE_FOOTER, description: trapNoticeEmbed('softban', count).description ?? '' },
});

const editedTo = (api: ReturnType<typeof fakeApi>) =>
  ((api.editMessage.mock.calls.at(-1) as unknown[])[2] as { embeds: { title: string; description: string }[] }).embeds[0];

describe('trap channel warning', () => {
  it('reads as the owner asked, and its count reads back', () => {
    const embed = trapNoticeEmbed('softban', 9);
    expect(embed.title).toBe('Do not type in this chat or you will be soft banned');
    expect(embed.description).toContain('**Soft ban count:** 9');
    expect(readTrapCount(embed.description ?? '')).toBe(9);
    expect(readTrapCount('no number here')).toBe(0);
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
    expect(editedTo(api)?.description).toContain('**Soft ban count:** 10');
  });

  it('counts catches at the same moment one after another', async () => {
    let count = 3;
    const api = fakeApi(null);
    api.listPinnedMessages.mockImplementation(async () => [notice(count)]);
    api.editMessage.mockImplementation(async (_channel: string, _id: string, payload: unknown) => {
      count = readTrapCount((payload as { embeds: { description: string }[] }).embeds[0]?.description ?? '');
      return 'ok' as const;
    });
    await Promise.all([bumpTrapNotice(api as never, 'trap', 'softban'), bumpTrapNotice(api as never, 'trap', 'softban')]);
    expect(count).toBe(5);
  });

  it('puts a deleted warning back at 1, but posts nothing when the pins cannot be read', async () => {
    const gone = fakeApi([]);
    await bumpTrapNotice(gone as never, 'trap', 'softban');
    expect(gone.postMessage).toHaveBeenCalledTimes(1);
    const posted = (gone.postMessage.mock.calls[0] as unknown[])[1] as { embeds: { description: string }[] };
    expect(posted.embeds[0]?.description).toContain('**Soft ban count:** 1');

    const unreadable = fakeApi(null);
    await bumpTrapNotice(unreadable as never, 'trap', 'softban');
    expect(unreadable.postMessage).not.toHaveBeenCalled();
  });
});
