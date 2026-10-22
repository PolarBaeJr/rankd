import * as Sentry from '@sentry/nextjs';
import { after } from 'next/server';
import { ExpectedError, MEMBERSHIP_PAYMENTS_SETTING_KEY, parseMembershipPaymentSettings } from '@badminton/shared';
import { createAdminClient } from './supabase-server';
import { logAdminAudit } from './audit';
import { accessLevelFor, permissionsOf, permits } from './permissions';
import {
  defaultGoogleDeps,
  getFormQuestions,
  GoogleFormsError,
  ReadBudget,
  readServiceAccount,
  type Fetch,
} from './google-forms';
import { callFormMaker, FormMakerError, parseCreatedForm, readFormMaker, type FormMaker } from './form-maker';
import {
  contentFingerprint,
  formContent,
  FORM_MAKER_CONSUMER_NAME,
  isPaid,
  managedMapping,
  stableJson,
  tournamentChoices,
  type ChoiceEvent,
  type ClubEventContentRow,
  type FeeTierRow,
  type ManagedKind,
  type TournamentChoice,
  type TournamentContentRow,
} from './managed-form-content';
import { formMappingSchema, mappedQuestionTitles, type FormMapping } from './registration-form-mapping';
import {
  insertBinding,
  revalidateTarget,
  switchBinding,
  updateCapabilityFor,
  writeMapping,
  type StoredBinding,
} from './registration-form-binding';

// THE FORMS THE CONSOLE MAKES (00296).
//
// An exec presses Create on an event (or a new event asks for one): the
// console claims a managed_registration_forms row, asks the form maker to copy
// the template, checks through the Forms API that the copy has every question
// the mapping names, binds it against the console's own consumer and saves
// the mapping. From then on 00287's reader reads it like any other Form.
//
// CLAIM FIRST. The row is inserted in state `creating` before Google is
// asked, and the partial unique index on the target makes a second insert
// answer 23505, so two replicas or two clicks make one Form. A crashed call
// leaves a claim that goes stale after ten minutes. The maker's requestKey is
// the target and generation, and the script answers a repeated key with the
// Form it already made, so taking a stale claim again never makes a second
// Form.
//
// A FORM BOUND BY HAND IS LEFT ALONE: any binding on the target that no
// managed row made means an exec already linked a Form, and nothing is made.
//
// THE FORM FOLLOWS THE EVENT. Every write to an event that changes what its
// Form says, or whether it should take responses, schedules a sync after the
// response (next/server after()), and a five-minute job catches anything
// missed. A sync writes the content only when its fingerprint changed, saves
// the mapping only when it differs (saving resets the reader's watermark),
// and closes or opens the Form only when that changed.
//
// NOTHING HERE CHANGES THE RESULT OF THE EVENT'S OWN ACTION. Every hook is
// gated on the maker being configured, runs after the response, and catches
// everything. Unconfigured, nothing here reads the database.

type Admin = ReturnType<typeof createAdminClient>;

export type ManagedState = 'creating' | 'failed' | 'unverified' | 'live' | 'retired';

export interface ManagedFormRow {
  id: string;
  target_kind: ManagedKind;
  club_event_id: string | null;
  tournament_id: string | null;
  generation: number;
  binding_id: string | null;
  form_id: string | null;
  responder_url: string | null;
  edit_url: string | null;
  template_waiver_version: string | null;
  state: ManagedState;
  claimed_at: string | null;
  accepting: boolean | null;
  close_reason: string | null;
  closed_at: string | null;
  synced_fingerprint: string | null;
  synced_at: string | null;
  attempted_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export const MANAGED_ROW_COLUMNS =
  'id, target_kind, club_event_id, tournament_id, generation, binding_id, form_id, responder_url, edit_url, template_waiver_version, state, claimed_at, accepting, close_reason, closed_at, synced_fingerprint, synced_at, attempted_at, last_error, created_at, updated_at';

export interface ManagedFormDeps {
  env: Record<string, string | undefined>;
  fetch: Fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultManagedFormDeps: ManagedFormDeps = { ...defaultGoogleDeps, env: process.env };

/** A claim older than this is a crashed call, and may be taken again. */
export const CLAIM_STALE_MS = 10 * 60_000;
/** A row whose last sync failed is not tried again sooner than this by the job. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** Rows the job looks at per round. */
export const SYNC_BATCH = 25;
/** No new row is started after this long into the job's round. */
export const SYNC_TIME_BUDGET_MS = 60_000;
/** Forms API reads while a fresh copy becomes visible to the service account. */
const VERIFY_ATTEMPTS = 3;
const VERIFY_WAIT_MS = 2000;

// The maker's refusals that are the setup's to fix, and say so on the card.
// Anything else is a fault Sentry hears about.
const EXPECTED_MAKER_CODES = new Set([
  'template_missing',
  'folder_missing',
  'payment_section_missing',
  'question_missing',
  'unreachable',
  'timeout',
]);

// A failed row that only Replace can mend: a copy with no Payment section
// left, or a row the staging snapshot copied from the club's console (its
// binding still names the club's real Form).
const REPLACE_ONLY_ERRORS = new Set(['payment_section_missing', 'staging_copy']);

// A closed Form whose event is gone, finished, started or cancelled is never
// opened again, so the job leaves it.
const TERMINAL_REASONS = new Set(['cancelled', 'deleted', 'started', 'finished']);

const table = (admin: Admin) => admin.from('managed_registration_forms' as never);

function report(err: unknown, extra: Record<string, unknown> = {}) {
  Sentry.captureException(err instanceof Error ? err : new Error('Managed form failed'), {
    extra: { job: 'managed-form', ...extra },
  });
}

function safeRevalidate(kind: ManagedKind, id: string) {
  try {
    revalidateTarget(kind, id);
  } catch {
    // Outside a request (the job, an after() callback) there is nothing to revalidate.
  }
}

// ---- reading ----------------------------------------------------------------

export type ManagedTarget =
  | {
      kind: 'club_event';
      id: string;
      row: ClubEventContentRow & { status: string };
    }
  | {
      kind: 'tournament';
      id: string;
      row: TournamentContentRow;
      events: ChoiceEvent[];
      tiers: FeeTierRow[];
      linkedClubEvent: boolean;
    };

/** The target as the Form needs it, or null when it no longer exists. A failed read throws: it is not a missing target. */
export async function loadTarget(admin: Admin, kind: ManagedKind, targetId: string): Promise<ManagedTarget | null> {
  if (kind === 'club_event') {
    const { data, error } = await admin
      .from('club_events')
      .select('id, title, description, location, starts_at, cost_cents, status')
      .eq('id', targetId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the event: ${error.message}`);
    if (!data) return null;
    return { kind, id: targetId, row: data as unknown as ClubEventContentRow & { status: string } };
  }
  const { data, error } = await admin
    .from('tournaments')
    .select('id, name, start_date, end_date')
    .eq('id', targetId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the tournament: ${error.message}`);
  if (!data) return null;
  const [eventsRes, tiersRes] = await Promise.all([
    admin.from('tournament_events').select('id, event_type, external_event, created_at').eq('tournament_id', targetId),
    admin
      .from('tournament_fee_tiers')
      .select('name, amount_cents')
      .eq('tournament_id', targetId)
      .order('sort_order')
      .order('created_at'),
  ]);
  if (eventsRes.error) throw new Error(`Could not read the events: ${eventsRes.error.message}`);
  if (tiersRes.error) throw new Error(`Could not read the fee tiers: ${tiersRes.error.message}`);
  const events = (eventsRes.data ?? []) as unknown as ChoiceEvent[];
  let linkedClubEvent = false;
  if (events.length > 0) {
    const { data: linked, error: linkedError } = await admin
      .from('club_events')
      .select('id')
      .in('tournament_event_id', events.map((e) => e.id))
      .limit(1);
    if (linkedError) throw new Error(`Could not read the linked club event: ${linkedError.message}`);
    linkedClubEvent = (linked ?? []).length > 0;
  }
  return {
    kind,
    id: targetId,
    row: data as unknown as TournamentContentRow,
    events,
    tiers: (tiersRes.data ?? []) as unknown as FeeTierRow[],
    linkedClubEvent,
  };
}

async function readEtransferEmail(admin: Admin): Promise<string | null> {
  const { data, error } = await admin
    .from('platform_settings')
    .select('value')
    .eq('key', MEMBERSHIP_PAYMENTS_SETTING_KEY)
    .maybeSingle();
  if (error) throw new Error(`Could not read the payment settings: ${error.message}`);
  return parseMembershipPaymentSettings((data as { value?: unknown } | null)?.value).etransferEmail;
}

async function acceptingFor(
  admin: Admin,
  kind: ManagedKind,
  targetId: string,
  joinWaitlist: boolean,
): Promise<{ accepting: boolean; reason: string | null }> {
  const { data, error } = await admin.rpc('registration_form_accepting' as never, {
    p_kind: kind,
    p_target: targetId,
    p_join_waitlist: joinWaitlist,
  } as never);
  if (error) throw new Error(`Could not ask whether the form takes responses: ${(error as { message: string }).message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { accepting?: boolean; reason?: string | null } | undefined;
  return { accepting: row?.accepting === true, reason: row?.accepting === true ? null : (row?.reason ?? null) };
}

async function readRow(admin: Admin, rowId: string): Promise<ManagedFormRow | null> {
  const { data, error } = await table(admin).select(MANAGED_ROW_COLUMNS).eq('id', rowId).maybeSingle();
  if (error) throw new Error(`Could not read the managed form: ${(error as { message: string }).message}`);
  return (data as unknown as ManagedFormRow | null) ?? null;
}

async function readRowsFor(admin: Admin, kind: ManagedKind, targetId: string): Promise<ManagedFormRow[]> {
  const column = kind === 'tournament' ? 'tournament_id' : 'club_event_id';
  const { data, error } = await table(admin).select(MANAGED_ROW_COLUMNS).eq(column, targetId);
  if (error) throw new Error(`Could not read the managed forms: ${(error as { message: string }).message}`);
  return (data ?? []) as unknown as ManagedFormRow[];
}

interface BindingRow extends StoredBinding {
  read_mapping: unknown;
  join_waitlist: boolean;
}

async function readBinding(admin: Admin, bindingId: string): Promise<BindingRow | null> {
  const { data, error } = await admin
    .from('registration_import_forms')
    .select('id, target_kind, tournament_id, club_event_id, season_id, active, read_mapping, join_waitlist')
    .eq('id', bindingId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the binding: ${error.message}`);
  return (data as unknown as BindingRow | null) ?? null;
}

/** Whether the target has a binding no managed row made: a Form an exec linked by hand. */
async function boundByHand(admin: Admin, kind: ManagedKind, targetId: string, rows: ManagedFormRow[]): Promise<boolean> {
  const column = kind === 'tournament' ? 'tournament_id' : 'club_event_id';
  const { data, error } = await admin.from('registration_import_forms').select('id').eq(column, targetId);
  // Fail closed: an unread list is not "no binding".
  if (error) throw new Error(`Could not read the form bindings: ${error.message}`);
  const made = new Set(rows.map((r) => r.binding_id).filter((id): id is string => !!id));
  return ((data ?? []) as { id: string }[]).some((b) => !made.has(b.id));
}

function targetOf(row: ManagedFormRow): string | null {
  return row.target_kind === 'tournament' ? row.tournament_id : row.club_event_id;
}

function storedBindingFor(kind: ManagedKind, targetId: string, id: string, active: boolean): StoredBinding {
  return {
    id,
    target_kind: kind,
    tournament_id: kind === 'tournament' ? targetId : null,
    club_event_id: kind === 'club_event' ? targetId : null,
    season_id: null,
    active,
  };
}

async function updateRow(admin: Admin, rowId: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await table(admin)
    .update({ ...values, updated_at: new Date().toISOString() } as never)
    .eq('id', rowId);
  if (error) throw new Error(`The managed form was not updated: ${(error as { message: string }).message}`);
}

async function markFailed(admin: Admin, rowId: string, code: string): Promise<void> {
  await updateRow(admin, rowId, {
    state: 'failed',
    last_error: code,
    claimed_at: null,
    attempted_at: new Date().toISOString(),
  });
}

function makerFailure(err: unknown, rowId: string): string {
  const code = err instanceof FormMakerError ? err.code : 'bad_response';
  if (!(err instanceof FormMakerError) || !EXPECTED_MAKER_CODES.has(code)) {
    report(new Error(`Form maker refused: ${code}`), { row: rowId });
  }
  return code;
}

// ---- making a Form ------------------------------------------------------------

export type EnsureOutcome = 'created' | 'exists' | 'busy' | 'not_configured' | 'skipped' | 'failed' | 'unverified';

/**
 * Makes the target's Form unless it has one. Throws ExpectedError for what the
 * exec must fix first (the reader is not set up, the target is gone or
 * cancelled); a refusal from the maker is recorded on the row as `failed`.
 */
export async function ensureManagedForm(
  admin: Admin,
  actorId: string | null,
  kind: ManagedKind,
  targetId: string,
  deps: ManagedFormDeps = defaultManagedFormDeps,
  generation = 1,
): Promise<EnsureOutcome> {
  const maker = readFormMaker(deps.env);
  if (maker.state !== 'ready') return 'not_configured';
  if (readServiceAccount(deps.env).state !== 'ready') {
    throw new ExpectedError("The console cannot read Google Forms yet. Set its service account key first.");
  }
  const target = await loadTarget(admin, kind, targetId);
  if (!target) throw new ExpectedError('That event or tournament no longer exists.');
  if (target.kind === 'club_event' && target.row.status === 'cancelled') {
    throw new ExpectedError('A cancelled event takes no form.');
  }
  // Its club event's Form signs people up there (00292).
  if (target.kind === 'tournament' && target.linkedClubEvent) return 'skipped';

  const rows = await readRowsFor(admin, kind, targetId);
  if (await boundByHand(admin, kind, targetId, rows)) return 'skipped';

  let current = rows.find((r) => r.state !== 'retired') ?? null;
  let claimed: ManagedFormRow | null = null;
  if (!current) {
    const now = new Date(deps.now()).toISOString();
    const { data, error } = await table(admin)
      .insert({
        target_kind: kind,
        club_event_id: kind === 'club_event' ? targetId : null,
        tournament_id: kind === 'tournament' ? targetId : null,
        generation,
        state: 'creating',
        claimed_at: now,
        attempted_at: now,
      } as never)
      .select(MANAGED_ROW_COLUMNS)
      .maybeSingle();
    if (error) {
      if ((error as { code?: string }).code !== '23505') {
        throw new Error(`The form was not claimed: ${(error as { message: string }).message}`);
      }
      // Somebody else claimed it first: read theirs.
      current = (await readRowsFor(admin, kind, targetId)).find((r) => r.state !== 'retired') ?? null;
      if (!current) return 'busy';
    } else {
      claimed = data as unknown as ManagedFormRow;
    }
  }

  if (!claimed && current) {
    if (current.state === 'live') return 'exists';
    if (current.state === 'unverified') return finishForm(admin, actorId, current, target, deps, false);
    if (current.state === 'creating' && current.claimed_at && deps.now() - Date.parse(current.claimed_at) < CLAIM_STALE_MS) {
      return 'busy';
    }
    // Failed, or a crashed claim: take it again, only if nobody else has.
    const now = new Date(deps.now()).toISOString();
    let retake = table(admin)
      .update({ state: 'creating', claimed_at: now, attempted_at: now, last_error: null, updated_at: now } as never)
      .eq('id', current.id)
      .eq('state', current.state);
    retake = current.claimed_at ? retake.eq('claimed_at', current.claimed_at) : retake.is('claimed_at', null);
    const { data, error } = await retake.select(MANAGED_ROW_COLUMNS);
    if (error) throw new Error(`The form was not claimed: ${(error as { message: string }).message}`);
    claimed = ((data ?? []) as unknown as ManagedFormRow[])[0] ?? null;
    if (!claimed) return 'busy';
  }
  if (!claimed) return 'busy';
  return makeForm(admin, actorId, maker.maker, claimed, target, deps);
}

async function makeForm(
  admin: Admin,
  actorId: string | null,
  maker: FormMaker,
  row: ManagedFormRow,
  target: ManagedTarget,
  deps: ManagedFormDeps,
): Promise<EnsureOutcome> {
  const choices = target.kind === 'tournament' ? tournamentChoices(target.events, null) : null;
  const tiers = target.kind === 'tournament' ? target.tiers : [];
  const paid = isPaid(target.kind, target.row, tiers);
  const etransferEmail = paid ? await readEtransferEmail(admin) : null;
  if (paid && !etransferEmail) {
    await markFailed(admin, row.id, 'etransfer_unset');
    return 'failed';
  }
  const content = formContent(target.kind, target.row, { etransferEmail, tiers, choices });
  const state = await acceptingFor(admin, target.kind, target.id, false);

  let created;
  try {
    const answer = await callFormMaker(
      maker,
      'create',
      {
        requestKey: `${target.kind}:${target.id}:${row.generation}`,
        template: target.kind,
        title: content.title,
        description: content.description,
        payment: content.payment,
        choices: content.choices,
        accepting: state.accepting,
        closedMessage: content.closedMessage,
      },
      deps,
    );
    created = parseCreatedForm(answer);
  } catch (err) {
    await markFailed(admin, row.id, makerFailure(err, row.id));
    return 'failed';
  }

  const now = new Date(deps.now()).toISOString();
  const made: ManagedFormRow = {
    ...row,
    form_id: created.formId,
    responder_url: created.responderUrl,
    edit_url: created.editUrl,
    template_waiver_version: created.waiverVersion || null,
    accepting: created.accepting,
    close_reason: created.accepting ? null : state.reason,
    closed_at: created.accepting ? null : now,
    synced_fingerprint: contentFingerprint(content),
    synced_at: now,
    state: 'unverified',
  };
  await updateRow(admin, row.id, {
    form_id: made.form_id,
    responder_url: made.responder_url,
    edit_url: made.edit_url,
    template_waiver_version: made.template_waiver_version,
    accepting: made.accepting,
    close_reason: made.close_reason,
    closed_at: made.closed_at,
    synced_fingerprint: made.synced_fingerprint,
    synced_at: made.synced_at,
    state: made.state,
  });
  return finishForm(admin, actorId, made, target, deps, true);
}

/**
 * Checks the made Form has every question the mapping names, binds it (on
 * only when it does) and saves the mapping. A Form that does not check out is
 * `unverified`, its binding off, until Check again finds it right.
 */
async function finishForm(
  admin: Admin,
  actorId: string | null,
  row: ManagedFormRow,
  target: ManagedTarget,
  deps: ManagedFormDeps,
  created: boolean,
): Promise<EnsureOutcome> {
  const formId = row.form_id;
  if (!formId) return 'failed';
  const binding = row.binding_id ? await readBinding(admin, row.binding_id) : null;
  const stored = binding?.read_mapping ? formMappingSchema.safeParse(binding.read_mapping) : null;
  const previous = stored?.success ? stored.data : null;
  const choices = target.kind === 'tournament' ? tournamentChoices(target.events, previous) : null;
  const paid = isPaid(target.kind, target.row, target.kind === 'tournament' ? target.tiers : []);
  const mapping = managedMapping(target.kind, target.id, choices, paid, row.template_waiver_version ?? '');

  let problem: string | null = null;
  const reader = readServiceAccount(deps.env);
  if (reader.state !== 'ready') {
    problem = 'auth';
  } else {
    let titles: Set<string> | null = null;
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
      try {
        const questions = await getFormQuestions(formId, reader.account, deps, new ReadBudget(VERIFY_ATTEMPTS * 3));
        titles = new Set(questions.map((q) => q.title));
        break;
      } catch (err) {
        // A fresh copy can take a moment to reach the service account.
        const code = err instanceof GoogleFormsError ? err.code : 'google_refused';
        if ((code === 'forbidden' || code === 'form_not_found') && attempt < VERIFY_ATTEMPTS) {
          await deps.sleep(VERIFY_WAIT_MS);
          continue;
        }
        problem = code;
        break;
      }
    }
    if (titles && mappedQuestionTitles(mapping).some((title) => !titles!.has(title))) problem = 'questions_missing';
  }
  // An empty template version would have the mapping stamp the LIVE waiver,
  // claiming the Form shows text nobody checked.
  if (!problem && !row.template_waiver_version) problem = 'waiver_version_unset';
  const verified = problem === null;

  let bindingId = binding?.id ?? null;
  if (!bindingId) {
    const { data: consumer, error } = await admin
      .from('data_api_consumers')
      .select('id')
      .eq('name', FORM_MAKER_CONSUMER_NAME)
      .maybeSingle();
    if (error) throw new Error(`Could not read the consumer: ${error.message}`);
    if (!consumer) throw new ExpectedError('Run migration 00296 first');
    bindingId = await insertBinding(
      admin,
      actorId,
      {
        targetKind: target.kind,
        targetId: target.id,
        consumerId: (consumer as { id: string }).id,
        formId,
        joinWaitlist: false,
        soloDoublesAck: false,
      },
      { active: verified, auditExtra: { managed: true } },
    );
    // The row learns its binding at once, so a later step that fails leaves no orphan.
    await updateRow(admin, row.id, { binding_id: bindingId });
  }
  const storedBinding = storedBindingFor(target.kind, target.id, bindingId, binding ? binding.active === true : verified);
  if (verified) {
    if (!previous || stableJson(previous) !== stableJson(mapping)) {
      await writeMapping(admin, actorId, storedBinding, mapping);
    }
    await switchBinding(admin, actorId, storedBinding, true);
  }

  await updateRow(admin, row.id, {
    binding_id: bindingId,
    state: verified ? 'live' : 'unverified',
    claimed_at: null,
    last_error: problem,
    attempted_at: new Date(deps.now()).toISOString(),
  });
  if (created) {
    await logAdminAudit(admin, {
      actor_id: actorId,
      action_type: 'registration_form_created',
      target_type: 'managed_registration_form',
      target_id: row.id,
      new_value: {
        target_kind: target.kind,
        target_id: target.id,
        form_id: formId,
        generation: row.generation,
        state: verified ? 'live' : 'unverified',
      },
      reason: 'The console made a Google Form for registrations',
    });
  }
  safeRevalidate(target.kind, target.id);
  return verified ? 'created' : 'unverified';
}

// ---- keeping it in step -------------------------------------------------------

export type SyncOutcome = 'unchanged' | 'updated' | 'skipped' | 'failed' | 'not_configured';

/**
 * Brings one made Form in step with its target. Never throws: a failure is a
 * code on the row, and Sentry hears about faults on this side.
 */
export async function syncManagedForm(
  admin: Admin,
  row: ManagedFormRow,
  deps: ManagedFormDeps = defaultManagedFormDeps,
  actorId: string | null = null,
): Promise<SyncOutcome> {
  try {
    const maker = readFormMaker(deps.env);
    if (maker.state !== 'ready') return 'not_configured';
    if (row.state !== 'live' && row.state !== 'unverified') return 'skipped';
    const formId = row.form_id;
    if (!formId) return 'skipped';
    if (
      actorId === null &&
      row.last_error &&
      row.attempted_at &&
      deps.now() - Date.parse(row.attempted_at) < RETRY_AFTER_MS
    ) {
      return 'skipped';
    }
    const now = new Date(deps.now()).toISOString();

    const targetId = targetOf(row);
    const target = targetId ? await loadTarget(admin, row.target_kind, targetId) : null;
    if (!target) {
      if (row.accepting === false && row.close_reason === 'deleted') return 'unchanged';
      await callFormMaker(maker.maker, 'close', { formId, closedMessage: 'Sign-ups for this event are closed.' }, deps);
      await updateRow(admin, row.id, {
        accepting: false,
        close_reason: 'deleted',
        closed_at: now,
        last_error: null,
        attempted_at: now,
      });
      return 'updated';
    }

    const binding = row.binding_id ? await readBinding(admin, row.binding_id) : null;
    const stored = binding?.read_mapping ? formMappingSchema.safeParse(binding.read_mapping) : null;
    const previous: FormMapping | null = stored?.success ? stored.data : null;
    const choices: TournamentChoice[] | null =
      target.kind === 'tournament' ? tournamentChoices(target.events, previous) : null;
    const tiers = target.kind === 'tournament' ? target.tiers : [];
    const paid = isPaid(target.kind, target.row, tiers);
    const etransferEmail = paid ? await readEtransferEmail(admin) : null;
    if (paid && !etransferEmail) {
      await updateRow(admin, row.id, { last_error: 'etransfer_unset', attempted_at: now });
      return 'failed';
    }
    const content = formContent(target.kind, target.row, { etransferEmail, tiers, choices });
    const fingerprint = contentFingerprint(content);
    const changes: Record<string, unknown> = {};

    if (fingerprint !== row.synced_fingerprint) {
      await callFormMaker(
        maker.maker,
        'update',
        { formId, title: content.title, description: content.description, payment: content.payment, choices: content.choices },
        deps,
      );
      changes.synced_fingerprint = fingerprint;
      changes.synced_at = now;
    }

    // The mapping follows the Form's content, and is saved only when it
    // differs: saving resets the reader's watermark.
    if (binding && row.state === 'live') {
      const mapping = managedMapping(
        target.kind,
        target.id,
        choices,
        paid,
        previous?.WAIVER_VERSION || row.template_waiver_version || '',
      );
      if (stableJson(mapping) !== stableJson(previous)) {
        await writeMapping(admin, actorId, binding, mapping);
        changes.mapping = true;
      }
    }

    const state = await acceptingFor(admin, target.kind, target.id, binding?.join_waitlist === true);
    if (state.accepting !== row.accepting) {
      if (state.accepting) {
        await callFormMaker(maker.maker, 'open', { formId }, deps);
      } else {
        await callFormMaker(maker.maker, 'close', { formId, closedMessage: content.closedMessage }, deps);
      }
      changes.accepting = state.accepting;
      changes.close_reason = state.reason;
      changes.closed_at = state.accepting ? null : now;
    } else if (!state.accepting && state.reason !== row.close_reason) {
      changes.close_reason = state.reason;
    }

    const changed = Object.keys(changes).length > 0;
    const { mapping: _mapping, ...columns } = changes;
    await updateRow(admin, row.id, { ...columns, last_error: null, attempted_at: now });

    if (row.state === 'unverified') {
      await finishForm(admin, actorId, { ...row, ...(columns as Partial<ManagedFormRow>) }, target, deps, false);
    }
    if (changed) safeRevalidate(target.kind, target.id);
    return changed ? 'updated' : 'unchanged';
  } catch (err) {
    const code =
      err instanceof FormMakerError ? makerFailure(err, row.id) : err instanceof ExpectedError ? 'mapping_invalid' : 'sync_failed';
    if (!(err instanceof FormMakerError)) report(err, { row: row.id });
    try {
      await updateRow(admin, row.id, { last_error: code, attempted_at: new Date(deps.now()).toISOString() });
    } catch {
      // The next round tries again.
    }
    return 'failed';
  }
}

/** Check again (unverified), Retry (failed) or a sync now (live), for the row an exec pressed it on. */
export async function recheckManagedForm(
  admin: Admin,
  actorId: string | null,
  row: ManagedFormRow,
  deps: ManagedFormDeps = defaultManagedFormDeps,
): Promise<EnsureOutcome | SyncOutcome> {
  const targetId = targetOf(row);
  if (row.state === 'retired') throw new ExpectedError('That form was replaced.');
  if (row.state === 'live' || row.state === 'unverified') return syncManagedForm(admin, row, deps, actorId);
  if (row.last_error && REPLACE_ONLY_ERRORS.has(row.last_error)) {
    throw new ExpectedError('This form cannot be made again as it is. Replace it instead.');
  }
  if (!targetId) throw new ExpectedError('That event or tournament no longer exists.');
  return ensureManagedForm(admin, actorId, row.target_kind, targetId, deps, row.generation);
}

/**
 * Retires a made Form and makes a new one from the template: the way out when
 * the copy no longer has a section the event now needs (a free event that
 * became paid has no Payment section left).
 */
export async function replaceManagedForm(
  admin: Admin,
  actorId: string | null,
  row: ManagedFormRow,
  deps: ManagedFormDeps = defaultManagedFormDeps,
): Promise<EnsureOutcome> {
  const maker = readFormMaker(deps.env);
  if (maker.state !== 'ready') return 'not_configured';
  if (row.state === 'retired') throw new ExpectedError('That form was already replaced.');
  if (row.state === 'creating' && row.claimed_at && deps.now() - Date.parse(row.claimed_at) < CLAIM_STALE_MS) {
    return 'busy';
  }
  const targetId = targetOf(row);
  if (!targetId) throw new ExpectedError('That event or tournament no longer exists.');

  if (row.form_id) {
    try {
      await callFormMaker(
        maker.maker,
        'close',
        { formId: row.form_id, closedMessage: 'This form was replaced. Ask the club for the new link.' },
        deps,
      );
    } catch (err) {
      if (!(err instanceof FormMakerError && err.code === 'form_unknown')) {
        makerFailure(err, row.id);
        throw new ExpectedError('The form maker could not close the old form. Try again.');
      }
    }
  }
  if (row.binding_id) {
    const binding = await readBinding(admin, row.binding_id);
    if (binding) await switchBinding(admin, actorId, binding, false);
  }
  await updateRow(admin, row.id, { state: 'retired', accepting: false, claimed_at: null });
  return ensureManagedForm(admin, actorId, row.target_kind, targetId, deps, row.generation + 1);
}

/** A stored row, for the actions. */
export async function loadManagedFormRow(admin: Admin, rowId: string): Promise<ManagedFormRow | null> {
  return readRow(admin, rowId);
}

// ---- hooks for the event's own actions --------------------------------------

/**
 * After a new event's response: make its Form, when the maker is configured
 * and the actor may edit the event. Never throws, never delays the response.
 */
export function scheduleManagedFormCreate(kind: ManagedKind, targetId: string, actor: { id: unknown }): void {
  try {
    if (readFormMaker(process.env).state !== 'ready') return;
    const player = actor as Parameters<typeof accessLevelFor>[0] & Parameters<typeof permissionsOf>[1];
    const level = accessLevelFor(player);
    if (!permits(level, permissionsOf(level, player), updateCapabilityFor(kind))) return;
    after(() =>
      ensureManagedForm(createAdminClient(), actor.id as string, kind, targetId).then(
        () => undefined,
        (err) => {
          if (!(err instanceof ExpectedError)) report(err, { target: targetId });
        },
      ),
    );
  } catch (err) {
    report(err, { target: targetId });
  }
}

/** The ids of a target's made Forms, read before the target is deleted. Empty when unconfigured or unreadable. */
export async function managedFormIdsFor(admin: Admin, kind: ManagedKind, targetId: string): Promise<string[]> {
  try {
    if (readFormMaker(process.env).state !== 'ready') return [];
    const rows = await readRowsFor(admin, kind, targetId);
    return rows.filter((r) => r.state !== 'retired').map((r) => r.id);
  } catch (err) {
    report(err, { target: targetId });
    return [];
  }
}

/** After the response: sync the target's made Form, if it has one. */
export function scheduleManagedFormSync(kind: ManagedKind, targetId: string): void {
  try {
    if (readFormMaker(process.env).state !== 'ready') return;
    after(async () => {
      try {
        const admin = createAdminClient();
        for (const row of await readRowsFor(admin, kind, targetId)) {
          if (row.state === 'live' || row.state === 'unverified') await syncManagedForm(admin, row);
        }
      } catch (err) {
        report(err, { target: targetId });
      }
    });
  } catch (err) {
    report(err, { target: targetId });
  }
}

/** After the response: sync these made Forms (a deleted target's, read before the delete). */
export function scheduleManagedFormSyncFor(rowIds: string[]): void {
  try {
    if (rowIds.length === 0 || readFormMaker(process.env).state !== 'ready') return;
    after(async () => {
      try {
        const admin = createAdminClient();
        for (const id of rowIds) {
          const row = await readRow(admin, id);
          if (row) await syncManagedForm(admin, row);
        }
      } catch (err) {
        report(err, { rows: rowIds.length });
      }
    });
  } catch (err) {
    report(err, { rows: rowIds.length });
  }
}

// ---- the job ----------------------------------------------------------------

export interface ManagedFormSyncRun {
  skipped?: 'not_configured';
  checked: number;
  updated: number;
  failed: number;
  stopped?: 'time';
  /** Row ids only: nothing here names a person. */
  rows: string[];
}

/** The five-minute round: every made Form still in play, oldest attempt first. */
export async function runManagedFormSync(
  admin: Admin,
  deps: ManagedFormDeps = defaultManagedFormDeps,
): Promise<ManagedFormSyncRun> {
  const run: ManagedFormSyncRun = { checked: 0, updated: 0, failed: 0, rows: [] };
  if (readFormMaker(deps.env).state !== 'ready') return { ...run, skipped: 'not_configured' };

  const { data, error } = await table(admin)
    .select(MANAGED_ROW_COLUMNS)
    .in('state', ['live', 'unverified', 'failed'])
    .order('attempted_at', { ascending: true, nullsFirst: true })
    .limit(SYNC_BATCH * 4);
  if (error) throw new Error(`Could not read the managed forms: ${(error as { message: string }).message}`);
  const due = ((data ?? []) as unknown as ManagedFormRow[])
    .filter((row) => !(row.state === 'failed' && row.last_error && REPLACE_ONLY_ERRORS.has(row.last_error)))
    .filter((row) => !(row.accepting === false && row.close_reason && TERMINAL_REASONS.has(row.close_reason)))
    .slice(0, SYNC_BATCH);

  const started = deps.now();
  for (const row of due) {
    if (deps.now() - started > SYNC_TIME_BUDGET_MS) {
      run.stopped = 'time';
      break;
    }
    run.checked += 1;
    run.rows.push(row.id);
    let outcome: EnsureOutcome | SyncOutcome;
    if (row.state === 'failed') {
      const targetId = targetOf(row);
      if (!targetId || (row.attempted_at && deps.now() - Date.parse(row.attempted_at) < RETRY_AFTER_MS)) continue;
      try {
        outcome = await ensureManagedForm(admin, null, row.target_kind, targetId, deps, row.generation);
      } catch (err) {
        if (!(err instanceof ExpectedError)) report(err, { row: row.id });
        outcome = 'failed';
      }
    } else {
      outcome = await syncManagedForm(admin, row, deps);
    }
    if (outcome === 'failed') run.failed += 1;
    else if (outcome === 'updated' || outcome === 'created') run.updated += 1;
  }
  return run;
}
