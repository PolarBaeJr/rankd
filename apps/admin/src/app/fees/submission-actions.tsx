'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ETRANSFER_REFERENCE_PATTERN,
  SFU_REC_REFERENCE_PATTERN,
  isHiddenEtransferReference,
  normaliseReference,
  type ReceiptMethod,
} from '@badminton/shared';
import { Button, Dialog, Input, Textarea, useConfirm } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { withBase } from '@/lib/base-path';
import {
  confirmFeeSubmission,
  eraseFormReceiptScreenshot,
  rejectFeeSubmission,
  remindUnpaidMembers,
  undoAutoConfirmedSubmission,
} from '@/lib/actions/fee-submissions';

// The controls on a payment receipt (00248, 00253): one Review button opens the
// screenshot with Approve (the fee is marked paid by the method the receipt was
// read as, with the member's reference) and Reject (with a reason the member is
// shown). When the member's browser could not tell how it was paid, it asks.
//
// A receipt a Google Form collected (00288) carries no reference: one can be
// typed, or read off the image in this browser (receipt-ocr.ts), and none at
// all is fine (00298), since some banks' screens show none. Its screenshot can
// be erased on request, the payment record staying.

export function SubmissionActions({
  submissionId,
  memberName,
  line,
  amount,
  reference,
  proofHref,
  method,
  feeType,
  fromForm = false,
  readableScreenshot = false,
}: {
  submissionId: string;
  memberName: string;
  line: string;
  amount: string;
  /** Null for a form receipt: the exec types or reads it on confirm. */
  reference: string | null;
  /** Null when the screenshot was removed with a purged account, or erased. */
  proofHref: string | null;
  /** Null when the member's browser could not tell; the exec picks. */
  method: ReceiptMethod | null;
  feeType: string;
  /** Sent through a Google Form's upload question. */
  fromForm?: boolean;
  /** A JPEG, PNG or WebP the browser can read; a PDF or HEIC is not. */
  readableScreenshot?: boolean;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [chosen, setChosen] = useState<ReceiptMethod | null>(null);
  const [typed, setTyped] = useState('');
  const [reading, setReading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  // Only dues are sold on the SFU Rec website.
  const choices: ReceiptMethod[] = feeType === 'dues' ? ['e_transfer', 'sfu_rec'] : ['e_transfer'];
  // The reference confirming would store: the one sent, else the one typed.
  const shownReference = reference ?? normaliseReference(typed);
  // An e-transfer number the bank printed with part of it hidden (00297).
  const hiddenReference = isHiddenEtransferReference(shownReference);
  const referenceReady = SFU_REC_REFERENCE_PATTERN.test(shownReference) || hiddenReference;
  // A 4 or 5 character number cannot be an e-transfer reference (00253).
  const shortReference = SFU_REC_REFERENCE_PATTERN.test(shownReference) && !ETRANSFER_REFERENCE_PATTERN.test(shownReference);
  const effectiveMethod = method ?? chosen;

  function send(picked?: ReceiptMethod) {
    startTransition(async () => {
      const result = await confirmFeeSubmission(submissionId, picked, reference ? undefined : shownReference || undefined);
      if (!result.ok) {
        toast(result.code ? `${result.error} (${result.code}.${result.ref})` : result.error, 'error');
        return;
      }
      toast('Payment confirmed', 'success');
      setReviewing(false);
      setChosen(null);
      setTyped('');
      router.refresh();
    });
  }

  async function readScreenshot() {
    if (!proofHref) return;
    setReading(true);
    try {
      // Same origin, through the exec-gated proof route, so the image never
      // goes anywhere but this browser.
      const response = await fetch(withBase(`${proofHref}?inline=1`), { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { readReceiptReference } = await import('./receipt-ocr');
      const found = await readReceiptReference(await response.blob());
      if (found) {
        setTyped(found.value);
        toast(found.confidence === 'anchored' ? 'Reference read. Check it against the screenshot.' : 'A guess at the reference. Check it against the screenshot.', 'success');
      } else {
        toast('No reference could be read. Type it from the screenshot.', 'error');
      }
    } catch {
      toast('The screenshot could not be read. Type the reference from it.', 'error');
    } finally {
      setReading(false);
    }
  }

  const handleErase = useEraseScreenshot(submissionId, memberName, startTransition);

  function close() {
    setReviewing(false);
    setRejecting(false);
    setReason('');
  }

  function handleReject() {
    startTransition(async () => {
      const result = await rejectFeeSubmission(submissionId, reason);
      if (!result.ok) {
        toast(result.code ? `${result.error} (${result.code}.${result.ref})` : result.error, 'error');
        return;
      }
      toast('Receipt rejected', 'success');
      close();
      router.refresh();
    });
  }

  // A typed reference must be one the database takes; none at all is fine for
  // a Form receipt (00298), whose bank screen may show no number.
  const typedOk = reference !== null || !shownReference ? true : referenceReady;
  const approveDisabled =
    !effectiveMethod ||
    !typedOk ||
    (!reference && !shownReference && !fromForm) ||
    (effectiveMethod === 'e_transfer' && shortReference) ||
    (effectiveMethod === 'sfu_rec' && hiddenReference);

  return (
    <>
      {/* The row keeps one decision button. Review opens the screenshot with
          Approve and Reject beside it; Erase stays out here for a Form
          receipt, whose file the club keeps. */}
      {fromForm && proofHref && (
        <Button variant="ghost" size="sm" onClick={handleErase} disabled={isPending}>
          Erase screenshot
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={() => setReviewing(true)} disabled={isPending}>
        Review
      </Button>
      <Dialog open={reviewing} onClose={close} title={`Review: ${memberName}`} size="wide">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            {line} ({amount}){reference ? `, reference ${reference}` : ''}. Check the recipient and the amount, and that
            it arrived.
          </p>
          {proofHref ? (
            readableScreenshot ? (
              <a href={withBase(proofHref)} target="_blank" rel="noopener noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element -- an exec-gated route, not a static asset */}
                <img
                  src={withBase(`${proofHref}?inline=1`)}
                  alt={`Receipt from ${memberName}`}
                  className="max-h-[55vh] w-auto mx-auto rounded-md border border-[var(--border)]"
                />
              </a>
            ) : (
              <a
                href={withBase(proofHref)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[var(--color-accent)] font-medium"
              >
                Open the screenshot (a PDF or HEIC opens in a new tab)
              </a>
            )
          ) : (
            <p className="text-xs text-[var(--text-muted)]">No screenshot</p>
          )}
          {rejecting ? (
            <>
              <p className="text-sm text-[var(--text-secondary)]">
                {fromForm
                  ? `${memberName} sent this through the form, so nobody is notified. Tell them yourself if they should send another.`
                  : `${memberName} is sent a notification with this reason and can send a new receipt.`}
              </p>
              <Textarea
                label="Reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. The amount on the receipt is not the fee"
                maxLength={500}
                rows={3}
              />
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setRejecting(false)}>
                  Back
                </Button>
                <Button
                  onClick={handleReject}
                  loading={isPending}
                  disabled={reason.trim().length < 3}
                  className="flex-1"
                >
                  Reject receipt
                </Button>
              </div>
            </>
          ) : (
            <>
              {!reference && (
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Input
                      label={fromForm ? 'Reference (if the receipt shows one)' : 'Reference'}
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      maxLength={48}
                      autoComplete="off"
                    />
                  </div>
                  {proofHref && readableScreenshot && (
                    <Button variant="ghost" size="sm" onClick={readScreenshot} loading={reading} disabled={isPending}>
                      Read screenshot
                    </Button>
                  )}
                </div>
              )}
              {!method && (
                <div className="flex gap-2">
                  {choices.map((m) => (
                    <Button
                      key={m}
                      variant={chosen === m ? 'primary' : 'ghost'}
                      size="sm"
                      aria-pressed={chosen === m}
                      onClick={() => setChosen(m)}
                      disabled={isPending || (m === 'e_transfer' && shortReference) || (m === 'sfu_rec' && hiddenReference)}
                    >
                      {m === 'e_transfer' ? 'Interac e-Transfer' : 'SFU Rec website'}
                    </Button>
                  ))}
                </div>
              )}
              {shortReference && (
                <p className="text-xs text-[var(--text-muted)]">
                  {shownReference} is too short for an e-transfer reference, so this can only be an SFU Rec receipt.
                </p>
              )}
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setRejecting(true)} disabled={isPending}>
                  Reject
                </Button>
                <Button
                  onClick={() => effectiveMethod && send(method ? undefined : effectiveMethod)}
                  loading={isPending}
                  disabled={approveDisabled}
                  className="flex-1"
                >
                  Approve
                </Button>
              </div>
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}

/**
 * "Remind unpaid" over the whole list, or "Remind" on one row. The count in
 * the dialog is who the page thinks is due one; the action decides again.
 */
export function RemindButton({
  playerIds,
  label,
  noun,
}: {
  playerIds: string[];
  label: string;
  /** "Ana Lee", or "14 members". */
  noun: string;
}) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  async function handleRemind() {
    const ok = await confirm({
      title: `Send a reminder to ${noun}?`,
      message:
        'They get an in-app notification asking them to pay and upload the receipt. Nobody is reminded twice within 3 days.',
      confirmLabel: 'Send reminder',
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await remindUnpaidMembers(playerIds);
      if (!result.ok) {
        toast(result.code ? `${result.error} (${result.code}.${result.ref})` : result.error, 'error');
        return;
      }
      const { sent, skipped } = result.data;
      toast(
        skipped > 0
          ? `Reminded ${sent}. ${skipped} skipped: paid, sent a receipt, or reminded recently.`
          : `Reminded ${sent} ${sent === 1 ? 'member' : 'members'}`,
        'success',
      );
      router.refresh();
    });
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleRemind} loading={isPending} disabled={playerIds.length === 0}>
      {label}
    </Button>
  );
}

/**
 * Erasing a form receipt's screenshot on request (00288): asked first, then
 * only the image goes. The receipt stays confirmed and the fee stays paid.
 */
function useEraseScreenshot(
  submissionId: string,
  memberName: string,
  startTransition: (action: () => Promise<void>) => void,
) {
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();
  return async function handleErase() {
    const ok = await confirm({
      title: 'Erase this screenshot?',
      message: `The screenshot ${memberName} sent through the form is deleted for good. The receipt and the fee stay as the club's record of the payment.`,
      confirmLabel: 'Erase screenshot',
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await eraseFormReceiptScreenshot(submissionId);
      if (!result.ok) {
        toast(result.code ? `${result.error} (${result.code}.${result.ref})` : result.error, 'error');
        return;
      }
      toast('Screenshot erased', 'success');
      router.refresh();
    });
  };
}

// A CONFIRMED form receipt whose screenshot the club still keeps as proof of
// payment (00288). Nothing to review: the screenshot can be opened, or erased
// when the person who sent it asks through the privacy address.
export function KeptScreenshotActions({
  submissionId,
  memberName,
  proofHref,
}: {
  submissionId: string;
  memberName: string;
  proofHref: string;
}) {
  const [isPending, startTransition] = useTransition();
  const handleErase = useEraseScreenshot(submissionId, memberName, startTransition);
  return (
    <>
      <a
        href={withBase(proofHref)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-[var(--color-accent)] font-medium px-2"
      >
        View screenshot
      </a>
      <Button variant="ghost" size="sm" onClick={handleErase} loading={isPending}>
        Erase screenshot
      </Button>
    </>
  );
}

// A receipt the server read and confirmed by itself (00297). The fee is paid;
// Undo asks why, then puts the receipt back to waiting and the fee back to
// unpaid, for an ordinary Confirm or Reject. Nobody is notified: the member
// sees their fee unpaid again with the receipt waiting.
export function AutoConfirmedActions({
  submissionId,
  memberName,
  reference,
  proofHref,
}: {
  submissionId: string;
  memberName: string;
  reference: string | null;
  /** Null when the screenshot was removed with a purged account, or erased. */
  proofHref: string | null;
}) {
  const [undoing, setUndoing] = useState(false);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleUndo() {
    startTransition(async () => {
      const result = await undoAutoConfirmedSubmission(submissionId, reason);
      if (!result.ok) {
        toast(result.code ? `${result.error} (${result.code}.${result.ref})` : result.error, 'error');
        return;
      }
      toast('Confirmation undone. The receipt is waiting for review.', 'success');
      setUndoing(false);
      setReason('');
      router.refresh();
    });
  }

  return (
    <>
      {proofHref ? (
        <a
          href={withBase(proofHref)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[var(--color-accent)] font-medium px-2"
        >
          View screenshot
        </a>
      ) : (
        <span className="text-xs text-[var(--text-muted)] px-2">No screenshot</span>
      )}
      <Button variant="ghost" size="sm" onClick={() => setUndoing(true)} disabled={isPending}>
        Undo
      </Button>
      <Dialog open={undoing} onClose={() => setUndoing(false)} title={`Undo confirmation: ${memberName}`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            The site confirmed this receipt{reference ? ` (${reference})` : ''} by itself. Undoing marks the fee
            unpaid again and puts the receipt back in the list to confirm or reject. {memberName} is not notified.
          </p>
          <Textarea
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. No payment with this reference reached the club"
            maxLength={500}
            rows={3}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setUndoing(false)}>
              Cancel
            </Button>
            <Button onClick={handleUndo} loading={isPending} disabled={reason.trim().length < 3} className="flex-1">
              Undo confirmation
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
