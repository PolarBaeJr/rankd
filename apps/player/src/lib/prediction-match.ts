// THE PURE HALF OF THE PREDICTIONS READ, safe in a client bundle. The server
// half (the feature gate and the two RPCs) is ./predictions.ts, which reaches
// next/headers and so cannot be imported by the new-challenge form.
//
// A matchup is two unordered sides of unordered players, the same rule the
// table in 00282 stores by. A prediction found with the sides the other way
// round is flipped to 1 - p, so the figure is always the chance of the side
// the caller named first.

export type PredictionFormat = 'singles' | 'doubles';

export interface MatchupPrediction {
  format: PredictionFormat;
  sideA: string[];
  sideB: string[];
  /** Side A's chance of winning, 0 to 1. */
  probability: number;
  model: string;
  madeAt: string;
}

export function sameSide(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id) => b.includes(id));
}

/**
 * The prediction for `sideA` against `sideB` out of `list`, oriented to
 * `sideA`, or null. A side with a blank id (a doubles partner not picked yet)
 * matches nothing.
 */
export function findPrediction(
  list: readonly MatchupPrediction[],
  format: PredictionFormat,
  sideA: readonly string[],
  sideB: readonly string[],
): MatchupPrediction | null {
  if ([...sideA, ...sideB].some((id) => !id)) return null;
  for (const p of list) {
    if (p.format !== format) continue;
    if (sameSide(p.sideA, sideA) && sameSide(p.sideB, sideB)) return p;
    if (sameSide(p.sideA, sideB) && sameSide(p.sideB, sideA)) {
      return { ...p, sideA: p.sideB, sideB: p.sideA, probability: 1 - p.probability };
    }
  }
  return null;
}

export function predictionPercent(probability: number): number {
  return Math.round(probability * 100);
}
