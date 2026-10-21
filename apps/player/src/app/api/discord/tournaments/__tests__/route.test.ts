import { describe, it, expect, vi, beforeEach } from "vitest";

// The temptation this file exists to resist.
//
// /sessions had a real leak — `track` narrows what the website shows a member,
// and the bot was not applying it — and the obvious lesson is "filter every
// list per caller". Applied here that lesson is WRONG. `scope`, the column that
// looked like tournament eligibility, was dropped in 00109 for gating nothing,
// and the website's tournament list filters by nothing at all. What is real is
// `allowed_memberships`, and it governs ENTRY, not visibility. Filtering on it
// would make Discord show less than the site.
//
// So: annotate, never hide — and stay ephemeral, because the annotation is the
// per-caller part and it says which membership type the caller holds.

let tournaments: Record<string, unknown>[] = [];
type Caller = { id: string; membership_type: string; is_exec: boolean; fee_exempt: boolean };
let link: { players: Caller } | null = null;
let linkError: { message: string } | null = null;
let readError: { message: string } | null = null;
// This season's club fee rows (00260). Internal means paid.
let dues: { player_id: string; paid_at: string | null }[] = [];
let duesError: { message: string } | null = null;
let activeSeason: { id: string } | null = null;
let eventWindows: Record<string, unknown>[] = [];
let windowsError: { code?: string; message: string } | null = null;

function caller(membership_type: string, over: Partial<Caller> = {}): { players: Caller } {
  return { players: { id: "p1", membership_type, is_exec: false, fee_exempt: false, ...over } };
}

// The date filter is deliberately NOT stubbed, because the route no longer asks
// the database to do it. Expressing "coalesce(end_date, start_date) >= today" in
// PostgREST needs a nested or(...and(...)), and a filter PostgREST cannot parse
// comes back as an empty list with NO error — so a stub that no-ops .or(), like
// this one, would pass either way while /tournaments answered "nothing
// scheduled" forever in production. The coalesce lives in TypeScript now, and
// these tests reach it.
function thenable(data: unknown, error: unknown = null) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "or", "gte", "order", "limit", "in"]) builder[m] = () => builder;
  builder.maybeSingle = () => Promise.resolve({ data, error });
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data, error }).then(resolve);
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "player_discord_links") return thenable(link, linkError);
      if (table === "tournaments") return thenable(tournaments, readError);
      if (table === "seasons") return thenable(activeSeason);
      if (table === "tournament_events") return thenable(eventWindows, windowsError);
      if (table === "club_fees") return thenable(duesError ? null : dues, duesError);
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

let bucket = 0;
function req(caller?: string, params?: Record<string, string>) {
  const url = new URL("http://localhost/api/discord/tournaments");
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return new Request(url, {
    headers: {
      authorization: "Bearer test-secret",
      "x-forwarded-for": `10.8.0.${(bucket += 1)}`,
      ...(caller ? { "x-discord-user-id": caller } : {}),
    },
  });
}

interface Summary {
  id: string;
  name: string;
  inProgress?: boolean;
  eligible: boolean | null;
  registrationOpen: boolean;
  events: string[];
}

async function list(caller?: string, params?: Record<string, string>) {
  const { GET } = await import("../route");
  const res = await GET(req(caller, params));
  return {
    status: res.status,
    body: (await res.json()) as {
      tournaments?: Summary[];
      recentlyFinished?: { id: string; name: string }[];
      linked?: boolean;
      page?: number;
      totalPages?: number;
      total?: number;
      query?: string | null;
    },
  };
}

function only(rows: Summary[] | undefined): Summary {
  expect(rows).toHaveLength(1);
  return (rows as Summary[])[0] as Summary;
}

function clubDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("en-CA", {
    timeZone: "America/Vancouver",
  });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = "test-secret";
  link = null;
  linkError = null;
  readError = null;
  eventWindows = [];
  windowsError = null;
  dues = [{ player_id: "p1", paid_at: "2026-09-01T00:00:00Z" }];
  duesError = null;
  activeSeason = null;
  tournaments = [
    {
      id: "t1",
      name: "Internal Open",
      start_date: clubDay(18),
      end_date: clubDay(19),
      allowed_memberships: ["internal"],
      season_id: "s1",
      tournament_events: [
        { id: "e1", event_type: "mens_singles", status: "registration" },
        { id: "e2", event_type: "womens_doubles", status: "bracket_generated" },
      ],
    },
  ];
});

describe("GET /api/discord/tournaments", () => {
  it("refuses without the service secret", async () => {
    const { GET } = await import("../route");
    const bad = new Request("http://localhost/api/discord/tournaments", {
      headers: { authorization: "Bearer wrong" },
    });
    expect((await GET(bad)).status).toBe(401);
  });

  it("SHOWS a tournament the caller cannot enter, marked as such", async () => {
    // Not hidden. The website shows it, and finding out at the click is worse.
    link = caller("external");
    dues = [];
    const { body } = await list("d1");

    expect(only(body.tournaments).eligible).toBe(false);
    expect(body.linked).toBe(true);
  });

  it("marks one the caller can enter", async () => {
    link = caller("internal");
    expect(only((await list("d1")).body.tournaments).eligible).toBe(true);
  });

  it("says 'unknown' rather than 'no' for an unlinked caller", async () => {
    // null and false render differently in Discord: one offers /link, the other
    // tells somebody they are barred from something they may not be.
    const { body } = await list();

    expect(only(body.tournaments).eligible).toBeNull();
    expect(body.linked).toBe(false);
  });

  it("treats an empty allowed_memberships as open to everyone", async () => {
    tournaments = [{ ...(tournaments[0] as object), allowed_memberships: [] }];
    link = caller("external");
    dues = [];

    expect(only((await list("d1")).body.tournaments).eligible).toBe(true);
  });

  it("reports registration as open when any event is taking entries", async () => {
    link = caller("internal");
    expect(only((await list("d1")).body.tournaments).registrationOpen).toBe(true);
  });

  it("reports registration closed once every draw is generated", async () => {
    tournaments = [
      {
        ...(tournaments[0] as object),
        tournament_events: [{ id: "e1", event_type: "mens_singles", status: "live" }],
      },
    ];
    expect(only((await list()).body.tournaments).registrationOpen).toBe(false);
  });

  it("reports registration closed while the event's window has not opened", async () => {
    eventWindows = [{ id: "e1", registration_opens_at: "2999-01-01T00:00:00Z" }];
    expect(only((await list()).body.tournaments).registrationOpen).toBe(false);
  });

  it("reports registration closed once the event's window has closed", async () => {
    eventWindows = [{ id: "e1", registration_closes_at: "2000-01-01T00:00:00Z" }];
    expect(only((await list()).body.tournaments).registrationOpen).toBe(false);
  });

  it("ignores the windows on a database without 00276", async () => {
    windowsError = { code: "42703", message: "column does not exist" };
    expect(only((await list()).body.tournaments).registrationOpen).toBe(true);
  });

  it("is a 503 when the windows cannot be read", async () => {
    windowsError = { code: "57014", message: "canceling statement" };
    expect((await list()).status).toBe(503);
  });

  it("does NOT quietly degrade a failed link lookup to 'unlinked'", async () => {
    // That would drop the eligibility note for a member who has an account, and
    // the list would look correct while being less useful than it should be.
    linkError = { message: "relation does not exist" };
    expect((await list("d1")).status).toBe(503);
  });

  it("keeps a multi-day tournament that is already under way", async () => {
    // What matters is the LAST day, not the first — a member mid-tournament
    // still wants it in the list.
    tournaments = [
      { ...(tournaments[0] as object), start_date: clubDay(-1), end_date: clubDay(1) },
    ];
    expect(only((await list()).body.tournaments).id).toBe("t1");
  });

  it("drops one that finished yesterday", async () => {
    tournaments = [
      { ...(tournaments[0] as object), start_date: clubDay(-3), end_date: clubDay(-1) },
    ];
    expect((await list()).body.tournaments).toEqual([]);
  });

  it("treats a null end_date as a single-day tournament", async () => {
    // Both halves of the coalesce, because getting it backwards would either
    // hide every one-day tournament or keep them forever.
    tournaments = [
      { ...(tournaments[0] as object), id: "today", start_date: clubDay(0), end_date: null },
      { ...(tournaments[0] as object), id: "gone", start_date: clubDay(-1), end_date: null },
    ];

    const rows = (await list()).body.tournaments as Summary[];
    expect(rows.map((r) => r.id)).toEqual(["today"]);
  });

  // ---- internal means this season's club fee is paid (00260) ------------
  it("marks an unpaid internal member as unable to enter an internal-only tournament", async () => {
    link = caller("internal");
    dues = [];
    expect(only((await list("d1")).body.tournaments).eligible).toBe(false);
  });

  it("marks a paid member whose stored group is external as able to enter", async () => {
    link = caller("external");
    expect(only((await list("d1")).body.tournaments).eligible).toBe(true);
  });

  it("marks an exec as able to enter without a dues row", async () => {
    link = caller("internal", { is_exec: true });
    dues = [];
    expect(only((await list("d1")).body.tournaments).eligible).toBe(true);
  });

  it("uses the active season when the tournament has none", async () => {
    tournaments = [{ ...(tournaments[0] as object), season_id: null }];
    link = caller("internal");
    activeSeason = { id: "s-active" };
    dues = [];
    expect(only((await list("d1")).body.tournaments).eligible).toBe(false);
    // ...and with no season anywhere, nothing could have been paid, so the
    // stored group stands.
    activeSeason = null;
    expect(only((await list("d1")).body.tournaments).eligible).toBe(true);
  });

  it("does NOT guess when the dues read fails", async () => {
    link = caller("internal");
    duesError = { message: "boom" };
    expect((await list("d1")).status).toBe(503);
  });

  it("names a failed tournament read rather than reporting an empty schedule", async () => {
    readError = { message: "relation does not exist" };
    expect((await list()).status).toBe(503);
  });
});

// Paging here will be invisible for a while: the row is omitted below eleven
// upcoming tournaments and the club runs a handful. That is the design working,
// not the work missing, so the arithmetic is pinned by tests rather than by
// looking at Discord.
describe("GET /api/discord/tournaments: paging", () => {
  beforeEach(() => {
    tournaments = [
      // Fifteen that finished, which the coalesce filter drops, and twenty-five
      // still to come. The two counts differ on purpose: paging computed over
      // the window rather than over the filtered list would report four pages
      // and hand the bot a last page with nothing on it.
      ...Array.from({ length: 15 }, (_, i) => ({
        ...(tournaments[0] as object),
        id: `done-${i}`,
        start_date: clubDay(-9),
        end_date: clubDay(-8),
      })),
      ...Array.from({ length: 25 }, (_, i) => ({
        ...(tournaments[0] as object),
        id: `live-${i}`,
        name: i === 0 ? "Autumn Classic" : "Internal Open",
        start_date: clubDay(3 + i),
        end_date: null,
      })),
    ];
  });

  it("defaults to page 1 and counts the pages after the still-running filter", async () => {
    const { body } = await list();
    expect(body.page).toBe(1);
    expect(body.total).toBe(25);
    expect(body.totalPages).toBe(3);
    expect(body.tournaments).toHaveLength(10);
  });

  it("returns the second page of rows", async () => {
    const first = await list(undefined, { page: "1" });
    const second = await list(undefined, { page: "2" });
    const firstIds = (first.body.tournaments as Summary[]).map((t) => t.id);
    const secondIds = (second.body.tournaments as Summary[]).map((t) => t.id);

    expect(second.body.page).toBe(2);
    expect(secondIds).toHaveLength(10);
    for (const id of secondIds) expect(firstIds).not.toContain(id);
  });

  it("clamps a page past the end onto the last real page", async () => {
    const { body } = await list(undefined, { page: "99" });
    expect(body.page).toBe(3);
    expect(body.tournaments).toHaveLength(5);
  });

  it("treats zero, a negative page and a non-number as page 1", async () => {
    for (const page of ["0", "-1", "abc"]) {
      expect((await list(undefined, { page })).body.page).toBe(1);
    }
  });

  it("answers a search with the matches, on one page, and echoes it", async () => {
    const { body } = await list(undefined, { q: "AUTUMN" });
    expect((body.tournaments as Summary[]).map((t) => t.id)).toEqual(["live-0"]);
    expect(body.total).toBe(1);
    expect(body.totalPages).toBe(1);
    expect(body.query).toBe("autumn");
  });

  it("treats a whitespace-only search as no search at all", async () => {
    const { body } = await list(undefined, { q: "  " });
    expect(body.query).toBeNull();
    expect(body.total).toBe(25);
  });
});

// Tournaments happening now are the ones a member most wants, so they lead the
// list and say so; last week's are offered beside it, outside the pager.
describe("GET /api/discord/tournaments: in progress and recently finished", () => {
  const base = () => tournaments[0] as Record<string, unknown>;

  it("puts one that has started ahead of one still to come, and marks it", async () => {
    tournaments = [
      { ...base(), id: "later", start_date: clubDay(5), end_date: null },
      { ...base(), id: "now", start_date: clubDay(-1), end_date: clubDay(1) },
    ];
    const rows = (await list()).body.tournaments as Summary[];
    expect(rows.map((r) => [r.id, r.inProgress])).toEqual([
      ["now", true],
      ["later", false],
    ]);
  });

  it("counts a tournament with an event being played as in progress", async () => {
    tournaments = [
      { ...base(), id: "later", start_date: clubDay(5), end_date: null },
      {
        ...base(),
        id: "pools",
        start_date: clubDay(9),
        end_date: null,
        tournament_events: [{ id: "e9", event_type: "mens_singles", status: "pool_live" }],
      },
    ];
    const rows = (await list()).body.tournaments as Summary[];
    expect(rows.map((r) => r.id)).toEqual(["pools", "later"]);
    expect(rows[0]?.inProgress).toBe(true);
  });

  it("offers up to three that finished in the last week, newest first", async () => {
    tournaments = [
      { ...base(), id: "old", start_date: clubDay(-12), end_date: clubDay(-10) },
      { ...base(), id: "d2", start_date: clubDay(-2), end_date: null },
      { ...base(), id: "d1", start_date: clubDay(-1), end_date: null },
      { ...base(), id: "d3", start_date: clubDay(-4), end_date: clubDay(-3) },
      { ...base(), id: "d6", start_date: clubDay(-6), end_date: null },
      { ...base(), id: "today", start_date: clubDay(0), end_date: null },
    ];
    const { body } = await list();
    expect((body.recentlyFinished ?? []).map((t) => t.id)).toEqual(["d1", "d2", "d3"]);
    expect((body.tournaments as Summary[]).map((t) => t.id)).toEqual(["today"]);
  });

  it("offers none on a search", async () => {
    tournaments = [{ ...base(), id: "d1", start_date: clubDay(-1), end_date: null }];
    expect((await list(undefined, { q: "open" })).body.recentlyFinished).toEqual([]);
  });
});
