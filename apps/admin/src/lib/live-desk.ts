import {
  allowedTournamentCourts, courtKey, courtLabel, courtsInOrder, eventHasDraw, eventIsPlaying, groupLabel, isPlayedMatch,
  nextCourtFree, poolLabel, stageCourtLabels, stageGroupLabel, stagedMatchName, validateMatch,
  type FormatConfig, type MatchRules, type TournamentCourt,
} from '@badminton/shared';

// ---------------------------------------------------------------------------
// THE DESK'S WORKING LIST, worked out once for the two screens that show it:
// the Court Management tab, and the live strip above the event's tabs. Both
// have to agree about which match is next and how many are on court, and two
// copies of that rule would drift the first time either was touched.
//
// Nothing in here touches React, the DOM or the database.
// ---------------------------------------------------------------------------

/**
 * The three states an unplayed match can be in, which is the whole information
 * content of the desk.
 *
 *   live     BEING PLAYED RIGHT NOW. Occupying a court, so it is what the desk
 *            needs to know about before anything else, and, until 00136, a state
 *            nothing in either app could produce.
 *   callable Both entrants known and not started. Can be sent on now.
 *   waiting  An entrant is still TBD, because a feeder match has not been played.
 *            Not callable however free the courts are.
 */
export type DeskState = 'live' | 'callable' | 'waiting';

/** The columns of `tournament_matches` the desk reads. */
export interface DeskMatch {
  id: string;
  status: string;
  is_bye: boolean | null;
  phase?: string | null;
  /** A staged event's stage, pool, group, slot and match label (00272); absent or null on a legacy row. */
  stage?: number | null;
  pool_number?: number | null;
  group_number?: number | null;
  slot?: number | null;
  match_label?: string | null;
  round_number: number;
  round_name?: string | null;
  match_number: number | null;
  bracket_position: number | null;
  court: string | null;
  /** The tournament court it is linked to (00273); absent before that migration. */
  court_id?: string | null;
  participant_a_id: string | null;
  participant_b_id: string | null;
  pair_a_id: string | null;
  pair_b_id: string | null;
}

export interface DeskRow<M extends DeskMatch, S extends { entryId: string | null }> {
  match: M;
  a: S;
  b: S;
  state: DeskState;
}

/**
 * WHETHER THE COURTS TAB EXISTS, and so whether the live strip may point at it.
 * A completed event has no next match, and a court set on one is history: the
 * tab would be a working list with no work in it.
 */
export function hasCourtsTab(status: string): boolean {
  return eventHasDraw(status) && status !== 'completed';
}

/**
 * WHETHER A SCORE MAY BE ENTERED FROM THE DESK: only while the event is actually
 * being played, but the UNION of what the two half-tabs ask, not a copy of one
 * of them.
 *
 * BracketTab uses `eventIsPlaying || 'bracket_generated'` and RoundRobinTab adds
 * `'pool_generated'`, because a pool is drawn and played before a knockout
 * exists. The desk is deliberately given the WHOLE event so it works one queue
 * across both halves, so taking either tab's predicate alone would hide Enter
 * score here while the other tab still offered it, sending the desk back to the
 * screen it exists to replace, on exactly the format (pool_to_bracket) where
 * one queue matters most.
 */
export function deskEventPlaying(status: string, format?: string): boolean {
  // A staged event takes scores only once it is started, exactly as the server
  // (enterMatchResultImpl) does; its drawn stage waits at bracket_generated.
  if (format === 'staged') return eventIsPlaying(status);
  return eventIsPlaying(status) || status === 'bracket_generated' || status === 'pool_generated';
}

const phaseRank = (m: DeskMatch) => (m.phase === 'bracket' ? 1 : 0);
const ordinal = (m: DeskMatch) => m.match_number ?? m.bracket_position ?? 0;
// A staged row runs stage by stage, and within a groups stage slot by slot: the
// slot is when it is played, and the match number runs across the pools in it.
const stageRank = (m: DeskMatch) => m.stage ?? 0;
const turn = (m: DeskMatch) => m.slot ?? m.round_number;

/**
 * Every match still to be played, in the draw's own sequence.
 *
 * THE ORDER: THE DRAW'S OWN SEQUENCE, AND NOTHING ELSE. This list used to sort
 * uncourted matches first, on the theory that "which matches still need a court"
 * was the working question. In practice the owner's screenshot read "95 of 98
 * unplayed matches have no court yet", which is the sort admitting it does
 * nothing: on any real draw almost everything is uncourted, so the rule never
 * differentiates and its only effect is to hide the sequence the desk actually
 * works in. It was also quietly hostile: saving a court moved that row from the
 * top group to the bottom one, so the reward for typing "3" was watching the row
 * you were looking at jump off screen.
 *
 * So: phase, then round, then match number. Nothing about a match's STATE touches
 * the order, which means no row ever moves under the desk's hands: not when a
 * court is saved, not when someone is marked ready, not when a result lands
 * elsewhere and the whole list repaints. That is the property that makes the
 * Court Management tab safe to type into.
 *
 * PHASE OUTRANKS ROUND, and it has to (00107). The desk is given the whole event
 * rather than one half of it, because matches from both halves of a
 * pool_to_bracket event are called out of one queue, but `round_number` restarts
 * at 1 in the bracket, so ordering on it alone would interleave a pool round 1
 * with a quarter-final.
 *
 * MATCH NUMBER RATHER THAN bracket_position, because the number is what the desk
 * and the entrant both say out loud: the row prints "ROUND OF 128 · M4" and M4 is
 * the ordinal in that round. bracket_position is the layout's coordinate and can
 * differ. It falls back to bracket_position where match_number is null, which is
 * how a draw generated before 00080's renumbering still sorts sanely.
 */
export function deskRows<M extends DeskMatch, S extends { entryId: string | null }>(
  matches: M[],
  sideOf: (entryId: string | null) => S,
  isDoubles: boolean,
): Array<DeskRow<M, S>> {
  return matches
    .filter((m) => !isPlayedMatch(m) && !m.is_bye && m.status !== 'voided')
    .map((m) => {
      const a = sideOf(isDoubles ? m.pair_a_id : m.participant_a_id);
      const b = sideOf(isDoubles ? m.pair_b_id : m.participant_b_id);
      const bothKnown = !!a.entryId && !!b.entryId;
      const state: DeskState =
        m.status === 'live' ? 'live' : bothKnown ? 'callable' : 'waiting';
      return { match: m, a, b, state };
    })
    .sort((x, y) => {
      if (stageRank(x.match) !== stageRank(y.match)) return stageRank(x.match) - stageRank(y.match);
      if (phaseRank(x.match) !== phaseRank(y.match)) return phaseRank(x.match) - phaseRank(y.match);
      if (turn(x.match) !== turn(y.match)) return turn(x.match) - turn(y.match);
      return ordinal(x.match) - ordinal(y.match);
    });
}

/**
 * WHICH ONE IS "NEXT", AND WHY IT IS ONE AND NOT A SET.
 *
 * The earliest `callable` row in the order above. Three decisions in that:
 *
 * A `live` MATCH DOES NOT OUTRANK IT: it is excluded. "Next" means the one to
 * send on now, and a match already being played is not something you call; it is
 * something you wait for. Live matches carry their own ON COURT badge and are
 * counted separately, which is the fact the desk needs from them (how many
 * courts are busy).
 *
 * TBD IS NOT CALLABLE. A round-of-64 slot fed by unplayed round-of-128 matches
 * has no names in it, so however many courts are free it cannot be sent
 * anywhere. Those rows say what they are waiting for instead.
 *
 * ONE, THOUGH SEVERAL COURTS RUN AT ONCE, and the owner's "next one" is right
 * even though his need is plural. Several matches genuinely ARE callable: on a
 * fresh round of 128, all 64 of them. Badging 64 rows "callable now" would be
 * badging the whole list, which is not information. And the app CANNOT compute
 * "the next four", because nothing in this schema knows how many courts the club
 * has: `sessions` has no court column and nothing else counts them, which is
 * written down in two places already (admin dashboard/page.tsx, sessions/page.tsx).
 *
 * What makes one badge sufficient is the ordering above: the rows immediately
 * BELOW the one marked NEXT are, by construction, the ones after next. The desk
 * reads down. That is the whole reason ordering by the draw's own sequence and
 * marking a single next are the same feature rather than two.
 */
export function nextCallable<R extends { state: DeskState }>(rows: R[]): R | null {
  return rows.find((r) => r.state === 'callable') ?? null;
}

/** A desk side that may know its round-robin group. */
interface GroupedSide {
  group?: number | null;
}

/**
 * A staged group as one number, so a pick can be stored and compared like a
 * legacy group number. Group numbers repeat in every pool (pool 1 and pool 2
 * both have a group 1), so the pool and the stage are part of the key. Legacy
 * groups are 1..32, so a staged key (10101 and up) never collides with one.
 */
export function stagedGroupKey(stage: number, pool: number, group: number): number {
  return stage * 10000 + pool * 100 + group;
}

/** The parts of a staged group key; null for a legacy group number. */
export function stagedGroupParts(key: number): { stage: number; pool: number; group: number } | null {
  if (key < 10000) return null;
  return { stage: Math.floor(key / 10000), pool: Math.floor(key / 100) % 100, group: key % 100 };
}

type DeskGroupMatch = { phase?: string | null; stage?: number | null; pool_number?: number | null; group_number?: number | null };

/**
 * THE GROUP A DESK ROW BELONGS TO. A group match is between two teams of the
 * same group, so side a says it, or side b while a is still TBD. A knockout
 * match has no group even when its entrants came out of one.
 *
 * A staged row says its own group (00272): the entry's group_number belongs to
 * the legacy draw, and a staged knockout or named match has none.
 */
export function deskRowGroup(row: { match: DeskGroupMatch; a: GroupedSide; b: GroupedSide }): number | null {
  if (row.match.stage != null) {
    const { stage, pool_number: pool, group_number: group } = row.match;
    return group != null ? stagedGroupKey(stage, pool ?? 1, group) : null;
  }
  if (row.match.phase === 'bracket') return null;
  return row.a.group ?? row.b.group ?? null;
}

function groupsStageOf(cfg: FormatConfig | null | undefined, stage: number) {
  const s = cfg?.stages[stage - 1];
  return s?.kind === 'groups' ? s : undefined;
}

/** "Group C", or for a staged group "G2 Group B". */
export function deskGroupLabel(key: number, cfg?: FormatConfig | null): string {
  const parts = stagedGroupParts(key);
  if (!parts) return `Group ${groupLabel(key)}`;
  return stageGroupLabel(groupsStageOf(cfg, parts.stage), parts.pool, parts.group);
}

/** The short form for a chip: "C", or for a staged group "G2 B". */
export function deskGroupChipLabel(key: number, cfg?: FormatConfig | null): string {
  const parts = stagedGroupParts(key);
  if (!parts) return groupLabel(key);
  const stage = groupsStageOf(cfg, parts.stage);
  if (!stage || stage.pools === 1) return groupLabel(parts.group);
  if (stage.groupsPerPool === 1) return groupLabel(parts.pool);
  return `${poolLabel(parts.pool)} ${groupLabel(parts.group)}`;
}

/**
 * The pools a set of staged group keys falls into, each with its groups, for
 * the pool chips. Only pools of more than one group: a chip for a pool of one
 * would repeat its group's chip. Legacy keys have no pool and are skipped.
 */
export function deskPools(keys: readonly number[], cfg?: FormatConfig | null): Array<{ key: string; label: string; groups: number[] }> {
  const pools = new Map<string, { key: string; label: string; groups: number[] }>();
  for (const k of keys) {
    const parts = stagedGroupParts(k);
    if (!parts) continue;
    const stage = groupsStageOf(cfg, parts.stage);
    if (!stage || stage.pools === 1 || stage.groupsPerPool === 1) continue;
    const id = `${parts.stage}:${parts.pool}`;
    const pool = pools.get(id) ?? { key: id, label: poolLabel(parts.pool), groups: [] };
    pool.groups.push(k);
    pools.set(id, pool);
  }
  return [...pools.values()].filter((p) => p.groups.length > 1);
}

/** The groups that still have a match to play, ascending. */
export function groupsInPlay(rows: Array<Parameters<typeof deskRowGroup>[0]>): number[] {
  const groups = new Set<number>();
  for (const row of rows) {
    const g = deskRowGroup(row);
    if (g != null) groups.add(g);
  }
  return [...groups].sort((x, y) => x - y);
}

/**
 * WHICH GROUPS THIS DESK RUNS. On a big round robin the groups are split
 * between volunteers, so each desk picks its own and Next up, the counts and
 * the list all follow that pick: callers run nextCallable and deskCounts on the
 * rows this returns.
 *
 * An empty pick means every group. A saved pick of groups that have all
 * finished would hide everything, so only picked groups still in play count;
 * `active` is that intersection, and empty again means every row.
 */
export function filterDeskRows<R extends Parameters<typeof deskRowGroup>[0]>(
  rows: R[],
  picked: readonly number[],
): { rows: R[]; active: number[] } {
  const inPlay = groupsInPlay(rows);
  const active = inPlay.filter((g) => picked.includes(g));
  if (active.length === 0) return { rows, active };
  return {
    rows: rows.filter((row) => {
      const g = deskRowGroup(row);
      return g != null && active.includes(g);
    }),
    active,
  };
}

/**
 * "Group C · Round 2 · M4" / "Pool · Round 2 · M4" / "Knockout · Round of 128 · M4".
 * A staged row: "G2 Group B · Round 3 · M12" in a groups stage, the stage's
 * name before the round elsewhere ("Knockout · Semi-final · M30"), and a named
 * match by its name ("Finals · Third place · M34").
 */
export function deskRoundLine(m: DeskMatch, group: number | null = null, cfg?: FormatConfig | null): string {
  const parts: string[] = [];
  if (group != null) parts.push(deskGroupLabel(group, cfg));
  if (m.stage != null) {
    const stage = cfg?.stages[m.stage - 1];
    if (stage && stage.kind !== 'groups') parts.push(stage.name);
    parts.push(stagedMatchName(cfg ?? null, m) ?? (m.round_name || `Round ${m.round_number}`));
  } else {
    if (m.phase === 'pool') parts.push('Pool');
    else if (m.phase === 'bracket') parts.push('Knockout');
    parts.push(m.round_name || `Round ${m.round_number}`);
  }
  if (m.match_number) parts.push(`M${m.match_number}`);
  return parts.join(' · ');
}

/** A desk side as the search reads it. */
interface SearchableSide extends GroupedSide {
  label: string;
  players?: ReadonlyArray<{ name: string }>;
}

/**
 * Does this row fit what the desk typed? Case-insensitive, over both sides'
 * labels and players, the court, `M<match number>` and the round line with its
 * group. A blank query fits everything.
 *
 * THE SEARCH ONLY NARROWS THE LIST. Callers apply it after nextCallable and
 * deskCounts, so typing a name never changes what is next or the counts.
 */
export function deskRowMatchesSearch(
  row: { match: DeskMatch; a: SearchableSide; b: SearchableSide },
  query: string,
  cfg?: FormatConfig | null,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const { match, a, b } = row;
  const haystack = [
    a.label,
    b.label,
    ...(a.players ?? []).map((p) => p.name),
    ...(b.players ?? []).map((p) => p.name),
    courtLabel(match.court) ?? '',
    match.match_number ? `M${match.match_number}` : '',
    deskRoundLine(match, deskRowGroup(row), cfg),
  ];
  return haystack.some((text) => text.toLowerCase().includes(needle));
}

/**
 * THE COURT TO SEND A CALLABLE MATCH TO, when the tournament lists its courts
 * (00273). Null when it lists none, when the match is already on an active
 * court nobody else is using, or when every active court is busy. Otherwise
 * the first free active court in order.
 *
 * `busy` is worked out on the server from every live match in the tournament,
 * across all its events. A court taken in ANOTHER event does not refresh this
 * desk live (it watches this event's matches only), so the suggestion can be
 * stale; the one-live-per-court index is the real guard, and Start says so.
 *
 * `allowed` is the match's stage courts (allowedTournamentCourts), null for
 * any court. With it, only those courts are suggested, and a current court
 * outside them is never fine.
 */
export function deskCourtSuggestion(
  row: { match: Pick<DeskMatch, 'court' | 'court_id'> },
  courts: readonly TournamentCourt[] | null | undefined,
  busy: ReadonlySet<string>,
  allowed?: readonly TournamentCourt[] | null,
): TournamentCourt | null {
  if (!courts?.length) return null;
  const { court, court_id } = row.match;
  const current = court_id
    ? courts.find((c) => c.id === court_id)
    : courts.find((c) => courtLabel(court) != null && courtKey(c.label) === courtKey(court));
  const usable = allowed ? allowed.filter((c) => c.active) : courts;
  if (current && current.active && !busy.has(current.id) && usable.some((c) => c.id === current.id)) return null;
  return nextCourtFree(usable, busy);
}

export function deskCounts(
  rows: Array<{ state: DeskState; match: { court: string | null } }>,
): { live: number; callable: number; waiting: number; uncourted: number } {
  const live = rows.filter((r) => r.state === 'live').length;
  const callable = rows.filter((r) => r.state === 'callable').length;
  return {
    live,
    callable,
    waiting: rows.length - live - callable,
    uncourted: rows.filter((r) => !courtLabel(r.match.court)).length,
  };
}

/**
 * What the shared ScoreEntryDialog needs, keyed by entry id: the display name,
 * the seed, and the entries the slot editor may place into an orphaned bracket
 * position. Withdrawn and disqualified entries are excluded from that last list
 * and refused again server-side: the client list is a convenience, not the rule.
 *
 * `nameOf` is passed in rather than imported so this file stays free of the
 * event page's component folder; every caller hands it `getName`, which is what
 * keeps a pair reading the same in the dialog, the bracket and the desk.
 */
export function buildEntryMaps<E extends { id: string; seed_number: number | null; status: string }>(
  entries: E[],
  nameOf: (entry: E) => string,
): {
  nameMap: Record<string, string>;
  seedMap: Record<string, number>;
  placeableEntries: Array<{ id: string; name: string }>;
} {
  const nameMap: Record<string, string> = {};
  const seedMap: Record<string, number> = {};
  for (const e of entries) {
    nameMap[e.id] = nameOf(e);
    if (e.seed_number) seedMap[e.id] = e.seed_number;
  }
  const placeableEntries = entries
    .filter((e) => e.status !== 'withdrawn' && e.status !== 'disqualified')
    .map((e) => ({ id: e.id, name: nameMap[e.id] ?? 'Unknown' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { nameMap, seedMap, placeableEntries };
}

type CourtRow = { match: DeskMatch; a: { entryId: string | null }; b: { entryId: string | null }; state: DeskState };

/** The entries playing right now, except in `exceptMatchId`. */
export function liveEntrants(rows: readonly CourtRow[], exceptMatchId?: string | null): Set<string> {
  const live = new Set<string>();
  for (const r of rows) {
    if (r.state !== 'live' || r.match.id === exceptMatchId) continue;
    if (r.a.entryId) live.add(r.a.entryId);
    if (r.b.entryId) live.add(r.b.entryId);
  }
  return live;
}

/**
 * THE MATCH A FREE COURT TAKES NEXT, in the desk's order: the first callable
 * row whose stage allows the court and whose entrants are not already on court.
 *
 * A groups stage with courts keeps to the court each row was drawn on, so a
 * pool's second court never takes its first court's queue. Anywhere else a row
 * fits its own court, or any allowed court when it has none.
 */
export function nextMatchForCourt<R extends CourtRow>(
  rows: readonly R[],
  court: TournamentCourt,
  courts: readonly TournamentCourt[],
  cfg: FormatConfig | null | undefined,
  opts: { exclude?: ReadonlySet<string>; busyEntries?: ReadonlySet<string> } = {},
): R | null {
  if (!court.active) return null;
  const busyEntries = opts.busyEntries ?? liveEntrants(rows);
  for (const r of rows) {
    if (r.state !== 'callable' || opts.exclude?.has(r.match.id)) continue;
    if ((r.a.entryId && busyEntries.has(r.a.entryId)) || (r.b.entryId && busyEntries.has(r.b.entryId))) continue;
    const allowed = allowedTournamentCourts(courts, stageCourtLabels(cfg, r.match));
    if (allowed && !allowed.some((c) => c.id === court.id)) continue;
    const onThisCourt = r.match.court_id
      ? r.match.court_id === court.id
      : courtLabel(r.match.court) != null && courtKey(r.match.court) === courtKey(court.label);
    const hasCourt = !!r.match.court_id || courtLabel(r.match.court) != null;
    const stage = r.match.stage != null ? cfg?.stages[r.match.stage - 1] : undefined;
    if (stage?.kind === 'groups' && stage.courts) {
      if (!onThisCourt) continue;
    } else if (!onThisCourt && hasCourt) {
      continue;
    }
    return r;
  }
  return null;
}

/**
 * Which match goes on which free court, one each, never a match or an entrant
 * twice. `preferCourtId` (the court a result just freed) is filled first.
 */
export function planCourtCalls<R extends CourtRow>(
  rows: readonly R[],
  courts: readonly TournamentCourt[],
  busy: ReadonlySet<string>,
  cfg: FormatConfig | null | undefined,
  preferCourtId?: string | null,
): Array<{ row: R; court: TournamentCourt }> {
  const free = courtsInOrder(courts).filter((c) => c.active && !busy.has(c.id));
  const preferred = free.findIndex((c) => c.id === preferCourtId);
  if (preferred > 0) free.unshift(...free.splice(preferred, 1));
  const taken = new Set<string>();
  const busyEntries = liveEntrants(rows);
  const plan: Array<{ row: R; court: TournamentCourt }> = [];
  for (const court of free) {
    const row = nextMatchForCourt(rows, court, courts, cfg, { exclude: taken, busyEntries });
    if (!row) continue;
    plan.push({ row, court });
    taken.add(row.match.id);
    if (row.a.entryId) busyEntries.add(row.a.entryId);
    if (row.b.entryId) busyEntries.add(row.b.entryId);
  }
  return plan;
}

/**
 * The court card's score as typed: the winner when it is a finished match, the
 * reason when it is not, and nothing while no game has been filled in or one
 * is half typed. A game still on its head start counts as not filled in.
 */
export function inlineScoreVerdict(
  games: ReadonlyArray<{ a: string; b: string }>,
  rules: MatchRules | null,
  sideNames: { a: string; b: string },
): { winner: 'a' | 'b' | null; error: string | null; scores: Array<{ a: number; b: number }> } {
  const startA = rules?.startA ? String(rules.startA) : '';
  const startB = rules?.startB ? String(rules.startB) : '';
  const filled = games
    .map((g) => ({ a: g.a.trim(), b: g.b.trim() }))
    .filter((g) => !(g.a === '' && g.b === '') && !(g.a === startA && g.b === startB));
  if (filled.length === 0 || filled.some((g) => g.a === '' || g.b === '')) return { winner: null, error: null, scores: [] };
  if (!rules) {
    return { winner: null, error: 'This stage\'s rules could not be read. Reload the page and try again.', scores: [] };
  }
  if (filled.some((g) => !/^\d+$/.test(g.a) || !/^\d+$/.test(g.b))) {
    return { winner: null, error: 'Scores must be whole numbers.', scores: [] };
  }
  const scores = filled.map((g) => ({ a: Number(g.a), b: Number(g.b) }));
  const verdict = validateMatch(scores, rules, { sideNames });
  return verdict.ok ? { winner: verdict.winner, error: null, scores } : { winner: null, error: verdict.error, scores };
}

export type AutoCallTrigger = 'result' | 'start' | 'draw';

/**
 * What putting the next matches on court did after a result, a Start or a
 * draw. Here rather than beside fillFreeCourts so the console can read it
 * without pulling server code into the browser.
 */
export interface AutoCallReport {
  called: Array<{ matchId: string; court: string }>;
  failed: Array<{ court: string | null; reason: string }>;
  off?: string;
}

/** "Next match could not be called: Court 2: reason", or null when nothing failed. */
export function autoCallFailureText(report: AutoCallReport | undefined | null): string | null {
  if (!report || report.failed.length === 0) return null;
  return `Next match could not be called: ${report.failed
    .map((f) => (f.court ? `${f.court}: ${f.reason}` : f.reason))
    .join('; ')}`;
}
