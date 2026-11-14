'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ExpectedError, parseOrThrow } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { assertReleaseFlag } from '../release-flags';
import { runAction, type ActionResult } from '../action-result';
import { requireCapability } from './_shared';

// A MEMBER'S ATTENDANCE RECORD (00324), from their console page: rescinding a
// warning, and restricting or lifting a restriction on entering events. The
// capabilities are suspension's, because a restriction is a narrower
// suspension: 'players.ban.write' to impose or take back, and
// 'players.reinstate.write' to lift. Each asks its kill switch after the
// capability.

const uuid = z.string().uuid();
const reasonSchema = z.string().trim().min(1, 'Give a reason.').max(500);

function isTableMissing(error: { code?: string } | null): boolean {
  return !!error && ['42P01', 'PGRST205'].includes(error.code ?? '');
}

const MIGRATION_PENDING = 'Run migration 00324 first';

async function rescindAttendanceWarningImpl(warningId: unknown, reason: unknown): Promise<void> {
  const actor = await requireCapability('players.ban.write');
  await assertReleaseFlag('attendance_warnings');
  const id = parseOrThrow(uuid, warningId);
  const text = parseOrThrow(reasonSchema, reason);
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.from('attendance_warnings')
    .update({ rescinded_at: new Date().toISOString(), rescinded_by: actor.id, rescind_reason: text })
    .eq('id', id)
    .is('rescinded_at', null)
    .select('id, player_id, event_id, kind')
    .maybeSingle();
  if (error) {
    if (isTableMissing(error)) throw new ExpectedError(MIGRATION_PENDING);
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  if (!data) throw new ExpectedError('That warning was already rescinded. Reload the page.');

  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'attendance_warning_rescinded',
    target_type: 'player',
    target_id: data.player_id,
    old_value: { warning_id: data.id, event_id: data.event_id, kind: data.kind },
    reason: text,
  });
  revalidatePath(`/players/${data.player_id}`);
}

export async function rescindAttendanceWarning(warningId: string, reason: string): Promise<ActionResult> {
  return runAction(() => rescindAttendanceWarningImpl(warningId, reason));
}

const restrictionSchema = z.object({
  playerId: uuid,
  reason: reasonSchema,
  // A club-time date the restriction ends on, or null for until an exec lifts it.
  endsAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export type EntryRestrictionInput = z.infer<typeof restrictionSchema>;

async function createEntryRestrictionImpl(raw: unknown): Promise<{ removedFromWaitlists: number }> {
  const actor = await requireCapability('players.ban.write');
  await assertReleaseFlag('entry_restriction');
  const input = parseOrThrow(restrictionSchema, raw);
  if (input.endsAt && new Date(input.endsAt).getTime() <= Date.now()) {
    throw new ExpectedError('Pick an end date in the future.');
  }
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.from('event_entry_restrictions')
    .insert({ player_id: input.playerId, reason: input.reason, ends_at: input.endsAt, created_by: actor.id })
    .select('id')
    .single();
  if (error) {
    if (isTableMissing(error)) throw new ExpectedError(MIGRATION_PENDING);
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  // A restricted member cannot enter, so they cannot be promoted either: their
  // places in every queue go now rather than at the head of it.
  let removed = 0;
  const { data: waiting, error: waitingError } = await adminClient.from('tournament_event_waitlist')
    .select('id')
    .eq('player_id', input.playerId)
    .eq('status', 'waiting');
  if (waitingError) {
    if (!isTableMissing(waitingError)) Sentry.captureException(waitingError);
  } else {
    for (const row of waiting ?? []) {
      const { data: out, error: outError } = await adminClient.rpc('remove_from_event_waitlist', {
        p_waitlist_id: row.id,
        p_actor: actor.id,
      });
      if (outError) {
        Sentry.captureException(outError);
        continue;
      }
      if ((out as { ok?: boolean } | null)?.ok) removed += 1;
    }
  }

  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'entry_restriction_created',
    target_type: 'player',
    target_id: input.playerId,
    new_value: { restriction_id: data.id, ends_at: input.endsAt, removed_from_waitlists: removed },
    reason: input.reason,
  });
  revalidatePath(`/players/${input.playerId}`);
  return { removedFromWaitlists: removed };
}

export async function createEntryRestriction(
  input: EntryRestrictionInput,
): Promise<ActionResult<{ removedFromWaitlists: number }>> {
  return runAction(() => createEntryRestrictionImpl(input));
}

async function liftEntryRestrictionImpl(restrictionId: unknown): Promise<void> {
  const actor = await requireCapability('players.reinstate.write');
  await assertReleaseFlag('entry_restriction');
  const id = parseOrThrow(uuid, restrictionId);
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.from('event_entry_restrictions')
    .update({ lifted_at: new Date().toISOString(), lifted_by: actor.id })
    .eq('id', id)
    .is('lifted_at', null)
    .select('id, player_id, ends_at')
    .maybeSingle();
  if (error) {
    if (isTableMissing(error)) throw new ExpectedError(MIGRATION_PENDING);
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  if (!data) throw new ExpectedError('That restriction was already lifted. Reload the page.');

  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'entry_restriction_lifted',
    target_type: 'player',
    target_id: data.player_id,
    old_value: { restriction_id: data.id, ends_at: data.ends_at },
  });
  revalidatePath(`/players/${data.player_id}`);
}

export async function liftEntryRestriction(restrictionId: string): Promise<ActionResult> {
  return runAction(() => liftEntryRestrictionImpl(restrictionId));
}
