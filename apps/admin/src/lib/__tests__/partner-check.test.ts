// The partner check (00311): the desk's choice first, then the typed note
// matched against the people signed up, then how the two relate. Advice only.

import { describe, it, expect } from 'vitest';
import { checkPartners, normalizeName, partnerAdvice, type PartnerPerson } from '../partner-check';

function member(id: string, name: string, wrote: string | null = null, desk: PartnerPerson['desk'] = null): PartnerPerson {
  return { key: `member:${id}`, playerId: id, name, wrote, desk };
}
function guest(id: string, name: string, wrote: string | null = null, desk: PartnerPerson['desk'] = null): PartnerPerson {
  return { key: `guest:${id}`, playerId: null, name, wrote, desk };
}

const outgoingOf = (people: PartnerPerson[], key: string) => checkPartners({ people }).byKey.get(key)!.outgoing;

describe('normalizeName', () => {
  it('drops accents, parentheses and punctuation', () => {
    expect(normalizeName('  José  (the tall one) Núñez-Smith ')).toBe('jose nunez smith');
    expect(normalizeName('N/A')).toBe('n a');
  });
});

describe('matching what they wrote', () => {
  const people = [
    member('a', 'Alice Wong', 'José Núñez'),
    member('b', 'Jose Nunez'),
    member('c', 'Jon Smith'),
    member('d', 'Jon Snow'),
    member('e', 'Eve Li', 'Jon S'),
    member('f', 'Fay Ho', 'jon'),
    member('g', 'Gus Ma', 'Bob (my roommate)'),
    member('h', 'Bob Tan'),
    member('i', 'Ivy Ko', 'Zed'),
  ];

  it('matches a full name across accents', () => {
    expect(outgoingOf(people, 'member:a')).toMatchObject({ state: 'matched', source: 'typed', partnerKey: 'member:b' });
  });

  it('matches a first name only, ignoring a parenthesised aside', () => {
    expect(outgoingOf(people, 'member:g')).toMatchObject({ state: 'matched', partnerKey: 'member:h' });
  });

  it('says ambiguous when a first name fits two, and lists them', () => {
    expect(outgoingOf(people, 'member:f')).toEqual({ state: 'ambiguous', candidates: ['member:c', 'member:d'] });
  });

  it('settles "Jon S" by the last initial when it fits one', () => {
    const narrowed = people.filter((person) => person.key !== 'member:d');
    expect(outgoingOf(narrowed, 'member:e')).toMatchObject({ state: 'matched', partnerKey: 'member:c' });
    expect(outgoingOf(people, 'member:e')).toEqual({ state: 'ambiguous', candidates: ['member:c', 'member:d'] });
  });

  it('says no match when nobody fits', () => {
    expect(outgoingOf(people, 'member:i')).toEqual({ state: 'no_match' });
  });

  it('reads placeholders as no preferred partner', () => {
    for (const note of ['', 'none', 'N/A', 'na', 'Any', 'anyone', 'random', 'No preference', 'nobody', 'no one', 'IDK', 'tbd', 'no']) {
      expect(outgoingOf([member('x', 'Xi Lu', note), member('y', 'Yan Wu')], 'member:x')).toEqual({ state: 'none', source: 'typed' });
    }
    expect(outgoingOf([member('x', 'Xi Lu', null)], 'member:x')).toEqual({ state: 'none', source: 'typed' });
  });

  it('never matches somebody to themselves', () => {
    expect(outgoingOf([member('x', 'Sam Lee', 'Sam'), member('y', 'Yan Wu')], 'member:x')).toEqual({ state: 'no_match' });
  });

  it('matches a non-member by name', () => {
    expect(outgoingOf([member('x', 'Xi Lu', 'Pat'), guest('p', 'Pat Guest')], 'member:x')).toMatchObject({
      state: 'matched',
      partnerKey: 'guest:p',
    });
  });
});

describe('how two people relate', () => {
  it('is mutual when each names the other, and offers them as a mutual pair', () => {
    const people = [member('a', 'Ann Ho', 'Ben'), member('b', 'Ben Wu', 'Ann')];
    const result = checkPartners({ people, pool: new Set(['a', 'b']) });
    expect(result.byKey.get('member:a')!.outgoing).toMatchObject({ relation: { kind: 'mutual' } });
    expect(result.byKey.get('member:a')!.mutualWith).toBe('member:b');
    expect(result.mutualPairs).toEqual([['member:a', 'member:b']]);
  });

  it('is one-sided when the other named nobody, somebody else, or nothing that resolves', () => {
    const people = [
      member('a', 'Ann Ho', 'Ben'),
      member('b', 'Ben Wu', 'none'),
      member('c', 'Cal Ng', 'Dee'),
      member('d', 'Dee Yu', 'Eli'),
      member('e', 'Eli Po'),
      member('f', 'Fox Ai', 'Gil'),
      member('g', 'Gil Oh', 'Zed'),
    ];
    const result = checkPartners({ people });
    expect(result.byKey.get('member:a')!.outgoing).toMatchObject({ relation: { kind: 'one_sided', reason: 'named_nobody' } });
    expect(result.byKey.get('member:c')!.outgoing).toMatchObject({
      relation: { kind: 'one_sided', reason: 'named_other', namedKey: 'member:e' },
    });
    expect(result.byKey.get('member:f')!.outgoing).toMatchObject({ relation: { kind: 'one_sided', reason: 'unresolved' } });
  });

  it('is taken when the one named is teamed with somebody else', () => {
    const people = [member('a', 'Ann Ho', 'Ben'), member('b', 'Ben Wu'), member('c', 'Cal Ng')];
    const result = checkPartners({ people, teams: [['b', 'c']] });
    expect(result.byKey.get('member:a')!.outgoing).toMatchObject({ relation: { kind: 'taken', teamedWith: 'member:c' } });
    expect(result.byKey.get('member:a')!.teamedWith).toBeNull();
  });

  it('is paired when the two are already a team, and says who each is teamed with', () => {
    const people = [member('a', 'Ann Ho', 'Ben'), member('b', 'Ben Wu', 'Ann')];
    const result = checkPartners({ people, teams: [['a', 'b']], pool: new Set() });
    expect(result.byKey.get('member:a')!.outgoing).toMatchObject({ relation: { kind: 'paired' } });
    expect(result.byKey.get('member:a')!.teamedWith).toBe('member:b');
    expect(result.mutualPairs).toEqual([]);
  });

  it('marks somebody already teamed when they name somebody else', () => {
    const people = [member('a', 'Ann Ho', 'Ben'), member('b', 'Ben Wu'), member('c', 'Cal Ng')];
    const result = checkPartners({ people, teams: [['a', 'c']] });
    expect(result.byKey.get('member:a')!.teamedWith).toBe('member:c');
    expect(result.byKey.get('member:a')!.outgoing).toMatchObject({ relation: { kind: 'one_sided' } });
  });
});

describe('the desk\'s choice', () => {
  it('beats what they wrote', () => {
    const people = [member('a', 'Ann Ho', 'Ben', { partnerKey: 'member:c' }), member('b', 'Ben Wu'), member('c', 'Cal Ng')];
    expect(outgoingOf(people, 'member:a')).toMatchObject({ state: 'matched', source: 'desk', partnerKey: 'member:c' });
  });

  it('can say no preferred partner', () => {
    const people = [member('a', 'Ann Ho', 'Ben', { partnerKey: null }), member('b', 'Ben Wu')];
    expect(outgoingOf(people, 'member:a')).toEqual({ state: 'none', source: 'desk' });
  });

  it('is stale when its pick is no longer signed up, and the note is used instead', () => {
    const people = [member('a', 'Ann Ho', 'Ben', { partnerKey: 'member:gone' }), member('b', 'Ben Wu')];
    const check = checkPartners({ people }).byKey.get('member:a')!;
    expect(check.deskStale).toBe(true);
    expect(check.outgoing).toMatchObject({ state: 'matched', source: 'typed', partnerKey: 'member:b' });
  });
});

describe('somebody asked for by several people', () => {
  it('is contested by two, in input order', () => {
    const people = [member('a', 'Ann Ho', 'Ben'), member('b', 'Ben Wu'), member('c', 'Cal Ng', 'Ben Wu')];
    const check = checkPartners({ people }).byKey.get('member:b')!;
    expect(check.requestedBy).toEqual(['member:a', 'member:c']);
    expect(check.contested).toBe(true);
  });

  it('is contested by three, and the advice lists them on that row', () => {
    const people = [
      member('a', 'Ann Ho', 'Ben'),
      member('b', 'Ben Wu'),
      member('c', 'Cal Ng', 'Ben'),
      guest('d', 'Dee Yu', 'Ben'),
    ];
    const pool = new Set(['a', 'b', 'c']);
    const result = checkPartners({ people, pool });
    expect(result.byKey.get('member:b')!.contested).toBe(true);
    const advice = partnerAdvice(people, result, pool);
    expect(advice['member:b']!.badges.map((badge) => badge.text)).toContain('Requested by Ann Ho, Cal Ng and Dee Yu');
    expect(advice['member:b']!.pairable.map((person) => person.playerId)).toEqual(['a', 'c']);
    expect(advice['member:b']!.unpairable).toEqual([{ name: 'Dee Yu', reason: 'a non-member who has not entered the tournament' }]);
    expect(advice['member:a']!.badges.map((badge) => badge.text)).not.toContain('Requested by Ann Ho, Cal Ng and Dee Yu');
  });

  it('is not contested when one of them is mutual: that one shows, and the rest are "also requested by"', () => {
    const people = [member('a', 'Ann Ho', 'Ben'), member('b', 'Ben Wu', 'Ann'), member('c', 'Cal Ng', 'Ben')];
    const pool = new Set(['a', 'b', 'c']);
    const result = checkPartners({ people, pool });
    const check = result.byKey.get('member:b')!;
    expect(check.contested).toBe(false);
    expect(check.mutualWith).toBe('member:a');
    const texts = partnerAdvice(people, result, pool)['member:b']!.badges.map((badge) => badge.text);
    expect(texts).toContain('Mutual: Ann Ho');
    expect(texts).toContain('Also requested by Cal Ng');
  });

  it('is not contested once the person is teamed', () => {
    const people = [member('a', 'Ann Ho', 'Ben'), member('b', 'Ben Wu'), member('c', 'Cal Ng', 'Ben'), member('d', 'Dee Yu')];
    expect(checkPartners({ people, teams: [['b', 'd']] }).byKey.get('member:b')!.contested).toBe(false);
  });
});

describe('mutual pairs', () => {
  it('leaves out a non-member and anybody not waiting in the pool', () => {
    const people = [
      member('a', 'Ann Ho', 'Ben'),
      member('b', 'Ben Wu', 'Ann'),
      member('c', 'Cal Ng', 'Pat'),
      guest('p', 'Pat Guest', 'Cal'),
      member('e', 'Eli Po', 'Fox'),
      member('f', 'Fox Ai', 'Eli'),
    ];
    const result = checkPartners({ people, pool: new Set(['a', 'b', 'c', 'e']) });
    expect(result.byKey.get('member:c')!.mutualWith).toBe('guest:p');
    expect(result.byKey.get('member:e')!.mutualWith).toBe('member:f');
    expect(result.mutualPairs).toEqual([['member:a', 'member:b']]);
  });
});
