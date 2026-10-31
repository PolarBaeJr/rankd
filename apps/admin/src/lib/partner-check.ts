// THE PARTNER CHECK (00311). Pure: no database, no React, so the sign-up list,
// the linked tournament's Unpaired block and the desk's actions all read the
// same answer from the same input.
//
// Each person's partner is the desk's choice when there is one, otherwise what
// they typed on the Google Form matched against the people signed up. The
// match is ADVICE: nothing pairs anybody from it. The check then says how the
// two people relate (mutual, one-sided, already teamed), and who is asked for
// by more than one person.

/** One sign-up. `key` is 'member:<playerId>' or 'guest:<externalId>', as the event page keys its rows. */
export interface PartnerPerson {
  key: string;
  /** Null for a non-member sign-up, who has no player record. */
  playerId: string | null;
  name: string;
  /** What they typed on the Form, as typed. */
  wrote: string | null;
  /** The desk's choice: null partnerKey is "No preferred partner". Null desk is no choice. */
  desk: { partnerKey: string | null } | null;
}

export type OneSidedReason = 'named_nobody' | 'named_other' | 'unresolved';

export type PartnerRelation =
  | { kind: 'paired' }
  | { kind: 'taken'; teamedWith: string }
  | { kind: 'mutual' }
  | { kind: 'one_sided'; reason: 'named_nobody' }
  | { kind: 'one_sided'; reason: 'named_other'; namedKey: string }
  | { kind: 'one_sided'; reason: 'unresolved' };

export type PartnerOutgoing =
  | { state: 'none'; source: 'desk' | 'typed' }
  | { state: 'matched'; source: 'desk' | 'typed'; partnerKey: string; relation: PartnerRelation }
  | { state: 'ambiguous'; candidates: string[] }
  | { state: 'no_match' };

export interface PartnerCheck {
  outgoing: PartnerOutgoing;
  /** Who named this person, in input order. */
  requestedBy: string[];
  /** Two or more asked for this person, none of them mutual, and this person is not teamed. */
  contested: boolean;
  /** The person this one and they both named each other, if any. */
  mutualWith: string | null;
  /** The desk picked somebody who is no longer signed up; the typed note is used instead. */
  deskStale: boolean;
  /** Who this person is already teamed with in the linked tournament, if anyone. */
  teamedWith: string | null;
}

export interface PartnerCheckResult {
  byKey: Map<string, PartnerCheck>;
  /** Two people who named each other, both with player records, both waiting for a partner. */
  mutualPairs: [string, string][];
}

const PLACEHOLDERS = new Set([
  '',
  'none',
  'no',
  'na',
  'n a',
  'any',
  'anyone',
  'random',
  'no preference',
  'nobody',
  'no one',
  'idk',
  'tbd',
]);

/** Lower case, accents and parenthesised asides dropped, punctuation to spaces. */
export function normalizeName(value: string): string {
  return value
    .replace(/\([^)]*\)/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The keys a typed note can mean, best tier first; empty when none. */
function matchTyped(note: string, self: PartnerPerson, people: PartnerPerson[]): string[] {
  const wanted = normalizeName(note);
  const tokens = wanted.split(' ');
  const others = people
    .filter((person) => person.key !== self.key)
    .map((person) => ({ key: person.key, normalized: normalizeName(person.name) }))
    .filter((person) => person.normalized !== '');

  const exact = others.filter((person) => person.normalized === wanted);
  if (exact.length > 0) return exact.map((person) => person.key);

  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  return others
    .filter((person) => {
      const candidate = person.normalized.split(' ');
      if (candidate[0] !== first) return false;
      if (tokens.length === 1) return true;
      return candidate.length > 1 && candidate[candidate.length - 1]!.startsWith(last);
    })
    .map((person) => person.key);
}

type Resolved =
  | { state: 'none'; source: 'desk' | 'typed' }
  | { state: 'matched'; source: 'desk' | 'typed'; partnerKey: string }
  | { state: 'ambiguous'; candidates: string[] }
  | { state: 'no_match' };

export function checkPartners(input: {
  people: PartnerPerson[];
  teams?: [string, string][];
  pool?: Set<string>;
}): PartnerCheckResult {
  const { people } = input;
  const pool = input.pool ?? new Set<string>();
  const present = new Set(people.map((person) => person.key));

  const keyByPlayer = new Map<string, string>();
  for (const person of people) if (person.playerId) keyByPlayer.set(person.playerId, person.key);
  const teamedWith = new Map<string, string>();
  for (const [a, b] of input.teams ?? []) {
    const keyA = keyByPlayer.get(a);
    const keyB = keyByPlayer.get(b);
    if (keyA && keyB) {
      teamedWith.set(keyA, keyB);
      teamedWith.set(keyB, keyA);
    } else if (keyA) {
      teamedWith.set(keyA, `player:${b}`);
    } else if (keyB) {
      teamedWith.set(keyB, `player:${a}`);
    }
  }

  const resolved = new Map<string, Resolved>();
  const deskStale = new Map<string, boolean>();
  for (const person of people) {
    let stale = false;
    if (person.desk) {
      const pick = person.desk.partnerKey;
      if (pick === null) {
        resolved.set(person.key, { state: 'none', source: 'desk' });
        deskStale.set(person.key, false);
        continue;
      }
      if (present.has(pick) && pick !== person.key) {
        resolved.set(person.key, { state: 'matched', source: 'desk', partnerKey: pick });
        deskStale.set(person.key, false);
        continue;
      }
      stale = true;
    }
    deskStale.set(person.key, stale);
    const note = person.wrote ?? '';
    if (PLACEHOLDERS.has(normalizeName(note))) {
      resolved.set(person.key, { state: 'none', source: 'typed' });
      continue;
    }
    const hits = matchTyped(note, person, people);
    if (hits.length === 1) resolved.set(person.key, { state: 'matched', source: 'typed', partnerKey: hits[0]! });
    else if (hits.length > 1) resolved.set(person.key, { state: 'ambiguous', candidates: hits });
    else resolved.set(person.key, { state: 'no_match' });
  }

  const targetOf = (key: string): string | null => {
    const r = resolved.get(key);
    return r && r.state === 'matched' ? r.partnerKey : null;
  };

  const byKey = new Map<string, PartnerCheck>();
  for (const person of people) {
    const r = resolved.get(person.key)!;
    let outgoing: PartnerOutgoing;
    if (r.state === 'matched') {
      const target = r.partnerKey;
      const targetTeam = teamedWith.get(target);
      const targetResolved = resolved.get(target)!;
      let relation: PartnerRelation;
      if (teamedWith.get(person.key) === target) relation = { kind: 'paired' };
      else if (targetTeam) relation = { kind: 'taken', teamedWith: targetTeam };
      else if (targetOf(target) === person.key) relation = { kind: 'mutual' };
      else if (targetResolved.state === 'none') relation = { kind: 'one_sided', reason: 'named_nobody' };
      else if (targetResolved.state === 'matched') {
        relation = { kind: 'one_sided', reason: 'named_other', namedKey: targetResolved.partnerKey };
      } else relation = { kind: 'one_sided', reason: 'unresolved' };
      outgoing = { state: 'matched', source: r.source, partnerKey: target, relation };
    } else {
      outgoing = r;
    }
    byKey.set(person.key, {
      outgoing,
      requestedBy: [],
      contested: false,
      mutualWith: null,
      deskStale: deskStale.get(person.key) ?? false,
      teamedWith: teamedWith.get(person.key) ?? null,
    });
  }

  for (const person of people) {
    const target = targetOf(person.key);
    if (target) byKey.get(target)!.requestedBy.push(person.key);
  }
  for (const person of people) {
    const check = byKey.get(person.key)!;
    const target = targetOf(person.key);
    if (target && targetOf(target) === person.key && !teamedWith.has(target) && !teamedWith.has(person.key)) {
      check.mutualWith = target;
    }
    if (check.requestedBy.length >= 2 && !check.teamedWith) {
      const mutual = check.requestedBy.some((requester) => targetOf(person.key) === requester);
      check.contested = !mutual;
    }
  }

  const mutualPairs: [string, string][] = [];
  const seen = new Set<string>();
  for (const person of people) {
    const check = byKey.get(person.key)!;
    const other = check.mutualWith;
    if (!other || seen.has(person.key)) continue;
    const partner = people.find((candidate) => candidate.key === other)!;
    seen.add(person.key);
    seen.add(other);
    if (!person.playerId || !partner.playerId) continue;
    if (!pool.has(person.playerId) || !pool.has(partner.playerId)) continue;
    if (check.teamedWith || byKey.get(other)!.teamedWith) continue;
    mutualPairs.push([person.key, other]);
  }

  return { byKey, mutualPairs };
}

// ---------------------------------------------------------------------------
// What a row shows. Built on the server so the client is handed names and
// plain values, never the Map.

export type PartnerBadgeTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export interface PartnerAdvice {
  wrote: string | null;
  /** 'none' or 'pick' when the desk's choice is in effect. */
  desk: 'none' | 'pick' | null;
  deskStale: boolean;
  badges: { tone: PartnerBadgeTone; text: string }[];
  /** Names of those who asked for this person, shown on this row only. */
  requestedBy: string[];
  contested: boolean;
  /** The dialog's preselected value: 'typed', 'none' or a person's key. */
  preselect: string;
  /** Present when this row may be paired with the person they named each other with. */
  mutualPair: { playerId: string; partnerPlayerId: string; partnerName: string } | null;
  /** For the contest dialog: who can be paired with this person, and who cannot. */
  pairable: { playerId: string; name: string }[];
  unpairable: { name: string; reason: string }[];
}

function namesList(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Every person's advice, keyed as the people are. */
export function partnerAdvice(
  people: PartnerPerson[],
  result: PartnerCheckResult,
  pool: Set<string>,
): Record<string, PartnerAdvice> {
  const byKey = new Map(people.map((person) => [person.key, person]));
  const nameOf = (key: string) => byKey.get(key)?.name ?? 'somebody not signed up';
  const pairs = new Map<string, string>();
  for (const [a, b] of result.mutualPairs) {
    pairs.set(a, b);
    pairs.set(b, a);
  }

  const advice: Record<string, PartnerAdvice> = {};
  for (const person of people) {
    const check = result.byKey.get(person.key);
    if (!check) continue;
    const badges: PartnerAdvice['badges'] = [];
    const out = check.outgoing;
    if (check.deskStale) badges.push({ tone: 'warning', text: 'The desk\'s pick is no longer signed up' });
    if (check.teamedWith) badges.push({ tone: 'success', text: 'Teamed' });
    if (out.state === 'matched') {
      const partner = nameOf(out.partnerKey);
      const relation = out.relation;
      if (relation.kind === 'mutual') badges.push({ tone: 'success', text: `Mutual: ${partner}` });
      else if (relation.kind === 'taken') {
        badges.push({ tone: 'danger', text: `${partner} is already teamed with ${nameOf(relation.teamedWith)}` });
      } else if (relation.kind === 'one_sided') {
        if (relation.reason === 'named_nobody') {
          badges.push({ tone: 'warning', text: `Wants ${partner}, who named nobody` });
        } else if (relation.reason === 'named_other') {
          badges.push({ tone: 'warning', text: `Wants ${partner}, who named ${nameOf(relation.namedKey)}` });
        } else {
          badges.push({ tone: 'neutral', text: `Wants ${partner}` });
        }
      }
    } else if (out.state === 'no_match') {
      badges.push({ tone: 'warning', text: 'No sign-up matches' });
    } else if (out.state === 'ambiguous') {
      badges.push({
        tone: 'warning',
        text: `Matches ${out.candidates.length}: ${out.candidates.map(nameOf).join(', ')}`,
      });
    }
    const askers = check.requestedBy.filter((key) => key !== check.mutualWith && key !== check.teamedWith);
    if (check.contested) {
      badges.push({ tone: 'warning', text: `Requested by ${namesList(check.requestedBy.map(nameOf))}` });
    } else if (askers.length > 0) {
      const text = check.mutualWith ? 'Also requested by' : 'Requested by';
      badges.push({ tone: 'neutral', text: `${text} ${namesList(askers.map(nameOf))}` });
    }

    const desk = out.state === 'none' && out.source === 'desk'
      ? 'none'
      : out.state === 'matched' && out.source === 'desk'
        ? 'pick'
        : null;
    const preselect = desk === 'none'
      ? 'none'
      : out.state === 'matched'
        ? out.partnerKey
        : 'typed';

    const pairable: PartnerAdvice['pairable'] = [];
    const unpairable: PartnerAdvice['unpairable'] = [];
    if (check.contested) {
      for (const key of check.requestedBy) {
        const requester = byKey.get(key)!;
        const teamed = result.byKey.get(key)?.teamedWith;
        if (requester.playerId && pool.has(requester.playerId)) {
          pairable.push({ playerId: requester.playerId, name: requester.name });
        } else if (teamed) {
          unpairable.push({ name: requester.name, reason: `already teamed with ${nameOf(teamed)}` });
        } else if (!requester.playerId) {
          unpairable.push({ name: requester.name, reason: 'a non-member who has not entered the tournament' });
        } else {
          unpairable.push({ name: requester.name, reason: 'not waiting for a partner in the tournament' });
        }
      }
    }

    const mutualKey = pairs.get(person.key);
    const mutualPerson = mutualKey ? byKey.get(mutualKey) : undefined;
    advice[person.key] = {
      wrote: person.wrote,
      desk,
      deskStale: check.deskStale,
      badges,
      requestedBy: check.requestedBy.map(nameOf),
      contested: check.contested,
      preselect,
      mutualPair:
        mutualPerson && person.playerId && mutualPerson.playerId
          ? { playerId: person.playerId, partnerPlayerId: mutualPerson.playerId, partnerName: mutualPerson.name }
          : null,
      pairable,
      unpairable,
    };
  }
  return advice;
}
