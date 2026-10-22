'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, useConfirm } from '@badminton/ui';
import { createManagedForm, recheckManagedForm, replaceManagedForm } from '@/lib/actions/managed-forms';
import type { ManagedFormView } from '@/lib/registration-imports';

// ---------------------------------------------------------------------------
// THE FORM THE CONSOLE MAKES (00296), inside the Google Form card.
//
// Create copies the club's template Form for this target, binds it and reads
// it, so nobody pastes an id or types a question title. From then on the Form
// follows the event: its title, description, payment text and choices, and
// whether it takes responses. Hidden when the console has no form maker and
// has made no Form here.
// ---------------------------------------------------------------------------

/** What each last_error code means, in the desk's words. */
const ERROR_LABEL: Record<string, string> = {
  etransfer_unset: 'Set the e-transfer email under Accounts first.',
  unauthorized: 'The form maker could not be reached.',
  bad_response: 'The form maker could not be reached.',
  unreachable: 'The form maker could not be reached.',
  timeout: 'The form maker took too long to answer. Try again.',
  bad_request: 'The form maker refused the request.',
  template_missing: 'The form maker cannot find its template form.',
  folder_missing: 'The form maker cannot find the forms folder.',
  question_missing: 'The template is missing a question this form needs.',
  payment_section_missing:
    'The form has no Payment section with the e-transfer screenshot question, so the payment text cannot be written. Replace the form to start again from the template.',
  form_unknown: 'The form maker does not know this form.',
  staging_copy: "This row was copied from the club's console, so it names a form this console must not touch. Replace it to make this console's own form.",
  google_refused: 'Google refused the change.',
  questions_missing: "The form does not have every question the console reads. Check the template's question titles.",
  waiver_version_unset: "The form maker has no waiver version set for this template, so the form's waiver cannot sign anyone.",
  forbidden: "The console's service account cannot open the form yet.",
  form_not_found: 'Google has no form with this id yet.',
  auth: "Google refused the console's service account key.",
  rate_limited: 'Google asked the console to slow down. It tries again shortly.',
  google_unavailable: 'Google did not answer. The console tries again shortly.',
  mapping_invalid: 'The question mapping could not be saved.',
  sync_failed: 'The last update failed. The console tries again shortly.',
};

const CLOSE_LABEL: Record<string, string> = {
  cancelled: 'event cancelled',
  deleted: 'event deleted',
  started: 'event started',
  finished: 'finished',
  suspended: 'suspended',
  not_open: 'sign-ups not open yet',
  closed_time: 'sign-ups closed',
  full: 'full',
  no_events: 'no event open for entries',
  draft: 'not published yet',
};

/** A failed row only Replace can mend. */
const REPLACE_ONLY = new Set(['payment_section_missing', 'staging_copy']);

const POLL_MS = 5000;
const POLL_FOR_MS = 120_000;

const linkClass = 'text-[var(--text-primary)] underline';

export function ManagedFormPanel({
  view,
  targetKind,
  targetId,
  canCreate,
  canEdit,
  className = '',
}: {
  /** Null before 00296. */
  view: ManagedFormView | null;
  targetKind: 'club_event' | 'tournament';
  targetId: string;
  /** May edit the target, and nothing else takes its sign-ups (no Form bound by hand, no linked club event). */
  canCreate: boolean;
  /** May edit the target. */
  canEdit: boolean;
  className?: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const creating = view?.row?.state === 'creating';

  // While the maker works, the page refreshes itself for up to two minutes.
  useEffect(() => {
    if (!creating) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > POLL_FOR_MS) {
        clearInterval(timer);
        return;
      }
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [creating, router]);

  if (!view) return null;
  const row = view.row;
  if (!view.configured && !row) return null;
  if (!row && !canCreate) return null;

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error);
      router.refresh();
    });
  }

  const problem = row?.lastError ? (ERROR_LABEL[row.lastError] ?? 'The last change failed.') : null;
  const staleWaiver =
    !!row?.templateWaiverVersion && !!view.liveWaiverVersion && row.templateWaiverVersion !== view.liveWaiverVersion;

  return (
    <div className={`space-y-2 rounded-xl border border-[var(--border)] p-3 text-sm ${className}`}>
      {!row && (
        <>
          <p className="text-xs text-[var(--text-muted)]">
            The console can make this {targetKind === 'tournament' ? "tournament's" : "event's"} Google Form from the
            club&apos;s template, read its responses here, and keep it in step with the{' '}
            {targetKind === 'tournament' ? 'tournament' : 'event'}: its details, payment text
            {targetKind === 'tournament' ? ', event choices' : ''} and whether it takes sign-ups.
          </p>
          <Button size="sm" disabled={pending} onClick={() => run(() => createManagedForm(targetKind, targetId))}>
            Make a Google Form
          </Button>
        </>
      )}

      {row?.state === 'creating' && (
        <p role="status" className="text-[var(--text-muted)]">
          Making the form. This page refreshes itself.
        </p>
      )}

      {row?.state === 'failed' && (
        <>
          <p role="status" className="text-[var(--color-danger)]">
            The form was not made. {problem}
          </p>
          {canEdit && !REPLACE_ONLY.has(row.lastError ?? '') && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => recheckManagedForm(row.id))}>
              Retry
            </Button>
          )}
        </>
      )}

      {(row?.state === 'unverified' || row?.state === 'live') && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info">Made by the console</Badge>
            {row.state === 'unverified' ? (
              <Badge variant="warning">Not read yet</Badge>
            ) : row.accepting === false ? (
              <Badge variant="neutral">Closed{row.closeReason ? `: ${CLOSE_LABEL[row.closeReason] ?? row.closeReason}` : ''}</Badge>
            ) : (
              <Badge variant="success">Accepting responses</Badge>
            )}
            {row.responderUrl && (
              <a href={row.responderUrl} target="_blank" rel="noreferrer" className={linkClass}>
                Open the form
              </a>
            )}
            {row.editUrl && (
              <a href={row.editUrl} target="_blank" rel="noreferrer" className={linkClass}>
                Edit in Google Forms
              </a>
            )}
          </div>
          {row.state === 'unverified' && (
            <p className="text-xs text-[var(--text-muted)]">
              The form was made, but the console has not confirmed it can read it, so its responses are not imported
              yet.
            </p>
          )}
          {problem && (
            <p role="status" className="text-[var(--color-danger)]">
              {problem}
            </p>
          )}
          {staleWaiver && (
            <p role="status" className="text-[var(--color-warning)]">
              The form shows waiver version {row.templateWaiverVersion}, but the published waiver is{' '}
              {view.liveWaiverVersion}, so the form signs nobody. Update the template&apos;s waiver text and its version
              in the form maker, then replace the form.
            </p>
          )}
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              {row.state === 'unverified' && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => run(() => recheckManagedForm(row.id))}
                >
                  Check again
                </Button>
              )}
              {(row.lastError === 'payment_section_missing' || staleWaiver) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Replace the form?',
                      message:
                        'The current form is closed and a new one is made from the template. Responses already imported stay. Anyone holding the old link will need the new one.',
                      confirmLabel: 'Replace',
                      danger: true,
                    });
                    if (ok) run(() => replaceManagedForm(row.id));
                  }}
                >
                  Replace the form
                </Button>
              )}
            </div>
          )}
        </>
      )}

      {row?.state === 'failed' && REPLACE_ONLY.has(row.lastError ?? '') && canEdit && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={async () => {
            const ok = await confirm({
              title: 'Replace the form?',
              message: 'A new form is made from the template.',
              confirmLabel: 'Replace',
              danger: true,
            });
            if (ok) run(() => replaceManagedForm(row.id));
          }}
        >
          Replace the form
        </Button>
      )}

      {error && (
        <p role="alert" className="text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
