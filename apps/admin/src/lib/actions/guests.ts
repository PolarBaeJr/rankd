'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ExpectedError, parseOrThrow } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { runAction, type ActionResult } from '../action-result';
import { logAdminAudit } from '../audit';
import { isAdminActor } from '../player-field-access';

// A guest (00292) is a Google Form entrant given a record so they could play a
// linked tournament. They cannot sign in, so they cannot delete or export their
// own data the way a member does: an exec does it for them on a request to the
// privacy address. Export is a download from the member app, which holds the
// export assembler; erasing is here.

const PROOF_BUCKET = 'fee-proofs';

/**
 * Erases a guest: their e-transfer screenshots from storage, then erase_guest,
 * which keeps the record under "Former guest#..." and scrubs the rest. The
 * screenshots go first and their paths are nulled after, so a failed removal
 * leaves the paths to try again with, as eraseFormReceiptScreenshot does.
 */
export async function eraseGuest(playerId: string): Promise<ActionResult<{ label: string }>> {
  return runAction(() => eraseGuestImpl(playerId));
}

async function eraseGuestImpl(playerId: string): Promise<{ label: string }> {
  const actor = await requireCapability('players.remove.write');
  parseOrThrow(z.string().uuid(), playerId);
  const adminClient = createAdminClient();

  const { data: guest, error: guestError } = await adminClient
    .from('players')
    .select('id, is_guest, user_id')
    .eq('id', playerId)
    .maybeSingle();
  if (guestError) throw new Error(`Could not read the guest: ${guestError.message}`);
  if (!guest) throw new ExpectedError('That record no longer exists.');
  if (!guest.is_guest || guest.user_id) throw new ExpectedError('Only a guest is erased here.');

  // Every screenshot of theirs: receipts on their fees, and Form uploads from
  // their responses, filed or not.
  const [fees, entries] = await Promise.all([
    adminClient.from('club_fees').select('id').eq('player_id', playerId),
    adminClient.from('registration_import_entries').select('import_id').eq('entrant_id', playerId),
  ]);
  if (fees.error) throw new Error(`Could not read the guest's fees: ${fees.error.message}`);
  if (entries.error) throw new Error(`Could not read the guest's Form entries: ${entries.error.message}`);
  const feeIds = (fees.data ?? []).map((row) => row.id as string);
  const importIds = [...new Set((entries.data ?? []).map((row) => row.import_id as string))];

  const submissions = await adminClient
    .from('fee_submissions')
    .select('id, screenshot_path')
    .or([`player_id.eq.${playerId}`, ...(feeIds.length ? [`club_fee_id.in.(${feeIds.join(',')})`] : [])].join(','))
    .not('screenshot_path', 'is', null);
  if (submissions.error) throw new Error(`Could not read the guest's receipts: ${submissions.error.message}`);
  const uploads = importIds.length
    ? await adminClient
        .from('registration_import_receipts')
        .select('id, storage_path')
        .in('import_id', importIds)
        .not('storage_path', 'is', null)
    : { data: [] as { id: string; storage_path: string }[], error: null };
  if (uploads.error) throw new Error(`Could not read the guest's Form uploads: ${uploads.error.message}`);

  const submissionRows = (submissions.data ?? []) as { id: string; screenshot_path: string }[];
  const uploadRows = (uploads.data ?? []) as { id: string; storage_path: string }[];
  const paths = [...new Set([...submissionRows.map((r) => r.screenshot_path), ...uploadRows.map((r) => r.storage_path)])];
  if (paths.length > 0) {
    const { error: removeError } = await adminClient.storage.from(PROOF_BUCKET).remove(paths);
    if (removeError) throw new Error(`The guest was not erased: a screenshot could not be removed: ${removeError.message}`);
    if (submissionRows.length > 0) {
      const { error } = await adminClient
        .from('fee_submissions')
        .update({ screenshot_path: null })
        .in('id', submissionRows.map((r) => r.id));
      if (error) throw new Error(`The screenshots were removed but a receipt still names one: ${error.message}`);
    }
    if (uploadRows.length > 0) {
      const { error } = await adminClient
        .from('registration_import_receipts')
        .update({ storage_path: null })
        .in('id', uploadRows.map((r) => r.id));
      if (error) throw new Error(`The screenshots were removed but a Form upload still names one: ${error.message}`);
    }
  }

  const { data, error } = await adminClient.rpc('erase_guest', {
    p_player_id: playerId,
    p_actor_id: actor.id as string,
  });
  if (error) throw new Error(`The guest was not erased: ${error.message}`);
  const result = data as { ok: boolean; reason?: string; label?: string } | null;
  if (!result?.ok || !result.label) {
    if (result?.reason === 'not_a_guest') throw new ExpectedError('Only a guest is erased here.');
    if (result?.reason === 'not_found') throw new ExpectedError('That record no longer exists.');
    throw new Error(`The guest was not erased: ${result?.reason ?? 'no answer'}`);
  }

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
  return { label: result.label };
}

// Making a guest a member without them signing in (00292). An admin does it,
// after a confirm in the console; an exec can only ask, and the ask waits on the
// record for an admin to confirm or decline. Signing in with the Form's email
// still makes them a member on its own, with no one asked.

async function readGuest(adminClient: ReturnType<typeof createAdminClient>, playerId: string) {
  parseOrThrow(z.string().uuid(), playerId);
  const { data, error } = await adminClient
    .from('players')
    .select('id, is_guest, email, guest_member_requested_by')
    .eq('id', playerId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the guest: ${error.message}`);
  if (!data) throw new ExpectedError('That record no longer exists.');
  if (!data.is_guest) throw new ExpectedError('They are already a member.');
  if ((data.email as string | null)?.endsWith('@deleted.invalid')) {
    throw new ExpectedError('This guest was erased.');
  }
  return data as { id: string; guest_member_requested_by: string | null };
}

export async function makeGuestMember(playerId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(() => makeGuestMemberImpl(playerId, reason));
}

async function makeGuestMemberImpl(playerId: string, reason: string): Promise<void> {
  const actor = await requireCapability('players.update.write');
  if (!isAdminActor(actor)) {
    throw new ExpectedError('Only an admin can make a guest a member. Ask one from the guest\'s row.');
  }
  const why = parseOrThrow(z.string().trim().min(1, 'Say why they are being made a member.').max(500), reason);
  const adminClient = createAdminClient();
  await readGuest(adminClient, playerId);
  const { data, error } = await adminClient.rpc('make_guest_member', {
    p_player_id: playerId,
    p_actor_id: actor.id,
    p_reason: why,
  });
  if (error) throw new Error(error.message);
  const result = data as { ok: boolean; reason?: string };
  if (!result.ok) throw new ExpectedError(`Not made a member (${result.reason}).`);
  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
}

export async function requestGuestMembership(playerId: string): Promise<ActionResult<void>> {
  return runAction(() => setGuestMembershipRequest(playerId, true));
}

export async function declineGuestMembership(playerId: string): Promise<ActionResult<void>> {
  return runAction(() => setGuestMembershipRequest(playerId, false));
}

async function setGuestMembershipRequest(playerId: string, asking: boolean): Promise<void> {
  const actor = await requireCapability('players.update.write');
  // Declining is the admin's half of the decision.
  if (!asking && !isAdminActor(actor)) throw new ExpectedError('Only an admin can decline this.');
  const adminClient = createAdminClient();
  const guest = await readGuest(adminClient, playerId);
  if (asking && guest.guest_member_requested_by) {
    throw new ExpectedError('An admin has already been asked.');
  }

  const { error } = await adminClient
    .from('players')
    .update(asking
      ? { guest_member_requested_by: actor.id, guest_member_requested_at: new Date().toISOString() }
      : { guest_member_requested_by: null, guest_member_requested_at: null })
    .eq('id', playerId)
    .eq('is_guest', true);
  if (error) throw new Error(error.message);

  // Two literal calls, not a ternary: the audit-policy drift test reads the
  // action names straight off the source.
  if (asking) {
    await logAdminAudit(adminClient, {
      actor_id: actor.id,
      action_type: 'guest_membership_requested',
      target_type: 'player',
      target_id: playerId,
      reason: 'Asked an admin to make this guest a member',
    });
  } else {
    await logAdminAudit(adminClient, {
      actor_id: actor.id,
      action_type: 'guest_membership_declined',
      target_type: 'player',
      target_id: playerId,
      reason: 'Declined making this guest a member',
    });
  }
  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
}
