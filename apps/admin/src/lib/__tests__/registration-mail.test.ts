// The mail a Google Form response causes (00283). Nothing here reaches a
// provider: sendEmail is mocked, and the database is a fake that records every
// RPC. What matters: the receipt follows the send and never precedes it, a
// suppressed or failed address is receipted as not sent, invites wait for the
// guest_waivers feature, and no receipt ever carries an email address.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendEmail = vi.fn(async (_to: string, _subject: string, _html: string) => ({ providerMessageId: 'msg-1' }));
let flags: Record<string, boolean> | Error = { guest_waivers: true };
vi.mock('@badminton/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@badminton/shared')>()),
  sendEmail,
  readFeatureFlags: vi.fn(async () => {
    if (flags instanceof Error) throw flags;
    return flags;
  }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const { runRegistrationMail, confirmEmail, inviteEmail, INVITE_DAILY_CAP } = await import('../registration-mail');

interface Call {
  fn: string;
  args: Record<string, unknown>;
}
let calls: Call[];
let confirmRows: unknown[];
let inviteRows: unknown[];
let suppressed: Set<string>;
let suppressionError: string | null;

function fakeAdmin() {
  return {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'claim_registration_confirm_emails') return { data: confirmRows, error: null };
      if (fn === 'claim_guest_waiver_invites') return { data: inviteRows, error: null };
      return { data: null, error: null };
    }),
    from: (table: string) => {
      expect(table).toBe('email_suppressions');
      let address = '';
      const chain = {
        select: () => chain,
        eq: (_column: string, value: string) => {
          address = value;
          return chain;
        },
        maybeSingle: async () =>
          suppressionError
            ? { data: null, error: { message: suppressionError } }
            : { data: suppressed.has(address) ? { email: address } : null, error: null },
      };
      return chain;
    },
  } as never;
}

const member = {
  entry_id: '11111111-1111-4111-8111-111111111111',
  email: 'member@example.com',
  first_name: 'Matthew',
  target_name: 'Fall Open',
  event_type: 'mens_singles',
};
const guest = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'member@example.com',
  target_kind: 'tournament',
  target_id: '33333333-3333-4333-8333-333333333333',
  target_name: 'Fall Open',
  target_starts: '2026-11-14',
};

beforeEach(() => {
  calls = [];
  confirmRows = [];
  inviteRows = [];
  suppressed = new Set();
  suppressionError = null;
  flags = { guest_waivers: true };
  sendEmail.mockClear();
  sendEmail.mockImplementation(async () => ({ providerMessageId: 'msg-1' }));
});

const receipts = () => calls.filter((c) => c.fn === 'record_registration_mail_receipt').map((c) => c.args);

describe('registration mail', () => {
  it('sends a member confirmation, then receipts it', async () => {
    confirmRows = [member];
    const run = await runRegistrationMail(fakeAdmin());
    expect(run.confirmations).toEqual({ claimed: 1, sent: 1, failed: 0, suppressed: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toBe('member@example.com');
    expect(sendEmail.mock.calls[0]![2]).toContain(`/registrations/${member.entry_id}`);
    expect(receipts()).toEqual([
      { p_kind: 'registration_confirm', p_id: member.entry_id, p_sent: true, p_error: null },
    ]);
  });

  it('receipts a failed send as not sent, with no address in the reason', async () => {
    confirmRows = [member];
    sendEmail.mockImplementation(async () => {
      throw new Error('Resend send failed: member@example.com is invalid');
    });
    const run = await runRegistrationMail(fakeAdmin());
    expect(run.confirmations.failed).toBe(1);
    const [receipt] = receipts();
    expect(receipt).toMatchObject({ p_kind: 'registration_confirm', p_sent: false });
    expect(String(receipt!.p_error)).not.toContain('@');
  });

  it('never mails a suppressed address, and refuses when the list cannot be read', async () => {
    confirmRows = [member];
    suppressed.add('member@example.com');
    let run = await runRegistrationMail(fakeAdmin());
    expect(sendEmail).not.toHaveBeenCalled();
    expect(run.confirmations.suppressed).toBe(1);
    expect(receipts()[0]).toMatchObject({ p_sent: false, p_error: 'suppressed' });

    calls = [];
    suppressed.clear();
    suppressionError = 'permission denied';
    run = await runRegistrationMail(fakeAdmin());
    expect(sendEmail).not.toHaveBeenCalled();
    expect(run.confirmations.failed).toBe(1);
  });

  it('holds every invite while guest waivers are off, and when the flag cannot be read', async () => {
    inviteRows = [guest];
    flags = { guest_waivers: false };
    let run = await runRegistrationMail(fakeAdmin());
    expect(run.invites.skipped).toBe('guest_waivers_off');
    expect(calls.some((c) => c.fn === 'claim_guest_waiver_invites')).toBe(false);

    calls = [];
    flags = new Error('flags unreadable');
    run = await runRegistrationMail(fakeAdmin());
    expect(run.invites.skipped).toBe('guest_waivers_off');
    expect(calls.some((c) => c.fn === 'claim_guest_waiver_invites')).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends an invite once the feature is on, under the daily cap', async () => {
    inviteRows = [guest];
    const run = await runRegistrationMail(fakeAdmin());
    expect(run.invites).toEqual({ claimed: 1, sent: 1, failed: 0, suppressed: 0 });
    expect(calls.find((c) => c.fn === 'claim_guest_waiver_invites')!.args).toMatchObject({
      p_daily_cap: INVITE_DAILY_CAP,
    });
    expect(sendEmail.mock.calls[0]![2]).toContain('/guest-waiver');
    expect(receipts()).toEqual([{ p_kind: 'guest_waiver_invite', p_id: guest.id, p_sent: true, p_error: null }]);
  });

  it('escapes what a form typed, in the body and the subject', () => {
    const mail = confirmEmail({ ...member, first_name: '<b>x</b>', target_name: 'Open\r\nBcc: someone' });
    expect(mail.html).not.toContain('<b>x</b>');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    const invite = inviteEmail({ target_name: '<script>', target_starts: null });
    expect(invite.html).not.toContain('<script>');
  });
});
