'use client';

import { useState } from 'react';
import { Badge, Button } from '@badminton/ui';
import {
  DEFAULT_EMAIL_QUESTION,
  DEFAULT_EVENT_QUESTION,
  DEFAULT_NAME_QUESTION,
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
export const READER_ERROR_LABEL: Record<string, string> = {
  auth: "Google refused the console's service account key. Check the key in the console's settings.",
  forbidden: 'Google refused access: is the form in the shared folder?',
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
  const [rows, setRows] = useState<Record<string, EventRow>>(() => rowsFrom(mapping, events));

  if (!reader) return null;

  function build(): FormMapping {
    if (targetKind === 'club_event') {
      return {
        EMAIL_QUESTION: emailQuestion.trim(),
        NAME_QUESTION: nameQuestion.trim(),
        EVENT_QUESTION: '',
        EVENTS: {},
        DEFAULT_EVENT_ID: targetId,
        PARTNERS: {},
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
              disabled={pending || emailQuestion.trim() === '' || nameQuestion.trim() === '' || !!repeatedChoice}
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
