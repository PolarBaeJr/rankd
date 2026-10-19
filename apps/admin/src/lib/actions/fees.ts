'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  parseOrThrow,
  feeMarkSchema,
  feeWaiveSchema,
  manualFeeSchema,
  namedFeeMarkSchema,
  playerFlagsSchema,
  ExpectedError,
  type FeeMarkInput,
  type FeeWaiveInput,
  type ManualFeeInput,
  type NamedFeeMarkInput,
  type PlayerFlagsInput,
} from '@badminton/shared';
import { isWaivedFee } from '../fee-status';
import { runAction, type ActionResult } from '../action-result';
import { requireCapability } from './_shared';

// The club-fee marker: fee_exempt exempts a member from the club fee. It does
// not affect gameplay, ratings or leaderboards — it only controls the
// fee-collection list.
//
// IT USED TO WRITE is_exec AS WELL, and that made this a second way to hand
// somebody the console: is_exec is one of the three columns admin_access_level
// resolves a level from. Console access is now set in exactly one place —
// /permissions, through setConsoleAccess, which refuses a self-edit, refuses a
// non-admin touching an admin, checks grant closure both before and after, and
// demands a reason — and none of that was reachable from a fee screen. An exec
// who also needs to stop paying is now two decisions in two places, which is
// what they always were.
export async function updatePlayerFlags(playerId: string, flags: PlayerFlagsInput) {
  parseOrThrow(playerFlagsSchema, flags);
  const admin = await requireCapability('fees.playerflags.write');
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient
    .from('players')
    .select('fee_exempt')
    .eq('id', playerId)
    .single();

  const { error } = await adminClient
    .from('players')
    .update({ fee_exempt: flags.fee_exempt })
    .eq('id', playerId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'player_flags_updated',
    target_type: 'player',
    target_id: playerId,
    old_value: oldPlayer,
    new_value: flags,
  }, { playerId });

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
  revalidatePath('/fees');
}

export async function markFeePaid(input: FeeMarkInput) {
  parseOrThrow(feeMarkSchema, input);
  const admin = await requireCapability('fees.clubfees.markpaid.write');
  const adminClient = createAdminClient();

  // Snapshot the amount: use the explicit input if given, else fall back to the
  // season's per-status fee (competitive vs recreational) so the paid row
  // records what was actually owed.
  let amountCents = input.amount_cents ?? null;
  if (amountCents == null) {
    const [{ data: player }, { data: season }] = await Promise.all([
      adminClient.from('players').select('status').eq('id', input.player_id).single(),
      adminClient
        .from('seasons')
        .select('competitive_fee_cents, recreational_fee_cents')
        .eq('id', input.season_id)
        .single(),
    ]);
    amountCents =
      player?.status === 'competitive'
        ? season?.competitive_fee_cents ?? null
        : season?.recreational_fee_cents ?? null;
  }

  // READ, THEN UPDATE OR INSERT — no upsert. This used to be
  // .upsert(…, { onConflict: 'player_id,season_id' }) against
  // club_fees_player_id_season_id_key, and 00094 replaced that constraint with
  // a PARTIAL unique index (… WHERE fee_type = 'dues'), because a member who
  // enters two tournaments in one season is two rows in the same table.
  // PostgREST emits ON CONFLICT (cols) with no index predicate, so a partial
  // index cannot be inferred as the arbiter and the upsert would fail outright.
  //
  // The shape is waiveFee's, a few lines below, for the same reasons it gives:
  // the 23505 branch turns the race into a message rather than a crash.
  //
  // AND NOW THE READ IS WIDE, for the rest of what waiveFee's comment says. It
  // records a production incident about overwriting a recorded payment and
  // guards against it, and this function — twenty lines above it, over the same
  // table, the same row, the same partial index — had the identical hole: the
  // update below replaces amount_cents/method/reference unconditionally, and the
  // audit entry carried no old_value, so a $100 dues row rewritten as $80 lost
  // the $100 in both places at once. Not part of the report that produced the
  // waiver fix; it is the same defect and the same three lines close it.
  const { data: existing } = await adminClient
    .from('club_fees')
    .select('id, player_id, season_id, amount_cents, paid_at, method, reference')
    .eq('player_id', input.player_id)
    .eq('season_id', input.season_id)
    .eq('fee_type', 'dues')
    .maybeSingle();

  // Refuse rather than overwrite. Reversing a season fee is markFeeUnpaid, which
  // keeps the amount and audits it; /fees renders "Mark Unpaid" for a paid row
  // and "Unwaive" for a waived one, so the Mark Paid dialog is never offered
  // over either and no rendered control reaches this branch.
  //
  // A waived row is refused on paid_at alone — see the matching note in
  // tournament-fees.ts. Recording a PAYMENT over a waiver replaces the club's
  // decision not to charge, and that decision is a fact of its own. waiveFee
  // refuses a re-waive on the same test, for a reason of its own: it would
  // rewrite the date the waiver was granted and the officer who granted it.
  if (existing?.paid_at) {
    throw new ExpectedError(
      `That fee is already recorded as ${isWaivedFee(existing) ? 'waived' : `paid ($${((existing.amount_cents ?? 0) / 100).toFixed(2)})`}. ` +
        'Mark it unpaid first if you really mean to record a different payment.',
    );
  }

  const payment = {
    paid_at: new Date().toISOString(),
    marked_by: admin.id,
    amount_cents: amountCents,
    method: input.method ?? null,
    reference: input.reference ?? null,
  };

  let fee: { id: string };
  if (existing) {
    const { data: updated, error } = await adminClient
      .from('club_fees')
      .update(payment)
      .eq('id', existing.id)
      // Only while it is STILL unpaid. The refusal above read a row that another
      // desk may have paid since — the exact race waiveFee's second comment
      // describes — and matching no row is not an error in PostgREST, so the
      // count below is what turns the loss into a message.
      .is('paid_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) {
      throw new ExpectedError(
        'That fee was recorded as paid while you were marking it — most likely another desk got there first. ' +
        'Reload and check before recording it again.',
      );
    }
    fee = updated;
  } else {
    const { data: inserted, error } = await adminClient
      .from('club_fees')
      .insert({
        player_id: input.player_id,
        season_id: input.season_id,
        // Explicit rather than left to the column default. This is the club's
        // season fee, and a row that reached the table without saying so would
        // be indistinguishable from an entry fee to every reader that filters.
        fee_type: 'dues',
        ...payment,
      })
      .select('id')
      .single();
    if (error) {
      // Somebody recorded this member's dues between the read and the insert.
      if (error.code === '23505') {
        throw new ExpectedError(
          'A fee was recorded for this member while you were marking it paid. Reload and check before trying again.',
        );
      }
      throw new Error(error.message);
    }
    fee = inserted;
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'fee_marked_paid',
    target_type: 'club_fee',
    target_id: fee.id,
    // Null on the insert path, where nothing preceded this. fee_waived and
    // fee_marked_unpaid both carry the previous row; this is the third writer of
    // the same columns and was the only one that did not.
    old_value: existing ?? null,
    new_value: {
      player_id: input.player_id,
      season_id: input.season_id,
      amount_cents: amountCents,
      method: input.method ?? null,
      reference: input.reference ?? null,
    },
  }, { playerId: input.player_id });

  revalidatePath('/fees');
}

// One-time waiver of the season fee: recorded as a paid row with
// amount_cents 0 and method 'waived' so income sums stay correct.
// Un-waiving is just markFeeUnpaid.
export async function waiveFee(input: FeeWaiveInput) {
  parseOrThrow(feeWaiveSchema, input);
  const admin = await requireCapability('fees.clubfees.waive.write');
  const adminClient = createAdminClient();

  // Read before writing. The upsert below sets amount_cents to 0, so running it
  // over a row that records a real payment silently erases how much was
  // collected — and the audit entry, written without an old_value, kept no copy
  // of it either. There is a fee_waived row on production with an empty
  // old_value for exactly this reason.
  //
  // Refuse rather than overwrite: reversing a payment is markFeeUnpaid, which
  // preserves the amount and audits it.
  //
  // AN ALREADY-WAIVED ROW IS REFUSED TOO, which it was not until recently. A
  // re-waive was called idempotent, and it is not: the update below writes a
  // fresh paid_at and marked_by, so running it a second time replaces the date
  // the waiver was granted and the officer who granted it with today and
  // whoever clicked. When a fee was waived and by whom is a fact of its own —
  // that is the whole point of recording it — and removing the waiver and
  // granting it again is how to redo the decision on the record.
  //
  // isWaivedFee is still needed: the page renders "Waived" from it, and the
  // refusal below uses it to say which of the two states the row is in.
  const { data: existing } = await adminClient
    .from('club_fees')
    .select('id, player_id, season_id, amount_cents, paid_at, method, reference')
    .eq('player_id', input.player_id)
    .eq('season_id', input.season_id)
    // Dues only. Waiving is a decision about the SEASON FEE; since 00094 the
    // same table also holds this member's entry fees and reinstatements, and
    // without this filter maybeSingle() would throw the moment they had one.
    .eq('fee_type', 'dues')
    .maybeSingle();

  // On paid_at alone, branching only for the wording — the shape markFeePaid
  // twenty lines above already had.
  if (existing?.paid_at) {
    throw new ExpectedError(
      isWaivedFee(existing)
        ? 'That fee is already waived. Remove the waiver first if you really mean to grant it again — ' +
          're-waiving would replace the date it was waived and the officer who waived it.'
        : `That fee is already recorded as paid ($${((existing.amount_cents ?? 0) / 100).toFixed(2)}). ` +
          'Mark it unpaid first if you really mean to waive it — waiving would overwrite the amount with $0.00.',
    );
  }

  // The check above ran against a row that was read a moment ago, and an upsert
  // will happily overwrite whatever is there now. Two desks working the same
  // roster — one recording a $100 payment, one waiving the fee — both saw an
  // unpaid row, and the waiver landed second and replaced a real payment with
  // $0/waived. The refusal above is the message; this is what makes it true.
  //
  // Written as an UPDATE of the unpaid row plus an INSERT for the no-row case,
  // because an upsert cannot carry a condition on the row it is replacing.
  let feeId: string | undefined;
  if (existing) {
    const { data: updated, error: updateError } = await adminClient
      .from('club_fees')
      .update({
        paid_at: new Date().toISOString(),
        marked_by: admin.id,
        amount_cents: 0,
        method: 'waived',
      })
      .eq('id', existing.id)
      // Only while it is STILL unpaid. This used to admit a row whose method
      // was already 'waived' as well, because a re-waive was permitted; the
      // refusal above ends that, so the predicate is now markFeePaid's exactly.
      .is('paid_at', null)
      .select('id')
      .maybeSingle();
    if (updateError) throw new Error(updateError.message);
    if (!updated) {
      throw new ExpectedError(
        'That fee was paid while you were waiving it — most likely another desk got there first. ' +
        'Reload and check before waiving it again.',
      );
    }
    feeId = updated.id;
  } else {
    const { data: inserted, error: insertError } = await adminClient
      .from('club_fees')
      .insert({
        player_id: input.player_id,
        season_id: input.season_id,
        fee_type: 'dues',
        paid_at: new Date().toISOString(),
        marked_by: admin.id,
        amount_cents: 0,
        method: 'waived',
      })
      .select('id')
      .single();
    // 23505 means somebody inserted a fee for this player and season in the
    // window between the read and this insert — which is exactly the payment
    // this must not overwrite.
    if (insertError) {
      if (insertError.code === '23505') {
        throw new ExpectedError(
          'A fee was recorded for this player while you were waiving it. Reload and check before waiving it again.',
        );
      }
      throw new Error(insertError.message);
    }
    feeId = inserted.id;
  }
  const fee = { id: feeId as string };

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'fee_waived',
    target_type: 'club_fee',
    target_id: fee.id,
    old_value: existing ?? null,
    new_value: {
      player_id: input.player_id,
      season_id: input.season_id,
      amount_cents: 0,
      method: 'waived',
    },
  }, { playerId: input.player_id });

  revalidatePath('/fees');
}

export async function markFeeUnpaid(playerId: string, seasonId: string) {
  const admin = await requireCapability('fees.clubfees.markunpaid.write');
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('club_fees')
    .select('id, player_id, season_id, amount_cents, paid_at, method')
    .eq('player_id', playerId)
    .eq('season_id', seasonId)
    // Dues only — this is the /fees roster's Unpaid button, and reversing a
    // season fee must never reach into an entry fee or a reinstatement.
    .eq('fee_type', 'dues')
    .single();
  // EXPECTED, NOT A FAULT. This was a plain Error, and its message is not in
  // EXPECTED_DB_GUARDS, so a member who simply has no dues row was filed in
  // Sentry as a defect. Asking to reverse a fee that was never recorded is an
  // ordinary mistake — a stale roster, or a run over people who have never been
  // billed — and the answer to it is a sentence, not an incident.
  if (!oldFee) {
    throw new ExpectedError(
      'There is no season fee recorded for that member, so there is nothing to reverse.',
    );
  }

  // NOTHING TO REVERSE. Without this the update below clears three fields that
  // are already null, matches its row, reports success, and files a
  // fee_marked_unpaid entry for a reversal that reversed nothing — an audit log
  // that says a payment was undone when there was never a payment is worse than
  // no entry at all, because it is the record somebody would reason from. /fees
  // renders this control only over a paid row ("Mark Unpaid") or a waived one
  // ("Unwaive"), so no rendered control reaches this branch; a stale selection
  // reaches it easily.
  if (oldFee.paid_at === null) {
    throw new ExpectedError('That fee is already unpaid, so there is nothing to reverse.');
  }

  // Keep the row — only clear the payment fields.
  //
  // COMPARE AND SWAP ON THE PAYMENT STATE WE READ. `WHERE id = ...` alone made
  // this a blind write: with two operators on the roster, A opening Mark Unpaid
  // and B recording a corrected payment in between meant A's delayed update
  // erased B's payment — and A's audit row recorded the OLD value, so nothing
  // in the trail showed that a newer payment had been destroyed.
  //
  // One predicate rather than the `.is('paid_at', null)` / `.eq(…)` pair this
  // used to choose between: the refusal above means paid_at was non-null when it
  // was read, so the null arm is unreachable by construction.
  const { data: cleared, error } = await adminClient
    .from('club_fees')
    .update({ paid_at: null, marked_by: null, method: null })
    .eq('id', oldFee.id)
    .eq('paid_at', oldFee.paid_at)
    .select('id');
  if (error) throw new Error(error.message);
  // Zero rows means the predicate no longer held: somebody changed the payment
  // after the read. Refuse rather than retry — the operator has to see the
  // current state before deciding again. Expected for the same reason the
  // not-found above is: losing a race is this guard working, and it was being
  // reported to Sentry as though it were not.
  if (!cleared || cleared.length === 0) {
    throw new ExpectedError('This fee was changed by someone else while you were working on it. Reload and try again.');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'fee_marked_unpaid',
    target_type: 'club_fee',
    target_id: oldFee.id,
    old_value: oldFee,
    new_value: { paid_at: null, marked_by: null, method: null },
  }, { playerId });

  revalidatePath('/fees');
}

// Manual entry: record a club-fee payment for someone who paid without an
// account (a name, no player row). Inserted already-paid against the season.
export async function addManualFee(input: ManualFeeInput) {
  // The parsed email, not input.email: the column CHECK in 00252 refuses
  // anything but the trimmed lowercase form, and the schema is what makes it so.
  const { email } = parseOrThrow(manualFeeSchema, input);
  const admin = await requireCapability('fees.clubfees.addmanual.write');
  const adminClient = createAdminClient();

  // The row goes in already paid, and club_fees_settled_has_amount refuses a
  // paid row without an amount; say so instead of surfacing the constraint.
  if (input.amount_cents == null) {
    throw new ExpectedError('Enter the amount they paid.');
  }

  // A named payment waits for a signup that has not happened yet. If the
  // address already has an account, the claim trigger would never fire for it
  // and the payment would sit as a stranger's row beside the member's own.
  if (email) {
    const { data: existing, error: lookupError } = await adminClient
      .from('players')
      .select('id, full_name')
      .eq('email', email)
      .maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    if (existing) {
      throw new ExpectedError(
        `That email already belongs to ${existing.full_name || 'a member'}. Record their payment on their own profile instead.`,
      );
    }
  }

  const { data: fee, error } = await adminClient
    .from('club_fees')
    .insert({
      player_id: null,
      manual_name: input.manual_name,
      manual_email: email ?? null,
      season_id: input.season_id,
      // A manual entry is somebody paying their SEASON FEE without an account.
      // Entry fees and reinstatements always have a real player row — the shape
      // CHECK in 00094 refuses a manual_name on either — so 'dues' is the only
      // legal value here, said out loud rather than left to the default.
      fee_type: 'dues',
      paid_at: new Date().toISOString(),
      marked_by: admin.id,
      amount_cents: input.amount_cents ?? null,
      method: input.method ?? null,
      reference: input.reference ?? null,
    })
    .select('id')
    .single();
  // club_fees_manual_name_season_key (00065). Manual rows sit outside
  // club_fees_player_id_season_id_key because player_id is NULL there, so until
  // that index existed a double-submit filed the same payment twice and the
  // season income figure — a plain SUM over paid rows — counted it twice.
  // club_fees_manual_email_season_key (00252) is the other unique index a
  // named payment can hit.
  if (error?.code === '23505' && error.message.includes('club_fees_manual_email_season_key')) {
    throw new ExpectedError('A named fee for that email is already on this season, paid or waiting on its receipt.');
  }
  if (error?.code === '23505') {
    throw new ExpectedError(
      `A manual fee for "${input.manual_name}" is already recorded for this season. ` +
        'If this is a different person with the same name, add something to tell them apart.',
    );
  }
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'manual_fee_added',
    target_type: 'club_fee',
    target_id: fee.id,
    new_value: {
      manual_name: input.manual_name,
      manual_email: email ?? null,
      season_id: input.season_id,
      amount_cents: input.amount_cents ?? null,
      method: input.method ?? null,
      reference: input.reference ?? null,
    },
  });

  revalidatePath('/fees');
}

/**
 * Mark a named dues row paid. A Google Form files one unpaid for a non-member
 * (00290), and confirming its receipt under Submitted settles it; this is for
 * the payment that arrived some other way, cash at a session or an e-transfer
 * with no screenshot. Same refusals as markFeePaid: a paid or waived row is
 * left alone, and the write only lands while the row is still unpaid.
 */
export async function markNamedFeePaid(input: NamedFeeMarkInput) {
  parseOrThrow(namedFeeMarkSchema, input);
  const admin = await requireCapability('fees.clubfees.markpaid.write');
  const adminClient = createAdminClient();

  const { data: existing, error: readError } = await adminClient
    .from('club_fees')
    .select('id, manual_name, manual_email, season_id, amount_cents, paid_at, method, reference')
    .eq('id', input.fee_id)
    // Named dues only: the id comes from a rendered table, and a member's row
    // or an entry fee has its own control with its own rules.
    .eq('fee_type', 'dues')
    .is('player_id', null)
    .not('manual_name', 'is', null)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!existing) throw new ExpectedError('That named fee is no longer on this season. Reload and check.');
  if (existing.paid_at) {
    throw new ExpectedError(
      `That fee is already recorded as ${isWaivedFee(existing) ? 'waived' : `paid ($${((existing.amount_cents ?? 0) / 100).toFixed(2)})`}.`,
    );
  }

  // club_fees_settled_has_amount refuses a paid row with no amount.
  const amountCents = input.amount_cents ?? existing.amount_cents;
  if (amountCents == null) throw new ExpectedError('Enter the amount they paid.');

  const payment = {
    paid_at: new Date().toISOString(),
    marked_by: admin.id,
    amount_cents: amountCents,
    method: input.method ?? null,
    reference: input.reference ?? null,
  };
  const { data: updated, error } = await adminClient
    .from('club_fees')
    .update(payment)
    .eq('id', existing.id)
    .is('paid_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!updated) {
    throw new ExpectedError(
      'That fee was recorded as paid while you were marking it, most likely by confirming its receipt. Reload and check.',
    );
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'fee_marked_paid',
    target_type: 'club_fee',
    target_id: existing.id,
    old_value: existing,
    new_value: {
      manual_name: existing.manual_name,
      season_id: existing.season_id,
      amount_cents: amountCents,
      method: input.method ?? null,
      reference: input.reference ?? null,
    },
  });

  revalidatePath('/fees');
}

export async function removeManualFee(id: string) {
  const admin = await requireCapability('fees.clubfees.removemanual.write');
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('club_fees')
    .select('id, manual_name, season_id, amount_cents, paid_at, method')
    .eq('id', id)
    // Manual dues only. This action deletes a row outright, and the id comes
    // from a rendered table — so the filter is what stops a stale or crafted id
    // from destroying an entry fee or a reinstatement through the one control
    // on this page that does not merely edit.
    .eq('fee_type', 'dues')
    .not('manual_name', 'is', null)
    .single();
  if (!oldFee) throw new Error('Fee record not found');

  const { error } = await adminClient.from('club_fees').delete().eq('id', id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'manual_fee_removed',
    target_type: 'club_fee',
    target_id: id,
    old_value: oldFee,
  });

  revalidatePath('/fees');
}

/**
 * Move a named payment onto the member it belongs to.
 *
 * A named payment waits for its member to sign up with the email on it (00252).
 * When they signed up with another address, or it carried none, it sits beside
 * their own row and the season counts them twice; "Paste a list" finds those and
 * this settles one. Both capabilities, because it is both halves: it takes a
 * named payment away and records the member as paid.
 *
 * NO DUES ROW FOR THE MEMBER: the named row itself becomes theirs, which is
 * exactly the claim trigger's UPDATE (player_id set, the name and email cleared,
 * as club_fees_check wants). AN UNPAID ONE: the payment is copied onto it and
 * the named row deleted, in that order, so a failure between the two leaves the
 * money counted twice rather than lost. A PAID OR WAIVED ONE is refused: the
 * named payment is then the second record of one payment, and removing it is
 * the exec's call. AN UNPAID NAMED ROW (a Google Form files one for a
 * non-member's screenshot, 00290) is not merged either: there is no payment to
 * copy, and deleting the row would take the receipt waiting on it.
 */
export async function attachNamedPayment(
  feeId: unknown,
  playerId: unknown,
): Promise<ActionResult<{ playerName: string; moved: 'attached' | 'merged' }>> {
  return runAction(async () => {
    const id = parseOrThrow(z.string().uuid(), feeId);
    const memberId = parseOrThrow(z.string().uuid(), playerId);
    const admin = await requireCapability('fees.clubfees.addmanual.write');
    await requireCapability('fees.clubfees.markpaid.write');
    const adminClient = createAdminClient();

    const { data: named, error: namedError } = await adminClient
      .from('club_fees')
      .select('id, season_id, player_id, manual_name, manual_email, paid_at, marked_by, amount_cents, method, reference')
      .eq('id', id)
      .eq('fee_type', 'dues')
      .is('player_id', null)
      .maybeSingle();
    if (namedError) throw new Error(namedError.message);
    if (!named || named.manual_name == null) {
      throw new ExpectedError('That named payment is no longer there, or has already moved onto a member. Reload and check.');
    }

    const { data: player, error: playerError } = await adminClient
      .from('players')
      .select('id, full_name, email')
      .eq('id', memberId)
      .maybeSingle();
    if (playerError) throw new Error(playerError.message);
    if (!player || (player.email ?? '').toLowerCase().endsWith('@deleted.invalid')) {
      throw new ExpectedError('That member no longer exists. Reload and check.');
    }
    const playerName = player.full_name || 'the member';

    const { data: existing, error: existingError } = await adminClient
      .from('club_fees')
      .select('id, player_id, season_id, amount_cents, paid_at, method, reference')
      .eq('player_id', memberId)
      .eq('season_id', named.season_id)
      .eq('fee_type', 'dues')
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);

    if (existing?.paid_at) {
      throw new ExpectedError(
        `${playerName}'s fee is already recorded as ${isWaivedFee(existing) ? 'waived' : 'paid'}, so moving this payment onto them would count it twice. ` +
          'Remove the named payment instead if it is the same payment.',
      );
    }
    if (existing && !named.paid_at) {
      throw new ExpectedError(
        `"${named.manual_name}" is not paid yet and ${playerName} already has a fee this season. ` +
          'Settle its receipt under Submitted first, then move it.',
      );
    }

    const payment = {
      paid_at: named.paid_at,
      marked_by: named.marked_by,
      amount_cents: named.amount_cents,
      method: named.method,
      reference: named.reference,
    };
    const audit = (targetId: string, moved: 'attached' | 'merged') =>
      logAdminAudit(adminClient, {
        actor_id: admin.id,
        action_type: 'manual_fee_attached',
        target_type: 'club_fee',
        target_id: targetId,
        old_value: { named_fee: named, member_fee: existing ?? null },
        new_value: { player_id: memberId, season_id: named.season_id, fee_id: targetId, moved, ...payment },
      }, { playerId: memberId });

    if (!existing) {
      const { data: attached, error } = await adminClient
        .from('club_fees')
        .update({ player_id: memberId, manual_name: null, manual_email: null })
        .eq('id', named.id)
        .is('player_id', null)
        .select('id')
        .maybeSingle();
      if (error?.code === '23505') {
        throw new ExpectedError(
          `A fee was recorded for ${playerName} while you were moving this payment. Reload and check before trying again.`,
        );
      }
      if (error) throw new Error(error.message);
      if (!attached) {
        throw new ExpectedError('That named payment was changed while you were moving it. Reload and check.');
      }
      await audit(named.id, 'attached');
      revalidatePath('/fees');
      return { playerName, moved: 'attached' as const };
    }

    // Onto their unpaid row first, only while it is still unpaid.
    const { data: paid, error: payError } = await adminClient
      .from('club_fees')
      .update(payment)
      .eq('id', existing.id)
      .is('paid_at', null)
      .select('id')
      .maybeSingle();
    if (payError) throw new Error(payError.message);
    if (!paid) {
      throw new ExpectedError(
        `${playerName}'s fee was recorded while you were moving this payment. Nothing was moved. Reload and check.`,
      );
    }

    // Then the named row. Matching nothing is not an error in PostgREST, so the
    // returned rows are what say it went.
    const { data: removed, error: removeError } = await adminClient
      .from('club_fees')
      .delete()
      .eq('id', named.id)
      .is('player_id', null)
      .select('id');
    await audit(existing.id, 'merged');
    revalidatePath('/fees');
    if (removeError || !removed || removed.length === 0) {
      throw new Error(
        `The payment is now on ${playerName}'s fee, but the named payment "${named.manual_name}" could not be removed, ` +
          'so it is counted twice. Remove it from the named payments on /fees.',
      );
    }
    return { playerName, moved: 'merged' as const };
  });
}
