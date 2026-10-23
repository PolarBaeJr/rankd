import { describe, it, expect, vi, beforeEach } from "vitest";

// What this file guards: the app decides, and the two decisions that are easy
// to get subtly wrong are (a) never announce something that is not public, and
// (b) never let the change detector chase its own tail.
//
// (b) is the one worth reading twice. Discord refuses a start time in the past,
// which is the ROUTINE case — drafts sit around and get activated on the
// morning of day one — so the send value is clamped forward. If the clamped
// value were also what got recorded, the next tick would compare the
// tournament's real start against a moving target and PATCH forever.

let settings: { key: string; value: string }[] = [];
let mapped: Record<string, unknown>[] = [];
let tournaments: Record<string, unknown>[] = [];
// A club event run as a tournament (00292) and the tournament events it points at.
let clubEvents: Record<string, unknown>[] = [];
let tournamentEvents: Record<string, unknown>[] = [];
let readError: Record<string, { code: string; message: string } | null> = {};
// The stored `features` row, or null for none (which means every feature on).
let featuresRow: Record<string, unknown> | null = null;
const upserted = vi.fn();
const deleted = vi.fn();

// APPLIES .eq() FOR REAL, which matters more here than it looks.
//
// The cancel path depends on the route issuing TWO reads and merging them: the
// announceable set is status = 'active', and an archived tournament is only in
// the second read, the one by mapped id. A stub that ignored .eq() would hand
// the archived row back to BOTH queries, and the cancel tests would pass
// against a route that never made the second read at all.
function thenable(rows: Record<string, unknown>[], error: unknown = null) {
  const filters: [string, unknown][] = [];
  const builder: Record<string, unknown> = {};
  let cap: number | null = null;
  for (const method of ["select", "is", "not", "gte", "lte", "or", "order"]) {
    builder[method] = () => builder;
  }
  // ALSO APPLIED FOR REAL. The route tells a broken read apart from a genuinely
  // empty one with a liveness query that has NO filters on it. If .in() were a
  // no-op the by-id read would return every row in the table, byId would never
  // be empty, and the test that says the route refuses to cancel everything
  // would pass against a route that had no such check.
  builder.in = (column: string, values: unknown[]) => {
    filters.push([column, values]);
    return builder;
  };
  // APPLIED FOR REAL. The mapping read's .limit() is a safety bound, not a
  // paging detail: it is what keeps the id list below PGRST_DB_MAX_ROWS, and
  // therefore what stops a truncated read from looking like "every tournament
  // was deleted" to the orphan sweep.
  builder.limit = (n: number) => {
    cap = n;
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    filters.push([column, value]);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => unknown) => {
    const matched = rows.filter((r) =>
      filters.every(([c, v]) =>
        c === "guild_id" ? true : Array.isArray(v) ? v.includes(r[c]) : r[c] === v,
      ),
    );
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
      if (table === "discord_settings")
        return thenable(settings, readError.settings ?? null);
      if (table === "tournaments")
        return thenable(tournaments, readError.tournaments ?? null);
      if (table === "club_events")
        return thenable(clubEvents, readError.clubEvents ?? null);
      if (table === "tournament_events")
        return thenable(tournamentEvents, readError.tournamentEvents ?? null);
      if (table === "discord_tournament_events") {
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

// Per-test IP: the limiter is module-level and is not reset between tests.
let bucket = 0;
function req(path = "/api/discord/tournament-events?guildId=g1", init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: "Bearer test-secret",
      "x-forwarded-for": `10.7.0.${(bucket += 1)}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

interface Action {
  kind: string;
  tournamentId: string;
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

async function run(): Promise<{
  actions: Action[];
  skipped: { tournamentId: string; reason: string }[];
}> {
  const { GET } = await import("../route");
  const res = await GET(req());
  return (await res.json()) as {
    actions: Action[];
    skipped: { tournamentId: string; reason: string }[];
  };
}

function only(actions: Action[]): Action {
  expect(actions).toHaveLength(1);
  return actions[0] as Action;
}

function clubDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });
}

function tournament(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "Fall Open",
    start_date: clubDay(7),
    end_date: clubDay(8),
    status: "active",
    suspended_at: null,
    tournament_events: [{ event_type: "mens_singles" }, { event_type: "womens_doubles" }],
    ...overrides,
  };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = "test-secret";
  readError = {};
  featuresRow = null;
  mapped = [];
  clubEvents = [];
  tournamentEvents = [];
  upserted.mockReset();
  deleted.mockReset();
  settings = [
    { key: "tournament_event_start_time", value: "09:00" },
    { key: "tournament_event_end_time", value: "18:00" },
    { key: "tournament_event_location", value: "SFU Burnaby" },
  ];
  tournaments = [tournament()];
});

describe("GET /api/discord/tournament-events", () => {
  it("refuses without the service secret", async () => {
    const { GET } = await import("../route");
    const bad = new Request("http://localhost/api/discord/tournament-events?guildId=g1", {
      headers: { authorization: "Bearer wrong" },
    });
    expect((await GET(bad)).status).toBe(401);
  });

  // TOURNAMENTS SWITCHED OFF: nothing to do. Not even a cancel for one already
  // posted, so a switch flipped by mistake cannot tear down the Events tab.
  it("has nothing to do while tournaments are switched off", async () => {
    featuresRow = { tournaments_enabled: false };
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "d1",
        synced_name: "Old name",
        synced_starts_at: new Date(Date.now() + 86400000).toISOString(),
        synced_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(),
        synced_location: "SFU Burnaby",
      },
    ];
    const { actions, skipped } = await run();
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ tournamentId: "*", reason: "tournaments_disabled" }]);
  });

  it("still announces when only another feature is switched off", async () => {
    featuresRow = { sessions_enabled: false, tournaments_enabled: true };
    expect(only((await run()).actions).kind).toBe("create");
  });

  it("offers a create for an active tournament with no Discord event yet", async () => {
    const action = only((await run()).actions);

    expect(action.kind).toBe("create");
    expect(action.name).toBe("Fall Open");
    expect(action.location).toBe("SFU Burnaby");
    // The individual draws are named in the description rather than becoming
    // separate Discord events — tournament_events carries no times of its own.
    expect(action.description).toContain("Men");
    expect(action.description).toContain("Doubles");
  });

  it("never announces a DRAFT", async () => {
    // Draft is where an exec assembles one. RLS lets a member read it; that is
    // not the same as the bot pushing it into everyone's Events tab. What
    // enforces it is the query narrowing to status = 'active' — which is why
    // the stub above applies .eq() rather than ignoring it.
    tournaments = [tournament({ status: "draft" })];
    expect((await run()).actions).toEqual([]);
  });

  it("pulls the Discord event when a tournament is reverted to draft", async () => {
    // The in-memory half of the same rule, and the half the query cannot do:
    // an unpublished tournament reaches this route through the by-id read, and
    // has to lose the event it already has.
    tournaments = [tournament({ status: "draft" })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: new Date().toISOString(),
        synced_ends_at: new Date().toISOString(),
        synced_location: "SFU Burnaby",
      },
    ];

    expect(only((await run()).actions).kind).toBe("cancel");
  });

  it("clamps a start already gone but records the tournament's own time", async () => {
    // The whole reason the two values are separate.
    tournaments = [tournament({ start_date: clubDay(-1), end_date: clubDay(2) })];
    const action = only((await run()).actions);

    expect(Date.parse(action.startsAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(action.syncedStartsAt)).toBeLessThan(Date.now());
  });

  it("skips a tournament that has already finished, and says why", async () => {
    tournaments = [tournament({ start_date: clubDay(-9), end_date: clubDay(-8) })];
    const { actions, skipped } = await run();

    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ tournamentId: "t1", reason: "already_ended" }]);
  });

  it("offers nothing when the Discord event already matches", async () => {
    const first = only((await run()).actions);
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: first.syncedStartsAt,
        synced_ends_at: first.syncedEndsAt,
        synced_location: "SFU Burnaby",
      },
    ];

    expect((await run()).actions).toEqual([]);
  });

  it("offers an update after a rename", async () => {
    const first = only((await run()).actions);
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Autumn Open",
        synced_starts_at: first.syncedStartsAt,
        synced_ends_at: first.syncedEndsAt,
        synced_location: "SFU Burnaby",
      },
    ];

    const action = only((await run()).actions);
    expect(action.kind).toBe("update");
    expect(action.discordEventId).toBe("evt-1");
    expect(action.name).toBe("Fall Open");
    // Not started, so the schedule goes with it.
    expect(action.patchTimes).toBe(true);
  });

  it("does NOT retime an event Discord has already started", async () => {
    // The loop this prevents needs nothing to go wrong: a tournament is
    // mid-run, an exec edits tournament_event_start_time — which moves the
    // computed start for EVERY mapped tournament at once — Discord refuses to
    // retime an event in progress, nothing is recorded, and the next tick
    // computes the identical diff. Every fifteen minutes, for days.
    tournaments = [tournament({ start_date: clubDay(-1), end_date: clubDay(2) })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        // A start on the hour, so the club-time computation cannot match it.
        synced_starts_at: "2020-01-01T00:00:00.000Z",
        synced_ends_at: "2020-01-02T00:00:00.000Z",
        synced_location: "SFU Burnaby",
      },
    ];

    const { actions, skipped } = await run();
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ tournamentId: "t1", reason: "started_cannot_retime" }]);
  });

  it("still pushes a RENAME onto a started event, with the times left alone", async () => {
    // A rename is the change members actually notice, so it lands — and
    // recording the tournament's current times alongside it settles the
    // comparison, which is what stops the retry loop rather than merely
    // narrowing it.
    tournaments = [tournament({ name: "Autumn Open", start_date: clubDay(-1), end_date: clubDay(2) })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: "2020-01-01T00:00:00.000Z",
        synced_ends_at: "2020-01-02T00:00:00.000Z",
        synced_location: "SFU Burnaby",
      },
    ];

    const action = only((await run()).actions);
    expect(action.kind).toBe("update");
    expect(action.name).toBe("Autumn Open");
    expect(action.patchTimes).toBe(false);
    // Recorded anyway. Discord keeps the times it was created with; they
    // describe an event already under way, which nobody can act on.
    expect(Date.parse(action.syncedStartsAt)).toBeLessThan(Date.now());
  });

  it("cancels the Discord event when the tournament is suspended", async () => {
    // A suspended tournament is one the club has told members is off. Leaving a
    // live event with a reminder attached contradicts that where they look.
    tournaments = [tournament({ suspended_at: new Date().toISOString() })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: new Date().toISOString(),
        synced_ends_at: new Date().toISOString(),
        synced_location: "SFU Burnaby",
      },
    ];

    const action = only((await run()).actions);
    expect(action.kind).toBe("cancel");
    expect(action.discordEventId).toBe("evt-1");
  });

  it("cancels when the tournament is archived", async () => {
    tournaments = [tournament({ status: "archived" })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: new Date().toISOString(),
        synced_ends_at: new Date().toISOString(),
        synced_location: "SFU Burnaby",
      },
    ];

    expect(only((await run()).actions).kind).toBe("cancel");
  });

  it("CANCELS an event whose tournament was DELETED outright", async () => {
    // deleteTournament is a hard DELETE, so there is no row left for the loop
    // to reach — and without this sweep it would be the one way of removing a
    // tournament that left its Discord event standing forever, while archiving,
    // suspending and completing all took it down.
    //
    // Reachable only because 00169 leaves tournament_id un-referenced: an
    // ON DELETE CASCADE would take the mapping and the event id with it.
    // The archived row is load-bearing: the sweep only runs on positive
    // evidence that `tournaments` is readable, and this row matches neither of
    // the route's working reads (wrong status, wrong id), so it reaches the
    // route only through the unfiltered liveness check.
    tournaments = [tournament({ id: "t-unrelated", status: "archived" })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: new Date().toISOString(),
        synced_ends_at: new Date().toISOString(),
        synced_location: "SFU Burnaby",
      },
    ];

    const action = only((await run()).actions);
    expect(action.kind).toBe("cancel");
    expect(action.tournamentId).toBe("t1");
    expect(action.discordEventId).toBe("evt-1");
  });

  it("CAPS the mapping read, and says when the cap bites", async () => {
    // What makes the sweep above safe. If the mapping read could hand back more
    // ids than the read that resolves them, everything past the ceiling would
    // come back missing and be cancelled in one tick.
    tournaments = [tournament({ id: "t-unrelated", status: "archived" })];
    mapped = Array.from({ length: 600 }, (_, i) => ({
      tournament_id: `t${i}`,
      discord_event_id: `evt-${i}`,
      synced_name: "Fall Open",
      synced_starts_at: new Date().toISOString(),
      synced_ends_at: new Date().toISOString(),
      synced_location: "SFU Burnaby",
    }));

    const { actions, skipped } = await run();

    expect(actions).toHaveLength(150);
    expect(skipped).toContainEqual({ tournamentId: "*", reason: "mapping_cap_reached" });
  });

  it("REFUSES to cancel everything when the tournaments read comes back empty", async () => {
    // A read that returns an EMPTY LIST with no error — missing grant, stale
    // schema cache — has bitten this codebase three times. Both of the route's
    // reads hit `tournaments`, so when that happens every mapping looks deleted
    // and the sweep wipes the server's Events tab in one tick, with nothing
    // anywhere reporting a failure. MAX_MAPPED cannot help: nothing truncated.
    tournaments = [];
    mapped = [1, 2, 3].map((n) => ({
      tournament_id: `t${n}`,
      discord_event_id: `evt-${n}`,
      synced_name: "Fall Open",
      synced_starts_at: new Date().toISOString(),
      synced_ends_at: new Date().toISOString(),
      synced_location: "SFU Burnaby",
    }));

    const { GET } = await import("../route");
    const res = await GET(req());

    expect(res.status).toBe(503);
    expect((await res.json()).actions).toBeUndefined();
  });

  it("FAILS CLOSED when the mapping read errors", async () => {
    // Treating it as "nothing announced yet" would create a SECOND Discord
    // event for every tournament that already has one, on every tick.
    readError.mapped = { code: "42P01", message: "relation does not exist" };
    const { GET } = await import("../route");
    expect((await GET(req())).status).toBe(503);
  });

  it("uses the tournament's OWN times and location over the club-wide keys", async () => {
    // HH:MM:SS, as PostgREST returns a time column. A reader that compared it
    // against HH:MM would call it malformed and quietly use 09:00.
    tournaments = [
      tournament({ starts_time: "10:30:00", ends_time: "16:00:00", location: "Central Gym" }),
    ];
    const action = only((await run()).actions);
    const club = (iso: string) =>
      new Date(iso).toLocaleTimeString("en-GB", {
        timeZone: "America/Vancouver",
        hour: "2-digit",
        minute: "2-digit",
      });
    expect(club(action.syncedStartsAt)).toBe("10:30");
    expect(club(action.syncedEndsAt)).toBe("16:00");
    expect(action.location).toBe("Central Gym");
  });

  it("takes each blank value from the club-wide key, then the default", async () => {
    tournaments = [tournament({ starts_time: "10:30:00", ends_time: null, location: null })];
    settings = [];
    const action = only((await run()).actions);
    const club = (iso: string) =>
      new Date(iso).toLocaleTimeString("en-GB", {
        timeZone: "America/Vancouver",
        hour: "2-digit",
        minute: "2-digit",
      });
    expect(club(action.syncedStartsAt)).toBe("10:30");
    expect(club(action.syncedEndsAt)).toBe("18:00");
    expect(action.location).toBeNull();
  });

  it("cuts a long location to Discord's 100 rather than sending one it refuses", async () => {
    tournaments = [tournament({ location: "x".repeat(200) })];
    expect(only((await run()).actions).location).toHaveLength(100);
  });

  it("offers an update when only the location changed", async () => {
    const first = only((await run()).actions);
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: first.syncedStartsAt,
        synced_ends_at: first.syncedEndsAt,
        synced_location: "SFU Burnaby",
      },
    ];
    tournaments = [tournament({ location: "Central Gym" })];

    const action = only((await run()).actions);
    expect(action.kind).toBe("update");
    expect(action.location).toBe("Central Gym");
    expect(action.patchTimes).toBe(true);
  });

  it("does not chase a location change onto a started event", async () => {
    // Discord only takes a location with the times, and it will not retime a
    // started event, so this is reported and left, not retried.
    tournaments = [tournament({ start_date: clubDay(-1), end_date: clubDay(2), location: "Central Gym" })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: "2020-01-01T00:00:00.000Z",
        synced_ends_at: "2020-01-02T00:00:00.000Z",
        synced_location: "SFU Burnaby",
      },
    ];

    const { actions, skipped } = await run();
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ tournamentId: "t1", reason: "started_cannot_retime" }]);
  });

  it("falls back rather than throwing on a malformed time setting", async () => {
    settings = [{ key: "tournament_event_start_time", value: "not a time" }];
    expect(only((await run()).actions).kind).toBe("create");
  });
});

describe("GET /api/discord/tournament-events, a tournament run as a club event", () => {
  const MAPPED = {
    tournament_id: "t1",
    discord_event_id: "evt-1",
    synced_name: "Fall Open",
    synced_starts_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    synced_ends_at: new Date(Date.now() + 8 * 86400000).toISOString(),
    synced_location: "SFU Burnaby",
  };

  beforeEach(() => {
    tournamentEvents = [{ id: "te1", tournament_id: "t1" }];
    clubEvents = [{ id: "ce1", status: "published", tournament_event_id: "te1" }];
  });

  it("does not post it, because the club event already carries it", async () => {
    const { actions, skipped } = await run();
    expect(actions).toEqual([]);
    expect(skipped).toContainEqual({ tournamentId: "t1", reason: "runs_as_club_event" });
  });

  it("takes down the duplicate it posted before the link", async () => {
    mapped = [MAPPED];
    const a = only((await run()).actions);
    expect(a).toMatchObject({ kind: "cancel", tournamentId: "t1", discordEventId: "evt-1" });
  });

  it("still posts it while club events are switched off, since nothing else would", async () => {
    featuresRow = { events_enabled: false };
    expect(only((await run()).actions).kind).toBe("create");
  });

  it("still posts it while the linked club event is only a draft", async () => {
    clubEvents = [{ id: "ce1", status: "draft", tournament_event_id: "te1" }];
    expect(only((await run()).actions).kind).toBe("create");
  });

  it("503s rather than guess when the link cannot be read, and cancels nothing", async () => {
    mapped = [MAPPED];
    for (const failing of ["clubEvents", "tournamentEvents"]) {
      readError = { [failing]: { code: "42501", message: "permission denied" } };
      const { GET } = await import("../route");
      const res = await GET(req());
      expect(res.status, failing).toBe(503);
    }
  });
});

describe("POST /api/discord/tournament-events", () => {
  it("records the mapping the bot confirmed", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/tournament-events", {
        method: "POST",
        body: JSON.stringify({
          tournamentId: "t1",
          guildId: "g1",
          discordEventId: "evt-1",
          name: "Fall Open",
          syncedStartsAt: "2026-09-01T16:00:00.000Z",
          syncedEndsAt: "2026-09-02T01:00:00.000Z",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upserted).toHaveBeenCalledWith(
      expect.objectContaining({
        tournament_id: "t1",
        guild_id: "g1",
        discord_event_id: "evt-1",
        synced_starts_at: "2026-09-01T16:00:00.000Z",
      }),
    );
  });

  it("records the location when the bot sends one, and leaves it alone when it does not", async () => {
    const { POST } = await import("../route");
    const mapping = {
      tournamentId: "t1",
      guildId: "g1",
      discordEventId: "evt-1",
      name: "Fall Open",
      syncedStartsAt: "2026-09-01T16:00:00.000Z",
      syncedEndsAt: "2026-09-02T01:00:00.000Z",
    };
    const post = (body: Record<string, unknown>) =>
      POST(req("/api/discord/tournament-events", { method: "POST", body: JSON.stringify(body) }));

    expect((await post({ ...mapping, location: "Central Gym" })).status).toBe(200);
    expect(upserted).toHaveBeenLastCalledWith(expect.objectContaining({ synced_location: "Central Gym" }));

    expect((await post({ ...mapping, location: null })).status).toBe(200);
    expect(upserted).toHaveBeenLastCalledWith(expect.objectContaining({ synced_location: null }));

    // A bot older than 00304 sends no location. Refusing it would leave a
    // posted event unrecorded, and the next tick would post a second one.
    expect((await post(mapping)).status).toBe(200);
    expect(upserted.mock.lastCall?.[0]).not.toHaveProperty("synced_location");

    expect((await post({ ...mapping, location: 42 })).status).toBe(400);
  });

  it("rejects a half-filled mapping instead of storing one", async () => {
    // A row missing synced_* would compare as changed forever.
    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/tournament-events", {
        method: "POST",
        body: JSON.stringify({ tournamentId: "t1", guildId: "g1", discordEventId: "evt-1" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(upserted).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/discord/tournament-events", () => {
  it("clears one mapping", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(
      req("/api/discord/tournament-events?tournamentId=t1&guildId=g1", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
    expect(deleted).toHaveBeenCalled();
  });

  it("refuses an unscoped delete", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(
      req("/api/discord/tournament-events?tournamentId=t1", { method: "DELETE" }),
    );

    expect(res.status).toBe(400);
    expect(deleted).not.toHaveBeenCalled();
  });
});
