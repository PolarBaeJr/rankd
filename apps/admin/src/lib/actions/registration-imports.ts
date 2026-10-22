'use server';

import { z } from 'zod';
import { ExpectedError, parseOrThrow } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { logAdminAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { formMappingSchema } from '../registration-form-mapping';
import {
  bindSchema,
  insertBinding,
  revalidateTarget,
  storedTarget,
  switchBinding,
  updateCapabilityFor,
  writeMapping,
  type BindFormInput,
  type StoredBinding,
} from '../registration-form-binding';

// GOOGLE FORM REGISTRATIONS (00283, 00284): the console's writes.
//
// EVERY EXPORTED PARAMETER BELOW IS A CLIENT-CONTROLLED POST FIELD. Ids are
// uuid-checked, the binding body is a strict schema, created_by is the actor
// requireCapability resolved, and the capability asked for is the one that
// governs the TARGET as the database records it, never as the client says.
//
// No new capability. Binding a form is editing the tournament or club event it
// fills; undoing an entry is removing that entry, with the remove capability
// of the field it is in. A season's form (00290) files dues receipts, so it is
// bound by whoever may mark club fees paid.

const uuid = z.string().uuid();

export type { BindFormInput };

export async function bindRegistrationForm(input: BindFormInput): Promise<ActionResult> {
  return runAction(() => bindImpl(input));
}

async function bindImpl(input: BindFormInput): Promise<void> {
  const parsed = parseOrThrow(bindSchema, input);
  const actor = await requireCapability(updateCapabilityFor(parsed.targetKind));
  const admin = createAdminClient();
  await insertBinding(admin, actor.id as string, parsed, { active: true });
}

export async function setRegistrationFormActive(bindingId: string, active: boolean): Promise<ActionResult> {
  return runAction(() => setActiveImpl(bindingId, active));
}

async function setActiveImpl(bindingId: string, active: boolean): Promise<void> {
  const id = parseOrThrow(uuid, bindingId);
  const on = parseOrThrow(z.boolean(), active);
  const admin = createAdminClient();
  const { data: binding, error } = await admin
    .from('registration_import_forms')
    .select('id, target_kind, tournament_id, club_event_id, season_id, active')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the binding: ${error.message}`);
  if (!binding) throw new ExpectedError('That form binding no longer exists.');
  const { kind } = storedTarget(binding);
  const actor = await requireCapability(updateCapabilityFor(kind));
  await switchBinding(admin, actor.id as string, binding as StoredBinding, on);
}

// ---- READING THE FORM WITH GOOGLE (00287) ----------------------------------
// The question mapping turns the console's reader on for a binding (null turns
// it off, and the form's Apps Script may post it again). The target is the one
// the binding row records, never one the client names, and every event id in
// the mapping must be an event of that tournament (or the club event itself).
// Saving resets the watermark, so the next read goes over every response
// again: unchanged ones replay, ones the old mapping got wrong are edits.

export async function saveRegistrationFormMapping(bindingId: string, mapping: unknown): Promise<ActionResult> {
  return runAction(() => saveMappingImpl(bindingId, mapping));
}

async function saveMappingImpl(bindingId: string, mapping: unknown): Promise<void> {
  const id = parseOrThrow(uuid, bindingId);
  const parsed = mapping === null ? null : parseOrThrow(formMappingSchema, mapping);
  const admin = createAdminClient();
  const { data: binding, error } = await admin
    .from('registration_import_forms')
    .select('id, target_kind, tournament_id, club_event_id, season_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the binding: ${error.message}`);
  if (!binding) throw new ExpectedError('That form binding no longer exists.');
  const { kind } = storedTarget(binding);
  const actor = await requireCapability(updateCapabilityFor(kind));
  await writeMapping(admin, actor.id as string, binding as StoredBinding, parsed);
}

const UNDO_REFUSALS: Record<string, string> = {
  not_found: 'That entry no longer exists.',
  entry_not_found: 'That entry no longer exists.',
  not_live: 'That entry is no longer live.',
  draw_exists: 'The draw has been made. Withdraw the entry from the event itself instead.',
  fee_paid: 'The fee for this entry has been paid. Refund it first, or withdraw the entry by hand.',
};

export async function undoImportedEntry(entryId: string): Promise<ActionResult> {
  return runAction(() => undoImpl(entryId));
}

async function undoImpl(entryId: string): Promise<void> {
  const id = parseOrThrow(uuid, entryId);
  const admin = createAdminClient();
  const { data: entry, error } = await admin
    .from('registration_import_entries')
    .select('id, tournament_event_id, club_event_id, pair_id, status')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the entry: ${error.message}`);
  if (!entry) throw new ExpectedError('That entry no longer exists.');

  // The remove capability of the field the entry is in, as the row says.
  const actor = await requireCapability(
    entry.club_event_id
      ? 'events.signups.remove.write'
      : entry.pair_id
        ? 'tournaments.draw.pairs.remove.write'
        : 'tournaments.draw.participants.remove.write',
  );

  let tournamentId: string | null = null;
  if (entry.tournament_event_id) {
    const { data: event } = await admin
      .from('tournament_events')
      .select('tournament_id')
      .eq('id', entry.tournament_event_id)
      .maybeSingle();
    tournamentId = (event?.tournament_id as string | undefined) ?? null;
  }

  const { data, error: undoError } = await admin.rpc('undo_registration_import_entry', {
    p_entry_id: id,
    p_actor: actor.id,
  });
  if (undoError) throw new Error(`The entry was not undone: ${undoError.message}`);
  const result = data as { ok?: boolean; reason?: string } | null;
  if (!result?.ok) {
    const reason = result?.reason ?? '';
    throw new ExpectedError(UNDO_REFUSALS[reason] ?? `The entry was not undone (${reason || 'unknown reason'}).`);
  }
  if (tournamentId) revalidateTarget('tournament', tournamentId);
  if (entry.club_event_id) revalidateTarget('club_event', entry.club_event_id as string);
}

// ---- A NON-MEMBER'S TOURNAMENT FEE ----------------------------------------
// A form's non-member owes a named fee (player_id NULL, manual_name and
// manual_email set). The member mark-paid path is keyed by player_id and
// cannot reach it, so these are keyed by the fee row's id, re-read here and
// refused unless it is a named TOURNAMENT fee. Same capabilities, same audit
// verbs, as marking a member's entry fee.

const methodSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((value) => value.toLowerCase() !== 'waived', 'Waive a fee from the fees page instead');

async function loadNamedTournamentFee(admin: ReturnType<typeof createAdminClient>, feeId: string) {
  const { data: fee, error } = await admin
    .from('club_fees')
    .select('id, tournament_id, manual_name, amount_cents, paid_at, method, fee_type')
    .eq('id', feeId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the fee: ${error.message}`);
  if (!fee || fee.fee_type !== 'tournament' || fee.manual_name == null || !fee.tournament_id) {
    throw new ExpectedError('That is not a non-member tournament fee.');
  }
  return fee as {
    id: string;
    tournament_id: string;
    manual_name: string;
    amount_cents: number | null;
    paid_at: string | null;
    method: string | null;
  };
}

export async function markNonMemberFeePaid(feeId: string, method: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseOrThrow(uuid, feeId);
    const how = parseOrThrow(methodSchema, method);
    const actor = await requireCapability('tournaments.fees.markpaid.write');
    const admin = createAdminClient();
    const fee = await loadNamedTournamentFee(admin, id);
    if (fee.paid_at) throw new ExpectedError('That fee is already marked paid.');
    const { data, error } = await admin
      .from('club_fees')
      .update({ paid_at: new Date().toISOString(), marked_by: actor.id, method: how })
      .eq('id', id)
      .is('paid_at', null)
      .select('id');
    if (error) throw new Error(`The fee was not marked paid: ${error.message}`);
    if (!data?.length) throw new ExpectedError('That fee changed while you were looking at it. Refresh and try again.');
    await logAdminAudit(admin, {
      actor_id: actor.id as string,
      action_type: 'tournament_fee_marked_paid',
      target_type: 'club_fee',
      target_id: id,
      new_value: { tournament_id: fee.tournament_id, amount_cents: fee.amount_cents, method: how, non_member: true },
      reason: 'A non-member entry fee was marked paid',
    });
    revalidateTarget('tournament', fee.tournament_id);
  });
}

export async function markNonMemberFeeUnpaid(feeId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseOrThrow(uuid, feeId);
    const actor = await requireCapability('tournaments.fees.markunpaid.write');
    const admin = createAdminClient();
    const fee = await loadNamedTournamentFee(admin, id);
    if (!fee.paid_at) throw new ExpectedError('That fee is not marked paid.');
    const { data, error } = await admin
      .from('club_fees')
      .update({ paid_at: null, marked_by: null, method: null })
      .eq('id', id)
      .eq('paid_at', fee.paid_at)
      .select('id');
    if (error) throw new Error(`The fee was not marked unpaid: ${error.message}`);
    if (!data?.length) throw new ExpectedError('That fee changed while you were looking at it. Refresh and try again.');
    await logAdminAudit(admin, {
      actor_id: actor.id as string,
      action_type: 'tournament_fee_marked_unpaid',
      target_type: 'club_fee',
      target_id: id,
      new_value: { tournament_id: fee.tournament_id, method: fee.method, non_member: true },
      reason: 'A non-member entry fee was marked unpaid',
    });
    revalidateTarget('tournament', fee.tournament_id);
  });
}
