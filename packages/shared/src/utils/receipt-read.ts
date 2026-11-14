// READING A RECEIPT ON THE SERVER, AND DECIDING WHETHER IT CONFIRMS ITSELF (00297).
//
// The server runs OCR over a receipt's screenshot and hands the text here.
// parseReceiptText pulls out what the decision needs: which kind of receipt,
// its number, the amount, and who it names. decideAutoConfirm then says
// whether the receipt is routine enough to settle with nobody looking, or
// which reason holds it for an exec. auto_confirm_fee_submission checks the
// money and the uniqueness again inside its locks; this is the half the
// database cannot do, because it never sees the text.
//
// THE LAYOUTS ARE THE ONES SEEN SO FAR, not a specification: the SFU Rec
// receipt on a desktop ("Order #: O-...", "Total Before Tax", "Program Name")
// and on a phone (the order number alone on a line, "Receipt", and the
// member's name beside "ID #"), and a bank's "e-Transfer sent" screen, whose
// labels ("Amount", "Sent to") may sit on the line above their value. Anything
// this cannot read holds the receipt, which is the safe way to be wrong.
//
// THE TEXT IS NEVER KEPT. It carries a member's name and student ID. Nothing here
// logs it, and no flag detail ever quotes a name.
//
// Dependency-free, so a test and both apps share it.

import { extractEtransferReference, extractSfuRecOrder, normaliseReference } from './etransfer-reference';
import { classifyReceiptText, type ReceiptMethod } from './receipt-method';

export const RECEIPT_FLAGS = [
  'no_reference',
  'reference_used',
  'screenshot_reused',
  'amount_mismatch',
  'amount_unreadable',
  'payee_mismatch',
  'payee_unreadable',
  'name_mismatch',
  'program_mismatch',
  'not_a_receipt',
  'wrong_method',
  'unreadable_format',
  'ocr_failed',
  'ocr_timeout',
  'fee_not_payable',
  'undone',
  'outside_window',
] as const;

export type ReceiptFlag = (typeof RECEIPT_FLAGS)[number];

export interface ReceiptReadout {
  kind: ReceiptMethod | null;
  reference: string | null;
  amountCents: number | null;
  /** SFU Rec desktop only: "Program Name: ...". */
  programName: string | null;
  /**
   * SFU Rec only: the campus in "Offering/Instance". Every campus's clubs sell
   * their dues on the same site, and Surrey has a Badminton Club too, so the
   * program's name alone does not say the dues are ours.
   */
  campus: 'main' | 'other' | null;
  /** SFU Rec phone only: the name beside "ID #". */
  payerName: string | null;
  /** E-transfer: who it was sent to, and their address when shown. */
  payeeName: string | null;
  payeeEmail: string | null;
}

const MONEY = String.raw`(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})`;

function cents(whole: string, fraction: string): number {
  return Number(whole.replace(/,/g, '')) * 100 + Number(fraction);
}

/** The first match of `pattern` over `text`, as cents, or null. */
function amountAfter(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  return match ? cents(match[1]!, match[2]!) : null;
}

// What only an SFU Rec receipt carries, beside the words receipt-method.ts
// already counts. The desktop receipt has none of those words.
const SFU_REC_ORDER_LABEL = /\border\s*#?\s*:?\s*[O0o]\s*-\s*\d{6,8}\b/i;
const SFU_REC_ORDER_ALONE = /^[O0o]\s*-\s*\d{6,8}$/m;
const PROGRAM_SHEET = /total before tax/i;
const DEPOSITED_NOTICE = /\btransfer\b.*\bdeposited\b/i;
const PURCHASE_WORDS = /\breceipt\b|thank you for your purchase/i;

function receiptKind(text: string, collapsed: string): ReceiptMethod | null {
  const classified = classifyReceiptText(text);
  if (classified) return classified;
  if (SFU_REC_ORDER_LABEL.test(collapsed) && (PROGRAM_SHEET.test(collapsed) || /program name/i.test(collapsed))) {
    return 'sfu_rec';
  }
  if (SFU_REC_ORDER_ALONE.test(text) && PURCHASE_WORDS.test(collapsed)) return 'sfu_rec';
  // A bank's "your transfer ... was successfully deposited" notice.
  if (DEPOSITED_NOTICE.test(collapsed) && /\$\s?\d/.test(collapsed)) return 'e_transfer';
  // A bank's own "sent" screen that never prints Interac or e-Transfer as
  // text (the logo is a picture): Scotiabank's dark confirmation ("Contact
  // method", "Make another transfer"), TD's "Money sent", "Your transfer has
  // been sent!" or "was accepted!", a "Transfer details" page. Its wording only counts beside an
  // address and an amount, so the decision still sees both.
  if (SENT_SCREEN.test(collapsed) && HAS_EMAIL.test(collapsed) && new RegExp(MONEY).test(collapsed)) {
    return 'e_transfer';
  }
  return null;
}

const SENT_SCREEN =
  /\bmoney sent\b|\byou sent\b|\btransfer (?:has been|was) (?:sent|accepted)\b|\btransfer details\b|\bcontact method\b|\b(?:make|send) another transfer\b/i;

const EMAIL = /[^\s@:;,()<>]+@[^\s@:;,()<>]+\.[A-Za-z]{2,}/g;
const HAS_EMAIL = /[^\s@:;,()<>]+@[^\s@:;,()<>]+\.[A-Za-z]{2,}/;

/** Who an e-transfer went to: "sent to X with", "To X", or a "Sent to" or "Recipient" label above the name. */
function payeeName(lines: string[], collapsed: string): string | null {
  const sentence =
    /\bsent to\s+(.+?)\s+with\b/i.exec(collapsed) ??
    /\b(?:transfer|sent) to\s+(.+?)\s+(?:was|has been)\b/i.exec(collapsed);
  if (sentence) return sentence[1]!.trim();
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(?:(?:sent\s+)?to|recipient)\b\s*:?\s*(.*)$/i.exec(lines[i]!);
    if (!match) continue;
    const value = (match[1] ?? '').trim() || (lines[i + 1] ?? '').trim();
    if (value && !HAS_EMAIL.test(value)) return value;
  }
  return null;
}

// A capital I or a bar in an email address is a lower case l the OCR misread:
// they are the same shape in most banking fonts, and banks show an address in
// lower case. A real "i" reads as a lower case i, so an address that differs
// by an i for an l still never matches: members have sent the fee to
// "iclub1" for "lclub1", which no bank delivers to the club.
const emailText = (address: string) => address.replace(/[I|]/g, 'l').toLowerCase();

// The labels a bank puts over the recipient, and over the member's own
// details. TD shows both addresses, the sender's first.
const RECIPIENT_LABEL = /^(?:recipient|(?:sent\s+)?to|contact)\b/i;
const SENDER_LABEL = /^(?:sender|from)\b/i;
const LABEL_REACH = 3;

function payeeEmail(lines: string[], text: string): string | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (!RECIPIENT_LABEL.test(lines[i]!)) continue;
    const found = lines.slice(i, i + 1 + LABEL_REACH).join(' ').match(EMAIL);
    if (found) return emailText(found[0]!);
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^e-?mail\b/i.test(lines[i]!)) continue;
    const found = `${lines[i]} ${lines[i + 1] ?? ''}`.match(EMAIL);
    if (found) return emailText(found[0]!);
  }
  const senders = new Set<string>();
  lines.forEach((line, i) => {
    if (!SENDER_LABEL.test(line)) return;
    for (const address of lines.slice(i, i + 1 + LABEL_REACH).join(' ').match(EMAIL) ?? []) {
      senders.add(emailText(address));
    }
  });
  const all = [...new Set((text.match(EMAIL) ?? []).map(emailText))].filter((a) => !senders.has(a));
  return all.length === 1 ? all[0]! : null;
}

/** A line holding only an amount, unless a line just above names it a balance. */
function amountAlone(lines: string[]): number | null {
  const alone = new RegExp(String.raw`^\$?\s?${MONEY}(?:\s*CAD)?$`, 'i');
  for (let i = 0; i < lines.length; i += 1) {
    const match = alone.exec(lines[i]!);
    // "New account balance" sits over the account's name, then the figure.
    if (match && !/balance/i.test(lines.slice(Math.max(0, i - 2), i).join(' '))) return cents(match[1]!, match[2]!);
  }
  return null;
}

/** What the decision needs from a receipt's OCR text. Never throws. */
export function parseReceiptText(text: string | null | undefined): ReceiptReadout {
  const none: ReceiptReadout = {
    kind: null,
    reference: null,
    amountCents: null,
    programName: null,
    campus: null,
    payerName: null,
    payeeName: null,
    payeeEmail: null,
  };
  if (typeof text !== 'string' || !text.trim()) return none;
  // The read can put a space either side of an address's "@" ("lclub1 @example.org").
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').replace(/(\w) ?@ ?(\w)/g, '$1@$2').trim())
    .filter((l) => l.length > 0);
  const tidy = lines.join('\n');
  const collapsed = lines.join(' ');
  const kind = receiptKind(tidy, collapsed);
  if (kind === 'sfu_rec') {
    const programAt = lines.findIndex((l) => /^program name\b/i.test(l));
    let programName = programAt >= 0 ? lines[programAt]!.replace(/^program name\s*:?\s*/i, '').trim() : '';
    // The receipt's table reads as a row of headings over a row of values:
    // "Program Name Offering/Instance", then "Badminton Club Main Campus ...".
    if (/^offering/i.test(programName)) programName = /^(.*?\bclub)\b/i.exec(lines[programAt + 1] ?? '')?.[1] ?? '';
    // Another campus anywhere on the receipt wins over Main Campus.
    const campus = /\b(surrey|vancouver|harbour centre)\b/i.test(collapsed)
      ? 'other'
      : /\b(Main Campus|Burnaby)\b/i.test(collapsed)
        ? 'main'
        : null;
    const payer = lines
      .map((l) => /^(.*?)\s+(?:[|Il1]\s+)?ID\s*#\s*:?\s*\d{6,}/.exec(l))
      .find((m) => m && /[A-Za-z]{2,}/.test(m[1]!));
    return {
      ...none,
      kind,
      reference: extractSfuRecOrder(tidy),
      amountCents: amountAfter(collapsed, new RegExp(String.raw`total before tax\s*:?\s*\$?\s*${MONEY}`, 'i')),
      programName: programName || null,
      campus,
      payerName: payer ? payer[1]!.trim() : null,
    };
  }
  if (kind === 'e_transfer') {
    // Only a number beside a label: a guess could be any run of digits.
    const found = extractEtransferReference(tidy);
    return {
      ...none,
      kind,
      reference: found?.confidence === 'anchored' ? normaliseReference(found.value) : null,
      // Some banks print the figure with no "$": "Sent / 5.00 / to ...", or a
      // line holding only the amount. Still only ever compared with the fee.
      amountCents:
        amountAfter(collapsed, new RegExp(String.raw`\$\s?${MONEY}\s*\(?\s*CAD`, 'i')) ??
        amountAfter(collapsed, new RegExp(String.raw`\bamount\s*:?\s*\$?\s?${MONEY}`, 'i')) ??
        amountAfter(collapsed, new RegExp(String.raw`\bsent\s*:?\s*\$?\s?${MONEY}\b`, 'i')) ??
        // RBC sets "Amount" and "Date" side by side, so the read comes out as
        // "Amount Date" over "$5.00 Oct 22, 2026": the figure opens the line
        // under the label line.
        amountAfter(tidy, new RegExp(String.raw`^amount\b[^\n]*\n\$\s?${MONEY}\b`, 'im')) ??
        // Scotiabank prints the new balance alone on its line above the
        // amount, so a balance is never taken for it.
        amountAlone(lines),
      payeeName: payeeName(lines, collapsed),
      payeeEmail: payeeEmail(lines, tidy),
    };
  }
  return none;
}

/** Lower case, accents dropped, letters only, split into words. */
function nameTokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0);
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Whether the name read off a receipt is the member's: their first and last
 * names each appear, accents and case aside, one OCR slip allowed in each. A
 * middle name on either side does not matter.
 */
export function namesMatch(read: string, member: string): boolean {
  const readTokens = nameTokens(read);
  const memberTokens = nameTokens(member);
  if (readTokens.length === 0 || memberTokens.length === 0) return false;
  const wanted = memberTokens.length === 1 ? memberTokens : [memberTokens[0]!, memberTokens[memberTokens.length - 1]!];
  return wanted.every((w) => readTokens.some((r) => withinOneEdit(r, w)));
}

const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

// An l and a 1 are one stroke apart in most banking fonts ("lclubl" for
// "lclub1"); an i keeps its dot and stays distinct.
const sameEmail = (a: string, b: string) => {
  const key = (address: string) => emailText(address.trim()).replace(/1/g, 'l');
  return key(a) === key(b);
};


const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

export interface AutoConfirmContext {
  feeType: string;
  amountCents: number | null;
  /** The member's full name, or the name a Google Form gave. */
  payerName: string | null;
  /** membership_payments: etransfer_email and etransfer_payee_name. */
  clubEmail: string | null;
  clubPayeeName: string | null;
}

export type AutoConfirmDecision =
  | { confirm: true; method: ReceiptMethod; reference: string | null; amountCents: number | null }
  | { confirm: false; flag: ReceiptFlag; detail: string | null; reference: string | null };

/**
 * Whether a read receipt settles its fee with nobody looking. Confirms only
 * when every rule holds; otherwise the first reason it fails, for the exec.
 */
export function decideAutoConfirm(read: ReceiptReadout, ctx: AutoConfirmContext): AutoConfirmDecision {
  const hold = (flag: ReceiptFlag, detail: string | null = null): AutoConfirmDecision => ({
    confirm: false,
    flag,
    detail,
    reference: read.reference,
  });
  if (ctx.amountCents == null) return hold('fee_not_payable');
  if (read.kind === null) return hold('not_a_receipt');

  if (read.kind === 'sfu_rec') {
    // Only dues are sold on the SFU Rec website.
    if (ctx.feeType !== 'dues') return hold('wrong_method', 'An SFU Rec receipt only pays membership dues');
    if (!read.reference || !/^O-\d{6,8}$/.test(read.reference)) return hold('no_reference');
    if (read.payerName && ctx.payerName && !namesMatch(read.payerName, ctx.payerName)) {
      return hold('name_mismatch', "The name on the receipt is not the member's");
    }
    // Each campus's club charges its own fee, so the price is a second check
    // on whose dues these are: it must be shown, and be ours.
    if (read.amountCents == null) return hold('amount_unreadable');
    if (read.amountCents !== ctx.amountCents) {
      return hold('amount_mismatch', `Receipt shows ${dollars(read.amountCents)}, the fee is ${dollars(ctx.amountCents)}`);
    }
    if (read.programName && !/badminton club/i.test(read.programName)) {
      return hold('program_mismatch', 'The program on the receipt is not the Badminton Club');
    }
    // An order number alone says nothing about which club or campus it paid,
    // so a receipt that does not show both goes to an exec.
    if (!read.programName) return hold('program_mismatch', 'The receipt does not show which club it pays for');
    if (read.campus === 'other') return hold('program_mismatch', "The receipt is for another campus's club");
    if (read.campus !== 'main') return hold('program_mismatch', 'The receipt does not show the Main Campus');
    return { confirm: true, method: 'sfu_rec', reference: read.reference, amountCents: read.amountCents };
  }

  if (read.amountCents == null) return hold('amount_unreadable');
  if (read.amountCents !== ctx.amountCents) {
    return hold('amount_mismatch', `Receipt shows ${dollars(read.amountCents)}, the fee is ${dollars(ctx.amountCents)}`);
  }
  const emailMatches = !!read.payeeEmail && !!ctx.clubEmail && sameEmail(read.payeeEmail, ctx.clubEmail);
  // Several names, comma separated: a bank may show the club's name or the
  // account holder's ("Sfu Badminton, Linhui Sun").
  const clubNames = (ctx.clubPayeeName ?? '').split(/[,;\n]/).filter((n) => n.trim());
  const nameMatches = !!read.payeeName && clubNames.some((n) => sameText(read.payeeName!, n));
  // An address is the member's own typing and the bank delivers by it; the
  // name beside it is often the member's own label for the contact. So an
  // address that is not the club's holds the receipt whatever the name says.
  if (read.payeeEmail && ctx.clubEmail && !emailMatches) {
    return hold('payee_mismatch', 'The receipt was sent to a different email address than the club\'s');
  }
  if (!emailMatches && !nameMatches) {
    if (!read.payeeEmail && !read.payeeName) return hold('payee_unreadable');
    return hold('payee_mismatch', 'The receipt does not show the club as the recipient');
  }
  // Some banks' "sent" screens show no reference (00298): the recipient and
  // the amount settle it, and the database takes that only for a Form receipt
  // whose screenshot is hashed, answering 'no_reference' for any other.
  return { confirm: true, method: 'e_transfer', reference: read.reference, amountCents: read.amountCents };
}

// An SFU Rec order number as the uniqueness key holds it (fee_reference_key,
// 00297): lower case, the "O-" gone.
const orderKey = (reference: string) => reference.trim().toLowerCase().replace(/^#\s*/, '').replace(/^[o0]\s*-\s*/, '');

/**
 * Whether two SFU Rec order numbers are one digit apart: one dropped, added
 * or changed. The order number is kept only so a receipt is used once (the
 * unique index on reference_key), and a read can drop or double a repeated
 * digit, so a second screenshot of a used receipt could pass that index under
 * a number one digit off. The receipt check holds such a receipt for an exec.
 * The same number is not "one off": the database answers that itself.
 */
export function orderNumbersOneOff(a: string, b: string): boolean {
  const x = orderKey(a);
  const y = orderKey(b);
  if (x === y || Math.abs(x.length - y.length) > 1) return false;
  if (x.length === y.length) {
    let differ = 0;
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) differ += 1;
    return differ === 1;
  }
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  for (let i = 0; i < long.length; i += 1) {
    if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  }
  return false;
}
