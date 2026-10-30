// "Paste a list" on /fees: an exec pastes who paid (an e-transfer export, a
// column out of a spreadsheet, a list typed into a chat) and the console says
// who that is before anything is recorded.
//
// NOT a 'use server' module: this is the plain part, the parser and the
// matcher, so it can be tested without a framework. The action that reads the
// roster and calls it is actions/fee-paste.ts; the writes are the existing
// bulkMarkFeesPaid and bulkAddManualFees, so nothing here decides who may do
// what.
//
// ONLY AN EMAIL OR AN EXACT FULL NAME MARKS ANYBODY ON ITS OWN. Everything
// looser (a surname and an initial, a display name) is offered as a candidate
// beside a not-found row, and nothing is marked until the exec picks one:
// marking the wrong Jane paid is a record that looks correct and is not, and
// nothing downstream would ever notice it.

import { isWaivedFee } from './fee-status';

/** The most entries one paste is read into. The rest are reported, not dropped. */
export const MAX_PASTE_ENTRIES = 500;

/** The column CHECK on club_fees.manual_email (00252), and the same test here. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Bounded on purpose. A spreadsheet row often carries a student number or a
// phone number, and an unbounded "digits are money" rule would read one as a
// six-figure payment.
const AMOUNT_RE = /^\$?\s*(\d{1,4})(?:\.(\d{1,2}))?$/;

// A line made only of these is a spreadsheet's header row, not a person.
const HEADER_WORDS = new Set([
  'name', 'names', 'full name', 'fullname', 'first name', 'firstname', 'first',
  'last name', 'lastname', 'last', 'surname', 'email', 'emails', 'e-mail',
  'email address', 'amount', 'paid', 'date', 'notes', 'note', 'method',
  'reference', 'sender', 'from', 'memo', 'message',
]);

// Wrapping punctuation that clings to an address pasted out of prose or a
// mail client: `<jane@example.org>`, `(jane@example.org)`, `jane@example.org.`
const EMAIL_WRAP_RE = /^[<("'[{]+|[>)"'\]}.,:;!?]+$/g;

export interface PastedPayer {
  kind: 'payer';
  /** The line (or the part of it) this came from, for the result view. */
  raw: string;
  name: string | null;
  /** Trimmed and lowercased, the form the column CHECK requires. */
  email: string | null;
  amountCents: number | null;
}

export interface PastedInvalid {
  kind: 'invalid';
  raw: string;
  reason: string;
}

export type PastedEntry = PastedPayer | PastedInvalid;

/**
 * Case, spacing, accents and surrounding punctuation removed, so "  ZOË  doe."
 * and "Zoe Doe" compare equal. Used for matching only; what is shown and stored
 * is always the name as it was typed.
 */
export function normalisePersonName(s: string): string {
  return s
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
}

function cleanEmail(token: string): string | null {
  const candidate = token.trim().replace(EMAIL_WRAP_RE, '').toLowerCase();
  return EMAIL_RE.test(candidate) ? candidate : null;
}

function parseAmount(field: string): number | null {
  const m = AMOUNT_RE.exec(field.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  // A $0 entry is not a payment, and manual_fee refuses one anyway.
  return cents > 0 ? cents : null;
}

function isHeaderField(field: string): boolean {
  const f = field.trim().toLowerCase().replace(/[^a-z -]/g, '').replace(/\s+/g, ' ').trim();
  return f !== '' && HEADER_WORDS.has(f);
}

function tidyName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
}

const hasLetter = (s: string) => /\p{L}/u.test(s);

interface Fields {
  emails: string[];
  badEmails: string[];
  amounts: number[];
  names: string[];
}

// Sorts the fields of one record into what they are. Within a field, an email
// may sit among words ("Jane Doe <jane@example.org>") and an amount may be written
// inline with a dollar sign ("Jane Doe $25"); a bare number inline is left to
// the name, where the letter test below throws it away.
function classify(fields: string[]): Fields {
  const out: Fields = { emails: [], badEmails: [], amounts: [], names: [] };
  for (const field of fields) {
    const whole = field.replace(/[<>]/g, ' ').trim();
    if (whole === '') continue;
    const amount = parseAmount(whole);
    if (amount != null) {
      out.amounts.push(amount);
      continue;
    }
    const words: string[] = [];
    for (const token of whole.split(/\s+/)) {
      if (token.includes('@')) {
        const email = cleanEmail(token);
        if (email) out.emails.push(email);
        else out.badEmails.push(token);
        continue;
      }
      if (token.startsWith('$')) {
        const inline = parseAmount(token);
        if (inline != null) {
          out.amounts.push(inline);
          continue;
        }
      }
      words.push(token);
    }
    const name = tidyName(words.join(' '));
    // A cell of digits or punctuation (a student number, a date) is not a name.
    if (name !== '' && hasLetter(name)) out.names.push(name);
  }
  return out;
}

function payer(raw: string, name: string | null, email: string | null, amountCents: number | null): PastedPayer {
  return { kind: 'payer', raw, name, email, amountCents };
}

function invalid(raw: string, reason: string): PastedInvalid {
  return { kind: 'invalid', raw, reason };
}

// One record: a spreadsheet row, or one part of a comma list. Every email-less
// name field joins into one name, which is what "Jane | Doe | jane@example.org"
// columns mean.
function oneRecord(raw: string, fields: string[]): PastedEntry {
  const c = classify(fields);
  if (c.badEmails.length > 0 && c.emails.length === 0) {
    return invalid(raw, `"${c.badEmails[0]}" is not a valid email address.`);
  }
  if (c.emails.length > 1) {
    return invalid(raw, 'More than one email address on one row. Put each person on their own line.');
  }
  const name = c.names.length > 0 ? c.names.join(' ') : null;
  const email = c.emails[0] ?? null;
  if (!name && !email) return invalid(raw, 'Could not find a name or an email address.');
  return payer(raw, name, email, c.amounts.length === 1 ? c.amounts[0]! : null);
}

function parseLine(line: string): PastedEntry[] {
  // A spreadsheet row: one person, the cells are their fields.
  if (line.includes('\t')) {
    const cells = line.split('\t');
    if (cells.every((cell) => cell.trim() === '' || isHeaderField(cell))) return [];
    return [oneRecord(line, cells)];
  }

  const parts = line.split(',');
  if (parts.every((p) => p.trim() === '' || isHeaderField(p))) return [];

  const emailCount = line.split(/[\s,<>]+/).filter((t) => t.includes('@') && cleanEmail(t)).length;

  // Several addresses: a comma-separated list, one person per part.
  if (emailCount >= 2) {
    return parts
      .filter((p) => p.trim() !== '')
      .map((p) => oneRecord(p.trim(), [p]));
  }

  // One address: the commas separate that person's fields.
  if (emailCount === 1 || line.includes('@')) return [oneRecord(line, parts)];

  // No address at all. Amount fields come off first, so "Jane Doe, 25" is a
  // name and a payment rather than a surname.
  const amounts: number[] = [];
  const nameParts: string[] = [];
  for (const p of parts) {
    const amount = parseAmount(p);
    if (amount != null) amounts.push(amount);
    else if (p.trim() !== '') nameParts.push(p.trim());
  }
  const amountCents = amounts.length === 1 ? amounts[0]! : null;

  if (nameParts.length === 2) {
    const [last, first] = nameParts as [string, string];
    // "Doe, Jane" is one person written surname first. Two full names either
    // side of the comma ("Jane Doe, Sam Lee") is a list of two, and reading it
    // as one would invent a person called "Sam Lee Jane Doe".
    if (!(/\s/.test(last) && /\s/.test(first))) {
      return [nameOnly(line, `${first} ${last}`, amountCents)];
    }
  }
  if (nameParts.length >= 2) {
    // A list of names shares no amount: which of them it belonged to is a guess.
    return nameParts.map((p) => nameOnly(p, p, null));
  }
  return [nameOnly(line, nameParts[0] ?? '', amountCents)];
}

// An inline "$25" still comes off a name here, as it does beside an email.
function nameOnly(raw: string, text: string, amountCents: number | null): PastedEntry {
  const c = classify([text]);
  const name = c.names.join(' ');
  if (name === '') return invalid(raw, 'Could not find a name or an email address.');
  return payer(raw, name, null, amountCents ?? (c.amounts.length === 1 ? c.amounts[0]! : null));
}

function dedupeKey(p: PastedPayer): string {
  return p.email ? `e:${p.email}` : `n:${normalisePersonName(p.name ?? '')}`;
}

/**
 * Read a pasted list into one entry per person.
 *
 * Lines split on newlines and semicolons. A TAB means a spreadsheet row and the
 * cells are one person's fields. Commas: two or more addresses on a line make
 * it a list; one address makes the commas that person's fields; no address and
 * one comma is "Last, First"; no address and more commas is a list of names.
 *
 * Duplicates collapse to the first. Past MAX_PASTE_ENTRIES the rest come back
 * as invalid, one apiece, so nothing silently disappears off the end.
 */
export function parsePastedPayers(text: string): PastedEntry[] {
  const out: PastedEntry[] = [];
  const seen = new Set<string>();
  let payers = 0;

  for (const rawLine of text.split(/\r?\n|;/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    for (const entry of parseLine(line)) {
      if (entry.kind === 'invalid') {
        out.push(entry);
        continue;
      }
      const key = dedupeKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      if (payers >= MAX_PASTE_ENTRIES) {
        out.push(invalid(entry.raw, `Only the first ${MAX_PASTE_ENTRIES} people in a paste are read. Paste the rest separately.`));
        continue;
      }
      payers += 1;
      out.push(entry);
    }
  }
  return out;
}

// ─── MATCHING ─────────────────────────────────────────────────────────────────

export interface PasteRosterPlayer {
  id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  email: string | null;
  status: string;
  is_exec: boolean;
  fee_exempt: boolean;
  deletion_requested_at: string | null;
}

export interface PasteDuesRow {
  id: string;
  player_id: string | null;
  manual_name: string | null;
  manual_email: string | null;
  paid_at: string | null;
  method: string | null;
  amount_cents: number | null;
}

export interface PasteMatchResult {
  willMark: Array<{ entry: PastedPayer; player: PasteRosterPlayer }>;
  alreadyPaid: Array<{ entry: PastedPayer; player: PasteRosterPlayer }>;
  waived: Array<{ entry: PastedPayer; player: PasteRosterPlayer }>;
  notBillable: Array<{ entry: PastedPayer; player: PasteRosterPlayer; reason: string }>;
  ambiguous: Array<{ entry: PastedPayer; candidates: PasteRosterPlayer[]; reason: string }>;
  /** `paid` false: a Google Form's named row (00290), waiting on its receipt under To review. */
  alreadyNamed: Array<{ entry: PastedPayer; manualName: string; paid: boolean }>;
  notFound: Array<{ entry: PastedPayer; possibleMembers: PasteRosterPlayer[] }>;
  invalid: PastedInvalid[];
  /** Unclaimed named payments this season that look like a member on the roster. */
  namedMatches: PasteNamedMatch[];
  /** Where every member offered as a candidate above stands this season. */
  statusOf: Map<string, PasteCandidateStatus>;
}

export type PasteCandidateState = 'will_mark' | 'already_paid' | 'waived' | 'not_billable';

export interface PasteCandidateStatus {
  state: PasteCandidateState;
  reason: string | null;
}

export type PasteMemberDues = 'none' | 'unpaid' | 'paid' | 'waived';

export interface PasteNamedMatch {
  row: PasteDuesRow;
  candidates: Array<{
    player: PasteRosterPlayer;
    /** email and name are the same person by the rule this file marks on; similar is a hint. */
    match: 'email' | 'name' | 'similar';
    memberDues: PasteMemberDues;
  }>;
}

const isTombstone = (p: PasteRosterPlayer) => (p.email ?? '').toLowerCase().endsWith('@deleted.invalid');

/**
 * Why somebody on the roster is not billed, or null when they are.
 *
 * Billable is the /fees roster's own predicate (competitive or recreational,
 * not exec, not fee-exempt), plus one more: a member who has asked for their
 * account to be deleted is on that roster but is not marked from a paste.
 */
export function notBillableReason(p: PasteRosterPlayer): string | null {
  if (p.status === 'pending_approval') return 'Pending approval';
  if (p.status === 'suspended') return 'Suspended';
  if (p.status !== 'competitive' && p.status !== 'recreational') return `Not an active member (${p.status})`;
  if (p.is_exec) return 'Exec, not billed a season fee';
  if (p.fee_exempt) return 'Fee exempt';
  if (p.deletion_requested_at) return 'Has asked for their account to be deleted';
  return null;
}

function firstAndLast(p: PasteRosterPlayer): { first: string; last: string } {
  const tokens = normalisePersonName(p.full_name).split(' ');
  return {
    first: p.first_name ? normalisePersonName(p.first_name) : tokens[0] ?? '',
    last: p.last_name ? normalisePersonName(p.last_name) : tokens[tokens.length - 1] ?? '',
  };
}

// Hints for a name that matched nobody exactly. Acted on only when an exec picks one.
function possibleMembersFor(name: string, pool: PasteRosterPlayer[]): PasteRosterPlayer[] {
  const norm = normalisePersonName(name);
  const tokens = norm.split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  const hits: PasteRosterPlayer[] = [];
  for (const p of pool) {
    const names = firstAndLast(p);
    const byParts = p.first_name != null && normalisePersonName(`${p.first_name} ${p.last_name ?? ''}`) === norm;
    const byDisplay = p.display_name != null && normalisePersonName(p.display_name) === norm;
    const bySurname =
      tokens.length >= 2 && names.last !== '' && names.last === last && names.first.charAt(0) === first.charAt(0);
    if (byParts || byDisplay || bySurname) hits.push(p);
    if (hits.length === 3) break;
  }
  return hits;
}

function memberDuesOf(fee: PasteDuesRow | undefined): PasteMemberDues {
  if (!fee) return 'none';
  if (isWaivedFee(fee)) return 'waived';
  return fee.paid_at ? 'paid' : 'unpaid';
}

/** What choosing this member on an ambiguous or hinted row would do. */
export function candidateStatus(p: PasteRosterPlayer, fee: PasteDuesRow | undefined): PasteCandidateStatus {
  const reason = notBillableReason(p);
  if (reason) return { state: 'not_billable', reason };
  const dues = memberDuesOf(fee);
  if (dues === 'waived') return { state: 'waived', reason: null };
  if (dues === 'paid') return { state: 'already_paid', reason: null };
  return { state: 'will_mark', reason: null };
}

/**
 * Every unclaimed named dues payment that looks like a member, pasted or not.
 *
 * A named payment is somebody who paid before they had an account. When they
 * sign up with the email on it the claim trigger (00252) moves it onto them;
 * when they sign up with another address, or the payment carried none, it sits
 * beside their own row and the season counts them twice. This finds those: the
 * same email or the exact same name is the same person by this file's rule, and
 * a looser resemblance is offered as a hint. Nothing here moves anything.
 */
export function findNamedMatches(
  pool: PasteRosterPlayer[],
  duesRows: PasteDuesRow[],
): PasteNamedMatch[] {
  const live = pool.filter((p) => !isTombstone(p));
  const duesByPlayer = new Map(duesRows.filter((d) => d.player_id).map((d) => [d.player_id!, d]));
  const out: PasteNamedMatch[] = [];
  for (const row of duesRows) {
    if (row.player_id != null || row.manual_name == null) continue;
    const email = row.manual_email?.toLowerCase() ?? null;
    const norm = normalisePersonName(row.manual_name);
    const candidates: PasteNamedMatch['candidates'] = [];
    const seen = new Set<string>();
    const add = (player: PasteRosterPlayer, match: 'email' | 'name' | 'similar') => {
      if (seen.has(player.id)) return;
      seen.add(player.id);
      candidates.push({ player, match, memberDues: memberDuesOf(duesByPlayer.get(player.id)) });
    };
    for (const p of live) {
      if (email != null && p.email != null && p.email.toLowerCase() === email) add(p, 'email');
    }
    for (const p of live) {
      if (norm !== '' && normalisePersonName(p.full_name) === norm) add(p, 'name');
    }
    for (const p of possibleMembersFor(row.manual_name, live)) add(p, 'similar');
    if (candidates.length > 0) out.push({ row, candidates });
  }
  return out;
}

/**
 * Sort parsed entries into what the paste would do.
 *
 * An email match beats a name match. A line whose email is one member and whose
 * name is exactly another is ambiguous rather than either. A name shared by two
 * members is ambiguous and never marked. A member reached twice appears once.
 * Tombstoned accounts are never matched.
 */
export function matchPastedPayers(
  entries: PastedEntry[],
  players: PasteRosterPlayer[],
  duesRows: PasteDuesRow[],
): PasteMatchResult {
  const result: PasteMatchResult = {
    willMark: [], alreadyPaid: [], waived: [], notBillable: [],
    ambiguous: [], alreadyNamed: [], notFound: [], invalid: [],
    namedMatches: [], statusOf: new Map(),
  };

  const pool = players.filter((p) => !isTombstone(p));
  const byEmail = new Map<string, PasteRosterPlayer>();
  const byName = new Map<string, PasteRosterPlayer[]>();
  for (const p of pool) {
    if (p.email) byEmail.set(p.email.toLowerCase(), p);
    const key = normalisePersonName(p.full_name);
    if (key) byName.set(key, [...(byName.get(key) ?? []), p]);
  }
  const duesByPlayer = new Map(duesRows.filter((d) => d.player_id).map((d) => [d.player_id!, d]));
  const manualRows = duesRows.filter((d) => d.player_id == null && d.manual_name != null);

  const placed = new Set<string>();

  for (const entry of entries) {
    if (entry.kind === 'invalid') {
      result.invalid.push(entry);
      continue;
    }

    const emailHit = entry.email ? byEmail.get(entry.email) : undefined;
    const nameHits = entry.name ? byName.get(normalisePersonName(entry.name)) ?? [] : [];

    let player: PasteRosterPlayer | undefined;
    if (emailHit) {
      const other = nameHits.length === 1 && nameHits[0]!.id !== emailHit.id ? nameHits[0]! : null;
      if (other) {
        result.ambiguous.push({
          entry,
          candidates: [emailHit, other],
          reason: 'The name and the email on this line belong to different members.',
        });
        continue;
      }
      player = emailHit;
    } else if (nameHits.length > 1) {
      result.ambiguous.push({
        entry,
        candidates: nameHits,
        reason: `${nameHits.length} members have this name.`,
      });
      continue;
    } else if (nameHits.length === 1) {
      player = nameHits[0];
    }

    if (!player) {
      const normName = entry.name ? normalisePersonName(entry.name) : null;
      const named = manualRows.find(
        (d) =>
          (entry.email != null && d.manual_email != null && d.manual_email.toLowerCase() === entry.email) ||
          (normName != null && normalisePersonName(d.manual_name!) === normName),
      );
      if (named) {
        result.alreadyNamed.push({ entry, manualName: named.manual_name!, paid: Boolean(named.paid_at) });
      } else {
        result.notFound.push({ entry, possibleMembers: entry.name ? possibleMembersFor(entry.name, pool) : [] });
      }
      continue;
    }

    if (placed.has(player.id)) continue;
    placed.add(player.id);

    const reason = notBillableReason(player);
    if (reason) {
      result.notBillable.push({ entry, player, reason });
      continue;
    }
    const fee = duesByPlayer.get(player.id);
    if (isWaivedFee(fee)) result.waived.push({ entry, player });
    else if (fee?.paid_at) result.alreadyPaid.push({ entry, player });
    else result.willMark.push({ entry, player });
  }

  for (const p of [
    ...result.ambiguous.flatMap((a) => a.candidates),
    ...result.notFound.flatMap((n) => n.possibleMembers),
  ]) {
    result.statusOf.set(p.id, candidateStatus(p, duesByPlayer.get(p.id)));
  }
  result.namedMatches = findNamedMatches(pool, duesRows);

  return result;
}

// ─── WHAT CROSSES TO THE BROWSER ─────────────────────────────────────────────
//
// The matcher holds whole roster rows. The browser gets the least that lets an
// exec check the list: an id and a name for the ones that will be marked, a
// name and a reason for the rest, and a masked address where two members have
// to be told apart.

export interface FeePasteRow {
  raw: string;
  name: string;
  reason: string;
  /** Set on a named row that is not paid yet. */
  unpaid?: boolean;
}

export interface FeePasteWillMark {
  raw: string;
  playerId: string;
  fullName: string;
  email: string | null;
}

/** A member an exec may pick for an ambiguous or hinted line. */
export interface FeePasteCandidate {
  playerId: string;
  name: string;
  maskedEmail: string | null;
  state: PasteCandidateState;
  /** Why they are not billed, when state is not_billable. */
  reason: string | null;
}

export interface FeePasteAmbiguous {
  raw: string;
  reason: string;
  candidates: FeePasteCandidate[];
}

export interface FeePasteNotFound {
  raw: string;
  name: string | null;
  email: string | null;
  amountCents: number | null;
  /** A hint only: none of them is marked unless the exec picks one. */
  possibleMembers: FeePasteCandidate[];
}

export interface FeePasteNamedMatch {
  feeId: string;
  manualName: string;
  amountCents: number | null;
  paidAt: string | null;
  candidates: Array<{
    playerId: string;
    name: string;
    maskedEmail: string | null;
    match: 'email' | 'name' | 'similar';
    memberDues: PasteMemberDues;
  }>;
}

export interface FeePastePreview {
  season: { id: string; name: string; competitiveFeeCents: number; recreationalFeeCents: number };
  willMark: FeePasteWillMark[];
  alreadyPaid: FeePasteRow[];
  waived: FeePasteRow[];
  alreadyNamed: FeePasteRow[];
  notBillable: FeePasteRow[];
  ambiguous: FeePasteAmbiguous[];
  notFound: FeePasteNotFound[];
  invalid: Array<{ raw: string; reason: string }>;
  namedMatches: FeePasteNamedMatch[];
}

/** "j***@example.org". Enough to tell two members apart, not enough to write to. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  return `${email.charAt(0)}***${email.slice(at)}`;
}

export function toFeePastePreview(
  season: FeePastePreview['season'],
  m: PasteMatchResult,
): FeePastePreview {
  const row = (entry: PastedPayer, player: PasteRosterPlayer, reason: string): FeePasteRow => ({
    raw: entry.raw,
    name: player.full_name,
    reason,
  });
  const candidate = (p: PasteRosterPlayer): FeePasteCandidate => {
    const status = m.statusOf.get(p.id) ?? { state: 'not_billable' as const, reason: 'Could not be checked' };
    return {
      playerId: p.id,
      name: p.full_name,
      maskedEmail: maskEmail(p.email),
      state: status.state,
      reason: status.reason,
    };
  };
  return {
    season,
    willMark: m.willMark.map(({ entry, player }) => ({
      raw: entry.raw,
      playerId: player.id,
      fullName: player.full_name,
      email: player.email,
    })),
    alreadyPaid: m.alreadyPaid.map(({ entry, player }) => row(entry, player, 'Already paid')),
    waived: m.waived.map(({ entry, player }) => row(entry, player, 'Fee waived')),
    alreadyNamed: m.alreadyNamed.map(({ entry, manualName, paid }) => ({
      raw: entry.raw,
      name: manualName,
      reason: paid
        ? 'Already recorded as a named payment this season'
        : 'Already named this season, not paid yet: confirm its receipt under To review',
      ...(paid ? {} : { unpaid: true }),
    })),
    notBillable: m.notBillable.map(({ entry, player, reason }) => row(entry, player, reason)),
    ambiguous: m.ambiguous.map(({ entry, candidates, reason }) => ({
      raw: entry.raw,
      reason,
      candidates: candidates.map(candidate),
    })),
    notFound: m.notFound.map(({ entry, possibleMembers }) => ({
      raw: entry.raw,
      name: entry.name,
      email: entry.email,
      amountCents: entry.amountCents,
      possibleMembers: possibleMembers.map(candidate),
    })),
    invalid: m.invalid.map(({ raw, reason }) => ({ raw, reason })),
    namedMatches: m.namedMatches.map(({ row, candidates }) => ({
      feeId: row.id,
      manualName: row.manual_name!,
      amountCents: row.amount_cents,
      paidAt: row.paid_at,
      candidates: candidates.map(({ player, match, memberDues }) => ({
        playerId: player.id,
        name: player.full_name,
        maskedEmail: maskEmail(player.email),
        match,
        memberDues,
      })),
    })),
  };
}
