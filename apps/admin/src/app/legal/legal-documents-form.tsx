'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AvatarChip, Badge, Button, LegalMarkdown, Textarea, useConfirm } from '@badminton/ui';
import { LEGAL_DOCUMENT_LABELS, type WaiverDocument } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { updateLegalDocument, requireReacceptance } from '@/lib/actions';
import { AutoGrowTextarea } from './auto-grow-textarea';
import { MIN_REASON_LENGTH } from '@/lib/legal-reason';

export interface LegalDocumentRow {
  document: string;
  version: string;
  content: string;
  updated_at: string;
  reacceptance_required_since?: string | null;
}

export interface OutstandingMember {
  id: string;
  full_name: string;
  avatar_url: string | null;
  /** The last version this member accepted, or null if they never signed it. */
  last_signed_version: string | null;
  last_signed_at: string | null;
}

export interface DocumentSignatures {
  signed: number;
  members: OutstandingMember[];
}

// `.card-base` — which /ratings, /accounts and the old version of this page all
// use — is defined ONLY in the player app's globals.css. The admin app's copy
// never declares it, so every one of those cards currently renders with no
// surface, no border and no padding at all. Rather than inherit that, the card
// chrome here is written from tokens, which is what the class would have said:
// --surface on a hairline --line border, the 16px card corner, no shadow.
const CARD = 'rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5';

/** The small uppercase card heading from the guidelines. `.section-heading` is
 *  likewise undeclared in this app, so it is spelled out in tokens. */
function SectionHeading({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h2
      className={`uppercase text-[var(--ink)] ${className ?? ''}`}
      style={{ fontFamily: 'var(--display)', fontSize: 13, fontWeight: 600, letterSpacing: '.1em' }}
    >
      {children}
    </h2>
  );
}

const DOC_DESCRIPTIONS: Record<string, string> = {
  terms_of_use: 'App usage rules. Accepted during onboarding; public at /legal/terms.',
  privacy_policy: 'What we collect and how long we keep it. Public at /legal/privacy.',
  waiver: 'Accepted during onboarding, after a version bump, and re-signed annually.',
  code_of_conduct: 'Accepted alongside the waiver.',
};

function shortDate(iso: string) {
  return new Date(iso)
    .toLocaleDateString('en-CA', { day: '2-digit', month: 'short', year: 'numeric' })
    .toUpperCase();
}

export function LegalConsole({
  documents,
  signatures,
  activeMemberCount,
  canEdit,
  canRequireReacceptance,
}: {
  documents: LegalDocumentRow[];
  /**
   * null means WITHHELD, not empty: the viewer does not hold players.read, so
   * the roster was never fetched. The panel says so in words. An empty object
   * would mean "fetched, nobody in the club", which is a different sentence.
   */
  signatures: Record<string, DocumentSignatures> | null;
  activeMemberCount: number | null;
  // Execs read the documents and may require a re-signature; only admins edit
  // the text. The server actions enforce both independently — hiding a control
  // is so nobody is offered a button that will reject them.
  canEdit: boolean;
  canRequireReacceptance: boolean;
}) {
  const [selectedKey, setSelectedKey] = useState(documents[0]?.document ?? '');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // The text reads as the live document until Edit is pressed. Leaving edit
  // mode, by Cancel, a publish or another document, drops the draft.
  const [editing, setEditing] = useState(false);
  const { toast } = useToast();
  const confirm = useConfirm();

  const selected = documents.find((d) => d.document === selectedKey) ?? documents[0];
  if (!selected) return null;

  const label = LEGAL_DOCUMENT_LABELS[selected.document as WaiverDocument] || selected.document;
  const draft = edits[selected.document] ?? selected.content;
  const isEdited = selected.document in edits && edits[selected.document] !== selected.content;
  const stats = signatures?.[selected.document] ?? null;

  // The same floor the server action enforces, so the button never offers an
  // action the boundary will refuse.
  const reasonOk = reason.trim().length >= MIN_REASON_LENGTH;

  // "All N members are gated" is the loudest sentence on this screen, so when
  // the roster was withheld the legend says "every active member" rather than
  // guessing a number.
  const population = activeMemberCount === null ? 'EVERY ACTIVE MEMBER' : `ALL ${activeMemberCount} ACTIVE MEMBERS`;

  function closeEditor() {
    setEdits({});
    setEditing(false);
    // The reason was written for the edit. Left in the box it would be sent
    // with a re-signature instead.
    setReason('');
  }

  async function switchTo(key: string) {
    if (key === selected!.document) return;
    if (isEdited) {
      const discard = await confirm({
        title: `Discard your changes to ${label}?`,
        message: 'They are in this browser only and are lost if you open another document.',
        confirmLabel: 'Discard changes',
        danger: true,
      });
      if (!discard) return;
    }
    closeEditor();
    setSelectedKey(key);
    // The reason describes the change being made to ONE document. Carrying it
    // across would attach one document's justification to another's audit row.
    setReason('');
  }

  async function publish(bumpVersion: boolean) {
    // The buttons are already disabled without a reason; this is the guard
    // behind them, so no path reaches a confirm dialog whose own confirm button
    // has no reason gate of its own.
    if (!reasonOk) {
      toast(`Give a reason of at least ${MIN_REASON_LENGTH} characters first.`, 'error');
      return;
    }
    const confirmed = await confirm({
      title: bumpVersion ? `Publish ${label} and require re-sign?` : `Publish ${label} quietly?`,
      message: bumpVersion ? (
        <>
          This bumps the version and asks{' '}
          <span className="text-[var(--text-primary)] font-medium">
            {activeMemberCount === null ? 'every active member' : `all ${activeMemberCount} active members`}
          </span>{' '}
          to sign <span className="text-[var(--text-primary)] font-medium">{label}</span> again.
          They are gated out of the app until they do.
        </>
      ) : (
        <>
          This replaces the text of{' '}
          <span className="text-[var(--text-primary)] font-medium">{label}</span> and leaves the
          version at{' '}
          <span className="font-mono text-[var(--text-primary)]">{selected!.version}</span>. Nobody
          is asked to re-sign, and existing signatures stand.
        </>
      ),
      confirmLabel: bumpVersion ? 'Publish and require re-sign' : 'Publish quietly',
    });
    if (!confirmed) return;

    setBusy(bumpVersion ? 'bump' : 'quiet');
    try {
      await updateLegalDocument(
        { document: selected!.document as WaiverDocument, content: draft, bump_version: bumpVersion },
        reason
      );
      toast(
        bumpVersion
          ? `${label} published — every active member must sign it again`
          : `${label} published — the version and existing signatures are unchanged`,
        'success'
      );
      closeEditor();
      setReason('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to publish document', 'error');
    }
    setBusy(null);
  }

  async function forceResign() {
    if (!reasonOk) {
      toast(`Give a reason of at least ${MIN_REASON_LENGTH} characters first.`, 'error');
      return;
    }
    const confirmed = await confirm({
      title: `Require re-signature of ${label}?`,
      message: (
        <>
          This asks{' '}
          <span className="text-[var(--text-primary)] font-medium">
            {activeMemberCount === null ? 'every active member' : `all ${activeMemberCount} active members`}
          </span>{' '}
          to sign <span className="text-[var(--text-primary)] font-medium">{label}</span> again on
          their next visit. The text and the version do not change.
        </>
      ),
      confirmLabel: 'Require re-signature',
    });
    if (!confirmed) return;

    setBusy('reaccept');
    try {
      await requireReacceptance(selected!.document as WaiverDocument, reason);
      toast('Every active member must re-sign this on their next visit.', 'success');
      setReason('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to require re-signature', 'error');
    }
    setBusy(null);
  }

  return (
    <div>
      {/* The mockup's "unpublished draft" band. legal_documents has no draft
          column — one row per document, and a save IS the publish (00010, and
          00015 adds only reacceptance_required_since) — so the band cannot
          report a stored draft. What it reports instead is real and is the same
          warning: edits that exist only in this browser, which members cannot
          see and which are lost on reload. It is omitted whenever there are
          none, per the guideline against rendering an empty band. */}
      {isEdited && (
        <div
          className="mb-5 flex flex-col gap-1.5 border px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-warning) 35%, transparent)',
            background: 'color-mix(in srgb, var(--color-warning) 6%, transparent)',
          }}
        >
          <span
            className="font-mono font-bold uppercase"
            style={{ fontSize: 11, letterSpacing: '.14em', color: 'var(--color-warning)' }}
          >
            Unsaved edit
          </span>
          <span className="text-[14px] text-[var(--ink-2)]">
            Your changes to {label} are in this browser only — members still see version{' '}
            <span className="font-mono">{selected.version}</span>. Publishing with re-signature asks{' '}
            {activeMemberCount === null ? 'every active member' : `all ${activeMemberCount} active members`}{' '}
            to sign again.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[230px_1fr_1fr]">
        {/* ---------------------------------------------------------------
            LEFT — the four documents. Every row is LIVE: there is no
            unpublished state to contrast with, which is itself the thing an
            editor needs to know before typing in the middle column.
        --------------------------------------------------------------- */}
        <nav className={`${CARD} !p-0`} aria-label="Documents">
          <SectionHeading className="px-4 pt-4 pb-2">Documents</SectionHeading>
          {documents.map((doc) => {
            const isSelected = doc.document === selected.document;
            const docStats = signatures?.[doc.document] ?? null;
            return (
              <button
                key={doc.document}
                type="button"
                onClick={() => void switchTo(doc.document)}
                aria-current={isSelected ? 'true' : undefined}
                className="block w-full border-t border-[var(--line)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]"
                style={{
                  borderLeft: `2px solid ${isSelected ? 'var(--red)' : 'transparent'}`,
                  background: isSelected ? 'var(--surface-2)' : undefined,
                }}
              >
                <span className="block text-[14px] leading-snug text-[var(--ink)]">
                  {LEGAL_DOCUMENT_LABELS[doc.document as WaiverDocument] || doc.document}
                </span>
                <span
                  className="mt-1 block font-mono uppercase text-[var(--mute)]"
                  style={{ fontSize: 10, letterSpacing: '.08em' }}
                >
                  v{doc.version} live ·{' '}
                  {docStats
                    ? `${docStats.signed} signed`
                    : shortDate(doc.updated_at)}
                </span>
              </button>
            );
          })}
        </nav>

        {/* ---------------------------------------------------------------
            MIDDLE — the editor.
        --------------------------------------------------------------- */}
        <div className={CARD}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <span
              className="font-mono uppercase text-[var(--mute)]"
              style={{ fontSize: 10, letterSpacing: '.16em' }}
            >
              {editing ? 'Edit' : 'Read'} · {label}
            </span>
            <div className="flex items-center gap-2">
              {/* Never a DRAFT badge: nothing here is a draft once saved, and
                  nothing is stored before it. The badge states the live version,
                  and turns warning-toned only while unsaved edits exist. */}
              <Badge variant={isEdited ? 'warning' : 'neutral'} className="font-mono whitespace-nowrap">
                {isEdited ? 'UNSAVED' : 'LIVE'} v{selected.version}
              </Badge>
              {canEdit && !editing && (
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
            </div>
          </div>

          <p className="settings-row-hint mb-3">
            {DOC_DESCRIPTIONS[selected.document] || ''} Markdown: ## headings, - lists, **bold**.
          </p>

          {canEdit && editing ? (
            /* AutoGrowTextarea, not the plain UI Textarea: it sizes the box to
               the whole document on mount and on every keystroke, so the page
               scrolls rather than the editor. min-h is only a floor. */
            <AutoGrowTextarea
              label="Markdown"
              value={draft}
              onChange={(e) =>
                setEdits((prev) => ({ ...prev, [selected.document]: e.target.value }))
              }
              rows={18}
              className="min-h-[320px] font-mono text-xs"
            />
          ) : (
            /* Read-only for execs, and for an admin until Edit. A disabled Textarea would look like an editor
               that is merely switched off; a pre block reads as the document it
               is. Same monospace so the two views match. */
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] p-3 font-mono text-xs text-[var(--text-secondary)]">
              {selected.content}
            </pre>
          )}

          {/* The reason box stays out of edit mode for the re-signature below:
              an exec holds that alone, with no Edit to press. */}
          {((canEdit && editing) || canRequireReacceptance) && (
            <div className="mt-5 border-t border-[var(--line)] pt-4">
              <Textarea
                label={`Reason (required, ${MIN_REASON_LENGTH}+ characters)`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="What changed and why. This is stored on the audit record for this change."
              />

              {canEdit && editing && (
                <>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      className="h-11"
                      disabled={busy !== null}
                      onClick={closeEditor}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="secondary"
                      className="h-11"
                      loading={busy === 'quiet'}
                      disabled={busy !== null || !reasonOk}
                      onClick={() => publish(false)}
                    >
                      Publish quietly
                    </Button>
                    {/* The one red control on this screen while the viewer can
                        edit: it is both the primary action and the destructive
                        one. */}
                    <Button
                      variant="primary"
                      className="h-11"
                      loading={busy === 'bump'}
                      disabled={busy !== null || !reasonOk}
                      onClick={() => publish(true)}
                    >
                      Publish and require re-sign
                    </Button>
                  </div>

                  {/* THE MOST IMPORTANT TEXT ON THIS SCREEN — the difference
                      between a quiet typo fix and gating the whole club out of
                      the app. Every line is written from what the action does:
                      updateLegalDocument sets version = bump ? nextVersion() :
                      old.version, and getMissingLegalDocuments matches an
                      acceptance on doc.version — so an unbumped save cannot
                      invalidate anybody, and a bumped one invalidates everybody.
                      Note what a quiet publish does NOT do: it mints no new
                      version, so new members sign the new text under the SAME
                      version string as the old. */}
                  <p
                    className="mt-4 font-mono uppercase text-[var(--mute)]"
                    style={{ fontSize: 10, lineHeight: 1.7, letterSpacing: '.06em' }}
                  >
                    Cancel: drops your edits. Members see nothing either way.
                    <br />
                    Publish quietly — text changes, version stays v{selected.version}. Nobody
                    re-signs, every existing signature stands, and new members sign the new text
                    under that same version — so the record will not show who saw which wording.
                    <br />
                    Publish and require re-sign — version bumps. {population} are gated out of the
                    app until they sign again.
                  </p>
                </>
              )}

              {canRequireReacceptance && (
                <div className="mt-4 border-t border-[var(--line)] pt-4">
                  {/* Its own block, below the publish row, because it is not a
                      publish: it changes no text at all. It is also a different
                      capability — an exec holds this one alone, with no editor
                      above it. */}
                  <Button
                    variant={canEdit ? 'secondary' : 'primary'}
                    className="h-11"
                    loading={busy === 'reaccept'}
                    disabled={busy !== null || !reasonOk}
                    onClick={forceResign}
                  >
                    Require re-signature now
                  </Button>
                  <p
                    className="mt-3 font-mono uppercase text-[var(--mute)]"
                    style={{ fontSize: 10, lineHeight: 1.7, letterSpacing: '.06em' }}
                  >
                    Require re-signature now — text and version unchanged. {population} are gated
                    out of the app until they sign again.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ---------------------------------------------------------------
            RIGHT — what a member sees, and who has agreed to it.
        --------------------------------------------------------------- */}
        <div className="flex flex-col gap-5">
          <div className={CARD}>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <SectionHeading>Preview · as members see it</SectionHeading>
              <span className="font-mono text-[10px] text-[var(--mute)]">390PX</span>
            </div>
            {/* Bounded to the width the player app actually renders at, so a
                heading that wraps badly on a phone wraps badly here too. */}
            <div className="max-h-[420px] max-w-[390px] overflow-y-auto border border-[var(--line)] bg-[var(--bg)] p-4">
              <LegalMarkdown content={draft} />
            </div>
          </div>

          <div className={CARD}>
            <SectionHeading className="mb-3">Signatures</SectionHeading>
            {stats === null ? (
              /* WITHHELD, not empty. The roster was never fetched for this
                 viewer, and a blank panel reads as broken. */
              <p className="text-[14px] text-[var(--mute)]">
                Signatures are not shown to you — they list who is in the club, which needs
                roster access.
              </p>
            ) : (
              <SignaturePanel
                stats={stats}
                version={selected.version}
                documentLabel={label}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SignaturePanel({
  stats,
  version,
  documentLabel,
}: {
  stats: DocumentSignatures;
  version: string;
  documentLabel: string;
}) {
  const outstanding = stats.members.length;
  const total = stats.signed + outstanding;
  const signedPct = total === 0 ? 0 : (stats.signed / total) * 100;

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[36px] leading-none tracking-tight text-[var(--ink)]">
          {stats.signed}
        </span>
        <span
          className="font-mono uppercase text-[var(--mute)]"
          style={{ fontSize: 10, letterSpacing: '.1em' }}
        >
          on v{version} · {outstanding} outstanding
        </span>
      </div>

      {/* Two segments, not a percentage: the number that matters is how many
          people are still locked out, and a bar makes "2 of 214" legible at a
          glance without doing arithmetic. */}
      <div className="mt-3 flex h-[10px] w-full overflow-hidden bg-[var(--surface-2)]">
        <div style={{ width: `${signedPct}%`, background: 'var(--color-success)' }} />
        <div style={{ width: `${100 - signedPct}%`, background: 'var(--color-warning)' }} />
      </div>
      <div
        className="mt-1.5 flex justify-between font-mono uppercase text-[var(--mute)]"
        style={{ fontSize: 10, letterSpacing: '.1em' }}
      >
        <span>Signed</span>
        <span>Waiting</span>
      </div>

      {outstanding === 0 ? (
        <p className="mt-4 border-t border-[var(--line)] pt-4 text-[14px] text-[var(--mute)]">
          Every active member has signed {documentLabel}.
        </p>
      ) : (
        /* Capped and scrolled to match the preview beside it. Uncapped, a
           freshly bumped document puts every active member in this list and the
           column runs off the page. */
        <ul className="mt-4 max-h-[420px] overflow-y-auto">
          {/* The state is named once, here, instead of an UNSIGNED badge on
              every row: each row in this list is unsigned by construction, so
              a per-row badge repeats a constant as many times as there are
              members and tells the reader nothing. */}
          <li
            className="sticky top-0 bg-[var(--surface)] pb-1 font-mono uppercase text-[var(--mute)]"
            style={{ fontSize: 10, letterSpacing: '.1em' }}
          >
            Has not signed v{version}
          </li>
          {stats.members.map((member) => (
            <li key={member.id} className="border-t border-[var(--line)]">
              {/* Links to the member's record rather than offering a re-sign
                  button here: RequireWaiverResignatureButton already exists on
                  /players/[id] behind players.waiver.resign.write, and a second
                  copy would be a second thing to keep in step. */}
              <Link
                href={`/players/${member.id}`}
                className="flex items-center gap-3 py-2.5 transition-colors hover:bg-[var(--surface-2)]"
              >
                <AvatarChip name={member.full_name} id={member.id} src={member.avatar_url} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-[var(--ink)]">
                    {member.full_name}
                  </span>
                  {/* The pair of facts the console could not show anywhere
                      before: which version they are sitting on, and when they
                      signed it. */}
                  <span
                    className="block font-mono uppercase text-[var(--mute)]"
                    style={{ fontSize: 10, letterSpacing: '.08em' }}
                  >
                    {member.last_signed_at && member.last_signed_version
                      ? `signed v${member.last_signed_version} · ${shortDate(member.last_signed_at)}`
                      : 'never signed'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
