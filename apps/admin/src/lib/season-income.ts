import type { SupabaseClient } from '@supabase/supabase-js';
import { isCollectedBySfuRec, unwrap, type FeeType } from '@badminton/shared';

/**
 * Money the club actually took in during a season.
 *
 * ONE FEE TABLE NOW, THREE KINDS OF ROW IN IT (00094). This function used to
 * read club_fees, tournament_fees and reinstatement_fees and add them up; the
 * first two are the same table since the collapse, and the arithmetic that
 * matters is that EACH PAYMENT IS COUNTED EXACTLY ONCE. A version of this file
 * that kept the old tournament_fees branch alongside a club_fees sum would
 * double every entry fee in the club's income — which is the specific hazard
 * the collapse creates and the reason season-income.test.ts makes any read of
 * the retired tables throw.
 *
 *   club_fees    season_id directly, split by fee_type
 *   club_ledger  season_id directly, NOT NULL, split by direction (00159)
 *
 * SEASON IS A COLUMN, NEVER A JOIN AND NEVER A DATE WINDOW. Entry fees used to
 * reach a season through tournaments.season_id; they now carry the season
 * stamped on at entry, which is the rule 00069 arrived at the hard way for
 * reinstatements (money paid three weeks before its season began belonged to no
 * season and was invisible in every total) and the rule 00084 restated for
 * corrections. The cost, stated plainly: moving a tournament to another season
 * afterwards no longer moves the entry money with it. That is the intended
 * behaviour — recorded money does not migrate — and an exec who really wants it
 * moved edits the fee rows.
 *
 * A row whose season_id is NULL — an entry fee for a tournament with no season,
 * a reinstatement taken between terms — belongs to no season's income. That is
 * unchanged from before the collapse and deliberate; reinstatePlayer refuses to
 * create one, see its comment.
 *
 * EVERY LEDGER IS FOLDED INTO totalCents HERE, and a caller wanting "income"
 * reads that field rather than adding ledgers up itself. Other income
 * (donations, grants, socials) was added to this function for that reason and
 * reached both /fees and /dashboard at once: a total assembled out of parts by
 * a page that only remembered some of them is precisely how the figure came to
 * be wrong the first time.
 *
 * The per-ledger helpers below are NOT that. They exist because seeing a ledger
 * is a per-ledger permission — fees.clubfees.read and fees.otherincome.read are
 * separate capabilities — so a caller allowed one figure can fetch that one
 * without reading books it may not see. This function calls them, so each sum
 * still has one implementation and the total still has one assembly point;
 * what is forbidden is a second piece of arithmetic, not a second entry point.
 *
 * Only rows with paid_at set count, in EVERY ledger — one rule, not one per
 * kind. An unpaid or waived row is a liability, not income.
 *
 * MONEY CAMPUS REC COLLECTED IS NOT THE CLUB'S INCOME. A fee paid on the Campus Rec
 * website (method 'sfu_rec') is taken by Campus Rec, not by the club; e-transfers
 * and cash land in the club's own hands. Those rows are still PAID (paid status,
 * outstanding lists and receipts never read this file), but they are kept out
 * of every total here and reported beside it as collectedBySfuRecCents. The
 * split happens in foldLedgerRows, so it reaches every figure built on it.
 */
export interface SeasonIncome {
  /** Everything below, added up. This is the number to show as "income". */
  totalCents: number;
  clubCents: number;
  tournamentCents: number;
  reinstatementCents: number;
  /** Club-event fees, filed when a member signs up for a priced event (00248). */
  eventCents: number;
  /** Donations, grants, socials — 00073. */
  otherCents: number;
  /**
   * Paid fees Campus Rec collected, across all four fee kinds. NOT in totalCents
   * or in any figure above: it is the sum of each fee ledger's
   * collectedBySfuRec, taken from the same reads, never a second query.
   */
  collectedBySfuRecCents: number;
  /**
   * EVERY INCOME LEDGER'S DATED AMOUNTS, MERGED AND UNLABELLED.
   *
   * The rows were always fetched — each of the four reads below returns a whole
   * LedgerRead and this function used to take `.total` and drop the dates on
   * the floor — so carrying them costs no query. What they are for is the net
   * position across the term, which is the only chart in the console that
   * spans every book.
   *
   * MERGED ON PURPOSE, AND THIS IS A PERMISSION PROPERTY RATHER THAN TIDINESS.
   * A caller holding `fees.netposition.read` may see the club's total, not its
   * individual ledgers — entry money answers to `tournaments.fees.read` and
   * reinstatements to `fees.reinstatements.read`. A list tagged by ledger would
   * hand that caller the itemised books through the back door, so there are no
   * tags: what comes out is dated money, and which shelf it came off is not
   * recoverable from it.
   *
   * The set is exactly the set the four totals are taken over — every query
   * here filters `paid_at is not null` — so a running total built from this
   * ends at `totalCents` and cannot drift from the figure printed beside it.
   */
  payments: LedgerPayment[];
}

/** Only the id is needed now that all three ledgers carry a real season key. */
export interface SeasonWindow {
  id: string;
}

/** One dated amount out of a ledger, for a running total across the term. */
export interface LedgerPayment {
  at: string;
  cents: number;
}

/**
 * ONE LEDGER, BOTH READINGS OF IT.
 *
 * The tile wants a figure and the running-total chart wants the dates behind
 * it. Reading the ledger twice — once summed, once itemised — would be a second
 * piece of arithmetic over the club's money, which is precisely what the note
 * at the top of this file forbids: the two could drift, and a chart whose last
 * point disagrees with the number printed beside it is worse than no chart.
 * So there is one read, and `total` is taken over the same rows `payments`
 * comes from.
 *
 * The two are not quite the same SET, and deliberately so. `total` counts every
 * row the query returned; `payments` keeps only those carrying a date, because
 * a row with no date cannot be placed on a time axis and putting it at the
 * start would silently move money earlier in the term. Every query below
 * filters `paid_at is not null`, so against the real table the two sets are
 * identical and the chart's last point IS the figure.
 */
export interface LedgerRead {
  total: number;
  payments: LedgerPayment[];
  /**
   * Money by category, largest first, for a ledger that HAS categories.
   * Empty for one that does not — club_fees carries no category column, and an
   * invented "other" bucket holding the whole ledger would draw a one-bar
   * breakdown chart that says nothing.
   */
  byCategory: { category: string; cents: number }[];
  /**
   * Paid rows whose method is 'sfu_rec', summed. Campus Rec collected this money,
   * so it is in none of `total`, `payments` or `byCategory`. Always 0 for a
   * ledger read without the method column (club_ledger has none).
   */
  collectedBySfuRec: number;
}

/**
 * The shape every ledger row is read through — the two or three columns the
 * arithmetic below actually touches, and nothing else. Exported because the
 * fold is exported: a caller that already holds rows (see foldLedgerRows) needs
 * to be able to say what it is handing over.
 */
export type LedgerAmountRow = {
  amount_cents: number | null;
  paid_at?: string | null;
  category?: string | null;
  /** How the fee was paid. Only club_fees has it; see collectedBySfuRec. */
  method?: string | null;
};

/**
 * THE ARITHMETIC OVER A LEDGER'S ROWS, WITH NO QUERY IN FRONT OF IT.
 *
 * Split out of readLedger so that a screen ALREADY HOLDING the rows can reach
 * the same three readings without asking the database for them a second time.
 * /fees is that screen twice over: its fee table selects the dues ledger to
 * decide who has paid, and its ledger card selects the income ledger row by row to
 * list it — in both cases the rows a chart needs are already in memory, and a
 * second read of the same table to draw a picture of it would be a round trip
 * for data the page is holding.
 *
 * WHAT MUST NOT HAPPEN IS A SECOND PIECE OF ARITHMETIC. That is the whole
 * subject of the note at the top of this file: the club's income read $0.00 for
 * months because two pages each summed the money their own way. A second CALLER
 * of one fold is not that; a second fold would be. So this function is the only
 * place a ledger's rows become a total, wherever the rows came from.
 *
 * IT DOES NOT FILTER ON paid_at, and the contract is the one LedgerRead states:
 * `total` counts every row it is given, `payments` keeps only the dated ones.
 * Every query in this file filters `paid_at is not null`, so the two sets are
 * identical against the real table. A caller passing rows it fetched WITHOUT
 * that filter — the ledger card selects unpaid rows too, so it can badge them
 * "not recorded" — must apply it before calling, exactly as the queries do.
 * Moving the filter in here would silently change what every existing caller
 * counts.
 *
 * CAMPUS REC ROWS ARE SET ASIDE HERE, and only here. A row whose method is exactly
 * 'sfu_rec' goes into `collectedBySfuRec` and into nothing else, so `total`,
 * `payments` and `byCategory` stay three readings of one set and the chart's
 * last point is still the figure. A waiver (method 'waived', amount 0) is
 * club money as before and adds nothing. A custom method is club money too,
 * even one that reads "Campus Rec": see isCollectedBySfuRec.
 */
export function foldLedgerRows(rows: readonly LedgerAmountRow[]): LedgerRead {
  const byCategory = new Map<string, number>();
  let total = 0;
  let collectedBySfuRec = 0;
  const payments: LedgerPayment[] = [];
  for (const row of rows) {
    const cents = row.amount_cents ?? 0;
    if (isCollectedBySfuRec(row.method)) {
      collectedBySfuRec += cents;
      continue;
    }
    total += cents;
    if (typeof row.paid_at === 'string') payments.push({ at: row.paid_at, cents });
    // Only when the caller actually SELECTED a category. `'category' in row` is
    // the test rather than `row.category != null`, so a ledger without the
    // column stays uncategorised instead of collapsing into one 'other' bar.
    if ('category' in row) {
      const key = row.category ?? 'other';
      byCategory.set(key, (byCategory.get(key) ?? 0) + cents);
    }
  }
  return {
    total,
    payments,
    byCategory: [...byCategory.entries()]
      .map(([category, cents]) => ({ category, cents }))
      .sort((a, b) => b.cents - a.cents),
    collectedBySfuRec,
  };
}

/**
 * REFUSING TO TREAT A FAILED QUERY AS AN EMPTY LEDGER.
 *
 * This used to be `(rows ?? []).reduce(...)` over `result.data`, which reads a
 * query that errored as a ledger containing nothing. That is the worst possible
 * failure for a money figure: it produces a number, the number looks fine, and
 * it is short by however much the failed ledger held. The first time it would
 * have bitten is the deploy of 00073 itself — the console ships through CI
 * while migrations are applied BY HAND, so between the two there is a window
 * where club_ledger does not exist yet and every query against it fails.
 * Silently, that window reports a plausible wrong total; loudly, it reports an
 * error somebody fixes by applying the migration.
 *
 * unwrap() is the repo's existing helper for exactly this and throws on error.
 */
const readLedger = (result: { data: LedgerAmountRow[] | null; error: unknown }): LedgerRead =>
  foldLedgerRows(
    unwrap(result as { data: LedgerAmountRow[] | null; error: { message: string } | null }, 'FEE-103'),
  );

/**
 * One KIND of fee, summed for one season.
 *
 * `.eq('fee_type', …)` is not a nicety. Since the collapse the same table holds
 * dues, entry fees, reinstatements and (00248) club-event fees, and the four
 * figures below have to partition it: a sum without this filter is every fee
 * four times over. It is
 * also the permission boundary: fees.clubfees.read and fees.reinstatements.read
 * are separate capabilities, so an unfiltered read hands one holder the other's
 * ledger.
 */
async function feeLedger(
  supabase: SupabaseClient,
  season: SeasonWindow,
  feeType: FeeType,
): Promise<LedgerRead> {
  return readLedger(
    await supabase
      .from('club_fees')
      // paid_at rides along with the amount. It is already the filter below, so
      // it costs nothing and it is what the running-total chart plots; the
      // alternative was a second read of the same ledger for the same rows.
      // method rides along for the same reason: it is what tells the fold
      // which paid rows Campus Rec collected rather than the club.
      .select('amount_cents, paid_at, method')
      .eq('season_id', season.id)
      .eq('fee_type', feeType)
      .not('paid_at', 'is', null),
  );
}

/**
 * SEASON DUES, ON THEIR OWN — and nothing else in the table.
 *
 * For the caller who may see this ledger and no other. Drawing the figure out
 * of getSeasonIncome instead would read the club's tournament money and
 * reinstatements on their behalf, which is the leak the fetch gating on /fees
 * and /dashboard exists to prevent. See the note on the interface above.
 *
 * DUES ONLY IS A PERMISSION BOUNDARY, NOT A DEFAULT. `fees.clubfees.read` owns
 * the dues slice of club_fees; entry fees answer to `tournaments.fees.read` and
 * reinstatements to `fees.reinstatements.read`, both of which an admin may hold
 * separately and a hand-picked person may not hold at all. So a chart of "the
 * fee ledger split by fee_type" cannot be drawn under this capability — it
 * would hand a dues reader two books that are somebody else's — and the
 * dashboard's fee chart is labelled "season dues" for that reason rather than
 * out of caution.
 *
 * A `total`-ONLY TWIN OF THIS USED TO SIT HERE (getClubFeeIncome), and
 * getOtherIncome beside it. Both are gone: every caller wants the dates too —
 * the panels chart them, and getSeasonIncome now merges them into the net
 * position — so the pair had become two names for one read whose only
 * difference was how much of the answer they threw away. `.total` is a field on
 * what comes back.
 */
export async function getClubFeeLedger(
  supabase: SupabaseClient,
  season: SeasonWindow,
): Promise<LedgerRead> {
  return feeLedger(supabase, season, 'dues');
}

/**
 * The other-income ledger on its own — donations, grants, socials (00073).
 * Same reason as getClubFeeLedger above, and the same paid_at rule.
 *
 * `category` is selected here and not for club_fees because this ledger
 * actually has the column — sponsorships, grants and socials are different
 * kinds of money to the club, and unlike club_fees' fee_type they are all the
 * same permission.
 *
 * `.eq('direction', 'income')` IS THE PERMISSION BOUNDARY, not a tidy-up.
 * Since 00159 income and expenses share one table, and what the club SPENT
 * answers to fees.expenses.read while this function is called for a holder of
 * fees.otherincome.read. Dropping the filter would add the club's spending to
 * its income — a total that is wrong in the flattering direction, on the one
 * figure the owner asked for by name ("are we in the positives"). It is the
 * same hazard 00094 documented for fee_type, one table further along.
 */
export async function getOtherIncomeLedger(
  supabase: SupabaseClient,
  season: SeasonWindow,
): Promise<LedgerRead> {
  return readLedger(
    await supabase
      .from('club_ledger')
      .select('amount_cents, paid_at, category')
      .eq('season_id', season.id)
      .eq('direction', 'income')
      .not('paid_at', 'is', null),
  );
}

export async function getSeasonIncome(
  supabase: SupabaseClient,
  season: SeasonWindow,
): Promise<SeasonIncome> {
  // FOUR DISJOINT SLICES OF ONE TABLE, plus the income half of club_ledger.
  // fee_type is a single NOT NULL column with a four-value CHECK (00248 added
  // 'event'), so these four filters cannot overlap and cannot leave a paid fee
  // out: the only way a row escapes all four is a fifth fee_type, which the
  // CHECK forbids until a migration adds one, and that migration has to add
  // its slice here. That is what makes "counted exactly once" a property of the
  // schema rather than a hope.
  // THE WHOLE LedgerRead IS KEPT NOW, not just its total. Every one of these
  // reads already returned the dated rows behind its figure and this function
  // dropped them; keeping them is what lets the net position be drawn across
  // the term without a single extra round trip. Nothing about WHAT is fetched
  // changed — see the note on `payments` above for why the four are then merged
  // into one untagged list.
  const [club, tournament, reinstatement, event, other] = await Promise.all([
    getClubFeeLedger(supabase, season),
    feeLedger(supabase, season, 'tournament'),
    feeLedger(supabase, season, 'reinstatement'),
    feeLedger(supabase, season, 'event'),

    // 00073, now the income half of club_ledger (00159). season_id is NOT NULL
    // here, so unlike fees there is no "attached to no season" row to worry
    // about — but the paid_at rule is the same, so a row recorded before the
    // money actually arrived stays out.
    getOtherIncomeLedger(supabase, season),
  ]);

  const clubCents = club.total;
  const tournamentCents = tournament.total;
  const reinstatementCents = reinstatement.total;
  const eventCents = event.total;
  const otherCents = other.total;

  return {
    clubCents,
    tournamentCents,
    reinstatementCents,
    eventCents,
    otherCents,
    totalCents: clubCents + tournamentCents + reinstatementCents + eventCents + otherCents,
    // Assembled beside totalCents out of the same four reads. other income has
    // no method column, so its share is always 0 and it is left out.
    collectedBySfuRecCents:
      club.collectedBySfuRec +
      tournament.collectedBySfuRec +
      reinstatement.collectedBySfuRec +
      event.collectedBySfuRec,
    payments: [
      ...club.payments,
      ...tournament.payments,
      ...reinstatement.payments,
      ...event.payments,
      ...other.payments,
    ],
  };
}
