import * as Sentry from '@sentry/nextjs';
import type { createAdminClient } from './supabase-server';
import {
  BudgetExhausted,
  defaultGoogleDeps,
  getFormQuestions,
  GoogleFormsError,
  listResponsesSince,
  ReadBudget,
  readServiceAccount,
  accessToken,
  type GoogleDeps,
  type ServiceAccount,
} from './google-forms';
import {
  answersByTitle,
  buildRegistrationPayload,
  formMappingSchema,
  requiredQuestions,
} from './registration-form-mapping';

// THE CONSOLE READS ITS GOOGLE FORMS (00287).
//
// Every five minutes pg_cron calls /api/cron/registration-form-poll, which
// runs this. For each form bound with a question mapping it lists the
// responses submitted or edited since the form's watermark and hands each one
// to forms_api_import_registration, the same import the Apps Script's posts
// reach through the Data API. A replay (same response id, same payload) costs
// one database call and changes nothing, so reading a little too much is
// always safe and reading too little never is.
//
// Claim, read, receipt, as the session reminders (00195): the claim is taken
// before any Google call, so two console replicas never read one form at
// once, and a crash leaves a claim that goes stale after ten minutes.
//
// THE WATERMARK moves only when a form's whole listing was read and every
// response settled (imported, replayed, or skipped as the Data API would have
// refused it). The next read starts a minute before it, so a response saved
// in the same second as the last one read is never missed.
//
// ONE FORM'S FAILURE IS ITS OWN. A refusal (the form is not in the shared
// folder, the id is wrong) is a short code on that binding for the card and
// the round carries on. Only a 429 that survives its retries, or the round's
// read budget, stops the round; forms not reached keep their place.
//
// Unconfigured, nothing runs: no claim, no Google call, no log line.
//
// NOTHING IS LOGGED THAT CARRIES AN ANSWER OR AN EMAIL. Expected refusals go
// to the card only; Sentry hears about faults on this side (a failed RPC).

type Admin = ReturnType<typeof createAdminClient>;

/** Forms claimed per round. */
export const POLL_BATCH = 40;
/** A form is read at most this often (seconds). Just under the five-minute schedule. */
export const POLL_MIN_INTERVAL_SECONDS = 240;
/** Google requests per round. The project's quota is about 300 reads a minute. */
export const POLL_READ_BUDGET = 150;
/** Forms read at once. */
export const POLL_CONCURRENCY = 3;
/** No new form is started after this long; well inside the claim's ten-minute stale window. */
export const POLL_TIME_BUDGET_MS = 90_000;
/** How far before the watermark each read starts. */
export const WATERMARK_OVERLAP_MS = 60_000;

export type PollErrorCode =
  | 'auth'
  | 'forbidden'
  | 'form_not_found'
  | 'rate_limited'
  | 'google_unavailable'
  | 'google_refused'
  | 'mapping_invalid'
  | 'questions_missing'
  | 'responses_skipped'
  | 'import_failed'
  | 'not_bound';

export interface FormPollOutcome {
  bindingId: string;
  read: boolean;
  listed: number;
  imported: number;
  replayed: number;
  skipped: number;
  error: PollErrorCode | null;
}

export interface FormPollRun {
  skipped?: 'not_configured' | 'invalid_key';
  claimed: number;
  read: number;
  imported: number;
  errors: number;
  stopped?: 'rate_limited' | 'budget' | 'time' | 'auth';
  forms: FormPollOutcome[];
}

interface ClaimedForm {
  id: string;
  form_id: string;
  read_mapping: unknown;
  poll_watermark: string | null;
  claimed_at: string;
}

export interface PollDeps extends GoogleDeps {
  env: Record<string, string | undefined>;
}

const defaultPollDeps: PollDeps = { ...defaultGoogleDeps, env: process.env };

async function receipt(
  admin: Admin,
  form: ClaimedForm,
  outcome: { read: boolean; watermark: string | null; imported: number; error: PollErrorCode | null },
): Promise<void> {
  const { error } = await admin.rpc('record_registration_form_poll', {
    p_binding_id: form.id,
    p_claimed_at: form.claimed_at,
    p_read: outcome.read,
    p_watermark: outcome.watermark,
    p_imported: outcome.imported,
    p_error: outcome.error,
  });
  // Not fatal: the claim goes stale and the next round reads the form again,
  // which replays.
  if (error) {
    Sentry.captureException(new Error(`Form poll receipt failed: ${error.message}`), {
      extra: { job: 'registration-form-poll', binding: form.id },
    });
  }
}

class StopRound extends Error {
  constructor(readonly why: 'rate_limited' | 'budget' | 'auth') {
    super(why);
  }
}

/** Reads one form and imports what is new. Throws StopRound when the round must end. */
async function pollForm(
  admin: Admin,
  form: ClaimedForm,
  account: ServiceAccount,
  deps: PollDeps,
  budget: ReadBudget,
): Promise<FormPollOutcome> {
  const outcome: FormPollOutcome = {
    bindingId: form.id,
    read: false,
    listed: 0,
    imported: 0,
    replayed: 0,
    skipped: 0,
    error: null,
  };
  const settle = async (read: boolean, watermark: string | null, error: PollErrorCode | null) => {
    outcome.read = read;
    outcome.error = error;
    await receipt(admin, form, { read, watermark, imported: outcome.imported, error });
    return outcome;
  };

  const mapping = formMappingSchema.safeParse(form.read_mapping);
  if (!mapping.success) return settle(false, null, 'mapping_invalid');

  const watermark = form.poll_watermark ? new Date(form.poll_watermark) : null;
  const since = watermark ? new Date(watermark.getTime() - WATERMARK_OVERLAP_MS) : null;

  try {
    const responses = await listResponsesSince(form.form_id, since, account, deps, budget);
    outcome.listed = responses.length;
    if (responses.length === 0) return settle(true, null, null);

    const questions = await getFormQuestions(form.form_id, account, deps, budget);
    const titles = new Set(questions.map((q) => q.title));
    if (requiredQuestions(mapping.data).some((t) => !titles.has(t))) {
      return settle(false, null, 'questions_missing');
    }

    // Oldest first, so a person's later response supersedes the earlier one
    // in the order they sent them.
    responses.sort((a, b) => Date.parse(a.lastSubmittedTime) - Date.parse(b.lastSubmittedTime));
    let newest: number | null = null;
    let failed = false;
    for (const response of responses) {
      const at = Date.parse(response.lastSubmittedTime);
      if (!Number.isNaN(at) && (newest === null || at > newest)) newest = at;
      const built = buildRegistrationPayload(
        mapping.data,
        form.form_id,
        response,
        answersByTitle(questions, response.answers),
      );
      if (!built.ok) {
        outcome.skipped += 1;
        continue;
      }
      const { data, error } = await admin.rpc('forms_api_import_registration', {
        p_binding_id: form.id,
        p_payload: built.payload,
      });
      if (error) {
        failed = true;
        Sentry.captureException(new Error(`Form response import failed: ${error.message}`), {
          extra: { job: 'registration-form-poll', binding: form.id },
        });
        continue;
      }
      const rows = (data ?? []) as { item: number; status: string; reason: string | null; replayed: boolean }[];
      const whole = rows.find((r) => r.item === 0 && r.status === 'refused');
      if (whole?.reason === 'not_found') {
        // Switched off or unmapped since the claim: stop, keep the watermark.
        return settle(false, null, 'not_bound');
      }
      if (whole) {
        outcome.skipped += 1;
      } else if (rows.length > 0 && rows.every((r) => r.replayed)) {
        outcome.replayed += 1;
      } else {
        outcome.imported += 1;
      }
    }
    if (failed) return settle(false, null, 'import_failed');
    return settle(
      true,
      newest === null ? null : new Date(newest).toISOString(),
      outcome.skipped > 0 ? 'responses_skipped' : null,
    );
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      // Not this form's fault: release it with nothing recorded.
      await receipt(admin, form, { read: false, watermark: null, imported: outcome.imported, error: null });
      throw new StopRound('budget');
    }
    if (err instanceof GoogleFormsError) {
      await settle(false, null, err.code);
      if (err.code === 'rate_limited') throw new StopRound('rate_limited');
      if (err.code === 'auth') throw new StopRound('auth');
      return outcome;
    }
    // A fault on this side: record it on the form and tell Sentry, without
    // the message of anything that may have held an answer.
    Sentry.captureException(new Error('Form poll failed unexpectedly'), {
      extra: { job: 'registration-form-poll', binding: form.id, kind: err instanceof Error ? err.name : typeof err },
    });
    await settle(false, null, 'import_failed');
    return outcome;
  }
}

export async function runRegistrationFormPoll(admin: Admin, deps: PollDeps = defaultPollDeps): Promise<FormPollRun> {
  const run: FormPollRun = { claimed: 0, read: 0, imported: 0, errors: 0, forms: [] };
  const reader = readServiceAccount(deps.env);
  if (reader.state === 'not_configured') return { ...run, skipped: 'not_configured' };
  if (reader.state === 'invalid') return { ...run, skipped: 'invalid_key' };
  const account = reader.account;

  const { data, error } = await admin.rpc('claim_registration_form_polls', {
    p_limit: POLL_BATCH,
    p_min_interval_seconds: POLL_MIN_INTERVAL_SECONDS,
  });
  if (error) throw new Error(`Could not claim forms to read: ${error.message}`);
  const queue = ((data ?? []) as ClaimedForm[]).slice();
  run.claimed = queue.length;
  if (queue.length === 0) return run;

  const started = deps.now();
  const budget = new ReadBudget(POLL_READ_BUDGET);

  // One token for the round. Refused: every claimed form says so, once.
  try {
    await accessToken(account, deps);
  } catch (err) {
    const code: PollErrorCode = err instanceof GoogleFormsError ? err.code : 'auth';
    for (const form of queue) {
      await receipt(admin, form, { read: false, watermark: null, imported: 0, error: code });
      run.forms.push({ bindingId: form.id, read: false, listed: 0, imported: 0, replayed: 0, skipped: 0, error: code });
    }
    run.errors = queue.length;
    run.stopped = code === 'rate_limited' ? 'rate_limited' : 'auth';
    return run;
  }

  let stop: FormPollRun['stopped'];
  const worker = async () => {
    for (;;) {
      if (stop) return;
      if (deps.now() - started > POLL_TIME_BUDGET_MS) {
        stop = 'time';
        return;
      }
      const form = queue.shift();
      if (!form) return;
      try {
        const outcome = await pollForm(admin, form, account, deps, budget);
        run.forms.push(outcome);
      } catch (err) {
        if (err instanceof StopRound) {
          stop = stop ?? err.why;
          return;
        }
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, queue.length) }, worker));

  // Claimed and never reached: released, keeping their place at the front.
  for (const form of queue) {
    await receipt(admin, form, { read: false, watermark: null, imported: 0, error: null });
  }
  if (stop) run.stopped = stop;
  for (const outcome of run.forms) {
    if (outcome.read) run.read += 1;
    if (outcome.error && outcome.error !== 'responses_skipped') run.errors += 1;
    run.imported += outcome.imported;
  }
  return run;
}
