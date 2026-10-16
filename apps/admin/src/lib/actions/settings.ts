'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, legalDocumentUpdateSchema, waiverDocumentSchema, eventWaiverTemplateUpdateSchema, type LegalDocumentUpdateInput, type EventWaiverTemplateUpdateInput, type WaiverDocument } from '@badminton/shared';
import { requireCapability } from './_shared';
import { ExpectedError, FEATURES_SETTING_KEY } from '@badminton/shared';
// TWO floors on purpose, and they are not the same number. Rating settings take
// the console's ordinary REASON_MIN (5) — enough to prove somebody typed
// something. A legal document takes MIN_REASON_LENGTH (10), because that reason
// is quoted back to every member in the re-sign prompt and "typo" is not an
// explanation anyone can act on. Both are imported rather than redeclared: a
// third hardcoded number is how the first two drift apart.
import { REASON_MIN } from '../audit-reason';
import { MIN_REASON_LENGTH } from '../legal-reason';
import { SEEDABLE_SETTINGS } from '../platform-setting-fields';
import {
  CLUB_SOCIALS_SETTING_KEY,
  MEMBERSHIP_PAYMENTS_SETTING_KEY,
  safeEtransferEmail,
  safeInstagramUrl,
  safePurchaseUrl,
} from '@badminton/shared';
import { clubToday } from '@badminton/shared';

// Platform configuration. Admin-only, and this is the boundary that matters:
// /ratings and /accounts merely decide who is shown the form.
//
// THE REASON IS REQUIRED, AND IT USED NOT TO BE. It arrived as an OPTIONAL
// parameter when /ratings was rebuilt, because /ratings had a reason box and
// /accounts' generic form did not — so the same audited action was reasoned
// from one screen and auto-captioned from the other, and which you got depended
// on which page you happened to open. PlatformSettingsForm now collects one
// too, so both call sites pass one and the parameter can say so.
//
// Enforced HERE and not only on the two Save buttons: a stale tab or a direct
// call to the server action reaches this write, and a floor that lives in the
// client is not a floor. REASON_MIN is imported, never redeclared.
export async function updatePlatformSettings(
  updates: { key: string; value: Record<string, unknown> }[],
  reason: string
) {
  const why = (reason ?? '').trim();
  if (why.length < REASON_MIN) {
    // Named for the thing being changed rather than for one of the two screens
    // — this used to say "the rating settings", which was wrong the moment
    // /accounts could reach it.
    throw new ExpectedError(
      `Changing a platform setting needs a reason of at least ${REASON_MIN} characters.`
    );
  }

  const admin = await requireCapability('platform.settings.write');
  const adminClient = createAdminClient();

  // EVERY KEY IS CHECKED BEFORE ANY KEY IS WRITTEN, in two passes.
  //
  // There is no transaction here — each key is a separate PostgREST call — so
  // a refusal raised halfway down a multi-key save leaves the keys before it
  // written and the keys after it untouched, and the officer sees only an error
  // toast. /accounts saves several keys at once, so that is a real shape. The
  // reason floor above was already all-or-nothing by being checked first; the
  // two per-key guards below would not have been, so they are hoisted to join
  // it. A write that fails at the database is still partial, and cannot be made
  // otherwise from here — but that is an outage, not a payload we could have
  // rejected.
  const checked: { key: string; value: Record<string, unknown>; stored: unknown; insert: boolean }[] = [];
  for (const update of updates) {
    const { data: found } = await adminClient
      .from('platform_settings')
      .select('value')
      .eq('key', update.key)
      .single();

    // A SEEDABLE KEY WITH NO ROW YET IS CREATED, not refused. The row stands
    // for its defaults until the first save (see SEEDABLE_SETTINGS), so it is
    // judged against those below, and written with an insert: the update
    // further down would match zero rows and audit a change that never landed.
    const seed = !found && Object.hasOwn(SEEDABLE_SETTINGS, update.key);
    const oldSetting = found ?? (seed ? { value: SEEDABLE_SETTINGS[update.key]!() } : null);

    // AN UNKNOWN KEY IS A REFUSAL, NOT A NO-OP. `.update().eq('key', ...)`
    // matches zero rows and returns no error, so an invented or misspelled key
    // used to sail all the way through and still write an audit row announcing
    // a change that never happened. `updates` is a client-controlled POST field
    // (see reference_server_action_params), so "no UI sends a bad key" is not
    // the same statement as "no caller does".
    if (!oldSetting) {
      throw new ExpectedError(`There is no platform setting called "${update.key}".`);
    }
    const stored = (oldSetting.value ?? {}) as Record<string, unknown>;

    // EVERY WRITE HERE REPLACES THE WHOLE JSONB BLOB, so a payload that is
    // missing a key DELETES that key. Both callers know it and both spread the
    // saved blob before overlaying their edits (ratings-form.tsx:265,
    // platform-settings-form.tsx:106) — which is exactly why this has been
    // invisible: the only two flows that exist happen to send a superset. The
    // two that are not flows are the ones that bite. A stale tab holds a blob
    // from before somebody else's save and writes their keys back out of
    // existence; and a hand-rolled POST of
    // `[{key:'rating_defaults', value:{tier_advanced_elo:9999}}]` wipes the
    // K-factors, the bounds and the two other tiers, with no error and a
    // perfectly ordinary-looking audit row.
    //
    // REFUSED RATHER THAN MERGED, and the difference matters. A server-side
    // shallow merge would make both of those harmless, and would also make key
    // DELETION impossible AND SILENT — the raw JSON <Textarea> that /ratings
    // offers for an unplaced key (ratings-form.tsx:422) is a deliberate
    // whole-blob editor, so an admin who removes a line there would watch it
    // reappear and be told nothing. Naming the keys covers both audiences: the
    // stale tab gets "reload", the deliberate deleter gets told where deletion
    // actually lives. Nothing in the app deletes a settings key — only
    // migrations add them — so there is no flow this costs.
    const dropped = Object.keys(stored).filter((field) => !(field in update.value));
    if (dropped.length > 0) {
      throw new ExpectedError(
        `Saving "${update.key}" would delete ${dropped.length === 1 ? 'the setting' : 'the settings'} `
          + `${dropped.join(', ')}, which this form has no way to have meant. Reload the page and `
          + `make the change again — if a key really should be removed, that is a migration, not a save.`
      );
    }

    const invalid = invalidClubLink(update.key, update.value);
    if (invalid) throw new ExpectedError(invalid);

    checked.push({
      key: update.key,
      value: update.value,
      // null for a row that did not exist: that is what the audit's "before" was.
      stored: seed ? null : oldSetting.value ?? null,
      insert: seed,
    });
  }

  for (const update of checked) {
    // Club changes (00286) draft a line from this write: its trigger records only
    // a write that sets updated_by and moves updated_at. Keep both.
    const row = {
      value: update.value,
      updated_by: admin.id,
      updated_at: new Date().toISOString(),
    };
    const { error } = update.insert
      ? await adminClient.from('platform_settings').insert({ key: update.key, ...row })
      : await adminClient.from('platform_settings').update(row).eq('key', update.key);

    if (error) throw new Error(`Failed to update ${update.key}: ${error.message}`);

    // Via logAdminAudit, not a bare insert: it checks the error and reports to
    // Sentry. The bare insert this replaced passed update.key into the `uuid`
    // target_id column and ignored the result, so every settings change since
    // launch went unaudited without a single symptom.
    await logAdminAudit(adminClient, {
      actor_id: admin.id,
      action_type: 'platform_setting_updated',
      target_type: 'platform_setting',
      target_id: null,
      // `stored` was read in the checking pass above, not re-read here — one
      // read per key, and the value the guard actually judged is the value the
      // audit row reports as the "before".
      old_value: update.stored,
      new_value: update.value,
      // Key FIRST. With target_id null this is the only place it appears, and
      // the /audit table truncates the reason cell at max-w-xs — "Platform
      // setting "repeat_opponent_caps" updated" is cut before the key ends.
      // The prefix is not decoration: /ratings reads these rows back by it to
      // find the last change to a rating key.
      //
      // No fallback caption any more. There used to be one for the reasonless
      // /accounts path, and with the reason required there is no such path.
      reason: `${update.key} — ${why}`,
    });
  }

  // The form now lives on /ratings and /accounts, not /settings.
  revalidatePath('/ratings');
  revalidatePath('/accounts');
  // The feature switches decide the console's nav, which the root layout
  // draws, so the whole tree re-renders rather than one page.
  if (checked.some((update) => update.key === FEATURES_SETTING_KEY)) revalidatePath('/', 'layout');
}

// THE TWO ROWS THE SITE PRINTS AS LINKS. The player app and the bot re-check
// every value on read and hide one that fails, so a bad save here would not be
// dangerous; it would be a link that silently vanishes. Refusing it at save
// time is what tells the officer why. '' is always allowed: it hides the link.
function invalidClubLink(key: string, value: Record<string, unknown>): string | null {
  const blankOr = (raw: unknown, ok: (v: string) => boolean) =>
    typeof raw === 'string' && (raw.trim() === '' || ok(raw));
  if (key === CLUB_SOCIALS_SETTING_KEY) {
    if (!blankOr(value.instagram_url, (v) => safeInstagramUrl(v) !== null)) {
      return 'The Instagram link has to be an https://www.instagram.com/ address, or empty to hide it.';
    }
    if (typeof value.show_discord !== 'boolean') {
      return 'Show Discord has to be on or off.';
    }
  }
  if (key === MEMBERSHIP_PAYMENTS_SETTING_KEY) {
    if (!blankOr(value.sfss_purchase_url, (v) => safePurchaseUrl(v) !== null)) {
      return 'The buy membership link has to start with https://, or be empty to hide the button.';
    }
    if (!blankOr(value.etransfer_email, (v) => safeEtransferEmail(v) !== null)) {
      return 'The e-transfer email does not look like an email address.';
    }
  }
  return null;
}

// Bumping re-requires acceptance from every member (the player app compares
// accepted versions against the current one). Versions are date strings; a
// same-day second bump appends '.2', '.3', ... so the string still changes.
function nextVersion(oldVersion: string): string {
  // The club's today. A version bumped on a Friday evening used to be stamped
  // with Saturday's date, and the version string is what every member's
  // acceptance record is compared against — so the wrong date is durable.
  const today = clubToday();
  if (oldVersion === today) return `${today}.2`;
  const sameDay = oldVersion.match(new RegExp(`^${today}\\.(\\d+)$`));
  if (sameDay) return `${today}.${Number(sameDay[1]) + 1}`;
  return today;
}

// The typed reason arrives as a SECOND PARAMETER rather than a field on
// `input`. legalDocumentUpdateSchema lives in @badminton/shared and is pinned
// by its own tests; the console's requirement that every audited action carry a
// reason is an admin-app rule, so it is enforced here, where the audit row is
// written. Validated server-side and not merely on the client: a reason the
// client gates on but the server never stores is the exact failure the rule
// exists to prevent — the audit row would still read as boilerplate.
function requireReason(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < MIN_REASON_LENGTH) {
    throw new Error(`A reason of at least ${MIN_REASON_LENGTH} characters is required`);
  }
  return trimmed;
}

export async function updateLegalDocument(input: LegalDocumentUpdateInput, reason: string) {
  parseOrThrow(legalDocumentUpdateSchema, input);
  const auditReason = requireReason(reason);
  const admin = await requireCapability('legal.documents.write');
  const adminClient = createAdminClient();

  const { data: old, error: readError } = await adminClient
    .from('legal_documents')
    .select('version, content')
    .eq('document', input.document)
    .single();
  if (readError) throw new Error(readError.message);

  const newVersion = input.bump_version ? nextVersion(old.version) : old.version;

  const { error } = await adminClient
    .from('legal_documents')
    .update({
      content: input.content,
      version: newVersion,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    })
    .eq('document', input.document);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'legal_document_updated',
    target_type: 'legal_document',
    // Keyed by `document`, not a uuid — see logAdminAudit. Passing the document
    // name here made this insert fail too, silently, since Legal shipped.
    target_id: null,
    old_value: { version: old.version, content_length: old.content.length },
    new_value: { version: newVersion, content_length: input.content.length },
    // Document first, same reason as above. The editor's own words are kept
    // verbatim after the machine-written summary: the summary says what the
    // action did, and only the typed half says why.
    reason: input.bump_version
      ? `${input.document} — legal document updated, version bumped (re-acceptance required): ${auditReason}`
      : `${input.document} — legal document content updated: ${auditReason}`,
  });

  // Left over from when the documents were a block inside /settings.
  revalidatePath('/legal');
}

// Save a season's event-waiver template (00074) — the text an exec pulls into
// a new tournament's "Event waiver" box instead of retyping it.
//
// legal.waivertemplate.write, which no baseline below admin holds: this is
// legal text, and it is the same boundary updateLegalDocument() draws — note
// that the third gate in this file, requireReacceptance(), belongs to `legal`
// too and IS exec work, so the area here does not follow the file. Execs read
// it on /legal and copy
// it into an event; only an admin changes the wording. There is deliberately
// no requireReacceptance() counterpart — nobody accepts a template. Editing it
// cannot reach anyone who has already signed, because a tournament holds its
// own copy of the text (see the migration header).
export async function updateEventWaiverTemplate(input: EventWaiverTemplateUpdateInput) {
  parseOrThrow(eventWaiverTemplateUpdateSchema, input);
  const admin = await requireCapability('legal.waivertemplate.write');
  const adminClient = createAdminClient();

  // maybeSingle, not single: a season with no template yet is the normal first
  // save, not an error. Only the active season is seeded.
  const { data: old, error: readError } = await adminClient
    .from('event_waiver_templates')
    .select('content')
    .eq('season_id', input.season_id)
    .maybeSingle();
  if (readError) throw new Error(readError.message);

  const { data: saved, error } = await adminClient
    .from('event_waiver_templates')
    .upsert(
      {
        season_id: input.season_id,
        content: input.content,
        updated_at: new Date().toISOString(),
        updated_by: admin.id,
      },
      { onConflict: 'season_id' }
    )
    .select('season_id');
  if (error) throw new Error(error.message);
  // PostgREST reports "matched no rows" as a success with an empty body, so a
  // missing error proves nothing was rejected — not that anything was written.
  // Without this, a season_id that no longer exists (or an upsert silently
  // filtered away) would toast "Saved" over an unchanged template.
  if (!saved || saved.length !== 1) {
    throw new Error('Template was not saved — the season may no longer exist');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'event_waiver_template_updated',
    target_type: 'event_waiver_template',
    // A real uuid here, unlike the legal_documents entries above: this table is
    // keyed by season_id, which is the seasons.id uuid.
    target_id: input.season_id,
    old_value: { content_length: old?.content.length ?? null },
    new_value: { content_length: input.content.length },
    reason: old
      ? 'event waiver template updated for a season'
      : 'event waiver template created for a season',
  });

  revalidatePath('/legal');
  // The create/edit tournament dialog is pre-filled from these rows.
  revalidatePath('/tournaments');
}

// Force every member to re-sign a specific document on their next visit,
// without editing its text or bumping its version. Stamps
// reacceptance_required_since = now(); the shared getMissingLegalDocuments
// helper then treats any acceptance older than this as stale.
// Exec-level on purpose: re-running the consent flow is operational — "everyone
// re-sign before the tournament" — and it cannot change what anyone is agreeing
// to. Editing the TEXT stays admin-only, which is where the legal exposure is.
export async function requireReacceptance(document: WaiverDocument, reason: string) {
  parseOrThrow(waiverDocumentSchema, document);
  const auditReason = requireReason(reason);
  const admin = await requireCapability('legal.reacceptance.write');
  const adminClient = createAdminClient();

  const { data: old, error: readError } = await adminClient
    .from('legal_documents')
    .select('reacceptance_required_since')
    .eq('document', document)
    .single();
  if (readError) throw new Error(readError.message);

  const now = new Date().toISOString();
  const { error } = await adminClient
    .from('legal_documents')
    .update({ reacceptance_required_since: now })
    .eq('document', document);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'legal_document_reacceptance_required',
    target_type: 'legal_document',
    target_id: null,
    old_value: { reacceptance_required_since: old.reacceptance_required_since },
    new_value: { reacceptance_required_since: now },
    reason: `${document} — all members must re-sign on their next visit: ${auditReason}`,
  });

  revalidatePath('/legal');
}
