import type { SupabaseClient } from '@supabase/supabase-js';
import {
  paymentPrompt,
  raise,
  type FeePayer,
  type FeeType,
  type PayableFeeLine,
  type PaymentPrompt,
} from '@badminton/shared';
import { createServerSupabaseClient, getActiveSeason } from './supabase-server';

// A MEMBER'S OWN FEE ROWS, WITH THE RECEIPTS SENT AGAINST THEM, IN ONE READ.
//
// Read on the SESSION client: RLS on club_fees (club_fees_select_own) and on
// fee_submissions (fee_submissions_select_own, 00248) each say "yours only",
// and the explicit player filter says it a third time. The receipts arrive
// embedded through fee_submissions' single-column key into club_fees. 00288
// added that key beside the composite one (00248), and an unnamed embed with
// two keys to choose from is refused (PGRST201), so every embed names it.

export type OwnFeeSubmission = {
  id: string;
  status: 'submitted' | 'confirmed' | 'rejected' | 'superseded';
  /** Null for a screenshot sent through a Google Form (00288) until an exec reads it. */
  reference: string | null;
  reject_reason: string | null;
  submitted_at: string;
};

export type OwnFeeRow = {
  id: string;
  fee_type: FeeType;
  season_id: string | null;
  tournament_id: string | null;
  club_event_id: string | null;
  amount_cents: number | null;
  paid_at: string | null;
  method: string | null;
  reference: string | null;
  created_at: string;
  fee_submissions: OwnFeeSubmission[] | null;
};

const OWN_FEE_COLUMNS =
  'id, fee_type, season_id, tournament_id, club_event_id, amount_cents, paid_at, method, reference, created_at, ' +
  'fee_submissions!fee_submissions_club_fee_fkey(id, status, reference, reject_reason, submitted_at)';

/** Every fee row of this member's, newest first. Throws on a failed read. */
export async function readOwnFees(supabase: SupabaseClient, playerId: string): Promise<OwnFeeRow[]> {
  const { data, error } = await supabase
    .from('club_fees')
    .select(OWN_FEE_COLUMNS)
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });
  if (error) throw raise('MEM-101', error, `Could not read your fees: ${error.message}`);
  return (data ?? []) as unknown as OwnFeeRow[];
}

/** The most recent receipt sent for a fee, or null. */
export function latestSubmission(row: Pick<OwnFeeRow, 'fee_submissions'> | undefined): OwnFeeSubmission | null {
  const subs = row?.fee_submissions ?? [];
  if (subs.length === 0) return null;
  return [...subs].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))[0] ?? null;
}

/**
 * This season's dues for a member, by players.status: competitive pays the
 * competitive price, everybody else the recreational one. The rule /fees has
 * always used, and the one the submit action prices a new dues row by.
 */
export function seasonFeeFor(
  status: string | null | undefined,
  season: { competitive_fee_cents: number; recreational_fee_cents: number },
): number {
  return status === 'competitive' ? season.competitive_fee_cents : season.recreational_fee_cents;
}

/**
 * The rows as payable lines, plus this season's dues when the member has no
 * dues row yet (they owe it all the same).
 */
export function toPayableLines(
  rows: readonly OwnFeeRow[],
  season: { id: string; competitive_fee_cents: number; recreational_fee_cents: number } | null,
  status: string | null | undefined,
): PayableFeeLine[] {
  const lines: PayableFeeLine[] = rows
    // Dues from past seasons are not what the banner is about.
    .filter((r) => r.fee_type !== 'dues' || (season !== null && r.season_id === season.id))
    .map((r) => ({
      feeType: r.fee_type,
      paidAt: r.paid_at,
      amountCents: r.amount_cents,
      pending: latestSubmission(r)?.status === 'submitted',
      remindedAt: null,
    }));
  if (season && !rows.some((r) => r.fee_type === 'dues' && r.season_id === season.id)) {
    lines.push({
      feeType: 'dues',
      paidAt: null,
      amountCents: seasonFeeFor(status, season),
      pending: false,
      remindedAt: null,
    });
  }
  return lines;
}

/**
 * What the payment banner says for this member. NEVER THROWS: it renders on
 * /feed, and a failed read hides the banner rather than the page.
 */
export async function getPaymentPrompt(player: {
  id: string;
  status?: string | null;
  is_exec?: boolean | null;
  fee_exempt?: boolean | null;
}): Promise<PaymentPrompt> {
  try {
    const payer: FeePayer = { isExec: Boolean(player.is_exec), feeExempt: Boolean(player.fee_exempt) };
    if (payer.isExec || payer.feeExempt) return { kind: 'none' };
    const supabase = await createServerSupabaseClient();
    const [rows, season] = await Promise.all([readOwnFees(supabase, player.id), getActiveSeason()]);
    return paymentPrompt(toPayableLines(rows, season, player.status), payer);
  } catch (err) {
    console.error('[membership] payment banner hidden, could not read fees:', err);
    return { kind: 'none' };
  }
}
