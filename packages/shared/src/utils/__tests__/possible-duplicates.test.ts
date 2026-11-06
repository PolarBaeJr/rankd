import { describe, it, expect } from 'vitest';
import {
  comparableEmail,
  duplicatePairKey,
  findPossibleDuplicates,
  isWorthAsking,
  matchExistingPeople,
  normaliseName,
  type DuplicateCandidate,
} from '../possible-duplicates';

const person = (id: string, fields: Omit<DuplicateCandidate, 'id'>): DuplicateCandidate => ({ id, ...fields });

describe('normaliseName', () => {
  it('ignores case, accents, punctuation and extra spaces', () => {
    expect(normaliseName('  José   Núñez ')).toBe('jose nunez');
    expect(normaliseName("O'Brien-Smith")).toBe('obrien smith');
    expect(normaliseName(null)).toBe('');
  });
});

describe('comparableEmail', () => {
  it('lower-cases a real address and drops the placeholders', () => {
    expect(comparableEmail(' Ada@SFU.ca ')).toBe('ada@sfu.ca');
    expect(comparableEmail('guest+0b5c2f1e-1111-4222-8333-944445555666@no-email.invalid')).toBeNull();
    expect(comparableEmail('deleted+abc@deleted.invalid')).toBeNull();
    expect(comparableEmail('')).toBeNull();
  });
});

describe('findPossibleDuplicates', () => {
  it('calls the same email strong, whatever its case', () => {
    const pairs = findPossibleDuplicates([
      person('b', { full_name: 'Ada Lovelace', email: 'ADA@sfu.ca' }),
      person('a', { full_name: 'Augusta King', email: 'ada@sfu.ca' }),
    ]);
    expect(pairs).toEqual([{ a: 'a', b: 'b', strength: 'strong', reasons: ['Same email'] }]);
  });

  it('calls the same student number or member code strong', () => {
    const pairs = findPossibleDuplicates([
      person('a', { full_name: 'Ada Lovelace', student_number: '301 234 567' }),
      person('b', { full_name: 'A. Byron', student_number: '301234567' }),
      person('c', { full_name: 'Grace Hopper', member_code: 'HOP1234' }),
      person('d', { full_name: 'Amazing Grace', member_code: 'hop1234' }),
    ]);
    expect(pairs.map((p) => [p.a, p.b, p.strength, p.reasons])).toEqual([
      ['a', 'b', 'strong', ['Same student number']],
      ['c', 'd', 'strong', ['Same member code']],
    ]);
  });

  it('calls the same name likely, with case, accents, spacing and order ignored', () => {
    const pairs = findPossibleDuplicates([
      person('a', { first_name: 'José', last_name: 'Núñez', full_name: 'José Núñez', email: 'one@sfu.ca' }),
      person('b', { full_name: '  jose   NUNEZ ', email: 'two@gmail.com' }),
      person('c', { full_name: 'Nunez Jose', email: 'three@gmail.com' }),
    ]);
    expect(pairs).toHaveLength(3);
    for (const pair of pairs) {
      expect(pair.strength).toBe('likely');
      expect(pair.reasons).toEqual(['Same name']);
    }
  });

  it('calls the same phone likely, not strong', () => {
    const pairs = findPossibleDuplicates([
      person('a', { full_name: 'Ada Lovelace', phone: '+1 (604) 555-0100' }),
      person('b', { full_name: 'Grace Hopper', phone: '604.555.0100' }),
    ]);
    expect(pairs).toEqual([{ a: 'a', b: 'b', strength: 'likely', reasons: ['Same phone'] }]);
  });

  it('calls a shared surname and first initial weak', () => {
    const pairs = findPossibleDuplicates([
      person('a', { first_name: 'John', last_name: 'Smith', full_name: 'John Smith' }),
      person('b', { first_name: 'J', last_name: 'Smith', full_name: 'J Smith' }),
      person('c', { first_name: 'Jane', last_name: 'Smithson', full_name: 'Jane Smithson' }),
    ]);
    expect(pairs).toEqual([{ a: 'a', b: 'b', strength: 'weak', reasons: ['Same surname and first initial'] }]);
  });

  it('keeps every reason and reports the strongest', () => {
    const [pair] = findPossibleDuplicates([
      person('a', { full_name: 'Ada Lovelace', email: 'ada@sfu.ca', phone: '6045550100' }),
      person('b', { full_name: 'Lovelace Ada', email: 'ada@sfu.ca', phone: '6045550100' }),
    ]);
    expect(pair?.strength).toBe('strong');
    expect(pair?.reasons).toEqual(['Same email', 'Same name', 'Same phone']);
  });

  it('never pairs two placeholder addresses, erased members or nameless stubs', () => {
    const pairs = findPossibleDuplicates([
      person('a', { full_name: 'Ada Lovelace', email: 'guest+1@no-email.invalid' }),
      person('b', { full_name: 'Grace Hopper', email: 'guest+1@no-email.invalid' }),
      person('c', { first_name: 'Deleted', last_name: 'Player', full_name: 'Deleted Player', email: 'deleted+c@deleted.invalid' }),
      person('d', { first_name: 'Deleted', last_name: 'Player', full_name: 'Deleted Player', email: 'deleted+d@deleted.invalid' }),
      person('e', { first_name: '', full_name: '', email: 'e@sfu.ca' }),
      person('f', { first_name: '', full_name: '', email: 'f@sfu.ca' }),
    ]);
    expect(pairs).toEqual([]);
  });

  it('does not match on a first name alone', () => {
    expect(findPossibleDuplicates([person('a', { full_name: 'Ada' }), person('b', { full_name: 'Ada' })])).toEqual([]);
  });

  it('leaves out a dismissed pair, whichever way round it was dismissed', () => {
    const people = [person('a', { full_name: 'Ada Lovelace' }), person('b', { full_name: 'Ada Lovelace' })];
    expect(findPossibleDuplicates(people, new Set([duplicatePairKey('b', 'a')]))).toEqual([]);
    expect(findPossibleDuplicates(people)).toHaveLength(1);
  });

  it('lists each pair once and the strongest first', () => {
    const pairs = findPossibleDuplicates([
      person('a', { first_name: 'John', last_name: 'Smith', full_name: 'John Smith', email: 'x@sfu.ca' }),
      person('b', { first_name: 'J', last_name: 'Smith', full_name: 'J Smith' }),
      person('c', { full_name: 'Grace Hopper', email: 'x@sfu.ca' }),
    ]);
    expect(pairs.map((p) => `${p.a}${p.b}:${p.strength}`)).toEqual(['ac:strong', 'ab:weak']);
  });
});

describe('matchExistingPeople', () => {
  const roster = [
    person('m1', { first_name: 'Wei', last_name: 'Chen', full_name: 'Wei Chen', email: 'wchen@sfu.ca' }),
    person('m2', { first_name: 'Grace', last_name: 'Hopper', full_name: 'Grace Hopper', email: 'grace@sfu.ca' }),
    person('m3', { first_name: 'Deleted', last_name: 'Player', full_name: 'Deleted Player', email: 'deleted+m3@deleted.invalid' }),
  ];

  it('finds a typed name, swapped and in any case', () => {
    expect(matchExistingPeople({ full_name: 'chen WEI' }, roster)).toEqual([
      { id: 'm1', strength: 'likely', reasons: ['Same name'] },
    ]);
  });

  it('finds a typed email as strong', () => {
    expect(matchExistingPeople({ full_name: 'Amazing Grace', email: 'Grace@SFU.ca' }, roster)).toEqual([
      { id: 'm2', strength: 'strong', reasons: ['Same email'] },
    ]);
  });

  it('never offers an erased member and finds nothing for a stranger', () => {
    expect(matchExistingPeople({ full_name: 'Deleted Player' }, roster)).toEqual([]);
    expect(matchExistingPeople({ full_name: 'Ada Lovelace', email: 'guest+1@no-email.invalid' }, roster)).toEqual([]);
  });
});

describe('isWorthAsking', () => {
  it('asks about strong and likely, not weak', () => {
    expect(isWorthAsking('strong')).toBe(true);
    expect(isWorthAsking('likely')).toBe(true);
    expect(isWorthAsking('weak')).toBe(false);
  });
});
