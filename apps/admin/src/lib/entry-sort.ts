import type { PairWithPlayers } from '@/lib/tournament-types';

export type EntrySortOrder = 'newest' | 'oldest' | 'seed' | 'name';
export type SignupSortOrder = 'newest' | 'oldest' | 'name';

export const ENTRY_SORT_OPTIONS: { value: EntrySortOrder; label: string }[] = [
  { value: 'newest', label: 'Newest sign-up first' },
  { value: 'oldest', label: 'Oldest sign-up first' },
  { value: 'seed', label: 'Seed' },
  { value: 'name', label: 'Name' },
];

export const SIGNUP_SORT_OPTIONS: { value: SignupSortOrder; label: string }[] = [
  { value: 'newest', label: 'Newest sign-up first' },
  { value: 'oldest', label: 'Oldest sign-up first' },
  { value: 'name', label: 'Name' },
];

export const ENTRY_SORT_KEY = 'participants-sort';
export const SIGNUP_SORT_KEY = 'club-signups-sort';

export function parseEntrySort(raw: unknown): EntrySortOrder | null {
  return ENTRY_SORT_OPTIONS.some((o) => o.value === raw) ? (raw as EntrySortOrder) : null;
}

export function parseSignupSort(raw: unknown): SignupSortOrder | null {
  return SIGNUP_SORT_OPTIONS.some((o) => o.value === raw) ? (raw as SignupSortOrder) : null;
}

export interface EntrySortKeys<T> {
  id: (row: T) => string;
  signedUpAt: (row: T) => string | null | undefined;
  seed?: (row: T) => number | null | undefined;
  name: (row: T) => string;
}

function timeOf(value: string | null | undefined): number | null {
  if (value == null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * A new array, never the input reordered. Every order is total: a row with no
 * usable time goes last whichever way the times run, and the id breaks every
 * tie, so rows sharing a timestamp keep one order between renders.
 */
export function sortEntries<T>(rows: readonly T[], order: EntrySortOrder | SignupSortOrder, keys: EntrySortKeys<T>): T[] {
  const byId = (a: T, b: T) => keys.id(a).localeCompare(keys.id(b));
  const byTime = (a: T, b: T, direction: 1 | -1) => {
    const at = timeOf(keys.signedUpAt(a));
    const bt = timeOf(keys.signedUpAt(b));
    if (at === null || bt === null) return at === bt ? 0 : at === null ? 1 : -1;
    return (at - bt) * direction;
  };
  const compare = (a: T, b: T): number => {
    switch (order) {
      case 'newest':
        return byTime(a, b, -1);
      case 'oldest':
        return byTime(a, b, 1);
      case 'seed': {
        const as = keys.seed?.(a) ?? null;
        const bs = keys.seed?.(b) ?? null;
        if (as !== bs) {
          if (as === null) return 1;
          if (bs === null) return -1;
          return as - bs;
        }
        return byTime(a, b, 1);
      }
      case 'name':
        return keys.name(a).localeCompare(keys.name(b), undefined, { sensitivity: 'base' });
    }
  };
  return [...rows].sort((a, b) => compare(a, b) || byId(a, b));
}

/** When a pair signed up: the club event's time if there is one, else the row's own. */
export function pairSignedUpAt(pair: PairWithPlayers, map: Record<string, string> | null | undefined): string | null {
  return map?.[pair.id] ?? pair.created_at ?? null;
}

/** The name the Participants tab shows for a pair. */
export function pairDisplayName(pair: PairWithPlayers): string {
  return pair.pair_name ?? `${pair.player1?.full_name} / ${pair.player2?.full_name}`;
}

/** The later of two sign-up times, compared as times; one if only one is usable. */
export function laterSignup(t1: string | null | undefined, t2: string | null | undefined): string | null {
  const a = timeOf(t1);
  const b = timeOf(t2);
  if (a === null) return b === null ? null : t2!;
  if (b === null) return t1!;
  return b > a ? t2! : t1!;
}
