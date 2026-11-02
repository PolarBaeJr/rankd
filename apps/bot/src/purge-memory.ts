// Who ran /purge where, for a few minutes, so the server log can name them.
//
// Discord logs a bulk delete under the bot (it did the deleting) and the
// gateway event carries no reason, so without this the entry says "By: the
// bot" and nothing about who asked. The bot is one process, so the purge and
// the log entry it causes are seen by the same memory.

const REMEMBER_MS = 5 * 60_000;
const recent = new Map<string, { userId: string; at: number }>();

export function rememberPurge(channelId: string, userId: string, now = Date.now()): void {
  recent.set(channelId, { userId, at: now });
  for (const [key, value] of recent) if (now - value.at > REMEMBER_MS) recent.delete(key);
}

/** Who purged this channel in the last few minutes, or null. */
export function recallPurge(channelId: string, now = Date.now()): string | null {
  const entry = recent.get(channelId);
  return entry && now - entry.at <= REMEMBER_MS ? entry.userId : null;
}
