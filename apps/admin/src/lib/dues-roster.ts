import { unwrap } from '@badminton/shared';
import type { createAdminClient } from './supabase-server';

// THE DUES ROSTER: who owes dues for a season, and the dues rows filed against
// it. Read by the /fees list and by the collection charts on /finances, so the
// two pages count the same population with the same filters.
//
// Every caller gates this on fees.clubfees.read before calling it. It is the
// roster and its payments, and a value awaited here reaches the RSC payload
// whether or not it is drawn.

type AdminClient = ReturnType<typeof createAdminClient>;

export async function loadDuesRoster(supabase: AdminClient, season: { id: string }) {
  // Fee-collection list: active players (competitive/recreational) who are
  // neither exec nor fee-exempt.
  const players = unwrap(
    await supabase
      .from('players')
      .select('id, full_name, email, avatar_url, status')
      .in('status', ['competitive', 'recreational'])
      .eq('is_exec', false)
      .eq('fee_exempt', false)
      // Guests (00292) owe no dues: they are entered in one event, not members.
      .eq('is_guest', false)
      .order('full_name'),
    'FEE-101',
  );

  const fees = unwrap(
    await supabase
      .from('club_fees')
      .select('id, player_id, manual_name, manual_email, amount_cents, paid_at, method, reference')
      .eq('season_id', season.id)
      // DUES ONLY, and this filter is load-bearing twice over.
      //
      // It is the PERMISSION BOUNDARY. Since 00094 this table also holds
      // reinstatements, which are a separate capability on /fees
      // (fees.reinstatements.read, see ReinstatementsCard). Without it,
      // holding fees.clubfees.read would hand you the reinstatement ledger,
      // including ban_reason, through the roster query.
      //
      // It is also what keeps the View counts meaning anything.
      // summariseFeeCollection counts ONE ROW PER LINE OF THE LIST and derives
      // Outstanding as the remainder, so a row that is not a line of the list
      // inflates Paid and shrinks Outstanding by one apiece: a mixed count over
      // three populations with three different exemption rules, presented as a
      // count of members who have paid their dues. Entry fees and
      // reinstatements have their own screens with their own totals, and that
      // is where they are counted.
      .eq('fee_type', 'dues'),
    'FEE-101',
  );
  const feeByPlayer = new Map(
    fees.filter((f) => f.player_id != null).map((f) => [f.player_id, f])
  );
  const manualFees = fees.filter((f) => f.manual_name != null);

  return { players, fees, feeByPlayer, manualFees };
}
