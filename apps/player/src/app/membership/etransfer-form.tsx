'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ImagePlus, Loader2 } from 'lucide-react';
import {
  isPlausibleReference,
  normaliseReference,
} from '@badminton/shared/src/utils/etransfer-reference';
import type { ReceiptMethod } from '@badminton/shared/src/utils/receipt-method';
import { createClient } from '@/lib/supabase-browser';
import { submitFeeSubmission } from '@/lib/actions/fee-submissions';
import type { ActionResult } from '@/lib/actions/_shared';

/** What the form hands on once the screenshot is uploaded. */
export interface SentReceipt {
  reference: string;
  screenshotPath: string;
  detectedMethod: ReceiptMethod | null;
}

// One unpaid line's "I have paid" form: the screenshot and the reference, both
// required. The member is not asked how they paid. Picking a screenshot runs
// OCR in the browser (./ocr, loaded only then), which pre-fills the reference
// and guesses whether it is an e-transfer confirmation or an SFU Rec receipt;
// the guess goes to the action with the rest, and the exec checks it. The field
// stays editable and a failed read leaves it empty.
//
// The name is from when e-transfer was the only way to pay.
//
// The screenshot is uploaded straight to fee-proofs from the browser, into the
// member's own folder (the one storage path 00248 allows), the way
// /feedback does it, and the action is handed the path.
//
// `onSend` replaces the Membership page's action: a paid club event's sign-up
// sends the receipt with the sign-up itself, so nobody is on the list without
// one. The server removes the upload when it refuses, either way.

// Mirrors 00248's bucket, so a wrong file is refused at the picker.
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function EtransferForm({
  feeId,
  duesSeasonId,
  dues,
  onSend,
  sendLabel = 'Send receipt',
  onSent,
}: {
  feeId: string | null;
  duesSeasonId: string | null;
  /** Only dues are sold on the SFU Rec website; every other line is an e-transfer. */
  dues: boolean;
  onSend?: (receipt: SentReceipt) => Promise<ActionResult>;
  sendLabel?: string;
  onSent?: () => void;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState('');
  const [detectedMethod, setDetectedMethod] = useState<ReceiptMethod | null>(null);
  const [reading, setReading] = useState(false);
  const [readHint, setReadHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const touched = useRef(false);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    setReadHint(null);
    setDetectedMethod(null);
    const picked = e.target.files?.[0] ?? null;
    if (!picked) {
      setFile(null);
      return;
    }
    if (!ALLOWED_TYPES.includes(picked.type)) {
      setError('That file is not a JPEG, PNG or WebP image.');
      e.target.value = '';
      return;
    }
    if (picked.size > MAX_BYTES) {
      setError('That image is over 8 MB. Try a screenshot of just the confirmation.');
      e.target.value = '';
      return;
    }
    setFile(picked);
    setReading(true);
    try {
      const { readReceipt } = await import('./ocr');
      const { reference: found, method } = await readReceipt(picked);
      setDetectedMethod(method);
      if (found && !touched.current) {
        setReference(found.value);
        setReadHint('Read from your screenshot, please check it.');
      }
    } finally {
      setReading(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('Attach a screenshot of your receipt.');
      return;
    }
    const cleaned = normaliseReference(reference);
    if (!cleaned) {
      setError('Enter the reference or receipt number.');
      return;
    }
    // The action's check, for the method it will store.
    const storedMethod = dues ? detectedMethod : 'e_transfer';
    if (!isPlausibleReference(cleaned, storedMethod)) {
      setError(
        storedMethod === 'e_transfer'
          ? 'The reference is 6 to 32 letters, digits or hyphens, with no spaces, or the number exactly as your bank shows it.'
          : 'The reference is 4 to 32 letters, digits or hyphens, with no spaces.',
      );
      return;
    }
    startTransition(async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          setError('Your session expired. Sign in again and resend.');
          return;
        }
        const path = `${user.id}/${crypto.randomUUID()}.${EXTENSIONS[file.type] ?? 'jpg'}`;
        const { error: uploadError } = await supabase.storage
          .from('fee-proofs')
          .upload(path, file, { contentType: file.type, upsert: false });
        if (uploadError) {
          setError(`The screenshot could not be uploaded (${uploadError.message}). Try a smaller image.`);
          return;
        }
        const res = onSend
          ? await onSend({ reference: cleaned, screenshotPath: path, detectedMethod })
          : await submitFeeSubmission({
              feeId,
              duesSeasonId,
              reference: cleaned,
              screenshotPath: path,
              detectedMethod,
            });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setFile(null);
        setReference('');
        setDetectedMethod(null);
        setReadHint(null);
        if (fileInput.current) fileInput.current.value = '';
        onSent?.();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not send that receipt');
      }
    });
  }

  const busy = pending || reading;

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 10, marginTop: 12 }}>
      <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
        <span>Screenshot of your receipt</span>
        {/* The native picker's "Choose file / No file chosen" cannot be styled,
            so the input is visually hidden inside a button-styled label. */}
        <div className="file-pick">
          <label className="btn btn-ghost file-pick-button">
            <ImagePlus size={14} aria-hidden />
            {file ? 'Change screenshot' : 'Choose screenshot'}
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={pick}
              disabled={pending}
              className="file-pick-input"
            />
          </label>
          <span className="file-pick-name">{file ? file.name : 'No screenshot yet'}</span>
        </div>
      </div>
      <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
        <span>Reference or receipt number</span>
        <input
          type="text"
          className="input-base"
          value={reference}
          onChange={(e) => {
            touched.current = true;
            setReadHint(null);
            setReference(e.target.value);
          }}
          placeholder={reading ? 'Reading your screenshot...' : 'e.g. CA1a2B3c4D or 12345678'}
          maxLength={48}
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          required
        />
      </label>
      {readHint && <p className="fees-note" style={{ margin: 0 }}>{readHint}</p>}
      {error && (
        <p role="alert" style={{ color: 'var(--red)', fontSize: 13, margin: 0 }}>
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {pending ? <Loader2 size={14} className="animate-spin" /> : null}
          {pending ? 'Sending...' : reading ? 'Reading screenshot...' : sendLabel}
        </button>
      </div>
    </form>
  );
}
