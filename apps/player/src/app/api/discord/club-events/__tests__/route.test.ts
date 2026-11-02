import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// What this file guards, beyond what the tournament route's test already
// covers for the shared shape:
//
//  - A club event KEEPS its Discord event while it runs. Creating needs a
//    future start; keeping needs only an end still ahead. Mixing the two up
//    deletes every Discord event the moment it starts.
//  - Everything sent is cut to Discord's limits, and cut the same way every
//    tick, or the change detector chases its own tail.
//  - A deleted event is only swept on positive evidence, including the audit
//    log when club_events reads as empty.

const E1 = "00000000-0000-4000-8000-000000000001";
const E2 = "00000000-0000-4000-8000-000000000002";

let mapped: Record<string, unknown>[] = [];
let clubEvents: Record<string, unknown>[] = [];
let auditLogs: Record<string, unknown>[] = [];
let forms: Record<string, unknown>[] = [];
let tournamentEvents: Record<string, unknown>[] = [];
let tournaments: Record<string, unknown>[] = [];
let readError: Record<string, { code: string; message: string } | null> = {};
let featuresRow: Record<string, unknown> | null = null;
const upserted = vi.fn();
const deleted = vi.fn();

// .eq, .in, .gt and .limit are APPLIED FOR REAL. The create rule lives in the
// .gt on starts_at and the .eq on status; the sweep's liveness check is the
// one read with no filter. A stub that ignored any of them would let the tests
// below pass against a route that never made the distinction.
function thenable(rows: Record<string, unknown>[], error: unknown = null) {
  const filters: ((r: Record<string, unknown>) => boolean)[] = [];
  const builder: Record<string, unknown> = {};
  let cap: number | null = null;
  let sort: ((a: Record<string, unknown>, b: Record<string, unknown>) => number) | null = null;
  builder.select = () => builder;
  builder.order = (column: string, options?: { ascending?: boolean }) => {
    const sign = options?.ascending === false ? -1 : 1;
    sort = (a, b) => sign * String(a[column] ?? "").localeCompare(String(b[column] ?? ""));
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    // The mapping rows carry no guild_id; every mapping is g1's.
    if (column !== "guild_id") filters.push((r) => r[column] === value);
    return builder;
  };
  builder.in = (column: string, values: unknown[]) => {
    filters.push((r) => values.includes(r[column]));
    return builder;
  };
  builder.gt = (column: string, value: string) => {
    filters.push((r) => Date.parse(r[column] as string) > Date.parse(value));
    return builder;
  };
  builder.limit = (n: number) => {
    cap = n;
    return builder;
  };
  builder.then = (resolve: (v: unknown) => unknown) => {
    const matched = rows.filter((r) => filters.every((f) => f(r)));
    if (sort) matched.sort(sort);
    const data = error ? null : cap === null ? matched : matched.slice(0, cap);
    return Promise.resolve({ data, error }).then(resolve);
  };
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "platform_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: featuresRow ? { value: featuresRow } : null, error: null }),
            }),
          }),
        };
      }
      if (table === "club_events") return thenable(clubEvents, readError.clubEvents ?? null);
      if (table === "audit_logs") return thenable(auditLogs, readError.audit ?? null);
      if (table === "registration_import_forms") return thenable(forms, readError.forms ?? null);
      if (table === "tournament_events") return thenable(tournamentEvents, readError.tournamentEvents ?? null);
      if (table === "tournaments") return thenable(tournaments, readError.tournaments ?? null);
      if (table === "discord_club_events") {
        return {
          ...thenable(mapped, readError.mapped ?? null),
          upsert: (row: unknown) => {
            upserted(row);
            return Promise.resolve({ error: null });
          },
          delete: () => {
            const chain: Record<string, unknown> = {
              eq: () => chain,
              then: (resolve: (v: unknown) => unknown) => {
                deleted();
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

let bucket = 0;
function req(path = "/api/discord/club-events?guildId=g1", init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: "Bearer test-secret",
      "x-forwarded-for": `10.8.0.${(bucket += 1)}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

interface Action {
  kind: string;
  eventId: string;
  discordEventId: string | null;
  name: string;
  startsAt: string;
  endsAt: string;
  syncedStartsAt: string;
  syncedEndsAt: string;
  patchTimes: boolean;
  location: string | null;
  description: string;
}

type Body = { actions: Action[]; skipped: { eventId: string; reason: string }[] };

async function run(): Promise<Body> {
  const { GET } = await import("../route");
  const res = await GET(req());
  return (await res.json()) as Body;
}

function only(actions: Action[]): Action {
  expect(actions).toHaveLength(1);
  return actions[0] as Action;
}

const HOUR = 60 * 60_000;

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function clubEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: E1,
    title: "Games Night",
    kind: "social",
    description: "Board games and snacks.",
    location: "Rotunda",
    starts_at: at(24 * HOUR),
    ends_at: at(27 * HOUR),
    status: "published",
    cost_cents: 500,
    ...overrides,
  };
}

/** The mapping the bot would record for this action. */
function recorded(a: Action, overrides: Record<string, unknown> = {}) {
  return {
    club_event_id: a.eventId,
    discord_event_id: "evt-1",
    synced_name: a.name,
    synced_starts_at: a.syncedStartsAt,
    synced_ends_at: a.syncedEndsAt,
    synced_location: a.location,
    synced_description: a.description,
    ...overrides,
  };
}

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    club_event_id: E1,
    discord_event_id: "evt-1",
    synced_name: "Games Night",
    synced_starts_at: at(-HOUR),
    synced_ends_at: at(HOUR),
    synced_location: "Rotunda",
    synced_description: "",
    ...overrides,
  };
}

/**
 * The mapping for a STARTED event, as the bot would have recorded it. Reached
 * through a rename, because a started event without a mapping is never
 * offered a create.
 */
async function settledStarted() {
  mapped = [mapping({ synced_name: "Before" })];
  const a = only((await run()).actions);
  expect(a.kind).toBe("update");
  return recorded(a);
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = "test-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://example.test/";
  readError = {};
  featuresRow = null;
  forms = [];
  tournamentEvents = [];
  mapped = [];
  auditLogs = [];
  upserted.mockReset();
  deleted.mockReset();
  clubEvents = [clubEvent()];
});

// Loading the route is slow on a cold CI runner; done once here with room to
// spare, so the first test is not the one that pays for it and times out.
beforeAll(async () => {
  await import("../route");
}, 30_000);

describe("GET /api/discord/club-events", () => {
  it("refuses without the service secret", async () => {
    const { GET } = await import("../route");
    const bad = new Request("http://localhost/api/discord/club-events?guildId=g1", {
      headers: { authorization: "Bearer wrong" },
    });
    expect((await GET(bad)).status).toBe(401);
  });

  it("has nothing to do while club events are switched off, even with a mapping", async () => {
    featuresRow = { events_enabled: false };
    mapped = [mapping()];
    clubEvents = [clubEvent({ status: "cancelled" })];
    const { actions, skipped } = await run();
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ eventId: "*", reason: "events_disabled" }]);
  });

  it("still announces when only another feature is switched off", async () => {
    featuresRow = { tournaments_enabled: false, events_enabled: true };
    expect(only((await run()).actions).kind).toBe("create");
  });

  it("offers a create for a published future event, linking to its page", async () => {
    const action = only((await run()).actions);
    expect(action.kind).toBe("create");
    expect(action.eventId).toBe(E1);
    expect(action.name).toBe("Games Night");
    expect(action.name.length).toBeLessThanOrEqual(100);
    expect(action.location).toBe("Rotunda");
    expect(action.patchTimes).toBe(true);
    expect(action.description).toContain(`https://example.test/events/${E1}`);
    expect(action.description).toContain("Social, $5.00");
    expect(action.description).toContain("Board games");
  });

  it("never announces a draft", async () => {
    clubEvents = [clubEvent({ status: "draft" })];
    expect((await run()).actions).toEqual([]);
  });

  it("cancels when a mapped event goes back to draft", async () => {
    clubEvents = [clubEvent({ status: "draft" })];
    mapped = [mapping()];
    const action = only((await run()).actions);
    expect(action.kind).toBe("cancel");
    expect(action.discordEventId).toBe("evt-1");
  });

  it("cancels when a mapped event is cancelled", async () => {
    clubEvents = [clubEvent({ status: "cancelled" })];
    mapped = [mapping()];
    expect(only((await run()).actions).kind).toBe("cancel");
  });

  it("KEEPS the Discord event of one that has started and not ended", async () => {
    // The guard against deleting every event as it starts.
    clubEvents = [clubEvent({ starts_at: at(-HOUR), ends_at: at(HOUR) })];
    mapped = [await settledStarted()];

    const { actions, skipped } = await run();
    expect(actions).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("cancels a mapped event past its end", async () => {
    clubEvents = [clubEvent({ starts_at: at(-4 * HOUR), ends_at: at(-HOUR) })];
    mapped = [mapping()];
    expect(only((await run()).actions).kind).toBe("cancel");
  });

  it("treats an event with no end as two hours long", async () => {
    clubEvents = [clubEvent({ ends_at: null })];
    const action = only((await run()).actions);
    expect(Date.parse(action.syncedEndsAt) - Date.parse(action.syncedStartsAt)).toBe(2 * HOUR);
    expect(action.endsAt).toBe(action.syncedEndsAt);
  });

  it("offers an update with times for a location edit before the start", async () => {
    const first = only((await run()).actions);
    mapped = [recorded(first, { synced_location: "Old gym" })];
    const action = only((await run()).actions);
    expect(action.kind).toBe("update");
    expect(action.location).toBe("Rotunda");
    expect(action.patchTimes).toBe(true);
  });

  it("does not push a location edit onto a started event", async () => {
    clubEvents = [clubEvent({ starts_at: at(-HOUR), ends_at: at(HOUR) })];
    mapped = [{ ...(await settledStarted()), synced_location: "Old gym" }];

    const { actions, skipped } = await run();
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ eventId: E1, reason: "started_cannot_retime" }]);
  });

  it("pushes a rename onto a started event without the times", async () => {
    clubEvents = [clubEvent({ title: "Games Night II", starts_at: at(-HOUR), ends_at: at(HOUR) })];
    mapped = [mapping()];
    const action = only((await run()).actions);
    expect(action.kind).toBe("update");
    expect(action.name).toBe("Games Night II");
    expect(action.patchTimes).toBe(false);
  });

  it("cuts a long title and location to 100, and settles on the cut values", async () => {
    clubEvents = [clubEvent({ title: "T".repeat(150), location: "L".repeat(200) })];
    const first = only((await run()).actions);
    expect(first.name).toHaveLength(100);
    expect(first.location).toHaveLength(100);

    mapped = [recorded(first)];
    expect((await run()).actions).toEqual([]);
  });

  it("never splits a character when cutting", async () => {
    // U+1D400 is two UTF-16 units. 99 letters plus one of them is 101.
    clubEvents = [clubEvent({ title: `${"T".repeat(99)}\u{1D400}` })];
    const first = only((await run()).actions);
    expect(first.name).toBe("T".repeat(99));
  });

  it("keeps the link when the description is at its 4000-character limit", async () => {
    clubEvents = [clubEvent({ description: "x".repeat(4000) })];
    const action = only((await run()).actions);
    expect(action.description.length).toBeLessThanOrEqual(1000);
    expect(action.description.endsWith(`https://example.test/events/${E1}`)).toBe(true);
  });

  it("adds the event's Google Form, newest active form first, and never calls the page a sign-up", async () => {
    forms = [
      { form_id: "OLD", club_event_id: E1, active: true, created_at: "2026-10-01T00:00:00Z" },
      { form_id: "OFF", club_event_id: E1, active: false, created_at: "2026-10-20T00:00:00Z" },
      { form_id: "NEW", club_event_id: E1, active: true, created_at: "2026-10-10T00:00:00Z" },
    ];
    const action = only((await run()).actions);
    expect(action.description).toContain(`Event details: https://example.test/events/${E1}`);
    expect(action.description).toContain(
      "Sign up with the Google Form: https://docs.google.com/forms/d/NEW/viewform",
    );
    expect(action.description).not.toContain("OLD");
    expect(action.description).not.toMatch(/sign-up/i);
  });

  it("keeps both links when the description is at its limit", async () => {
    clubEvents = [clubEvent({ description: "x".repeat(4000) })];
    forms = [{ form_id: "F1", club_event_id: E1, active: true, created_at: "2026-10-01T00:00:00Z" }];
    const action = only((await run()).actions);
    expect(action.description.length).toBeLessThanOrEqual(1000);
    expect(action.description).toContain(`https://example.test/events/${E1}`);
    expect(action.description.endsWith("https://docs.google.com/forms/d/F1/viewform")).toBe(true);
  });

  it("refuses the tick when the forms cannot be read, rather than dropping the link", async () => {
    readError = { forms: { code: "42501", message: "permission denied" } };
    const { GET } = await import("../route");
    const res = await GET(req());
    expect(res.status).toBe(503);
  });

  it("cancels an event deleted outright while other events exist", async () => {
    clubEvents = [clubEvent({ id: E2, status: "draft" })];
    mapped = [mapping()];
    const action = only((await run()).actions);
    expect(action.kind).toBe("cancel");
    expect(action.eventId).toBe(E1);
  });

  it("cancels a deleted event on an empty table when the audit log confirms it", async () => {
    clubEvents = [];
    mapped = [mapping()];
    auditLogs = [{ action_type: "club_event_deleted", target_id: E1 }];
    const action = only((await run()).actions);
    expect(action.kind).toBe("cancel");
    expect(action.eventId).toBe(E1);
  });

  it("does NOT cancel on an empty table without an audit row", async () => {
    clubEvents = [];
    mapped = [mapping()];
    auditLogs = [{ action_type: "club_event_updated", target_id: E1 }];
    const { actions, skipped } = await run();
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ eventId: E1, reason: "absence_unverified" }]);
  });

  it("503s when the table is empty and the audit log cannot be read", async () => {
    clubEvents = [];
    mapped = [mapping()];
    readError.audit = { code: "42501", message: "permission denied" };
    const { GET } = await import("../route");
    expect((await GET(req())).status).toBe(503);
  });

  it("FAILS CLOSED when the mapping read errors", async () => {
    readError.mapped = { code: "42P01", message: "relation does not exist" };
    const { GET } = await import("../route");
    expect((await GET(req())).status).toBe(503);
  });

  it("CAPS the mapping read, and says when the cap bites", async () => {
    clubEvents = [clubEvent({ id: E2, status: "draft" })];
    mapped = Array.from({ length: 600 }, (_, i) =>
      mapping({ club_event_id: `00000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}` }),
    );
    const { actions, skipped } = await run();
    expect(actions).toHaveLength(150);
    expect(skipped).toContainEqual({ eventId: "*", reason: "mapping_cap_reached" });
  });
});

describe("GET /api/discord/club-events, an event run as a tournament", () => {
  const T1 = "00000000-0000-4000-8000-0000000000aa";

  beforeEach(() => {
    tournamentEvents = [{ id: "te1", tournament_id: T1 }];
    tournaments = [{ id: T1, status: "active" }];
    clubEvents = [clubEvent({ tournament_event_id: "te1" })];
  });

  it("leaves the link out while the tournament is a draft, whose page is a 404", async () => {
    tournaments = [{ id: T1, status: "draft" }];
    expect(only((await run()).actions).description).not.toContain("Bracket");
  });

  it("links the bracket, and keeps the link when the description is at its limit", async () => {
    const link = `Bracket and draw: https://example.test/tournaments/${T1}`;
    expect(only((await run()).actions).description).toContain(link);
    clubEvents = [clubEvent({ tournament_event_id: "te1", description: "x".repeat(4000) })];
    const description = only((await run()).actions).description;
    expect(description).toContain(link);
    expect(description.length).toBeLessThanOrEqual(1000);
  });

  it("PATCHes an event already posted without the link", async () => {
    mapped = [
      mapping({
        synced_starts_at: clubEvents[0]!.starts_at,
        synced_ends_at: clubEvents[0]!.ends_at,
        synced_description: "Social, $5.00",
      }),
    ];
    const a = only((await run()).actions);
    expect(a.kind).toBe("update");
    expect(a.description).toContain(`/tournaments/${T1}`);
  });

  it("refuses the tick when the link cannot be read, rather than dropping it", async () => {
    for (const failing of ["tournamentEvents", "tournaments"]) {
      readError = { [failing]: { code: "42501", message: "permission denied" } };
      const { GET } = await import("../route");
      expect((await GET(req())).status, failing).toBe(503);
    }
  });

  it("adds no link and reads nothing more for an event that is not linked", async () => {
    clubEvents = [clubEvent()];
    readError = { tournamentEvents: { code: "42501", message: "permission denied" } };
    expect(only((await run()).actions).description).not.toContain("Bracket");
  });
});

describe("POST /api/discord/club-events", () => {
  const body = {
    eventId: E1,
    guildId: "g1",
    discordEventId: "evt-1",
    name: "Games Night",
    syncedStartsAt: "2026-10-01T02:00:00.000Z",
    syncedEndsAt: "2026-10-01T04:00:00.000Z",
    location: null,
    description: "",
  };

  it("accepts a null location and an empty description", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/club-events", { method: "POST", body: JSON.stringify(body) }),
    );
    expect(res.status).toBe(200);
    expect(upserted).toHaveBeenCalledWith(
      expect.objectContaining({
        club_event_id: E1,
        guild_id: "g1",
        synced_location: null,
        synced_description: "",
      }),
    );
  });

  it("rejects a half-filled mapping instead of storing one", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/club-events", {
        method: "POST",
        body: JSON.stringify({ eventId: E1, guildId: "g1", discordEventId: "evt-1" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(upserted).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/discord/club-events", () => {
  it("clears one mapping", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(
      req(`/api/discord/club-events?eventId=${E1}&guildId=g1`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    expect(deleted).toHaveBeenCalled();
  });

  it("refuses an unscoped delete", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(req(`/api/discord/club-events?eventId=${E1}`, { method: "DELETE" }));
    expect(res.status).toBe(400);
    expect(deleted).not.toHaveBeenCalled();
  });
});
