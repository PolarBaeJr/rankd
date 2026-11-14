import {
  isDoublesEvent,
  isOutOfEvent,
  toCompetitionCategory,
  TOURNAMENT_EVENT_TYPE_LABELS,
  type TeamCandidate,
  type TournamentEventType,
} from '@badminton/shared';
import type { createAdminClient } from '../supabase-server';

type AdminClient = ReturnType<typeof createAdminClient>;

// WHAT THE TEAMS BUILDER SHOWS, read in one place (generate_teams, 00334).
//
// THE RUN LOG IS THE AUDIT TRAIL. Every publish, hand add, edit and split
// writes one tournament_audit_log row with the pairs and members it touched,
// so "published", "orphan" and "Run 2: +3 teams" are all read back from it and
// there is no second record to drift.

export const TEAM_AUDIT_ACTIONS = ['teams_published', 'team_added', 'team_edited', 'team_split'] as const;
export type TeamAuditAction = (typeof TEAM_AUDIT_ACTIONS)[number];

export const ACTIVE_ENTRY = ['registered', 'checked_in'] as const;

export interface TeamAuditDetails {
  run_no?: number;
  mode?: string;
  manual?: boolean;
  pair_ids?: string[];
  member_ids?: string[];
  refused?: number;
}

export interface BoardPerson {
  playerId: string;
  name: string;
  rating: number | null;
  provisional: boolean;
  category: 'mens' | 'womens' | null;
}

export interface BoardPair {
  id: string;
  player1Id: string | null;
  player2Id: string | null;
  name: string;
  status: string;
  published: boolean;
}

export interface BoardReserve {
  id: string;
  playerId: string;
  name: string;
}

export interface RunLogLine {
  at: string;
  text: string;
}

export interface TeamsBoard {
  event: {
    id: string;
    tournamentId: string;
    eventType: string;
    name: string;
    status: string;
    drawLocked: boolean;
    external: boolean;
    maxParticipants: number | null;
  };
  /** Solo entrants waiting for a partner. */
  pool: BoardPerson[];
  pairs: BoardPair[];
  /** Pool members an earlier run paired whose team has since gone. */
  orphanIds: string[];
  reserves: BoardReserve[];
  runLog: RunLogLine[];
  /** How many runs have published teams. */
  runs: number;
}

const first = <T,>(value: T | T[] | null | undefined): T | null => (Array.isArray(value) ? value[0] ?? null : value ?? null);

export function auditDetails(value: unknown): TeamAuditDetails {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as TeamAuditDetails) : {};
}

/** Pure: the run log lines from the audit rows, oldest first. */
export function runLogLines(
  rows: ReadonlyArray<{ action: string; created_at: string | null; details: unknown; performed_by: string | null }>,
  actorName: (id: string | null) => string,
): RunLogLine[] {
  let run = 0;
  return rows.map((row) => {
    const details = auditDetails(row.details);
    const teams = details.pair_ids?.length ?? 0;
    const plural = teams === 1 ? 'team' : 'teams';
    const by = actorName(row.performed_by);
    let text: string;
    if (row.action === 'teams_published') {
      run += 1;
      text = run === 1 ? `Run ${run}: ${teams} ${plural}, by ${by}` : `Run ${run}: +${teams} ${plural}, by ${by}`;
    } else if (row.action === 'team_added') {
      text = `+1 team, added by hand by ${by}`;
    } else if (row.action === 'team_edited') {
      text = `A team was edited by ${by}`;
    } else {
      text = `A team was split by ${by}`;
    }
    return { at: row.created_at ?? '', text };
  });
}

export function teamsEventName(tournamentName: string | null | undefined, eventType: string): string {
  const label = TOURNAMENT_EVENT_TYPE_LABELS[eventType as TournamentEventType] ?? eventType;
  return tournamentName ? `${tournamentName} ${label}` : label;
}

export function candidatesOf(pool: readonly BoardPerson[]): TeamCandidate[] {
  return pool.map((person) => ({ playerId: person.playerId, rating: person.rating, provisional: person.provisional, category: person.category }));
}

export async function loadTeamsBoard(adminClient: AdminClient, eventId: string): Promise<TeamsBoard | null> {
  const { data: event, error: eventError } = await adminClient
    .from('tournament_events')
    .select('id, tournament_id, event_type, status, draw_locked, external_event, max_participants, tournament:tournaments(name)')
    .eq('id', eventId)
    .maybeSingle();
  if (eventError) throw new Error(`The event could not be read: ${eventError.message}`);
  if (!event || !isDoublesEvent(event.event_type)) return null;

  const [poolRes, pairsRes, auditRes, reservesRes] = await Promise.all([
    adminClient
      .from('tournament_participants')
      .select('player_id, status, elo_before, player:players!player_id(full_name, competition_category, ratings(doubles_elo, doubles_provisional))')
      .eq('event_id', eventId),
    adminClient
      .from('tournament_pairs')
      .select('id, status, player1_id, player2_id, external1_name, external2_name, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)')
      .eq('event_id', eventId)
      .in('status', [...ACTIVE_ENTRY]),
    adminClient
      .from('tournament_audit_log')
      .select('action, created_at, details, performed_by')
      .eq('event_id', eventId)
      .in('action', [...TEAM_AUDIT_ACTIONS])
      .order('created_at', { ascending: true }),
    adminClient
      .from('tournament_event_waitlist')
      .select('id, player_id, joined_at, player:players!player_id(full_name)')
      .eq('event_id', eventId)
      .eq('status', 'waiting')
      .order('joined_at', { ascending: true }),
  ]);
  // A failed read must not read as "nobody waiting" or "no teams".
  if (poolRes.error) throw new Error(`The pool could not be read: ${poolRes.error.message}`);
  if (pairsRes.error) throw new Error(`The teams could not be read: ${pairsRes.error.message}`);
  if (auditRes.error) throw new Error(`The run log could not be read: ${auditRes.error.message}`);
  const reserveRows = reservesRes.error ? [] : reservesRes.data ?? [];

  const pool: BoardPerson[] = (poolRes.data ?? [])
    .filter((row) => !isOutOfEvent(row.status))
    .map((row) => {
      const player = first(row.player as unknown) as { full_name?: string | null; competition_category?: unknown; ratings?: unknown } | null;
      const ratings = first(player?.ratings as unknown) as { doubles_elo?: number | null; doubles_provisional?: boolean | null } | null;
      return {
        playerId: row.player_id,
        name: player?.full_name ?? 'This player',
        rating: ratings?.doubles_elo ?? row.elo_before ?? null,
        provisional: ratings?.doubles_provisional === true,
        category: toCompetitionCategory(player?.competition_category) ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const audit = auditRes.data ?? [];
  const published = new Set<string>();
  const everPaired = new Set<string>();
  for (const row of audit) {
    const details = auditDetails(row.details);
    if (row.action !== 'team_split') for (const id of details.pair_ids ?? []) published.add(id);
    if (row.action === 'teams_published' || row.action === 'team_added') {
      for (const id of details.member_ids ?? []) everPaired.add(id);
    }
  }

  const pairs: BoardPair[] = (pairsRes.data ?? []).map((row) => {
    const one = (first(row.player1 as unknown) as { full_name?: string | null } | null)?.full_name ?? row.external1_name ?? 'Player';
    const two = (first(row.player2 as unknown) as { full_name?: string | null } | null)?.full_name ?? row.external2_name ?? 'Player';
    return { id: row.id, player1Id: row.player1_id, player2Id: row.player2_id, name: `${one} & ${two}`, status: row.status, published: published.has(row.id) };
  });

  const actorIds = [...new Set(audit.map((row) => row.performed_by).filter((id): id is string => !!id))];
  const actorNames = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: actors } = await adminClient.from('players').select('id, full_name').in('id', actorIds);
    for (const actor of actors ?? []) actorNames.set(actor.id, actor.full_name ?? 'an exec');
  }

  const tournament = first(event.tournament as unknown) as { name?: string | null } | null;
  return {
    event: {
      id: event.id,
      tournamentId: event.tournament_id,
      eventType: event.event_type,
      name: teamsEventName(tournament?.name, event.event_type),
      status: event.status,
      drawLocked: event.draw_locked === true,
      external: event.external_event === true,
      maxParticipants: event.max_participants ?? null,
    },
    pool,
    pairs,
    orphanIds: pool.filter((person) => everPaired.has(person.playerId)).map((person) => person.playerId),
    reserves: reserveRows.map((row) => ({
      id: row.id,
      playerId: row.player_id,
      name: (first(row.player as unknown) as { full_name?: string | null } | null)?.full_name ?? 'This player',
    })),
    runLog: runLogLines(audit, (id) => (id ? actorNames.get(id) ?? 'an exec' : 'an exec')),
    runs: audit.filter((row) => row.action === 'teams_published').length,
  };
}
