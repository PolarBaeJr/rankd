'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  banSchema,
  reinstatementSchema,
  reinstatementPaymentSchema,
  type BanInput,
  type ReinstatementInput,
  type ReinstatementPaymentInput,
  requireActiveSeasonId,
} from '@badminton/shared';
import { requireCapability } from './_shared';
import { ExpectedError } from '@badminton/shared';
import { isAdminActor } from '../player-field-access';
import { runAction, type ActionResult } from '../action-result';

// Ban/unban is exec work — the club owner named it explicitly. Note that this
// writes is_banned, which the guard_player_privileged_columns trigger also
// lists; that trigger returns early when auth.uid() IS NULL, and this runs on
// the service-role client, so it never fires here. The gate is this function.
//
// RETURNS ITS REFUSALS RATHER THAN THROWING THEM, which is the change that makes
// every guard below worth writing. Next replaces anything thrown out of a server
// action in production with a generic message, so an ExpectedError raised here
// would reach the exec as "an error occurred" — the two sentences added below
// tell them what to do instead, and they only survive as a returned value.
// handleBan in players/player-actions.tsx checks `res.ok` for the same reason;
// it previously awaited a bare promise and toasted success unconditionally.
export async function banPlayer(input: BanInput): Promise<ActionResult<void>> {
  return runAction(() => banPlayerImpl(input));
}

async function banPlayerImpl(input: BanInput) {
  parseOrThrow(banSchema, input);
  const actor = await requireCapability('players.ban.write');
  const adminClient = createAdminClient();

  // This function used to write blind — no read of the row it was about to
  // overwrite, and an audit entry carrying new_value only. Both of the guards
  // below need the stored row, and the audit entry now carries it as old_value
  // so that whatever a ban replaces is recoverable from /audit.
  const { data: target } = await adminClient
    .from('players')
    .select('id, role, is_banned, banned_at, banned_by, ban_reason')
    .eq('id', input.player_id)
    .maybeSingle();
  if (!target) throw new ExpectedError('That member no longer exists.');

  // REFUSED RATHER THAN MADE A NO-OP, and banned_at is why. It is not a
  // decorative timestamp: it is the identity of the ban episode.
  // club_fees.ban_started_at snapshots it at reinstatement and
  // club_fees_reinstatement_ban_key UNIQUE (player_id, ban_started_at) (00065,
  // carried into 00094) is the only thing that makes one reinstatement fee per
  // ban true rather than hoped for. So re-stamping it on a ban that was never
  // lifted does two things, one certain and one racy:
  //
  //   * CERTAIN. banned_at, banned_by and ban_reason are overwritten, and until
  //     this commit the audit row for a ban carried no old_value at all — so the
  //     original moderation decision (who banned them, when, and what for) was
  //     destroyed with no trace anywhere in the database.
  //   * RACY, AND THIS IS WHAT THE INDEX WAS FOR. reinstatePlayer's own note:
  //     two admins submitting the same reinstatement at once "both read
  //     is_banned = true, so the precondition above cannot separate them — they
  //     snapshot the same banned_at and the index does". Slide a re-ban between
  //     the two reads and they no longer snapshot the same value: one inserts a
  //     fee keyed on T1, the other on T2, the unique index cannot collide them,
  //     and the member is charged twice for one ban.
  //
  // A no-op would leave the exec's typed reason silently discarded and report
  // success for a write that did not happen. A refusal says what is true, and it
  // is the same shape as reinstatePlayer's "not banned, so there is nothing to
  // reinstate" one screen down. Unreachable from the console — rosterActionsFor
  // offers Unban and never Ban for a banned member — which is exactly the
  // approvePlayer situation: a client-side rule guarding a server action is a
  // suggestion, and this is the guarantee.
  if (target.is_banned) {
    throw new ExpectedError(
      'That member is already banned. Lift the existing ban first if it needs to be re-issued — ' +
      're-banning would overwrite the record of the ban they are already serving.',
    );
  }

  // THE CONSOLE MUST STAY REACHABLE, and since 00140 a ban is how you take that
  // away. 00050 guards the three ways to end up with no admin who can get in —
  // demoting the last one, deleting them, deleting their last passkey — with
  // triggers, on the stated grounds that "a check in application code is a
  // suggestion; this is the guarantee". is_banned was not one of the three,
  // because in 00050's day a banned admin still passed is_admin() and still
  // opened the console.
  //
  // 00140 ended that in both places at once: is_admin() and is_admin_or_coach()
  // now return FALSE for a banned admin (45 + 3 RLS policies), and
  // requireAdminPlayer refuses them with 'Account suspended pending
  // reinstatement' before any capability is resolved. So banning the last
  // passkey-holding admin is a full lockout whose only recovery is a manual
  // UPDATE against production — and players.ban.write is EXEC-level, so an exec
  // can do it to every admin the club has.
  //
  // Counted through admins_with_passkeys(), the same function
  // guard_last_admin_role calls, rather than a second transcription of the join:
  // enrolled_via = 'admin' matters (00051) and a copy would drift. 00126 revoked
  // it from anon and authenticated and kept the service_role grant, which is the
  // client this runs on.
  //
  // THIS LINE IS NOT COMPLETE ON ITS OWN AND THE COMPANION MIGRATION IS WHY.
  // admins_with_passkeys filters role = 'admin' and does NOT filter is_banned,
  // so with one admin already banned it still counts them as a live door and
  // would let this ban through. 00145 adds the missing clause — and the
  // is_banned arm to guard_last_admin_role, which is the half no app code can
  // reach, since the same over-count lets guard_last_admin_role permit the
  // DEMOTION or DELETION of the last unbanned admin.
  if (target.role === 'admin') {
    const { data: doors, error: doorsError } = await adminClient.rpc('admins_with_passkeys', {
      p_excluding_player: input.player_id,
    });
    // Fails closed on both branches: an unreadable count is not permission to
    // ban the last admin, and `null` from a function declared RETURNS INTEGER
    // means something is wrong with the call rather than that there are doors.
    if (doorsError) throw new Error(doorsError.message);
    if (!doors) {
      throw new ExpectedError(
        'This is the only admin with a passkey. Give another admin a passkey before banning this one, ' +
        'or the admin console becomes unreachable.',
      );
    }
  }

  const bannedAt = new Date().toISOString();
  const { data: banned, error } = await adminClient
    .from('players')
    .update({
      is_banned: true,
      banned_at: bannedAt,
      banned_by: actor.id,
      ban_reason: input.reason,
    })
    .eq('id', input.player_id)
    // Re-checked in the WHERE clause, on approvePlayer's pattern: the read above
    // is a moment old, and two execs acting on the same report would both pass
    // the precondition. The loser matches no row, so the winner's banned_at
    // stands and only one player_banned entry is filed.
    .eq('is_banned', false)
    // Matching zero rows is not an error in PostgREST, so without the count the
    // loser would be told the ban landed and would file an audit row for a write
    // that did nothing.
    .select('id');
  if (error) throw new Error(error.message);
  if (!banned?.length) {
    throw new ExpectedError(
      'That member was banned while you were banning them — most likely another exec got there first. ' +
      'Reload the roster before trying again.',
    );
  }

  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'player_banned',
    target_type: 'player',
    target_id: input.player_id,
    // The row this ban replaced. Empty for the ordinary case (nobody has been
    // banned before), and the whole point when it is not: the precondition above
    // refuses a re-ban, so this is the record that a hand-applied UPDATE or a
    // future bulk path would otherwise erase without trace.
    old_value: {
      is_banned: target.is_banned,
      banned_at: target.banned_at,
      banned_by: target.banned_by,
      ban_reason: target.ban_reason,
    },
    new_value: { is_banned: true, banned_at: bannedAt, banned_by: actor.id, reason: input.reason },
  }, { playerId: input.player_id });

  revalidatePath('/players');
  revalidatePath('/fees');
  revalidatePath('/finances');
}

export async function reinstatePlayer(input: ReinstatementInput) {
  const parsed = parseOrThrow(reinstatementSchema, input);
  const actor = await requireCapability('players.reinstate.write');
  // Lifting the ban is exec work; recording what was collected for it is not.
  // This inserts a club_fees row tagged 'reinstatement' and revalidates /fees, which is
  // admin-only in the same access map — so an exec reinstates for free and an
  // admin records the money. Rejected rather than dropped: a silently ignored
  // amount would leave the ledger short with nothing to show for it.
  if (!isAdminActor(actor) && (parsed.amount_cents !== undefined || parsed.method !== undefined || parsed.reference !== undefined)) {
    throw new ExpectedError('Admin access required to record a reinstatement fee');
  }
  const adminClient = createAdminClient();

  // Snapshot the ban before touching it: banned_at identifies which ban this
  // fee settles (00065) and ban_reason is copied onto the record before it is
  // cleared.
  const { data: player } = await adminClient
    .from('players')
    .select('is_banned, banned_at, ban_reason')
    .eq('id', input.player_id)
    .single();
  if (!player) throw new ExpectedError('That member no longer exists.');

  // There was no precondition here at all, so the Unban button could file a
  // reinstatement fee — real money in the season ledger — for a ban that never
  // happened. rosterActionsFor already tries not to offer Unban in that case;
  // this is the guarantee rather than the suggestion, and it is also what stops
  // a sequential double-click from charging twice.
  if (!player.is_banned) {
    throw new ExpectedError('That member is not banned, so there is nothing to reinstate.');
  }

  // Which season this money counts toward. Stamped from the active season
  // rather than inferred from paid_at later: a reinstatement taken in the gap
  // before a term opens is for that term, and date-bucketing put it in no
  // season at all — a real $20 payment sat invisible in every income figure
  // because it was paid three weeks before the season it belonged to started.
  //
  // "Between terms is exactly when a lapsed member comes back, so record the
  // payment unattached rather than refusing it" was the old reasoning, and it
  // was wrong about where the money ends up. Season income filters by an exact
  // season id, so a paid fee with season_id NULL is visible on the member's row,
  // individually correct, and absent from every season's income permanently —
  // and recordReinstatementPayment then refuses to repair it, because the amount
  // is already recorded. Refusing up front is recoverable; a stranded payment is
  // not.
  //
  // RESOLVED BEFORE THE FIRST WRITE, because requireActiveSeasonId throws. Read
  // after the unban, it threw with the ban already lifted and committed, so a
  // reinstatement attempted between terms unbanned the member and then reported
  // a failure: the refusal that was supposed to be recoverable had already done
  // half the job. This is a read, so it is safe to take before the precondition
  // work above has committed anything.
  const { data: activeSeason } = await adminClient
    .from('seasons')
    .select('id')
    .eq('active_flag', true)
    .maybeSingle();
  const activeSeasonId = requireActiveSeasonId(activeSeason?.id, 'reinstatement fee');

  // Lift the ban FIRST, then record the money. The old order inserted the fee
  // up front, so a failure on the update left the member charged AND still
  // banned: the worst of the two possible half-states, and invisible until
  // someone reconciled the ledger. This way the bad outcome is "unbanned but
  // the payment was not recorded", which is visible on /fees and fixable.
  const { error } = await adminClient
    .from('players')
    .update({
      is_banned: false,
      banned_at: null,
      banned_by: null,
      ban_reason: null,
    })
    .eq('id', input.player_id);
  if (error) throw new Error(error.message);

  // Falls back to now() only if the row was banned without a banned_at, which
  // banPlayer never does; the column is NOT NULL.
  const banStartedAt = player.banned_at ?? new Date().toISOString();

  // Was the money settled, or is it simply unknown?
  //
  // The row used to be written with paid_at = now() no matter who filed it, so
  // an exec unban — the dialog hides the payment fields from execs entirely —
  // produced a row that claimed a payment had been taken and recorded its
  // amount as nothing. It counted as $0 in the season income and could never
  // be corrected: reinstatePlayer refuses a second call because the member is
  // no longer banned, and club_fees_reinstatement_ban_key (00065, 00094) refuses a
  // second row for the same ban. Real money, permanently booked as zero.
  //
  // An admin SAW the amount box and left it blank, which the dialog spells out
  // as "leave blank for a free reinstatement" — that is a decision, so record
  // it as one: $0, paid. An exec was never shown the box, so nothing is known
  // — leave amount_cents and paid_at null. A null paid_at is what every other
  // ledger in this app already means by "not settled" (markTournamentFeeUnpaid
  // clears exactly those fields), so it is excluded from season income rather
  // than counted as zero, and recordReinstatementPayment below fills it in.
  const paymentRecorded = isAdminActor(actor);
  const amountCents = paymentRecorded ? (input.amount_cents ?? 0) : null;

  // Into club_fees, the club's one fee ledger since 00094 — tagged
  // 'reinstatement' and keyed on the ban episode, exactly as
  // reinstatement_fees was. The columns are the same columns; what changed is
  // that a member's dues, entry fees and this now answer "what do you owe?" in
  // one query instead of three.
  const { data: fee, error: feeError } = await adminClient
    .from('club_fees')
    .insert({
      fee_type: 'reinstatement',
      player_id: input.player_id,
      amount_cents: amountCents,
      paid_at: paymentRecorded ? new Date().toISOString() : null,
      marked_by: actor.id,
      method: input.method ?? null,
      reference: input.reference ?? null,
      ban_reason: player.ban_reason ?? null,
      ban_started_at: banStartedAt,
      season_id: activeSeasonId,
    })
    .select('id')
    .single();

  // Audited before the fee error is raised: the ban really was lifted, and that
  // has to be on the record whether or not the money row landed.
  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'player_reinstated',
    target_type: 'player',
    target_id: input.player_id,
    old_value: { is_banned: true, banned_at: player.banned_at, ban_reason: player.ban_reason },
    new_value: {
      reinstatement_fee_id: fee?.id ?? null,
      fee_recorded: !feeError,
      payment_recorded: paymentRecorded,
      ban_started_at: banStartedAt,
      amount_cents: amountCents,
      method: input.method ?? null,
    },
  }, { playerId: input.player_id });

  revalidatePath('/players');
  revalidatePath('/fees');
  revalidatePath('/finances');

  if (feeError) {
    // club_fees_reinstatement_ban_key (00065, 00094): two admins submitting the same
    // reinstatement at once both read is_banned = true, so the precondition
    // above cannot separate them — they snapshot the same banned_at and the
    // index does. The member is unbanned either way; only the duplicate charge
    // is refused.
    if (feeError.code === '23505') {
      throw new ExpectedError(
        'The ban was lifted, but a reinstatement fee for it had already been recorded — this one was not charged again.',
      );
    }
    throw new Error(feeError.message);
  }
}

/**
 * Record the money for a reinstatement that has already happened.
 *
 * This is the missing half of the exec/admin split above. An exec lifts the
 * ban, the member hands over $20, and until now there was no way for anyone to
 * ever attach that $20 to the club's books: reinstatePlayer refuses to run
 * again because the member is no longer banned, and 00065's
 * (player_id, ban_started_at) index refuses a second row for the same ban.
 *
 * Which is also why the fix is an update and not "skip the placeholder row".
 * The row IS the ban episode: reinstatePlayer clears players.banned_at, and
 * club_fees.ban_started_at is required for a reinstatement row (00094's shape CHECK) precisely so
 * that nothing can invent one later (00065). Once the row is gone the ban
 * identity is gone with it, and a later insert becomes impossible to key. So
 * the row is written unconditionally and the payment fields are filled in here.
 *
 * Admin-only, matching /fees in the access map and the payment fields in the
 * unban dialog — an exec who could fill this in would be recording money.
 */
export async function recordReinstatementPayment(input: ReinstatementPaymentInput) {
  const parsed = parseOrThrow(reinstatementPaymentSchema, input);
  const admin = await requireCapability('fees.reinstatements.write');
  const adminClient = createAdminClient();

  const { data: fee } = await adminClient
    .from('club_fees')
    .select('id, player_id, amount_cents, paid_at, method, reference, season_id')
    .eq('id', parsed.fee_id)
    // The id arrives from a rendered list, and the ledger now holds three kinds
    // of row. Without this a dues row's id would be accepted here and filled in
    // as though it were a reinstatement — bypassing markFeePaid's own
    // capability, which is a different one.
    .eq('fee_type', 'reinstatement')
    .maybeSingle();
  if (!fee) throw new ExpectedError('That reinstatement no longer exists.');

  // Deliberately not an editor for money that is already on the books. This
  // action exists to close a gap, not to make the ledger rewritable: a figure
  // that has been recorded is corrected by an admin who can see the audit
  // trail, not silently overwritten from a list. amount_cents IS NULL is
  // exactly "nobody has said what was collected" — including the rows written
  // before this split existed.
  if (fee.amount_cents != null) {
    throw new ExpectedError('That reinstatement already has a recorded amount.');
  }

  // Only fill a blank. A row written between terms has no season and its money
  // would otherwise stay out of every income figure — the gap 00069 exists to
  // close — but a row that already names a season keeps it: the payment counts
  // toward the season the reinstatement was granted in, not whichever season
  // happens to be active when the paperwork catches up.
  let seasonId = fee.season_id;
  if (seasonId == null) {
    const { data: activeSeason } = await adminClient
      .from('seasons')
      .select('id')
      .eq('active_flag', true)
      .maybeSingle();
    // Same rule as creation: a payment that lands on no season disappears from
    // every season's income and this is the action that was supposed to repair
    // exactly that.
    seasonId = requireActiveSeasonId(activeSeason?.id, 'reinstatement payment');
  }

  const { data: updated, error } = await adminClient
    .from('club_fees')
    .update({
      amount_cents: parsed.amount_cents,
      paid_at: new Date().toISOString(),
      marked_by: admin.id,
      method: parsed.method ?? null,
      reference: parsed.reference ?? null,
      season_id: seasonId,
    })
    .eq('id', parsed.fee_id)
    // Re-checked in the WHERE clause, not just in the read above: two admins
    // recording the same payment from two open tabs would both pass the check
    // and the second would overwrite the first. This way the second update
    // matches no row.
    .is('amount_cents', null)
    // And the row count is checked, because matching no row is not an error in
    // PostgREST. Without this the loser of that race is told the payment was
    // recorded and the audit log gets an entry for an amount the ledger does
    // not hold — a worse lie than the one this action was written to fix.
    .select('id');
  if (error) throw new Error(error.message);
  if (!updated?.length) {
    throw new ExpectedError('Somebody else recorded a payment for that reinstatement first.');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'reinstatement_payment_recorded',
    target_type: 'player',
    target_id: fee.player_id,
    old_value: { amount_cents: null, paid_at: fee.paid_at, method: fee.method, reference: fee.reference },
    new_value: {
      reinstatement_fee_id: fee.id,
      amount_cents: parsed.amount_cents,
      method: parsed.method ?? null,
      reference: parsed.reference ?? null,
      season_id: seasonId,
    },
  }, { playerId: fee.player_id });

  revalidatePath('/fees');
  revalidatePath('/finances');
}
