import type { SupabaseClient } from '@supabase/supabase-js';
import { unwrap } from '@badminton/shared';
import { isWaivedFee, type FeeStatusRow } from './fee-status';

/**
 * HOW MUCH SEASON MONEY IS STILL OWED, IN CENTS.
 *
 * The dashboard's "fees outstanding" cell is an AMOUNT; /fees shows a COUNT of
 * people. They are two readings of one ledger, so the predicate that decides
 * whether a person still owes lives here, in a module with a test on it, rather
 * than a second time inside a page component that nothing can render in a unit
 * test. season-income.ts sets that norm and says why: a total assembled by a
 * page that only remembered some of the rules is how the income figure came to
 * be wrong the first time.
 *
 * WHO IS BILLABLE is transcribed from fees/page.tsx and must stay identical to
 * it: active competitive/recreational members who are neither exec nor
 * fee-exempt. A dashboard that counted a different population would print a
 * figure that contradicts the page it links to.
 *
 * WHAT THEY OWE is the flat per-status fee on the season row. Those two columns
 * are the club's PRICE LIST, and reading them is the caller's decision, not
 * this function's — see the note on BillableSeason.
 *
 * PAID AND WAIVED BOTH SETTLE. A waiver is stored as a paid row with
 * amount_cents 0 and method 'waived' (fee-status.ts), so both carry `paid_at`;
 * the predicate is written out in the same two halves fees/page.tsx uses so
 * that a change to what "waived" means reaches both through the shared helper.
 */

/**
 * The season, WITH its price list.
 *
 * `competitive_fee_cents` / `recreational_fee_cents` are the club's prices, and
 * a sibling agent found /fees shipping them to anybody who could read the
 * expense ledger. They are not page furniture: the caller must have selected
 * them under `fees.clubfees.read` and no weaker gate.
 */
export interface BillableSeason {
  id: string;
  competitive_fee_cents: number;
  recreational_fee_cents: number;
}

/** A member of the billable roster, as both callers of the sum below hold them. */
export interface BillableMember {
  id: string;
  status: string;
}

/** The two columns that price a member. The season's id is not part of the sum. */
export type PriceList = Pick<BillableSeason, 'competitive_fee_cents' | 'recreational_fee_cents'>;

/**
 * WHAT IS STILL OWED, OVER A ROSTER AND A FEE MAP ALREADY IN HAND.
 *
 * The predicate lives here rather than at either call site because there are
 * now two of them and they must never drift: the dashboard fetches the roster
 * and the ledger for this figure alone, while /fees is already holding both —
 * it builds exactly this roster and exactly this `feeByPlayer` map to render
 * the fee table — so its collection chart can reach the same number with no
 * query at all. Two screens, one sum, no second read.
 *
 * PAID AND WAIVED BOTH SETTLE, through the shared isWaivedFee predicate. A
 * waiver is a paid row with amount_cents 0 and method 'waived', so a test that
 * looked only at the amount would bill somebody the club has already excused.
 *
 * WHO IS BILLABLE IS THE CALLER'S QUESTION, not this function's — it sums
 * whatever roster it is given. Both callers filter it the same way (active
 * competitive/recreational, not exec, not fee-exempt), and a caller that
 * filtered differently would be printing a figure about a different club.
 */
export function outstandingClubFeeCents(
  roster: readonly BillableMember[],
  feeByPlayer: ReadonlyMap<string, FeeStatusRow | undefined>,
  prices: PriceList,
): number {
  return roster.reduce((cents, player) => {
    const fee = feeByPlayer.get(player.id);
    const waived = isWaivedFee(fee);
    const paid = Boolean(fee?.paid_at) && !waived;
    if (paid || waived) return cents;
    return (
      cents +
      (player.status === 'competitive'
        ? prices.competitive_fee_cents
        : prices.recreational_fee_cents)
    );
  }, 0);
}

export async function getOutstandingClubFees(
  supabase: SupabaseClient,
  season: BillableSeason,
): Promise<number> {
  const [rosterResult, feesResult] = await Promise.all([
    supabase
      .from('players')
      .select('id, status')
      .in('status', ['competitive', 'recreational'])
      .eq('is_exec', false)
      .eq('fee_exempt', false)
      // Guests (00292) owe no dues: they are entered in one event, not members.
      .eq('is_guest', false),
    supabase
      .from('club_fees')
      .select('player_id, paid_at, method')
      .eq('season_id', season.id)
      // DUES ONLY (00094). This figure is "how much SEASON money is still
      // owed", and the ledger now also holds entry fees and reinstatements.
      // Without the filter a member who had paid a tournament entry would be
      // read as having settled their dues — feeByPlayer keys on player_id, so
      // whichever of their rows arrived last would answer for all of them, and
      // the dashboard would under-report what the club is owed.
      .eq('fee_type', 'dues'),
  ]);

  // unwrap() rather than `?? []`: a query that errored would otherwise read as
  // "nobody owes anything", which is the most dangerous possible failure for a
  // money figure — it produces a plausible number that is short by whatever the
  // failed query held.
  const roster = unwrap(rosterResult as { data: { id: string; status: string }[] | null; error: { message: string } | null }, 'FEE-104');
  const fees = unwrap(feesResult as { data: { player_id: string | null; paid_at: string | null; method: string | null }[] | null; error: { message: string } | null }, 'FEE-104');

  const feeByPlayer = new Map(
    fees.filter((f) => f.player_id != null).map((f) => [f.player_id as string, f]),
  );

  return outstandingClubFeeCents(roster, feeByPlayer, season);
}
