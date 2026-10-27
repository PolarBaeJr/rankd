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

/**
 * How the bot recognises its own warning among the pins: the count button's
 * custom_id. Warnings pinned before the button existed carry this footer
 * instead, and are rewritten in the new look on their next count.
 */
export const TRAP_STATS_BUTTON = 'trap:stats';
export const TRAP_NOTICE_FOOTER = 'Auto mod trap channel';

// Dark grey, so the bar all but disappears and the warning reads as a card.
const COLOR_CARD = 0x2b2d31;

/** What a post here gets, in the warning's words, and what its count button says. */
const CONSEQUENCE: Record<AutomodAction, { result: string; counted: string }> = {
  softban: { result: 'will result in **a soft ban**', counted: 'Soft bans' },
  timeout_then_softban: {
    result: 'will result in **a timeout**, and **a soft ban** if it happens again',
    counted: 'Caught',
  },
  timeout: { result: 'will result in **a timeout**', counted: 'Timeouts' },
  flag: { result: 'is **reported to the moderators**', counted: 'Reported' },
};

export function trapNoticeEmbed(action: AutomodAction): Embed {
  return {
    title: 'DO NOT SEND MESSAGES IN THIS CHANNEL',
    description: `This channel is used to catch spam bots. Any message sent here ${CONSEQUENCE[action].result}.`,
    color: COLOR_CARD,
  };
}

/** The whole warning: the card, and under it the count as a button that shows the stats. */
export function trapNoticeMessage(action: AutomodAction, count: number) {
  return {
    embeds: [trapNoticeEmbed(action)],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 2, custom_id: TRAP_STATS_BUTTON, label: `${CONSEQUENCE[action].counted}: ${count}` },
        ],
      },
    ],
  };
}

/** The number at the end of a count button's label (or an old warning's text), or 0. */
export function readTrapCount(text: string): number {
  const match = /(\d+)\s*$/.exec(text);
  return match ? Number(match[1]) : 0;
}

type Pin = Awaited<ReturnType<DiscordApi['listPinnedMessages']>> extends (infer P)[] | null ? P : never;

function isNotice(pin: Pin, botId: string): boolean {
  if (pin.authorId !== botId) return false;
  return pin.buttons.some((button) => button.customId === TRAP_STATS_BUTTON) || pin.embed?.footer === TRAP_NOTICE_FOOTER;
}

/** A warning's count: from its button, or from an old warning's last line. */
export function noticeCount(pin: Pin): number {
  const button = pin.buttons.find((candidate) => candidate.customId === TRAP_STATS_BUTTON);
  return readTrapCount(button ? button.label : (pin.embed?.description ?? ''));
}

type NoticeApi = Pick<
  DiscordApi,
  'getBotUserId' | 'listPinnedMessages' | 'postMessage' | 'editMessage' | 'pinMessage' | 'deleteMessage'
>;

async function findNotice(api: NoticeApi, channelId: string) {
  const [pins, botId] = await Promise.all([api.listPinnedMessages(channelId), api.getBotUserId()]);
  if (!pins) return { readable: false as const, notice: null };
  const notice = pins.find((pin) => isNotice(pin, botId)) ?? null;
  return { readable: true as const, notice };
}

/** Post and pin a fresh warning. Says whether the pin took, so the caller can explain a missing one. */
async function postNotice(api: NoticeApi, channelId: string, action: AutomodAction, count: number): Promise<RoleCallResult> {
  const messageId = await api.postMessage(channelId, { ...trapNoticeMessage(action, count), allowed_mentions: { parse: [] } });
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
    const result = await api.editMessage(channelId, notice.id, trapNoticeMessage(action, noticeCount(notice)));
    return result === 'ok' ? 'ok' : 'failed';
  }
  return postNotice(api, channelId, action, 0);
}

/** A trap channel's count, or null when its pins cannot be read. */
export async function readTrapChannelCount(api: NoticeApi, channelId: string): Promise<number | null> {
  const { readable, notice } = await findNotice(api, channelId);
  if (!readable) return null;
  return notice ? noticeCount(notice) : 0;
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
      const count = noticeCount(notice) + 1;
      const result = await api.editMessage(channelId, notice.id, trapNoticeMessage(action, count));
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
