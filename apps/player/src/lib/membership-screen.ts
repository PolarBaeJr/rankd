import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isFeeExempt,
  resolveEntrySeasonId,
  screenMembershipEntry,
  type MembershipScreen,
} from '@badminton/shared';

// WHAT THE TOURNAMENT PAGES KNOW ABOUT THE MEMBERSHIP GATE BEFORE THE CLICK.
//
// registerForEvent refuses an unpaid member from an internal-only event
// (00260). The pages ask the same question first, so the member reads "Club
// fee needed" above the events instead of a Register button that can only
// fail.
//
// Read on the SESSION client: seasons_select admits any signed-in member, and
// club_fees_select_own / fee_submissions_select_own each say "yours only". The
// dues rule is loadPaidDues's (a dues row for the season with paid_at set);
// the row is read here directly only so the receipt waiting on it comes back
// in the same request.
//
// Null means a read failed, and the pages then render nothing extra: the
// action still decides, and a notice built on a failed read would tell a paid
// member they owe a fee.

export interface MyMembershipScreen {
  screen: MembershipScreen;
  /** A receipt for this season's club fee is waiting for an exec. */
  receiptPending: boolean;
}

export async function loadMyMembershipScreen(
  supabase: SupabaseClient,
  tournament: { season_id?: string | null; allowed_memberships?: readonly string[] | null },
  player: {
    id: string;
    membership_type?: string | null;
    is_exec?: boolean | null;
    fee_exempt?: boolean | null;
  } | null,
): Promise<MyMembershipScreen | null> {
  if (!player) return null;
  const season = await resolveEntrySeasonId(supabase, tournament.season_id);
  if (season.error) return null;

  let paid = false;
  let receiptPending = false;
  if (season.seasonId) {
    const { data, error } = await supabase
      .from('club_fees')
      .select('paid_at, fee_submissions!fee_submissions_club_fee_fkey(status)')
      .eq('player_id', player.id)
      .eq('fee_type', 'dues')
      .eq('season_id', season.seasonId)
      .maybeSingle();
    if (error) return null;
    const row = data as { paid_at: string | null; fee_submissions: { status: string }[] | null } | null;
    paid = row?.paid_at != null;
    receiptPending = !paid && (row?.fee_submissions ?? []).some((s) => s.status === 'submitted');
  }

  return {
    screen: screenMembershipEntry(
      {
        stored: player.membership_type,
        exempt: isFeeExempt(player),
        paid,
        hasSeason: season.seasonId !== null,
      },
      tournament.allowed_memberships,
    ),
    receiptPending,
  };
}
