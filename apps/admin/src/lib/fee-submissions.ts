import {
  isReceiptMethod,
  reminderDecision,
  lastRemindedAt,
  selectInChunks,
  unwrap,
  type FeeType,
  type PayableFeeLine,
  type ReceiptMethod,
  type ReminderDecision,
} from '@badminton/shared';
import type { createAdminClient } from './supabase-server';
import type { Capability } from './permissions';

// PAYMENT RECEIPTS AND UNPAID LINES, READ FOR THE CONSOLE (00248, 00253).
//
// Not a 'use server' module: the /fees page and the actions in
// ./actions/fee-submissions.ts both read through here, so the list an exec
// sees and the list a Remind button acts on are the same computation.

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Who may settle a receipt, by the fee it is for. Dues and club events are
 * club fees; a tournament entry is entry money, its own capability. Anything
 * else (a reinstatement) is never settled by receipt.
 */
export function submissionCapability(feeType: string | null | undefined): Capability | null {
  if (feeType === 'dues' || feeType === 'event') return 'fees.clubfees.markpaid.write';
  if (feeType === 'tournament') return 'tournaments.fees.markpaid.write';
  return null;
}

export type PendingSubmission = {
  id: string;
  reference: string;
  /** How the member paid, as their browser read the receipt. Null when it could not tell. */
  method: ReceiptMethod | null;
  submittedAt: string;
  hasScreenshot: boolean;
  feeId: string;
  feeType: FeeType;
  amountCents: number | null;
  playerId: string;
  playerName: string;
  playerEmail: string | null;
  /** "Fall 2026 dues", an event's title, or a tournament's name. */
  line: string;
  /** An event fee whose sign-up is gone, or whose event was cancelled. */
  withdrawn: boolean;
};

/**
 * Every receipt waiting for an exec, oldest first. `scope` 'club' is dues and
 * club events (the /fees Submitted tab); a tournament id is that tournament's
 * entry fees.
 */
export async function loadPendingSubmissions(
  admin: AdminClient,
  scope: 'club' | { tournamentId: string },
): Promise<PendingSubmission[]> {
  const subs = unwrap(
    await admin
      .from('fee_submissions')
      .select('id, club_fee_id, player_id, reference, method, screenshot_path, submitted_at')
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: true }),
    'FEE-102',
  ) as {
    id: string;
    club_fee_id: string;
    player_id: string;
    reference: string;
    method: string | null;
    screenshot_path: string | null;
    submitted_at: string;
  }[];
  if (subs.length === 0) return [];

  const feeQuery = (ids: string[]) => {
    const q = admin
      .from('club_fees')
      .select('id, fee_type, amount_cents, season_id, club_event_id, tournament_id')
      .in('id', ids);
    return scope === 'club'
      ? q.in('fee_type', ['dues', 'event'])
      : q.eq('fee_type', 'tournament').eq('tournament_id', scope.tournamentId);
  };
  const fees = unwrap(
    await selectInChunks([...new Set(subs.map((s) => s.club_fee_id))], (ids) => feeQuery(ids) as never),
    'FEE-102',
  ) as { id: string; fee_type: FeeType; amount_cents: number | null; season_id: string | null; club_event_id: string | null; tournament_id: string | null }[];
  const feeById = new Map(fees.map((f) => [f.id, f]));
  const mine = subs.filter((s) => feeById.has(s.club_fee_id));
  if (mine.length === 0) return [];

  const playerIds = [...new Set(mine.map((s) => s.player_id))];
  const eventIds = [...new Set(fees.map((f) => f.club_event_id).filter((v): v is string => Boolean(v)))];
  const seasonIds = [...new Set(fees.filter((f) => f.fee_type === 'dues').map((f) => f.season_id).filter((v): v is string => Boolean(v)))];
  const tournamentIds = [...new Set(fees.map((f) => f.tournament_id).filter((v): v is string => Boolean(v)))];

  const [players, events, signups, seasons, tournaments] = await Promise.all([
    selectInChunks(playerIds, (ids) => admin.from('players').select('id, full_name, email').in('id', ids) as never),
    eventIds.length
      ? admin.from('club_events').select('id, title, status').in('id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    eventIds.length
      ? admin.from('club_event_signups').select('event_id, player_id').in('event_id', eventIds).in('player_id', playerIds)
      : Promise.resolve({ data: [], error: null }),
    seasonIds.length
      ? admin.from('seasons').select('id, name').in('id', seasonIds)
      : Promise.resolve({ data: [], error: null }),
    tournamentIds.length
      ? admin.from('tournaments').select('id, name').in('id', tournamentIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const playerById = new Map(
    (unwrap(players, 'FEE-102') as { id: string; full_name: string; email: string | null }[]).map((p) => [p.id, p]),
  );
  const eventById = new Map(
    (unwrap(events, 'FEE-102') as { id: string; title: string; status: string }[]).map((e) => [e.id, e]),
  );
  const signedUp = new Set(
    (unwrap(signups, 'FEE-102') as { event_id: string; player_id: string }[]).map((s) => `${s.event_id}:${s.player_id}`),
  );
  const seasonName = new Map((unwrap(seasons, 'FEE-102') as { id: string; name: string }[]).map((s) => [s.id, s.name]));
  const tournamentName = new Map((unwrap(tournaments, 'FEE-102') as { id: string; name: string }[]).map((t) => [t.id, t.name]));

  return mine.map((s) => {
    const fee = feeById.get(s.club_fee_id)!;
    const player = playerById.get(s.player_id);
    const event = fee.club_event_id ? eventById.get(fee.club_event_id) : undefined;
    const line =
      fee.fee_type === 'dues'
        ? `${(fee.season_id && seasonName.get(fee.season_id)) || 'Season'} dues`
        : fee.fee_type === 'event'
          ? event?.title ?? 'Club event'
          : (fee.tournament_id && tournamentName.get(fee.tournament_id)) || 'Tournament entry';
    return {
      id: s.id,
      reference: s.reference,
      method: isReceiptMethod(s.method) ? s.method : null,
      submittedAt: s.submitted_at,
      hasScreenshot: s.screenshot_path != null,
      feeId: fee.id,
      feeType: fee.fee_type,
      amountCents: fee.amount_cents,
      playerId: s.player_id,
      playerName: player?.full_name ?? 'Unknown member',
      playerEmail: player?.email ?? null,
      line,
      withdrawn:
        fee.fee_type === 'event' &&
        (!fee.club_event_id || !signedUp.has(`${fee.club_event_id}:${s.player_id}`) || event?.status === 'cancelled'),
    };
  });
}

export type OutstandingLine = PayableFeeLine & {
  /** Null for this season's dues when the member has no row yet. */
  feeId: string | null;
  name: string;
};

export type OutstandingMember = {
  id: string;
  fullName: string;
  email: string | null;
  avatarUrl: string | null;
  status: string;
  lines: OutstandingLine[];
  totalCents: number;
  pending: boolean;
  remindedAt: Date | null;
  decision: ReminderDecision;
};

type Season = { id: string; name: string; active_flag: boolean; competitive_fee_cents: number; recreational_fee_cents: number };

export function duesFor(status: string | null | undefined, season: Season): number {
  return status === 'competitive' ? season.competitive_fee_cents : season.recreational_fee_cents;
}

/**
 * Everybody who owes money for this season that a receipt can settle: dues
 * for the roster (competitive or recreational, not exec, not fee-exempt), and
 * every unpaid club-event line. Tournament entries are not here; they have
 * their own page. A member is listed once, with each of their lines.
 */
export async function loadOutstandingMembers(admin: AdminClient, season: Season, now: Date): Promise<OutstandingMember[]> {
  const [roster, dues, eventFeesRaw] = await Promise.all([
    admin
      .from('players')
      .select('id, full_name, email, avatar_url, status, is_exec, fee_exempt')
      .in('status', ['competitive', 'recreational'])
      .eq('is_exec', false)
      .eq('fee_exempt', false),
    admin
      .from('club_fees')
      .select('id, player_id, amount_cents, paid_at, payment_reminded_at')
      .eq('season_id', season.id)
      .eq('fee_type', 'dues')
      .not('player_id', 'is', null),
    // An event fee filed between seasons has no season; it is owed now, so
    // it belongs to whichever season is running.
    season.active_flag
      ? admin
          .from('club_fees')
          .select('id, player_id, amount_cents, paid_at, payment_reminded_at, club_event_id')
          .eq('fee_type', 'event')
          .is('paid_at', null)
          .or(`season_id.eq.${season.id},season_id.is.null`)
      : admin
          .from('club_fees')
          .select('id, player_id, amount_cents, paid_at, payment_reminded_at, club_event_id')
          .eq('fee_type', 'event')
          .is('paid_at', null)
          .eq('season_id', season.id),
  ]);
  type Player = { id: string; full_name: string; email: string | null; avatar_url: string | null; status: string; is_exec: boolean; fee_exempt: boolean };
  type Fee = { id: string; player_id: string; amount_cents: number | null; paid_at: string | null; payment_reminded_at: string | null; club_event_id?: string | null };
  const rosterRows = unwrap(roster, 'FEE-102') as Player[];
  const duesRows = unwrap(dues, 'FEE-102') as Fee[];
  // A non-member a Google Form signed up (00284) owes a NAMED event row with no
  // player_id. This list is per member, so those rows are not members' lines;
  // the event's own page lists them.
  const eventFees = (unwrap(eventFeesRaw, 'FEE-102') as (Omit<Fee, 'player_id'> & { player_id: string | null })[]).filter(
    (f): f is Fee => f.player_id != null,
  );

  // Event lines can belong to members outside the roster (a pending member
  // who signed up, say). Exec and fee-exempt members are filed no event fee,
  // but one promoted after signing up keeps what they owe, as tournament
  // entries do.
  const extraIds = [...new Set(eventFees.map((f) => f.player_id))].filter(
    (id) => !rosterRows.some((p) => p.id === id),
  );
  const extras = extraIds.length
    ? (unwrap(
        await selectInChunks(extraIds, (ids) =>
          admin.from('players').select('id, full_name, email, avatar_url, status, is_exec, fee_exempt').in('id', ids) as never,
        ),
        'FEE-102',
      ) as Player[])
    : [];

  const feeIds = [...duesRows.filter((f) => !f.paid_at).map((f) => f.id), ...eventFees.map((f) => f.id)];
  const eventIds = [...new Set(eventFees.map((f) => f.club_event_id).filter((v): v is string => Boolean(v)))];
  const [pendingRaw, eventsRaw] = await Promise.all([
    feeIds.length
      ? selectInChunks(feeIds, (ids) =>
          admin.from('fee_submissions').select('club_fee_id').eq('status', 'submitted').in('club_fee_id', ids) as never,
        )
      : Promise.resolve({ data: [], error: null }),
    eventIds.length
      ? admin.from('club_events').select('id, title').in('id', eventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const pending = new Set((unwrap(pendingRaw, 'FEE-102') as { club_fee_id: string }[]).map((s) => s.club_fee_id));
  const eventTitle = new Map((unwrap(eventsRaw, 'FEE-102') as { id: string; title: string }[]).map((e) => [e.id, e.title]));
  const duesByPlayer = new Map(duesRows.map((f) => [f.player_id, f]));

  const members: OutstandingMember[] = [];
  for (const p of [...rosterRows, ...extras]) {
    const lines: OutstandingLine[] = [];
    const onRoster = !p.is_exec && !p.fee_exempt && (p.status === 'competitive' || p.status === 'recreational');
    if (onRoster) {
      const row = duesByPlayer.get(p.id);
      if (!row?.paid_at) {
        lines.push({
          feeId: row?.id ?? null,
          name: `${season.name} dues`,
          feeType: 'dues',
          paidAt: null,
          amountCents: row ? row.amount_cents ?? duesFor(p.status, season) : duesFor(p.status, season),
          pending: row ? pending.has(row.id) : false,
          remindedAt: row?.payment_reminded_at ?? null,
        });
      }
    }
    for (const f of eventFees.filter((e) => e.player_id === p.id)) {
      lines.push({
        feeId: f.id,
        name: (f.club_event_id && eventTitle.get(f.club_event_id)) || 'Club event',
        feeType: 'event',
        paidAt: null,
        amountCents: f.amount_cents,
        pending: pending.has(f.id),
        remindedAt: f.payment_reminded_at,
      });
    }
    if (lines.length === 0) continue;
    // Event lines are owed whatever the member's standing now, so the
    // reminder is decided over the lines alone rather than re-exempting them.
    const payer = { isExec: false, feeExempt: false };
    members.push({
      id: p.id,
      fullName: p.full_name,
      email: p.email,
      avatarUrl: p.avatar_url,
      status: p.status,
      lines,
      totalCents: lines.reduce((sum, l) => sum + (l.amountCents ?? 0), 0),
      pending: lines.some((l) => l.pending),
      remindedAt: lastRemindedAt(lines),
      decision: reminderDecision(lines, payer, now),
    });
  }
  return members.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
