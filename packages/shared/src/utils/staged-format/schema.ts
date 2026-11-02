// The stored shape of a staged event: a list of stages, each fed by the field
// or by named slots out of earlier stages. Version 1. Everything here is data;
// the behaviour lives in the sibling modules and reads this shape only.

import { z } from 'zod';

export const STAGE_TIEBREAKS = [
  'wins', 'point_diff', 'points_for', 'points_against_low', 'game_diff', 'h2h', 'seed',
] as const;

const slug = z.string().min(1).max(24).regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use lower-case letters, digits, - and _.');
const name = z.string().trim().min(1).max(40);
const positiveInt = z.number().int().min(1);

export const stageTiebreakSchema = z.enum(STAGE_TIEBREAKS);

export const slotRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('group_place'), stage: slug, pool: positiveInt, group: positiveInt, place: positiveInt }),
  z.object({ type: z.literal('pool_place'), stage: slug, pool: positiveInt, place: positiveInt }),
  // The best `count` of the entries that finished `place` in their group,
  // ranked across groups by `rankBy`. Expands to `count` slots (default: one
  // per group), so "the best two 3rd-placed teams" is one ref.
  z.object({
    type: z.literal('group_rank'),
    stage: slug,
    place: positiveInt,
    rankBy: z.array(stageTiebreakSchema).min(1).max(STAGE_TIEBREAKS.length),
    count: positiveInt.optional(),
  }),
  z.object({ type: z.literal('match'), stage: slug, match: slug, result: z.enum(['winner', 'loser']) }),
  z.object({ type: z.literal('seed'), n: positiveInt }),
]);

export const stageSourceSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('field'), order: z.enum(['elo', 'random', 'manual']) }),
  z.object({
    from: z.literal('slots'),
    slots: z.array(slotRefSchema).min(1).max(128),
    reseed: z.object({
      by: z.array(stageTiebreakSchema).min(1).max(STAGE_TIEBREAKS.length),
      scope: z.enum(['source_stage', 'all_prior']),
      // Which stage's record the reseed reads under scope source_stage. Absent
      // means the stage the slots point into. Set it when the slots point at a
      // playoff but the record that should count is the group stage before it.
      stage: slug.optional(),
    }).optional(),
  }),
]);

export const stageScoringSchema = z.object({
  bestOf: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)]),
  target: z.number().int().min(5).max(30),
  winByTwo: z.boolean(),
  cap: z.number().int().max(60).nullable(),
  handicap: z.boolean(),
  // A walkover is recorded as this score. null = target-0.
  forfeit: z.object({ winner: z.number().int().min(0).max(60), loser: z.number().int().min(0).max(60) }).nullable(),
}).superRefine((s, ctx) => {
  if (s.cap != null && s.cap < s.target) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cap'], message: 'The cap cannot be below the target.' });
  }
  if (s.forfeit && s.forfeit.winner <= s.forfeit.loser) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['forfeit'], message: 'A forfeit must have a winner.' });
  }
});

const stageCommon = {
  key: slug,
  name,
  rated: z.boolean().default(true),
  scoring: stageScoringSchema,
  entrants: stageSourceSchema,
};

const courtName = z.string().trim().min(1).max(20);

export const groupsStageSchema = z.object({
  ...stageCommon,
  kind: z.literal('groups'),
  // Up to 32 rather than 16 so a legacy event's group_count (CHECK 1..32 in
  // 00106) maps onto one pool per group.
  pools: z.number().int().min(1).max(32),
  groupsPerPool: z.number().int().min(1).max(8),
  groupSize: z.union([z.number().int().min(2).max(16), z.literal('auto')]),
  assignment: z.enum(['snake', 'random', 'manual']),
  interleave: z.boolean().default(false),
  courts: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('per_pool'), pools: z.array(z.array(courtName).min(1).max(16)).min(1) }),
    z.object({ mode: z.literal('shared'), courts: z.array(courtName).min(1).max(64) }),
  ]).nullable().default(null),
  tiebreaks: z.array(stageTiebreakSchema).min(1).max(STAGE_TIEBREAKS.length).default(['wins', 'point_diff']),
  poolRanking: z.enum(['best_group_winner', 'none']).default('none'),
  // How many rounds each group plays. Absent is a full round robin, so every
  // config saved before this key existed draws exactly as it did.
  gamesPerTeam: z.number().int().min(1).max(15).optional(),
});

export const knockoutStageSchema = z.object({
  ...stageCommon,
  kind: z.literal('knockout'),
  size: z.union([
    z.literal('auto'),
    z.number().int().min(2).max(128).refine((n) => (n & (n - 1)) === 0, 'The draw size must be a power of 2.'),
  ]),
  // standard: the listed order is the seed order, placed 1 v N. as_listed: the
  // list fills the draw lines top to bottom.
  seeding: z.enum(['standard', 'as_listed']).default('standard'),
  thirdPlace: z.boolean().default(false),
  // The courts this stage's matches may go on. Absent is any court.
  courts: z.array(courtName).min(1).max(64).optional(),
});

export const stageMatchDefSchema = z.object({
  label: slug,
  name,
  a: slotRefSchema,
  b: slotRefSchema,
  winnerPlace: positiveInt.optional(),
  loserPlace: positiveInt.optional(),
  court: courtName.optional(),
});

export const matchesStageSchema = z.object({
  ...stageCommon,
  kind: z.literal('matches'),
  matches: z.array(stageMatchDefSchema).min(1).max(64),
});

export const formatStageSchema = z.discriminatedUnion('kind', [
  groupsStageSchema,
  knockoutStageSchema,
  matchesStageSchema,
]);

export const formatCategorySchema = z.object({ key: slug, label: name });

const points = z.number().int().min(0).max(10000);

// Ladder points (see points.ts). byPlace[i] is place i + 1; a place past the end
// takes `rest`. Zod strips unknown keys, so a config saved with the old unused
// `bonuses` key still parses.
export const formatPointsSchema = z.object({
  byPlace: z.array(points).max(128),
  rest: points.optional(),
  participation: points,
  perWin: points,
});

export type StageTiebreak = z.infer<typeof stageTiebreakSchema>;
export type SlotRef = z.infer<typeof slotRefSchema>;
export type StageSource = z.infer<typeof stageSourceSchema>;
export type StageScoring = z.infer<typeof stageScoringSchema>;
export type GroupsStage = z.infer<typeof groupsStageSchema>;
export type KnockoutStage = z.infer<typeof knockoutStageSchema>;
export type MatchesStage = z.infer<typeof matchesStageSchema>;
export type StageMatchDef = z.infer<typeof stageMatchDefSchema>;
export type FormatStage = z.infer<typeof formatStageSchema>;
export type FormatCategory = z.infer<typeof formatCategorySchema>;
export type FormatPoints = z.infer<typeof formatPointsSchema>;
/** Row category -> column category -> points the ROW side starts on. */
export type HeadStarts = Record<string, Record<string, number>>;

/** Groups in a groups stage, all pools together. */
export function totalGroups(stage: GroupsStage): number {
  return stage.pools * stage.groupsPerPool;
}

/** How many entrants one ref stands for: group_rank expands, the rest are one. */
export function slotRefWidth(ref: SlotRef, source: FormatStage | undefined): number {
  if (ref.type !== 'group_rank') return 1;
  if (ref.count != null) return ref.count;
  return source && source.kind === 'groups' ? totalGroups(source) : 1;
}

function maxGroupPlace(stage: GroupsStage): number {
  return stage.groupSize === 'auto' ? 16 : stage.groupSize;
}

type RefCtx = {
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  earlier: Map<string, FormatStage>;
  seedCount: number | null;
  inMatch: boolean;
};

function checkRef(ref: SlotRef, c: RefCtx): void {
  const issue = (message: string) => c.ctx.addIssue({ code: z.ZodIssueCode.custom, path: c.path, message });
  if (ref.type === 'seed') {
    if (c.seedCount == null) issue('A seed can only be used in a stage that reseeds its entrants.');
    else if (ref.n > c.seedCount) issue(`Seed ${ref.n} does not exist: this stage has ${c.seedCount} entrants.`);
    return;
  }
  const source = c.earlier.get(ref.stage);
  if (!source) {
    issue(`"${ref.stage}" is not an earlier stage.`);
    return;
  }
  switch (ref.type) {
    case 'group_place':
      if (source.kind !== 'groups') return issue(`"${ref.stage}" has no groups.`);
      if (ref.pool > source.pools) issue(`"${ref.stage}" has ${source.pools} pools.`);
      if (ref.group > source.groupsPerPool) issue(`"${ref.stage}" has ${source.groupsPerPool} groups per pool.`);
      if (ref.place > maxGroupPlace(source)) issue('No group is that large.');
      return;
    case 'pool_place':
      if (source.kind !== 'groups') return issue(`"${ref.stage}" has no pools.`);
      if (source.poolRanking === 'none') issue(`"${ref.stage}" does not rank its pools.`);
      if (ref.pool > source.pools) issue(`"${ref.stage}" has ${source.pools} pools.`);
      if (ref.place > source.groupsPerPool) issue('A pool ranks only its group winners.');
      return;
    case 'group_rank':
      if (source.kind !== 'groups') return issue(`"${ref.stage}" has no groups.`);
      if (ref.place > maxGroupPlace(source)) issue('No group is that large.');
      if (ref.count != null && ref.count > totalGroups(source)) issue('There are not that many groups.');
      if (c.inMatch && slotRefWidth(ref, source) !== 1) issue('A match side takes exactly one entrant: set count to 1.');
      return;
    case 'match':
      if (source.kind !== 'matches') return issue(`"${ref.stage}" has no named matches.`);
      if (!source.matches.some((m) => m.label === ref.match)) issue(`"${ref.stage}" has no match "${ref.match}".`);
      return;
  }
}

export const formatConfigSchema = z.object({
  version: z.literal(1),
  categories: z.array(formatCategorySchema).min(1).max(12).default([
    { key: 'mens', label: "Men's" },
    { key: 'womens', label: "Women's" },
    { key: 'mixed', label: 'Mixed' },
  ]),
  headStarts: z.record(z.string(), z.record(z.string(), z.number().int().min(0).max(20))).default({}),
  points: formatPointsSchema.optional(),
  stages: z.array(formatStageSchema).min(1).max(8),
}).superRefine((cfg, ctx) => {
  const issue = (path: Array<string | number>, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  const catKeys = new Set<string>();
  cfg.categories.forEach((c, i) => {
    if (catKeys.has(c.key)) issue(['categories', i, 'key'], `Category "${c.key}" is listed twice.`);
    catKeys.add(c.key);
  });

  const handicapTargets = cfg.stages.filter((s) => s.scoring.handicap).map((s) => s.scoring.target);
  const lowestTarget = handicapTargets.length ? Math.min(...handicapTargets) : null;
  for (const [row, cols] of Object.entries(cfg.headStarts)) {
    if (!catKeys.has(row)) issue(['headStarts', row], `"${row}" is not a category.`);
    for (const [col, start] of Object.entries(cols)) {
      const path = ['headStarts', row, col];
      if (!catKeys.has(col)) issue(path, `"${col}" is not a category.`);
      if (row === col && start !== 0) issue(path, 'A category gets no head start against itself.');
      if (lowestTarget != null && start >= lowestTarget) {
        issue(path, `A head start must be below every handicapped stage's target (${lowestTarget}).`);
      }
    }
  }

  const earlier = new Map<string, FormatStage>();
  const places = new Set<number>();
  cfg.stages.forEach((stage, si) => {
    const base = ['stages', si];
    if (earlier.has(stage.key)) issue([...base, 'key'], `Stage "${stage.key}" is listed twice.`);
    // Owner decision 6: a handicapped game is not a fair game to rate.
    if (stage.scoring.handicap && stage.rated) issue([...base, 'rated'], 'A handicapped stage cannot be rated.');

    if (stage.kind === 'groups' && stage.courts?.mode === 'per_pool' && stage.courts.pools.length !== stage.pools) {
      issue([...base, 'courts'], `Give courts for each of the ${stage.pools} pools.`);
    }

    let seedCount: number | null = null;
    if (stage.entrants.from === 'slots') {
      const src = stage.entrants;
      src.slots.forEach((ref, ri) => {
        checkRef(ref, { ctx, path: [...base, 'entrants', 'slots', ri], earlier, seedCount: null, inMatch: false });
      });
      if (src.reseed) {
        seedCount = src.slots.reduce(
          (n, ref) => n + slotRefWidth(ref, ref.type === 'seed' ? undefined : earlier.get(ref.stage)),
          0,
        );
        if (src.reseed.stage != null && !earlier.has(src.reseed.stage)) {
          issue([...base, 'entrants', 'reseed', 'stage'], `"${src.reseed.stage}" is not an earlier stage.`);
        }
      }
      if (stage.kind === 'knockout' && stage.size !== 'auto') {
        const width = src.slots.reduce(
          (n, ref) => n + slotRefWidth(ref, ref.type === 'seed' ? undefined : earlier.get(ref.stage)),
          0,
        );
        if (width > stage.size) issue([...base, 'size'], `${width} entrants do not fit a draw of ${stage.size}.`);
      }
    }

    if (stage.kind === 'matches') {
      const labels = new Set<string>();
      stage.matches.forEach((m, mi) => {
        const mpath = [...base, 'matches', mi];
        if (labels.has(m.label)) issue([...mpath, 'label'], `Match "${m.label}" is listed twice.`);
        labels.add(m.label);
        checkRef(m.a, { ctx, path: [...mpath, 'a'], earlier, seedCount, inMatch: true });
        checkRef(m.b, { ctx, path: [...mpath, 'b'], earlier, seedCount, inMatch: true });
        for (const p of [m.winnerPlace, m.loserPlace]) {
          if (p == null) continue;
          if (places.has(p)) issue(mpath, `Place ${p} is awarded twice.`);
          places.add(p);
        }
        if (m.loserPlace != null && m.winnerPlace == null) issue(mpath, 'A match that places its loser must place its winner.');
      });
    }

    earlier.set(stage.key, stage);
  });

  // Explicit places run 1..k with no gaps, so everyone else can be placed from
  // k+1 and the whole result is a permutation.
  const sorted = [...places].sort((a, b) => a - b);
  if (sorted.some((p, i) => p !== i + 1)) issue(['stages'], 'Awarded places must run 1, 2, 3... with no gaps.');

  const last = cfg.stages[cfg.stages.length - 1];
  if (last?.kind === 'matches' && !last.matches.some((m) => m.winnerPlace != null)) {
    issue(['stages', cfg.stages.length - 1], 'The last stage must decide places: give a match a winner place.');
  }
});

export type FormatConfig = z.infer<typeof formatConfigSchema>;
export type FormatConfigInput = z.input<typeof formatConfigSchema>;
