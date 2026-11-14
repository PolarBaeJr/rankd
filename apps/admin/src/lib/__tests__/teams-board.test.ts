import { describe, it, expect, vi } from 'vitest';
import { tableFake } from './table-fake';

vi.mock('server-only', () => ({}));

const { loadTeamsBoard, runLogLines } = await import('../teams/load-teams-board');

const EVENT = 'bbbbbbbb-0000-4000-8000-000000000001';

describe('the run log', () => {
  it('reads "Run 1: 12 teams, Run 2: +3 teams, added by hand by X"', () => {
    const lines = runLogLines(
      [
        { action: 'teams_published', created_at: '1', performed_by: 'a', details: { pair_ids: Array.from({ length: 12 }, (_, i) => `p${i}`) } },
        { action: 'teams_published', created_at: '2', performed_by: 'a', details: { pair_ids: ['q1', 'q2', 'q3'] } },
        { action: 'team_added', created_at: '3', performed_by: 'b', details: { pair_ids: ['r1'] } },
        { action: 'team_split', created_at: '4', performed_by: null, details: null },
      ],
      (id) => (id === 'a' ? 'Avery Placeholder' : id === 'b' ? 'Blake Placeholder' : 'an exec'),
    );
    expect(lines.map((line) => line.text)).toEqual([
      'Run 1: 12 teams, by Avery Placeholder',
      'Run 2: +3 teams, by Avery Placeholder',
      '+1 team, added by hand by Blake Placeholder',
      'A team was split by an exec',
    ]);
  });
});

describe('loadTeamsBoard', () => {
  it('marks published teams and finds orphans: paired by a run, waiting again now', async () => {
    const fake = tableFake({
      tournament_events: [{ id: EVENT, tournament_id: 't1', event_type: 'mixed_doubles', status: 'registration', draw_locked: false, external_event: false, max_participants: 16, tournament: { name: 'Fall Open' } }],
      tournament_participants: [
        { event_id: EVENT, player_id: 'm1', status: 'registered', elo_before: null, player: { full_name: 'Casey Placeholder', competition_category: 'womens', ratings: { doubles_elo: 1100, doubles_provisional: true } } },
        { event_id: EVENT, player_id: 'm2', status: 'withdrawn', elo_before: null, player: { full_name: 'Gone Placeholder' } },
        { event_id: EVENT, player_id: 'm3', status: 'registered', elo_before: 900, player: { full_name: 'Drew Placeholder' } },
      ],
      tournament_pairs: [{ id: 'pair-1', event_id: EVENT, status: 'registered', player1_id: 'a', player2_id: 'b', player1: { full_name: 'Avery Placeholder' }, player2: { full_name: 'Blake Placeholder' } }],
      tournament_audit_log: [
        { event_id: EVENT, action: 'teams_published', created_at: '2026-11-10T10:00:00Z', performed_by: 'desk', details: { pair_ids: ['pair-1', 'pair-gone'], member_ids: ['a', 'b', 'm1', 'x'] } },
      ],
      tournament_event_waitlist: [],
      players: [{ id: 'desk', full_name: 'Desk Placeholder' }],
    } as never);
    const board = await loadTeamsBoard(fake.client as never, EVENT);
    expect(board!.pool.map((person) => person.playerId)).toEqual(['m1', 'm3']);
    expect(board!.pool[0]).toMatchObject({ provisional: true, category: 'womens', rating: 1100 });
    expect(board!.pairs).toEqual([expect.objectContaining({ id: 'pair-1', name: 'Avery Placeholder & Blake Placeholder', published: true })]);
    expect(board!.orphanIds).toEqual(['m1']);
    expect(board!.runs).toBe(1);
    expect(board!.runLog[0]!.text).toBe('Run 1: 2 teams, by Desk Placeholder');
    expect(board!.event.name).toBe('Fall Open Mixed Doubles');
  });

  it('is null for a singles event, and a failed pool read throws', async () => {
    const singles = tableFake({ tournament_events: [{ id: EVENT, event_type: 'open_singles' }] } as never);
    expect(await loadTeamsBoard(singles.client as never, EVENT)).toBeNull();
    const broken = tableFake({ tournament_events: [{ id: EVENT, tournament_id: 't1', event_type: 'open_doubles', status: 'registration' }] } as never);
    broken.failRead.add('tournament_participants');
    await expect(loadTeamsBoard(broken.client as never, EVENT)).rejects.toThrow('pool');
  });
});
