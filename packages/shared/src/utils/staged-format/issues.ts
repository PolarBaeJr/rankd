// A config that does not validate, said in words an organiser can act on:
// "Stage 2 (Finals), match 1 (Final), side A: ..." rather than a zod path.

import type { z } from 'zod';
import { formatConfigSchema, type FormatConfig } from './schema';

type Raw = Record<string, unknown> | undefined;

const at = (v: unknown, k: string | number): unknown =>
  v != null && typeof v === 'object' ? (v as Record<string | number, unknown>)[k] : undefined;

const FIELD_WORDS: Record<string, string> = {
  key: 'key',
  name: 'name',
  label: 'label',
  rated: 'rated',
  scoring: 'scoring',
  bestOf: 'best of',
  target: 'target',
  winByTwo: 'win by two',
  cap: 'cap',
  handicap: 'head starts',
  forfeit: 'forfeit score',
  entrants: 'entrants',
  slots: 'slot',
  reseed: 'reseed',
  pools: 'pools',
  groupsPerPool: 'groups per pool',
  groupSize: 'group size',
  assignment: 'assignment',
  courts: 'courts',
  tiebreaks: 'tiebreak order',
  poolRanking: 'pool ranking',
  gamesPerTeam: 'games per team',
  size: 'draw size',
  seeding: 'seeding',
  thirdPlace: 'third place',
  winnerPlace: 'winner place',
  loserPlace: 'loser place',
  categories: 'categories',
  headStarts: 'head starts',
};

/** Where an issue sits, in words. */
export function describeIssuePath(input: unknown, path: ReadonlyArray<string | number>): string {
  const parts: string[] = [];
  let i = 0;
  if (path[0] === 'stages' && typeof path[1] === 'number') {
    const stage = at(at(input, 'stages'), path[1]) as Raw;
    const name = typeof stage?.name === 'string' && stage.name.trim() ? ` (${stage.name.trim()})` : '';
    parts.push(`Stage ${path[1] + 1}${name}`);
    i = 2;
    if (path[2] === 'matches' && typeof path[3] === 'number') {
      const m = at(at(stage, 'matches'), path[3]) as Raw;
      const mName = typeof m?.name === 'string' && m.name.trim() ? ` (${m.name.trim()})` : '';
      parts.push(`match ${path[3] + 1}${mName}`);
      i = 4;
      if (path[4] === 'a' || path[4] === 'b') {
        parts.push(`side ${String(path[4]).toUpperCase()}`);
        i = 5;
      }
    } else if (path[2] === 'entrants' && path[3] === 'slots' && typeof path[4] === 'number') {
      parts.push(`entrant slot ${path[4] + 1}`);
      i = 5;
    }
  } else if (path[0] === 'categories' && typeof path[1] === 'number') {
    parts.push(`Category ${path[1] + 1}`);
    i = 2;
  } else if (path[0] === 'headStarts') {
    parts.push(path.length >= 3 ? `Head start ${String(path[1])} against ${String(path[2])}` : 'Head starts');
    i = path.length;
  }
  for (; i < path.length; i++) {
    const p = path[i]!;
    if (typeof p === 'number') continue;
    const word = FIELD_WORDS[p];
    if (word) parts.push(word);
  }
  return parts.length ? parts.join(', ') : 'The format';
}

/** Every issue in a failed parse, one sentence each, duplicates dropped. */
export function formatConfigIssues(input: unknown, error: z.ZodError): string[] {
  const out: string[] = [];
  for (const issue of error.issues) {
    // A cleared number box arrives as NaN, which zod words as "received nan".
    const message = issue.code === 'invalid_type' && issue.received === 'nan' ? 'Enter a number.' : issue.message;
    const line = `${describeIssuePath(input, issue.path)}: ${message}`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** Validate a config the organiser wrote. */
export function checkFormatConfig(
  input: unknown,
): { ok: true; config: FormatConfig } | { ok: false; errors: string[] } {
  const parsed = formatConfigSchema.safeParse(input);
  if (parsed.success) return { ok: true, config: parsed.data };
  return { ok: false, errors: formatConfigIssues(input, parsed.error) };
}
