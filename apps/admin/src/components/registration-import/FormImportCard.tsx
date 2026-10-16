'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Checkbox, useConfirm } from '@badminton/ui';
import {
  bindRegistrationForm,
  saveRegistrationFormMapping,
  setRegistrationFormActive,
  undoImportedEntry,
} from '@/lib/actions/registration-imports';
import { FormReaderPanel, type MappableEvent } from './FormReaderPanel';
import type { ActionResult } from '@/lib/action-result';
import type { FormBinding, ImportedEntry, ImportTargetKind } from '@/lib/registration-imports';

// ---------------------------------------------------------------------------
// GOOGLE FORM REGISTRATIONS on a tournament or club event (00283, 00284).
//
// The form's Apps Script posts each response to the Data API with a key that
// carries registrations:write. A response lands here only once the form is
// bound to this target against that key's consumer. Or (00287) the console
// reads the form itself through the Google Forms API, once the binding has a
// question mapping; a form takes one road or the other, never both. Members are never entered
// by a form: they confirm in the app. Non-members are entered at once in the
// events open to them, owe a named fee, and are sent the guest waiver once
// that feature is on.
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = {
  entered: 'Entered',
  awaiting_member: 'Waiting for the member',
  awaiting_partner: 'Waiting for the partner',
  needs_review: 'Needs review',
  refused: 'Refused',
  undone: 'Undone',
  superseded: 'Replaced',
};

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  entered: 'success',
  awaiting_member: 'info',
  awaiting_partner: 'info',
  needs_review: 'warning',
  refused: 'danger',
  undone: 'neutral',
  superseded: 'neutral',
};

/** What each parked or refused reason means, in the desk's words. */
const REASON_LABEL: Record<string, string> = {
  event_full: 'Event full',
  waitlist_queue: 'Others are waiting',
  registration_closed: 'Registration closed',
  registration_not_open: 'Registration not open yet',
  registration_window_closed: 'Registration window closed',
  event_not_in_target: 'Event not in this tournament',
  duplicate_in_submission: 'Same event twice',
  already_registered: 'Already entered',
  duplicate_team: 'This team is already entered',
  not_me: 'The member said it was not them',
  removed_from_form: 'Removed when the response changed',
  paired_elsewhere: 'Paired another way',
  partner_is_self: 'Named themselves as partner',
  external_in_member_event: 'Non-member in a members event',
  external_partner: 'Member with a non-member partner',
  external_without_partner: 'Non-member with no partner in doubles',
  external_not_available: 'Event not open to non-members',
  external_pair_refused: 'The external team was refused',
  external_refused: 'The sign-up was refused',
  member_in_external_event: 'Member in an external event',
  member_partner_in_external_event: 'Partner is a member, in an external event',
  banned: 'Member is suspended',
  suspended: 'Member is suspended',
  deletion_pending: 'Member asked for deletion',
  pending_approval: 'Member not approved yet',
  not_eligible: 'Member cannot sign up right now',
  no_rating: 'Member has no rating',
  withdrawn_reentry: 'Member withdrew from this event before',
  full: 'Event full',
  closed: 'Sign-ups closed',
  not_open_yet: 'Sign-ups not open yet',
  cancelled: 'Event cancelled',
  started: 'Event started',
  not_published: 'Event not published',
};

const INVITE_LABEL: Record<NonNullable<ImportedEntry['invite']>, string> = {
  sent: 'Waiver email sent',
  queued: 'Waiver email queued',
  failed: 'Waiver email failed',
  cancelled: 'Waiver email cancelled',
  off: 'Waiver email held: guest waivers are off',
};

const inputClass =
  'min-h-[44px] px-3 bg-[var(--bg-surface)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-60';

function money(cents: number | null): string {
  return cents === null ? 'TBD' : `$${(cents / 100).toFixed(2)}`;
}

export function FormImportCard({
  targetKind,
  targetId,
  bindings,
  consumers,
  entries,
  canBind,
  canUndo,
  migrationMissing,
  reader,
  events = [],
}: {
  targetKind: ImportTargetKind;
  targetId: string;
  /** Null before 00283. */
  bindings: FormBinding[] | null;
  consumers: { id: string; name: string }[];
  entries: ImportedEntry[];
  /** The capability that edits this target. */
  canBind: boolean;
  /** Any remove capability for this target's entries; the server asks per entry. */
  canUndo: boolean;
  migrationMissing: string;
  /** The console's Google Forms reader: never the key, at most the account's email. */
  reader: { state: 'not_configured' } | { state: 'invalid' } | { state: 'ready'; clientEmail: string };
  /** A tournament's events, for the question mapping. */
  events?: MappableEvent[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [formId, setFormId] = useState('');
  const [consumerId, setConsumerId] = useState(consumers[0]?.id ?? '');
  const [joinWaitlist, setJoinWaitlist] = useState(false);
  const [soloDoublesAck, setSoloDoublesAck] = useState(false);

  function run(action: () => Promise<ActionResult<void>>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error);
      else after?.();
      router.refresh();
    });
  }

  if (bindings === null) {
    return <p className="text-sm text-[var(--text-muted)]">{migrationMissing}</p>;
  }

  const live = entries.filter((e) => e.status !== 'superseded');
  const readerShown = bindings.some((b) => b.reader !== null);

  return (
    <div className="space-y-4">
      {readerShown && (
        <p className="text-xs text-[var(--text-muted)]">
          {reader.state === 'ready' ? (
            <>
              The console can read a form itself when the form is in the club&apos;s forms folder, shared with{' '}
              <code className="break-all">{reader.clientEmail}</code>.
            </>
          ) : reader.state === 'invalid' ? (
            "Reading forms with Google is not working: the console's service account key could not be read."
          ) : (
            'Reading forms with Google is not set up for this console, so forms are posted by their Apps Script.'
          )}
        </p>
      )}
      {bindings.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          No Google Form is linked yet. Paste the form&apos;s id and pick the Data API key its script sends with.
          Its responses then show up below.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
          {bindings.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-2 p-3">
              <code className="text-xs break-all">{b.formId}</code>
              <span className="text-xs text-[var(--text-muted)]">via {b.consumerName}</span>
              <Badge variant={b.active ? 'success' : 'neutral'}>{b.active ? 'Active' : 'Off'}</Badge>
              {b.joinWaitlist && <Badge variant="info">Joins the waitlist when full</Badge>}
              {b.soloDoublesAck && <Badge variant="neutral">Form asks the solo doubles question</Badge>}
              {canBind && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => run(() => setRegistrationFormActive(b.id, !b.active))}
                >
                  {b.active ? 'Switch off' : 'Switch on'}
                </Button>
              )}
              {b.reader && (reader.state !== 'not_configured' || b.reader.mapping) && (
                <FormReaderPanel
                  binding={b}
                  targetKind={targetKind}
                  targetId={targetId}
                  events={events}
                  canEdit={canBind}
                  pending={pending}
                  onSave={(mapping, after) => run(() => saveRegistrationFormMapping(b.id, mapping), after)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {canBind && (
        <div className="space-y-2 rounded-xl border border-[var(--border)] p-3">
          {consumers.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              First mint a Data API key with &quot;Import form registrations&quot; ticked, under Accounts, then
              come back here to link the form.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <label className="flex flex-1 min-w-[12rem] flex-col gap-1 text-sm text-[var(--text-secondary)]">
                  Google Form id
                  <input
                    className={inputClass}
                    placeholder="The long id in the form's edit link"
                    value={formId}
                    onChange={(e) => setFormId(e.target.value)}
                    disabled={pending}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
                  Data API key holder
                  <select
                    className={inputClass}
                    value={consumerId}
                    onChange={(e) => setConsumerId(e.target.value)}
                    disabled={pending}
                  >
                    {consumers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {targetKind === 'tournament' && (
                <div className="flex flex-col gap-2 py-1">
                  <Checkbox
                    checked={joinWaitlist}
                    onChange={setJoinWaitlist}
                    disabled={pending}
                    label="Put non-members on the waitlist when an event is full"
                    showLabel
                  />
                  <Checkbox
                    checked={soloDoublesAck}
                    onChange={setSoloDoublesAck}
                    disabled={pending}
                    label="The form explains that a doubles entry without a partner may be paired by the exec"
                    showLabel
                  />
                </div>
              )}
              <Button
                disabled={pending || formId.trim() === '' || consumerId === ''}
                onClick={() =>
                  run(
                    () =>
                      bindRegistrationForm({
                        targetKind,
                        targetId,
                        consumerId,
                        formId: formId.trim(),
                        joinWaitlist,
                        soloDoublesAck,
                      }),
                    () => setFormId(''),
                  )
                }
              >
                Link form
              </Button>
            </>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      {live.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[var(--text-muted)]">
              <tr>
                <th className="p-2">Person</th>
                <th className="p-2">Event</th>
                <th className="p-2">Status</th>
                <th className="p-2">Guest waiver</th>
                <th className="p-2">Fee</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {live.map((e) => (
                <tr key={e.id}>
                  <td className="p-2 align-top">
                    <div>{e.person}</div>
                    {e.email && <div className="text-xs text-[var(--text-muted)] break-all">{e.email}</div>}
                    {e.partner && <div className="text-xs text-[var(--text-muted)]">Partner: {e.partner}</div>}
                    {!e.isMember && <Badge variant="neutral">Non-member</Badge>}
                  </td>
                  <td className="p-2 align-top">{e.event}</td>
                  <td className="p-2 align-top">
                    <Badge variant={STATUS_VARIANT[e.status] ?? 'neutral'}>{STATUS_LABEL[e.status] ?? e.status}</Badge>
                    {e.reason && (
                      <div className="text-xs text-[var(--text-muted)]">
                        {e.reason.startsWith('error_') ? 'Failed, check the logs' : (REASON_LABEL[e.reason] ?? e.reason)}
                      </div>
                    )}
                  </td>
                  <td className="p-2 align-top text-xs">
                    {e.isMember
                      ? 'Member'
                      : e.waiver?.signed
                        ? 'Signed'
                        : 'Not signed'}
                    {e.invite && <div className="text-[var(--text-muted)]">{INVITE_LABEL[e.invite]}</div>}
                  </td>
                  <td className="p-2 align-top text-xs">
                    {e.fee ? `${money(e.fee.amountCents)}${e.fee.paid ? ', paid' : ''}` : ''}
                  </td>
                  <td className="p-2 align-top">
                    {canUndo && ['entered', 'awaiting_member', 'awaiting_partner', 'needs_review'].includes(e.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={async () => {
                          const ok = await confirm({
                            title: 'Undo this entry?',
                            message:
                              'It leaves the event, and an unpaid fee this form created is removed. A paid fee or a made draw stops the undo.',
                            confirmLabel: 'Undo',
                            danger: true,
                          });
                          if (ok) run(() => undoImportedEntry(e.id));
                        }}
                      >
                        Undo
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
