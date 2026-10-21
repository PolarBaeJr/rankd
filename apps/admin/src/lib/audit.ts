// Audit log helpers. NOT a 'use server' module — these are internal
// utilities imported by the admin server actions, not actions themselves.
import * as Sentry from '@sentry/nextjs';
import type { createAdminClient } from './supabase-server';
import { discordActorStore } from './discord-actor-store';
import {
  AUDIT_PAYLOAD_DROPPED_KEY,
  auditPayloadDroppedSuffix,
  isRequiredAudit,
} from './audit-policy';

// Tournament-scoped audit trail (tournament_audit_log table).
//
// A failed write is reported to Sentry and never breaks the parent action —
// the same contract logAdminAudit states below, and it did NOT hold here until
// now. This function awaited the insert and dropped the `error` it resolved
// with: supabase-js resolves rather than rejects on a PostgREST failure, so
// every way a row could be refused — a revoked column grant, a constraint, a
// dropped socket — looked exactly like success, and the tournament audit trail
// could lose entries with nothing anywhere to say so. Silence was the one
// outcome neither of the two sensible policies wanted. Same shape as below so
// the two trails behave alike.
export async function logAudit(
  adminClient: ReturnType<typeof createAdminClient>,
  params: {
    tournament_id?: string;
    event_id?: string;
    match_id?: string;
    action: string;
    performed_by: string;
    details?: Record<string, unknown>;
  }
) {
  const { error } = await adminClient.from('tournament_audit_log').insert({
    tournament_id: params.tournament_id ?? null,
    event_id: params.event_id ?? null,
    match_id: params.match_id ?? null,
    action: params.action,
    performed_by: params.performed_by,
    details: params.details ?? null,
  });
  if (!error) return;

  const where = {
    action: params.action,
    tournamentId: params.tournament_id ?? null,
    eventId: params.event_id ?? null,
    matchId: params.match_id ?? null,
  };
  Sentry.captureException(
    new Error(`Tournament audit log write failed: ${error.message}`), { extra: where });

  // Same two-class policy as logAdminAudit — `details` is this trail's payload
  // and its most likely reason to be refused, so the fact is retried without
  // it. Every action on this trail that reaches a completed event, a voided
  // match or a deleted draw is in the required class.
  //
  // That sentence was aspirational until 2026-08-28: the set it consults held
  // only `action_type:` names from the admin trail, and this trail writes
  // `action:`, so isRequiredAudit returned false for all 32 of them and no
  // degraded retry ever ran here. The drift test that should have caught it
  // scanned only the other spelling. Both are now classified and both are
  // scanned; see audit-policy.ts.
  if (!isRequiredAudit(params.action)) return;

  const { error: fallbackError } = await adminClient.from('tournament_audit_log').insert({
    tournament_id: params.tournament_id ?? null,
    event_id: params.event_id ?? null,
    match_id: params.match_id ?? null,
    action: params.action,
    performed_by: params.performed_by,
    details: { [AUDIT_PAYLOAD_DROPPED_KEY]: error.message.slice(0, 200) },
  });
  if (fallbackError) {
    Sentry.captureException(
      new Error(`Tournament audit FACT lost — degraded retry also failed: ${fallbackError.message}`),
      { extra: { originalError: error.message, ...where } },
    );
  }
}

// General admin audit trail (audit_logs table). A failed write is reported
// to Sentry but never breaks the parent action.
export async function logAdminAudit(
  adminClient: ReturnType<typeof createAdminClient>,
  entry: {
    // Null when the actor is a scheduled job rather than a person.
    actor_id: string | null;
    action_type: string;
    target_type: string;
    // audit_logs.target_id is a `uuid` column. Null when the thing acted on has
    // no uuid at all — platform_settings is keyed by `key`, legal_documents by
    // `document`. Passing the text key here instead threw
    // "invalid input syntax for type uuid" on every insert; name it in `reason`
    // and leave this null.
    target_id: string | null;
    old_value?: unknown;
    new_value?: unknown;
    reason?: string;
  },
  sentryExtra: Record<string, unknown> = {}
) {
  // A console command run from Discord says so on its audit row. A new object,
  // never the caller's: the same entry is reused for the degraded retry below.
  if (discordActorStore.getStore()) {
    const stamped =
      entry.new_value && typeof entry.new_value === 'object' && !Array.isArray(entry.new_value)
        ? { ...(entry.new_value as Record<string, unknown>), source: 'discord' }
        : entry.new_value === undefined || entry.new_value === null
          ? { source: 'discord' }
          : { value: entry.new_value, source: 'discord' };
    entry = { ...entry, new_value: stamped };
  }

  const { error } = await adminClient.from('audit_logs').insert(entry);
  if (!error) return;

  Sentry.captureException(new Error(`Audit log write failed: ${error.message}`), {
    extra: { action: entry.action_type, ...sentryExtra },
  });

  // For the risk classes in audit-policy.ts, one refused insert is not the end
  // of it: retry WITHOUT the payload. old_value/new_value are the likeliest
  // reason a row is refused — an oversized jsonb, a value the column will not
  // take — and the fact (who did what, to what, when) is what governance needs.
  // Deliberately still not throwing; see audit-policy.ts for why a late throw
  // is worse than a degraded row.
  if (!isRequiredAudit(entry.action_type)) return;

  const { error: fallbackError } = await adminClient.from('audit_logs').insert({
    actor_id: entry.actor_id,
    action_type: entry.action_type,
    target_type: entry.target_type,
    target_id: entry.target_id,
    // The original reason still matters — it is the human's own words — but it
    // has to survive the truncation that a refused payload might have needed.
    reason:
      `${(entry.reason ?? '').slice(0, 400)}`.trim() +
      auditPayloadDroppedSuffix(error.message),
  });
  if (fallbackError) {
    Sentry.captureException(
      new Error(`Audit log FACT lost — degraded retry also failed: ${fallbackError.message}`),
      { extra: { action: entry.action_type, originalError: error.message, ...sentryExtra } },
    );
  }
}
