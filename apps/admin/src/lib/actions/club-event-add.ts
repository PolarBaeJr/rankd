'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';
import { ExpectedError, isReservedMethod, parseOrThrow } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { logAdminAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { ReadBudget, defaultGoogleDeps, getFormQuestions, readServiceAccount } from '../google-forms';
import { formMappingSchema } from '../registration-form-mapping';
import { scheduleManagedFormSync } from '../managed-forms';

// AN OFFICER ADDS SOMEBODY TO A CLUB EVENT BY HAND (00306): somebody who paid
// cash, or who does not use the app, email or the Form. A member, or a guest by
// name alone; what they paid; their answers. No waiver is asked for.
//
// Every exported parameter is a client-controlled POST field, so each is
// shape-checked, and the actor is always the one requireCapability resolves.

const REFUSALS: Record<string, string> = {
  not_found: 'That event no longer exists.',
  cancelled: 'This event is cancelled.',
  not_eligible: 'That member cannot sign up right now (suspended, pending approval or leaving).',
  bad_name: 'Type a name, up to 120 characters.',
  bad_email: 'That email does not look right.',
  email_is_member: 'That email belongs to a member. Add them from the Member tab.',
  already_registered: 'They are already signed up for this event.',
  bad_partner: 'Keep the preferred partner under 120 characters.',
  bad_method: 'Pick how they paid. "waived" is not a payment.',
  bad_answers: 'An answer is too long. Keep each under 2000 characters.',
};

const uuid = z.string().uuid();
const answersSchema = z
  .record(z.string().max(300), z.string().max(2000))
  .refine((answers) => Object.keys(answers).length <= 40, { message: 'At most 40 answers' });

const addSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('member'),
      playerId: uuid,
      partner: z.string().trim().max(120).optional(),
      answers: answersSchema.optional(),
      paidMethod: z.string().trim().max(60).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('guest'),
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().max(254).optional(),
      partner: z.string().trim().max(120).optional(),
      mediaConsent: z.boolean().optional(),
      answers: answersSchema.optional(),
      paidMethod: z.string().trim().max(60).optional(),
    })
    .strict(),
]);

export type AddByHand = z.infer<typeof addSchema>;

type AddResult = { ok: boolean; reason?: string; player_id?: string; record_made?: boolean; paid?: boolean };

/** Sign somebody up by hand, and mark the event fee paid when they paid. */
export async function addClubEventPersonByHand(
  eventId: string,
  person: AddByHand,
): Promise<ActionResult<{ paid: boolean }>> {
  return runAction(async () => {
    const actor = await requireCapability('events.signups.checkin.write');
    parseOrThrow(uuid, eventId);
    const input = parseOrThrow(addSchema, person);
    const paidMethod = input.paidMethod || null;
    if (paidMethod) {
      if (isReservedMethod(paidMethod)) throw new ExpectedError(REFUSALS.bad_method as string);
      // Recording money is the fee write, on top of adding them.
      await requireCapability('fees.clubfees.markpaid.write');
    }

    const adminClient = createAdminClient();
    const { data, error } = await adminClient.rpc('club_event_add_by_hand' as never, {
      p_event_id: eventId,
      p_player_id: input.kind === 'member' ? input.playerId : null,
      p_name: input.kind === 'guest' ? input.name : null,
      p_email: input.kind === 'guest' ? input.email || null : null,
      p_partner: input.partner || null,
      p_media_consent: input.kind === 'guest' ? input.mediaConsent ?? null : null,
      p_answers: input.answers && Object.keys(input.answers).length > 0 ? input.answers : null,
      p_paid_method: paidMethod,
      p_actor: actor.id,
    } as never);
    // 23514: the linked tournament's draw is made (00292), and the message
    // says to enter them from the tournament.
    if ((error as { code?: string } | null)?.code === '23514') throw new ExpectedError(error!.message);
    if (error) throw new Error(`club_event_add_by_hand failed: ${error.message}`);
    const result = data as unknown as AddResult;
    if (!result.ok) throw new ExpectedError(REFUSALS[result.reason ?? ''] ?? 'They could not be added.');

    await logAdminAudit(
      adminClient,
      {
        actor_id: actor.id as string,
        action_type: 'club_event_added_by_hand',
        target_type: 'club_event',
        target_id: eventId,
        new_value: {
          player_id: result.player_id,
          guest: input.kind === 'guest',
          record_made: result.record_made === true,
          with_email: input.kind === 'guest' ? !!input.email : true,
          paid: result.paid === true,
          method: result.paid ? paidMethod : null,
        },
        reason: 'Somebody was added to a club event by hand',
      },
      { eventId, playerId: result.player_id },
    );
    // A place taken may close a full event's Form.
    scheduleManagedFormSync('club_event', eventId);
    revalidatePath(`/events/${eventId}`);
    revalidatePath(`/events/${eventId}/checkin`);
    return { paid: result.paid === true };
  });
}

export interface HandQuestions {
  /** The bound Form's questions the dialog asks, in Form order. */
  questions: string[];
  /** Why there are none, when there are none. */
  note: string | null;
}

/**
 * The event Form's questions an officer can answer for somebody: every one
 * except those the dialog already asks or that are not answers (name, email,
 * the receipt, the waiver and its signature, photos, the partner note).
 */
export async function loadClubEventHandQuestions(eventId: string): Promise<ActionResult<HandQuestions>> {
  return runAction(async () => {
    await requireCapability('events.signups.checkin.write');
    parseOrThrow(uuid, eventId);
    const { data: binding, error } = await createAdminClient()
      .from('registration_import_forms')
      .select('form_id, read_mapping')
      .eq('club_event_id', eventId)
      .eq('active', true)
      .not('read_mapping', 'is', null)
      .maybeSingle();
    if (error) throw new Error(`The event's Form could not be read: ${error.message}`);
    if (!binding) return { questions: [], note: 'This event has no Google Form, so there are no other questions.' };

    const reader = readServiceAccount();
    if (reader.state !== 'ready') return { questions: [], note: 'The Form reader is not set up, so its questions cannot be listed.' };
    const parsed = formMappingSchema.safeParse(binding.read_mapping);
    const mapped = new Set(
      parsed.success
        ? [
            parsed.data.NAME_QUESTION,
            parsed.data.EMAIL_QUESTION,
            parsed.data.EVENT_QUESTION,
            parsed.data.RECEIPT_QUESTION,
            parsed.data.WAIVER_QUESTION,
            parsed.data.SIGNATURE_QUESTION,
            parsed.data.MEDIA_QUESTION,
            parsed.data.PARTNER_NOTE_QUESTION,
          ].filter(Boolean)
        : [],
    );
    try {
      const questions = await getFormQuestions(binding.form_id as string, reader.account, defaultGoogleDeps, new ReadBudget(3));
      return {
        questions: [...new Set(questions.map((q) => q.title.trim()))].filter((title) => title && !mapped.has(title)),
        note: null,
      };
    } catch (err) {
      Sentry.captureException(err);
      return { questions: [], note: 'Google did not answer, so the Form\'s questions could not be listed. Try again.' };
    }
  });
}
