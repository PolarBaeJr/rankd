// Client for the badminton app's /api/discord/* surface.
//
// The bot NEVER talks to the database. Every answer comes from the app, through
// the same services the website uses, so registration rules, visibility rules and
// fee checks cannot drift between the two clients. That is the whole reason this
// indirection exists — see docs/design/discord-bot.md.

export interface LeaderboardEntry {
  rank: number;
  name: string;
  handle: string | null;
  rating: number;
  provisional: boolean;
  wins: number;
  losses: number;
  streak: number;
}

export interface LeaderboardPage {
  ladder: 'singles' | 'doubles' | 'points';
  page: number;
  totalPages: number;
  totalPlayers: number;
  entries: LeaderboardEntry[];
}

export interface SessionSummary {
  id: string;
  name: string | null;
  date: string;
  startTime: string | null;
  endTime: string | null;
  startsAt: string | null;
  location: string | null;
  track: string | null;
  going: number | null;
}

export class AppApiError extends Error {}

/**
 * The caller's Discord account is already connected to a club account.
 *
 * NOT an AppApiError. dispatch() renders every AppApiError as "couldn't reach
 * the club app", which would be a lie here -- the app answered, clearly, and
 * the answer was "no". Kept separate so handleLink can say what is true.
 */
export class AlreadyLinkedError extends Error {}

/**
 * The role named is one the nightly sweep controls, so it cannot be self-serve.
 *
 * Separate from AppApiError for the same reason AlreadyLinkedError is: the app
 * answered clearly and the answer was a specific, fixable "no". Rendering it as
 * "couldn't reach the club app" would send an exec looking for a network fault.
 */
export class SweepManagedRoleError extends Error {}

/**
 * The app answered 429: the caller has filed too much, too fast.
 *
 * Separate for the same reason as the two above. "Couldn't reach the club app"
 * would send a member retrying a request that is working exactly as designed,
 * and each retry pushes their next allowed attempt further out.
 */
export class RateLimitedError extends Error {}

// Deliberately short. Discord's interaction deadline is 3 seconds end to end, so
// a request that has not answered in 2.5s cannot be rendered in time anyway — and
// failing fast leaves room to reply with something useful instead of timing out
// silently, which Discord surfaces as "the application did not respond".
const TIMEOUT_MS = 2500;

// A caller that runs after a deferred acknowledgement has fifteen minutes, not
// three seconds, and passes a longer timeout; an autocomplete passes a shorter
// one so it answers inside its own budget.
async function get<T>(path: string, callerId?: string | null, timeoutMs = TIMEOUT_MS): Promise<T> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL(path, base), {
    headers: {
      authorization: `Bearer ${secret}`,
      // A HEADER, never a query param: ids in a URL end up in the access log.
      // Omitted entirely when there is no caller, so the app sees an absent
      // header rather than the string "null" or "undefined".
      ...(callerId ? { 'x-discord-user-id': callerId } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    // The body may carry an error code, but it may also be an HTML error page
    // from something in front of the app. Never interpolate it into a Discord
    // reply; log the status and keep the user-facing message generic.
    throw new AppApiError(`GET ${path} -> ${response.status}`);
  }

  return (await response.json()) as T;
}

async function send<T>(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = TIMEOUT_MS
): Promise<T> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    // 409 is the app telling us the role is one the nightly sweep controls.
    // Distinguished here so the command can explain the actual problem rather
    // than reporting a generic failure for a mistake with an obvious fix.
    if (response.status === 409) throw new SweepManagedRoleError('sweep-managed');
    if (response.status === 429) throw new RateLimitedError('rate-limited');
    throw new AppApiError(`${method} ${path} -> ${response.status}`);
  }

  return (await response.json()) as T;
}

export interface SelfRole {
  roleId: string;
  label: string;
  emoji: string | null;
  sortOrder: number;
}

/** The ping roles members may assign themselves in this guild. */
export function fetchSelfRoles(
  guildId: string
): Promise<{ roles: SelfRole[]; truncated: boolean }> {
  const params = new URLSearchParams({ guildId });
  return get<{ roles: SelfRole[]; truncated: boolean }>(
    `/api/discord/self-roles?${params}`
  );
}

export function addSelfRole(input: {
  guildId: string;
  roleId: string;
  label: string;
  emoji?: string | null;
  sortOrder?: number;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/self-roles', input);
}

export function removeSelfRole(guildId: string, roleId: string): Promise<{ ok: true }> {
  const params = new URLSearchParams({ guildId, roleId });
  return send<{ ok: true }>('DELETE', `/api/discord/self-roles?${params}`);
}

/**
 * Tell the app what a member picked for themselves in Discord.
 *
 * The ONE call in this file that runs Discord -> app. The app decides whether
 * the account is linked at all and refuses to write anything but membership_type
 * — see apps/player/src/app/api/discord/membership/route.ts for why that is a
 * boundary worth being pedantic about.
 */
export function setMembership(
  updates: readonly { discordUserId: string; membershipType: 'internal' | 'alumni' | 'external' }[]
): Promise<{ ok: true; updated: number; unchanged: number; skipped: number; failed: number }> {
  return send<{ ok: true; updated: number; unchanged: number; skipped: number; failed: number }>(
    'POST',
    '/api/discord/membership',
    { updates }
  );
}

export interface DuePing {
  sessionId: string;
  channelId: string;
  // Every role to mention in this ONE message. The app groups by channel so
  // that a club-wide session matching several ping roles does not produce the
  // same announcement twice in the same place.
  roleIds: string[];
  name: string | null;
  startsAt: string;
  location: string | null;
}

/** Sessions due a ping, decided entirely by the app. */
export function fetchDuePings(guildId: string): Promise<{ pings: DuePing[] }> {
  const params = new URLSearchParams({ guildId });
  return get<{ pings: DuePing[] }>(`/api/discord/session-pings?${params}`);
}

/** Record a ping that has ALREADY been posted. Never call this beforehand. */
export function recordPing(sessionId: string, roleIds: string[]): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/session-pings', { sessionId, roleIds });
}

export interface TournamentEventAction {
  kind: 'create' | 'update' | 'cancel';
  tournamentId: string;
  /** null only for a create. */
  discordEventId: string | null;
  name: string;
  /** What to SEND Discord — possibly clamped forward past a start already gone. */
  startsAt: string;
  endsAt: string;
  /** What the tournament ITSELF says. Recorded, so the change detector stays stable. */
  syncedStartsAt: string;
  syncedEndsAt: string;
  /**
   * False once Discord has started the event. Discord will not retime an event
   * in progress, so the PATCH carries name and description only — see the
   * app-side route, which is where the decision is made.
   */
  patchTimes: boolean;
  location: string | null;
  description: string;
}

/** Tournaments that owe Discord a scheduled event, or a change to one. */
export function fetchTournamentActions(guildId: string): Promise<{
  actions: TournamentEventAction[];
  skipped: { tournamentId: string; reason: string }[];
}> {
  const params = new URLSearchParams({ guildId });
  return get(`/api/discord/tournament-events?${params}`);
}

/** Record an event Discord has ALREADY accepted. Never call this beforehand. */
export function recordTournamentEvent(input: {
  tournamentId: string;
  guildId: string;
  discordEventId: string;
  name: string;
  syncedStartsAt: string;
  syncedEndsAt: string;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/tournament-events', input);
}

/** Forget a mapping, after the Discord event is gone. */
export function clearTournamentEvent(
  tournamentId: string,
  guildId: string
): Promise<{ ok: true }> {
  const params = new URLSearchParams({ tournamentId, guildId });
  return send<{ ok: true }>('DELETE', `/api/discord/tournament-events?${params}`);
}

export interface ClubEventAction {
  kind: 'create' | 'update' | 'cancel';
  eventId: string;
  /** null only for a create. */
  discordEventId: string | null;
  name: string;
  /** What to SEND Discord: possibly clamped forward past a start already gone. */
  startsAt: string;
  endsAt: string;
  /** What the club event ITSELF says. Recorded, so the change detector stays stable. */
  syncedStartsAt: string;
  syncedEndsAt: string;
  /** False once Discord has started the event and will no longer retime it. */
  patchTimes: boolean;
  location: string | null;
  description: string;
}

/** Club events that owe Discord a scheduled event, or a change to one. */
export function fetchClubEventActions(guildId: string): Promise<{
  actions: ClubEventAction[];
  skipped: { eventId: string; reason: string }[];
}> {
  const params = new URLSearchParams({ guildId });
  return get(`/api/discord/club-events?${params}`);
}

/** Record an event Discord has ALREADY accepted. Never call this beforehand. */
export function recordClubEvent(input: {
  eventId: string;
  guildId: string;
  discordEventId: string;
  name: string;
  syncedStartsAt: string;
  syncedEndsAt: string;
  /** The app's value, null when unset, never the fallback the bot sent. */
  location: string | null;
  description: string;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/club-events', input);
}

/** Forget a mapping, after the Discord event is gone. */
export function clearClubEvent(eventId: string, guildId: string): Promise<{ ok: true }> {
  const params = new URLSearchParams({ eventId, guildId });
  return send<{ ok: true }>('DELETE', `/api/discord/club-events?${params}`);
}

export interface TournamentSummary {
  id: string;
  name: string;
  startDate: string;
  endDate: string | null;
  events: string[];
  registrationOpen: boolean;
  /** null for an unlinked caller: "we do not know", not "no". */
  eligible: boolean | null;
}

export interface TournamentsPage {
  tournaments: TournamentSummary[];
  linked: boolean;
  page: number;
  totalPages: number;
  total: number;
  /** WHAT THE ROUTE APPLIED, not what was asked for. See fetchSessions. */
  query: string | null;
}

/**
 * Upcoming tournaments, annotated for THIS caller.
 *
 * The id is required rather than optional for the same reason fetchSessions's
 * is: a new call site that omitted it would silently get the anonymous view.
 * The page is optional for the same reason fetchSessions's is: the wrong page is
 * a cosmetic mistake and the wrong audience is not.
 */
export async function fetchTournaments(
  discordUserId: string | null,
  page = 1,
  q?: string
): Promise<TournamentsPage> {
  const params = new URLSearchParams({ page: String(page) });
  if (q) params.set('q', q);

  const body = await get<{
    tournaments: TournamentSummary[];
    linked: boolean;
    page?: number;
    totalPages?: number;
    total?: number;
    query?: string | null;
  }>(`/api/discord/tournaments?${params}`, discordUserId);

  return {
    ...body,
    page: body.page ?? 1,
    totalPages: body.totalPages ?? 1,
    total: body.total ?? body.tournaments.length,
    query: body.query ?? null,
  };
}

export function fetchLeaderboard(
  ladder: string,
  page: number
): Promise<LeaderboardPage> {
  const params = new URLSearchParams({ ladder, page: String(page) });
  return get<LeaderboardPage>(`/api/discord/leaderboard?${params}`);
}

export interface ClubHandle {
  handle: string;
  name: string;
}

/**
 * Every handle the ladder publishes, for the /profile picker.
 *
 * NAMES AND HANDLES ONLY. The route it calls reads the same ladder function the
 * handle lookup itself reads, so the suggestions are exactly the set a member
 * could already have found by typing — see the route for why that equivalence
 * is the privacy argument and not a coincidence.
 */
export function fetchHandles(): Promise<{ members: ClubHandle[] }> {
  return get<{ members: ClubHandle[] }>('/api/discord/handles');
}

export interface SessionsPage {
  sessions: SessionSummary[];
  linked: boolean;
  page: number;
  totalPages: number;
  /** How many MATCHED, which is more than the page holds. */
  total: number;
  /**
   * WHAT THE ROUTE APPLIED, not what was asked for, and the two are checked
   * against each other before anything is framed as a search or as a filter.
   * The bot and the app roll independently, so a bot asking an older player
   * image gets an unfiltered page back; announcing it as "3 matches for club
   * night" would be a wrong answer rather than a cosmetic one.
   */
  query: string | null;
  location: string | null;
  /** The distinct locations in the WINDOW, for the select. Ids are the route's. */
  locations: { id: string; label: string }[];
  /** Set only when the app's read window came back full, so `total` undercounts. */
  windowCapReached?: boolean;
}

/**
 * The schedule as THIS caller should see it.
 *
 * The id is required rather than optional so a new call site cannot quietly
 * omit it and get the unlinked view for everybody — the compiler asks. Pass
 * null only where there genuinely is no caller.
 *
 * THE ASYMMETRY IS DELIBERATE: the caller id is required and the page is not.
 * A defaulted audience widens what somebody sees, which is silent and serious; a
 * defaulted page is page 1, which is what the public board and every first reply
 * want anyway.
 */
export async function fetchSessions(
  discordUserId: string | null,
  page = 1,
  q?: string,
  location?: string
): Promise<SessionsPage> {
  // URLSearchParams rather than interpolation: a session name goes in `q`, and
  // it is club-authored text with spaces and punctuation in it.
  const params = new URLSearchParams({ page: String(page) });
  if (q) params.set('q', q);
  if (location) params.set('location', location);

  const body = await get<{
    sessions: SessionSummary[];
    linked: boolean;
    page?: number;
    totalPages?: number;
    total?: number;
    query?: string | null;
    location?: string | null;
    locations?: { id: string; label: string }[];
    windowCapReached?: boolean;
  }>(`/api/discord/sessions?${params}`, discordUserId);

  // Optional on the wire, required in the model. The bot and the app deploy
  // independently, so the bot can be running against an image that predates
  // these fields; defaulting `total` to the rows that arrived makes that read as
  // "this is all of them" rather than printing a truncation that is not
  // happening, and defaulting the echoes to "nothing applied" is what makes the
  // checks at the call sites fail closed.
  return {
    ...body,
    page: body.page ?? 1,
    totalPages: body.totalPages ?? 1,
    total: body.total ?? body.sessions.length,
    query: body.query ?? null,
    location: body.location ?? null,
    locations: body.locations ?? [],
  };
}

/** Which servers to manage, their role ids, and where the audit log goes. */
export interface BotConfigPayload {
  guilds: { guildId: string; roles: Record<string, string> }[];
  auditChannelId: string | null;
}

export function fetchBotConfig(): Promise<BotConfigPayload> {
  return get<BotConfigPayload>('/api/discord/config');
}

/**
 * Every linked member and what the app currently believes about them.
 *
 * The sweep's input. `state` is null for a link the app can no longer resolve to
 * a player — a deleted account, a merged-away duplicate — which the sync treats
 * as "strip everything".
 */
export interface LinkedMemberRow {
  discordUserId: string;
  state: {
    status: 'competitive' | 'recreational' | 'pending_approval' | 'suspended';
    membershipType: 'internal' | 'alumni' | 'external';
    isExec: boolean;
    isBanned: boolean;
    permissionRole: 'finance' | 'tournaments' | 'internal' | 'external' | 'custom' | null;
    capabilities: string[];
  } | null;
}

/**
 * Deliberately NOT on the 2.5s interaction budget. This one is called by the
 * reconciliation sweep, which nobody is watching a "thinking..." spinner for,
 * and the whole roster does not arrive in the time a single slash command has.
 */
export async function fetchLinkedMembers(): Promise<LinkedMemberRow[]> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/members', base), {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new AppApiError(`GET /api/discord/members -> ${response.status}`);

  const body = (await response.json()) as { members?: LinkedMemberRow[] };
  return body.members ?? [];
}

/**
 * Whether the app has this member banned.
 *
 * THE WHOLE ROSTER, FILTERED HERE. /api/discord/members takes no filter, and
 * the answer is not on the route a member's own click already calls: the
 * membership write deliberately reads nothing back. So this asks the list the
 * sweep asks for and picks one id out of it, rather than growing a second route
 * to the same rows.
 *
 * NOT fetchLinkedMembers(), and the difference is the timeout. That one allows
 * itself 30 seconds because nobody is watching a sweep; this runs inside a
 * button click, so it goes through get() and gives up at 2.5s, leaving the
 * caller room to refuse inside Discord's 3-second deadline.
 *
 * False for an id the app does not know. That is not a ban, it is an unlinked
 * account, and the caller already has an answer for those. THROWS rather than
 * answering false when the read fails: "I could not find out" and "they are in
 * good standing" are different answers, and only the caller can decide what to
 * do about the first.
 */
export async function isMemberBanned(discordUserId: string): Promise<boolean> {
  const body = await get<{ members?: LinkedMemberRow[] }>('/api/discord/members');
  const row = (body.members ?? []).find((m) => m.discordUserId === discordUserId);
  return row?.state?.isBanned ?? false;
}

/**
 * Tell the app which tombstoned accounts are now actually clean.
 *
 * Failure here is deliberately NOT fatal to the sweep: the roles have already
 * been removed by the time this runs, and the only cost of the tombstone
 * surviving is that the next sweep visits an account that has nothing left to
 * strip. Losing the sweep's result over a bookkeeping call would be the worse
 * trade.
 */
export async function clearRevocations(discordUserIds: readonly string[]): Promise<void> {
  if (discordUserIds.length === 0) return;

  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/members', base), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ discordUserIds }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new AppApiError(`DELETE /api/discord/members -> ${response.status}`);
  }
}

/**
 * Mint a one-time link token and get back the URL the member should open.
 *
 * ON THE INTERACTION BUDGET, unlike fetchLinkedMembers: Discord gives roughly
 * three seconds for a first response, so this uses a short timeout and would
 * rather fail fast into a "try again" than hold the interaction open until
 * Discord gives up on it and shows the member "the application did not respond".
 */
export async function mintLinkToken(
  discordUserId: string,
  guildId: string | null
): Promise<{ url: string; expiresAt: string }> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  const publicBase = process.env.APP_PUBLIC_URL;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');
  // The member's browser has to reach this, so it cannot be the in-cluster
  // http://player:3000 that APP_API_URL is. Separate variable on purpose.
  if (!publicBase) throw new AppApiError('APP_PUBLIC_URL is not set');

  const response = await fetch(new URL('/api/discord/link-tokens', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ discordUserId, guildId }),
    signal: AbortSignal.timeout(2_000),
  });
  // 409 is the app declining on purpose, not a fault: this Discord account
  // already has a link row. Distinguished from every other non-ok status so
  // the member is told to /unlink rather than told the app is down.
  if (response.status === 409) {
    throw new AlreadyLinkedError('already linked');
  }
  if (!response.ok) {
    throw new AppApiError(`POST /api/discord/link-tokens -> ${response.status}`);
  }

  const body = (await response.json()) as { token?: string; expiresAt?: string };
  if (!body.token || !body.expiresAt) throw new AppApiError('mint returned no token');

  // Path segment rather than ?token=. Query strings are the part of a URL that
  // leaks most readily — into referrers, into analytics, into server logs that
  // record the query and not the path.
  return {
    url: new URL(`/link/${body.token}`, publicBase).toString(),
    expiresAt: body.expiresAt,
  };
}

/** Remove the caller's link. Returns false when they were not linked at all. */
export async function deleteLink(discordUserId: string): Promise<boolean> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/link', base), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ discordUserId }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new AppApiError(`DELETE /api/discord/link -> ${response.status}`);

  const body = (await response.json()) as { unlinked?: boolean };
  return body.unlinked === true;
}

// ---- FORCE LINK ------------------------------------------------------------

/** Why the app declined to link by hand. Closed set; see the route. */
export type ForceLinkRefusal =
  | 'not_linked'
  | 'not_permitted'
  | 'no_such_member'
  | 'already_linked_elsewhere'
  | 'no_reason';

export type ForceLinkResult =
  | {
      ok: true;
      /** The account this member was linked to before, which is now loose. */
      displacedDiscordUserId: string | null;
      memberName: string | null;
      /** The link already named this account, so nothing actually moved. */
      alreadyThatAccount: boolean;
    }
  | { ok: false; refusal: ForceLinkRefusal };

/**
 * Attach a Discord account to a club member on an officer's word, for /forcelink.
 *
 * TWO DISCORD IDS, AND THEY ARE NOT INTERCHANGEABLE. `discordUserId` is the
 * CALLER, the officer who typed the command, and it is what the app resolves to a
 * club account to check `players.discordlink.write` against. Swapping the two
 * would ask the app whether the member being linked is allowed to link
 * themselves, which is the whole gate inverted.
 *
 * A BESPOKE FETCH RATHER THAN send(), for two independent reasons:
 *
 *   send()'s TIMEOUT_MS is 2.5s (see the constant), sized for a command racing
 *   Discord's three-second interaction deadline. /forcelink defers first, so it
 *   is not racing that, and this route makes about six round trips: the caller
 *   read, the member read, the conflict read, the current-link read, the upsert
 *   and the audit insert. Failing at 2.5s would abandon a write that was about
 *   to succeed, and a half-done one here means a link row with no audit row.
 *
 *   send() maps 409 to SweepManagedRoleError and 429 to RateLimitedError, and
 *   both sentences would be wrong here. This route answers neither status: every
 *   refusal it has arrives as a 200 carrying a code, for the reason its own
 *   header gives.
 *
 * The `refusal` is matched against the union above at the call site rather than
 * printed. Nothing the app puts in a response body is ever interpolated into a
 * Discord message.
 */
export async function forceLinkDiscordAccount(input: {
  discordUserId: string;
  targetDiscordUserId: string;
  handle: string;
  reason: string;
}): Promise<ForceLinkResult> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/force-link', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new AppApiError(`POST /api/discord/force-link -> ${response.status}`);
  }

  return (await response.json()) as ForceLinkResult;
}

// ---- FORCE UNLINK ----------------------------------------------------------

/** Why the app declined to disconnect an account. Closed set; see the route. */
export type ForceUnlinkRefusal =
  | 'not_linked'
  | 'not_permitted'
  | 'no_reason'
  | 'target_not_linked';

export type ForceUnlinkResult =
  | { ok: true; memberName: string | null }
  | { ok: false; refusal: ForceUnlinkRefusal };

/**
 * Disconnect ANOTHER member's Discord account, for /forceunlink.
 *
 * TWO DISCORD IDS, AND THEY ARE NOT INTERCHANGEABLE. `discordUserId` is the
 * CALLER, the officer who typed the command, and it is what the app resolves to
 * a club account to check `players.discordlink.write` against.
 * `targetDiscordUserId` is the account being disconnected. Swapping the two
 * would ask the app whether the member being unlinked may unlink themselves,
 * which is the whole gate inverted.
 *
 * A BESPOKE FETCH RATHER THAN send(), for /forcelink's two reasons: send()'s
 * 2.5s timeout is sized for a command racing Discord's three-second deadline
 * and this command defers first, and send() maps 409 to SweepManagedRoleError
 * and 429 to RateLimitedError, neither of which this route ever answers. Every
 * refusal it has arrives as a 200 carrying a code.
 *
 * 10 seconds, because the route makes four round trips: the caller read, the
 * target read, the delete and the audit insert. Failing early would abandon a
 * delete that was about to succeed and leave a link row with no audit row.
 *
 * The `refusal` is matched against the union above at the call site rather than
 * printed. Nothing the app puts in a response body is ever interpolated into a
 * Discord message.
 */
export async function forceUnlinkDiscordAccount(input: {
  discordUserId: string;
  targetDiscordUserId: string;
  reason: string;
}): Promise<ForceUnlinkResult> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/force-unlink', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new AppApiError(`POST /api/discord/force-unlink -> ${response.status}`);
  }

  return (await response.json()) as ForceUnlinkResult;
}

// ---- FORCE SYNC ------------------------------------------------------------

/** Why the app declined to re-apply a member's roles. Closed set; see the route. */
export type ForceSyncRefusal = 'not_linked' | 'not_permitted' | 'target_not_linked';

export type ForceSyncResult =
  | { ok: true; memberName: string | null }
  | { ok: false; refusal: ForceSyncRefusal };

/**
 * May this officer re-apply one member's roles, and is that account linked at
 * all, for /forceupdate.
 *
 * THIS CALL WRITES NOTHING. It is the permission check plus the one fact the
 * bot cannot learn on its own: whether the target has a link row. That second
 * half is not a formality. syncMembersNow() reads an id absent from the roster
 * as "strip everything", so running the resync against an unlinked account
 * would be a silent full strip nobody asked for.
 *
 * 5 seconds, between force-unlink's 10 and the picker's 2: two reads and no
 * write, and the command has deferred, so it is not racing the three-second
 * deadline.
 */
export async function forceSyncMember(input: {
  discordUserId: string;
  targetDiscordUserId: string;
}): Promise<ForceSyncResult> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/force-sync', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new AppApiError(`POST /api/discord/force-sync -> ${response.status}`);
  }

  return (await response.json()) as ForceSyncResult;
}

// ---- LINKED ACCOUNTS -------------------------------------------------------

/** One row of the officer picker: a readable label over a raw snowflake. */
export interface LinkedAccountChoice {
  name: string;
  value: string;
}

export type LinkedAccountsResult =
  | { ok: true; choices: LinkedAccountChoice[] }
  | { ok: false; refusal: 'not_linked' | 'not_permitted' };

/**
 * Connected accounts matching what the officer has typed so far, for the
 * /forceunlink and /forceupdate pickers.
 *
 * TWO SECONDS, AND IT IS NOT WHAT KEEPS THE INTERACTION ALIVE. Discord gives an
 * autocomplete about three seconds in total and DISCARDS a late answer, but the
 * deadline is already held in index.ts, which races this call against
 * AUTOCOMPLETE_BUDGET_MS and answers with an empty list at one second whatever
 * this is set to. What this timeout does is stop the abandoned request
 * outliving the interaction it was for. It is tighter than get()'s shared 2.5s
 * anyway, which is the opposite trade to the two commands above: they have
 * deferred and would rather wait than abandon a write.
 *
 * The caller's id still goes with it: this route carries the SAME capability
 * check the acts do, because an ungated list of every linked member is an
 * oracle for the members the ladder deliberately hides.
 */
export async function fetchLinkedAccounts(input: {
  discordUserId: string;
  query: string;
}): Promise<LinkedAccountsResult> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/linked-accounts', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(2_000),
  });

  if (!response.ok) {
    throw new AppApiError(`POST /api/discord/linked-accounts -> ${response.status}`);
  }

  return (await response.json()) as LinkedAccountsResult;
}

/**
 * Write a guild's role map, for /setup.
 *
 * Its own timeout rather than the 2.5s shared one: /setup answers Discord with
 * a deferred reply before it gets here, so it is not racing the 3-second
 * interaction deadline, and it may be creating nine roles first. Failing this
 * at 2.5s would abandon a write that was about to succeed and leave the guild
 * half-configured.
 */
export async function writeGuildConfig(payload: {
  guildId: string;
  label?: string;
  roles: Record<string, string>;
  auditChannelId?: string;
}): Promise<void> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/config', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new AppApiError(`POST /api/discord/config -> ${response.status}`);
  }
}

/**
 * Write the guild's CATALOGUE of mentionable roles, for the console's notify
 * picker (00229).
 *
 * A DIFFERENT ROUTE FROM writeGuildConfig ABOVE, AND THAT IS THE POINT. That one
 * writes the nine roles the app ASSIGNS, and its payload comes back out of
 * /api/discord/config into `registryFromPayload`, which throws on any name
 * outside MANAGED_ROLES: one arbitrary role in there takes the bot's whole
 * config load down. This one writes a list of names the console may MENTION,
 * into a table nothing else reads.
 *
 * The route REPLACES the guild's rows, so an empty list is refused rather than
 * obeyed: see its own comment. Callers must post nothing at all when they could
 * not read the guild's roles.
 *
 * Its own 10s timeout, like writeGuildConfig, because this is called from /setup
 * after a deferred reply and from a five minute tick. Neither is racing Discord's
 * 3-second interaction deadline, and 250 rows is a bigger body than the shared
 * 2.5s budget was chosen for.
 */
export async function writeServerRoleCatalog(payload: {
  guildId: string;
  roles: { roleId: string; name: string; position?: number }[];
}): Promise<void> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');

  const response = await fetch(new URL('/api/discord/server-roles', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // 429 is mapped for the same reason `send` maps it: the callers of this
    // either log and continue (/setup) or count a failure (the tick), and
    // neither should report a rate limit as an unreachable app.
    if (response.status === 429) throw new RateLimitedError('rate-limited');
    throw new AppApiError(`POST /api/discord/server-roles -> ${response.status}`);
  }
}

/**
 * The club's links for /socials: the socials switch, show_discord and the
 * Instagram URL, each already checked by the app. The invite URL is not in it;
 * the bot has its own constant.
 */
export function fetchClubSocials(): Promise<{
  enabled: boolean;
  showDiscord: boolean;
  instagramUrl: string | null;
}> {
  return get('/api/discord/socials');
}

// ---- RUNTIME SETTINGS ------------------------------------------------------
//
// The key/value rows every relay reads to decide where it posts. Separate from
// writeGuildConfig above because that route refuses a payload with no roles in
// it -- moving the announcement channel is not a role change.

/** Every setting the club has actually set, keyed as it is in the database. */
export function fetchDiscordSettings(): Promise<{ settings: Record<string, string> }> {
  return get<{ settings: Record<string, string> }>('/api/discord/settings');
}

/**
 * Write settings, or clear them.
 *
 * A NULL VALUE DELETES THE KEY, and that is the only way to turn a relay back
 * off: every one of them treats a missing key as "post nothing", and an empty
 * string is not the same thing -- it survives the `?? null` that two of the
 * routes use and would leave a relay pointed at a channel id of ''.
 */
export function writeDiscordSettings(
  settings: Record<string, string | null>
): Promise<{ ok: true; written: number; cleared: number }> {
  return send<{ ok: true; written: number; cleared: number }>(
    'POST',
    '/api/discord/settings',
    { settings }
  );
}

// ---- SESSION BOARD ---------------------------------------------------------
//
// Separate from the settings pair above because the channel and the state are
// different kinds of thing: the channel is an exec's decision, set with /config
// and validated by the settings route's whitelist, while the state is the tick's
// own bookkeeping. The route these two call refuses any field it does not know,
// which is what keeps a page out of the row.
//
// BOTH INHERIT TIMEOUT_MS, which is sized for Discord's interaction deadline and
// not for a cron tick. Kept anyway: a timeout here defers the board to the next
// tick five minutes later, and nothing is waiting on a spinner, so the 30s
// variant fetchLinkedMembers uses would buy a slower failure and nothing else.

export interface SessionBoardState {
  /** Where the message actually is, which is not always the configured channel. */
  channelId: string;
  messageId: string | null;
  /** A post was started and not confirmed. The tick refuses to post again. */
  pending: boolean;
  fingerprint: string | null;
  postedAt: string | null;
  reposts: number;
  repostWindowStart: string | null;
}

/** Where the board should be, and what the last tick left behind. */
export function fetchSessionBoard(): Promise<{
  channelId: string | null;
  state: SessionBoardState | null;
}> {
  return get<{ channelId: string | null; state: SessionBoardState | null }>(
    '/api/discord/session-board'
  );
}

/**
 * Record the board, or forget it.
 *
 * NULL FORGETS THE WHOLE ROW, counters included, and that is only ever right
 * after a human has touched the setting. Everything else writes the full object:
 * the route stores it as one string so `pending` and `messageId` can never
 * disagree.
 */
export function writeSessionBoard(state: SessionBoardState | null): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/session-board', { state });
}

// ---- ANNOUNCEMENT RELAY ----------------------------------------------------

export interface AnnouncementAction {
  kind: 'post' | 'edit' | 'retract';
  announcementId: string;
  /** For an edit or retract this is the channel the message IS in, which is not
   *  necessarily the configured one — a club that repoints the setting has not
   *  moved the messages it already posted. */
  channelId: string;
  /** null only for a post. */
  discordMessageId: string | null;
  title: string;
  body: string;
  /** announcement_type: info | warning | urgent | event. Picks the colour. */
  type: string;
  url: string | null;
}

/** Announcements that owe Discord a message, or a change to one. */
export function fetchAnnouncementActions(guildId: string): Promise<{
  actions: AnnouncementAction[];
  skipped: { announcementId: string; reason: string }[];
}> {
  const params = new URLSearchParams({ guildId });
  return get(`/api/discord/announcements?${params}`);
}

/** Record a message Discord has ALREADY accepted. Never call this beforehand. */
export function recordAnnouncementPost(input: {
  announcementId: string;
  guildId: string;
  channelId: string;
  discordMessageId: string;
  title: string;
  body: string;
  type: string;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/announcements', input);
}

// ---------------------------------------------------------------------------
// The outbox — messages the console asked for (00222)
// ---------------------------------------------------------------------------

export interface OutboxMessage {
  id: string;
  channelId: string;
  /** A plain message, exactly like /say. Null when this is an embed. */
  content: string | null;
  embed: { title: string; body: string; type: string } | null;
  /** Whether mentions in the text are allowed to notify. Default is silence. */
  ping: boolean;
  attempts: number;
  /**
   * The message this row already is in Discord, or null when it is new.
   *
   * THE ONLY SIGNAL THAT A CLAIMED ROW IS AN EDIT. The console re-queues a sent
   * row with new text and keeps this id, so a row that carries one is a
   * correction to a message members can already read: it is PATCHed in place,
   * never posted a second time underneath the first.
   */
  discordMessageId: string | null;
  /**
   * The name of the exec who asked for it, for the audit entry. Null when the
   * row's requester was deleted, or when the app could not resolve the name —
   * the entry still gets written, it just cannot say who.
   */
  requestedBy: string | null;
  /**
   * The member buttons this message carries, as a NAMED SET, or null for none.
   *
   * A NAME, RESOLVED HERE, NEVER A PAYLOAD. `componentsForButtonSet` in
   * commands.ts turns it into real components, beside the handlers that answer
   * them. The row cannot carry component JSON because the insert path is a
   * server action in the admin console, and every field on one of those is a
   * client-controlled POST field: a column holding raw JSON would be a way to
   * make the club's bot post an arbitrary Discord payload.
   *
   * An older relay route sends no such field, which arrives as `undefined` and
   * resolves to no components.
   */
  buttonSet: string | null;
}

/**
 * CLAIM the next few, do not merely read them.
 *
 * The endpoint takes the claim in the same statement it returns the rows, so
 * calling this TAKES OWNERSHIP: whatever comes back is this process's to post,
 * and no other replica will be given it for ten minutes. Anything claimed and
 * not resolved through recordOutboxResult comes back into the pool then.
 */
export function claimOutboxMessages(guildId: string): Promise<{ messages: OutboxMessage[] }> {
  const params = new URLSearchParams({ guildId });
  return get(`/api/discord/outbox?${params}`);
}

/**
 * Say what Discord did. Exactly one of the two outcomes.
 *
 * `discordMessageId` closes the row for good. `error` spends one attempt and
 * releases the claim, so a transient refusal is retried and a permanent one
 * stops after three with the reason still readable in the console — which is
 * the only thing that will get it fixed.
 */
export function recordOutboxResult(input: {
  id: string;
  discordMessageId?: string;
  error?: string;
  /**
   * Something worth saying about a message that DID go out, which is not a
   * third outcome: it rides along with `discordMessageId`, so the row is closed
   * as sent and the note is what the console shows underneath it. The one case
   * today is a message Discord took without its buttons.
   */
  note?: string;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/outbox', input);
}

/** Forget a mapping, after the Discord message is gone. */
export function clearAnnouncementPost(
  announcementId: string,
  guildId: string
): Promise<{ ok: true }> {
  const params = new URLSearchParams({ announcementId, guildId });
  return send<{ ok: true }>('DELETE', `/api/discord/announcements?${params}`);
}

// ---- MATCH RESULT RELAY ----------------------------------------------------

export interface MatchResultAction {
  kind: 'post' | 'edit' | 'retract';
  matchId: string;
  /** For an edit or retract this is the channel the message IS in, which is not
   *  necessarily the configured one — a club that repoints the setting has not
   *  moved the messages it already posted. */
  channelId: string;
  /** null only for a post. */
  discordMessageId: string | null;
  /** Rendered line, and the mapping's change-detection key. */
  summary: string;
  teamA: string;
  teamB: string;
  score: string;
  /** Which side won. null only on a retract, where there is nothing to render. */
  winner: 'a' | 'b' | null;
  /** singles | doubles. */
  matchType: string;
  playedAt: string | null;
}

/** Confirmed results that owe Discord a message, or a change to one. */
export function fetchMatchResultActions(guildId: string): Promise<{
  actions: MatchResultAction[];
  skipped: { matchId: string; reason: string }[];
  /** Present when the tick's read hit its cap. NOT decoration: a capped window
   *  is the one condition under which a match that should be posted, or one
   *  that should be taken down, is silently deferred to a later tick. If it is
   *  set every tick, the window is too small for the club's volume. */
  windowCapReached?: number;
}> {
  const params = new URLSearchParams({ guildId });
  return get(`/api/discord/match-results?${params}`);
}

/** Record a message Discord has ALREADY accepted. Never call this beforehand. */
export function recordMatchPost(input: {
  matchId: string;
  guildId: string;
  channelId: string;
  discordMessageId: string;
  summary: string;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/match-results', input);
}

/** Forget a mapping, after the Discord message is gone. */
export function clearMatchPost(matchId: string, guildId: string): Promise<{ ok: true }> {
  const params = new URLSearchParams({ matchId, guildId });
  return send<{ ok: true }>('DELETE', `/api/discord/match-results?${params}`);
}

// ---- FEEDBACK AND BUG REPORTS ----------------------------------------------

export type FeedbackKind = 'bug' | 'feedback' | 'tournament_feedback' | 'other';

/**
 * File one report. See 00172.
 *
 * `linked` comes back so the caller can warn a reporter whose Discord account
 * is not connected to a club account that a reply may not reach them. The row
 * is stored either way — an unlinked member is the one most likely to have hit
 * an onboarding bug, and turning them away would silence exactly that report.
 */
export function submitFeedback(input: {
  kind: FeedbackKind;
  /** null for a report filed by anything that is not the modal. */
  title: string | null;
  body: string;
  /** Discord CDN url of a screenshot. SIGNED AND EXPIRING — see 00173. */
  imageUrl: string | null;
  discordUserId: string | null;
  guildId: string | null;
}): Promise<{ ok: true; linked: boolean }> {
  return send<{ ok: true; linked: boolean }>('POST', '/api/discord/feedback', input);
}

// ---- ANNOUNCE --------------------------------------------------------------

/** Why the app declined to file an announcement. Closed set; see the route. */
export type AnnounceRefusal = 'not_linked' | 'not_permitted' | 'no_active_season';

/**
 * File a club announcement, or learn why not.
 *
 * REFUSALS COME BACK AS A 200 WITH A CODE rather than a 4xx, and that is the
 * app's decision rather than this client's -- send() turns every non-ok status
 * into an AppApiError, which dispatch renders as "couldn't reach the club app",
 * and all three refusals here are the app being reached and answering clearly.
 * The route's header explains why it answers this way; this signature is the
 * half of the contract the bot has to honour.
 *
 * The `refusal` is matched against the union above at the call site rather than
 * printed. Nothing the app puts in a response body is ever interpolated into a
 * Discord message.
 */
export function submitAnnouncement(input: {
  discordUserId: string | null;
  title: string;
  body: string;
  type: 'info' | 'warning' | 'urgent' | 'event';
  pin: boolean;
  draft: boolean;
  evergreen: boolean;
}): Promise<
  | { ok: true; announcementId: string; status: 'draft' | 'published' }
  | { ok: false; refusal: AnnounceRefusal }
> {
  return send('POST', '/api/discord/announce', input);
}

// ---- CHALLENGES ------------------------------------------------------------

/**
 * Why the app declined a /challenge. Closed set; see the challenges routes.
 * 'rule' and the two 'invalid' codes are the only ones that carry a message,
 * and it is the app's own sentence about the club's rules.
 */
export type ChallengeRefusal =
  | 'not_linked'
  | 'lapsed'
  | 'standing'
  | 'feature_off'
  | 'waiver'
  | 'opponent_not_linked'
  | 'partner_not_linked'
  | 'opponent_partner_not_linked'
  | 'not_participant'
  | 'not_accepted'
  | 'invalid'
  | 'invalid_score'
  | 'invalid_duration'
  | 'rule';

export type ChallengeReply<T> = (T & { ok: true }) | { ok: false; refusal: ChallengeRefusal; message?: string };

/** Both run after a deferred acknowledgement, so they can wait. */
const CHALLENGE_TIMEOUT_MS = 10_000;

/** Inside the autocomplete branch's one-second race, with room to answer. */
const CHALLENGE_PICKER_TIMEOUT_MS = 900;

/**
 * Send a challenge as the caller. Every person is a Discord id; the app
 * resolves each through the link table and never takes a club player id.
 */
export function createChallenge(input: {
  discordUserId: string;
  opponentDiscordId: string;
  type: 'singles' | 'doubles';
  rated: boolean;
  bestOf: number;
  points: number;
  partnerDiscordId: string | null;
  opponentPartnerDiscordId: string | null;
  note: string | null;
}): Promise<ChallengeReply<{ challengeId: string }>> {
  return send('POST', '/api/discord/challenges', input, CHALLENGE_TIMEOUT_MS);
}

/** The caller's accepted challenges with no result yet, labelled for a picker. */
export async function fetchOpenChallenges(
  discordUserId: string
): Promise<{ id: string; label: string }[]> {
  const result = await get<{ challenges?: { id: string; label: string }[] }>(
    '/api/discord/challenges',
    discordUserId,
    CHALLENGE_PICKER_TIMEOUT_MS
  );
  return result.challenges ?? [];
}

/** Report a result as the caller: their side's points first in every game. */
export function reportChallenge(input: {
  discordUserId: string;
  challengeId: string;
  games: { mine: number; theirs: number }[];
  durationMinutes: number;
}): Promise<ChallengeReply<{ matchId: string; opponents: string }>> {
  return send('POST', '/api/discord/challenges/report', input, CHALLENGE_TIMEOUT_MS);
}

// ---- FEE RECEIPTS ----------------------------------------------------------

/**
 * Why the app declined a /receipt. Closed set; see the receipts route. 'rule'
 * and 'invalid' carry the app's own sentence; 'file' carries which check the
 * screenshot failed.
 */
export type ReceiptRefusal =
  | 'not_linked'
  | 'lapsed'
  | 'standing'
  | 'feature_off'
  | 'waiver'
  | 'no_login'
  | 'invalid'
  | 'rule'
  | 'file';

export type ReceiptFileFailure = 'bad_url' | 'unreachable' | 'too_large' | 'not_image';

export type ReceiptReply =
  | { ok: true }
  | { ok: false; refusal: ReceiptRefusal; message?: string; file?: ReceiptFileFailure };

/**
 * Runs after a deferred acknowledgement. The app downloads the screenshot from
 * Discord's CDN (up to 8 MB) and stores it before answering, so this waits
 * longer than a challenge does.
 */
const RECEIPT_TIMEOUT_MS = 25_000;

/** Inside the autocomplete branch's race, like the challenge picker. */
const RECEIPT_PICKER_TIMEOUT_MS = 900;

/**
 * Send a fee receipt as the caller. The app is handed the attachment's url,
 * never its bytes, and downloads it itself from Discord's CDN only.
 */
export function submitReceipt(input: {
  discordUserId: string;
  fee: string;
  reference: string;
  attachmentUrl: string;
}): Promise<ReceiptReply> {
  return send('POST', '/api/discord/receipts', input, RECEIPT_TIMEOUT_MS);
}

/** The caller's own fees a receipt can be sent for, labelled for a picker. */
export async function fetchOwnFees(discordUserId: string): Promise<{ id: string; label: string }[]> {
  const result = await get<{ fees?: { id: string; label: string }[] }>(
    '/api/discord/receipts',
    discordUserId,
    RECEIPT_PICKER_TIMEOUT_MS
  );
  return result.fees ?? [];
}

// ---- SIGN-UP ---------------------------------------------------------------

/** What the app asks the bot to draw next. The app decides; the bot renders. */
export type SignupScreen =
  | {
      kind: 'choice';
      step: 'events' | 'tier' | 'age' | 'consent';
      prompt: string;
      choices: { value: string; label: string }[];
      notice?: string;
    }
  | {
      kind: 'document';
      document: string;
      title: string;
      version: string;
      versionTag: string;
      page: number;
      pageCount: number;
      text: string;
      notice?: string;
    }
  | { kind: 'code_sent' }
  | { kind: 'done'; approved: boolean; linked: boolean }
  | { kind: 'cancelled'; codeSent: boolean };

export type SignupRefusal =
  | 'already_linked'
  | 'timed_out'
  | 'incomplete'
  | 'invalid'
  | 'rate_limited'
  | 'send_failed'
  | 'wrong_code'
  | 'too_many_attempts'
  | 'in_progress'
  | 'existing_account';

export type SignupReply =
  | { ok: true; screen: SignupScreen }
  | { ok: false; refusal: SignupRefusal; message?: string };

// Every step runs after a deferred acknowledgement, so the interaction token
// has fifteen minutes. The code send reaches GoTrue; verify reaches it twice,
// runs the whole onboarding body and waits on the role sync (itself up to ten
// seconds), so it gets the most room: an abort there leaves a made account the
// member is told nothing certain about.
const SIGNUP_TIMEOUT_MS = 10_000;
const SIGNUP_VERIFY_TIMEOUT_MS = 30_000;

/**
 * One /signup step as the caller: an answer, a page turn, a cancel, or the
 * code. The first step carries the email and names; never log the body.
 */
export function signupStep(
  input: { discordUserId: string; action: string } & Record<string, unknown>
): Promise<SignupReply> {
  return send(
    'POST',
    '/api/discord/signup',
    input,
    input.action === 'verify' ? SIGNUP_VERIFY_TIMEOUT_MS : SIGNUP_TIMEOUT_MS
  );
}

// ---- FEEDBACK RELAY --------------------------------------------------------

export interface FeedbackAction {
  kind: 'post' | 'edit' | 'retract';
  /** Which table sourceId points into: a Discord-filed report, or a tournament
   *  survey response from the website. They render differently and they go to
   *  DIFFERENT configured channels; see 00173's header on why. */
  source: 'report' | 'event_feedback';
  sourceId: string;
  /** For an edit or retract this is the channel the message IS in, which is not
   *  necessarily the configured one — a club that repoints the setting has not
   *  moved the messages it already posted. */
  channelId: string;
  /** null only for a post. */
  discordMessageId: string | null;
  /** Rendered body, and the mapping's change-detection key. */
  summary: string;
  title: string;
  body: string;
  /** Whose report it is, already rendered — a mention when the reporter is
   *  linked, a plain name or a bare Discord id when they are not. */
  author: string;
  /** report: the kind. event_feedback: the tournament name. */
  context: string;
  /** 1..5, event_feedback only. */
  rating: number | null;
  /** Screenshot url, report only, and only while it still resolves. */
  imageUrl: string | null;
  createdAt: string | null;
}

/** Reports and survey comments that owe Discord a message, or a change to one. */
export function fetchFeedbackActions(guildId: string): Promise<{
  actions: FeedbackAction[];
  skipped: { sourceId: string; reason: string }[];
  /** Present when the tick's read hit its cap; see fetchMatchResultActions. */
  windowCapReached?: number;
}> {
  const params = new URLSearchParams({ guildId });
  return get(`/api/discord/feedback-relay?${params}`);
}

/** Record a message Discord has ALREADY accepted. Never call this beforehand. */
export function recordFeedbackPost(input: {
  source: 'report' | 'event_feedback';
  sourceId: string;
  guildId: string;
  channelId: string;
  discordMessageId: string;
  summary: string;
}): Promise<{ ok: true }> {
  return send<{ ok: true }>('POST', '/api/discord/feedback-relay', input);
}

/** Forget a mapping, after the Discord message is gone. */
export function clearFeedbackPost(
  source: 'report' | 'event_feedback',
  sourceId: string,
  guildId: string
): Promise<{ ok: true }> {
  const params = new URLSearchParams({ source, sourceId, guildId });
  return send<{ ok: true }>('DELETE', `/api/discord/feedback-relay?${params}`);
}

export interface ProfileLadderLine {
  elo: number;
  provisional: boolean;
  wins: number;
  losses: number;
  streak: number;
  rank: number;
  // Rank among competitive members only, or null for a member who is not one.
  // Same rating as `rank` -- the two ladders differ by who is counted, not by
  // how anyone is rated. Mirrored here, unlike the rest of the card's numbers,
  // because /profile has to know whether a requested `type:` can be honoured
  // BEFORE it spends the budget rendering a card that would ignore it.
  //
  // READ IT WITH == null. A player app older than the resolver that added this
  // omits the key, so the runtime value can be undefined however this reads.
  compRank: number | null;
}

export interface ProfilePayload {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  bio: string | null;
  status: string | null;
  ranked: boolean;
  doubles: ProfileLadderLine | null;
  singles: ProfileLadderLine | null;
  tournamentPoints: number | null;
  awards: { label: string; glyph?: string | null }[];
}

/** The app declining on purpose — not a fault. See fetchProfile. */
export type ProfileMiss =
  | 'not_linked'
  | 'target_unlinked'
  | 'no_such_handle'
  | 'not_found';

export type ProfileResult =
  | { profile: ProfilePayload; cardUrl: string }
  | { miss: ProfileMiss };

/**
 * A member's profile card.
 *
 * Written out rather than routed through get() for two reasons. The 404s are
 * the app declining on purpose — "you haven't linked", "no such handle" — and
 * get() turns every non-ok status into the same AppApiError, which would tell a
 * member the club app was down when they had simply mistyped a handle. And the
 * card's URL has to be built against APP_PUBLIC_URL: Discord's CDN fetches the
 * image from outside the cluster, so the in-cluster APP_API_URL it would
 * otherwise inherit is unreachable. Same split, and the same reason, as
 * mintLinkToken.
 *
 * Both Discord ids travel as HEADERS. Ids in a URL end up in the access log.
 */
export async function fetchProfile(
  callerId: string | null,
  target: { discordUserId?: string | null; handle?: string | null }
): Promise<ProfileResult> {
  const base = process.env.APP_API_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  const publicBase = process.env.APP_PUBLIC_URL;
  if (!base) throw new AppApiError('APP_API_URL is not set');
  if (!secret) throw new AppApiError('DISCORD_SERVICE_SECRET is not set');
  if (!publicBase) throw new AppApiError('APP_PUBLIC_URL is not set');

  const path = target.handle
    ? `/api/discord/profile?${new URLSearchParams({ handle: target.handle })}`
    : '/api/discord/profile';

  const response = await fetch(new URL(path, base), {
    headers: {
      authorization: `Bearer ${secret}`,
      ...(callerId ? { 'x-discord-user-id': callerId } : {}),
      ...(target.discordUserId ? { 'x-discord-target-id': target.discordUserId } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.status === 404) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    const miss = body?.error;
    return {
      miss:
        miss === 'not_linked' ||
        miss === 'target_unlinked' ||
        miss === 'no_such_handle'
          ? miss
          : 'not_found',
    };
  }

  if (!response.ok) {
    throw new AppApiError(`GET /api/discord/profile -> ${response.status}`);
  }

  const body = (await response.json()) as { profile: ProfilePayload; cardToken: string };
  return {
    profile: body.profile,
    cardUrl: new URL(`/api/discord/card/${body.cardToken}`, publicBase).toString(),
  };
}

export interface CardFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

// A rendered card is tens of kilobytes. Anything approaching this is not one,
// and buffering it would spend the rest of the interaction's budget on a body
// that is going to be discarded.
const MAX_CARD_BYTES = 2 * 1024 * 1024;

/**
 * The rendered card as BYTES, so the reply can upload it instead of linking it.
 *
 * NEVER THROWS. A timeout, an expired card token, an HTML error page from
 * something in front of the app — every one of them comes back as null, because
 * the caller's answer to null is the URL fallback and an exception would sail
 * past it into dispatch's generic "couldn't reach the club app". The whole
 * point of the fallback is that it stays reachable.
 *
 * Takes its budget rather than using TIMEOUT_MS: by the time this runs the
 * caller has already spent part of Discord's three seconds on fetchProfile, and
 * what is left still has to cover encoding and writing the multipart body.
 */
export async function fetchCard(cardUrl: string, budgetMs: number): Promise<CardFile | null> {
  try {
    const response = await fetch(cardUrl, { signal: AbortSignal.timeout(budgetMs) });
    if (!response.ok) return null;

    // A proxy error page is a 200 whose body is HTML. Uploading it would attach
    // a file Discord renders as a broken image, which reads as the card being
    // wrong rather than the card never having arrived.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;

    // Checked twice on purpose: the header is absent on a chunked response, so
    // it can only ever reject early, never authorise.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_CARD_BYTES) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CARD_BYTES) return null;

    return { filename: 'card.png', contentType, bytes };
  } catch {
    return null;
  }
}
