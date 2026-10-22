'use client';

import { useState } from 'react';
import { Badge, Button } from '@badminton/ui';
import {
  DEFAULT_EMAIL_QUESTION,
  DEFAULT_EVENT_QUESTION,
  DEFAULT_NAME_QUESTION,
  DEFAULT_RECEIPT_QUESTION,
  DEFAULT_WAIVER_QUESTION,
  DEFAULT_SIGNATURE_QUESTION,
  DEFAULT_MEDIA_QUESTION,
  DEFAULT_MEDIA_ALLOW_ANSWER,
  defaultPartnerQuestions,
  type FormMapping,
} from '@/lib/registration-form-mapping';
import type { FormBinding, ImportTargetKind } from '@/lib/registration-imports';

// ---------------------------------------------------------------------------
// READING ONE FORM WITH GOOGLE (00287), inside the Google Form card.
//
// The status of the console's reader for this binding (last read, responses
// imported, the last error) and the question mapping that turns it on. The
// mapping is the Apps Script's CONFIG, field by field: the questions are found
// by their TITLE on the form, and each event is the text of its choice.
// ---------------------------------------------------------------------------

export interface MappableEvent {
  id: string;
  label: string;
  doubles: boolean;
}

/** What each poll_error code means, in the desk's words. */
// Why an uploaded receipt (00288) did not reach the review, after its count.
const RECEIPT_PROBLEM_LABEL: Record<string, string> = {
  too_large: 'over 10 MB',
  bad_type: 'not an image or PDF',
  drive_forbidden: 'Drive would not hand over',
  download_failed: 'never downloaded',
  no_fee: 'with nothing to pay (an exec, a fee-exempt member, or someone not signed up)',
  duplicate: 'for a fee that already had one waiting',
};

// The problems a resent screenshot can fix. A receipt with no fee to pay, or one
// already waiting, needs nothing from the person.
const RESEND_FIXES = new Set(['too_large', 'bad_type', 'drive_forbidden', 'download_failed']);

export const READER_ERROR_LABEL: Record<string, string> = {
  auth: "Google refused the console's service account key. Check the key in the console's settings.",
  forbidden: 'Google refused access: share the form with the service account as an Editor',
  form_not_found: "Google has no form with this id. Copy the id from the form's edit link again.",
  rate_limited: 'Google asked the console to slow down. It carries on at the next read.',
  google_unavailable: 'Google did not answer. The console tries again at the next read.',
  google_refused: 'Google refused the read.',
  mapping_invalid: 'The question mapping is no longer valid. Open it and save it again.',
  questions_missing: 'The form has no question with the email or name title below. Check the titles match exactly.',
  responses_skipped:
    'Some responses were skipped: the email or name was missing, or an email was not an address. The same response sent by the script would be refused too.',
  import_failed: 'A response could not be imported. The console retries it at the next read.',
  not_bound: 'The link was switched off while the form was being read.',
};

function when(iso: string | null): string {
  if (!iso) return 'not yet';
  return new Date(iso).toLocaleString('en-CA', {
    timeZone: 'America/Vancouver',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const inputClass =
  'min-h-[44px] px-3 bg-[var(--bg-surface)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-60';

interface EventRow {
  choice: string;
  partnerName: string;
  partnerEmail: string;
  category: string;
}

function rowsFrom(mapping: FormMapping | null, events: MappableEvent[]): Record<string, EventRow> {
  const rows: Record<string, EventRow> = {};
  for (const event of events) {
    const choice = mapping ? (Object.entries(mapping.EVENTS).find(([, id]) => id === event.id)?.[0] ?? '') : event.label;
    const partner = mapping && choice ? mapping.PARTNERS[choice] : undefined;
    const defaults = defaultPartnerQuestions(choice || event.label);
    rows[event.id] = {
      choice,
      partnerName: partner?.NAME_QUESTION ?? (event.doubles && !mapping ? defaults.NAME_QUESTION : ''),
      partnerEmail: partner?.EMAIL_QUESTION ?? (event.doubles && !mapping ? defaults.EMAIL_QUESTION : ''),
      category: partner?.CATEGORY_QUESTION ?? '',
    };
  }
  return rows;
}

export function FormReaderPanel({
  binding,
  targetKind,
  targetId,
  events,
  canEdit,
  pending,
  onSave,
}: {
  binding: FormBinding;
  targetKind: ImportTargetKind;
  targetId: string;
  events: MappableEvent[];
  canEdit: boolean;
  pending: boolean;
  onSave: (mapping: FormMapping | null, after: () => void) => void;
}) {
  const reader = binding.reader;
  const mapping = reader?.mapping ?? null;
  const [editing, setEditing] = useState(false);
  const [emailQuestion, setEmailQuestion] = useState(mapping?.EMAIL_QUESTION ?? DEFAULT_EMAIL_QUESTION);
  const [nameQuestion, setNameQuestion] = useState(mapping?.NAME_QUESTION ?? DEFAULT_NAME_QUESTION);
  const [eventQuestion, setEventQuestion] = useState(mapping?.EVENT_QUESTION ?? DEFAULT_EVENT_QUESTION);
  // A saved mapping keeps what it has, '' (no receipt question) included.
  const [receiptQuestion, setReceiptQuestion] = useState(mapping ? mapping.RECEIPT_QUESTION : DEFAULT_RECEIPT_QUESTION);
  // The waiver questions (00295): a new mapping, or one saved before they
  // existed, starts from the Chaos Cards form's titles; a mapping saved since
  // keeps what it has, empty included.
  const waiverSaved = mapping && !reader?.waiverNeverSet ? mapping : null;
  const [waiverQuestion, setWaiverQuestion] = useState(waiverSaved ? waiverSaved.WAIVER_QUESTION : DEFAULT_WAIVER_QUESTION);
  const [signatureQuestion, setSignatureQuestion] = useState(
    waiverSaved ? waiverSaved.SIGNATURE_QUESTION : DEFAULT_SIGNATURE_QUESTION,
  );
  const [mediaQuestion, setMediaQuestion] = useState(waiverSaved ? waiverSaved.MEDIA_QUESTION : DEFAULT_MEDIA_QUESTION);
  const [mediaAllow, setMediaAllow] = useState(
    waiverSaved ? waiverSaved.MEDIA_ALLOW_ANSWER : DEFAULT_MEDIA_ALLOW_ANSWER,
  );
  const [waiverVersion, setWaiverVersion] = useState(mapping?.WAIVER_VERSION ?? '');
  const [rows, setRows] = useState<Record<string, EventRow>>(() => rowsFrom(mapping, events));

  if (!reader) return null;

  const waiverFields = () =>
    targetKind === 'season'
      ? { WAIVER_QUESTION: '', WAIVER_VERSION: '', SIGNATURE_QUESTION: '', MEDIA_QUESTION: '', MEDIA_ALLOW_ANSWER: '' }
      : {
          WAIVER_QUESTION: waiverQuestion.trim(),
          WAIVER_VERSION: waiverQuestion.trim() ? waiverVersion.trim() : '',
          SIGNATURE_QUESTION: signatureQuestion.trim(),
          MEDIA_QUESTION: mediaQuestion.trim(),
          MEDIA_ALLOW_ANSWER: mediaAllow.trim(),
        };

  function build(): FormMapping {
    if (targetKind === 'club_event' || targetKind === 'season') {
      return {
        EMAIL_QUESTION: emailQuestion.trim(),
        NAME_QUESTION: nameQuestion.trim(),
        EVENT_QUESTION: '',
        EVENTS: {},
        // A season's form names no event (00290).
        DEFAULT_EVENT_ID: targetKind === 'season' ? '' : targetId,
        PARTNERS: {},
        RECEIPT_QUESTION: receiptQuestion.trim(),
        ...waiverFields(),
      };
    }
    const eventsMap: Record<string, string> = {};
    const partners: FormMapping['PARTNERS'] = {};
    for (const event of events) {
      const row = rows[event.id];
      const choice = row?.choice.trim() ?? '';
      if (!row || !choice) continue;
      eventsMap[choice] = event.id;
      if (row.partnerName.trim() || row.partnerEmail.trim() || row.category.trim()) {
        partners[choice] = {
          NAME_QUESTION: row.partnerName.trim(),
          EMAIL_QUESTION: row.partnerEmail.trim(),
          CATEGORY_QUESTION: row.category.trim(),
        };
      }
    }
    return {
      EMAIL_QUESTION: emailQuestion.trim(),
      NAME_QUESTION: nameQuestion.trim(),
      EVENT_QUESTION: eventQuestion.trim(),
      EVENTS: eventsMap,
      DEFAULT_EVENT_ID: '',
      PARTNERS: partners,
      RECEIPT_QUESTION: receiptQuestion.trim(),
      ...waiverFields(),
    };
  }

  const choices = targetKind === 'tournament' ? events.map((e) => rows[e.id]?.choice.trim() ?? '').filter(Boolean) : [];
  const repeatedChoice = choices.find((choice, i) => choices.indexOf(choice) !== i);

  const setRow = (id: string, patch: Partial<EventRow>) =>
    setRows((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }));

  return (
    <div className="w-full space-y-2 text-xs">
      {mapping ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="info">Read by the console</Badge>
          <span className="text-[var(--text-muted)]">Last read: {when(reader.readAt)}</span>
          <span className="text-[var(--text-muted)]">
            {reader.importedCount} {reader.importedCount === 1 ? 'response' : 'responses'} imported
          </span>
        </div>
      ) : (
        <p className="text-[var(--text-muted)]">
          {reader.mappingInvalid
            ? READER_ERROR_LABEL.mapping_invalid
            : "Not read by the console. The form's Apps Script can post its responses instead."}
        </p>
      )}
      {mapping && reader.error && (
        <p role="status" className="text-[var(--color-danger)]">
          {READER_ERROR_LABEL[reader.error] ?? 'The last read failed.'}
        </p>
      )}
      {mapping && Object.keys(reader.receiptProblems).length > 0 && (
        <p role="status" className="text-[var(--color-warning)]">
          Uploaded receipts not in the review:{' '}
          {Object.entries(reader.receiptProblems)
            .map(([status, count]) => `${count} ${RECEIPT_PROBLEM_LABEL[status] ?? status}`)
            .join(', ')}
          .
          {Object.keys(reader.receiptProblems).some((status) => RESEND_FIXES.has(status)) &&
            ' Ask the person to email the screenshot instead.'}
        </p>
      )}

      {canEdit && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => setEditing(true)}>
            {mapping ? 'Edit question mapping' : 'Read this form with Google'}
          </Button>
          {mapping && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => onSave(null, () => undefined)}>
              Stop reading
            </Button>
          )}
        </div>
      )}

      {canEdit && editing && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] p-3 text-sm">
          <p className="text-xs text-[var(--text-muted)]">
            Type each question title exactly as it appears on the form. While the console reads this form, the
            form&apos;s Apps Script is refused for it, so a response is never imported twice.
          </p>
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-1 min-w-[12rem] flex-col gap-1 text-[var(--text-secondary)]">
              Email question
              <input className={inputClass} value={emailQuestion} onChange={(e) => setEmailQuestion(e.target.value)} />
            </label>
            <label className="flex flex-1 min-w-[12rem] flex-col gap-1 text-[var(--text-secondary)]">
              Full name question
              <input className={inputClass} value={nameQuestion} onChange={(e) => setNameQuestion(e.target.value)} />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-[var(--text-secondary)]">
            {targetKind === 'season'
              ? 'E-transfer screenshot question (a file upload)'
              : 'E-transfer screenshot question (a file upload; leave empty if the form has none)'}
            <input className={inputClass} value={receiptQuestion} onChange={(e) => setReceiptQuestion(e.target.value)} />
          </label>
          {targetKind !== 'season' && (
            <fieldset className="space-y-2 border-t border-[var(--border)] pt-2">
              <legend className="text-xs font-semibold text-[var(--text-secondary)]">Waiver on the form</legend>
              <p className="text-xs text-[var(--text-muted)]">
                A non-member who agrees on the form is signed for the guest waiver, with the signature and photo
                answer they gave. Leave the agree question empty if the form has no waiver.
              </p>
              <label className="flex flex-col gap-1 text-[var(--text-secondary)]">
                &quot;I agree&quot; question
                <input className={inputClass} value={waiverQuestion} onChange={(e) => setWaiverQuestion(e.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                <label className="flex flex-1 min-w-[12rem] flex-col gap-1 text-[var(--text-secondary)]">
                  Signature question
                  <input
                    className={inputClass}
                    value={signatureQuestion}
                    onChange={(e) => setSignatureQuestion(e.target.value)}
                  />
                </label>
                <label className="flex flex-1 min-w-[10rem] flex-col gap-1 text-[var(--text-secondary)]">
                  Waiver version the form shows
                  <input
                    className={inputClass}
                    value={waiverVersion}
                    placeholder="Empty: the current waiver"
                    onChange={(e) => setWaiverVersion(e.target.value)}
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <label className="flex flex-1 min-w-[12rem] flex-col gap-1 text-[var(--text-secondary)]">
                  Photo and video question
                  <input className={inputClass} value={mediaQuestion} onChange={(e) => setMediaQuestion(e.target.value)} />
                </label>
                <label className="flex flex-1 min-w-[8rem] flex-col gap-1 text-[var(--text-secondary)]">
                  Its &quot;yes&quot; choice
                  <input className={inputClass} value={mediaAllow} onChange={(e) => setMediaAllow(e.target.value)} />
                </label>
              </div>
            </fieldset>
          )}
          {targetKind === 'tournament' && (
            <>
              <label className="flex flex-col gap-1 text-[var(--text-secondary)]">
                Question listing the events
                <input className={inputClass} value={eventQuestion} onChange={(e) => setEventQuestion(e.target.value)} />
              </label>
              {events.length === 0 && (
                <p className="text-xs text-[var(--text-muted)]">This tournament has no events yet.</p>
              )}
              {events.map((event) => {
                const row = rows[event.id]!;
                return (
                  <fieldset key={event.id} className="space-y-2 border-t border-[var(--border)] pt-2">
                    <legend className="text-xs font-semibold text-[var(--text-secondary)]">{event.label}</legend>
                    <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                      Its choice on the form (leave empty if the form does not offer it)
                      <input
                        className={inputClass}
                        value={row.choice}
                        onChange={(e) => setRow(event.id, { choice: e.target.value })}
                      />
                    </label>
                    {event.doubles && (
                      <div className="flex flex-wrap gap-2">
                        <label className="flex flex-1 min-w-[10rem] flex-col gap-1 text-xs text-[var(--text-secondary)]">
                          Partner name question
                          <input
                            className={inputClass}
                            value={row.partnerName}
                            onChange={(e) => setRow(event.id, { partnerName: e.target.value })}
                          />
                        </label>
                        <label className="flex flex-1 min-w-[10rem] flex-col gap-1 text-xs text-[var(--text-secondary)]">
                          Partner email question
                          <input
                            className={inputClass}
                            value={row.partnerEmail}
                            onChange={(e) => setRow(event.id, { partnerEmail: e.target.value })}
                          />
                        </label>
                        <label className="flex flex-1 min-w-[10rem] flex-col gap-1 text-xs text-[var(--text-secondary)]">
                          Team category question (optional)
                          <input
                            className={inputClass}
                            value={row.category}
                            onChange={(e) => setRow(event.id, { category: e.target.value })}
                          />
                        </label>
                      </div>
                    )}
                  </fieldset>
                );
              })}
            </>
          )}
          {repeatedChoice && (
            <p role="alert" className="text-xs text-[var(--color-danger)]">
              Two events have the choice &quot;{repeatedChoice}&quot;. Each choice can enter one event.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                pending ||
                emailQuestion.trim() === '' ||
                nameQuestion.trim() === '' ||
                (targetKind === 'season' && receiptQuestion.trim() === '') ||
                !!repeatedChoice
              }
              onClick={() => onSave(build(), () => setEditing(false))}
            >
              Save and read
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
