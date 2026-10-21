import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  readFeatureFlags,
  type TournamentEventType,
} from '@badminton/shared';
import type { createServiceRoleClient } from '@/lib/supabase-server';

// The member tournament commands on Discord (/tournaments draw, next, results),
// rendered as short text lines here, where they are type-checked, so the bot
// only lays them out.
//
// THE COLUMN LISTS ARE THE EVENT PAGE'S (app/tournaments/[id]/events/[eventId]),
// never `*`: tournament_participants.notes, tournament_pairs.notes and
// tournament_matches.notes still hold an exec's private reasons (00117/00118),
// and these routes run with the service role.

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

export const PARTICIPANT_COLUMNS =
  'id, seed_number, status, final_position, points, elo_change, player:players!player_id(full_name, avatar_url)';
export const PAIR_COLUMNS =
  'id, seed_number, status, final_position, points, pair_name, external1_name, external2_name, player1:players!tournament_pairs_player1_id_fkey(full_name, avatar_url), player2:players!tournament_pairs_player2_id_fkey(full_name, avatar_url)';

export type MatchRow = {
  id: string;
  round_number: number;
  bracket_position: number | null;
  round_name: string | null;
  court: string | null;
  status: string;
  scores: { a: number; b: number }[] | null;
  is_bye: boolean | null;
  phase: string | null;
  participant_a_id: string | null;
  participant_b_id: string | null;
  pair_a_id: string | null;
  pair_b_id: string | null;
  winner_participant_id: string | null;
  winner_pair_id: string | null;
  stage?: number | null;
  pool_number?: number | null;
  group_number?: number | null;
  match_label?: string | null;
  match_number?: number | null;
};

type NameEmbed = { full_name?: string | null } | { full_name?: string | null }[] | null | undefined;

function one(embed: NameEmbed): { full_name?: string | null } | null {
  return (Array.isArray(embed) ? embed[0] : embed) ?? null;
}

/** The event page's own naming: an external team by its name, otherwise "A & B". */
export function pairDisplayName(p: Record<string, unknown>): string {
  const p1 = one(p.player1 as NameEmbed);
  const p2 = one(p.player2 as NameEmbed);
  const teamNamed = p.external1_name != null && p.pair_name !== `${p.external1_name} / ${p.external2_name}`;
  const name = teamNamed
    ? (p.pair_name as string)
    : [p1?.full_name ?? p.external1_name, p2?.full_name ?? p.external2_name].filter(Boolean).join(' & ');
  return name || (p.pair_name as string | null) || 'Unknown Pair';
}

export function participantDisplayName(p: Record<string, unknown>): string {
  return one(p.player as NameEmbed)?.full_name || 'Unknown';
}

/** Is the tournaments feature switched on for members at all. */
export async function tournamentsOn(supabase: ServiceClient): Promise<boolean> {
  return (await readFeatureFlags(supabase)).tournaments;
}

export function eventTypeLabel(eventType: string): string {
  return TOURNAMENT_EVENT_TYPE_LABELS[eventType as TournamentEventType] ?? eventType;
}

/** "R2 #3", or a staged event's own label. The console picker uses the same rule. */
export function matchRef(m: Pick<MatchRow, 'round_number' | 'bracket_position' | 'match_number' | 'match_label'>): string {
  return m.match_label ?? `R${m.round_number} #${m.match_number ?? (m.bracket_position ?? 0) + 1}`;
}

export function sideIds(m: MatchRow, doubles: boolean): { a: string | null; b: string | null; winner: string | null } {
  return doubles
    ? { a: m.pair_a_id, b: m.pair_b_id, winner: m.winner_pair_id }
    : { a: m.participant_a_id, b: m.participant_b_id, winner: m.winner_participant_id };
}

/**
 * One match as a line, side A first: "R1 #3 Smith 21-15 21-18 Jones" once
 * played, "R1 #3 Smith v Jones · on court · Court 2" before.
 */
export function matchLine(m: MatchRow, doubles: boolean, names: Map<string, string>, prefix = ''): string {
  const ids = sideIds(m, doubles);
  const name = (id: string | null) => (id ? names.get(id) ?? 'TBD' : 'TBD');
  const head = `${prefix}${matchRef(m)}`;
  if (m.status === 'walkover') {
    const winner = ids.winner ? names.get(ids.winner) ?? 'TBD' : null;
    return `${head} ${name(ids.a)} v ${name(ids.b)} · walkover${winner ? `, ${winner} through` : ''}`;
  }
  if (m.status === 'completed' && m.scores && m.scores.length > 0) {
    return `${head} ${name(ids.a)} ${m.scores.map((g) => `${g.a}-${g.b}`).join(' ')} ${name(ids.b)}`;
  }
  const state = m.status === 'live' ? 'on court' : m.status === 'ready' ? 'waiting to be called' : null;
  return [`${head} ${name(ids.a)} v ${name(ids.b)}`, state, m.court ? `Court ${m.court}` : null]
    .filter(Boolean)
    .join(' · ');
}

/** The member app's public base, the one /api/discord/schedule links with. */
export function publicBase(): string | null {
  const base = process.env.NEXT_PUBLIC_PLAYER_URL || process.env.NEXT_PUBLIC_APP_URL;
  return base ? base.replace(/\/+$/, '') : null;
}

/**
 * Names for every entry in these events, keyed by the id the match rows name.
 * 'unavailable' when either read fails: a draw full of "TBD" would look right
 * and be wrong.
 */
export async function loadEntryNames(
  supabase: ServiceClient,
  eventIds: string[],
): Promise<Map<string, string> | 'unavailable'> {
  const names = new Map<string, string>();
  if (eventIds.length === 0) return names;
  const [participantRes, pairRes] = await Promise.all([
    supabase.from('tournament_participants').select(PARTICIPANT_COLUMNS).in('event_id', eventIds),
    supabase.from('tournament_pairs').select(PAIR_COLUMNS).in('event_id', eventIds),
  ]);
  if (participantRes.error || pairRes.error) {
    console.error('[discord] tournament entry names read failed');
    return 'unavailable';
  }
  for (const p of (participantRes.data ?? []) as Record<string, unknown>[]) {
    names.set(p.id as string, participantDisplayName(p));
  }
  for (const p of (pairRes.data ?? []) as Record<string, unknown>[]) names.set(p.id as string, pairDisplayName(p));
  return names;
}
