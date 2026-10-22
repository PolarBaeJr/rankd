import * as Sentry from '@sentry/nextjs';
import { TOURNAMENT_EVENT_TYPE_LABELS } from '@badminton/shared';
import type { createAdminClient } from './supabase-server';
import { formMappingSchema, type FormMapping } from './registration-form-mapping';
import { readFormMaker } from './form-maker';

// GOOGLE FORM REGISTRATIONS (00283, 00284): what the console shows about them.
//
// One reader for the tournament page and the club event page: the form
// bindings on the target, the keys' consumers to bind against, and every entry
// the forms produced, with the guest waiver, the invite and the fee beside it.
// And for /fees (00290): a season's form makes no entries, so it lists each
// response with where its screenshot went and the dues it was filed against.
//
// SERVER ONLY. It reads with the service client and returns non-members' typed
// emails, so a page renders it only behind the capability that opens the page.

type Admin = ReturnType<typeof createAdminClient>;

export type ImportTargetKind = 'tournament' | 'club_event' | 'season';

export interface FormBinding {
  id: string;
  formId: string;
  consumerId: string;
  consumerName: string;
  active: boolean;
  joinWaitlist: boolean;
  soloDoublesAck: boolean;
  createdAt: string;
  /**
   * Reading the form through the Google Forms API (00287). Null before that
   * migration. `mapping` null: the console does not read this form and its
   * Apps Script may post it.
   */
  reader: {
    mapping: FormMapping | null;
    /** A stored mapping that no longer parses; the card asks for a fresh save. */
    mappingInvalid: boolean;
    /**
     * The stored mapping predates the waiver questions (00295), so its empty
     * waiver fields were never chosen: the editor offers the defaults.
     */
    waiverNeverSet: boolean;
    /** The same for the preferred partner question (00299). */
    partnerNoteNeverSet: boolean;
    readAt: string | null;
    attemptedAt: string | null;
    importedCount: number;
    error: string | null;
    /**
     * Uploaded receipts that did not reach the review (00288), by why: the
     * file was too big, not an image or PDF, Drive refused it, it never
     * downloaded, no fee matched, or the fee already had a receipt waiting.
     */
    receiptProblems: Record<string, number>;
  } | null;
}

export interface ImportedEntry {
  id: string;
  responseId: string;
  submittedAt: string | null;
  /** The member's name, or the name a non-member typed. */
  person: string;
  isMember: boolean;
  /** A non-member's typed email. Never set for a member. */
  email: string | null;
  partner: string | null;
  event: string;
  eventId: string | null;
  status: string;
  reason: string | null;
  inPair: boolean;
  fee: { amountCents: number | null; paid: boolean } | null;
  waiver: { signed: boolean; signedAt: string | null } | null;
  invite: 'sent' | 'queued' | 'failed' | 'cancelled' | 'off' | null;
}

/** One response to a season's form (00290). */
export interface ImportedResponse {
  id: string;
  responseId: string;
  submittedAt: string | null;
  /** The member's name, or the name a non-member typed. */
  person: string;
  isMember: boolean;
  /** A non-member's typed email. Never set for a member. */
  email: string | null;
  /** A later response by the same person replaced this one. */
  replaced: boolean;
  /** The screenshot's status (registration_import_receipts.status), or null when none was uploaded. */
  receipt: string | null;
  /** The dues the screenshot was filed against. */
  fee: { amountCents: number | null; paid: boolean } | null;
}

export interface RegistrationImportView {
  /** Null when the database is older than 00283. */
  bindings: FormBinding[] | null;
  consumers: { id: string; name: string }[];
  entries: ImportedEntry[];
  /** A season's responses (00290); empty for a tournament or club event. */
  responses: ImportedResponse[];
}

const MISSING = 'PGRST205';
const UNDEFINED_COLUMN = '42703';

function readerOf(row: Record<string, unknown>): FormBinding['reader'] {
  const stored = row.read_mapping;
  const parsed = stored == null ? null : formMappingSchema.safeParse(stored);
  return {
    mapping: parsed?.success ? parsed.data : null,
    mappingInvalid: !!parsed && !parsed.success,
    waiverNeverSet:
      !!stored && typeof stored === 'object' && !Object.prototype.hasOwnProperty.call(stored, 'WAIVER_QUESTION'),
    partnerNoteNeverSet:
      !!stored && typeof stored === 'object' && !Object.prototype.hasOwnProperty.call(stored, 'PARTNER_NOTE_QUESTION'),
    readAt: (row.poll_read_at as string | null) ?? null,
    attemptedAt: (row.poll_attempted_at as string | null) ?? null,
    importedCount: (row.poll_imported_count as number | null) ?? 0,
    error: (row.poll_error as string | null) ?? null,
    receiptProblems: {},
  };
}

/** The receipt statuses the card reports: everything that did not reach a reviewer or a settled fee. */
export const RECEIPT_PROBLEMS = ['too_large', 'bad_type', 'drive_forbidden', 'download_failed', 'no_fee', 'duplicate'];

/** Every row this page needs, or bindings null before the migration. */
export async function loadRegistrationImports(
  admin: Admin,
  kind: ImportTargetKind,
  targetId: string,
  opts: { guestWaiversOn: boolean },
): Promise<RegistrationImportView> {
  const column = kind === 'tournament' ? 'tournament_id' : kind === 'season' ? 'season_id' : 'club_event_id';
  const baseColumns = 'id, form_id, consumer_id, active, join_waitlist, solo_doubles_ack, created_at';
  const readerColumns = 'read_mapping, poll_read_at, poll_attempted_at, poll_imported_count, poll_error';
  const readBindings = (columns: string) =>
    admin.from('registration_import_forms').select(columns).eq(column, targetId).order('created_at');
  const [firstBindingsRes, consumersRes] = await Promise.all([
    readBindings(`${baseColumns}, ${readerColumns}`),
    // Never `*`: 00241 grants the service role named columns only.
    admin.from('data_api_consumers').select('id, name').order('name'),
  ]);
  // Before 00287 the reader's columns do not exist: read without them.
  const readerMissing = firstBindingsRes.error?.code === UNDEFINED_COLUMN;
  const bindingsRes = readerMissing ? await readBindings(baseColumns) : firstBindingsRes;
  if (bindingsRes.error) {
    if (bindingsRes.error.code === MISSING) return { bindings: null, consumers: [], entries: [], responses: [] };
    // Before 00290 there is no season column: no form can be linked yet.
    if (kind === 'season' && bindingsRes.error.code === UNDEFINED_COLUMN) {
      return { bindings: null, consumers: [], entries: [], responses: [] };
    }
    throw new Error(`Could not read the form bindings: ${bindingsRes.error.message}`);
  }
  if (consumersRes.error) throw new Error(`Could not read the data API consumers: ${consumersRes.error.message}`);
  const consumers = (consumersRes.data ?? []) as { id: string; name: string }[];
  const consumerName = (id: string) => consumers.find((c) => c.id === id)?.name ?? 'Unknown consumer';

  const bindingRows = (bindingsRes.data ?? []) as unknown as Record<string, unknown>[];
  const bindings: FormBinding[] = bindingRows.map((b) => ({
    id: b.id as string,
    formId: b.form_id as string,
    consumerId: b.consumer_id as string,
    consumerName: consumerName(b.consumer_id as string),
    active: b.active as boolean,
    joinWaitlist: b.join_waitlist as boolean,
    soloDoublesAck: b.solo_doubles_ack as boolean,
    createdAt: b.created_at as string,
    reader: readerMissing ? null : readerOf(b),
  }));
  if (bindings.length === 0) return { bindings, consumers, entries: [], responses: [] };

  // Before 00288 the table does not exist: no counts.
  const problemsRes = await admin
    .from('registration_import_receipts')
    .select('status, registration_imports!inner(binding_id)')
    .in('registration_imports.binding_id', bindings.map((b) => b.id))
    .in('status', RECEIPT_PROBLEMS);
  if (problemsRes.error && problemsRes.error.code !== MISSING) {
    throw new Error(`Could not read the form receipts: ${problemsRes.error.message}`);
  }
  for (const row of (problemsRes.data ?? []) as unknown as { status: string; registration_imports: { binding_id: string } }[]) {
    const reader = bindings.find((b) => b.id === row.registration_imports.binding_id)?.reader;
    if (reader) reader.receiptProblems[row.status] = (reader.receiptProblems[row.status] ?? 0) + 1;
  }

  const importsRes = await admin
    .from('registration_imports')
    .select('id, response_id, submitted_at')
    .in('binding_id', bindings.map((b) => b.id))
    .order('created_at', { ascending: false })
    .limit(500);
  if (importsRes.error) throw new Error(`Could not read the imported responses: ${importsRes.error.message}`);
  const imports = importsRes.data ?? [];
  if (imports.length === 0) return { bindings, consumers, entries: [], responses: [] };
  if (kind === 'season') {
    return { bindings, consumers, entries: [], responses: await loadSeasonResponses(admin, imports.map((i) => i.id as string)) };
  }

  const entriesRes = await admin
    .from('registration_import_entries')
    .select(
      'id, import_id, item, tournament_event_id, club_event_id, entrant_id, requested_partner_id, external_name, external_email, partner_name, status, reason, pair_id, fee_id, created_at',
    )
    .in('import_id', imports.map((i) => i.id as string))
    .order('created_at', { ascending: false });
  if (entriesRes.error) throw new Error(`Could not read the imported entries: ${entriesRes.error.message}`);
  const rows = entriesRes.data ?? [];

  const playerIds = [
    ...new Set(
      rows.flatMap((r) => [r.entrant_id, r.requested_partner_id]).filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const eventIds = [...new Set(rows.map((r) => r.tournament_event_id).filter((id): id is string => !!id))];
  const feeIds = [...new Set(rows.map((r) => r.fee_id).filter((id): id is string => !!id))];
  const entryIds = rows.map((r) => r.id as string);

  const [playersRes, eventsRes, feesRes, invitesRes] = await Promise.all([
    playerIds.length
      ? admin.from('players').select('id, full_name').in('id', playerIds)
      : Promise.resolve({ data: [], error: null }),
    eventIds.length
      ? admin.from('tournament_events').select('id, event_type').in('id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    feeIds.length
      ? admin.from('club_fees').select('id, amount_cents, paid_at').in('id', feeIds)
      : Promise.resolve({ data: [], error: null }),
    entryIds.length
      ? admin
          .from('guest_waiver_invites')
          .select('import_entry_id, sent_at, cancelled_at, attempts, last_error')
          .in('import_entry_id', entryIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const [what, res] of [
    ['players', playersRes],
    ['events', eventsRes],
    ['fees', feesRes],
    ['invites', invitesRes],
  ] as const) {
    if (res.error) throw new Error(`Could not read the imported entries' ${what}: ${res.error.message}`);
  }
  const name = (id: string | null) =>
    id ? ((playersRes.data ?? []) as { id: string; full_name: string }[]).find((p) => p.id === id)?.full_name ?? 'A member' : null;
  const eventName = (id: string | null) => {
    if (!id) return 'Sign-up';
    const type = ((eventsRes.data ?? []) as { id: string; event_type: string }[]).find((e) => e.id === id)?.event_type;
    return type ? (TOURNAMENT_EVENT_TYPE_LABELS as Record<string, string>)[type] ?? type : 'Event';
  };

  // The waiver lookup is per email, and only for non-members.
  const emails = [...new Set(rows.map((r) => r.external_email).filter((e): e is string => !!e))];
  const waivers = new Map<string, { signed: boolean; signedAt: string | null }>();
  await Promise.all(
    emails.slice(0, 200).map(async (email) => {
      const { data, error } = await admin.rpc('guest_waiver_status', { p_email: email });
      if (error) {
        Sentry.captureException(error, { tags: { read: 'guest_waiver_status' } });
        return;
      }
      const status = data as { signed?: boolean; signed_at?: string | null } | null;
      waivers.set(email, { signed: status?.signed === true, signedAt: status?.signed_at ?? null });
    }),
  );

  const importById = new Map(imports.map((i) => [i.id as string, i]));
  const entries: ImportedEntry[] = rows.map((r) => {
    const parent = importById.get(r.import_id as string);
    const fee = ((feesRes.data ?? []) as { id: string; amount_cents: number | null; paid_at: string | null }[]).find(
      (f) => f.id === r.fee_id,
    );
    const invite = ((invitesRes.data ?? []) as {
      import_entry_id: string;
      sent_at: string | null;
      cancelled_at: string | null;
      attempts: number;
      last_error: string | null;
    }[]).find((i) => i.import_entry_id === r.id);
    const isMember = !!r.entrant_id;
    return {
      id: r.id as string,
      responseId: (parent?.response_id as string) ?? '',
      submittedAt: (parent?.submitted_at as string | null) ?? null,
      person: isMember ? name(r.entrant_id as string)! : ((r.external_name as string | null) ?? 'A guest'),
      isMember,
      email: isMember ? null : ((r.external_email as string | null) ?? null),
      partner: name(r.requested_partner_id as string | null) ?? ((r.partner_name as string | null) ?? null),
      event: kind === 'club_event' ? 'Sign-up' : eventName(r.tournament_event_id as string | null),
      eventId: (r.tournament_event_id as string | null) ?? (r.club_event_id as string | null) ?? null,
      status: r.status as string,
      reason: (r.reason as string | null) ?? null,
      inPair: !!r.pair_id,
      fee: fee ? { amountCents: fee.amount_cents, paid: !!fee.paid_at } : null,
      waiver: !isMember && r.external_email ? (waivers.get(r.external_email as string) ?? null) : null,
      invite: !invite
        ? null
        : invite.sent_at
          ? 'sent'
          : invite.cancelled_at
            ? 'cancelled'
            : !opts.guestWaiversOn
              ? 'off'
              : invite.attempts >= 3 && invite.last_error
                ? 'failed'
                : 'queued',
    };
  });
  return { bindings, consumers, entries, responses: [] };
}

/** A season form's responses, newest first, with the screenshot's road and the dues it reached. */
async function loadSeasonResponses(admin: Admin, importIds: string[]): Promise<ImportedResponse[]> {
  const [importsRes, receiptsRes] = await Promise.all([
    admin
      .from('registration_imports')
      .select('id, response_id, submitted_at, submitter_player_id, submitter_name, submitter_email, superseded_by')
      .in('id', importIds)
      .order('created_at', { ascending: false }),
    admin.from('registration_import_receipts').select('import_id, status, fee_submission_id').in('import_id', importIds),
  ]);
  if (importsRes.error) throw new Error(`Could not read the imported responses: ${importsRes.error.message}`);
  if (receiptsRes.error) throw new Error(`Could not read the form receipts: ${receiptsRes.error.message}`);
  const rows = (importsRes.data ?? []) as {
    id: string;
    response_id: string;
    submitted_at: string | null;
    submitter_player_id: string | null;
    submitter_name: string | null;
    submitter_email: string | null;
    superseded_by: string | null;
  }[];
  const receipts = (receiptsRes.data ?? []) as { import_id: string; status: string; fee_submission_id: string | null }[];

  const playerIds = [...new Set(rows.map((r) => r.submitter_player_id).filter((id): id is string => !!id))];
  const submissionIds = receipts.map((r) => r.fee_submission_id).filter((id): id is string => !!id);
  const [playersRes, submissionsRes] = await Promise.all([
    playerIds.length
      ? admin.from('players').select('id, full_name').in('id', playerIds)
      : Promise.resolve({ data: [], error: null }),
    submissionIds.length
      ? admin.from('fee_submissions').select('id, club_fee_id').in('id', submissionIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (playersRes.error) throw new Error(`Could not read the responses' members: ${playersRes.error.message}`);
  if (submissionsRes.error) throw new Error(`Could not read the responses' receipts: ${submissionsRes.error.message}`);
  const submissions = (submissionsRes.data ?? []) as { id: string; club_fee_id: string }[];
  const feeIds = [...new Set(submissions.map((s) => s.club_fee_id))];
  const feesRes = feeIds.length
    ? await admin.from('club_fees').select('id, amount_cents, paid_at').in('id', feeIds)
    : { data: [], error: null };
  if (feesRes.error) throw new Error(`Could not read the responses' dues: ${feesRes.error.message}`);
  const fees = (feesRes.data ?? []) as { id: string; amount_cents: number | null; paid_at: string | null }[];
  const players = (playersRes.data ?? []) as { id: string; full_name: string }[];

  return rows.map((r) => {
    const receipt = receipts.find((x) => x.import_id === r.id);
    const feeId = submissions.find((x) => x.id === receipt?.fee_submission_id)?.club_fee_id;
    const fee = feeId ? fees.find((f) => f.id === feeId) : undefined;
    const isMember = !!r.submitter_player_id;
    return {
      id: r.id,
      responseId: r.response_id,
      submittedAt: r.submitted_at,
      person: isMember
        ? (players.find((p) => p.id === r.submitter_player_id)?.full_name ?? 'A member')
        : (r.submitter_name ?? 'A non-member'),
      isMember,
      email: isMember ? null : r.submitter_email,
      replaced: !!r.superseded_by,
      receipt: receipt?.status ?? null,
      fee: fee ? { amountCents: fee.amount_cents, paid: !!fee.paid_at } : null,
    };
  });
}

// ---- THE FORM THE CONSOLE MADE (00296) --------------------------------------

/** What the Google Form card shows about the target's made Form. No personal data is in it. */
export interface ManagedFormView {
  /** The console has the form maker's address and secret. */
  configured: boolean;
  row: {
    id: string;
    state: 'creating' | 'failed' | 'unverified' | 'live';
    bindingId: string | null;
    responderUrl: string | null;
    editUrl: string | null;
    accepting: boolean | null;
    closeReason: string | null;
    lastError: string | null;
    templateWaiverVersion: string | null;
    claimedAt: string | null;
  } | null;
  /** The published waiver's version, to say when the template's text is older. */
  liveWaiverVersion: string | null;
}

/** The target's current made Form, or null before 00296. */
export async function loadManagedForm(
  admin: Admin,
  kind: 'club_event' | 'tournament',
  targetId: string,
): Promise<ManagedFormView | null> {
  const column = kind === 'tournament' ? 'tournament_id' : 'club_event_id';
  const [rowsRes, waiverRes] = await Promise.all([
    admin
      .from('managed_registration_forms' as never)
      .select(
        'id, state, binding_id, responder_url, edit_url, accepting, close_reason, last_error, template_waiver_version, claimed_at',
      )
      .eq(column, targetId)
      .neq('state', 'retired')
      .order('created_at', { ascending: false })
      .limit(1),
    admin.from('legal_documents').select('version').eq('document', 'waiver').maybeSingle(),
  ]);
  if (rowsRes.error) {
    if ((rowsRes.error as { code?: string }).code === MISSING) return null;
    throw new Error(`Could not read the made form: ${(rowsRes.error as { message: string }).message}`);
  }
  const stored = ((rowsRes.data ?? []) as unknown as Record<string, unknown>[])[0];
  return {
    configured: readFormMaker().state === 'ready',
    row: stored
      ? {
          id: stored.id as string,
          state: stored.state as NonNullable<ManagedFormView['row']>['state'],
          bindingId: (stored.binding_id as string | null) ?? null,
          responderUrl: (stored.responder_url as string | null) ?? null,
          editUrl: (stored.edit_url as string | null) ?? null,
          accepting: (stored.accepting as boolean | null) ?? null,
          closeReason: (stored.close_reason as string | null) ?? null,
          lastError: (stored.last_error as string | null) ?? null,
          templateWaiverVersion: (stored.template_waiver_version as string | null) ?? null,
          claimedAt: (stored.claimed_at as string | null) ?? null,
        }
      : null,
    liveWaiverVersion: waiverRes.error ? null : ((waiverRes.data?.version as string | undefined) ?? null),
  };
}
