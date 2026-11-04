'use server';

import { revalidatePath } from 'next/cache';
import {
  isAdminRole,
  parseOrThrow,
  otherIncomeSchema,
  clubExpenseSchema,
  clubExpenseUpdateSchema,
  computeClubShare,
  type OtherIncomeInput,
  type ClubExpenseInput,
  type ClubExpenseUpdateInput,
  type ExpenseReceiptType,
} from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { requireCapability } from './_shared';

/**
 * The two non-fee money ledgers: other income (donations, grants, socials) and
 * club expenses (shuttles, court rental, ...). Tables land in 00073;
 * reimbursement state lands in 00077.
 *
 * WHO MAY DO WHAT, AND WHY IT IS ENFORCED HERE. createAdminClient() is
 * service-role and bypasses RLS entirely, so the gate at the top of each
 * function IS the boundary — the route map in permissions.ts is middleware and
 * decides only who may open the page. An ungated action would be an open write
 * endpoint no matter what that map says.
 *
 *   addExpense               exec or admin
 *   everything else here     admin only  (including updateExpense)
 *
 * addExpense is the one exception, and it is the club owner's: "allow execs to
 * add expenses too". An exec who buys shuttles out of their own pocket has to
 * be able to say so, or the club never learns the money went out and the exec
 * never gets paid back. That is bookkeeping. DELETING an expense is not — it
 * erases a spend from the season total with no second copy of the number
 * anywhere — so removeExpense keeps a capability no baseline below admin
 * holds, as do both halves of the income ledger, which is club money an exec
 * has no stake in.
 *
 * markExpenseReimbursed is admin-only for the plainest reason: it asserts the
 * club has paid someone. An exec confirming their own reimbursement is the
 * whole point of not letting them.
 *
 * EVERY MUTATION IS AUDITED, matching how the club_fees actions do it: the
 * inserted/deleted row is recorded in audit_logs with the acting admin. Money
 * moving with nobody's name on it is the thing an audit trail exists for.
 *
 * ROW COUNTS ARE CHECKED ON EVERY DELETE AND EVERY UPDATE. PostgREST reports
 * "matched no rows" as success — `error` is null and `data` is an empty array —
 * so a delete or update against an id that no longer exists returns exactly
 * what a successful one returns. Several bugs shipped by trusting an error that
 * never arrives. Every mutation below asks for the affected rows back with
 * .select() and refuses to report success unless exactly one came out.
 *
 * THE RECEIPT PHOTO (00231), in four sentences, because it touches three of the
 * functions below. It is OPTIONAL: a receipt can be lost or emailed, and the row
 * already asserts the payment on its own. The PATH IS RE-CHECKED AGAINST THE
 * UPLOADER in addExpense, because it is client-supplied and the client here is
 * service-role. It is FROZEN ONCE THE EXPENSE IS SETTLED, for the same reason
 * the amount and the payer are. And THE FILE NEVER PASSES THROUGH A SERVER
 * ACTION: the browser uploads it straight to storage and these actions see only
 * a path, which keeps a multi-megabyte body off the Node process that renders
 * every other page.
 *
 * SEVERAL FILES, ITEMS AND TAX LINES (00313). An expense now keeps every page of
 * its receipt in order, the item lines read off it and which of them were the
 * club's. They live in three child tables written only by the
 * save_club_expense_details RPC, which locks the ledger row and refuses a
 * settled one. On an expense with items, amount_cents is the CLUB'S SHARE,
 * recomputed here from the items and never taken from the client, and
 * receipt_total_cents is the total as printed. receipt_path is kept, mirrored
 * to the first file by the RPC, until a later migration drops it.
 *
 * AUDIT ROWS CARRY THE RECEIPT PATHS, THE VENDOR, THE PRINTED TOTAL, THE ITEM
 * COUNT AND THE CLUB'S SHARE, and never an item's description: the owner's rule,
 * so the audit log is not a second list of what anybody bought.
 *
 * ALL FOUR READS OF receipt_path NEED 00231 APPLIED FIRST, and every read of
 * vendor, receipt_total_cents and the child tables needs 00313 the same way. PostgREST refuses a
 * select naming a column it does not know, and this console reads a refused read
 * as an EMPTY RESULT. So with this code deployed against a database still at
 * 00230 the expense ledger renders empty and every Edit and every Delete below
 * reports "Expense not found", because `existing` comes back null. On a money
 * page, with nothing in any log saying why. The migration goes first.
 */

/** paid_at defaults to now: recording an entry means the money already moved. */
const paidAtOrNow = (given: string | undefined) => given ?? new Date().toISOString();

/** What an unticked item is stored as. See prepareDetails. */
const PERSONAL_ITEM = 'Personal item';

const RECEIPT_TYPE_BY_EXTENSION: Record<string, ExpenseReceiptType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
};

const receiptTypeOf = (path: string): ExpenseReceiptType | null =>
  RECEIPT_TYPE_BY_EXTENSION[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;

/** The receipt files, items and tax lines as save_club_expense_details takes them. */
interface ExpenseDetails {
  amountCents: number;
  vendor: string | null;
  receiptTotalCents: number | null;
  receipts: { position: number; path: string; content_type: string }[];
  items: {
    position: number;
    description: string;
    quantity: number | null;
    unit_price_cents: number | null;
    line_total_cents: number;
    discount_cents: number;
    tax_code: string | null;
    tax_code_source: string;
    is_club: boolean;
  }[];
  taxLines: { position: number; label: string; rate_ppm: number | null; printed_cents: number | null; codes: string[] }[];
}

const RECEIPT_COLS = 'ledger_id, position, path, content_type';
const ITEM_COLS =
  'ledger_id, position, description, quantity, unit_price_cents, line_total_cents, discount_cents, tax_code, tax_code_source, is_club';
const TAX_LINE_COLS = 'ledger_id, position, label, rate_ppm, printed_cents, codes';

/**
 * Check, order and price what the client sent, before anything is written.
 *
 * EVERY PATH IS CLIENT-SUPPLIED, so each is checked rather than trusted, for
 * the reason addExpense's header gives: the routes that open a file sign or
 * download it with the service role, so a path naming another member's folder
 * would be a read primitive for the whole bucket. A path must sit in the
 * uploader's own folder, or already be stored on THIS row (an admin editing an
 * exec's expense keeps the exec's files). It may not climb out with "..", must
 * not repeat, and its declared type must agree with its extension, because the
 * routes decide how to answer by the extension.
 *
 * POSITIONS COME FROM ARRAY ORDER, never from the client.
 *
 * THE AMOUNT IS RECOMPUTED HERE when there are items: the ticked items plus each
 * one's tax by its own code (computeClubShare). The client's figure is ignored,
 * because it is the figure an admin later reimburses.
 *
 * AN UNTICKED ITEM IS STORED AS "Personal item", with its amounts and tax code
 * kept so the share still adds up. The owner's rule: what an exec bought for
 * themselves on the same receipt is not the club's business, and every holder
 * of fees.expenses.read would otherwise read it. It is enforced HERE rather
 * than only in the dialog, so a caller that sends the real description cannot
 * get it stored. The photo is still there for anyone checking the receipt.
 */
function prepareDetails(
  actorUserId: string,
  parsed: ClubExpenseInput | ClubExpenseUpdateInput,
  storedPaths: ReadonlySet<string> = new Set(),
): ExpenseDetails {
  const refuse = () => {
    throw new Error('That receipt could not be attached');
  };

  // A dialog still open from before 00313 sends a single receipt_path.
  const files =
    parsed.receipts ??
    (parsed.receipt_path ? [{ path: parsed.receipt_path, content_type: receiptTypeOf(parsed.receipt_path) ?? refuse() }] : []);

  const seen = new Set<string>();
  const receipts = files.map((file, i) => {
    if (file.path.includes('..') || seen.has(file.path)) refuse();
    if (!file.path.startsWith(`${actorUserId}/`) && !storedPaths.has(file.path)) refuse();
    if (receiptTypeOf(file.path) !== file.content_type) refuse();
    seen.add(file.path);
    return { position: i + 1, path: file.path, content_type: file.content_type };
  });

  const items = (parsed.items ?? []).map((item, i) => ({
    position: i + 1,
    description: item.is_club ? item.description : PERSONAL_ITEM,
    quantity: item.quantity ?? null,
    unit_price_cents: item.unit_price_cents ?? null,
    line_total_cents: item.line_total_cents,
    discount_cents: item.discount_cents ?? 0,
    tax_code: item.tax_code ?? null,
    tax_code_source: item.tax_code_source ?? 'receipt',
    is_club: item.is_club,
  }));

  const taxLines = (parsed.tax_lines ?? []).map((line, i) => ({
    position: i + 1,
    label: line.label,
    rate_ppm: line.rate_ppm ?? null,
    printed_cents: line.printed_cents ?? null,
    codes: line.codes,
  }));

  let amountCents = parsed.amount_cents;
  if (items.length > 0) {
    amountCents = computeClubShare(
      items.map((it) => ({ netCents: it.line_total_cents + it.discount_cents, taxCode: it.tax_code, isClub: it.is_club })),
      taxLines.map((t) => ({ label: t.label, ratePpm: t.rate_ppm, printedCents: t.printed_cents, codes: t.codes })),
    ).clubShareCents;
    // Refund lines can push it below zero, which club_ledger's CHECK refuses
    // with a database error nobody could act on.
    if (amountCents < 0) {
      throw new Error("The club's share of this receipt comes to less than nothing. Check the items that are ticked.");
    }
  }

  return {
    amountCents,
    vendor: parsed.vendor ?? null,
    receiptTotalCents: parsed.receipt_total_cents ?? null,
    receipts,
    items,
    taxLines,
  };
}

const hasDetails = (d: ExpenseDetails) =>
  d.receipts.length > 0 || d.items.length > 0 || d.taxLines.length > 0 || d.vendor !== null || d.receiptTotalCents !== null;

/** The stored children of one expense, each in position order. */
async function readDetails(adminClient: ReturnType<typeof createAdminClient>, ledgerId: string) {
  const [receipts, items, taxLines] = await Promise.all([
    adminClient.from('club_expense_receipts').select(RECEIPT_COLS).in('ledger_id', [ledgerId]).order('position'),
    adminClient.from('club_expense_items').select(ITEM_COLS).in('ledger_id', [ledgerId]).order('position'),
    adminClient.from('club_expense_tax_lines').select(TAX_LINE_COLS).in('ledger_id', [ledgerId]).order('position'),
  ]);
  // A refused read comes back as an empty list. Here that would read as "this
  // expense has no receipt", and an edit of a settled row would then refuse
  // nothing, so a failed read stops the action instead.
  const failed = receipts.error ?? items.error ?? taxLines.error;
  if (failed) throw new Error(failed.message);
  return {
    receipts: (receipts.data ?? []) as unknown as ExpenseDetails['receipts'],
    items: (items.data ?? []) as unknown as ExpenseDetails['items'],
    taxLines: (taxLines.data ?? []) as unknown as ExpenseDetails['taxLines'],
  };
}

/** One comparable form of the children, so an untouched resend reads as no change. */
function detailsKey(d: Pick<ExpenseDetails, 'vendor' | 'receiptTotalCents' | 'receipts' | 'items' | 'taxLines'>) {
  return JSON.stringify([
    d.vendor ?? null,
    d.receiptTotalCents ?? null,
    d.receipts.map((r) => [Number(r.position), r.path, r.content_type]),
    d.items.map((it) => [
      Number(it.position),
      it.description,
      it.quantity == null ? null : Number(it.quantity),
      it.unit_price_cents ?? null,
      it.line_total_cents,
      it.discount_cents ?? 0,
      it.tax_code ?? null,
      it.tax_code_source ?? 'receipt',
      it.is_club,
    ]),
    d.taxLines.map((t) => [Number(t.position), t.label, t.rate_ppm ?? null, t.printed_cents ?? null, [...(t.codes ?? [])]]),
  ]);
}

/** What the audit log keeps of the children: never an item's description. */
function auditDetails(
  d: Pick<ExpenseDetails, 'vendor' | 'receiptTotalCents' | 'receipts' | 'items'>,
  amountCents: number,
) {
  return {
    receipts: d.receipts.map((r) => r.path),
    vendor: d.vendor ?? null,
    receipt_total_cents: d.receiptTotalCents ?? null,
    item_count: d.items.length,
    club_share_cents: d.items.length > 0 ? amountCents : null,
  };
}

/** The one writer of the children (00313). Answers 'ok', 'settled' or 'not_found'. */
async function saveDetails(adminClient: ReturnType<typeof createAdminClient>, ledgerId: string, d: ExpenseDetails) {
  const { data, error } = await adminClient.rpc('save_club_expense_details', {
    p_ledger_id: ledgerId,
    p_amount_cents: d.amountCents,
    p_vendor: d.vendor as string,
    p_receipt_total_cents: d.receiptTotalCents as number,
    p_receipts: d.receipts,
    p_items: d.items,
    p_tax_lines: d.taxLines,
  });
  if (error) return 'error';
  return data as string;
}

/**
 * A payer has to be someone who could plausibly have bought something for the
 * club — an exec or an admin.
 *
 * The dialog only offers those people, but the dialog is not the boundary: a
 * server action can be invoked directly with any payload, and `paid_by` is
 * validated by the schema only as "a uuid". Without this an exec could name any
 * member — including one who has no idea — as the person the club owes money
 * to, and the reimbursement flow would then hand that debt to an admin to
 * settle.
 *
 * Silent on a null payer, which is the "club funds" case and names nobody.
 */
async function assertEligiblePayer(
  adminClient: ReturnType<typeof createAdminClient>,
  paidBy: string | null,
) {
  if (!paidBy) return;
  const { data: payer } = await adminClient
    .from('players')
    .select('id, role, is_exec')
    .eq('id', paidBy)
    .maybeSingle();
  if (!payer) throw new Error('That payer is not a member of the club');
  if (!isAdminRole(payer.role) && !payer.is_exec) {
    throw new Error('Only an exec or an admin can be recorded as having paid for the club');
  }
}

export async function addOtherIncome(input: OtherIncomeInput) {
  const parsed = parseOrThrow(otherIncomeSchema, input);
  const admin = await requireCapability('fees.otherincome.add.write');
  const adminClient = createAdminClient();

  const row = {
    season_id: parsed.season_id,
    // 00159 merged this ledger with club_expenses. The column has NO DEFAULT,
    // so an insert that forgot it fails loudly rather than filing a donation as
    // a spend — which would subtract it from the season instead of adding it,
    // moving the club's net position by twice the amount.
    direction: 'income' as const,
    category: parsed.category,
    description: parsed.description,
    amount_cents: parsed.amount_cents,
    paid_at: paidAtOrNow(parsed.paid_at),
    marked_by: admin.id,
    method: parsed.method ?? null,
    reference: parsed.reference ?? null,
  };

  const { data: created, error } = await adminClient
    .from('club_ledger')
    .insert(row)
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    // The audit vocabulary is UNCHANGED by 00159, on purpose. There are
    // already rows on production carrying these strings, and audit-log-view.ts
    // matches on them; renaming the type to match the new table would orphan
    // the history it exists to preserve. The table moved, the record of what
    // happened did not.
    action_type: 'other_income_added',
    target_type: 'other_income',
    target_id: created.id,
    new_value: row,
  }, { seasonId: parsed.season_id });

  revalidatePath('/finances');
}

export async function removeOtherIncome(id: string) {
  const admin = await requireCapability('fees.otherincome.remove.write');
  const adminClient = createAdminClient();

  // Read first so the audit entry carries what was destroyed. Without it the
  // log records that an amount was deleted but not which one — there is a
  // fee_waived row on production with an empty old_value for exactly that
  // reason (see waiveFee).
  // `.eq('direction', 'income')` IS A SAFETY INTERLOCK, NOT A FILTER.
  // Since 00159 ids are unique across the WHOLE ledger, so an expense id passed
  // to this action would otherwise read — and below, DELETE — a row belonging to
  // the other book, under fees.otherincome.remove.write, which its holder may
  // not have. Before the merge the table name made that impossible. Now this
  // does. Every id-keyed statement in this file carries it.
  const { data: existing } = await adminClient
    .from('club_ledger')
    .select('id, season_id, category, description, amount_cents, paid_at, method, reference')
    .eq('id', id)
    .eq('direction', 'income')
    .maybeSingle();
  if (!existing) throw new Error('Income entry not found');

  // .select() so the deleted rows come back. Without it a delete matching
  // nothing is indistinguishable from a delete that worked.
  const { data: deleted, error } = await adminClient
    .from('club_ledger')
    .delete()
    .eq('id', id)
    .eq('direction', 'income')
    .select('id');
  if (error) throw new Error(error.message);
  if (!deleted || deleted.length !== 1) {
    throw new Error('Income entry was not deleted — it may have been removed already');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'other_income_removed',
    target_type: 'other_income',
    target_id: id,
    old_value: existing,
  }, { seasonId: existing.season_id });

  revalidatePath('/finances');
}

/**
 * Record money out. The ONE action in this file an exec may call — see the
 * module header.
 *
 * paid_by is taken from the input, never from the actor. The two are different
 * people whenever an admin writes up an exec's receipt, and defaulting it to
 * the actor would file the admin as the one owed the money. Absent means the
 * club account paid directly and nobody is owed; the dialog makes the caller
 * choose rather than letting either case be the silent default.
 */
export async function addExpense(input: ClubExpenseInput) {
  const parsed = parseOrThrow(clubExpenseSchema, input);
  const actor = await requireCapability('fees.expenses.add.write');
  const adminClient = createAdminClient();
  await assertEligiblePayer(adminClient, parsed.paid_by ?? null);

  // THE PATHS ARE CLIENT-SUPPLIED, so they are checked rather than trusted, in
  // prepareDetails, before anything is written. 00231's
  // storage policy already stopped them WRITING outside their own folder, but
  // nothing stopped them naming somebody else's folder in THIS call, and the
  // receipt route signs whatever path the row holds using createAdminClient(),
  // which is service-role and bypasses RLS. Without this check, filing a $0
  // expense whose receipt_path names another member's folder is a read primitive
  // for the entire bucket.
  //
  // IT KEYS ON THE UPLOADER AND NOT ON paid_by, and the difference is the whole
  // reason this line reads the way it does. The folder is named after the person
  // whose browser uploaded the file (auth.uid(), which is what storage RLS can
  // see), and that is routinely NOT the payer: 00077 documents the commonest
  // flow as an exec texting a receipt to an admin who records it, so the admin
  // uploads while the exec is owed the money. Validating the path against
  // `paid_by` would refuse exactly that flow, every time, and would let nothing
  // useful through in exchange.
  //
  // actor.user_id, not actor.id: requireCapability resolves its row by
  // .eq('user_id', user.id) with select('*') (supabase-server.ts:128-132), so
  // user_id IS the auth.uid() the folder is named after. players.id is a
  // different uuid and would match no folder anybody could ever upload into.
  const details = prepareDetails(actor.user_id, parsed);

  const row = {
    season_id: parsed.season_id,
    // See addOtherIncome. `direction` also gates the CHECK constraints: only an
    // expense row may carry paid_by, quantity or the reimbursement columns, so
    // a misfiled row is refused by the database rather than rendered with a
    // reimbursement badge on somebody's donation.
    direction: 'expense' as const,
    category: parsed.category,
    description: parsed.description,
    // The club's share when there are items; see prepareDetails.
    amount_cents: details.amountCents,
    quantity: parsed.quantity ?? null,
    paid_at: paidAtOrNow(parsed.paid_at),
    marked_by: actor.id,
    paid_by: parsed.paid_by ?? null,
    method: parsed.method ?? null,
    reference: parsed.reference ?? null,
  };

  const { data: created, error } = await adminClient
    .from('club_ledger')
    .insert(row)
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  // The files, items and tax lines go in through the RPC, after the row
  // exists. If that fails the row is taken back out, so a spend is never filed
  // with its receipt silently missing; the exec sees the error and saves again.
  if (hasDetails(details) && (await saveDetails(adminClient, created.id, details)) !== 'ok') {
    await adminClient.from('club_ledger').delete().eq('id', created.id).eq('direction', 'expense');
    throw new Error('The receipts could not be attached. Nothing was recorded.');
  }

  // The receipt paths ride along, so the log answers "which files were filed as
  // the evidence for this spend" even after the row itself is deleted.
  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'expense_added',
    target_type: 'club_expense',
    target_id: created.id,
    new_value: { ...row, ...auditDetails(details, details.amountCents) },
  }, { seasonId: parsed.season_id });

  revalidatePath('/finances');
}

/**
 * Correct an expense that has already been recorded. ADMIN ONLY.
 *
 * The club owner asked for this so a typo in a description or a fat-fingered
 * amount does not need a delete and a re-entry. Admin-only for the same reason
 * removeExpense is: an exec recording their own spend is bookkeeping, an exec
 * silently raising the figure afterwards is not.
 *
 * ONCE REIMBURSED, THE AMOUNT AND THE PAYER ARE FROZEN.
 * This is the one real decision in this function. A reimbursement was settled
 * against a specific figure paid to a specific person, and both of those are
 * now facts about money that has already changed hands twice — the exec paid
 * the shop, the club paid the exec. Editing either turns the row into a claim
 * that the club reimbursed an amount it did not reimburse, or reimbursed
 * somebody it did not pay. The badge on the row would assert it, and nobody
 * reads the audit log to check a badge. Everything that does NOT change what
 * was settled — description, category, quantity, date, method, reference —
 * stays editable, which covers the typo case the owner actually described.
 *
 * The two alternatives, and what each would have meant:
 *
 *   - CLEAR THE REIMBURSEMENT when the amount changes. Rejected: the club
 *     really did pay that money out, on a date, confirmed by a named admin, and
 *     an edit to a description-adjacent field would destroy all three. It also
 *     hides the interesting case — if the reimbursed amount was wrong, someone
 *     was underpaid or overpaid, and quietly resetting the row to "owed"
 *     obscures which.
 *   - ALLOW IT AND RECORD BOTH VALUES IN THE AUDIT ROW. Rejected as the only
 *     protection: the audit trail is reconstructible but the visible row is
 *     wrong, and the person harmed (the exec who was paid the old figure) reads
 *     the row, not audit_logs. Both values ARE recorded here regardless — that
 *     part of the option is kept for every edit, not used as a substitute for
 *     refusing this one.
 *
 * A settled expense whose amount is genuinely wrong therefore needs an admin to
 * delete it and re-record it. That is deliberate friction: it is a statement
 * that a reimbursement was paid incorrectly, which is a conversation with a
 * person, not a form field.
 */
export async function updateExpense(input: ClubExpenseUpdateInput) {
  const parsed = parseOrThrow(clubExpenseUpdateSchema, input);
  const admin = await requireCapability('fees.expenses.update.write');
  const adminClient = createAdminClient();

  const { data: existing } = await adminClient
    .from('club_ledger')
    .select('id, season_id, category, description, amount_cents, quantity, paid_at, paid_by, reimbursed_at, reimbursed_by, method, reference, receipt_path, vendor, receipt_total_cents')
    .eq('id', parsed.id)
    .eq('direction', 'expense')
    .maybeSingle();
  if (!existing) throw new Error('Expense not found');

  const stored = await readDetails(adminClient, parsed.id);
  // A receipt in receipt_path alone, with no club_expense_receipts row: written
  // by a console still on 00231's code after 00313 was applied (its backfill
  // only saw the rows already there). It is read as that row's one file, so an
  // admin may keep an exec's photo, a settled row compares equal, and the save
  // below moves it into the table rather than mirroring an empty list over it.
  if (stored.receipts.length === 0 && existing.receipt_path) {
    const type = receiptTypeOf(existing.receipt_path);
    if (type) stored.receipts = [{ position: 1, path: existing.receipt_path, content_type: type }];
  }
  const details = prepareDetails(admin.user_id, parsed, new Set(stored.receipts.map((r) => r.path)));

  // A FULL REPLACEMENT, exactly like addExpense: an omitted payer means "the
  // club paid, nobody is owed", not "leave it alone". The dialog always resends
  // the stored value, and on a settled row the equality check below refuses an
  // omission outright rather than quietly un-assigning the person the club has
  // already paid.
  const nextPaidBy = parsed.paid_by ?? null;
  const settled = Boolean(existing.reimbursed_at);
  if (settled && details.amountCents !== existing.amount_cents) {
    throw new Error(
      'This expense has already been reimbursed — its amount can no longer be changed. Delete it and re-record it if the reimbursement was wrong.',
    );
  }
  if (settled && nextPaidBy !== (existing.paid_by ?? null)) {
    throw new Error(
      'This expense has already been reimbursed — who paid it can no longer be changed.',
    );
  }
  // AND THE RECEIPT IS FROZEN WITH THEM (00231). The receipt is the evidence for
  // a payment that has already been asserted and then settled against, so
  // letting it change after the fact is letting somebody swap the proof: the row
  // would go on claiming the club reimbursed $84 for shuttles while the attached
  // picture became a receipt for something else entirely, and the badge on the
  // row asserts the settlement without anyone reading the audit log to check it.
  //
  // THE NULL-TO-PATH DIRECTION IS REFUSED TOO, and that is deliberate rather
  // than an oversight in the comparison. Attaching a receipt an exec finally
  // found to a reimbursement paid last month is a sympathetic case, and it is
  // still refused, because a settled row's evidence is frozen AS A WHOLE.
  // Allowing it would mean this guard has to tell "supplementing" from
  // "swapping", and the stored row cannot support that distinction: once one
  // direction is open, a receipt can be removed and re-added in two saves. As
  // with the amount, a settled expense whose evidence is genuinely wrong needs an
  // admin to delete it and re-record it, which is a statement that a
  // reimbursement was paid against the wrong proof.
  //
  // It belongs in the action and not in the validator for the same reason the
  // amount and payer checks do: the boundary depends on the STORED row, which a
  // validator cannot see.
  //
  // SINCE 00313 THE EVIDENCE IS EVERY FILE, IN ORDER, AND EVERY ITEM, TICK, TAX
  // CODE AND TAX LINE, plus the vendor and the printed total. All of it is
  // compared, after the incoming side has been through prepareDetails, so an
  // untouched resend compares equal and any change at all is refused.
  const storedDetails = {
    vendor: existing.vendor,
    receiptTotalCents: existing.receipt_total_cents,
    ...stored,
  };
  if (settled && detailsKey(details) !== detailsKey(storedDetails)) {
    throw new Error(
      'This expense has already been reimbursed. Its receipts and items can no longer be changed.',
    );
  }
  await assertEligiblePayer(adminClient, nextPaidBy);

  // THE CHILDREN FIRST, on a row that is not settled. The RPC takes the row
  // lock and re-checks reimbursed_at itself, so a reimbursement that landed
  // since the read above is refused here rather than overwritten. A settled
  // row never reaches it: everything it writes was compared equal above.
  if (!settled) {
    const saved = await saveDetails(adminClient, parsed.id, details);
    if (saved === 'not_found') throw new Error('Expense not found');
    if (saved === 'settled') {
      throw new Error('This expense was marked reimbursed while you were editing it. Reload and check it again.');
    }
    if (saved !== 'ok') throw new Error('The receipts could not be saved. Nothing was changed.');
  }

  const patch = {
    category: parsed.category,
    description: parsed.description,
    // With items the RPC has already set the club's share; without, the typed
    // figure is the amount, as it always was.
    ...(details.items.length > 0 ? {} : { amount_cents: details.amountCents }),
    quantity: parsed.quantity ?? null,
    // Keeps the stored date when the caller sends none, rather than stamping
    // today the way an INSERT does. An edit that silently re-dated a spend to
    // whenever the typo was noticed would move it in every date-ordered view
    // for no reason the admin asked for.
    paid_at: parsed.paid_at ?? existing.paid_at ?? new Date().toISOString(),
    paid_by: nextPaidBy,
    method: parsed.method ?? null,
    reference: parsed.reference ?? null,
    // receipt_path is NOT here any more (00313). The RPC above mirrors it to
    // the first file, and writing it again from the input would NULL it on
    // every save from a console that no longer sends it.
  };

  // The reimbursement state is re-checked BY THE DATABASE, not just by the read
  // above. Between that read and this write another admin can mark the row
  // reimbursed; without this filter the amount change would land on a settled
  // row anyway and the guard would have been decoration. When the row was
  // already settled the filter matches on its stored timestamp instead, so the
  // still-permitted edits (description, category, ...) go through.
  const query = adminClient
    .from('club_ledger')
    .update(patch)
    .eq('id', parsed.id)
    // Not redundant with the read above: the read proves the row WAS an
    // expense, this proves the row being written still is. Both are needed for
    // the same reason the reimbursed_at filter below is — a concurrent writer
    // between the two statements.
    .eq('direction', 'expense');
  const scoped = settled
    ? query.eq('reimbursed_at', existing.reimbursed_at)
    : query.is('reimbursed_at', null);

  const { data: updated, error } = await scoped.select('id');
  if (error) throw new Error(error.message);
  // PostgREST calls "matched no rows" a success. Without this an admin is
  // toasted "Saved" for an edit that never landed — on a money figure.
  if (!updated || updated.length !== 1) {
    throw new Error(
      settled
        ? 'Expense was not updated — someone else may have just changed it'
        : 'Only the receipts and items were saved. The rest of the expense was not updated, because someone else may have just changed it.',
    );
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'expense_updated',
    target_type: 'club_expense',
    target_id: parsed.id,
    // Both sides in full, so a changed amount is reconstructible from the log
    // alone without a second query against a row that may later be deleted.
    old_value: { ...existing, ...auditDetails(storedDetails, existing.amount_cents) },
    new_value: { ...patch, ...auditDetails(details, details.amountCents) },
  }, { seasonId: existing.season_id });

  revalidatePath('/finances');
}

/**
 * Confirm the club has paid back whoever fronted an expense. ADMIN ONLY.
 *
 * The amount it confirms is amount_cents, which on an expense with items is the
 * club's share of the receipt (00313), not the printed total: what the club
 * owes is the ticked items and their tax, and that is what the dialog shows.
 *
 * Changes NO money figure. The expense already counted against the season net
 * the moment it was recorded and it still does — see season-finance.ts for why.
 * This records that a debt to a person is settled, nothing more.
 *
 * Three guards, because three different wrong things can be reported as
 * success:
 *
 *  1. The row is read first. Without it, "already reimbursed", "row was
 *     deleted" and "the club paid for this, there is nobody to reimburse" all
 *     produce the same zero-row update and would all be reported identically.
 *     Each gets its own message here, so an admin who is told nothing happened
 *     knows which nothing it was.
 *
 *  2. The update filters on `reimbursed_at IS NULL`. That makes a double
 *     submit a no-op rather than silently rewriting the original settlement
 *     date to today — a month-old reimbursement quietly re-dated is a figure
 *     nobody would ever notice was wrong.
 *
 *  3. The affected rows are counted. PostgREST returns `error: null` and an
 *     empty array for an update that matched nothing, which is byte for byte
 *     what a successful update returns. Between the read and the write another
 *     admin can settle or delete the same row; without this check the second
 *     admin is toasted "Marked reimbursed" for a write that never happened, and
 *     an audit row is filed swearing it did.
 *
 * AND IT SETTLES ONLY WHAT THE ADMIN ACTUALLY CONFIRMED. The caller passes the
 * amount and the payer it displayed in the confirm dialog, and both are part of
 * the WHERE clause. Taking only the id would mean the click approves whatever
 * the row happens to say at the instant the write lands: another admin edits
 * "$84, Alice" to "$840, Bob" in between, and the first admin's "yes, pay Alice
 * back her $84" silently becomes "yes, pay Bob $840". Nothing on screen would
 * ever have shown that figure to the person who approved it.
 */
export async function markExpenseReimbursed(
  id: string,
  /** What the confirm dialog showed. The settlement is refused if the row has moved. */
  confirmed: { amountCents: number; paidBy: string },
) {
  const admin = await requireCapability('fees.expenses.reimburse.write');
  const adminClient = createAdminClient();

  const { data: existing } = await adminClient
    .from('club_ledger')
    .select('id, season_id, description, amount_cents, paid_by, reimbursed_at, reimbursed_by')
    .eq('id', id)
    .eq('direction', 'expense')
    .maybeSingle();
  if (!existing) throw new Error('Expense not found');
  if (!existing.paid_by) {
    throw new Error('This expense was paid from club funds — there is nobody to reimburse');
  }
  if (existing.reimbursed_at) throw new Error('This expense is already marked reimbursed');
  // Checked here for the readable message, and again in the WHERE clause below
  // for the race. This branch alone would be decoration.
  if (existing.amount_cents !== confirmed.amountCents || existing.paid_by !== confirmed.paidBy) {
    throw new Error('This expense changed while you were looking at it — reload and check it again');
  }

  const reimbursed_at = new Date().toISOString();

  const { data: updated, error } = await adminClient
    .from('club_ledger')
    .update({ reimbursed_at, reimbursed_by: admin.id })
    .eq('id', id)
    .eq('direction', 'expense')
    .is('reimbursed_at', null)
    .eq('amount_cents', confirmed.amountCents)
    .eq('paid_by', confirmed.paidBy)
    .select('id');
  if (error) throw new Error(error.message);
  if (!updated || updated.length !== 1) {
    throw new Error('Expense was not marked reimbursed — someone else may have just changed it');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'expense_reimbursed',
    target_type: 'club_expense',
    target_id: id,
    // Both sides, so the log answers "who was paid back, how much, and when"
    // without a join against a row that may later be deleted.
    old_value: existing,
    new_value: { reimbursed_at, reimbursed_by: admin.id, paid_by: existing.paid_by },
  }, { seasonId: existing.season_id });

  revalidatePath('/finances');
}

/**
 * ADMIN ONLY, deliberately not exec, even though an exec may add one. Recording
 * a spend adds a fact; deleting one erases money from the season total and
 * there is no second copy of the figure anywhere. It would also let an exec
 * remove an expense an admin had already reimbursed them for.
 */
export async function removeExpense(id: string) {
  const admin = await requireCapability('fees.expenses.remove.write');
  const adminClient = createAdminClient();

  const { data: existing } = await adminClient
    .from('club_ledger')
    // receipt_path included so the audit old_value names the file. THE STORAGE
    // OBJECT IS DELIBERATELY NOT DELETED with the row: the audit entry below
    // records the path as part of what was destroyed, and destroying the very
    // evidence the deletion was audited against is worse than leaving an orphan
    // in a private bucket nothing links to. An orphaned object costs a few
    // kilobytes; an audit row pointing at a file that no longer exists costs the
    // only way to check what was deleted and why.
    .select('id, season_id, category, description, amount_cents, quantity, paid_at, paid_by, reimbursed_at, reimbursed_by, method, reference, receipt_path, vendor, receipt_total_cents')
    .eq('id', id)
    .eq('direction', 'expense')
    .maybeSingle();
  if (!existing) throw new Error('Expense not found');
  // Read before the delete, which cascades to them, so the audit names every
  // file. The same reasoning as receipt_path above: no file is deleted.
  const stored = await readDetails(adminClient, id);

  const { data: deleted, error } = await adminClient
    .from('club_ledger')
    .delete()
    .eq('id', id)
    .eq('direction', 'expense')
    .select('id');
  if (error) throw new Error(error.message);
  if (!deleted || deleted.length !== 1) {
    throw new Error('Expense was not deleted — it may have been removed already');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'expense_removed',
    target_type: 'club_expense',
    target_id: id,
    old_value: {
      ...existing,
      ...auditDetails({ vendor: existing.vendor, receiptTotalCents: existing.receipt_total_cents, ...stored }, existing.amount_cents),
    },
  }, { seasonId: existing.season_id });

  revalidatePath('/finances');
}
