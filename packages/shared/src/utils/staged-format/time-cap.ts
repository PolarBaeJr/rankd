// A time cap on a groups stage, a pool or one group (00331). Pure, so the
// console's auto-call, its locks and its badges read a cap the same way the
// SQL sweep applies it: a null group is the whole pool, a null pool the whole
// stage.

export interface GroupTimeCap {
  id: string;
  stage: number;
  pool_number: number | null;
  group_number: number | null;
  cap_at: string;
  applied_at: string | null;
}

export interface CappableMatch {
  stage?: number | null;
  pool_number?: number | null;
  group_number?: number | null;
}

export function capCovers(cap: Pick<GroupTimeCap, 'stage' | 'pool_number' | 'group_number'>, match: CappableMatch): boolean {
  if ((match.stage ?? null) !== cap.stage) return false;
  if (cap.pool_number !== null && (match.pool_number ?? null) !== cap.pool_number) return false;
  if (cap.group_number !== null && (match.group_number ?? null) !== cap.group_number) return false;
  return true;
}

/** Applied, or due and waiting for the minute job: no new match starts. */
export function capReached(cap: Pick<GroupTimeCap, 'cap_at' | 'applied_at'>, now: Date): boolean {
  return cap.applied_at !== null || new Date(cap.cap_at).getTime() <= now.getTime();
}

/** Whether any reached cap covers this match: the group's table stands. */
export function scopeLocked(caps: readonly GroupTimeCap[], match: CappableMatch, now: Date): boolean {
  return caps.some((cap) => capReached(cap, now) && capCovers(cap, match));
}
