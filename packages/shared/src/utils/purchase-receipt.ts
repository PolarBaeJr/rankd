// READING A SHOP RECEIPT FOR AN EXPENSE (00313).
//
// An exec photographs what they bought for the club; the console reads the
// photo in their own browser and this turns the OCR text into the store, the
// date, the total, the item lines and the tax lines, so the exec checks a
// guess instead of typing a long till slip. Every field is a pre-fill the exec
// corrects; nothing here decides anything about money on its own.
//
// PRIVACY: LINES ARE DROPPED FIRST, THEN WHAT IS LEFT IS STRIPPED. A till slip
// carries a masked card number, an approval code, a membership number and the
// store's own register numbers. None of them is returned: a line naming one is
// never a store or an item candidate, and an item's own number (a UPC, a
// Costco item number) is removed from its description and kept only privately,
// to attach an instant saving to the item it names. The text itself is never
// logged or returned.
//
// TAX CODES COME ONLY FROM WHAT THIS RECEIPT PRINTS. There is no table of what
// a store's letters mean and no remembered rule: the same item is taxed at one
// shop and not at another, and a wrong guess would quietly move money between
// the club and the exec. A legend on the slip maps codes; failing that, one tax
// line and one code is mapped and flagged as inferred; anything else is left
// unmapped for the exec to set.
//
// Never throws: unreadable text reads as nothing found.

export const PURCHASE_FLAGS = [
  'no_total',
  'totals_disagree',
  'tip_included',
  'items_subtotal_mismatch',
  'subtotal_tax_total_mismatch',
  'no_date',
  'date_ambiguous',
  'tax_codes_unmapped',
  'tax_codes_inferred',
] as const;
export type PurchaseFlag = (typeof PURCHASE_FLAGS)[number];

export interface PurchaseItem {
  description: string;
  quantity: number | null;
  unitPriceCents: number | null;
  lineTotalCents: number;
  /** Zero or negative: instant savings, coupons and the like on this item. */
  discountCents: number;
  taxCode: string | null;
}

export interface PurchaseTaxLine {
  label: string;
  /** Parts per million: 5.000% is 50000. */
  ratePpm: number | null;
  printedCents: number | null;
  /** The item tax codes this line applies to, from this receipt only. */
  codes: string[];
}

export interface PurchaseReadout {
  store: string | null;
  /** YYYY-MM-DD. */
  date: string | null;
  totalCents: number | null;
  subtotalCents: number | null;
  items: PurchaseItem[];
  taxLines: PurchaseTaxLine[];
  flags: PurchaseFlag[];
}

// An amount: "4.99", "$1,234.50", "-3.00", "3.00-". Not a digit or a point on
// either side, so "5.000 %" is a rate and not $5.00.
const MONEY_SOURCE = String.raw`(?<![\d.,])(-)?\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?![\d])(-)?`;
const MONEY_ONLY = new RegExp(`^${MONEY_SOURCE}$`);

interface Money {
  cents: number;
  start: number;
  end: number;
}

function moneyIn(line: string): Money[] {
  const out: Money[] = [];
  for (const m of line.matchAll(new RegExp(MONEY_SOURCE, 'g'))) {
    const whole = Number.parseInt(m[2]!.replace(/,/g, ''), 10) * 100 + Number.parseInt(m[3]!, 10);
    out.push({ cents: m[1] || m[4] ? -whole : whole, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

const lastMoney = (line: string): Money | null => moneyIn(line).at(-1) ?? null;

const SENSITIVE = [
  /\*{2,}\s*\d/,
  /[X*]{3,}\d/i,
  // A card or transaction number: one long run, or groups of four. Not any
  // thirteen digits with spaces between, which a UPC beside its price is.
  /\b\d{13,19}\b/,
  /\b\d{4}(?:[ -]\d{4}){3}/,
  /card\s*#/i,
  /\bacct\b/i,
  /\bauth\b/i,
  /\bapproval\b/i,
  /\baid\b/i,
  /\btvr\b/i,
  /\bseq\b/i,
  /\bterminal\b/i,
  /\b(?:member|membership|mbr)\b/i,
  /\b(?:ST|OP|TE|TR|TC)\s*#/i,
  /invoice\s*#/i,
  /\bref\s*#/i,
  /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/,
  /https?:\/\/|www\.|\.(?:com|ca|net|org)\b/i,
  /\S+@\S+\.\S+/,
];

const isSensitive = (line: string) => SENSITIVE.some((re) => re.test(line));

type LabelKind = 'subtotal' | 'tax' | 'total1' | 'total2' | 'total3' | 'tip' | 'excluded' | null;

const TAX_LABEL = /^(GST\s*\/\s*HST|GST|PST|HST|QST|SALES\s+TAX|TAX(?:\s*\d(?![\d.,]))?)\b/i;

function labelKind(line: string): LabelKind {
  if (/^sub[\s-]?total\b/i.test(line)) return 'subtotal';
  if (/^(?:tip|gratuity)\b/i.test(line)) return 'tip';
  if (
    /^total\s+(?:savings|number|items|tax)\b/i.test(line) ||
    /^(?:you\s+saved|instant\s+savings|items\s+sold|change(?:\s+due)?|cash\s+back)\b/i.test(line) ||
    /\btend(?:ered)?\b/i.test(line) ||
    /^(?:visa|mastercard|master\s*card|debit|credit|cash|amex|interac|payment)\b/i.test(line)
  ) {
    return 'excluded';
  }
  if (TAX_LABEL.test(line)) return 'tax';
  if (/^(?:grand\s+)?total(?:\s+due)?\b/i.test(line)) return 'total1';
  if (/^amount(?:\s+due)?\b/i.test(line)) return 'total2';
  if (/^balance(?:\s+due)?\b/i.test(line)) return 'total3';
  return null;
}

/** The amount for a labelled line: on the same line, or alone on the next. */
function labelledAmount(lines: readonly string[], i: number): number | null {
  const same = lastMoney(lines[i]!);
  if (same) return same.cents;
  const next = lines[i + 1];
  if (next !== undefined && MONEY_ONLY.test(next)) return lastMoney(next)?.cents ?? null;
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_WORD = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;

function isoDate(year: number, month: number, day: number, today: Date): string | null {
  if (year < 100) year += 2000;
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null;
  const limit = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.getTime() > limit) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

interface DateCandidate {
  iso: string;
  withTime: boolean;
  ambiguous: boolean;
}

function datesOn(line: string, today: Date): DateCandidate[] {
  const withTime = /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(line);
  const out: DateCandidate[] = [];
  const push = (iso: string | null, ambiguous = false) => {
    if (iso) out.push({ iso, withTime, ambiguous });
  };
  for (const m of line.matchAll(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g)) {
    push(isoDate(+m[1]!, +m[2]!, +m[3]!, today));
  }
  for (const m of line.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g)) {
    const a = +m[1]!;
    const b = +m[2]!;
    const y = +m[3]!;
    if (a > 12) push(isoDate(y, b, a, today));
    else push(isoDate(y, a, b, today), b <= 12 && a !== b);
  }
  for (const m of line.matchAll(new RegExp(String.raw`\b${MONTH_WORD}\s+(\d{1,2}),?\s+(\d{4})\b`, 'gi'))) {
    push(isoDate(+m[3]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!, today));
  }
  for (const m of line.matchAll(new RegExp(String.raw`\b(\d{1,2})[\s-]${MONTH_WORD}[\s-](\d{4}|\d{2})\b`, 'gi'))) {
    push(isoDate(+m[3]!, MONTHS.indexOf(m[2]!.toLowerCase()) + 1, +m[1]!, today));
  }
  return out;
}

const NOT_A_STORE = /^(?:welcome|receipt|customer\s+copy|merchant\s+copy|sale|thank\s+you)\b/i;
const ADDRESS = /^\d+\s+.*\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|way|dr|drive|hwy|highway|cres|crescent|pl|place)\b/i;

function storeOf(lines: readonly string[]): { store: string | null; index: number } {
  let seen = 0;
  for (let i = 0; i < lines.length && seen < 6; i++) {
    const line = lines[i]!;
    if (isSensitive(line)) continue;
    seen++;
    if (NOT_A_STORE.test(line) || ADDRESS.test(line) || lastMoney(line) || labelKind(line)) continue;
    if ((line.match(/[A-Za-z]/g) ?? []).length < 3) continue;
    const store = line
      .replace(/#\s*\d+/g, '')
      .replace(/\bstore\s*\d+/gi, '')
      .replace(/\b\d{3,}\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (store) return { store, index: i };
  }
  return { store: null, index: -1 };
}

const DISCOUNT_LABEL = /\b(?:inst(?:ant)?\s*sav(?:ings)?|tpd|coupon|discount|rollback\s+savings)\b/i;
const QTY_AT = /(\d+)\s*[@xX]\s*\$?(\d+\.\d{2})(?!\d)/;

interface DraftItem extends PurchaseItem {
  /** The item's own number, used only to attach a saving. Never returned. */
  privateNumber: string | null;
}

function legendCodes(lines: readonly string[]): Map<string, { labels: string[]; ratePpm: number | null }> {
  const legend = new Map<string, { labels: string[]; ratePpm: number | null }>();
  for (const line of lines) {
    const m = /^([A-Z0-9]{1,2})\s*[=:]\s*(.+)$/.exec(line);
    if (!m || lastMoney(m[2]!)) continue;
    const labels = [...m[2]!.toUpperCase().matchAll(/\b(GST|PST|HST|QST)\b/g)].map((x) => x[1]!);
    const rate = /(\d+(?:\.\d+)?)\s*%/.exec(m[2]!);
    const ratePpm = rate ? Math.round(Number.parseFloat(rate[1]!) * 10000) : null;
    if (labels.length === 0 && ratePpm === null) continue;
    legend.set(m[1]!, { labels, ratePpm });
  }
  return legend;
}

function emptyReadout(): PurchaseReadout {
  return {
    store: null,
    date: null,
    totalCents: null,
    subtotalCents: null,
    items: [],
    taxLines: [],
    flags: ['no_total', 'no_date'],
  };
}

const normalise = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);

export function parsePurchaseReceipt(
  text: string | null | undefined,
  opts: { today?: Date } = {},
): PurchaseReadout {
  if (typeof text !== 'string' || !text.trim()) return emptyReadout();
  try {
    return parse(normalise(text), opts.today ?? new Date());
  } catch {
    return emptyReadout();
  }
}

function parse(all: string[], today: Date): PurchaseReadout {
  const flags = new Set<PurchaseFlag>();
  const lines = all.filter((l) => !isSensitive(l));

  // ---- date, from every line: a date is not private, and a footer that also
  // names a terminal still carries the right day.
  const dates = all.flatMap((l) => datesOn(l, today));
  const date = dates.find((d) => d.withTime) ?? dates[0] ?? null;
  if (!date) flags.add('no_date');
  else if (date.ambiguous) flags.add('date_ambiguous');

  // ---- totals, subtotal, tip, tax lines
  const totals: { priority: number; cents: number }[] = [];
  let subtotalCents: number | null = null;
  let tipCents = 0;
  const taxLines: PurchaseTaxLine[] = [];
  let firstMoneyLabel = -1;
  lines.forEach((line, i) => {
    const kind = labelKind(line);
    if (!kind || kind === 'excluded') return;
    const cents = labelledAmount(lines, i);
    if (cents === null) return;
    if (firstMoneyLabel < 0 && kind !== 'tip') firstMoneyLabel = i;
    if (kind === 'subtotal') subtotalCents = cents;
    else if (kind === 'tip') tipCents = cents;
    else if (kind === 'tax') {
      const rate = /(\d+(?:\.\d+)?)\s*%/.exec(line);
      taxLines.push({
        label: TAX_LABEL.exec(line)![1]!.toUpperCase().replace(/\s+/g, ' ').slice(0, 24),
        ratePpm: rate ? Math.round(Number.parseFloat(rate[1]!) * 10000) : null,
        printedCents: Math.abs(cents),
        codes: [],
      });
    } else {
      totals.push({ priority: Number(kind.slice(-1)), cents });
    }
  });

  let totalCents: number | null = null;
  if (totals.length === 0) {
    flags.add('no_total');
  } else {
    const best = Math.min(...totals.map((t) => t.priority));
    const chosen = totals.filter((t) => t.priority === best);
    totalCents = chosen.at(-1)!.cents;
    const distinct = [...new Set(chosen.map((t) => t.cents))];
    if (distinct.length > 1) {
      const earlier = distinct.filter((c) => c !== totalCents);
      if (tipCents > 0 && earlier.some((c) => c + tipCents === totalCents)) flags.add('tip_included');
      else flags.add('totals_disagree');
    }
  }

  // ---- items, between the store line and the first money-bearing total,
  // subtotal or tax line.
  const { store, index: storeIndex } = storeOf(all);
  const storeLine = storeIndex >= 0 ? all[storeIndex]! : null;
  const start = storeLine ? lines.indexOf(storeLine) + 1 : 0;
  const end = firstMoneyLabel >= 0 ? firstMoneyLabel : lines.length;
  const items: DraftItem[] = [];
  let qtyColumn = false;
  for (let i = Math.max(0, start); i < end; i++) {
    const line = lines[i]!;
    const money = lastMoney(line);
    if (!money) {
      if (/\bqty\b/i.test(line)) qtyColumn = true;
      continue;
    }
    if (labelKind(line)) continue;

    // "2 @ 4.99" on its own line: the quantity of the item above it.
    const qtyOnly = /^(\d+)\s*[@xX]\s*\$?(\d+\.\d{2})$/.exec(line);
    if (qtyOnly) {
      const prev = items.at(-1);
      if (prev) {
        prev.quantity = +qtyOnly[1]!;
        prev.unitPriceCents = lastMoney(line)!.cents;
      }
      continue;
    }

    let head = line.slice(0, money.start).trim();
    const tail = line.slice(money.end).trim();
    let taxCode: string | null = /^[A-Z]{1,2}$/.test(tail) ? tail : null;
    if (tail && !taxCode) continue;
    if (!taxCode) {
      const before = /\s([A-Z])$/.exec(head);
      if (before) {
        taxCode = before[1]!;
        head = head.slice(0, -2).trim();
      }
    }

    const numberMatch = /^(\d{4,14})\b\s*\/?\s*/.exec(head);
    const privateNumber = numberMatch ? numberMatch[1]! : null;

    if (money.cents < 0 || DISCOUNT_LABEL.test(head)) {
      const target = (privateNumber && items.find((it) => it.privateNumber === privateNumber)) || items.at(-1);
      if (target) target.discountCents -= Math.abs(money.cents);
      continue;
    }

    let quantity: number | null = null;
    let unitPriceCents: number | null = null;
    if (numberMatch) head = head.slice(numberMatch[0].length);
    if (qtyColumn) {
      const lead = /^(\d{1,4})\s+(?=\D)/.exec(head);
      if (lead) {
        quantity = +lead[1]!;
        head = head.slice(lead[0].length);
      }
    }
    const at = QTY_AT.exec(head);
    if (at) {
      quantity = +at[1]!;
      unitPriceCents = lastMoney(at[0])?.cents ?? null;
      head = head.replace(at[0], ' ');
    }
    const qtyWord = /\bqty\s*(\d+)\b/i.exec(head);
    if (qtyWord) {
      quantity = +qtyWord[1]!;
      head = head.replace(qtyWord[0], ' ');
    }
    if (quantity && unitPriceCents === null && money.cents % quantity === 0) {
      unitPriceCents = money.cents / quantity;
    }

    const description = head
      .replace(/\b\d{6,}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s/:-]+|[\s/:-]+$/g, '')
      .slice(0, 120);
    if ((description.match(/[A-Za-z]/g) ?? []).length < 2) continue;

    items.push({
      description,
      quantity,
      unitPriceCents,
      lineTotalCents: money.cents,
      discountCents: 0,
      taxCode,
      privateNumber,
    });
  }

  // ---- codes, from this receipt only
  const legend = legendCodes(lines);
  const itemCodes = [...new Set(items.map((it) => it.taxCode).filter((c): c is string => !!c))];
  if (legend.size > 0) {
    for (const [code, entry] of legend) {
      for (const t of taxLines) {
        const byLabel = entry.labels.some((l) => t.label.includes(l));
        const byRate = entry.ratePpm !== null && entry.ratePpm === t.ratePpm;
        const generic = taxLines.length === 1 && !/GST|PST|HST|QST/.test(t.label);
        if (byLabel || byRate || (generic && entry.labels.length > 0)) t.codes.push(code);
      }
    }
  } else if (taxLines.length === 1 && itemCodes.length === 1) {
    taxLines[0]!.codes.push(itemCodes[0]!);
    flags.add('tax_codes_inferred');
  }
  const mapped = new Set(taxLines.flatMap((t) => t.codes));
  if (itemCodes.some((c) => !mapped.has(c))) flags.add('tax_codes_unmapped');

  // ---- checks; they never block anything
  const subtotal = subtotalCents as number | null;
  if (subtotal !== null && items.length > 0) {
    const sum = items.reduce((s, it) => s + it.lineTotalCents + it.discountCents, 0);
    if (sum !== subtotal) flags.add('items_subtotal_mismatch');
  }
  if (subtotal !== null && totalCents !== null) {
    const tax = taxLines.reduce((s, t) => s + (t.printedCents ?? 0), 0);
    if (subtotal + tax + tipCents !== totalCents) flags.add('subtotal_tax_total_mismatch');
  }

  return {
    store,
    date: date?.iso ?? null,
    totalCents,
    subtotalCents: subtotal,
    items: items.map(({ privateNumber: _private, ...item }) => item),
    taxLines,
    flags: PURCHASE_FLAGS.filter((f) => flags.has(f)),
  };
}

/**
 * Several photos of one long receipt, in order, as one text. Where a photo
 * starts with the lines the previous one ended on (the overlap a person leaves
 * so nothing is missed), those lines are dropped, so an item in the overlap is
 * not counted twice. The longest overlap of up to 12 lines wins.
 */
export function joinReceiptPages(pages: readonly string[]): string {
  const joined: string[] = [];
  for (const page of pages) {
    const lines = typeof page === 'string' ? normalise(page) : [];
    let overlap = 0;
    for (let k = Math.min(12, joined.length, lines.length); k > 0; k--) {
      const tail = joined.slice(joined.length - k);
      if (tail.every((l, i) => l === lines[i])) {
        overlap = k;
        break;
      }
    }
    joined.push(...lines.slice(overlap));
  }
  return joined.join('\n');
}
