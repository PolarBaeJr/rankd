import { describe, it, expect } from 'vitest';
import { buildCaption, formatEventDate, normaliseHashtags } from '../caption';

const base = { eventName: 'Sandpiper Open Mixed Doubles', date: '2026-11-21', time: '18:30:00', venue: 'West Gym', hashtags: '#clubbadminton doubles, #new' };

describe('social captions', () => {
  it('has one opening per kind', () => {
    expect(buildCaption({ ...base, kind: 'teams_full' })).toMatch(/^Meet the teams for Sandpiper Open Mixed Doubles!/);
    expect(buildCaption({ ...base, kind: 'teams_new' })).toMatch(/^More teams joining Sandpiper Open Mixed Doubles\./);
    expect(buildCaption({ ...base, kind: 'draw' })).toMatch(/^The pools are drawn for/);
    expect(buildCaption({ ...base, kind: 'draw', drawShape: 'bracket' })).toMatch(/^The draw is out for/);
  });

  it('says when and where, and ends with the hashtags', () => {
    const caption = buildCaption({ ...base, kind: 'teams_full' });
    expect(caption).toContain('Saturday, November 21 at 6:30 PM, West Gym');
    expect(caption.split('\n').at(-1)).toBe('#clubbadminton #doubles #new');
  });

  it('never carries an em dash, even from an event name', () => {
    for (const kind of ['teams_full', 'teams_new', 'draw'] as const) {
      expect(buildCaption({ ...base, eventName: 'Open \u2014 Finals', kind })).not.toContain('\u2014');
    }
  });

  it('leaves out what it does not know', () => {
    expect(buildCaption({ kind: 'teams_full', eventName: 'Cup' })).toBe('Meet the teams for Cup!');
    expect(formatEventDate('not a date')).toBeNull();
    expect(normaliseHashtags('  ## , ')).toBe('');
  });
});
