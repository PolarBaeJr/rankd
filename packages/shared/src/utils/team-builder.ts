import { planAutoPairs, type AutoPairCandidate } from './doubles-pool';
import { shuffleWithRng } from './draw-order';

// GENERATE TEAMS (generate_teams, 00334). Pure: the console reads the pool,
// plans here, shows the plan, and pairs only what the desk confirms.
//
// THREE MODES.
//   balanced  the Auto pair fold (planAutoPairs): strongest with weakest, so
//             every team's combined rating is close to every other's.
//   similar   neighbours by rating: each team is internally even.
//   random    a seeded shuffle, then neighbours in that order.
//
// A PROVISIONAL OR MISSING RATING counts as the median of the pool's
// established ratings, so a new member is neither the strongest nor the
// weakest by accident of a 400 default. The preview marks them.
//
// MUTUAL REQUESTS come first and are kept when both people are in the pool and
// the pair is allowed. EVERY PLANNED PAIR passes `eligible` (the event's own
// rule, mixed doubles only) and the avoid hook.

export type TeamMode = 'balanced' | 'similar' | 'random';
export const TEAM_MODES: readonly TeamMode[] = ['balanced', 'similar', 'random'];

/** True when these two should not be paired. The drop-in avoid list plugs in here. */
export type AvoidPartnerCheck = (a: string, b: string) => boolean;
export const NO_AVOID_LIST: AvoidPartnerCheck = () => false;

export interface TeamCandidate {
  playerId: string;
  /** doubles_elo, or null when there is none. */
  rating: number | null;
  provisional?: boolean;
  category?: 'mens' | 'womens' | null;
}

export interface PlanTeamsInput {
  candidates: readonly TeamCandidate[];
  mode: TeamMode;
  /** Mutual partner requests, kept first when both are in the pool. */
  mutual?: ReadonlyArray<readonly [string, string]>;
  /** Required for random; ignored otherwise. */
  rng?: () => number;
  eligible?: (a: TeamCandidate, b: TeamCandidate) => boolean;
  avoid?: AvoidPartnerCheck;
}

export interface TeamPlan {
  pairs: Array<[string, string]>;
  /** The one person an odd count leaves, or null. */
  leftOver: string | null;
  /** People with nobody left they may partner. */
  unpairable: string[];
}

export const DEFAULT_TEAM_RATING = 400;

/** The rating each candidate plans with: their own, or the pool's established median. */
export function planningRatings(candidates: readonly TeamCandidate[]): Map<string, number> {
  const established = candidates
    .filter((candidate) => candidate.rating !== null && !candidate.provisional)
    .map((candidate) => candidate.rating!)
    .sort((a, b) => a - b);
  const middle = established.length >> 1;
  const median =
    established.length === 0
      ? DEFAULT_TEAM_RATING
      : established.length % 2 === 1
        ? established[middle]!
        : Math.round((established[middle - 1]! + established[middle]!) / 2);
  return new Map(
    candidates.map((candidate) => [
      candidate.playerId,
      candidate.rating === null || candidate.provisional ? median : candidate.rating,
    ]),
  );
}

const byId = (a: TeamCandidate, b: TeamCandidate) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);

/** Pair each person with the next one in `order` they may play with. */
function pairInOrder(order: readonly TeamCandidate[], allowed: (a: TeamCandidate, b: TeamCandidate) => boolean): TeamPlan {
  const pool = [...order];
  const pairs: Array<[string, string]> = [];
  const setAside: string[] = [];
  while (pool.length > 1) {
    const first = pool.shift()!;
    const index = pool.findIndex((other) => allowed(first, other));
    if (index === -1) {
      setAside.push(first.playerId);
      continue;
    }
    const partner = pool.splice(index, 1)[0]!;
    pairs.push([first.playerId, partner.playerId]);
  }
  if (setAside.length === 0) return { pairs, leftOver: pool[0]?.playerId ?? null, unpairable: [] };
  return { pairs, leftOver: null, unpairable: pool.length === 1 ? [...setAside, pool[0]!.playerId] : setAside };
}

export function planTeams(input: PlanTeamsInput): TeamPlan {
  const avoid = input.avoid ?? NO_AVOID_LIST;
  const allowed = (a: TeamCandidate, b: TeamCandidate) =>
    !avoid(a.playerId, b.playerId) && (input.eligible ? input.eligible(a, b) : true);

  const byPlayer = new Map(input.candidates.map((candidate) => [candidate.playerId, candidate]));
  const taken = new Set<string>();
  const mutualPairs: Array<[string, string]> = [];
  for (const [a, b] of input.mutual ?? []) {
    const first = byPlayer.get(a);
    const second = byPlayer.get(b);
    if (!first || !second || a === b || taken.has(a) || taken.has(b) || !allowed(first, second)) continue;
    mutualPairs.push([a, b]);
    taken.add(a);
    taken.add(b);
  }

  const rest = input.candidates.filter((candidate) => !taken.has(candidate.playerId));
  const ratings = planningRatings(input.candidates);
  const rated = rest.map((candidate) => ({ ...candidate, rating: ratings.get(candidate.playerId)! }));

  let plan: TeamPlan;
  if (input.mode === 'balanced') {
    const lookup = new Map(rated.map((candidate) => [candidate.playerId, candidate]));
    const folded = planAutoPairs(
      rated.map((candidate): AutoPairCandidate => ({ playerId: candidate.playerId, rating: candidate.rating, category: candidate.category ?? null })),
      { eligible: (a, b) => allowed(lookup.get(a.playerId)!, lookup.get(b.playerId)!) },
    );
    plan = { pairs: folded.pairs, leftOver: folded.leftOver, unpairable: [...folded.unpairable] };
  } else if (input.mode === 'similar') {
    plan = pairInOrder([...rated].sort((a, b) => b.rating - a.rating || byId(a, b)), allowed);
  } else {
    if (!input.rng) throw new Error('A random plan needs a seeded rng.');
    plan = pairInOrder(shuffleWithRng([...rated].sort(byId), input.rng), allowed);
  }
  return { ...plan, pairs: [...mutualPairs, ...plan.pairs] };
}

// ---------------------------------------------------------------------------
// THE PREVIEW, client state only. Nothing is written until Confirm.
// ---------------------------------------------------------------------------

export interface PreviewTeam {
  a: string;
  b: string;
  locked: boolean;
}

export interface TeamPreview {
  teams: PreviewTeam[];
  leftOver: string[];
}

/** The plan as a preview. A team in `locked` (the mutual requests) starts locked, so a swap or re-roll keeps it. */
export function previewFromPlan(plan: TeamPlan, options: { locked?: ReadonlyArray<readonly [string, string]> } = {}): TeamPreview {
  const lockedKeys = new Set((options.locked ?? []).map(([a, b]) => [a, b].sort().join('|')));
  return {
    teams: plan.pairs.map(([a, b]) => ({ a, b, locked: lockedKeys.has([a, b].sort().join('|')) })),
    leftOver: [...(plan.leftOver ? [plan.leftOver] : []), ...plan.unpairable],
  };
}

export function toggleLock(preview: TeamPreview, index: number): TeamPreview {
  return { ...preview, teams: preview.teams.map((team, i) => (i === index ? { ...team, locked: !team.locked } : team)) };
}

/** Swap two people between teams, or between a team and the leftovers. Locked teams are not touched. */
export function swapMembers(preview: TeamPreview, first: string, second: string): TeamPreview {
  if (first === second) return preview;
  const lockedIds = new Set(preview.teams.filter((team) => team.locked).flatMap((team) => [team.a, team.b]));
  if (lockedIds.has(first) || lockedIds.has(second)) return preview;
  const swap = (id: string) => (id === first ? second : id === second ? first : id);
  return {
    teams: preview.teams.map((team) => (team.locked ? team : { ...team, a: swap(team.a), b: swap(team.b) })),
    leftOver: preview.leftOver.map(swap),
  };
}

/** Plan again everybody not in a locked team; locked teams keep their place. */
export function rerollUnlocked(
  preview: TeamPreview,
  candidates: readonly TeamCandidate[],
  input: Omit<PlanTeamsInput, 'candidates' | 'mutual'>,
): TeamPreview {
  const locked = preview.teams.filter((team) => team.locked);
  const lockedIds = new Set(locked.flatMap((team) => [team.a, team.b]));
  const plan = planTeams({ ...input, candidates: candidates.filter((candidate) => !lockedIds.has(candidate.playerId)) });
  const fresh = previewFromPlan(plan);
  return { teams: [...locked, ...fresh.teams], leftOver: fresh.leftOver };
}
