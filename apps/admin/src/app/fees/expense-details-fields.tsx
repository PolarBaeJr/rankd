'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Select } from '@badminton/ui';
import {
  computeClubShare,
  EXPENSE_RECEIPT_TYPES,
  roundHalfUp,
  type ClubShare,
  type ExpenseItemInput,
  type ExpenseReceiptFileInput,
  type ExpenseReceiptType,
  type ExpenseTaxLineInput,
  type PurchaseFlag,
  type PurchaseReadout,
} from '@badminton/shared';
import { withBase } from '@/lib/base-path';
import { createClient } from '@/lib/supabase-browser';

// AN EXPENSE'S RECEIPT FILES, ITEMS AND TAX LINES (00313), for the Add and Edit
// expense dialogs in finance-actions.tsx. The dialog holds the state; this
// draws it, uploads what is picked, reads it, and works out the club's share.
// The server works the share out again (finance.ts prepareDetails) and stores
// its own figure, so the one shown here is the explanation, not the boundary.

// All three mirror the bucket's own configuration (00231, widened by 00313),
// checked here as well so a wrong-typed or oversized file is refused next to
// the picker rather than after an upload storage was always going to reject.
const RECEIPT_TYPES: readonly string[] = EXPENSE_RECEIPT_TYPES;
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_FILES = 20;

const EXTENSION_BY_TYPE: Record<ExpenseReceiptType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};

const TYPE_BY_EXTENSION: Record<string, ExpenseReceiptType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
};

// As form-receipts.ts sniffs a Drive file: some browsers hand a HEIC or a PDF
// over with an empty type.
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

const PREVIEWABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

const READ_FAILED = 'Could not read it. Type the details in.';
const PDF_FAILED = 'Could not read this PDF. Type the details in.';

const FLAG_SENTENCES: Record<PurchaseFlag, string> = {
  no_total: 'No total was found on the receipt. Type the amount.',
  totals_disagree: 'The receipt shows two different totals. Check the amount.',
  tip_included: 'The total includes a tip. Check the tip should be claimed.',
  items_subtotal_mismatch: 'The items do not add up to the subtotal. An item may be missing or misread.',
  subtotal_tax_total_mismatch: 'The subtotal and the tax do not add up to the total. Check the figures.',
  no_date: 'No date was found on the receipt. Set it below.',
  date_ambiguous: 'The date could be read two ways. Check it.',
  tax_codes_unmapped: 'Some tax codes are not explained on the receipt. Check each item\'s tax code.',
  tax_codes_inferred: 'The tax codes were worked out from the receipt\'s only tax line. Check them.',
};

const TAX_CODE = /^[A-Z0-9]{1,3}$/;

export interface ReceiptFileState {
  key: string;
  path: string;
  content_type: ExpenseReceiptType;
  /** Picked in this dialog; null for a file already stored on the row. */
  file: File | null;
  /** The stored attachment's id, for opening it; null until saved. */
  id: string | null;
  name: string;
}

export interface ItemState {
  key: string;
  description: string;
  quantity: string;
  amount: string;
  /** Typed as a positive figure; stored negative. */
  discount: string;
  /** '' is no tax code. */
  taxCode: string;
  taxCodeSource: 'receipt' | 'exec';
  isClub: boolean;
  /** As read off the receipt; dropped once the amount or quantity is edited. */
  unitPriceCents: number | null;
}

export interface TaxLineState {
  key: string;
  label: string;
  /** A percentage, "5" for 5%. */
  rate: string;
  printed: string;
  codes: string[];
}

export interface ExpenseDetailsState {
  receipts: ReceiptFileState[];
  vendor: string;
  receiptTotal: string;
  items: ItemState[];
  taxLines: TaxLineState[];
  flags: PurchaseFlag[];
  /** What the last read put in vendor and receiptTotal, so a re-read can replace it. */
  lastRead?: { vendor: string; receiptTotal: string };
  /** An upload or a read is running: saving waits for it. */
  busy: boolean;
}

export const EMPTY_DETAILS: ExpenseDetailsState = {
  receipts: [],
  vendor: '',
  receiptTotal: '',
  items: [],
  taxLines: [],
  flags: [],
  busy: false,
};

/** The stored children of an expense, as ledger-card.tsx reads them. */
export interface StoredExpenseDetails {
  vendor: string | null;
  receipt_total_cents: number | null;
  receipts: { id: string; path: string; content_type: string; position: number }[];
  items: {
    description: string;
    quantity: number | null;
    unit_price_cents: number | null;
    line_total_cents: number;
    discount_cents: number;
    tax_code: string | null;
    tax_code_source: string;
    is_club: boolean;
    position: number;
  }[];
  tax_lines: {
    label: string;
    rate_ppm: number | null;
    printed_cents: number | null;
    codes: string[];
    position: number;
  }[];
}

const newKey = () => crypto.randomUUID();
const centsText = (cents: number) => (cents / 100).toFixed(2);
export const dollars = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** As finance-actions.tsx's toCents, except that a refund line may be negative. */
function signedCents(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d*\.?\d{0,2}$/.test(trimmed) || trimmed === '' || trimmed === '-' || trimmed === '.' || trimmed === '-.') {
    return null;
  }
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function ppmOf(rate: string): number | null {
  const trimmed = rate.trim();
  if (trimmed === '' || !/^\d*\.?\d{0,4}$/.test(trimmed)) return null;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? Math.round(n * 10000) : null;
}

const itemNet = (item: ItemState) => (signedCents(item.amount) ?? 0) - Math.abs(signedCents(item.discount || '0') ?? 0);

export function detailsFromStored(stored: StoredExpenseDetails): ExpenseDetailsState {
  return {
    receipts: [...stored.receipts]
      .sort((a, b) => a.position - b.position)
      .map((r, i) => ({
        // '' is a receipt still only in receipt_path, with no attachment id.
        key: r.id || newKey(),
        path: r.path,
        content_type: (RECEIPT_TYPES.includes(r.content_type) ? r.content_type : 'image/jpeg') as ExpenseReceiptType,
        file: null,
        id: r.id || null,
        name: `Page ${i + 1}`,
      })),
    vendor: stored.vendor ?? '',
    receiptTotal: stored.receipt_total_cents == null ? '' : centsText(stored.receipt_total_cents),
    items: [...stored.items]
      .sort((a, b) => a.position - b.position)
      .map((it) => ({
        key: newKey(),
        description: it.description,
        quantity: it.quantity == null ? '' : String(Number(it.quantity)),
        amount: centsText(it.line_total_cents),
        discount: it.discount_cents ? centsText(-it.discount_cents) : '',
        taxCode: it.tax_code ?? '',
        taxCodeSource: it.tax_code_source === 'exec' ? 'exec' : 'receipt',
        isClub: it.is_club,
        unitPriceCents: it.unit_price_cents,
      })),
    taxLines: [...stored.tax_lines]
      .sort((a, b) => a.position - b.position)
      .map((t) => ({
        key: newKey(),
        label: t.label,
        rate: t.rate_ppm == null ? '' : String(t.rate_ppm / 10000),
        printed: t.printed_cents == null ? '' : centsText(t.printed_cents),
        codes: [...(t.codes ?? [])],
      })),
    flags: [],
    busy: false,
  };
}

/**
 * A field a read may fill: one still empty, or still holding what the last read
 * put there. So reading again (a better page, a second PDF) corrects an earlier
 * misread, and never overwrites what the exec typed.
 */
export function readFill(current: string, lastRead: string | undefined, read: string): string {
  if (!read) return current;
  return current === '' || current === lastRead ? read : current;
}

/**
 * Fill what is empty or still the last read's, so a read never overwrites what
 * was typed. Items and tax lines fill only when there are none: the exec's
 * ticks and codes on them are kept.
 */
function applyReadout(state: ExpenseDetailsState, readout: PurchaseReadout): ExpenseDetailsState {
  const vendor = readFill(state.vendor, state.lastRead?.vendor, (readout.store ?? '').slice(0, 80));
  const receiptTotal = readFill(
    state.receiptTotal,
    state.lastRead?.receiptTotal,
    readout.totalCents == null ? '' : centsText(readout.totalCents),
  );
  return {
    ...state,
    vendor,
    receiptTotal,
    lastRead: { vendor, receiptTotal },
    items:
      state.items.length > 0
        ? state.items
        : readout.items.slice(0, 500).map((it) => ({
            key: newKey(),
            description: it.description.slice(0, 120),
            quantity: it.quantity == null ? '' : String(it.quantity),
            amount: centsText(it.lineTotalCents),
            discount: it.discountCents ? centsText(-it.discountCents) : '',
            taxCode: it.taxCode && TAX_CODE.test(it.taxCode) ? it.taxCode : '',
            taxCodeSource: 'receipt',
            isClub: true,
            unitPriceCents: it.unitPriceCents,
          })),
    taxLines:
      state.taxLines.length > 0
        ? state.taxLines
        : readout.taxLines.slice(0, 10).map((t) => ({
            key: newKey(),
            label: t.label.slice(0, 24),
            rate: t.ratePpm == null ? '' : String(t.ratePpm / 10000),
            printed: t.printedCents == null ? '' : centsText(t.printedCents),
            codes: t.codes.filter((code) => TAX_CODE.test(code)).slice(0, 10),
          })),
    flags: readout.flags,
  };
}

/** The club's share of the ticked items, or null when there are no items. */
export function detailsShare(state: ExpenseDetailsState): ClubShare | null {
  if (state.items.length === 0) return null;
  return computeClubShare(
    state.items.map((it) => ({ netCents: itemNet(it), taxCode: it.taxCode || null, isClub: it.isClub })),
    state.taxLines.map((t) => ({
      label: t.label.trim(),
      ratePpm: ppmOf(t.rate),
      printedCents: t.printed.trim() === '' ? null : signedCents(t.printed),
      codes: t.codes,
    })),
  );
}

/** Something typed will not save: a figure that does not parse, or a blank label. */
export function detailsInvalid(state: ExpenseDetailsState): boolean {
  if (state.busy) return true;
  if (state.receiptTotal.trim() !== '' && (signedCents(state.receiptTotal) ?? -1) < 0) return true;
  for (const it of state.items) {
    if (it.isClub && !it.description.trim()) return true;
    if (signedCents(it.amount) === null) return true;
    if (it.discount.trim() !== '' && signedCents(it.discount) === null) return true;
    if (it.quantity.trim() !== '' && !(Number.parseFloat(it.quantity) > 0)) return true;
  }
  for (const t of state.taxLines) {
    if (!t.label.trim()) return true;
    if (t.rate.trim() !== '' && ppmOf(t.rate) === null) return true;
    if (t.printed.trim() !== '' && (signedCents(t.printed) ?? -1) < 0) return true;
  }
  const share = detailsShare(state);
  return share !== null && share.clubShareCents < 0;
}

/**
 * What the expense actions take. ALWAYS SENT IN FULL: the server replaces the
 * receipts, items and tax lines wholesale (save_club_expense_details), so a
 * file or an item the dialog forgets is one the save deletes.
 */
export function detailsPayload(state: ExpenseDetailsState): {
  receipts: ExpenseReceiptFileInput[];
  vendor: string | undefined;
  receipt_total_cents: number | undefined;
  items: ExpenseItemInput[];
  tax_lines: ExpenseTaxLineInput[];
} {
  const total = state.receiptTotal.trim() === '' ? null : signedCents(state.receiptTotal);
  return {
    receipts: state.receipts.map((r) => ({ path: r.path, content_type: r.content_type })),
    vendor: state.vendor.trim() || undefined,
    receipt_total_cents: total ?? undefined,
    items: state.items.map((it) => {
      const quantity = Number.parseFloat(it.quantity);
      const discount = it.discount.trim() === '' ? 0 : -Math.abs(signedCents(it.discount) ?? 0);
      return {
        // An unticked item is stored as "Personal item" whatever is sent
        // (prepareDetails); a blank one still has to pass the schema.
        description: it.description.trim() || (it.isClub ? '' : 'Personal item'),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
        unit_price_cents: it.unitPriceCents ?? undefined,
        line_total_cents: signedCents(it.amount) ?? 0,
        discount_cents: discount,
        tax_code: it.taxCode || null,
        tax_code_source: it.taxCodeSource,
        is_club: it.isClub,
      };
    }),
    tax_lines: state.taxLines.map((t) => ({
      label: t.label.trim(),
      rate_ppm: ppmOf(t.rate),
      printed_cents: t.printed.trim() === '' ? null : signedCents(t.printed),
      codes: t.codes,
    })),
  };
}

async function receiptTypeOf(file: File): Promise<ExpenseReceiptType | null> {
  if (RECEIPT_TYPES.includes(file.type)) return file.type as ExpenseReceiptType;
  if (file.type !== '' && file.type !== 'application/octet-stream') return null;
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (HEIF_BRANDS.has(brand)) return 'image/heif';
  }
  if (bytes.length >= 5 && ascii(0, 5) === '%PDF-') return 'application/pdf';
  return TYPE_BY_EXTENSION[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

/**
 * Upload a picked receipt file and return the path the action should store.
 *
 * STRAIGHT FROM THE BROWSER TO STORAGE, never through a server action: a
 * multi-megabyte photo posted to an action would cross the single Node thread
 * that renders every other page in the console. There is no multipart route and
 * no FormData anywhere in this repo, and this deliberately does not add the
 * first one.
 *
 * The folder is the UPLOADER'S auth.uid(), because that is the only thing
 * storage RLS can see and it is what 00231's INSERT policy checks. It is
 * frequently not the payer: an admin writing up an exec's texted receipt uploads
 * it under their own id while the exec is the one owed the money. The actions
 * re-check the path against the uploader for the same reason.
 *
 * UPLOADED ON PICK, not on save, so the receipt can be read (a HEIC through the
 * pending route, which reads storage) before the expense exists. A dialog that
 * is cancelled, or a file removed before saving, leaves its object behind in
 * the uploader's own folder: unreachable, since nothing names it and the bucket
 * has no read policy, and the same orphan a failed save always left.
 *
 * Returns null when the upload failed, having already said so.
 */
async function uploadReceipt(
  file: File,
  type: ExpenseReceiptType,
  fail: (message: string) => void,
): Promise<string | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    fail('Your session expired. Sign in again and try once more.');
    return null;
  }

  const path = `${user.id}/${crypto.randomUUID()}.${EXTENSION_BY_TYPE[type]}`;
  const { error } = await supabase.storage
    .from('expense-receipts')
    .upload(path, file, { contentType: type, upsert: false });

  if (error) {
    fail(`The receipt could not be uploaded (${error.message}). Try again, or use a smaller file.`);
    return null;
  }
  return path;
}

/** A picked photo, previewed from the local File; revoked on unmount. */
function LocalThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  if (!url) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="Receipt page to be attached" className="h-16 w-auto border border-[var(--border)]" />;
}

/** The share as one sentence, for the dialog and the viewer alike. */
export function shareSummary(share: ClubShare, receiptTotalCents: number | null, allTicked: boolean): string[] {
  const taxes = share.perLine
    .filter((line) => line.clubTaxCents !== 0)
    .map((line) => ` + ${line.label} ${dollars(line.clubTaxCents)}`)
    .join('');
  const lines = [`Club items ${dollars(share.clubNetCents)}${taxes} = Club share ${dollars(share.clubShareCents)}.`];
  if (receiptTotalCents !== null) {
    if (!allTicked) {
      lines[0] += ` Receipt total ${dollars(receiptTotalCents)}. Personal ${dollars(receiptTotalCents - share.clubShareCents)}.`;
    } else if (receiptTotalCents !== share.clubShareCents) {
      lines.push(
        `Every item is ticked, but the club share is ${dollars(share.clubShareCents)} and the receipt total is ${dollars(receiptTotalCents)} (${dollars(Math.abs(receiptTotalCents - share.clubShareCents))} apart).`,
      );
    }
  }
  if (share.mode === 'proportional') {
    lines.push(
      "This receipt shows no tax code per item, so its tax is split by the ticked items' share. Set each item's tax code to work it out exactly.",
    );
  }
  return [...lines, ...share.roundingNotes];
}

export function ExpenseDetailsFields({
  value,
  setValue,
  disabled,
  onRead,
}: {
  value: ExpenseDetailsState;
  setValue: React.Dispatch<React.SetStateAction<ExpenseDetailsState>>;
  /** Settled row: everything is shown and nothing can change. */
  disabled: boolean;
  /** A read found something: the dialog fills its own empty fields from it. */
  onRead: (readout: PurchaseReadout) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [readNote, setReadNote] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Once per opening of the dialog: the dialog unmounts this when it closes.
  const autoRead = useRef(false);
  const locked = disabled || value.busy;

  const setItem = (key: string, patch: Partial<ItemState>) =>
    setValue((d) => ({ ...d, items: d.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) }));
  const setTaxLine = (key: string, patch: Partial<TaxLineState>) =>
    setValue((d) => ({ ...d, taxLines: d.taxLines.map((t) => (t.key === key ? { ...t, ...patch } : t)) }));

  async function read(receipts: readonly ReceiptFileState[]) {
    if (receipts.length === 0) return;
    setReading(true);
    setReadNote(null);
    setValue((d) => ({ ...d, busy: true }));
    try {
      const { readExpenseReceipt } = await import('./expense-receipt-reader');
      const { readout, pdfFailed } = await readExpenseReceipt(
        receipts.map((r) => ({ file: r.file, path: r.path, type: r.content_type })),
      );
      const found =
        readout !== null &&
        (readout.totalCents !== null || readout.items.length > 0 || readout.store !== null || readout.date !== null);
      if (readout && found) {
        setValue((d) => applyReadout(d, readout));
        onRead(readout);
      }
      setReadNote(pdfFailed ? PDF_FAILED : found ? null : READ_FAILED);
    } catch {
      setReadNote(READ_FAILED);
    } finally {
      setReading(false);
      setValue((d) => ({ ...d, busy: false }));
    }
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    // Cleared so picking the SAME file again still fires a change event.
    e.target.value = '';
    if (picked.length === 0) return;
    setError(null);
    if (value.receipts.length + picked.length > MAX_RECEIPT_FILES) {
      setError(`A receipt can have at most ${MAX_RECEIPT_FILES} files.`);
      return;
    }

    setValue((d) => ({ ...d, busy: true }));
    const uploaded: ReceiptFileState[] = [];
    try {
      for (const file of picked) {
        const type = await receiptTypeOf(file);
        if (!type) {
          setError('A receipt needs to be a JPEG, PNG, WebP or HEIC photo, or a PDF.');
          continue;
        }
        if (file.size > MAX_RECEIPT_BYTES) {
          setError(`${file.name} is over 8 MB. Try a smaller one, or a photo of just the receipt.`);
          continue;
        }
        const path = await uploadReceipt(file, type, setError);
        if (!path) break;
        const next: ReceiptFileState = { key: newKey(), path, content_type: type, file, id: null, name: file.name };
        uploaded.push(next);
        setValue((d) => ({ ...d, receipts: [...d.receipts, next] }));
      }
    } finally {
      setValue((d) => ({ ...d, busy: false }));
    }
    if (uploaded.length > 0 && !autoRead.current) {
      autoRead.current = true;
      await read([...value.receipts, ...uploaded]);
    }
  }

  function move(index: number, by: -1 | 1) {
    setValue((d) => {
      const receipts = [...d.receipts];
      const [moved] = receipts.splice(index, 1);
      if (moved) receipts.splice(index + by, 0, moved);
      return { ...d, receipts };
    });
  }

  const codes = [
    ...new Set([...value.items.map((it) => it.taxCode), ...value.taxLines.flatMap((t) => t.codes)].filter(Boolean)),
  ].sort();
  const share = detailsShare(value);
  const total = value.receiptTotal.trim() === '' ? null : signedCents(value.receiptTotal);
  const lineTax = (item: ItemState) => {
    if (!item.taxCode) return null;
    let cents = 0;
    let known = false;
    for (const t of value.taxLines) {
      const ppm = ppmOf(t.rate);
      if (ppm === null || !t.codes.includes(item.taxCode)) continue;
      cents += roundHalfUp(itemNet(item) * ppm, 1_000_000);
      known = true;
    }
    return known ? cents : null;
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <span className="block text-sm font-medium text-[var(--text-primary)]">Receipt (optional)</span>
        <input
          ref={input}
          type="file"
          multiple
          accept={[...RECEIPT_TYPES, '.heic', '.heif'].join(',')}
          onChange={pick}
          className="hidden"
          disabled={locked}
        />
        {value.receipts.length > 0 && (
          <ol className="space-y-2">
            {value.receipts.map((r, i) => (
              <li key={r.key} className="flex flex-wrap items-center gap-2">
                {r.file && PREVIEWABLE.has(r.content_type) ? (
                  <LocalThumb file={r.file} />
                ) : null}
                <span className="text-sm text-[var(--text-secondary)] break-all">
                  {i + 1}. {r.name}
                  {r.content_type === 'application/pdf' ? ' (PDF)' : ''}
                </span>
                {r.id && (
                  <a
                    href={withBase(`/fees/expense-receipt/${r.id}`)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-[var(--color-accent)] underline"
                  >
                    Open
                  </a>
                )}
                {!disabled && (
                  <span className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => move(i, -1)} disabled={locked || i === 0}>
                      Up
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => move(i, 1)}
                      disabled={locked || i === value.receipts.length - 1}
                    >
                      Down
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setValue((d) => ({ ...d, receipts: d.receipts.filter((x) => x.key !== r.key) }))}
                      disabled={locked}
                    >
                      Remove
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        {!disabled && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => input.current?.click()}
              disabled={locked || value.receipts.length >= MAX_RECEIPT_FILES}
            >
              {value.receipts.length > 0 ? 'Add another page' : 'Add a receipt'}
            </Button>
            {value.receipts.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => read(value.receipts)} disabled={locked}>
                Read receipt
              </Button>
            )}
          </div>
        )}
        {reading && <p className="text-xs text-[var(--text-secondary)]">Reading the receipt...</p>}
        {readNote && <p className="text-xs text-[var(--text-secondary)]">{readNote}</p>}
        {error && (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {error}
          </p>
        )}
        <p className="text-xs text-[var(--text-muted)]">
          JPEG, PNG, WebP, HEIC or PDF, up to 8 MB each and {MAX_RECEIPT_FILES} files, in page order. Only people
          who can see this ledger can open them.
        </p>
      </div>

      {value.flags.length > 0 && (
        <ul className="space-y-1 rounded-md border border-[var(--color-warning)] px-3 py-2 text-sm text-[var(--text-secondary)]">
          {value.flags.map((flag) => (
            <li key={flag}>{FLAG_SENTENCES[flag]}</li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Store (optional)"
          value={value.vendor}
          onChange={(e) => setValue((d) => ({ ...d, vendor: e.target.value }))}
          maxLength={80}
          disabled={locked}
        />
        <Input
          label="Receipt total $ (optional)"
          type="number"
          step="0.01"
          min="0"
          value={value.receiptTotal}
          onChange={(e) => setValue((d) => ({ ...d, receiptTotal: e.target.value }))}
          disabled={locked}
        />
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-medium text-[var(--text-primary)]">Items (optional)</span>
        {value.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th className="pr-2 font-medium">Club</th>
                  <th className="pr-2 font-medium">Description</th>
                  <th className="pr-2 font-medium">Qty</th>
                  <th className="pr-2 font-medium">Amount $</th>
                  <th className="pr-2 font-medium">Discount $</th>
                  <th className="pr-2 font-medium">Tax code</th>
                  <th className="pr-2 font-medium">Tax</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {value.items.map((it, i) => {
                  const tax = lineTax(it);
                  return (
                    <tr key={it.key} className="align-middle">
                      <td className="pr-2">
                        <Checkbox
                          checked={it.isClub}
                          onChange={(isClub) => setItem(it.key, { isClub })}
                          label={`Item ${i + 1} is for the club`}
                          disabled={locked}
                        />
                      </td>
                      <td className="pr-2 min-w-[10rem]">
                        <Input
                          aria-label={`Item ${i + 1} description`}
                          value={it.description}
                          onChange={(e) => setItem(it.key, { description: e.target.value })}
                          placeholder={it.isClub ? undefined : 'Personal item'}
                          maxLength={120}
                          disabled={locked}
                        />
                      </td>
                      <td className="pr-2 w-20">
                        <Input
                          aria-label={`Item ${i + 1} quantity`}
                          type="number"
                          min="0"
                          step="any"
                          value={it.quantity}
                          onChange={(e) => setItem(it.key, { quantity: e.target.value, unitPriceCents: null })}
                          disabled={locked}
                        />
                      </td>
                      <td className="pr-2 w-28">
                        <Input
                          aria-label={`Item ${i + 1} amount`}
                          inputMode="decimal"
                          value={it.amount}
                          onChange={(e) => setItem(it.key, { amount: e.target.value, unitPriceCents: null })}
                          disabled={locked}
                        />
                      </td>
                      <td className="pr-2 w-28">
                        <Input
                          aria-label={`Item ${i + 1} discount`}
                          type="number"
                          min="0"
                          step="0.01"
                          value={it.discount}
                          onChange={(e) => setItem(it.key, { discount: e.target.value })}
                          disabled={locked}
                        />
                      </td>
                      <td className="pr-2 w-28">
                        <Select
                          aria-label={`Item ${i + 1} tax code`}
                          options={[{ value: '', label: 'None' }, ...codes.map((code) => ({ value: code, label: code }))]}
                          value={it.taxCode}
                          onValueChange={(taxCode) => setItem(it.key, { taxCode, taxCodeSource: 'exec' })}
                          disabled={locked}
                        />
                      </td>
                      <td className="pr-2 whitespace-nowrap text-[var(--text-secondary)]">
                        {tax === null ? '' : dollars(tax)}
                      </td>
                      <td>
                        {!disabled && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setValue((d) => ({ ...d, items: d.items.filter((x) => x.key !== it.key) }))}
                            disabled={locked}
                          >
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!disabled && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setValue((d) => ({
                ...d,
                items: [
                  ...d.items,
                  {
                    key: newKey(),
                    description: '',
                    quantity: '',
                    amount: '',
                    discount: '',
                    taxCode: '',
                    taxCodeSource: 'exec',
                    isClub: true,
                    unitPriceCents: null,
                  },
                ],
              }))
            }
            disabled={locked || value.items.length >= 500}
          >
            Add item
          </Button>
        )}
        {value.items.some((it) => !it.isClub) && (
          <p className="text-xs text-[var(--text-muted)]">
            An unticked item is saved as &quot;Personal item&quot;, with its amount kept so the receipt still adds up.
          </p>
        )}
      </div>

      {(value.taxLines.length > 0 || value.items.length > 0) && (
        <div className="space-y-2">
          <span className="block text-sm font-medium text-[var(--text-primary)]">Tax lines</span>
          {value.flags.includes('tax_codes_inferred') && (
            <p className="text-xs text-[var(--text-muted)]">Worked out from this receipt.</p>
          )}
          {value.taxLines.map((t, i) => (
            <div key={t.key} className="flex flex-wrap items-end gap-2">
              <div className="w-28">
                <Input
                  aria-label={`Tax line ${i + 1} label`}
                  value={t.label}
                  onChange={(e) => setTaxLine(t.key, { label: e.target.value })}
                  placeholder="GST"
                  maxLength={24}
                  disabled={locked}
                />
              </div>
              <div className="w-24">
                <Input
                  aria-label={`Tax line ${i + 1} rate percent`}
                  type="number"
                  min="0"
                  step="any"
                  value={t.rate}
                  onChange={(e) => setTaxLine(t.key, { rate: e.target.value })}
                  placeholder="Rate %"
                  disabled={locked}
                />
              </div>
              <div className="w-28">
                <Input
                  aria-label={`Tax line ${i + 1} printed amount`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={t.printed}
                  onChange={(e) => setTaxLine(t.key, { printed: e.target.value })}
                  placeholder="Printed $"
                  disabled={locked}
                />
              </div>
              {codes.map((code) => (
                <Checkbox
                  key={code}
                  checked={t.codes.includes(code)}
                  onChange={(on) =>
                    setTaxLine(t.key, {
                      codes: on ? [...t.codes, code].slice(0, 10) : t.codes.filter((c) => c !== code),
                    })
                  }
                  label={code}
                  showLabel
                  disabled={locked}
                />
              ))}
              {!disabled && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setValue((d) => ({ ...d, taxLines: d.taxLines.filter((x) => x.key !== t.key) }))}
                  disabled={locked}
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          {!disabled && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setValue((d) => ({
                  ...d,
                  taxLines: [...d.taxLines, { key: newKey(), label: '', rate: '', printed: '', codes: [] }],
                }))
              }
              disabled={locked || value.taxLines.length >= 10}
            >
              Add tax line
            </Button>
          )}
        </div>
      )}

      {share && (
        <div className="space-y-1 text-sm text-[var(--text-secondary)]">
          {shareSummary(share, total, value.items.every((it) => it.isClub)).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}
