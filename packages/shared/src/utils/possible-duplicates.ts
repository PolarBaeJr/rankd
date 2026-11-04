// WHICH PLAYER RECORDS MIGHT BE THE SAME PERSON.
//
// Advice for an officer, never a merge. Two real people can share a name, and a
// merge moves history in a way that is hard to undo, so this only says which
// pairs to look at and why. The console lists them beside the existing merge
// dialog, and the two creation paths ask "Did you mean" before making a second
// record.
//
// STRENGTH
//   strong  the same email, or the same student number or member code
//   likely  the same full name once normalised (case, accents, extra spaces,
//           first and last swapped), or the same phone number
//   weak    the same surname and the same first initial
//
// A phone number is "likely", not "strong": a family can share one.
//
// Rows that cannot be a person's live record are left out: an erased member
// (deleted+<id>@deleted.invalid, named Deleted Player) would otherwise pair
// with every other erased member, and a signup stub has no name to compare.
// The placeholder address a guest with no email gets
// (guest+<uuid>@no-email.invalid, 00306) is never compared.
//
// Built from key maps, not every pair against every other: the console runs
// this over the whole roster on each render.

export interface DuplicateCandidate {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  email?: string | null;
  member_code?: string | null;
  student_number?: string | null;
  phone?: string | null;
}

export type DuplicateStrength = 'strong' | 'likely' | 'weak';

export interface DuplicatePair {
  /** The lower of the two ids, so a pair has one spelling. */
  a: string;
  b: string;
  strength: DuplicateStrength;
  reasons: string[];
}

export interface DuplicateMatch {
  id: string;
  strength: DuplicateStrength;
  reasons: string[];
}

const RANK: Record<DuplicateStrength, number> = { strong: 3, likely: 2, weak: 1 };

/** Lower-cased, accents and punctuation gone, single-spaced. */
export function normaliseName(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The address to compare, or null for none and for a placeholder. */
export function comparableEmail(email: string | null | undefined): string | null {
  const value = (email ?? '').trim().toLowerCase();
  if (!value || value.endsWith('@no-email.invalid') || value.endsWith('@deleted.invalid')) return null;
  return value;
}

function comparablePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  // A leading country code 1 is the same number written two ways.
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function comparableCode(code: string | null | undefined): string | null {
  const value = (code ?? '').replace(/\s+/g, '').toLowerCase();
  return value || null;
}

function nameTokens(person: DuplicateCandidate): string[] {
  const whole = person.full_name?.trim()
    ? person.full_name
    : [person.first_name, person.last_name].filter(Boolean).join(' ');
  return normaliseName(whole).split(' ').filter(Boolean);
}

/** The words of the name in sorted order, so "Wei Chen" and "Chen Wei" agree. */
function fullNameKey(tokens: string[]): string | null {
  return tokens.length >= 2 ? [...tokens].sort().join(' ') : null;
}

/** Surname plus first initial, as typed (first name first). */
function initialKey(person: DuplicateCandidate, tokens: string[]): string | null {
  const first = normaliseName(person.first_name).split(' ')[0] || tokens[0];
  const surnameTokens = normaliseName(person.last_name).split(' ').filter(Boolean);
  const surname = surnameTokens.length > 0 ? surnameTokens[surnameTokens.length - 1] : tokens.length >= 2 ? tokens[tokens.length - 1] : '';
  if (!first || !surname || tokens.length < 2) return null;
  return `${surname} ${first[0]}`;
}

function isErased(person: DuplicateCandidate): boolean {
  return (person.email ?? '').toLowerCase().endsWith('@deleted.invalid');
}

interface Keys {
  email: string | null;
  code: string | null;
  student: string | null;
  phone: string | null;
  name: string | null;
  initial: string | null;
}

function keysOf(person: DuplicateCandidate): Keys {
  const tokens = nameTokens(person);
  return {
    email: comparableEmail(person.email),
    code: comparableCode(person.member_code),
    student: comparableCode(person.student_number),
    phone: comparablePhone(person.phone),
    name: fullNameKey(tokens),
    initial: initialKey(person, tokens),
  };
}

/** Why two key sets agree, strongest reason first, or null when they do not. */
function compare(x: Keys, y: Keys): { strength: DuplicateStrength; reasons: string[] } | null {
  const reasons: string[] = [];
  let strength: DuplicateStrength | null = null;
  const raise = (to: DuplicateStrength) => {
    if (strength === null || RANK[to] > RANK[strength]) strength = to;
  };
  if (x.email && x.email === y.email) { reasons.push('Same email'); raise('strong'); }
  if (x.student && x.student === y.student) { reasons.push('Same student number'); raise('strong'); }
  if (x.code && x.code === y.code) { reasons.push('Same member code'); raise('strong'); }
  if (x.name && x.name === y.name) { reasons.push('Same name'); raise('likely'); }
  if (x.phone && x.phone === y.phone) { reasons.push('Same phone'); raise('likely'); }
  if (!(x.name && x.name === y.name) && x.initial && x.initial === y.initial) {
    reasons.push('Same surname and first initial');
    raise('weak');
  }
  return strength === null ? null : { strength, reasons };
}

/** The key a pair is stored and dismissed under: the two ids in order. */
export function duplicatePairKey(first: string, second: string): string {
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

/**
 * Every pair of records that might be one person, strongest first. A pair in
 * `dismissed` (keys from duplicatePairKey) is left out.
 */
export function findPossibleDuplicates(
  people: readonly DuplicateCandidate[],
  dismissed: ReadonlySet<string> = new Set(),
): DuplicatePair[] {
  const live = people.filter((p) => !isErased(p));
  const keys = new Map(live.map((p) => [p.id, keysOf(p)]));
  const buckets = new Map<string, string[]>();
  for (const person of live) {
    const k = keys.get(person.id)!;
    const entries: [string, string | null][] = [
      ['e', k.email], ['c', k.code], ['s', k.student], ['p', k.phone], ['n', k.name], ['i', k.initial],
    ];
    for (const [kind, value] of entries) {
      if (!value) continue;
      const bucket = `${kind}:${value}`;
      const ids = buckets.get(bucket);
      if (ids) ids.push(person.id);
      else buckets.set(bucket, [person.id]);
    }
  }

  const seen = new Set<string>();
  const pairs: DuplicatePair[] = [];
  for (const ids of buckets.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pairKey = duplicatePairKey(ids[i]!, ids[j]!);
        if (seen.has(pairKey) || dismissed.has(pairKey)) continue;
        seen.add(pairKey);
        const result = compare(keys.get(ids[i]!)!, keys.get(ids[j]!)!);
        if (!result) continue;
        const [a, b] = ids[i]! < ids[j]! ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!];
        pairs.push({ a, b, ...result });
      }
    }
  }
  return pairs.sort((x, y) => RANK[y.strength] - RANK[x.strength] || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}

/**
 * The existing records a person about to be created might already be,
 * strongest first. `typed` needs no id; erased records are never offered.
 */
export function matchExistingPeople(
  typed: Omit<DuplicateCandidate, 'id'>,
  existing: readonly DuplicateCandidate[],
): DuplicateMatch[] {
  const mine = keysOf({ ...typed, id: '' });
  const matches: DuplicateMatch[] = [];
  for (const person of existing) {
    if (isErased(person)) continue;
    const result = compare(mine, keysOf(person));
    if (result) matches.push({ id: person.id, ...result });
  }
  return matches.sort((x, y) => RANK[y.strength] - RANK[x.strength]);
}

/** Strong and likely only: what the console shows and what stops a create. */
export function isWorthAsking(strength: DuplicateStrength): boolean {
  return strength !== 'weak';
}
