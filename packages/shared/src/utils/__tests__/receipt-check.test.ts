import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkSubmission, sweepReceiptChecks, type OcrRead, type ReceiptOcr } from '../receipt-check';

// The orchestration around the read (00297): what it claims, what it sends the
// database, and that nothing read off a screenshot leaves it. The OCR and the
// RPCs are fakes; every value is made up.

const TEXT = 'Interac e-Transfer sent\nAmount\n$15.00\nSent to\nSFU Badminton Club\nReference number\nCA1Q7r2Kp9Xb';
const SECRET_LINE = 'Ana Lee | ID #: 301234567';

type Row = {
  submission_id: string;
  club_fee_id: string;
  screenshot_path: string | null;
  method: string | null;
  fee_type: string;
  amount_cents: number | null;
  payer_name: string | null;
  attempts: number;
};

const row = (over: Partial<Row> = {}): Row => ({
  submission_id: 'sub-1',
  club_fee_id: 'fee-1',
  screenshot_path: 'p/sub-1.png',
  method: 'e_transfer',
  fee_type: 'dues',
  amount_cents: 1500,
  payer_name: 'Ana Lee',
  attempts: 1,
  ...over,
});

function fakeAdmin(queue: Row[], opts: { download?: 'fail'; confirm?: string } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'claim_fee_submission_ocr') {
        const next = queue.shift();
        return { data: next ? [next] : [], error: null };
      }
      if (fn === 'auto_confirm_fee_submission') return { data: opts.confirm ?? 'ok', error: null };
      return { data: 'ok', error: null };
    }),
    storage: {
      from: () => ({
        download: async () =>
          opts.download === 'fail'
            ? { data: null, error: { message: 'gone' } }
            : { data: new Blob([new Uint8Array([1, 2, 3])]), error: null },
      }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { value: { etransfer_email: 'club@example.org', etransfer_payee_name: 'SFU Badminton Club' } },
            error: null,
          }),
        }),
      }),
    }),
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

function fakeOcr(read: OcrRead | (() => OcrRead), opts: { busy?: boolean } = {}): ReceiptOcr {
  return {
    withSlot: async (work) => (opts.busy ? 'busy' : work()),
    read: async () => (typeof read === 'function' ? read() : read),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('checkSubmission', () => {
  it('confirms a clean receipt with its reference, amount and hash', async () => {
    const { admin, calls } = fakeAdmin([row()]);
    expect(await checkSubmission(admin, 'sub-1', fakeOcr({ text: TEXT }))).toBe('ok');
    expect(calls[0]).toEqual({ fn: 'claim_fee_submission_ocr', args: { p_submission_id: 'sub-1', p_limit: 1 } });
    const confirm = calls.find((c) => c.fn === 'auto_confirm_fee_submission')!;
    expect(confirm.args).toMatchObject({
      p_submission_id: 'sub-1',
      p_method: 'e_transfer',
      p_reference: 'CA1Q7r2Kp9Xb',
      p_amount_cents: 1500,
    });
    expect(confirm.args.p_image_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('holds an amount that is not the fee, with the sentence and no name', async () => {
    const { admin, calls } = fakeAdmin([row({ amount_cents: 2500 })]);
    expect(await checkSubmission(admin, 'sub-1', fakeOcr({ text: TEXT }))).toBe('amount_mismatch');
    const flag = calls.find((c) => c.fn === 'flag_fee_submission_ocr')!;
    expect(flag.args).toMatchObject({ p_flag: 'amount_mismatch', p_detail: 'Receipt shows $15.00, the fee is $25.00' });
  });

  it('holds a timeout and a failed read by their kind', async () => {
    let { admin, calls } = fakeAdmin([row()]);
    expect(await checkSubmission(admin, 'sub-1', fakeOcr({ error: 'timeout' }))).toBe('ocr_timeout');
    expect(calls.some((c) => c.fn === 'auto_confirm_fee_submission')).toBe(false);
    ({ admin, calls } = fakeAdmin([row()]));
    expect(await checkSubmission(admin, 'sub-1', fakeOcr({ error: 'failed' }))).toBe('ocr_failed');
  });

  it('holds a PDF without reading it, but still records its hash', async () => {
    const read = vi.fn((): OcrRead => ({ text: TEXT }));
    const { admin, calls } = fakeAdmin([row({ screenshot_path: 'p/sub-1.pdf' })]);
    expect(await checkSubmission(admin, 'sub-1', fakeOcr(read))).toBe('unreadable_format');
    expect(read).not.toHaveBeenCalled();
    expect(calls.find((c) => c.fn === 'flag_fee_submission_ocr')!.args.p_image_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves a receipt whose screenshot will not download for the next claim', async () => {
    const { admin, calls } = fakeAdmin([row()], { download: 'fail' });
    expect(await checkSubmission(admin, 'sub-1', fakeOcr({ text: TEXT }))).toBe('retry');
    expect(calls.map((c) => c.fn)).toEqual(['claim_fee_submission_ocr']);
  });

  it('answers busy without claiming, so no attempt is spent', async () => {
    const { admin, calls } = fakeAdmin([row()]);
    expect(await checkSubmission(admin, 'sub-1', fakeOcr({ text: TEXT }, { busy: true }))).toBe('busy');
    expect(calls).toEqual([]);
  });

  it('answers none when somebody settled it first', async () => {
    const { admin } = fakeAdmin([row()], { confirm: 'not_pending' });
    expect(await checkSubmission(admin, 'sub-1', fakeOcr({ text: TEXT }))).toBe('none');
  });

  it('never logs or sends the text it read', async () => {
    const logged = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const { admin, calls } = fakeAdmin([row({ fee_type: 'dues', amount_cents: 2500 })]);
    await checkSubmission(
      admin,
      'sub-1',
      fakeOcr({ text: `O-601558\nReceipt\nThank you for your purchase.\n${SECRET_LINE}` }),
    );
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(calls)).not.toMatch(/301234567|Ana Lee \|/);
  });
});

describe('sweepReceiptChecks', () => {
  it('works through the queue one at a time until it is empty', async () => {
    const { admin } = fakeAdmin([row(), row({ submission_id: 'sub-2', amount_cents: 2500 })]);
    expect(await sweepReceiptChecks(admin, fakeOcr({ text: TEXT }), { deadline: Date.now() + 60_000, limit: 5 })).toEqual({
      ok: 1,
      amount_mismatch: 1,
    });
  });

  it('stops at the limit, on busy, and past the deadline', async () => {
    let { admin } = fakeAdmin([row(), row(), row()]);
    expect(await sweepReceiptChecks(admin, fakeOcr({ text: TEXT }), { deadline: Date.now() + 60_000, limit: 2 })).toEqual({
      ok: 2,
    });
    ({ admin } = fakeAdmin([row()]));
    expect(
      await sweepReceiptChecks(admin, fakeOcr({ text: TEXT }, { busy: true }), { deadline: Date.now() + 60_000, limit: 5 }),
    ).toEqual({ busy: 1 });
    ({ admin } = fakeAdmin([row()]));
    expect(await sweepReceiptChecks(admin, fakeOcr({ text: TEXT }), { deadline: 0, limit: 5 })).toEqual({});
  });
});
