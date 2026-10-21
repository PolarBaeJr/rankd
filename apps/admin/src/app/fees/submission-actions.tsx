'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ETRANSFER_REFERENCE_PATTERN,
  SFU_REC_REFERENCE_PATTERN,
  formatPaymentMethod,
  normaliseReference,
  type ReceiptMethod,
} from '@badminton/shared';
import { Badge, Button, Dialog, Input, Textarea, useConfirm } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { withBase } from '@/lib/base-path';
import {
  confirmFeeSubmission,
  eraseFormReceiptScreenshot,
  rejectFeeSubmission,
  remindUnpaidMembers,
} from '@/lib/actions/fee-submissions';

// The controls on a payment receipt (00248, 00253): look at the screenshot,
// confirm it (the fee is marked paid by the method the receipt was read as,
// with the member's reference), or reject it with a reason the member is shown.
// When the member's browser could not tell how it was paid, confirming asks.
//
// A receipt a Google Form collected (00288) carries no reference: confirming
// asks for it, and "Read screenshot" reads one off the image in this browser
// (receipt-ocr.ts) for the exec to check. A PDF or HEIC is typed by hand. Its
// screenshot can be erased on request, the payment record staying.

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
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<ReceiptMethod | null>(null);
  const [typed, setTyped] = useState('');
  const [reading, setReading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  // Only dues are sold on the Campus Rec website.
  const choices: ReceiptMethod[] = feeType === 'dues' ? ['e_transfer', 'sfu_rec'] : ['e_transfer'];
  // The reference confirming would store: the one sent, else the one typed.
  const shownReference = reference ?? normaliseReference(typed);
  const referenceReady = SFU_REC_REFERENCE_PATTERN.test(shownReference);
  // A 4 or 5 character number cannot be an e-transfer reference (00253).
  const shortReference = referenceReady && !ETRANSFER_REFERENCE_PATTERN.test(shownReference);
  const effectiveMethod = method ?? chosen;

  function send(picked?: ReceiptMethod) {
    startTransition(async () => {
      const result = await confirmFeeSubmission(submissionId, picked, reference ? undefined : shownReference);
      if (!result.ok) {
        toast(result.code ? `${result.error} (${result.code}.${result.ref})` : result.error, 'error');
        return;
      }
      toast('Payment confirmed', 'success');
      setChoosing(false);
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

  async function handleConfirm() {
    if (!method || !reference) {
      setChoosing(true);
      return;
    }
    const ok = await confirm({
      title: 'Confirm this payment?',
      message: `${memberName}'s ${line} (${amount}) is marked paid by ${formatPaymentMethod(method)}, reference ${reference}. Check it arrived first.`,
      confirmLabel: 'Confirm payment',
    });
    if (!ok) return;
    send();
  }

  function handleReject() {
    startTransition(async () => {
      const result = await rejectFeeSubmission(submissionId, reason);
      if (!result.ok) {
        toast(result.code ? `${result.error} (${result.code}.${result.ref})` : result.error, 'error');
        return;
      }
      toast('Receipt rejected', 'success');
      setRejecting(false);
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
      {fromForm && <Badge variant="info">From the form</Badge>}
      <Button variant="ghost" size="sm" onClick={handleConfirm} loading={isPending}>
        Confirm
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setRejecting(true)} disabled={isPending}>
        Reject
      </Button>
      {fromForm && proofHref && (
        <Button variant="ghost" size="sm" onClick={handleErase} disabled={isPending}>
          Erase screenshot
        </Button>
      )}
      <Dialog open={rejecting} onClose={() => setRejecting(false)} title={`Reject receipt: ${memberName}`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            {fromForm
              ? `${memberName} sent this through the form, so nobody is notified. Tell them yourself if they should send another.`
              : `${memberName} is sent a notification with this reason and can send a new receipt.`}
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
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
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
        </div>
      </Dialog>
      <Dialog open={choosing} onClose={() => setChoosing(false)} title={`Confirm payment: ${memberName}`}>
        <div className="space-y-4">
          {reference ? (
            <p className="text-sm text-[var(--text-secondary)]">
              The site could not tell how {memberName} paid their {line} ({amount}), reference {reference}.
              Check the screenshot, say how it was paid, and check it arrived first.
            </p>
          ) : (
            <>
              <p className="text-sm text-[var(--text-secondary)]">
                {memberName} sent a screenshot for their {line} ({amount}) and no reference. Type the reference
                from the screenshot, and check it arrived first.
              </p>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Input
                    label="Reference"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    maxLength={40}
                    autoComplete="off"
                  />
                </div>
                {proofHref && readableScreenshot && (
                  <Button variant="ghost" size="sm" onClick={readScreenshot} loading={reading} disabled={isPending}>
                    Read screenshot
                  </Button>
                )}
              </div>
              {proofHref && !readableScreenshot && (
                <p className="text-xs text-[var(--text-muted)]">
                  This screenshot is a PDF or HEIC, which the console cannot read. Open it and type the reference.
                </p>
              )}
            </>
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
                  disabled={isPending || (m === 'e_transfer' && shortReference)}
                >
                  {m === 'e_transfer' ? 'Interac e-Transfer' : 'Campus Rec website'}
                </Button>
              ))}
            </div>
          )}
          {shortReference && (
            <p className="text-xs text-[var(--text-muted)]">
              {shownReference} is too short for an e-transfer reference, so this can only be an Campus Rec receipt.
              If it is not one, reject it and ask for the right reference.
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setChoosing(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => effectiveMethod && send(method ? undefined : effectiveMethod)}
              loading={isPending}
              disabled={
                !effectiveMethod ||
                !referenceReady ||
                (effectiveMethod === 'e_transfer' && shortReference)
              }
              className="flex-1"
            >
              Confirm payment
            </Button>
          </div>
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
