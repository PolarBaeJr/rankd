'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import { Button, Dialog, Input, useConfirm } from '@badminton/ui';
import { errorToastText, resolvePaymentMethod } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { markFeePaid, waiveFee, markFeeUnpaid, addManualFee, removeManualFee, markNamedFeePaid, recordReinstatementPayment } from '@/lib/actions';
import {
  PaymentMethodFields,
  paymentMethodInvalid,
  EMPTY_PAYMENT_METHOD,
  type PaymentMethodState,
} from './payment-method-fields';

interface FeeActionsProps {
  playerId: string;
  playerName: string;
  seasonId: string;
  seasonName: string;
  defaultFeeCents: number;
  paid: boolean;
  waived: boolean;
}

export function FeeActions({ playerId, playerName, seasonId, seasonName, defaultFeeCents, paid, waived }: FeeActionsProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [amount, setAmount] = useState((defaultFeeCents / 100).toFixed(2));
  const [payment, setPayment] = useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  function handleMarkPaid() {
    startTransition(async () => {
      try {
        const dollars = amount ? parseFloat(amount) : undefined;
        await markFeePaid({
          player_id: playerId,
          season_id: seasonId,
          amount_cents: dollars ? Math.round(dollars * 100) : undefined,
          method: resolvePaymentMethod(payment.method, payment.customMethod),
          reference: payment.reference.trim() || undefined,
        });
        toast('Fee marked as paid', 'success');
        setOpen(false);
        setPayment(EMPTY_PAYMENT_METHOD);
        router.refresh();
      } catch (err) {
        toast(errorToastText(err, 'FEE', 'Failed to mark fee paid'), 'error');
      }
    });
  }

  function handleMarkUnpaid(successMessage: string) {
    startTransition(async () => {
      try {
        await markFeeUnpaid(playerId, seasonId);
        toast(successMessage, 'success');
        router.refresh();
      } catch (err) {
        toast(errorToastText(err, 'FEE', 'Failed to mark fee unpaid'), 'error');
      }
    });
  }

  async function handleWaive() {
    if (!(await confirm({ title: 'Waive fee?', message: `Waive the season fee for ${playerName}? They will be excluded from the outstanding count.`, confirmLabel: 'Waive fee' }))) return;
    startTransition(async () => {
      try {
        await waiveFee({ player_id: playerId, season_id: seasonId });
        toast('Fee waived', 'success');
        router.refresh();
      } catch (err) {
        toast(errorToastText(err, 'FEE', 'Failed to waive fee'), 'error');
      }
    });
  }

  if (paid) {
    return (
      <Button variant="ghost" size="sm" onClick={() => handleMarkUnpaid('Fee marked as unpaid')} loading={isPending}>
        Mark Unpaid
      </Button>
    );
  }

  if (waived) {
    return (
      <Button variant="ghost" size="sm" onClick={() => handleMarkUnpaid('Fee waiver removed')} loading={isPending}>
        Unwaive
      </Button>
    );
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={handleWaive} loading={isPending}>Skip (Waive)</Button>
      <Button variant="ghost" size="sm" onClick={() => { setAmount((defaultFeeCents / 100).toFixed(2)); setOpen(true); }}>Mark Paid</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Mark Fee Paid — ${playerName}`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Season: <strong className="text-[var(--text-primary)]">{seasonName}</strong>
          </p>
          <Input label="Amount $ (optional)" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 15.00" />
          <PaymentMethodFields value={payment} onChange={setPayment} disabled={isPending} />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleMarkPaid} loading={isPending} disabled={paymentMethodInvalid(payment)} className="flex-1">
              Mark Paid
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

export function AddManualFee({ seasonId, seasonName }: { seasonId: string; seasonName: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [payment, setPayment] = useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  // A named payment is inserted already paid, and club_fees_settled_has_amount
  // refuses a paid row with no amount, so the amount is required here. There is
  // no member row to take a tier price from, unlike Mark paid.
  const dollars = parseFloat(amount);
  const amountInvalid = amount.trim() === '' || Number.isNaN(dollars) || dollars < 0;

  function handleAdd() {
    startTransition(async () => {
      try {
        await addManualFee({
          season_id: seasonId,
          manual_name: name.trim(),
          email: email.trim() || undefined,
          amount_cents: Math.round(dollars * 100),
          method: resolvePaymentMethod(payment.method, payment.customMethod),
          reference: payment.reference.trim() || undefined,
        });
        toast(`Added ${name.trim()}`, 'success');
        setOpen(false);
        setName(''); setEmail(''); setAmount(''); setPayment(EMPTY_PAYMENT_METHOD);
        router.refresh();
      } catch (err) {
        toast(errorToastText(err, 'FEE', 'Failed to add name'), 'error');
      }
    });
  }

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        className="border-[var(--border-hover)] text-[var(--text-primary)]"
      >
        <UserPlus aria-hidden className="w-4 h-4" />
        Add a name
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add a name">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Record a payment for someone without an account for{' '}
            <strong className="text-[var(--text-primary)]">{seasonName}</strong>.
          </p>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jane Doe" />
          <div className="space-y-1">
            <Input
              label="Email (optional)"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g. jane@example.org"
            />
            <p className="text-xs text-[var(--text-muted)]">
              If they sign up later with this email, the payment moves onto their account.
            </p>
          </div>
          <Input label="Amount $" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 15.00" />
          <PaymentMethodFields value={payment} onChange={setPayment} disabled={isPending} />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} loading={isPending} className="flex-1" disabled={!name.trim() || amountInvalid || paymentMethodInvalid(payment)}>
              Add
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/**
 * Fill in the money for a reinstatement that has already been granted.
 *
 * An exec can lift a ban but cannot record a payment, so their unban leaves a
 * reinstatement with no amount. Before this existed there was no route back to
 * that row at all — the member was no longer banned, so the Unban dialog was
 * gone, and the ban could not be reinstated a second time. Whatever was handed
 * over stayed off the books for good.
 *
 * Amount is required here, unlike the other fee dialogs: the row already
 * exists, so a blank submission would be indistinguishable from not having
 * bothered. $0.00 is a legitimate entry meaning the reinstatement was free.
 */
export function RecordReinstatementPayment({ feeId, playerName }: { feeId: string; playerName: string }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [payment, setPayment] = useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  const dollars = parseFloat(amount);
  const amountInvalid = amount.trim() === '' || Number.isNaN(dollars) || dollars < 0;

  function handleRecord() {
    startTransition(async () => {
      try {
        await recordReinstatementPayment({
          fee_id: feeId,
          amount_cents: Math.round(dollars * 100),
          method: resolvePaymentMethod(payment.method, payment.customMethod),
          reference: payment.reference.trim() || undefined,
        });
        toast('Reinstatement payment recorded', 'success');
        setOpen(false);
        setAmount('');
        setPayment(EMPTY_PAYMENT_METHOD);
        router.refresh();
      } catch (err) {
        toast(errorToastText(err, 'FEE', 'Failed to record payment'), 'error');
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Record payment</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Record reinstatement payment">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            What did <strong className="text-[var(--text-primary)]">{playerName}</strong> pay to be reinstated?
            Enter $0.00 if the reinstatement was free.
          </p>
          <Input label="Amount $" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 20.00" />
          <PaymentMethodFields value={payment} onChange={setPayment} disabled={isPending} />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleRecord} loading={isPending} disabled={amountInvalid || paymentMethodInvalid(payment)} className="flex-1">
              Record
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

// An unpaid named row (a Google Form files one for a non-member, 00290) paid
// some other way than its screenshot: cash at a session, or no receipt sent.
export function MarkNamedFeePaid({ id, name, seasonName, amountCents }: { id: string; name: string; seasonName: string; amountCents: number | null }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(amountCents != null ? (amountCents / 100).toFixed(2) : '');
  const [payment, setPayment] = useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  const dollars = parseFloat(amount);
  const amountInvalid = amount.trim() === '' || Number.isNaN(dollars) || dollars <= 0;

  function handleMarkPaid() {
    startTransition(async () => {
      try {
        await markNamedFeePaid({
          fee_id: id,
          amount_cents: Math.round(dollars * 100),
          method: resolvePaymentMethod(payment.method, payment.customMethod),
          reference: payment.reference.trim() || undefined,
        });
        toast(`${name} marked as paid`, 'success');
        setOpen(false);
        setPayment(EMPTY_PAYMENT_METHOD);
        router.refresh();
      } catch (err) {
        toast(errorToastText(err, 'FEE', 'Failed to mark fee paid'), 'error');
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Mark Paid</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Mark Fee Paid: ${name}`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Season: <strong className="text-[var(--text-primary)]">{seasonName}</strong>
          </p>
          <Input label="Amount $" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 25.00" />
          <PaymentMethodFields value={payment} onChange={setPayment} disabled={isPending} />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleMarkPaid} loading={isPending} disabled={amountInvalid || paymentMethodInvalid(payment)} className="flex-1">
              Mark Paid
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

export function RemoveManualFee({ id, name }: { id: string; name: string }) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleRemove() {
    startTransition(async () => {
      try {
        await removeManualFee(id);
        toast(`Removed ${name}`, 'success');
        router.refresh();
      } catch (err) {
        toast(errorToastText(err, 'FEE', 'Failed to remove'), 'error');
      }
    });
  }

  return (
    <Button variant="danger" size="sm" onClick={handleRemove} loading={isPending}>
      Remove
    </Button>
  );
}
