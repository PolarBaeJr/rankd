import { createAdminClient } from '@/lib/supabase-server';
import { Badge, Card, EmptyState, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import {
  unwrap,
  formatPaymentMethod,
  formatExpenseCategory,
  formatOtherIncomeCategory,
  formatExpenseRef,
  formatOtherIncomeRef,
  selectInChunks,
} from '@badminton/shared';
import {
  AddOtherIncome,
  AddExpense,
  EditExpense,
  RemoveLedgerEntry,
  MarkReimbursed,
} from './finance-actions';
import { CardHeading } from './card-heading';
import { LedgerCharts } from './ledger-charts';
import { withBase } from '@/lib/base-path';

/**
 * The row list for one of the two non-fee ledgers (00073).
 *
 * IT SHOWS A TOTAL NOW, AND THE RULE THAT FORBADE ONE IS INTACT. This card used
 * to refuse a subtotal outright: a card that summed its own rows would be a
 * second implementation of the same total sitting inches from the first, and
 * the two would disagree the moment one of them changed — which is exactly how
 * the income headline came to read $0.00 while money sat in the database.
 *
 * What that rule actually forbids is a second piece of ARITHMETIC, and
 * LedgerCharts below is not one: it folds these rows through the same
 * `summariseExpenseRows` / `foldLedgerRows` the season figures come out of, so
 * the number at the head of this card is the same number by construction rather
 * than by two people remembering one rule. The refusal was also costing a real
 * reader — the net-position strip is behind `fees.netposition.read`, which an
 * exec does not hold, so the person who files the club's expenses was shown
 * every row of this ledger and no total anywhere on the page.
 *
 * The list still answers "what is in here" and the charts answer "how much, and
 * when". Neither asks the database for anything: the rows are already here.
 *
 * A row with no paid_at is excluded from those totals, so it is badged "Not
 * recorded" here rather than looking identical to a counted row. A filtered-out
 * row that looks the same as a counted one is a row nobody knows is missing.
 *
 * REIMBURSEMENT STATE (00077) IS SHOWN TO EVERYONE WHO CAN SEE THE ROW,
 * including execs — that is the whole point of the feature for them: an exec
 * who bought shuttles out of pocket comes here to find out whether the club has
 * paid them back. Seeing the state and changing it are separate capabilities.
 */

type LedgerKind = 'income' | 'expense';

/**
 * Which controls to offer, one flag per action, decided by the PAGE.
 *
 * This replaced a single `isAdmin`. That flag was an accurate description of
 * the boundary while it was "execs file expenses, admins do everything else",
 * and it stopped being one the moment the club could hand somebody
 * fees.expenses.reimburse.write without making them an admin. Four booleans
 * rather than a level, because there are four actions and they are separately
 * grantable.
 *
 * Still only which controls are OFFERED. Every action re-gates itself, since
 * the client that runs them is service-role and bypasses RLS.
 */
export type LedgerWrites = {
  add: boolean;
  /** Expenses only — an income row has no payer and nothing to edit in place. */
  update: boolean;
  /** Expenses only. */
  reimburse: boolean;
  remove: boolean;
};

interface LedgerRow {
  id: string;
  /** Database-assigned counter behind EXP-0001 / INC-0001 (00077). */
  ref_no: number | null;
  category: string | null;
  description: string;
  amount_cents: number;
  quantity?: number | null;
  paid_at: string | null;
  paid_by?: string | null;
  reimbursed_at?: string | null;
  reimbursed_by?: string | null;
  method: string | null;
  reference: string | null;
  /** Object path of the receipt photo in the private bucket (00231). */
  receipt_path?: string | null;
  created_at: string;
}

const INCOME_COLS = 'id, ref_no, category, description, amount_cents, paid_at, method, reference, created_at';
// receipt_path CANNOT BE DEPLOYED BEFORE 00231 IS APPLIED. PostgREST refuses a
// select naming an unknown column and this console reads a refused read as an
// empty list, so the whole expense ledger would render EMPTY, on a money page,
// with nothing in any log. The full note is in lib/actions/finance.ts's header.
const EXPENSE_COLS = `${INCOME_COLS}, quantity, paid_by, reimbursed_at, reimbursed_by, receipt_path`;

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * A plain <a> dressed as a ghost Button, because it has to be an anchor.
 *
 * Button renders a bare <button> with no href form, and this file is a SERVER
 * component: reaching for a client component to hold one link would ship a
 * bundle to every viewer of the ledger for something a link already does. The
 * classes are Button's ghost + sm, transcribed, so the control sits level with
 * the Edit and Delete beside it.
 */
const RECEIPT_LINK_CLASS =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-[var(--line)] bg-transparent px-3 min-h-[32px] text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--ink-2)] transition-all duration-150 hover:bg-[var(--surface-2)] hover:text-[var(--ink)]';

/** Local date only — the time of day a shuttle order was paid is noise. */
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '-';

export async function LedgerCard({
  kind,
  seasonId,
  seasonName,
  canRead,
  canWrite,
}: {
  kind: LedgerKind;
  seasonId: string;
  seasonName: string;
  /**
   * May the viewer see the ROWS? False is a real state, not an empty ledger:
   * somebody handed the add capability and not the read comes here to file an
   * expense and has no business reading what the club has spent. The query is
   * skipped rather than the table hidden — a row that reaches this component
   * reaches the RSC payload whether or not it is drawn.
   */
  canRead: boolean;
  /** Passed in rather than re-derived, so the page is the one place deciding. */
  canWrite: LedgerWrites;
}) {
  const supabase = createAdminClient();
  const isIncome = kind === 'income';
  // ONE TABLE SINCE 00159, and `direction` is what used to be the table name.
  // This component is rendered twice on /finances, once per ledger, under two
  // SEPARATE capabilities, so the filter is the only thing that still stops the
  // income section drawing the club's spending. It is not derived from `kind` at
  // the query site by accident: `kind` decides the columns, the heading, the
  // actions and now the rows, so all four move together or none do.
  const direction = isIncome ? 'income' : 'expense';

  // season_id is NOT NULL on the ledger (00073, carried into 00159), so unlike
  // the reinstatement card there is no "attached to no season" bucket to sweep
  // up: every row belongs to exactly one season and this query cannot miss one.
  const rows = canRead
    ? (unwrap(
        await supabase
          .from('club_ledger')
          .select(isIncome ? INCOME_COLS : EXPENSE_COLS)
          .eq('season_id', seasonId)
          .eq('direction', direction)
          .order('paid_at', { ascending: false, nullsFirst: true })
          .order('created_at', { ascending: false }),
        'FEE-101',
      ) as unknown as LedgerRow[])
    : [];

  // Names for the payer / confirmer ids, in ONE lookup.
  //
  // Not a PostgREST embed: club_ledger has three foreign keys to players
  // (marked_by, paid_by, reimbursed_by), and an embed across an ambiguous
  // relationship fails outright with "more than one relationship was found"
  // unless every one is disambiguated by constraint name. A plain `.in()` on
  // the ids the rows actually carry is shorter, cannot break when a fourth FK
  // is added, and fetches at most a handful of rows.
  const peopleIds = isIncome
    ? []
    : [...new Set(rows.flatMap((r) => [r.paid_by, r.reimbursed_by]).filter((v): v is string => !!v))];
  const nameById = new Map<string, string>();
  if (peopleIds.length > 0) {
    // Chunked: one id per distinct payer/reimbursee across the whole ledger.
    const people = unwrap(
      await selectInChunks(peopleIds, (ids) =>
        supabase.from('players').select('id, full_name').in('id', ids) as never,
      ),
      'FEE-101',
    ) as unknown as { id: string; full_name: string }[];
    for (const p of people) nameById.set(p.id, p.full_name);
  }
  // Falls back to "someone" rather than to an empty string: a row reading
  // "Reimbursed" with no name looks settled to nobody, and a deleted player is
  // exactly when this matters.
  const nameOf = (id: string | null | undefined) => (id ? nameById.get(id) ?? 'someone' : null);

  // Who may be named as having fronted an expense: the people who can be in a
  // shop buying shuttles for the club. Execs and admins first — the same set the
  // console admits — because they are the ones with a way to be reimbursed
  // through this page. NOT fetched for the income ledger, which has no payer.
  //
  // The fallback is not defensive padding. A brand-new club, or a season set up
  // before anyone is flagged exec, has NO row matching the filter, and a "Paid
  // by" list holding nothing but "Club funds" makes the out-of-pocket case
  // unrecordable — the person who actually bought the shuttles cannot be named
  // at all. When nobody matches, offer the members instead so the expense can
  // still be entered truthfully; the flags can be fixed afterwards.
  //
  // FETCHED ONLY FOR SOMEBODY WHO IS OFFERED A CONTROL THAT USES IT. This list
  // exists to fill the "Paid by" picker in the Add and Edit dialogs and is read
  // nowhere else, so a viewer holding the expense READ and neither write was
  // being handed the club's whole exec roster — names and ids — in the RSC
  // payload behind a picker they are never shown. Same rule as every other
  // query on this page: the guard goes on the fetch, not on the JSX.
  const payerOptions = isIncome || !(canWrite.add || canWrite.update)
    ? []
    : await (async () => {
        const execs = unwrap(
          await supabase
            .from('players')
            .select('id, full_name')
            .or('role.eq.admin,is_exec.eq.true')
            .order('full_name'),
          'FEE-101',
        ) as unknown as { id: string; full_name: string }[];
        if (execs.length > 0) return execs;
        return unwrap(
          await supabase
            .from('players')
            .select('id, full_name')
            .eq('is_banned', false)
            .order('full_name'),
          'FEE-101',
        ) as unknown as { id: string; full_name: string }[];
      })();

  const formatCategory = isIncome ? formatOtherIncomeCategory : formatExpenseCategory;
  // EXP-0001 / INC-0001. Formatting lives in @badminton/shared so the table, a
  // toast and the audit trail cannot spell the same row three ways.
  const formatRef = isIncome ? formatOtherIncomeRef : formatExpenseRef;

  /**
   * The three states of an expense's money, in words.
   *
   * "Club funds" is a real answer, not a missing one: paid_by IS NULL means the
   * club account paid directly and there is nobody to reimburse (00077's
   * club_ledger_reimbursement_needs_payer CHECK enforces that no such row can
   * ever be marked reimbursed). Showing it explicitly is what stops an exec
   * reading a blank as "they forgot about me".
   */
  const reimbursement = (row: LedgerRow) => {
    if (isIncome) return null;
    if (!row.paid_by) {
      return { variant: 'neutral' as const, label: 'Club funds', detail: null };
    }
    const payer = nameOf(row.paid_by);
    if (row.reimbursed_at) {
      return { variant: 'success' as const, label: `Reimbursed ${payer}`, detail: day(row.reimbursed_at) };
    }
    return { variant: 'warning' as const, label: `Owed to ${payer}`, detail: null };
  };

  const heading = isIncome ? 'Other income' : 'Expenses';
  const blurb = isIncome
    ? 'Donations, grants, socials and anything else that is money in but not a fee.'
    : 'Money out. Shuttles, court rental, equipment and food, for this season.';

  const subLine = (row: LedgerRow) => {
    const parts = [formatRef(row.ref_no), formatCategory(row.category), day(row.paid_at)];
    if (!isIncome && row.quantity != null) parts.push(`×${row.quantity}`);
    return parts.filter(Boolean).join(' · ');
  };

  /** The props EditExpense needs, straight off the row. Expenses only. */
  const editable = (row: LedgerRow) => ({
    id: row.id,
    ref: formatRef(row.ref_no),
    category: row.category ?? 'other',
    description: row.description,
    amount_cents: row.amount_cents,
    quantity: row.quantity ?? null,
    paid_at: row.paid_at,
    paid_by: row.paid_by ?? null,
    reimbursed_at: row.reimbursed_at ?? null,
    method: row.method,
    reference: row.reference,
    // Carried into the dialog so an edit RESENDS it. updateExpense's patch is a
    // full replacement, so a dialog that forgot this field would silently NULL
    // the receipt on every save of an unrelated one.
    receipt_path: row.receipt_path ?? null,
  });

  return (
    <Card padding={false}>
      <CardHeading
        title={heading}
        sub={blurb}
        action={
          canWrite.add
            ? isIncome
              ? <AddOtherIncome seasonId={seasonId} seasonName={seasonName} />
              : <AddExpense seasonId={seasonId} seasonName={seasonName} payerOptions={payerOptions} />
            : undefined
        }
      />

      {/* How much, and when — out of the rows already fetched above, so this
          adds no query. Nothing is rendered for a viewer who may not read the
          ledger because nothing was fetched for them: `rows` is empty, and the
          gate is the query, not this line. */}
      {canRead && <LedgerCharts kind={kind} seasonName={seasonName} rows={rows} />}

      {/* "You may not see this" and "there is nothing to see" are different
          statements, and telling somebody the ledger is empty when it is merely
          withheld is the kind of small lie a permission model should not tell. */}
      {!canRead ? (
        <EmptyState
          title={isIncome ? 'Other income is not shown to you' : 'Expenses are not shown to you'}
          description={
            canWrite.add
              ? `You can record ${isIncome ? 'income' : 'an expense'} for ${seasonName}, but not browse what has already been recorded.`
              : `Nothing on this ledger is shown to you.`
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title={isIncome ? 'No other income recorded' : 'No expenses recorded'}
          description={
            isIncome
              ? `Nothing beyond fees has been recorded for ${seasonName} yet.`
              : `Nothing has been recorded as spent in ${seasonName} yet.`
          }
        />
      ) : (
        <ResponsiveTable
          cards={rows.map((row) => {
            const reimb = reimbursement(row);
            return (
            <TableCard
              key={row.id}
              title={
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{row.description}</p>
                  <p className="text-xs font-normal text-[var(--text-muted)]">{subLine(row)}</p>
                </div>
              }
              // Atomic because TableCard sets [overflow-wrap:anywhere] on the
              // whole card, so an amount is free to break mid-token on a narrow
              // phone. Coloured to match the desktop cell: the card form is the
              // same row, and money in was green in one and neutral in the other.
              value={
                <Atomic className={isIncome ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}>
                  {isIncome ? '' : '-'}
                  {money(row.amount_cents)}
                </Atomic>
              }
              badges={
                <>
                  <Badge variant={row.paid_at ? 'success' : 'warning'}>
                    {row.paid_at ? 'Counted' : 'Not recorded'}
                  </Badge>
                  {reimb && <Badge variant={reimb.variant}>{reimb.label}</Badge>}
                </>
              }
              fields={[
                { label: 'Method', value: row.method ? formatPaymentMethod(row.method) : '-' },
                {
                  label: 'Reference',
                  value: row.reference ? <Atomic className="font-mono text-xs">{row.reference}</Atomic> : '-',
                },
                ...(reimb?.detail ? [{ label: 'Reimbursed', value: reimb.detail }] : []),
              ]}
              actions={
                <>
                  {/* Somebody who can only READ this ledger sees the state —
                      that is the point of the feature for them — and no control
                      that would reject them. */}
                  {/* Gated on canRead alone, not on any write flag: looking at
                      the receipt is reading the row, and the exec who is owed
                      the money is exactly who needs to check it. withBase
                      because Next does not prefix a raw string, and an
                      unprefixed /fees/... here is a LIVE ROUTE ON THE PLAYER
                      APP rather than a 404. */}
                  {!isIncome && row.receipt_path && (
                    <a
                      href={withBase(`/fees/receipt/${row.id}`)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={RECEIPT_LINK_CLASS}
                    >
                      Receipt
                    </a>
                  )}
                  {canWrite.update && !isIncome && (
                    <EditExpense expense={editable(row)} payerOptions={payerOptions} />
                  )}
                  {canWrite.reimburse && !isIncome && row.paid_by && !row.reimbursed_at && (
                    <MarkReimbursed
                      id={row.id}
                      payerId={row.paid_by}
                      payerName={nameOf(row.paid_by)!}
                      amountCents={row.amount_cents}
                    />
                  )}
                  {canWrite.remove && (
                    <RemoveLedgerEntry id={row.id} kind={kind} label={row.description} amountCents={row.amount_cents} />
                  )}
                </>
              }
            />
            );
          })}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                {/* The reference the club owner asked for: something a person
                    can read off a receipt and match to a row. First column
                    because that is how it will be used — scanned down, not
                    hunted for. */}
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Ref</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Entry</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Category</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Date</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Method</th>
                {/* Expenses only — the income ledger has no payer to pay back.
                    Header and cell are gated on the same flag so the column
                    counts cannot drift apart. */}
                {!isIncome && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Paid by</th>
                )}
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map((row) => {
                const reimb = reimbursement(row);
                return (
                <tr key={row.id} className="hover:bg-[var(--border-hover)] transition-colors">
                  <td className="px-4 py-3">
                    <Atomic className="font-mono text-xs text-[var(--text-muted)]">{formatRef(row.ref_no)}</Atomic>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{row.description}</p>
                    {!row.paid_at && (
                      <Badge variant="warning">Not recorded</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                    {formatCategory(row.category)}
                    {!isIncome && row.quantity != null && (
                      <span className="block text-xs text-[var(--text-muted)]">×{row.quantity}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">{day(row.paid_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {/* Atomic: the sign and the amount are one token. A row
                        reading "-" on one line and "$84.00" on the next is a
                        different number. */}
                    <Atomic
                      className={`font-mono ${isIncome ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}
                    >
                      {isIncome ? '' : '-'}
                      {money(row.amount_cents)}
                    </Atomic>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                    {row.method ? formatPaymentMethod(row.method) : '-'}
                    {row.reference && (
                      <span className="block font-mono text-xs text-[var(--text-muted)]">{row.reference}</span>
                    )}
                  </td>
                  {!isIncome && reimb && (
                    <td className="px-4 py-3 text-sm">
                      <Badge variant={reimb.variant}>{reimb.label}</Badge>
                      {reimb.detail && (
                        <span className="block text-xs text-[var(--text-muted)] mt-1">{reimb.detail}</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {/* See the card form above for why this is canRead-only
                          and why the href goes through withBase. */}
                      {!isIncome && row.receipt_path && (
                        <a
                          href={withBase(`/fees/receipt/${row.id}`)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={RECEIPT_LINK_CLASS}
                        >
                          Receipt
                        </a>
                      )}
                      {canWrite.update && !isIncome && (
                        <EditExpense expense={editable(row)} payerOptions={payerOptions} />
                      )}
                      {canWrite.reimburse && !isIncome && row.paid_by && !row.reimbursed_at && (
                        <MarkReimbursed
                          id={row.id}
                          payerId={row.paid_by}
                          payerName={nameOf(row.paid_by)!}
                          amountCents={row.amount_cents}
                        />
                      )}
                      {canWrite.remove && (
                        <RemoveLedgerEntry
                          id={row.id}
                          kind={kind}
                          label={row.description}
                          amountCents={row.amount_cents}
                        />
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </Card>
  );
}
