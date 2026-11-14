'use server';

// GROUP TIME CAPS (00331): a time on a groups stage, a pool or one group after
// which no new match of it starts. The minute job applies a cap when its time
// comes; Cap now applies it at once. Every action asks the void key, then the
// group_time_cap switch, before anything is written. Every id, stage and time
// below is a client-controlled POST field, so each is read back.

import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { ExpectedError, parseFormatConfig, parseOrThrow } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { assertReleaseFlag } from '../release-flags';
import { assertTournamentNotSuspended, requireCapability, revalidateEventPaths } from './_internal';
import { fillFreeCourts, type AutoCallEvent, type AutoCallReport } from './auto-call';

type AdminClient = ReturnType<typeof createAdminClient>;

const CAPABILITY = 'tournaments.results.void.write';
const MIGRATION_MISSING = 'Run migration 00331 first';
const isMissing = (error: { code?: string } | null) =>
  !!error && ['42P01', 'PGRST205', '42883', 'PGRST202'].includes(error.code ?? '');

const uuid = z.string().uuid();
const scopeSchema = z.object({
  stage: z.number().int().min(1).max(8),
  pool: z.number().int().min(1).max(64).nullable(),
  group: z.number().int().min(1).max(64).nullable(),
}).refine((s) => s.group === null || s.pool !== null, 'A group is in a pool.');

async function readStagedEvent(adminClient: AdminClient, eventId: string) {
  const { data: event, error } = await adminClient.from('tournament_events')
    .select('id, tournament_id, format, format_config, status, event_type')
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the event: ${error.message}`);
  if (!event) throw new Error('Event not found');
  if (event.format !== 'staged') throw new ExpectedError('A time cap is for an event played in stages.');
  return event as AutoCallEvent;
}

async function readCap(adminClient: AdminClient, capId: unknown) {
  const id = parseOrThrow(uuid, capId);
  const { data: cap, error } = await adminClient.from('stage_group_time_caps')
    .select('id, event_id, stage, pool_number, group_number, cap_at, applied_at')
    .eq('id', id)
    .maybeSingle();
  if (isMissing(error)) throw new ExpectedError(MIGRATION_MISSING);
  if (error) throw new Error(`Could not read the time cap: ${error.message}`);
  if (!cap) throw new ExpectedError('This time cap is gone. Reload the page.');
  return cap as { id: string; event_id: string; stage: number; pool_number: number | null; group_number: number | null; cap_at: string; applied_at: string | null };
}

export interface GroupTimeCapInput {
  stage: number;
  pool: number | null;
  group: number | null;
  /** UTC, from the club-time picker. */
  capAt: string;
}

// Set, or move while not yet applied. Refused once a later stage is drawn:
// the groups have already fed it.
async function setGroupTimeCapImpl(eventId: unknown, input: unknown): Promise<{ capId: string }> {
  const admin = await requireCapability(CAPABILITY);
  await assertReleaseFlag('group_time_cap');
  const adminClient = createAdminClient();
  const event = await readStagedEvent(adminClient, parseOrThrow(uuid, eventId));
  const raw = (input ?? {}) as Record<string, unknown>;
  const scope = parseOrThrow(scopeSchema, { stage: raw.stage, pool: raw.pool ?? null, group: raw.group ?? null });
  const capAt = parseOrThrow(z.string().datetime({ offset: true }), raw.capAt);
  if (new Date(capAt).getTime() <= Date.now()) throw new ExpectedError('Pick a time still to come, or use Cap now.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const config = parseFormatConfig(event.format_config);
  if (config?.stages[scope.stage - 1]?.kind !== 'groups') throw new ExpectedError('A time cap is for a groups stage.');
  const { count: later, error: laterError } = await adminClient.from('tournament_matches')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', event.id)
    .gt('stage', scope.stage);
  if (laterError) throw new Error(`Could not read the event's stages: ${laterError.message}`);
  if ((later ?? 0) > 0) throw new ExpectedError('The next stage is drawn, so these groups are over.');

  const { data: existing, error: readError } = await adminClient.from('stage_group_time_caps')
    .select('id, applied_at, pool_number, group_number')
    .eq('event_id', event.id)
    .eq('stage', scope.stage);
  if (isMissing(readError)) throw new ExpectedError(MIGRATION_MISSING);
  if (readError) throw new Error(`Could not read the time caps: ${readError.message}`);
  const same = (existing ?? []).find((c) => c.pool_number === scope.pool && c.group_number === scope.group);
  if (same?.applied_at) throw new ExpectedError('This cap has been applied already.');

  let capId: string;
  if (same) {
    const { error } = await adminClient.from('stage_group_time_caps')
      .update({ cap_at: capAt })
      .eq('id', same.id)
      .is('applied_at', null);
    if (error) throw new Error(`Could not move the time cap: ${error.message}`);
    capId = same.id as string;
  } else {
    const { data, error } = await adminClient.from('stage_group_time_caps')
      .insert({ event_id: event.id, stage: scope.stage, pool_number: scope.pool, group_number: scope.group, cap_at: capAt })
      .select('id')
      .single();
    if (error?.code === '23505') throw new ExpectedError('Somebody set this cap a moment ago. Reload the page.');
    if (error) throw new Error(`Could not set the time cap: ${error.message}`);
    capId = data.id as string;
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: 'group_time_cap_set',
    performed_by: admin.id,
    details: { cap_id: capId, stage: scope.stage, pool: scope.pool, group: scope.group, cap_at: capAt },
  });
  revalidateEventPaths(event.tournament_id, event.id);
  return { capId };
}

export async function setGroupTimeCap(eventId: string, input: GroupTimeCapInput): Promise<ActionResult<{ capId: string }>> {
  return runAction(() => setGroupTimeCapImpl(eventId, input));
}

async function clearGroupTimeCapImpl(capId: unknown): Promise<void> {
  const admin = await requireCapability(CAPABILITY);
  await assertReleaseFlag('group_time_cap');
  const adminClient = createAdminClient();
  const cap = await readCap(adminClient, capId);
  if (cap.applied_at) throw new ExpectedError('This cap has been applied, so its matches are voided. Restore one by hand.');
  const event = await readStagedEvent(adminClient, cap.event_id);

  const { count, error } = await adminClient.from('stage_group_time_caps')
    .delete({ count: 'exact' })
    .eq('id', cap.id)
    .is('applied_at', null);
  if (error) throw new Error(`Could not clear the time cap: ${error.message}`);
  if (count === 0) throw new ExpectedError('The cap was applied in the meantime. Reload the page.');

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: 'group_time_cap_cleared',
    performed_by: admin.id,
    details: { cap_id: cap.id, stage: cap.stage, pool: cap.pool_number, group: cap.group_number },
  });
  revalidateEventPaths(event.tournament_id, event.id);
}

export async function clearGroupTimeCap(capId: string): Promise<ActionResult> {
  return runAction(() => clearGroupTimeCapImpl(capId));
}

export interface CapNowResult {
  voided: number;
  autoCall: AutoCallReport | null;
}

async function applyGroupTimeCapNowImpl(capId: unknown): Promise<CapNowResult> {
  const admin = await requireCapability(CAPABILITY);
  await assertReleaseFlag('group_time_cap');
  const adminClient = createAdminClient();
  const cap = await readCap(adminClient, capId);
  const event = await readStagedEvent(adminClient, cap.event_id);
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const { data, error } = await adminClient.rpc('apply_group_time_cap', { p_cap_id: cap.id, p_actor: admin.id });
  if (isMissing(error)) throw new ExpectedError(MIGRATION_MISSING);
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const result = data as { ok: boolean; reason?: string; already?: boolean; voided?: number } | null;
  if (!result?.ok) {
    throw new ExpectedError(result?.reason === 'event_status'
      ? 'A time cap applies while the groups are being played.'
      : 'This time cap is gone. Reload the page.');
  }

  let autoCall: AutoCallReport | null = null;
  try {
    autoCall = await fillFreeCourts(adminClient, { event, actorId: admin.id, trigger: 'void' });
  } catch (err) {
    Sentry.captureException(err);
    autoCall = { called: [], failed: [{ court: null, reason: err instanceof Error ? err.message : 'Unknown error' }] };
  }
  revalidateEventPaths(event.tournament_id, event.id);
  return { voided: result.voided ?? 0, autoCall };
}

export async function applyGroupTimeCapNow(capId: string): Promise<ActionResult<CapNowResult>> {
  return runAction(() => applyGroupTimeCapNowImpl(capId));
}
