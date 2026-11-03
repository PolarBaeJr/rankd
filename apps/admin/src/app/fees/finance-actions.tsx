'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input, Select, DatePicker, useConfirm } from '@badminton/ui';
import {
  errorToastText,
  resolvePaymentMethod,
  PAYMENT_METHODS,
  PAYMENT_METHOD_CUSTOM,
  EXPENSE_CATEGORIES,
  OTHER_INCOME_CATEGORIES,
  type ExpenseCategory,
  type OtherIncomeCategory,
  type PurchaseReadout,
} from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import {
  addOtherIncome,
  removeOtherIncome,
  addExpense,
  updateExpense,
  removeExpense,
  markExpenseReimbursed,
} from '@/lib/actions';
import {
  PaymentMethodFields,
  paymentMethodInvalid,
  EMPTY_PAYMENT_METHOD,
  type PaymentMethodState,
} from './payment-method-fields';
import {
  ExpenseDetailsFields,
  EMPTY_DETAILS,
  detailsFromStored,
  detailsInvalid,
  detailsPayload,
  detailsShare,
  type ExpenseDetailsState,
  type StoredExpenseDetails,
} from './expense-details-fields';

/**
 * Dialogs for the two non-fee ledgers (00073).
 *
 * Both entry forms share one shape on purpose — description, category, amount,
 * optional date, optional payment method — because the two tables share one
 * column layout and a future consolidation should not have to reconcile two
 * different ideas of what a money entry is.
 */

// THE RECEIPT FILES, ITEMS AND TAX LINES (00231, 00313) are drawn, uploaded
// and read by expense-details-fields.tsx.

/**
 * Dollars typed into a text box -> integer cents.
 *
 * Math.round, not truncation: 19.99 * 100 is 1998.9999999999998 in binary
 * floating point, and |0 would file it as $19.98. Cents are the only integer
 * the database ever sees; the float exists for the length of this function.
 */
function toCents(dollars: string): number | null {
  const trimmed = dollars.trim();
  // At most two decimal places, REFUSED rather than rounded. "1.005" is not a
  // sum of money, and rounding it silently picks $1.00 or $1.01 on the user's
  // behalf — in binary floating point 1.005 * 100 is 100.49999999999999, so it
  // picks the one nobody expects. The amount box is step="0.01", so anything
  // finer arrived by paste or by a caller bypassing the widget; disabling
  // submit and letting the person fix it is the only honest answer.
  if (!/^\d*\.?\d{0,2}$/.test(trimmed) || trimmed === '' || trimmed === '.') return null;
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * "YYYY-MM-DD" from the date picker -> a full ISO timestamp.
 *
 * Noon local time, not midnight: midnight in a timezone behind UTC serialises
 * to the previous day, so an expense entered for the 1st would be stored as the
 * last day of the previous month. Nothing buckets by this date — the season is
 * a column — but a receipt dated a day early is still wrong on screen.
 */
function dateToIso(day: string): string | undefined {
  if (!day) return undefined;
  const d = new Date(`${day}T12:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * The inverse, for prefilling the edit dialog: a stored timestamp -> the
 * "YYYY-MM-DD" the date picker wants.
 *
 * Built from the LOCAL date parts, not from `toISOString().slice(0, 10)`. The
 * stored value is noon local (see above), so slicing the UTC string gives the
 * previous day anywhere east of UTC — an admin opening a September 1st expense
 * to fix a typo would find it dated August 31st and save that back.
 */
function isoToDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A stored method string -> the two form fields it came from.
 *
 * Anything outside the fixed vocabulary was typed into the Custom box, so it
 * goes back there rather than being dropped: an edit dialog that silently
 * cleared "cheque" would make every save of an unrelated field erase how the
 * money moved.
 */
function paymentFromStored(method: string | null, reference: string | null): PaymentMethodState {
  // PAYMENT_METHOD_CUSTOM is the UI's "reveal the text box" sentinel and is
  // never stored (resolvePaymentMethod turns it into the typed text or into
  // undefined). A row holding the literal string anyway — written by some other
  // path — must not be treated as a known value: selecting Custom with an empty
  // box round-trips to undefined and would erase how the money moved on the
  // next save of an unrelated field.
  const known = method !== PAYMENT_METHOD_CUSTOM && PAYMENT_METHODS.some((m) => m.value === method);
  return {
    method: method ? (known ? method : PAYMENT_METHOD_CUSTOM) : '',
    customMethod: method && !known ? method : '',
    reference: reference ?? '',
  };
}

interface EntryFormState {
  description: string;
  amount: string;
  category: string;
  day: string;
  quantity: string;
  /**
   * Who fronted the money (00077). Three distinct values, and the distinction
   * matters:
   *   ''          nothing chosen yet — submit stays disabled
   *   CLUB_FUNDS  the club account paid; nobody is owed
   *   <uuid>      that person is out of pocket until an admin reimburses them
   *
   * There is no default on purpose. Defaulting to the club would silently drop
   * an exec's reimbursement; defaulting to the person typing would invent a
   * debt to whichever admin wrote up someone else's receipt. And neither could
   * be corrected afterwards — there is no edit action, and delete is
   * admin-only, so an exec cannot fix their own row.
   */
  paidBy: string;
}

/** Sentinel for "the club account paid" — distinct from "not chosen yet" (''). */
const CLUB_FUNDS = 'club';

const emptyForm = (category: string): EntryFormState => ({
  description: '',
  amount: '',
  category,
  day: '',
  quantity: '',
  paidBy: '',
});

/** Shared dialog body. `quantityLabel` present = show the unit-count field. */
function EntryDialog({
  open,
  onClose,
  title,
  intro,
  categories,
  form,
  setForm,
  payment,
  setPayment,
  quantityLabel,
  payerOptions,
  details,
  settledNote,
  onSubmit,
  isPending,
  submitLabel,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  intro: React.ReactNode;
  categories: readonly { value: string; label: string }[];
  form: EntryFormState;
  setForm: (next: EntryFormState) => void;
  payment: PaymentMethodState;
  setPayment: (next: PaymentMethodState) => void;
  quantityLabel?: string;
  /** Present = this ledger has a payer to ask about (expenses do, income does not). */
  payerOptions?: { id: string; full_name: string }[];
  /**
   * Set when editing an expense the club has already reimbursed. The amount and
   * the payer are what the reimbursement was settled against, so they are shown
   * and greyed rather than hidden — an admin looking for the amount needs to
   * see it, and needs to see that it is not theirs to change. updateExpense()
   * refuses them regardless; this is the explanation, not the boundary.
   */
  /**
   * Present = this ledger takes a receipt (00231, 00313): its files, items and
   * tax lines. Expenses do; income does not, and passing nothing is what keeps
   * the picker off the income dialog entirely rather than hiding it with a flag.
   *
   * Held by the CALLER, not in EntryFormState: that shape is shared with the
   * income ledger, and a receipt on it would be a field one of the two dialogs
   * could never fill.
   */
  details?: {
    value: ExpenseDetailsState;
    setValue: React.Dispatch<React.SetStateAction<ExpenseDetailsState>>;
    /** Settled row: the receipt, items and tax are frozen, so all are read-only. */
    disabled?: boolean;
  };
  settledNote?: string;
  onSubmit: () => void;
  isPending: boolean;
  submitLabel: string;
}) {
  // A read lands after an await, by which time `form` in this closure may be
  // a keystroke old; the ref is the form as it is now.
  const formRef = useRef(form);
  formRef.current = form;

  // With items, the amount is the club's share of them and is not typed.
  const share = details ? detailsShare(details.value) : null;

  function fillFromReadout(readout: PurchaseReadout) {
    const now = formRef.current;
    setForm({
      ...now,
      description: now.description || (readout.store ?? '').slice(0, 120),
      day: now.day || (readout.date ?? ''),
      // Only when no items were read: with items the amount is their share.
      amount:
        now.amount || readout.items.length > 0 || readout.totalCents === null
          ? now.amount
          : (readout.totalCents / 100).toFixed(2),
    });
  }

  const cents = share ? share.clubShareCents : toCents(form.amount);
  // Amount is required and must parse. An entry with no figure is not a ledger
  // line, and a blank one submitted as 0 would look like a recorded $0.00.
  //
  // paidBy is required too, on the ledger that has one — see EntryFormState for
  // why there is no default to fall back on.
  const invalid =
    !form.description.trim() ||
    (!share && form.amount.trim() === '') ||
    cents === null ||
    cents < 0 ||
    (details !== undefined && detailsInvalid(details.value)) ||
    (payerOptions !== undefined && form.paidBy === '') ||
    paymentMethodInvalid(payment);

  return (
    <Dialog open={open} onClose={onClose} title={title} size={details ? 'wide' : 'default'}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">{intro}</p>
        {settledNote && (
          <p className="text-sm rounded-md border border-[var(--color-warning)] px-3 py-2 text-[var(--text-secondary)]">
            {settledNote}
          </p>
        )}
        <Input
          label="Description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="e.g. 6 tubes of Yonex AS-30"
          maxLength={120}
        />
        <Select
          label="Category"
          options={categories.map((c) => ({ value: c.value, label: c.label }))}
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
        />
        {share && details ? (
          <div className="space-y-1">
            <Input label="Amount $ (the club's share of the items)" value={(share.clubShareCents / 100).toFixed(2)} readOnly disabled />
            {!details.disabled && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setForm({ ...form, amount: (share.clubShareCents / 100).toFixed(2) });
                  details.setValue((d) => ({ ...d, items: [] }));
                }}
                disabled={isPending}
              >
                Type the amount instead
              </Button>
            )}
          </div>
        ) : (
          <Input
            label="Amount $"
            type="number"
            step="0.01"
            min="0"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            placeholder="e.g. 84.00"
            disabled={isPending || Boolean(settledNote)}
          />
        )}
        {quantityLabel && (
          <Input
            label={quantityLabel}
            type="number"
            step="1"
            min="1"
            value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
            placeholder="e.g. 6"
          />
        )}
        {payerOptions && (
          <>
            <Select
              label="Paid by"
              options={[
                // The empty option is what makes "not chosen" a state rather
                // than an accident of ordering. It stays in the list after a
                // choice is made so the field can be put back to unanswered.
                { value: '', label: 'Select who paid…' },
                { value: CLUB_FUNDS, label: 'Club funds — nobody to reimburse' },
                ...payerOptions.map((p) => ({ value: p.id, label: `${p.full_name} (out of pocket)` })),
              ]}
              value={form.paidBy}
              onChange={(e) => setForm({ ...form, paidBy: e.target.value })}
              disabled={isPending || Boolean(settledNote)}
            />
            <p className="text-xs text-[var(--text-muted)] -mt-2">
              Pick the person who actually paid, not whoever is typing this in. An admin can mark it
              reimbursed once the club has paid them back.
            </p>
          </>
        )}
        {details && (
          <ExpenseDetailsFields
            value={details.value}
            setValue={details.setValue}
            disabled={isPending || Boolean(details.disabled)}
            onRead={fillFromReadout}
          />
        )}
        <DatePicker
          label="Date (optional — defaults to today)"
          value={form.day}
          onChange={(day) => setForm({ ...form, day })}
          disabled={isPending}
        />
        <PaymentMethodFields value={payment} onChange={setPayment} disabled={isPending} />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {/* `loading` also disables the button, which is the only thing
              stopping a double-click filing the same spend twice: unlike a
              season fee, two identical expenses on the same day are legitimate,
              so the database has no uniqueness constraint to catch it. */}
          <Button onClick={onSubmit} loading={isPending} disabled={invalid} className="flex-1">
            {submitLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function AddOtherIncome({ seasonId, seasonName }: { seasonId: string; seasonName: string }) {
  const DEFAULT_CATEGORY: OtherIncomeCategory = 'donation';
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EntryFormState>(emptyForm(DEFAULT_CATEGORY));
  const [payment, setPayment] = useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleAdd() {
    const cents = toCents(form.amount);
    if (cents === null) return;
    startTransition(async () => {
      try {
        await addOtherIncome({
          season_id: seasonId,
          category: form.category as OtherIncomeCategory,
          description: form.description.trim(),
          amount_cents: cents,
          paid_at: dateToIso(form.day),
          method: resolvePaymentMethod(payment.method, payment.customMethod),
          reference: payment.reference.trim() || undefined,
        });
        toast('Income recorded', 'success');
        setOpen(false);
        setForm(emptyForm(DEFAULT_CATEGORY));
        setPayment(EMPTY_PAYMENT_METHOD);
        router.refresh();
      } catch (err) {
        toast(errorToastText(err, 'FEE', 'Failed to record income'), 'error');
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Add income</Button>
      <EntryDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add other income"
        intro={
          <>
            Money in that is not a club, tournament or reinstatement fee — counts toward{' '}
            <strong className="text-[var(--text-primary)]">{seasonName}</strong>.
          </>
        }
        categories={OTHER_INCOME_CATEGORIES}
        form={form}
        setForm={setForm}
        payment={payment}
        setPayment={setPayment}
        onSubmit={handleAdd}
        isPending={isPending}
        submitLabel="Add income"
      />
    </>
  );
}

/**
 * Record money out. The one dialog on this page an EXEC can open — the club
 * owner asked for "execs can add expenses too", so an exec who buys shuttles
 * out of their own pocket can say so and be reimbursed.
 */
export function AddExpense({
  seasonId,
  seasonName,
  payerOptions,
}: {
  seasonId: string;
  seasonName: string;
  /** Execs and admins — the people who can be out of pocket for the club. */
  payerOptions: { id: string; full_name: string }[];
}) {
  const DEFAULT_CATEGORY: ExpenseCategory = 'shuttles';
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EntryFormState>(emptyForm(DEFAULT_CATEGORY));
  const [payment, setPayment] = useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  // Held here rather than in EntryFormState, which the income dialog shares.
  const [details, setDetails] = useState<ExpenseDetailsState>(EMPTY_DETAILS);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleAdd() {
    // With items the server works the share out again and stores its own.
    const share = detailsShare(details);
    const cents = share ? share.clubShareCents : toCents(form.amount);
    if (cents === null) return;
    const qty = form.quantity.trim() === '' ? undefined : Number.parseInt(form.quantity, 10);
    startTransition(async () => {
      try {
        // The receipt files were uploaded when they were picked, and a failed
        // upload was never added to the list, so every path sent here exists.
        await addExpense({
          season_id: seasonId,
          category: form.category as ExpenseCategory,
          description: form.description.trim(),
          amount_cents: cents,
          quantity: Number.isFinite(qty) ? qty : undefined,
          // CLUB_FUNDS becomes undefined, which the action stores as NULL —
          // "the club paid, nobody is owed". Any other value is a player id.
          paid_by: form.paidBy === CLUB_FUNDS ? undefined : form.paidBy,
          paid_at: dateToIso(form.day),
          method: resolvePaymentMethod(payment.method, payment.customMethod),
          reference: payment.reference.trim() || undefined,
          ...detailsPayload(details),
        });
        toast('Expense recorded', 'success');
        setOpen(false);
        setForm(emptyForm(DEFAULT_CATEGORY));
        setPayment(EMPTY_PAYMENT_METHOD);
        setDetails(EMPTY_DETAILS);
        router.refresh();
      } catch (err) {
        toast(errorToastText(err, 'FEE', 'Failed to record expense'), 'error');
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Add expense</Button>
      <EntryDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add expense"
        intro={
          <>
            Money out — shuttles, court rental, equipment, food. Counts against{' '}
            <strong className="text-[var(--text-primary)]">{seasonName}</strong>.
          </>
        }
        categories={EXPENSE_CATEGORIES}
        form={form}
        setForm={setForm}
        payment={payment}
        setPayment={setPayment}
        quantityLabel="Quantity (optional — e.g. tubes)"
        payerOptions={payerOptions}
        details={{ value: details, setValue: setDetails }}
        onSubmit={handleAdd}
        isPending={isPending}
        submitLabel="Add expense"
      />
    </>
  );
}

/** The stored row, as much of it as the edit dialog needs to prefill itself. */
export interface EditableExpense {
  id: string;
  ref: string;
  category: string;
  description: string;
  amount_cents: number;
  quantity: number | null;
  paid_at: string | null;
  paid_by: string | null;
  reimbursed_at: string | null;
  method: string | null;
  reference: string | null;
  /**
   * The stored receipt files, items and tax lines (00231, 00313), with the
   * store and the printed total. Present on the interface so the dialog can
   * RESEND them: the save replaces them wholesale, so anything the dialog
   * forgets is something the save erases. Exactly the trap paymentFromStored
   * exists to avoid one column over.
   */
  details: StoredExpenseDetails;
}

/**
 * Correct an expense that is already recorded. ADMIN ONLY — rendered only for
 * an admin, and updateExpense() re-checks, which is the actual boundary.
 *
 * The form is remounted from the stored row every time the dialog opens
 * (`key={...}` at the call site is not enough on its own, so the state is seeded
 * on open). Otherwise an admin who opened a row, changed a figure, cancelled,
 * and opened a different row would be shown the first row's numbers over the
 * second row's data — and would be one click from saving them.
 */
export function EditExpense({
  expense,
  payerOptions,
}: {
  expense: EditableExpense;
  payerOptions: { id: string; full_name: string }[];
}) {
  const seed = (): EntryFormState => ({
    description: expense.description,
    amount: (expense.amount_cents / 100).toFixed(2),
    category: expense.category,
    day: isoToDay(expense.paid_at),
    quantity: expense.quantity == null ? '' : String(expense.quantity),
    paidBy: expense.paid_by ?? CLUB_FUNDS,
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EntryFormState>(seed);
  const [payment, setPayment] = useState<PaymentMethodState>(() =>
    paymentFromStored(expense.method, expense.reference),
  );
  // Seeded from the stored row so an edit that never touches the receipt
  // still resends it.
  const [details, setDetails] = useState<ExpenseDetailsState>(() => detailsFromStored(expense.details));
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  const settled = Boolean(expense.reimbursed_at);

  function handleOpen() {
    setForm(seed());
    setPayment(paymentFromStored(expense.method, expense.reference));
    // Re-seeded with the rest of the form, for the reason in this component's
    // doc comment: an admin who opened one row, changed something, cancelled and
    // opened another must not be shown the first row's receipt over the second
    // row's data.
    setDetails(detailsFromStored(expense.details));
    setOpen(true);
  }

  function handleSave() {
    const share = detailsShare(details);
    const cents = share ? share.clubShareCents : toCents(form.amount);
    if (cents === null) return;
    const qty = form.quantity.trim() === '' ? undefined : Number.parseInt(form.quantity, 10);
    startTransition(async () => {
      try {
        // A new file was uploaded as a NEW object when picked rather than
        // overwriting an old one: the old path may still be named by an audit
        // row, and overwriting would rewrite history that another row points at.
        await updateExpense({
          id: expense.id,
          category: form.category as ExpenseCategory,
          description: form.description.trim(),
          // Sent from the (disabled) field on a settled row, so it is always
          // the stored value and the action's equality check passes. If it ever
          // is not, the action refuses — which is the point of checking there.
          amount_cents: cents,
          quantity: Number.isFinite(qty) ? qty : undefined,
          paid_by: form.paidBy === CLUB_FUNDS ? undefined : form.paidBy,
          paid_at: dateToIso(form.day),
          method: resolvePaymentMethod(payment.method, payment.customMethod),
          reference: payment.reference.trim() || undefined,
          // ALWAYS RESENT, never omitted. The save replaces them wholesale, so
          // an omission here would drop the receipt on every save of an
          // unrelated field: silently, on a row somebody may be owed money against.
          ...detailsPayload(details),
        });
        toast(`${expense.ref} updated`, 'success');
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast(errorToastText(err, 'FEE', 'Failed to update expense'), 'error');
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={handleOpen}>Edit</Button>
      <EntryDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Edit ${expense.ref}`}
        intro="Correct what was recorded. The season this counts toward cannot be changed here — file it against a different season by deleting this entry and re-recording it."
        categories={EXPENSE_CATEGORIES}
        form={form}
        setForm={setForm}
        payment={payment}
        setPayment={setPayment}
        quantityLabel="Quantity (optional — e.g. tubes)"
        payerOptions={payerOptions}
        details={{
          value: details,
          setValue: setDetails,
          // Frozen once settled, like the amount and the payer, and explained by
          // the settledNote below rather than left as mysterious greying.
          disabled: settled,
        }}
        settledNote={
          settled
            ? 'The club has already reimbursed this expense, so the amount, the payer, the receipts and items are what was settled and cannot be changed. If the reimbursement itself was wrong, delete this entry and re-record it.'
            : undefined
        }
        onSubmit={handleSave}
        isPending={isPending}
        submitLabel="Save changes"
      />
    </>
  );
}

/**
 * Confirm the club has paid back whoever fronted an expense. ADMIN ONLY —
 * rendered only for an admin, and markExpenseReimbursed() re-checks, which is
 * the actual boundary.
 *
 * Confirmed rather than one-click, and the confirm names the person and the
 * amount: there is no undo. Marking the wrong row settled tells an exec who is
 * still owed $84 that they have been paid, and the only way back is an admin
 * deleting the row and re-entering it.
 *
 * No "un-reimburse" button, deliberately. An undo would be a second way to
 * change money state and the first thing a mis-click would reach for; a wrong
 * settlement is rare, visible in the audit log, and fixable by an admin.
 */
export function MarkReimbursed({
  id,
  payerId,
  payerName,
  amountCents,
}: {
  id: string;
  /**
   * Sent back with the confirmation, together with the amount. The action
   * settles ONLY a row that still matches both, so the click approves the
   * figures this button was rendered with and not whatever the row says by the
   * time the write lands.
   */
  payerId: string;
  payerName: string;
  amountCents: number;
}) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  async function handleMark() {
    const money = `$${(amountCents / 100).toFixed(2)}`;
    const ok = await confirm({
      title: 'Mark as reimbursed?',
      message: `Confirm the club has paid ${payerName} back the ${money} they spent. This cannot be undone.`,
      confirmLabel: 'Mark reimbursed',
    });
    if (!ok) return;
    startTransition(async () => {
      try {
        await markExpenseReimbursed(id, { amountCents, paidBy: payerId });
        toast(`Marked as reimbursed to ${payerName}`, 'success');
        router.refresh();
      } catch (err) {
        // The action throws rather than returning silently when its update
        // matched no rows — PostgREST calls that success, so the message here
        // is the only thing standing between an admin and a "done" toast for a
        // reimbursement that never happened.
        toast(errorToastText(err, 'FEE', 'Failed to mark reimbursed'), 'error');
      }
    });
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleMark} loading={isPending}>
      Mark reimbursed
    </Button>
  );
}

/**
 * Delete a row from either ledger.
 *
 * Confirmed, unlike RemoveManualFee: these rows are typed by hand and there is
 * no second copy of the number anywhere. The confirm names the amount so a
 * mis-click on the wrong row is visible before it happens.
 */
export function RemoveLedgerEntry({
  id,
  kind,
  label,
  amountCents,
}: {
  id: string;
  kind: 'income' | 'expense';
  label: string;
  amountCents: number;
}) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  async function handleRemove() {
    const money = `$${(amountCents / 100).toFixed(2)}`;
    const ok = await confirm({
      title: kind === 'income' ? 'Delete income entry?' : 'Delete expense?',
      message: `Delete "${label}" (${money})? This removes it from the season total.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    startTransition(async () => {
      try {
        if (kind === 'income') await removeOtherIncome(id);
        else await removeExpense(id);
        toast('Deleted', 'success');
        router.refresh();
      } catch (err) {
        toast(errorToastText(err, 'FEE', 'Failed to delete'), 'error');
      }
    });
  }

  return (
    <Button variant="danger" size="sm" onClick={handleRemove} loading={isPending}>
      Delete
    </Button>
  );
}
