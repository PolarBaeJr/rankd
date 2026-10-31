// THE PARTNER BOARD (00311). Server side only, and NOT 'use server': the read
// the event page, the linked tournament's page and the desk's partner actions
// share, so all three check the same people against the same teams.
//
// A failed PostgREST read arrives as an empty list, which here would say
// nobody signed up. So a read that fails is retried with fewer columns (the
// desk's choice is 00311's, the note 00299's), and only the last failure of the
// members' read throws.

import { isDoublesEvent, isOutOfEvent } from '@badminton/shared';
import { checkPartners, type PartnerCheckResult, type PartnerPerson } from './partner-check';
import type { createAdminClient } from './supabase-server';

type AdminClient = ReturnType<typeof createAdminClient>;

export interface PartnerBoard {
  people: PartnerPerson[];
  teams: [string, string][];
  /** Player ids waiting for a partner in the linked doubles event. */
  pool: Set<string>;
  linkedEventId: string | null;
  linkedTournamentId: string | null;
  /** The linked event is doubles, so its pool can be paired. */
  doubles: boolean;
  /** 00311 is applied, so the desk can record a choice. */
  choiceReady: boolean;
  result: PartnerCheckResult;
}

const CHOICE = 'preferred_partner_player_id, preferred_partner_external_id, preferred_partner_set_at';
const MEMBER_NAME = 'players!club_event_signups_player_id_fkey(full_name)';

type ChoiceColumns = {
  preferred_partner?: string | null;
  preferred_partner_player_id?: string | null;
  preferred_partner_external_id?: string | null;
  preferred_partner_set_at?: string | null;
};

type MemberRow = ChoiceColumns & {
  player_id: string;
  players: { full_name: string | null } | { full_name: string | null }[] | null;
};

type GuestRow = ChoiceColumns & { id: string; full_name: string };

function deskOf(row: ChoiceColumns): PartnerPerson['desk'] {
  if (!row.preferred_partner_set_at) return null;
  if (row.preferred_partner_player_id) return { partnerKey: `member:${row.preferred_partner_player_id}` };
  if (row.preferred_partner_external_id) return { partnerKey: `guest:${row.preferred_partner_external_id}` };
  return { partnerKey: null };
}

async function readWithFallback<T>(
  read: (columns: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  attempts: string[],
): Promise<{ rows: T[]; used: number } | { error: string }> {
  let last = 'no read attempted';
  for (let index = 0; index < attempts.length; index += 1) {
    const { data, error } = await read(attempts[index]!);
    if (!error) return { rows: (data ?? []) as T[], used: index };
    last = error.message;
  }
  return { error: last };
}

export async function loadPartnerBoard(adminClient: AdminClient, clubEventId: string): Promise<PartnerBoard> {
  const [members, guests, { data: eventRow }] = await Promise.all([
    readWithFallback<MemberRow>(
      (columns) =>
        adminClient
          .from('club_event_signups')
          .select(columns)
          .eq('event_id', clubEventId)
          .order('created_at', { ascending: true }),
      [
        `player_id, preferred_partner, ${CHOICE}, ${MEMBER_NAME}`,
        `player_id, preferred_partner, ${MEMBER_NAME}`,
        `player_id, ${MEMBER_NAME}`,
      ],
    ),
    readWithFallback<GuestRow>(
      (columns) =>
        adminClient
          .from('club_event_external_signups')
          .select(columns)
          .eq('event_id', clubEventId)
          .order('created_at', { ascending: true }),
      [`id, full_name, preferred_partner, ${CHOICE}`, 'id, full_name, preferred_partner', 'id, full_name'],
    ),
    adminClient.from('club_events').select('tournament_event_id').eq('id', clubEventId).maybeSingle(),
  ]);
  if ('error' in members) throw new Error(`Could not read the sign-ups: ${members.error}`);
  // Before 00284 there is no non-member table, and so no non-members.
  const guestRows = 'error' in guests ? [] : guests.rows;
  const choiceReady = members.used === 0 && ('error' in guests || guests.used === 0);

  const people: PartnerPerson[] = [
    ...members.rows.map((row) => {
      const player = Array.isArray(row.players) ? row.players[0] : row.players;
      return {
        key: `member:${row.player_id}`,
        playerId: row.player_id,
        name: player?.full_name ?? 'A member',
        wrote: row.preferred_partner ?? null,
        desk: deskOf(row),
      };
    }),
    ...guestRows.map((row) => ({
      key: `guest:${row.id}`,
      playerId: null,
      name: row.full_name,
      wrote: row.preferred_partner ?? null,
      desk: deskOf(row),
    })),
  ];

  const tournamentEventId = (eventRow as { tournament_event_id?: string | null } | null)?.tournament_event_id ?? null;
  let linkedTournamentId: string | null = null;
  let doubles = false;
  const teams: [string, string][] = [];
  const pool = new Set<string>();
  if (tournamentEventId) {
    const { data: linked } = await adminClient
      .from('tournament_events')
      .select('id, tournament_id, event_type')
      .eq('id', tournamentEventId)
      .maybeSingle();
    const linkedRow = linked as { id: string; tournament_id: string; event_type: string } | null;
    if (linkedRow) {
      linkedTournamentId = linkedRow.tournament_id;
      doubles = isDoublesEvent(linkedRow.event_type as Parameters<typeof isDoublesEvent>[0]);
    }
    if (linkedRow && doubles) {
      const [{ data: pairRows, error: pairError }, { data: soloRows, error: soloError }] = await Promise.all([
        adminClient.from('tournament_pairs').select('player1_id, player2_id, status').eq('event_id', tournamentEventId),
        adminClient.from('tournament_participants').select('player_id, status').eq('event_id', tournamentEventId),
      ]);
      if (pairError) throw new Error(`Could not read the teams: ${pairError.message}`);
      if (soloError) throw new Error(`Could not read who is waiting for a partner: ${soloError.message}`);
      for (const pair of (pairRows ?? []) as { player1_id: string | null; player2_id: string | null; status: string }[]) {
        if (isOutOfEvent(pair.status) || !pair.player1_id || !pair.player2_id) continue;
        teams.push([pair.player1_id, pair.player2_id]);
      }
      for (const solo of (soloRows ?? []) as { player_id: string; status: string }[]) {
        if (!isOutOfEvent(solo.status)) pool.add(solo.player_id);
      }
    }
  }

  return {
    people,
    teams,
    pool,
    linkedEventId: tournamentEventId && linkedTournamentId ? tournamentEventId : null,
    linkedTournamentId,
    doubles,
    choiceReady,
    result: checkPartners({ people, teams, pool }),
  };
}
