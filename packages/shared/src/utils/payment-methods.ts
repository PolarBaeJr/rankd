// How a fee was paid. Was a free-text box, which meant "E-transfer",
// "e transfer", "etransfer" and "E-Transfer" all landed in the same column and
// nothing could be counted or filtered. A fixed list makes the common cases
// consistent; Custom keeps the escape hatch for the one-off that does not fit.

export const PAYMENT_METHODS = [
  { value: 'e_transfer', label: 'E-transfer' },
  { value: 'cash', label: 'Cash' },
  { value: 'online_portal', label: 'Online portal' },
  { value: 'sfu_rec', label: 'Campus Rec website' },
  { value: 'custom', label: 'Custom' },
] as const;

export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number]['value'];

/** The sentinel that reveals the free-text box. Never stored. */
export const PAYMENT_METHOD_CUSTOM: PaymentMethodValue = 'custom';

// A waived fee is recorded as a paid row with amount_cents 0 and method
// 'waived' so income sums stay right without a separate table. That makes
// 'waived' a reserved word here: a custom method of "waived" would render the
// row as Waived and silently drop it out of the outstanding count. The old
// free-text box had this hazard too and it was noted in the code as "accepted";
// with a fixed list it costs nothing to actually close it.
export const RESERVED_METHOD = 'waived';

export function isReservedMethod(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === RESERVED_METHOD;
}

/**
 * The stored value for a fee paid on the Campus Rec website. Campus Rec takes that
 * money, not the club, so the console's income totals report it as its own
 * figure (see admin's season-income.ts). The member is paid either way.
 */
export const SFU_REC_METHOD: PaymentMethodValue = 'sfu_rec';

/**
 * True only for the exact stored value. A custom method somebody typed by hand
 * ("Campus Rec", "Campus Rec website") is NOT matched: free text is club money unless
 * an exec picks the fixed option, so a guess can never move a payment out of
 * the club's income.
 */
export function isCollectedBySfuRec(method: string | null | undefined): boolean {
  return method === SFU_REC_METHOD;
}

/**
 * Turn the dropdown selection (plus any custom text) into the single string
 * stored on the fee row. Returns undefined when nothing was chosen — method is
 * optional and an empty string would be stored as a meaningless "".
 */
export function resolvePaymentMethod(
  selected: string,
  custom: string,
): string | undefined {
  if (!selected) return undefined;
  if (selected === PAYMENT_METHOD_CUSTOM) {
    const trimmed = custom.trim();
    return trimmed || undefined;
  }
  return selected;
}

/** Stored value -> something readable. Unknown values are shown as typed. */
export function formatPaymentMethod(stored: string | null | undefined): string {
  if (!stored) return '';
  const known = PAYMENT_METHODS.find((m) => m.value === stored);
  if (known && known.value !== PAYMENT_METHOD_CUSTOM) return known.label;
  return stored;
}
