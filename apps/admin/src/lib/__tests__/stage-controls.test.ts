import { describe, it, expect } from 'vitest';
import { splitGroupMatches, uncategorisedWarning } from '../stage-controls';

describe('uncategorisedWarning', () => {
  it('counts teams still in the event with no category', () => {
    expect(uncategorisedWarning([
      { status: 'registered', team_category: null },
      { status: 'checked_in', team_category: undefined },
      { status: 'registered', team_category: 'mens' },
      { status: 'withdrawn', team_category: null },
      { status: 'disqualified', team_category: null },
    ])).toBe('2 teams have no category, so they get no head start. Set it in Participants.');
  });

  it('reads one team in the singular', () => {
    expect(uncategorisedWarning([{ status: 'no_show', team_category: null }]))
      .toBe('1 team has no category, so it gets no head start. Set it in Participants.');
  });

  it('says nothing when every team has one', () => {
    expect(uncategorisedWarning([{ status: 'registered', team_category: 'mixed' }])).toBeNull();
    expect(uncategorisedWarning([])).toBeNull();
  });
});

describe('splitGroupMatches', () => {
  const m = (id: string, status: string) => ({ id, status });

  it('puts a voided match in its own bucket, not in to play', () => {
    const split = splitGroupMatches([m('1', 'voided'), m('2', 'pending'), m('3', 'completed'), m('4', 'walkover'), m('5', 'live')]);
    expect(split.toPlay.map((x) => x.id)).toEqual(['2', '5']);
    expect(split.played.map((x) => x.id)).toEqual(['3', '4']);
    expect(split.voided.map((x) => x.id)).toEqual(['1']);
    expect(split.summary).toBe('2 to play, 2 played, 1 voided');
  });

  it('leaves voided out of the summary when there is none', () => {
    expect(splitGroupMatches([m('1', 'ready'), m('2', 'completed')]).summary).toBe('1 to play, 1 played');
  });
});
