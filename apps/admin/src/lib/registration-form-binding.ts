import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ExpectedError } from '@badminton/shared';
import type { createAdminClient } from './supabase-server';
import { logAdminAudit } from './audit';
import type { FormMapping } from './registration-form-mapping';

// THE WRITES BEHIND A FORM BINDING (00283, 00287, 00295), for the console's
// actions (actions/registration-imports.ts) and for the Forms the console
// makes itself (managed-forms.ts, 00296). Not a 'use server' module: nothing
// here is a POST endpoint, and nothing here asks for a capability. Each caller
// has already asked for the one that governs the target as the database
// records it.

type Admin = ReturnType<typeof createAdminClient>;

const uuid = z.string().uuid();

export const bindSchema = z
  .object({
    targetKind: z.enum(['tournament', 'club_event', 'season']),
    targetId: uuid,
    consumerId: uuid,
    // A Google Form id, or whatever stable id the script sends. Same shape the
    // Data API accepts.
    formId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.:-]{1,200}$/, 'A form id is letters, digits and . _ : - only'),
    joinWaitlist: z.boolean(),
    soloDoublesAck: z.boolean(),
  })
  .strict();

export type BindFormInput = z.input<typeof bindSchema>;
export type ParsedBinding = z.output<typeof bindSchema>;

export type TargetKind = 'tournament' | 'club_event' | 'season';

export function updateCapabilityFor(kind: TargetKind) {
  if (kind === 'season') return 'fees.clubfees.markpaid.write';
  return kind === 'tournament' ? 'tournaments.manage.update.write' : 'events.manage.update.write';
}

export interface StoredBinding {
  id: string;
  target_kind: unknown;
  tournament_id: unknown;
  club_event_id: unknown;
  season_id?: unknown;
  active?: unknown;
}

/** The target column the binding row records for its kind. */
export function storedTarget(binding: { target_kind: unknown; tournament_id: unknown; club_event_id: unknown; season_id?: unknown }) {
  const kind = binding.target_kind as TargetKind;
  const targetId = (
    kind === 'tournament' ? binding.tournament_id : kind === 'club_event' ? binding.club_event_id : binding.season_id
  ) as string | null;
  return { kind, targetId: targetId ?? null };
}

export function revalidateTarget(kind: TargetKind, id: string) {
  if (kind === 'tournament') {
    revalidatePath(`/tournaments/${id}`);
    revalidatePath(`/tournaments/${id}/fees`);
  } else if (kind === 'season') {
    revalidatePath('/fees');
  } else {
    revalidatePath(`/events/${id}`);
  }
}

/** Writes a new binding and audits it. The target and consumer are re-read; the id of the new binding is returned. */
export async function insertBinding(
  admin: Admin,
  actorId: string | null,
  parsed: ParsedBinding,
  options: { active: boolean; auditExtra?: Record<string, unknown> } = { active: true },
): Promise<string> {
  const targetRes =
    parsed.targetKind === 'tournament'
      ? await admin.from('tournaments').select('id').eq('id', parsed.targetId).maybeSingle()
      : parsed.targetKind === 'season'
        ? await admin.from('seasons').select('id').eq('id', parsed.targetId).maybeSingle()
        : await admin.from('club_events').select('id').eq('id', parsed.targetId).maybeSingle();
  if (targetRes.error) throw new Error(`Could not read the target: ${targetRes.error.message}`);
  if (!targetRes.data) throw new ExpectedError('That tournament, event or season no longer exists.');

  const consumerRes = await admin.from('data_api_consumers').select('id').eq('id', parsed.consumerId).maybeSingle();
  if (consumerRes.error) throw new Error(`Could not read the consumer: ${consumerRes.error.message}`);
  if (!consumerRes.data) throw new ExpectedError('That data API consumer no longer exists.');

  const { data, error } = await admin
    .from('registration_import_forms')
    .insert({
      consumer_id: parsed.consumerId,
      form_id: parsed.formId,
      target_kind: parsed.targetKind,
      tournament_id: parsed.targetKind === 'tournament' ? parsed.targetId : null,
      club_event_id: parsed.targetKind === 'club_event' ? parsed.targetId : null,
      season_id: parsed.targetKind === 'season' ? parsed.targetId : null,
      join_waitlist: parsed.joinWaitlist,
      solo_doubles_ack: parsed.soloDoublesAck,
      active: options.active,
      created_by: actorId,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') {
      throw new ExpectedError(
        'That form is already bound for this consumer, here or on another tournament, event or season. Switch the old binding off first.',
      );
    }
    throw new Error(`The binding was not written: ${error.message}`);
  }
  const id = (data as { id: string } | null)?.id;
  if (!id) throw new Error('The binding was not written.');

  await logAdminAudit(admin, {
    actor_id: actorId,
    action_type: 'registration_form_bound',
    target_type: 'registration_import_form',
    target_id: id,
    new_value: {
      target_kind: parsed.targetKind,
      target_id: parsed.targetId,
      consumer_id: parsed.consumerId,
      form_id: parsed.formId,
      join_waitlist: parsed.joinWaitlist,
      ...(options.active ? {} : { active: false }),
      ...(options.auditExtra ?? {}),
    },
    reason: 'A Google Form was bound to registrations',
  });
  revalidateTarget(parsed.targetKind, parsed.targetId);
  return id;
}

/**
 * Switches a stored binding on or off and audits it. Nothing is written when
 * it already is.
 */
export async function switchBinding(admin: Admin, actorId: string | null, binding: StoredBinding, on: boolean): Promise<void> {
  const { kind, targetId } = storedTarget(binding);
  if (binding.active === on) return;

  const { error: updateError } = await admin
    .from('registration_import_forms')
    .update({ active: on, updated_at: new Date().toISOString() })
    .eq('id', binding.id);
  if (updateError) {
    // 00287: one form is read by the console under one active binding.
    if (updateError.code === '23505') {
      throw new ExpectedError('Another link of this form is already read by the console. Switch that one off first.');
    }
    throw new Error(`The binding was not changed: ${updateError.message}`);
  }

  const entry = {
    actor_id: actorId,
    target_type: 'registration_import_form',
    target_id: binding.id,
    new_value: { active: on, target_kind: kind, target_id: targetId },
  };
  // Two literal calls, not a ternary, so the audit policy's scan sees both names.
  if (on) {
    await logAdminAudit(admin, {
      ...entry,
      action_type: 'registration_form_bound',
      reason: 'A Google Form binding was switched back on',
    });
  } else {
    await logAdminAudit(admin, {
      ...entry,
      action_type: 'registration_form_unbound',
      reason: 'A Google Form binding was switched off',
    });
  }
  if (targetId) revalidateTarget(kind, targetId);
}

/**
 * Saves the question mapping on a stored binding (null stops the console
 * reading it), checked against the target the binding records. Saving resets
 * the watermark, so the next read goes over every response again.
 */
export async function writeMapping(
  admin: Admin,
  actorId: string | null,
  binding: StoredBinding,
  parsed: FormMapping | null,
): Promise<void> {
  const { kind, targetId } = storedTarget(binding);
  if (!targetId) throw new ExpectedError('That form binding has no tournament, event or season any more.');

  if (parsed) {
    const named = [...Object.values(parsed.EVENTS), ...(parsed.DEFAULT_EVENT_ID ? [parsed.DEFAULT_EVENT_ID] : [])];
    if (kind === 'season') {
      // A season's form enters nobody in anything: its screenshot is the point.
      if (named.length > 0 || Object.keys(parsed.PARTNERS).length > 0) {
        throw new ExpectedError('A season form names no event.');
      }
      if (!parsed.RECEIPT_QUESTION) {
        throw new ExpectedError('A season form needs its e-transfer screenshot question.');
      }
    } else if (kind === 'tournament') {
      const unique = [...new Set(named)];
      if (unique.length > 0) {
        const { data: events, error: eventsError } = await admin
          .from('tournament_events')
          .select('id')
          .eq('tournament_id', targetId)
          .in('id', unique);
        if (eventsError) throw new Error(`Could not read the events: ${eventsError.message}`);
        if ((events ?? []).length !== unique.length) {
          throw new ExpectedError('The mapping names an event that is not in this tournament.');
        }
      }
    } else if (named.some((eventId) => eventId !== targetId)) {
      throw new ExpectedError('A club event form can only name this event.');
    }
    for (const choice of Object.keys(parsed.PARTNERS)) {
      if (!Object.prototype.hasOwnProperty.call(parsed.EVENTS, choice)) {
        throw new ExpectedError('Partner questions are set for a choice that names no event.');
      }
    }
  }

  // The Form's waiver text is the live waiver unless the mapping says which
  // version it shows (00295): the officer saving the mapping is the one who
  // looked at the form.
  if (parsed?.WAIVER_QUESTION && !parsed.WAIVER_VERSION) {
    const { data: waiver, error: waiverError } = await admin
      .from('legal_documents')
      .select('version')
      .eq('document', 'waiver')
      .maybeSingle();
    if (waiverError) throw new Error(`Could not read the waiver: ${waiverError.message}`);
    if (!waiver?.version) throw new ExpectedError('No waiver is published, so the form cannot sign one.');
    parsed.WAIVER_VERSION = waiver.version as string;
  }

  const { error: updateError } = await admin
    .from('registration_import_forms')
    .update({
      read_mapping: parsed,
      poll_watermark: null,
      poll_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', binding.id);
  if (updateError) {
    if (updateError.code === '23505') {
      throw new ExpectedError('Another link of this form is already read by the console. Switch that one off first.');
    }
    throw new Error(`The mapping was not saved: ${updateError.message}`);
  }

  // Question titles and event ids only: no answer is in the mapping.
  await logAdminAudit(admin, {
    actor_id: actorId,
    action_type: 'registration_form_bound',
    target_type: 'registration_import_form',
    target_id: binding.id,
    new_value: { target_kind: kind, target_id: targetId, read_by_console: parsed !== null, read_mapping: parsed },
    reason: parsed
      ? 'A Google Form is read by the console with this question mapping'
      : 'A Google Form is no longer read by the console',
  });
  revalidateTarget(kind, targetId);
}
