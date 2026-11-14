// The generate_teams tiers of the partner check: after the 00311 exact and
// first-name tiers come a display name or handle, the surname first, and a
// near spelling. Every person here is invented. More than one hit at the best
// tier is ambiguous, and with the switch off the 00311 answer is unchanged.

import { describe, it, expect } from 'vitest';
import { checkPartners, type PartnerPerson } from '../partner-check';

function member(id: string, name: string, wrote: string | null = null, aliases: string[] = []): PartnerPerson {
  return { key: `member:${id}`, playerId: id, name, aliases, wrote, desk: null };
}

const people = [
  member('a', 'Ada Sampleton', 'Marsiol'),
  member('b', 'Marisol Placeholder'),
  member('c', 'Cyrus Sampleton', 'SmashBot99'),
  member('d', 'Quentin Testcase', null, ['Q', 'smashbot99']),
  member('e', 'Esme Sampleton', 'Otilie'),
  member('f', 'Ottilie Placeholder'),
  member('g', 'Ottilie Testcase'),
  member('h', 'Hugo Sampleton', 'Examplar Wendell'),
  member('i', 'Wendell Examplar'),
  member('j', 'Juno Sampleton', 'Theo'),
  member('k', 'Theodora Placeholder'),
  member('l', 'Lior Sampleton', 'Kim Placeholder'),
  member('m', 'Lee Placeholder'),
];

const outgoing = (key: string, fuzzy: boolean, list = people) => checkPartners({ people: list, fuzzy }).byKey.get(key)!.outgoing;

describe('the generate_teams tiers', () => {
  it('a transposed spelling resolves to the one person it fits', () => {
    expect(outgoing('member:a', true)).toMatchObject({ state: 'matched', source: 'typed', partnerKey: 'member:b' });
  });

  it('a nickname that starts the name resolves', () => {
    expect(outgoing('member:j', true)).toMatchObject({ state: 'matched', partnerKey: 'member:k' });
  });

  it('a handle typed as the name resolves through the aliases', () => {
    expect(outgoing('member:c', true)).toMatchObject({ state: 'matched', partnerKey: 'member:d' });
  });

  it('a misspelled first name two people share is ambiguous, never guessed', () => {
    expect(outgoing('member:e', true)).toEqual({ state: 'ambiguous', candidates: ['member:f', 'member:g'] });
  });

  it('the surname first resolves', () => {
    expect(outgoing('member:h', true)).toMatchObject({ state: 'matched', partnerKey: 'member:i' });
  });

  it('a shared surname alone is not a match', () => {
    expect(outgoing('member:l', true)).toEqual({ state: 'no_match' });
  });

  it('a short token is never fuzzed', () => {
    const list = [member('x', 'Xan Sampleton', 'Bo'), member('y', 'Bob Placeholder')];
    expect(outgoing('member:x', true, list)).toEqual({ state: 'no_match' });
  });

  it('the 00311 tiers still win first: an exact first name is not widened by a near one', () => {
    const list = [member('x', 'Xan Sampleton', 'Marisol'), member('b', 'Marisol Placeholder'), member('z', 'Marisel Testcase')];
    expect(outgoing('member:x', true, list)).toMatchObject({ state: 'matched', partnerKey: 'member:b' });
  });

  it('with the switch off, every one of these reads as the 00311 tiers do', () => {
    for (const key of ['member:a', 'member:c', 'member:e', 'member:h', 'member:j', 'member:l']) {
      expect(outgoing(key, false)).toEqual({ state: 'no_match' });
    }
    expect(checkPartners({ people }).byKey.get('member:a')!.outgoing).toEqual({ state: 'no_match' });
  });

  it('mutual requests made through the new tiers are mutual pairs', () => {
    const list = [member('p', 'Marisol Placeholder', 'Examplar Wendell'), member('q', 'Wendell Examplar', 'Marsiol')];
    const result = checkPartners({ people: list, pool: new Set(['p', 'q']), fuzzy: true });
    expect(result.mutualPairs).toEqual([['member:p', 'member:q']]);
    expect(checkPartners({ people: list, pool: new Set(['p', 'q']) }).mutualPairs).toEqual([]);
  });
});
