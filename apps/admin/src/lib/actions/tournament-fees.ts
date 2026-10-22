'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  feeTierSchema,
  tournamentFeeMarkSchema,
  type FeeTierInput,
  type TournamentFeeMarkInput,
  ExpectedError,
} from '@badminton/shared';
import { requireCapability } from './_shared';
import { scheduleManagedFormSync } from '../managed-forms';

/**
 * Move the "default" flag onto one tier, restoring the old one if it fails.
 *
 * uq_tournament_fee_tiers_default (00002) is a partial unique index, so this is
 * necessarily two statements with no transaction around them. Between them the
 * tournament has no default tier, and a failure on the second one used to leave
 * it that way permanently. The compensating update puts the previous default
 * back, so the visible outcome of a failure is "the change did not take" rather
 * than the silent "this tournament now prices unlisted players at nothing".
 *
 * If the restore itself fails there is nothing left to try; Sentry and an
 * explicit message are the only honest options, because the state that survives
 * is the one nobody would think to look for.
 */
async function promoteDefaultTier(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  tierId: string,
) {
  const { data: previous } = await adminClient
    .from('tournament_fee_tiers')
    .select('id')
    .eq('tournament_id', tournamentId)
    .eq('is_default', true)
    .neq('id', tierId)
    .maybeSingle();

  if (previous) {
    const { error: clearError } = await adminClient
      .from('tournament_fee_tiers')
      .update({ is_default: false })
      .eq('id', previous.id);
    if (clearError) throw new Error(clearError.message);
  }

  const { data: promoted, error: setError } = await adminClient
    .from('tournament_fee_tiers')
    .update({ is_default: true })
    .eq('id', tierId)
    // Matching no row is not an error in PostgREST, and "no row" is reachable:
    // the tier can be deleted between the clear above and this update. Without
    // the count check that path returns success having left the tournament with
    // no default at all — the exact outcome this function exists to prevent.
    .select('id');
  if (!setError && promoted?.length) return;

  const reason = setError ? setError.message : 'the fee tier no longer exists';

  if (previous) {
    const { error: restoreError } = await adminClient
      .from('tournament_fee_tiers')
      .update({ is_default: true })
      .eq('id', previous.id);
    if (restoreError) {
      Sentry.captureException(
        new Error(`Tournament left with no default fee tier: ${reason} (restore: ${restoreError.message})`),
        { extra: { tournamentId, tierId, previousDefaultId: previous.id } },
      );
      throw new Error(
        'The default fee tier could not be changed, and the previous default could not be restored — ' +
        'this tournament now has no default tier. Set one from the fees page.',
      );
    }
  }
  throw new Error(reason);
}

export async function createFeeTier(input: FeeTierInput) {
  parseOrThrow(feeTierSchema, input);
  const admin = await requireCapability('tournaments.fees.tier.create.write');
  const adminClient = createAdminClient();

  // Create the tier as a NON-default first, then move the default onto it.
  //
  // The old order cleared the tournament's existing default and only then
  // inserted — so an insert that failed UNIQUE(tournament_id, name) reported
  // failure and left the tournament with no default tier at all. Nothing in the
  // console says "this tournament lost its default"; it just starts pricing
  // unlisted players at nothing, and markTournamentFeePaid snapshots a null
  // amount. Doing the write that can fail on its own data FIRST means a
  // rejected name changes nothing.
  //
  // uq_tournament_fee_tiers_default (00002) is a partial unique index on
  // tournament_id WHERE is_default, so the flip genuinely has to be
  // clear-then-set; it cannot be one statement through PostgREST.
  const { data: tier, error } = await adminClient
    .from('tournament_fee_tiers')
    .insert({
      tournament_id: input.tournament_id,
      name: input.name,
      amount_cents: input.amount_cents,
      // Which memberships this tier prices (00094). `?? null` and not omitted:
      // null is the meaningful value — "anyone" — and leaving the key out would
      // work only because the column happens to default to it.
      applies_to: input.applies_to ?? null,
      is_default: false,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  if (input.is_default) {
    try {
      await promoteDefaultTier(adminClient, input.tournament_id, tier.id);
    } catch (err) {
      // The tier itself was created; only the default flag failed to move.
      // Push the fresh list before rethrowing and say so plainly — otherwise
      // the admin reads "failed" on a stale page, retries the same name, and
      // gets a duplicate-key error for a tier they believe was never made.
      revalidatePath(`/tournaments/${input.tournament_id}/fees`);
      throw new Error(
        `"${input.name}" was created, but could not be made the default tier: ` +
        (err instanceof Error ? err.message : 'unknown error'),
      );
    }
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_tier_created',
    target_type: 'tournament_fee_tier',
    target_id: tier.id,
    new_value: input,
  }, { tournamentId: input.tournament_id });

  revalidatePath(`/tournaments/${input.tournament_id}/fees`);
  // The fee tiers are the payment text on the tournament's made Form (00296).
  scheduleManagedFormSync('tournament', input.tournament_id);
}

export async function updateFeeTier(id: string, input: Partial<FeeTierInput>) {
  parseOrThrow(feeTierSchema.partial(), input);
  const admin = await requireCapability('tournaments.fees.tier.update.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient
    .from('tournament_fee_tiers')
    .select('*')
    .eq('id', id)
    .single();
  if (!old) throw new Error('Fee tier not found');

  // Same ordering as createFeeTier, and for the same reason: the field update
  // is the one that can fail on UNIQUE(tournament_id, name), so it goes first
  // and a rejected rename leaves the tournament's existing default alone.
  // Clearing it up front meant a rename to an already-used name reported
  // failure AND silently removed the default.
  //
  // tournament_id is dropped rather than applied. feeTierSchema.partial()
  // accepts it, so this action would happily move a tier to another
  // tournament — and every entry-fee row already pointing at that tier
  // would silently become a cross-tournament reference, which is the same
  // corruption markTournamentFeePaid now refuses to create. A tier belongs to
  // the tournament it was made for; renaming and repricing are the edits.
  const { is_default: wantsDefault, tournament_id: _ignored, ...fields } = input;
  const changes = wantsDefault === false ? { ...fields, is_default: false } : fields;
  if (Object.keys(changes).length > 0) {
    const { error } = await adminClient.from('tournament_fee_tiers').update(changes).eq('id', id);
    if (error) throw new Error(error.message);
  }

  if (wantsDefault === true) {
    await promoteDefaultTier(adminClient, old.tournament_id, id);
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_tier_updated',
    target_type: 'tournament_fee_tier',
    target_id: id,
    old_value: old,
    // What was actually written, not what was asked for. Logging `input` would
    // record the tournament_id move that this action deliberately refuses —
    // an audit trail claiming a change that never happened.
    new_value: { ...changes, ...(wantsDefault === true ? { is_default: true } : {}) },
  }, { tournamentId: old.tournament_id });

  revalidatePath(`/tournaments/${old.tournament_id}/fees`);
  scheduleManagedFormSync('tournament', old.tournament_id);
}

export async function deleteFeeTier(id: string) {
  const admin = await requireCapability('tournaments.fees.tier.delete.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient
    .from('tournament_fee_tiers')
    .select('*')
    .eq('id', id)
    .single();
  if (!old) throw new Error('Fee tier not found');

  const { error } = await adminClient.from('tournament_fee_tiers').delete().eq('id', id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_tier_deleted',
    target_type: 'tournament_fee_tier',
    target_id: id,
    old_value: old,
  }, { tournamentId: old.tournament_id });

  revalidatePath(`/tournaments/${old.tournament_id}/fees`);
  scheduleManagedFormSync('tournament', old.tournament_id);
}

export async function markTournamentFeePaid(input: TournamentFeeMarkInput) {
  parseOrThrow(tournamentFeeMarkSchema, input);
  const admin = await requireCapability('tournaments.fees.markpaid.write');
  const adminClient = createAdminClient();

  // READ, THEN UPDATE OR INSERT — see the note in actions/fees.ts. 00094's
  // uniqueness is a partial index (… WHERE fee_type = 'tournament'), which
  // PostgREST cannot infer as an upsert arbiter.
  //
  // THE WHOLE ROW, not just the id, and for the reason waiveFee gives at length:
  // the update below replaces amount_cents, tier_id, method and reference, so
  // running it over a row that already records a payment erases what was
  // collected — and the audit entry, written with no old_value, kept no copy of
  // it either. waiveFee's comment names a fee_waived row on production with an
  // empty old_value for exactly that. This is the same defect at the entry-fee
  // desk, where the numbers are per-tournament and a tier fallback can silently
  // substitute a different price for the one that was taken.
  const { data: existing } = await adminClient
    .from('club_fees')
    .select('id, tier_id, amount_cents, paid_at, method, reference')
    .eq('tournament_id', input.tournament_id)
    .eq('player_id', input.player_id)
    .eq('fee_type', 'tournament')
    .maybeSingle();

  // REFUSE RATHER THAN OVERWRITE, the same choice waiveFee made. Reversing a
  // recorded entry fee is markTournamentFeeUnpaid, which preserves the amount
  // and audits it with an old_value; there is no correction workflow that goes
  // through here, and the fees page proves it — TournamentFeeActions renders
  // "Mark Unpaid" for a paid row and "Unwaive" for a waived one, never the Mark
  // Paid dialog, so no rendered control reaches this branch. (The waived half of
  // that was NOT true until recently: `paid` is false for a waiver, so the page
  // offered "Mark Paid" on a waived row and the only possible outcome was the
  // error below.) A server action is a public endpoint, though,
  // and a stale tab is a client that still thinks the row is unpaid.
  //
  // A WAIVED ROW IS REFUSED TOO. isWaivedFee is paid_at plus method 'waived',
  // which this test catches on paid_at alone — deliberately. Marking a waived
  // entry PAID would replace the club's record that it had decided not to
  // charge, which is a different fact and not one to lose silently. waiveFee
  // refuses a re-waive on the same test, for a reason of its own: writing
  // $0/waived over $0/waived is not the no-op it looks like, because it rewrites
  // paid_at and marked_by along with them.
  if (existing?.paid_at) {
    throw new ExpectedError(
      `That entry fee is already recorded as paid ($${((existing.amount_cents ?? 0) / 100).toFixed(2)}). ` +
        'Mark it unpaid first if you really mean to record a different payment.',
    );
  }

  // Snapshot the amount: explicit input, else the chosen tier's amount, else
  // whatever the existing row already holds, else the tournament's default
  // tier's amount. Records the tier that determined it.
  //
  // DERIVED AFTER `existing` IS READ, and the row's own snapshot now outranks
  // the default tier. This used to sit above that read, so a caller naming
  // NEITHER a tier nor an amount fell through to the tournament's is_default
  // tier and the update below wrote it over whatever the row held. But a caller
  // who names neither field is asking to record payment of the amount already
  // on the row — not to have a price re-derived from scratch — and re-deriving
  // is exactly what substituted the default: ensureEntryFees seeds these rows
  // from the member's REAL tier, so a $15 internal member's unpaid row came back
  // priced at the $25 external default, silently, with the audit entry agreeing.
  //
  // The dialog already works this way — quoteEntryFee prefills it off the ledger
  // row precisely because "the ledger outranks the tier list", and this is the
  // server finally agreeing with it rather than contradicting it one layer down.
  // It was reachable from the UI, narrowly: the Amount field is optional, so
  // clearing it on a row that carries no tier_id sent neither field and re-priced
  // the row from the default. A loop over a roster sends neither by default.
  let tierId = input.tier_id ?? null;
  let amountCents = input.amount_cents ?? null;

  if (tierId) {
    // club_fees.tier_id is a plain FK to tournament_fee_tiers(id)
    // (00001), which constrains the tier to exist and nothing more — a tier
    // belonging to a DIFFERENT tournament is a perfectly valid row as far as
    // Postgres is concerned. The lookup used to be keyed on the id alone, so
    // passing tournament B's tier id while marking a fee for tournament A
    // copied B's price onto A's fee and stored B's tier against it. This
    // filters on the pair, so a tier from another tournament simply is not
    // found.
    //
    // Checked whenever a tier is named, not only when the amount has to be
    // derived from it. The old code skipped the lookup entirely when an
    // explicit amount was supplied, which meant the one input path that never
    // validated the tier was also the one that stored it verbatim.
    const { data: tier } = await adminClient
      .from('tournament_fee_tiers')
      .select('id, amount_cents')
      .eq('id', tierId)
      .eq('tournament_id', input.tournament_id)
      .maybeSingle();
    if (!tier) throw new ExpectedError('That fee tier does not belong to this tournament.');
    if (amountCents == null) amountCents = tier.amount_cents;
  } else if (amountCents == null && existing?.amount_cents != null) {
    // The row's own price, and the tier that set it — including a null tier_id,
    // which is a row priced without one rather than a row waiting for a price.
    tierId = existing.tier_id;
    amountCents = existing.amount_cents;
  } else if (amountCents == null) {
    const { data: tier } = await adminClient
      .from('tournament_fee_tiers')
      .select('id, amount_cents')
      .eq('tournament_id', input.tournament_id)
      .eq('is_default', true)
      .maybeSingle();
    tierId = tier?.id ?? null;
    amountCents = tier?.amount_cents ?? null;
  }

  // WHICH SEASON THIS MONEY COUNTS TOWARD, stamped on rather than joined.
  // Entry fees used to reach a season through tournaments.season_id at read
  // time; club_fees carries the season itself, the same rule 00069 arrived at
  // for reinstatements and 00073 built in from the start. Nullable, because
  // tournaments.season_id is (00001) — a tournament outside every season is a
  // real row, and refusing to record its money would be worse than recording it
  // unattached.
  const { data: tournament } = await adminClient
    .from('tournaments')
    .select('season_id')
    .eq('id', input.tournament_id)
    .maybeSingle();

  const payment = {
    tier_id: tierId,
    amount_cents: amountCents,
    paid_at: new Date().toISOString(),
    marked_by: admin.id,
    method: input.method ?? null,
    reference: input.reference ?? null,
  };

  let fee: { id: string };
  if (existing) {
    const { data: updated, error } = await adminClient
      .from('club_fees')
      .update(payment)
      .eq('id', existing.id)
      // The refusal above ran against a row read a moment ago, and an unguarded
      // UPDATE overwrites whatever is there NOW. Two desks working one
      // tournament — one taking $25 at the door, one recording the $15 member
      // tier — both see an unpaid row, and the second write replaces a real
      // payment with a different figure. This is what makes the refusal true
      // rather than advisory, and it is the same predicate waiveFee carries.
      .is('paid_at', null)
      // Matching no row is not an error in PostgREST, so the count is what
      // detects the lost race. Without it the loser is told the payment was
      // recorded and the audit log gets a row for money the ledger does not
      // hold — a worse lie than the overwrite.
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) {
      throw new ExpectedError(
        'That entry fee was recorded as paid while you were marking it — most likely another desk got there first. ' +
        'Reload and check before recording it again.',
      );
    }
    fee = updated;
  } else {
    const { data: inserted, error } = await adminClient
      .from('club_fees')
      .insert({
        fee_type: 'tournament',
        tournament_id: input.tournament_id,
        player_id: input.player_id,
        season_id: tournament?.season_id ?? null,
        ...payment,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ExpectedError(
          'An entry fee was recorded for this player while you were marking it paid. Reload and check before trying again.',
        );
      }
      throw new Error(error.message);
    }
    fee = inserted;
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_marked_paid',
    target_type: 'tournament_fee',
    target_id: fee.id,
    // What the row held before. Null on the insert path, where there was no
    // previous figure to lose. markTournamentFeeUnpaid a few lines below has
    // always carried this; the paid direction is the one that can destroy a
    // number, so it is the one that needed it more.
    old_value: existing ?? null,
    new_value: {
      tournament_id: input.tournament_id,
      player_id: input.player_id,
      tier_id: tierId,
      amount_cents: amountCents,
      method: input.method ?? null,
      reference: input.reference ?? null,
    },
  }, { tournamentId: input.tournament_id, playerId: input.player_id });

  revalidatePath(`/tournaments/${input.tournament_id}/fees`);
}

export async function markTournamentFeeUnpaid(tournamentId: string, playerId: string) {
  const admin = await requireCapability('tournaments.fees.markunpaid.write');
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('club_fees')
    .select('id, tournament_id, player_id, tier_id, amount_cents, paid_at, method')
    .eq('tournament_id', tournamentId)
    .eq('player_id', playerId)
    .eq('fee_type', 'tournament')
    .single();
  // EXPECTED, NOT A FAULT — the same three changes markFeeUnpaid took in
  // actions/fees.ts, applied to its mirror here. This was a plain Error, and its
  // message is not in EXPECTED_DB_GUARDS, so an entrant who simply has no
  // entry-fee row was filed in Sentry as a defect. A bulk bar loops this action
  // over a whole roster, which makes "somebody on the list has no row" the
  // ordinary case rather than a corner of it.
  if (!oldFee) {
    throw new ExpectedError(
      'There is no entry fee recorded for that member, so there is nothing to reverse.',
    );
  }

  // NOTHING TO REVERSE. Without this the update below clears three fields that
  // are already null, matches its row, reports success, and files a
  // tournament_fee_marked_unpaid entry for a reversal that reversed nothing — an
  // audit log that says a payment was undone when there was never a payment is
  // worse than no entry at all, because it is the record somebody would reason
  // from. The page renders this control only over a paid row ("Mark Unpaid") or
  // a waived one ("Unwaive"), so no rendered control reaches this branch; a
  // stale selection reaches it easily. Same wording as the dues-side twin.
  if (oldFee.paid_at === null) {
    throw new ExpectedError('That entry fee is already unpaid, so there is nothing to reverse.');
  }

  // The row STAYS, with only the payment fields cleared — the entry itself is
  // still a fact, and the member still owes for it. Same as markFeeUnpaid,
  // including the compare-and-swap: see the comment there for why an unguarded
  // `WHERE id = ...` lets a stale Mark Unpaid erase a newer payment without
  // leaving any sign of it in the audit trail.
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
  if (!cleared || cleared.length === 0) {
    // Expected for the same reason the not-found above is: losing a race is this
    // guard working, and it was being reported to Sentry as though it were not.
    throw new ExpectedError('This fee was changed by someone else while you were working on it. Reload and try again.');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_marked_unpaid',
    target_type: 'tournament_fee',
    target_id: oldFee.id,
    old_value: oldFee,
    new_value: { paid_at: null, marked_by: null, method: null },
  }, { tournamentId, playerId });

  revalidatePath(`/tournaments/${tournamentId}/fees`);
}
