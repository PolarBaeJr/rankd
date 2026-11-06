import { CLUB_TIMEZONE } from './constants';
import type { UserRole } from '../types/database';

// A plain DATE ('2026-09-29') is read by `new Date()` as UTC midnight, so it is
// formatted in UTC too: otherwise any runtime behind UTC (a browser, or a dev
// server on Pacific time) showed the day before. Anything with a time part keeps
// the runtime zone it always had.
export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(/^\d{4}-\d{2}-\d{2}$/.test(dateString) ? { timeZone: 'UTC' } : {}),
  });
}

/**
 * A TIMESTAMPTZ as the club's own calendar day, e.g. "Mar 15, 2024".
 *
 * SEPARATE FROM formatDate BECAUSE THE TWO ARE GIVEN DIFFERENT COLUMNS, and one
 * function cannot serve both. formatDate is handed plain DATE values
 * ('2026-01-06'), which `new Date()` reads as UTC midnight: formatting those in
 * a zone behind UTC moves them to the previous day, so putting a timeZone on
 * formatDate would break every session and tournament date in order to fix the
 * timestamps. This is the one for instants, where the opposite is true. A
 * walkover reported at 19:00 in Vancouver happened that day, and the container's
 * UTC clock calls it the next one.
 *
 * Same split, and the same reason, as formatDayMonth/formatPaidDay in the player
 * app's fees.ts. Note that three local helpers called clubDate already exist in
 * the apps and none of them returns this shape: two return YYYY-MM-DD for
 * querying, and my-stats/past-season.tsx returns "18 APR 2027".
 */
export function clubDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: CLUB_TIMEZONE,
  });
}

// Every caller passes a TIMESTAMPTZ, so this is pinned to club time. Without a
// timeZone it rendered in the RUNTIME's zone, and the app containers run with TZ
// unset: an audit entry or a match recorded on a club evening was shown with
// tomorrow's date, because past 17:00 here it is already tomorrow in UTC.
export function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: CLUB_TIMEZONE,
  });
}

// "18:30:00" (or "18:30") -> "6:30 PM". For Postgres TIME columns.
export function formatTime(time: string): string {
  const [h, m] = time.split(':');
  const hour = Number(h);
  const minute = Number(m ?? '0');
  const period = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

export function formatRelativeTime(dateString: string): string {
  const now = Date.now();
  const then = new Date(dateString).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  // clubDate, NOT formatDate. Every caller of this function passes a TIMESTAMPTZ
  // (played_at, created_at, reported_at, last_active_at), so the fallback is an
  // instant and belongs in club time for the same reason formatDateTime above
  // does. formatDate has no timeZone and rendered it in the container's zone,
  // which is UTC: a match played at 19:00 in Vancouver is already the next day
  // there, so the feed printed a row date one ahead of its own day header, which
  // groups by CLUB_TIMEZONE. Only rows past the 7-day cutoff reach this line,
  // which is why the newer half of the feed always looked right.
  return clubDate(dateString);
}

export function isAdmin(role: UserRole): boolean {
  return role === 'admin' || role === 'super_admin';
}

export function getWinRate(wins: number, losses: number): string {
  const total = wins + losses;
  if (total === 0) return '0%';
  return `${Math.round((wins / total) * 100)}%`;
}

// null (not 0) when no games played, so sorts can push unplayed records to
// the bottom instead of treating them as genuine 0% win rates.
export function getWinRateNumeric(wins: number, losses: number): number | null {
  const total = wins + losses;
  if (total === 0) return null;
  return wins / total;
}

export function getOverallRecord(r: {
  singles_wins: number;
  singles_losses: number;
  doubles_wins: number;
  doubles_losses: number;
}): { wins: number; losses: number; played: number; winRate: string; winRateNumeric: number | null } {
  const wins = r.singles_wins + r.doubles_wins;
  const losses = r.singles_losses + r.doubles_losses;
  return {
    wins,
    losses,
    played: wins + losses,
    winRate: getWinRate(wins, losses),
    winRateNumeric: getWinRateNumeric(wins, losses),
  };
}

export function getPointDifferential(scored: number, allowed: number): string {
  const diff = scored - allowed;
  return diff >= 0 ? `+${diff}` : `${diff}`;
}

export function getStreakDisplay(streak: number): string {
  if (streak > 0) return `W${streak}`;
  if (streak < 0) return `L${Math.abs(streak)}`;
  return '-';
}

export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

// Supabase embeds a joined relation as either an object or a one-element
// array depending on how it infers the relationship cardinality — normalize
// to object-or-null.
export function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export type SeasonTier = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond' | 'Elite';

const TIER_THRESHOLDS: { tier: SeasonTier; min: number; color: string; bg: string }[] = [
  { tier: 'Elite', min: 1900, color: '#EF4444', bg: '#EF4444' },
  { tier: 'Diamond', min: 1700, color: '#60A5FA', bg: '#60A5FA' },
  { tier: 'Platinum', min: 1500, color: '#22D3EE', bg: '#22D3EE' },
  { tier: 'Gold', min: 1300, color: '#FFD700', bg: '#FFD700' },
  { tier: 'Silver', min: 1100, color: '#C0C0C0', bg: '#C0C0C0' },
  { tier: 'Bronze', min: 0, color: '#CD7F32', bg: '#CD7F32' },
];

export function getSeasonTier(elo: number): { tier: SeasonTier; color: string; bg: string } {
  const match = TIER_THRESHOLDS.find((t) => elo >= t.min) ?? TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1]!;
  return { tier: match.tier, color: match.color, bg: match.bg };
}
