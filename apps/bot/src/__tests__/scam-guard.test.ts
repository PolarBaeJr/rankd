import { describe, expect, it, vi } from "vitest";
import {
  SPRAY_WINDOW_MS,
  SprayTracker,
  createScamGuard,
  fingerprint,
  isModerator,
  isSuspect,
  readMessage,
  type ScamMessage,
} from "../scam-guard.js";
import { intentsFor, parseServerLogScopes } from "../server-log.js";
import type { ServerLogEntry } from "../server-log.js";

const BAIT = "Gifting free stuff to the first 5 people, DM me!";
const PHOTOS = [
  { size: 48211, content_type: "image/png" },
  { size: 50133, content_type: "image/png" },
];

let nextId = 0;
const raw = (channel: string, extra: Record<string, unknown> = {}) => ({
  id: `m${(nextId += 1)}`,
  guild_id: "club",
  channel_id: channel,
  author: { id: "hacked" },
  member: { roles: [] },
  content: BAIT,
  attachments: PHOTOS,
  ...extra,
});

function message(
  channel: string,
  extra: Record<string, unknown> = {},
): ScamMessage {
  const read = readMessage(raw(channel, extra));
  if (!read) throw new Error("fixture did not parse");
  return read;
}

describe("scam scope", () => {
  it("switches on the messages and content it reads, and adds no intent of its own", () => {
    const { scopes } = parseServerLogScopes("scam");
    expect([...scopes].sort()).toEqual(["content", "messages", "scam"]);
    expect(intentsFor(scopes)).toBe((1 << 9) | (1 << 15));
  });
});

describe("fingerprint", () => {
  it("ignores case, punctuation and mentions, so a light reword is still the same post", () => {
    const a = fingerprint({
      text: "Gifting FREE stuff!! <@123> dm me",
      attachments: [],
    });
    const b = fingerprint({
      text: "gifting free stuff dm me",
      attachments: [],
    });
    expect(a).toBe(b);
  });

  it("carries image-only posts by their attachments", () => {
    expect(
      fingerprint({ text: "", attachments: [{ size: 10, type: "image/png" }] }),
    ).toBe("|10:image/png");
  });

  it("is null for a short text with nothing attached", () => {
    expect(fingerprint({ text: "hi all", attachments: [] })).toBeNull();
  });
});

describe("isSuspect", () => {
  it("flags a giveaway with pictures, a link or crypto words", () => {
    expect(
      isSuspect({
        text: BAIT,
        attachments: [
          { size: 1, type: "a" },
          { size: 2, type: "b" },
        ],
      }),
    ).toBe(true);
    expect(
      isSuspect({ text: "free nitro https://example.test", attachments: [] }),
    ).toBe(true);
    expect(
      isSuspect({ text: "giving away my bitcoin profits", attachments: [] }),
    ).toBe(true);
  });

  it("leaves an ordinary post alone, even one about free things", () => {
    expect(
      isSuspect({
        text: "Free play on Friday, bring a racket",
        attachments: [],
      }),
    ).toBe(false);
    expect(
      isSuspect({
        text: "check out my new racket",
        attachments: [
          { size: 1, type: "a" },
          { size: 2, type: "b" },
        ],
      }),
    ).toBe(false);
  });
});

describe("isModerator", () => {
  const roles = [
    { id: "mod", name: "Mod", position: 5, permissions: String(1n << 13n) },
    { id: "member", name: "Member", position: 1, permissions: "0" },
  ];
  it("is true for a role with Manage Messages, false for a plain one", () => {
    expect(isModerator(["mod"], roles)).toBe(true);
    expect(isModerator(["member"], roles)).toBe(false);
    expect(isModerator([], roles)).toBe(false);
  });
});

describe("SprayTracker", () => {
  it("calls the same post in three channels a spray", () => {
    const tracker = new SprayTracker();
    const plain = {
      content: "join my server for exclusive deals today",
      attachments: [],
    };
    expect(tracker.verdict(message("a", plain), 0).kind).toBe("none");
    expect(tracker.verdict(message("b", plain), 1000).kind).toBe("none");
    expect(tracker.verdict(message("c", plain), 2000)).toEqual({
      kind: "spray",
      channels: 3,
    });
  });

  it("calls a giveaway with pictures in two channels a spray", () => {
    const tracker = new SprayTracker();
    expect(tracker.verdict(message("a"), 0).kind).toBe("suspect");
    expect(tracker.verdict(message("b"), 1000)).toEqual({
      kind: "spray",
      channels: 2,
    });
  });

  it("does not count one channel twice, or posts outside the window", () => {
    const tracker = new SprayTracker();
    const plain = {
      content: "join my server for exclusive deals today",
      attachments: [],
    };
    tracker.verdict(message("a", plain), 0);
    tracker.verdict(message("a", plain), 500);
    tracker.verdict(message("b", plain), SPRAY_WINDOW_MS + 1000);
    expect(
      tracker.verdict(message("c", plain), SPRAY_WINDOW_MS + 1001).kind,
    ).toBe("none");
  });

  it("keeps accounts apart", () => {
    const tracker = new SprayTracker();
    const plain = {
      content: "join my server for exclusive deals today",
      attachments: [],
    };
    tracker.verdict(message("a", { ...plain, author: { id: "one" } }), 0);
    tracker.verdict(message("b", { ...plain, author: { id: "two" } }), 0);
    expect(
      tracker.verdict(message("c", { ...plain, author: { id: "three" } }), 0)
        .kind,
    ).toBe("none");
  });
});

describe("readMessage", () => {
  it("skips bots, webhooks and DMs", () => {
    expect(
      readMessage(raw("a", { author: { id: "x", bot: true } })),
    ).toBeNull();
    expect(readMessage(raw("a", { webhook_id: "w" }))).toBeNull();
    expect(readMessage(raw("a", { guild_id: undefined }))).toBeNull();
  });
});

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    getBotUserId: vi.fn(async () => "bot"),
    getGuildOwnerId: vi.fn(async () => "owner"),
    listGuildRoles: vi.fn(async () => [
      { id: "mod", name: "Mod", position: 5, permissions: String(1n << 2n) },
      { id: "member", name: "Member", position: 1, permissions: "0" },
      { id: "top", name: "Top", position: 9, permissions: "0" },
    ]),
    getOwnRolePosition: vi.fn(async () => 8),
    banMember: vi.fn(async () => "ok" as const),
    unbanMember: vi.fn(async () => "ok" as const),
    ...overrides,
  };
}

function guardWith(api: ReturnType<typeof fakeApi>, servers = ["club"]) {
  const reports: { guildId: string; entry: ServerLogEntry }[] = [];
  let clock = Date.parse("2026-10-22T18:00:00Z");
  const guard = createScamGuard({
    api,
    clubServers: async () => new Set(servers),
    report: (guildId, entry) => reports.push({ guildId, entry }),
    log: () => {},
    now: () => new Date((clock += 1000)),
    sleep: async () => {},
  });
  return { guard, reports };
}

describe("createScamGuard", () => {
  it("soft-bans a spray once, deleting the last hour, and reports it", async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api);
    for (const channel of ["a", "b", "c", "d"]) guard.onMessage(raw(channel));
    await guard.drain();
    expect(api.banMember).toHaveBeenCalledTimes(1);
    expect(api.banMember).toHaveBeenCalledWith(
      "club",
      "hacked",
      3600,
      expect.stringContaining("scam guard"),
    );
    expect(api.unbanMember).toHaveBeenCalledTimes(1);
    const titles = reports.map((r) => r.entry.embed.title);
    expect(titles).toEqual([
      "Possible scam post (no action taken)",
      "Scam spray caught",
    ]);
    expect(reports[1]?.entry.embed.fields?.[0]?.value).toMatch(/^Soft-banned/);
  });

  it("never acts outside the club servers", async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api, ["other"]);
    for (const channel of ["a", "b", "c"]) guard.onMessage(raw(channel));
    await guard.drain();
    expect(api.banMember).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  it("leaves moderators and the owner alone", async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api);
    for (const channel of ["a", "b", "c"])
      guard.onMessage(raw(channel, { member: { roles: ["mod"] } }));
    for (const channel of ["a", "b", "c"])
      guard.onMessage(raw(channel, { author: { id: "owner" } }));
    await guard.drain();
    expect(api.banMember).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  it("reports instead of banning someone ranked at or above the bot", async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api);
    for (const channel of ["a", "b"])
      guard.onMessage(raw(channel, { member: { roles: ["top"] } }));
    await guard.drain();
    expect(api.banMember).not.toHaveBeenCalled();
    expect(reports.at(-1)?.entry.embed.fields?.[0]?.value).toMatch(
      /at or above mine/,
    );
  });

  it("says so loudly when the unban never lands", async () => {
    const api = fakeApi({ unbanMember: vi.fn(async () => "failed" as const) });
    const { guard, reports } = guardWith(api);
    for (const channel of ["a", "b"]) guard.onMessage(raw(channel));
    await guard.drain();
    expect(api.unbanMember).toHaveBeenCalledTimes(3);
    expect(reports.at(-1)?.entry.embed.fields?.[0]?.value).toMatch(
      /still BANNED/,
    );
  });

  it("only flags a lone giveaway post", async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api);
    guard.onMessage(raw("a"));
    guard.onMessage(
      raw("a", {
        content: "unrelated chatter about the next session",
        attachments: [],
      }),
    );
    await guard.drain();
    expect(api.banMember).not.toHaveBeenCalled();
    expect(reports.map((r) => r.entry.embed.title)).toEqual([
      "Possible scam post (no action taken)",
    ]);
  });
});
