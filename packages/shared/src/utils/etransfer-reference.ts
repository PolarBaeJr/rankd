// READING A PAYMENT REFERENCE OUT OF OCR TEXT.
//
// A member uploads a screenshot of their bank's "e-Transfer sent" screen, or of
// the receipt the Campus Rec website gave them, and the browser runs OCR over it.
// This turns that text into a best guess at the reference or receipt number,
// which pre-fills a field the member can still edit. The guess is a
// convenience; the field is the answer.
//
// THE FORMAT IS UNVERIFIED. Every bank lays the confirmation out differently
// and none of the fixtures in the tests is a real screenshot. So this is
// tolerant rather than exact: a set of labels a reference tends to sit next
// to, any 6 to 32 character run of letters, digits and hyphens with at least
// one digit in it, and a ranking that prefers what sits closest to a label.
// A number a bank prints with part of it hidden ("H99517225...111525803",
// "C1Aarp***bAz") is taken whole (00297). An Campus Rec order number has its own
// reader, extractSfuRecOrder, since its receipt carries three similar ids.
//
// Dependency-free, so the client form and the server action share it.

/** The shape fee_submissions.reference accepts (00248's CHECK). */
export const ETRANSFER_REFERENCE_PATTERN = /^[A-Za-z0-9-]{6,32}$/;

/**
 * The shorter one 00253 allows on anything not stored as an e-transfer: a
 * Campus Rec receipt, or a dues receipt the browser could not place (NULL).
 */
export const SFU_REC_REFERENCE_PATTERN = /^[A-Za-z0-9-]{4,32}$/;

/**
 * An e-transfer number as a bank prints it with part of it hidden (00297):
 * elided, "H99517225...111525803" (three ASCII dots, see normaliseReference),
 * or masked, "C1Aarp***bAz". Mirrors the CHECK's third arm, which also wants
 * something hidden and 6 to 48 characters: see isHiddenEtransferReference.
 */
export const ETRANSFER_DISPLAY_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9*-]{2,30}(?:\.\.\.[A-Za-z0-9*-]{2,30})?$/;

/** A hidden e-transfer number the CHECK accepts: the pattern, a '*' or '...', 6 to 48 characters. */
export function isHiddenEtransferReference(s: string): boolean {
  const v = s.trim();
  return v.length >= 6 && v.length <= 48 && /\*|\.\.\./.test(v) && ETRANSFER_DISPLAY_REFERENCE_PATTERN.test(v);
}

/**
 * Whether a typed or extracted reference is one the database will accept, for
 * the method the submission will be stored with. Mirrors the CHECK: null (not
 * detected) takes the short form like 'sfu_rec'. Leaving the method out asks
 * for the e-transfer shape. A hidden e-transfer number passes only when the
 * method is 'e_transfer' itself, as the CHECK has it.
 */
export function isPlausibleReference(s: string, method?: string | null): boolean {
  const strict = method === undefined || method === 'e_transfer';
  const pattern = strict ? ETRANSFER_REFERENCE_PATTERN : SFU_REC_REFERENCE_PATTERN;
  return pattern.test(s.trim()) || (method === 'e_transfer' && isHiddenEtransferReference(s));
}

/**
 * Trimmed, with one leading '#' dropped: "#12345678" is how a receipt prints
 * it. An ellipsis character becomes three dots, the one form stored.
 */
export function normaliseReference(s: string): string {
  return s.trim().replace(/^#\s*/, '').replace(/\u2026/g, '...');
}

export interface ExtractedReference {
  value: string;
  /** 'anchored' when it sat on or under a label like "Reference number". */
  confidence: 'anchored' | 'guess';
}

// Case-insensitive. The optional trailing colon, hash or "no." is swallowed so
// what follows the match is the value.
const ANCHOR =
  /(?:reference\s*(?:number|no\.?|#|:)|ref\s*(?:#|:|no\.)|confirmation\s*(?:number|no\.?|#)|transaction\s*(?:id|#|number)|receipt\s*(?:number|no\.?|#|:)|order\s*(?:number|no\.?|#|id)|invoice\s*(?:number|no\.?|#))\s*[:#.]?/i;

const EMAIL = /\S+@\S+/g;
const TOKEN = /[A-Za-z0-9-]{6,32}/g;
const DATE = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{2,4})$/;
// A number with part of it hidden, taken whole before the text is split, so
// "H99517225...111525803" never yields "H99517225" on its own.
const HIDDEN = /[A-Za-z0-9-]{2,}(?:\.{3}|\u2026)[A-Za-z0-9-]{2,}|[A-Za-z0-9]+\*{2,}[A-Za-z0-9]+/g;

/**
 * O for 0 and l or I for 1, fixed only where the token is mostly a number. A
 * letter, a hyphen and digits ("O-600857", "I-502003") keeps its letter: that
 * is how Campus Rec prefixes its numbers.
 */
function fixOcrDigits(token: string): string {
  if (/^[A-Za-z]-\d+$/.test(token)) return token;
  const digits = (token.match(/\d/g) ?? []).length;
  if (digits < 2) return token;
  return token.replace(/[Oo]/g, '0').replace(/[lI]/g, '1');
}

function candidates(text: string): string[] {
  const out: string[] = [];
  const rest = text.replace(EMAIL, ' ').replace(HIDDEN, (run) => {
    const value = normaliseReference(run);
    if (/\d/.test(value) && isHiddenEtransferReference(value)) out.push(value);
    return ' ';
  });
  for (const raw of rest.match(TOKEN) ?? []) {
    const token = fixOcrDigits(raw.replace(/^-+|-+$/g, ''));
    if (token.length < 6 || !/\d/.test(token) || DATE.test(token)) continue;
    if (!ETRANSFER_REFERENCE_PATTERN.test(token)) continue;
    out.push(token);
  }
  return out;
}

const preferredLength = (s: string) => (s.length >= 8 && s.length <= 16 ? 0 : 1);

/**
 * The most likely reference in a block of OCR text, or null when nothing in it
 * could be one. Never throws.
 */
export function extractEtransferReference(text: string | null | undefined): ExtractedReference | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);

  // Anchored: on the label's line after the label (distance 0), or on the next
  // line (distance 1). Closest first, then a length in the usual range.
  const anchored: { value: string; distance: number; order: number }[] = [];
  lines.forEach((line, i) => {
    const match = ANCHOR.exec(line);
    if (!match) return;
    const after = line.slice(match.index + match[0].length);
    candidates(after).forEach((value) => anchored.push({ value, distance: 0, order: anchored.length }));
    const next = lines[i + 1];
    if (next !== undefined && !ANCHOR.test(next)) {
      candidates(next).forEach((value) => anchored.push({ value, distance: 1, order: anchored.length }));
    }
  });
  if (anchored.length > 0) {
    anchored.sort(
      (a, b) =>
        a.distance - b.distance ||
        preferredLength(a.value) - preferredLength(b.value) ||
        a.order - b.order,
    );
    return { value: anchored[0]!.value, confidence: 'anchored' };
  }

  // No label found: the best-looking token anywhere, preferring the usual
  // length and a mix of letters and digits over a bare number.
  const loose = lines.flatMap((l) => candidates(l));
  if (loose.length === 0) return null;
  const mixed = (s: string) => (/[A-Za-z]/.test(s) ? 0 : 1);
  const best = loose
    .map((value, order) => ({ value, order }))
    .sort(
      (a, b) =>
        preferredLength(a.value) - preferredLength(b.value) ||
        mixed(a.value) - mixed(b.value) ||
        a.order - b.order,
    )[0]!;
  return { value: best.value, confidence: 'guess' };
}

// "Order #: O-600857" on the desktop receipt, "O-601558" alone on a line on the
// phone one. The OCR reads the O as a zero as often as not. Never the
// "I-" invoice, the "R-" registration, nor the nine-digit student ID beside a name.
const SFU_REC_ORDER_LABELLED = /\border\s*(?:#|number|no\.?)?\s*:?\s*[O0o]\s*-\s*(\d{6,8})\b/i;
const SFU_REC_ORDER_ALONE = /^[O0o]\s*-\s*(\d{6,8})$/;

/**
 * The Campus Rec order number in a block of OCR text, as "O-<digits>", or null.
 * The labelled one wins over one on a line of its own. Never throws.
 */
export function extractSfuRecOrder(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    const match = SFU_REC_ORDER_LABELLED.exec(line);
    if (match) return `O-${match[1]}`;
  }
  for (const line of lines) {
    const match = SFU_REC_ORDER_ALONE.exec(line);
    if (match) return `O-${match[1]}`;
  }
  return null;
}
