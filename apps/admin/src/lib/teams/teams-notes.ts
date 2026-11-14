import * as Sentry from '@sentry/nextjs';
import type { createAdminClient } from '../supabase-server';
import { loadPartnerBoard, type PartnerBoard } from '../partner-board';
import type { TeamsBoard } from './load-teams-board';

type AdminClient = ReturnType<typeof createAdminClient>;

// THE PARTNER NOTES ON THE TEAMS SCREEN (generate_teams). Only a doubles event
// a club event runs (club_events.tournament_event_id) has sign-up notes; a
// plain tournament event skips the step and pairs everyone left.
//
// The notes are the 00311 partner check read for the people waiting in the
// pool, sorted into what the desk does next: a mutual request is pre-locked in
// the preview, an ambiguous one is settled with the desk's pick, and the rest
// are shown so nobody is surprised by who they get.
//
// NOT 'use server': every export of such a module is a public action.

export type TeamsNoteKind = 'resolved' | 'ambiguous' | 'one_sided' | 'not_entered' | 'no_match';

export interface TeamsNote {
  kind: TeamsNoteKind;
  playerId: string;
  name: string;
  wrote: string | null;
  /** 'desk' when the desk's pick is in effect. */
  source: 'desk' | 'typed';
  detail: string;
  /** For an ambiguous note: who it could mean, as the desk's pick takes them. */
  candidates: Array<{ kind: 'member' | 'guest'; id: string; name: string }>;
}

export type TeamsNotes =
  | { state: 'unlinked' }
  | { state: 'hidden' }
  | { state: 'unreadable' }
  | {
      state: 'ready';
      clubEventId: string;
      /** 00311 is applied and the viewer may set a sign-up's partner, so an ambiguous note can be settled here. */
      canPick: boolean;
      notes: TeamsNote[];
      /** Player id pairs who named each other, both waiting. */
      mutual: Array<[string, string]>;
    };

export type TeamsScreen = TeamsBoard & { notes: TeamsNotes };

const ORDER: TeamsNoteKind[] = ['ambiguous', 'resolved', 'one_sided', 'not_entered', 'no_match'];

function whoOf(key: string): { kind: 'member' | 'guest'; id: string } {
  const [kind, id] = key.split(':') as ['member' | 'guest', string];
  return { kind, id };
}

/** Pure: the notes for the people waiting in the pool. */
export function teamsNotesFrom(board: Pick<PartnerBoard, 'people' | 'pool' | 'teams' | 'result'>): { notes: TeamsNote[]; mutual: Array<[string, string]> } {
  const byKey = new Map(board.people.map((person) => [person.key, person]));
  const nameOf = (key: string) => byKey.get(key)?.name ?? 'somebody not signed up';
  const teamed = new Set(board.teams.flat());
  const entered = (key: string) => {
    const playerId = byKey.get(key)?.playerId;
    return !!playerId && (board.pool.has(playerId) || teamed.has(playerId));
  };
  const mutualKeys = new Set(board.result.mutualPairs.flat());

  const notes: TeamsNote[] = [];
  for (const person of board.people) {
    if (!person.playerId || !board.pool.has(person.playerId)) continue;
    const out = board.result.byKey.get(person.key)?.outgoing;
    if (!out || out.state === 'none') continue;
    const base = { playerId: person.playerId, name: person.name, wrote: person.wrote, candidates: [] };
    if (out.state === 'ambiguous') {
      notes.push({
        ...base,
        kind: 'ambiguous',
        source: 'typed',
        detail: `Could be ${out.candidates.map(nameOf).join(' or ')}`,
        candidates: out.candidates.map((key) => ({ ...whoOf(key), name: nameOf(key) })),
      });
    } else if (out.state === 'no_match') {
      notes.push({ ...base, kind: 'no_match', source: 'typed', detail: 'Nobody signed up matches' });
    } else {
      const partner = nameOf(out.partnerKey);
      const relation = out.relation;
      let kind: TeamsNoteKind = 'one_sided';
      let detail: string;
      if (!entered(out.partnerKey)) {
        kind = 'not_entered';
        detail = `Wants ${partner}, who has not entered this event`;
      } else if (relation.kind === 'mutual' && mutualKeys.has(person.key)) {
        kind = 'resolved';
        detail = `Named each other with ${partner}`;
      } else if (relation.kind === 'taken') {
        detail = `Wants ${partner}, who is already teamed with ${nameOf(relation.teamedWith)}`;
      } else if (relation.kind === 'one_sided' && relation.reason === 'named_other') {
        detail = `Wants ${partner}, who named ${nameOf(relation.namedKey)}`;
      } else if (relation.kind === 'one_sided' && relation.reason === 'named_nobody') {
        detail = `Wants ${partner}, who named nobody`;
      } else {
        detail = `Wants ${partner}`;
      }
      notes.push({ ...base, kind, source: out.source, detail });
    }
  }
  notes.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));

  const mutual = board.result.mutualPairs.map(
    ([first, second]): [string, string] => [byKey.get(first)!.playerId!, byKey.get(second)!.playerId!],
  );
  return { notes, mutual };
}

/**
 * The notes for a tournament event, or why there are none. Never throws: a
 * failed read says so, rather than hiding the tool or reading as "no notes".
 */
export async function loadTeamsNotes(adminClient: AdminClient, eventId: string, mayPick: boolean): Promise<TeamsNotes> {
  try {
    const { data, error } = await adminClient.from('club_events').select('id').eq('tournament_event_id', eventId).limit(1);
    if (error) throw new Error(`The linked club event could not be read: ${error.message}`);
    const clubEventId = (data as Array<{ id: string }> | null)?.[0]?.id;
    if (!clubEventId) return { state: 'unlinked' };
    const board = await loadPartnerBoard(adminClient, clubEventId);
    return { state: 'ready', clubEventId, canPick: mayPick && board.choiceReady, ...teamsNotesFrom(board) };
  } catch (err) {
    Sentry.captureException(err, { tags: { action: 'loadTeamsNotes' } });
    return { state: 'unreadable' };
  }
}
