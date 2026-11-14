// The partner notes on the Teams screen: the 00311 check for the people
// waiting, sorted into resolved, ambiguous, one-sided, named somebody not
// entered, and no match. Mutual requests come back as player id pairs for the
// planner. A plain tournament event has none, and a failed read says so.

import { describe, it, expect, vi } from 'vitest';
import { tableFake } from './table-fake';
import type { PartnerPerson } from '../partner-check';

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../supabase-server', () => ({ createAdminClient: vi.fn() }));
vi.mock('../release-flags', () => ({ releaseFlagOn: vi.fn(async () => true) }));

const { checkPartners } = await import('../partner-check');
const { loadTeamsNotes, teamsNotesFrom } = await import('../teams/teams-notes');

function member(id: string, name: string, wrote: string | null = null): PartnerPerson {
  return { key: `member:${id}`, playerId: id, name, wrote, desk: null };
}

const people = [
  member('a', 'Ada Placeholder', 'Bram Placeholder'),
  member('b', 'Bram Placeholder', 'Ada'),
  member('c', 'Cleo Placeholder', 'Ada'),
  member('d', 'Dov Placeholder', 'Rue'),
  member('e', 'Rue Sampleton'),
  member('f', 'Rue Testcase'),
  member('g', 'Gil Placeholder', 'Nia Sampleton'),
  member('h', 'Nia Sampleton'),
  member('i', 'Ivo Placeholder', 'Somebody Unknown'),
  member('j', 'Jem Placeholder'),
];
const pool = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'i']);

describe('teamsNotesFrom', () => {
  const board = { people, pool, teams: [] as [string, string][], result: checkPartners({ people, pool, fuzzy: true }) };
  const { notes, mutual } = teamsNotesFrom(board);
  const kindOf = (playerId: string) => notes.find((note) => note.playerId === playerId)?.kind;

  it('sorts each waiting person who named somebody', () => {
    expect(kindOf('a')).toBe('resolved');
    expect(kindOf('b')).toBe('resolved');
    expect(kindOf('c')).toBe('one_sided');
    expect(kindOf('d')).toBe('ambiguous');
    expect(kindOf('g')).toBe('not_entered');
    expect(kindOf('i')).toBe('no_match');
    expect(kindOf('e')).toBeUndefined();
    expect(kindOf('h')).toBeUndefined();
  });

  it('an ambiguous note offers the people it could mean, as the desk pick takes them', () => {
    const note = notes.find((entry) => entry.playerId === 'd')!;
    expect(note.candidates).toEqual([
      { kind: 'member', id: 'e', name: 'Rue Sampleton' },
      { kind: 'member', id: 'f', name: 'Rue Testcase' },
    ]);
    expect(notes[0]!.kind).toBe('ambiguous');
  });

  it('hands the mutual requests to the planner as player ids', () => {
    expect(mutual).toEqual([['a', 'b']]);
  });

  it('a desk pick settles an ambiguous note, and can make a mutual pair', () => {
    const picked = people.map((person) => (person.key === 'member:d' ? { ...person, desk: { partnerKey: 'member:e' } } : person.key === 'member:e' ? { ...person, wrote: 'Dov' } : person));
    const after = teamsNotesFrom({ people: picked, pool, teams: [], result: checkPartners({ people: picked, pool, fuzzy: true }) });
    expect(after.notes.find((note) => note.playerId === 'd')).toMatchObject({ kind: 'resolved', source: 'desk' });
    expect(after.mutual).toContainEqual(['d', 'e']);
  });
});

describe('loadTeamsNotes', () => {
  it('a plain tournament event has no notes', async () => {
    const fake = tableFake({ club_events: [] });
    expect(await loadTeamsNotes(fake.client as never, 'event-1', true)).toEqual({ state: 'unlinked' });
  });

  it('a failed read says so rather than reading as no notes', async () => {
    const fake = tableFake({ club_events: [] });
    fake.failRead.add('club_events');
    expect(await loadTeamsNotes(fake.client as never, 'event-1', true)).toEqual({ state: 'unreadable' });
  });

  it('a linked event reads the club event\'s sign-ups', async () => {
    const fake = tableFake({
      club_events: [{ id: 'club-1', tournament_event_id: 'event-1' }],
      club_event_signups: [
        { event_id: 'club-1', player_id: 'a', preferred_partner: 'Bram', players: { full_name: 'Ada Placeholder' } },
        { event_id: 'club-1', player_id: 'b', preferred_partner: 'Ada', players: { full_name: 'Bram Placeholder' } },
      ],
      club_event_external_signups: [],
      tournament_events: [{ id: 'event-1', tournament_id: 't1', event_type: 'open_doubles' }],
      tournament_pairs: [],
      tournament_participants: [
        { event_id: 'event-1', player_id: 'a', status: 'registered' },
        { event_id: 'event-1', player_id: 'b', status: 'registered' },
      ],
    });
    const notes = await loadTeamsNotes(fake.client as never, 'event-1', true);
    expect(notes).toMatchObject({ state: 'ready', clubEventId: 'club-1', mutual: [['a', 'b']] });
  });
});
