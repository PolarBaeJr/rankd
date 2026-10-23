// The warning a trap channel carries (auto mod, scam-guard.ts), and its count.
//
// When a channel is made a trap the bot posts and pins a warning there, so a
// person reads it before they post. Each account auto mod catches there bumps
// the count on that warning.
//
// THE COUNT LIVES IN THE MESSAGE. No table: the warning is found again among
// the channel's pins by its footer, the number read off it and written back
// one higher. A restart forgets nothing, and a warning someone deleted is
// simply posted again at 1. Bumps for one channel run one after another, so
// two catches at once cannot both write the same number.

import type { AutomodAction } from './api.js';
import type { DiscordApi, RoleCallResult } from './discord-api.js';
import type { Embed } from './audit.js';

/** How the bot recognises its own warning among the pins. */
export const TRAP_NOTICE_FOOTER = 'Auto mod trap channel';

const COLOR_WARNING = 0xe74c3c;

/** What a post here gets, in the warning's words, and what its count counts. */
const CONSEQUENCE: Record<AutomodAction, { gets: string; counted: string }> = {
  softban: { gets: 'soft banned', counted: 'Soft ban count' },
  timeout_then_softban: { gets: 'timed out, then soft banned', counted: 'Caught' },
  timeout: { gets: 'timed out', counted: 'Timeout count' },
  flag: { gets: 'reported to the moderators', counted: 'Reported' },
};

export function trapNoticeEmbed(action: AutomodAction, count: number): Embed {
  const { gets, counted } = CONSEQUENCE[action];
  return {
    title: `Do not type in this chat or you will be ${gets}`,
    description: `Anything posted here is deleted.\n\n**${counted}:** ${count}`,
    color: COLOR_WARNING,
    footer: { text: TRAP_NOTICE_FOOTER },
  };
}

/** The number on a warning, or 0 when there is none to read. */
export function readTrapCount(description: string): number {
  const match = /\*\*[^*]+:\*\* (\d+)\s*$/.exec(description);
  return match ? Number(match[1]) : 0;
}

type NoticeApi = Pick<
  DiscordApi,
  'getBotUserId' | 'listPinnedMessages' | 'postMessage' | 'editMessage' | 'pinMessage' | 'deleteMessage'
>;

async function findNotice(api: NoticeApi, channelId: string) {
  const [pins, botId] = await Promise.all([api.listPinnedMessages(channelId), api.getBotUserId()]);
  if (!pins) return { readable: false as const, notice: null };
  const notice = pins.find((pin) => pin.authorId === botId && pin.embed?.footer === TRAP_NOTICE_FOOTER) ?? null;
  return { readable: true as const, notice };
}

/** Post and pin a fresh warning. Says whether the pin took, so the caller can explain a missing one. */
async function postNotice(api: NoticeApi, channelId: string, action: AutomodAction, count: number): Promise<RoleCallResult> {
  const messageId = await api.postMessage(channelId, { embeds: [trapNoticeEmbed(action, count)], allowed_mentions: { parse: [] } });
  if (!messageId) return 'failed';
  return api.pinMessage(channelId, messageId, 'Auto mod: the trap channel warning');
}

/**
 * Put the warning up in a channel just made a trap, keeping the count of one
 * that is already there (a channel removed and added back again).
 */
export async function putUpTrapNotice(api: NoticeApi, channelId: string, action: AutomodAction): Promise<RoleCallResult> {
  const { notice } = await findNotice(api, channelId);
  if (notice) {
    const count = readTrapCount(notice.embed?.description ?? '');
    const result = await api.editMessage(channelId, notice.id, { embeds: [trapNoticeEmbed(action, count)] });
    return result === 'ok' ? 'ok' : 'failed';
  }
  return postNotice(api, channelId, action, 0);
}

/** Take the warning down from a channel that is no longer a trap. */
export async function takeDownTrapNotice(api: NoticeApi, channelId: string): Promise<void> {
  const { notice } = await findNotice(api, channelId);
  if (notice) await api.deleteMessage(channelId, notice.id);
}

/** One count bump at a time per channel. */
const bumping = new Map<string, Promise<void>>();

/** Count one more caught account on the channel's warning, putting it back if it is gone. */
export function bumpTrapNotice(
  api: NoticeApi,
  channelId: string,
  action: AutomodAction,
  log: (line: string) => void = (line) => console.error(line)
): Promise<void> {
  const previous = bumping.get(channelId) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      const { readable, notice } = await findNotice(api, channelId);
      // Pins that cannot be read are not proof the warning is gone; posting
      // another would only stack duplicates.
      if (!readable) return;
      if (!notice) {
        await postNotice(api, channelId, action, 1);
        return;
      }
      const count = readTrapCount(notice.embed?.description ?? '') + 1;
      const result = await api.editMessage(channelId, notice.id, { embeds: [trapNoticeEmbed(action, count)] });
      if (result === 'gone') await postNotice(api, channelId, action, count);
    } catch (error) {
      log(`[trap-notice] ${channelId}: ${String(error)}`);
    }
  });
  const settled = next.finally(() => {
    if (bumping.get(channelId) === settled) bumping.delete(channelId);
  });
  bumping.set(channelId, settled);
  return settled;
}
