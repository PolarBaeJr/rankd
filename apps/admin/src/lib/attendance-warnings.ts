// Attendance warnings (00324). NOT a 'use server' module: these are helpers
// for the actions that mark a member as not having come, never actions.
//
// NEVER THROWS. A warning is a consequence of an action that already happened
// (the no-show was marked, the place was released), so a warning that cannot
// be written is reported and the action still succeeds. A database without
// 00324 has nowhere to write one, and that is a logged no-op.
import * as Sentry from '@sentry/nextjs';
import { ATTENDANCE_POLICY_TEXT, TOURNAMENT_EVENT_TYPE_LABELS } from '@badminton/shared';
import type { createAdminClient } from './supabase-server';
import { logAudit } from './audit';
import { notifyPlayers } from './notify';

type AdminClient = ReturnType<typeof createAdminClient>;

export type AttendanceWarningKind = 'no_show' | 'left_without_notice';
export type AttendanceWarningSource = 'checkin_close' | 'did_not_come' | 'desk' | 'court_helper';

function isTableMissing(error: { code?: string } | null): boolean {
  return !!error && ['42P01', 'PGRST205'].includes(error.code ?? '');
}

async function eventLabel(adminClient: AdminClient, eventId: string): Promise<string> {
  const { data } = await adminClient
    .from('tournament_events')
    .select('event_type, tournament:tournaments(name)')
    .eq('id', eventId)
    .maybeSingle();
  const embed = data?.tournament as { name: string } | { name: string }[] | null | undefined;
  const name = (Array.isArray(embed) ? embed[0] : embed)?.name;
  const type = data?.event_type
    ? (TOURNAMENT_EVENT_TYPE_LABELS as Record<string, string>)[data.event_type] ?? data.event_type
    : 'the event';
  return name ? `${type} at ${name}` : type;
}

/**
 * One warning per member, for one event. A member who already holds an active
 * warning of this kind for the event is skipped: the partial unique index says
 * so, and a duplicate is not a second offence. Returns who was warned, with
 * the warning each got.
 */
export async function issueAttendanceWarnings(
  adminClient: AdminClient,
  input: {
    playerIds: string[];
    tournamentId: string;
    eventId: string;
    kind: AttendanceWarningKind;
    source: AttendanceWarningSource;
    note?: string | null;
    actorId: string;
  },
): Promise<Array<{ playerId: string; warningId: string }>> {
  const warned: Array<{ playerId: string; warningId: string }> = [];
  try {
    for (const playerId of [...new Set(input.playerIds)]) {
      const { data, error } = await adminClient.from('attendance_warnings').insert({
        player_id: playerId,
        tournament_id: input.tournamentId,
        event_id: input.eventId,
        kind: input.kind,
        source: input.source,
        note: input.note?.trim() ? input.note.trim().slice(0, 500) : null,
        issued_by: input.actorId,
      }).select('id').single();
      if (!error && data) {
        warned.push({ playerId, warningId: data.id });
        continue;
      }
      if (!error) continue;
      if (error.code === '23505') continue;
      if (isTableMissing(error)) {
        console.warn('[attendance-warnings] the table is missing, 00324 is not applied; no warning written');
        return warned;
      }
      Sentry.captureException(new Error(`Attendance warning write failed: ${error.message}`), {
        extra: { eventId: input.eventId, kind: input.kind },
      });
    }
    if (warned.length === 0) return warned;

    const where = await eventLabel(adminClient, input.eventId);
    const warnedIds = warned.map((w) => w.playerId);
    await notifyPlayers(adminClient, warnedIds, {
      type: 'general',
      title: 'Attendance warning',
      body: input.kind === 'left_without_notice'
        ? `You left ${where} without telling the organizers. ${ATTENDANCE_POLICY_TEXT}`
        : `You were marked as not having come to ${where}. ${ATTENDANCE_POLICY_TEXT}`,
      metadata: { kind: 'attendance_warning', event_id: input.eventId, tournament_id: input.tournamentId },
    });
    await logAudit(adminClient, {
      tournament_id: input.tournamentId,
      event_id: input.eventId,
      action: 'attendance_warning_issued',
      performed_by: input.actorId,
      details: { player_ids: warnedIds, kind: input.kind, source: input.source },
    });
  } catch (err) {
    Sentry.captureException(err);
  }
  return warned;
}

/**
 * Takes back the active warnings an undone mark wrote: the desk's no-show is
 * undone, so the warning it caused goes too. Returns how many were rescinded.
 */
export async function rescindEventWarnings(
  adminClient: AdminClient,
  input: {
    playerIds: string[];
    tournamentId: string;
    eventId: string;
    sources: AttendanceWarningSource[];
    actorId: string;
    reason: string;
  },
): Promise<number> {
  if (input.playerIds.length === 0) return 0;
  try {
    const { data, error } = await adminClient
      .from('attendance_warnings')
      .update({ rescinded_at: new Date().toISOString(), rescinded_by: input.actorId, rescind_reason: input.reason })
      .eq('event_id', input.eventId)
      .eq('kind', 'no_show')
      .in('player_id', input.playerIds)
      .in('source', input.sources)
      .is('rescinded_at', null)
      .select('id');
    if (error) {
      if (!isTableMissing(error)) {
        Sentry.captureException(new Error(`Attendance warning rescind failed: ${error.message}`));
      }
      return 0;
    }
    const count = data?.length ?? 0;
    if (count > 0) {
      await logAudit(adminClient, {
        tournament_id: input.tournamentId,
        event_id: input.eventId,
        action: 'attendance_warning_rescinded',
        performed_by: input.actorId,
        details: { warning_ids: (data ?? []).map((row) => row.id), reason: input.reason },
      });
    }
    return count;
  } catch (err) {
    Sentry.captureException(err);
    return 0;
  }
}

/** The members of an entry: one for a participant, both for a pair. */
export async function entryPlayerIds(adminClient: AdminClient, entryId: string, isPair: boolean): Promise<string[]> {
  if (isPair) {
    const { data } = await adminClient.from('tournament_pairs').select('player1_id, player2_id').eq('id', entryId).maybeSingle();
    return [data?.player1_id, data?.player2_id].filter((id): id is string => typeof id === 'string');
  }
  const { data } = await adminClient.from('tournament_participants').select('player_id').eq('id', entryId).maybeSingle();
  return data?.player_id ? [data.player_id] : [];
}
