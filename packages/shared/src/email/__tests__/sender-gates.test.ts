import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// THE TWO GATES IN sendCategoryEmail HAD NO TESTS AT ALL.
//
// One of them is the gate the module's own docstring calls "the gate that must
// never fail open" — the suppression check that keeps mail away from an address
// that hard-bounced, filed a spam complaint, or unsubscribed from everything.
// F-013 fixed it to throw on a read error; nothing verified that it still does,
// so a future refactor destructuring the error away again would be silent.
//
// The two gates are deliberately ASYMMETRIC and the tests below pin that
// asymmetry down, because it is the kind of thing that reads like an oversight
// and gets "tidied" into consistency:
//   - suppression read fails  -> THROW. Not knowing is not permission to send.
//   - preference read fails   -> SEND, but say so. A failed lookup is not
//                                evidence the member said no; silencing their
//                                mail on that basis is the worse error.

const suppressionResult = { data: null as unknown, error: null as unknown };
const preferenceResult = { data: null as unknown, error: null as unknown };
const guestResult = { data: [] as unknown, error: null as unknown };
const sent: { to: string; subject: string }[] = [];

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (payload: { to: string; subject: string }) => {
        sent.push({ to: payload.to, subject: payload.subject });
        return { data: { id: 'stub' }, error: null };
      },
    };
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'email_suppressions' ? suppressionResult : preferenceResult,
          // The guest read (00292): players by email AND is_guest.
          eq: () => ({ limit: async () => guestResult }),
        }),
      }),
    }),
  }),
}));

// Both must be set or getAdmin() returns null and neither gate runs — which
// would make every assertion below vacuously pass.
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.test';
process.env.RESEND_API_KEY = 'test-resend-key';
// Without these, safeUnsubscribeUrl() yields nothing and warnUnsubscribeUnavailable
// fires its own console.warn — which would be counted by the warn assertions below
// and make them pass or fail for the wrong reason.
process.env.EMAIL_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret';
process.env.NEXT_PUBLIC_PLAYER_URL = 'https://player.example.test';

async function loadSender() {
  vi.resetModules();
  return import('../sender');
}

describe('sendCategoryEmail gates', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sent.length = 0;
    suppressionResult.data = null;
    suppressionResult.error = null;
    preferenceResult.data = null;
    preferenceResult.error = null;
    guestResult.data = [];
    guestResult.error = null;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => warn.mockRestore());

  it('sends when both gates come back clean', async () => {
    preferenceResult.data = { notification_preferences: { email_challenges: true } };
    const { sendChallengeReceivedEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail('Member@Example.test', 'Alex', 'singles', 'ranked', 'ch-1');

    expect(outcome).toEqual({ sent: true, providerMessageId: 'stub' });
    expect(sent).toHaveLength(1);
    // The address is lower-cased for the two LOOKUPS — a member stored in one
    // casing must still match a suppression list keyed in another — but the
    // mail goes to the address as given. The local part of an address is
    // case-sensitive per RFC 5321, so normalising what we actually send to
    // would be a delivery bug rather than a tidy-up.
    expect(sent[0]!.to).toBe('Member@Example.test');
  });

  it('refuses to send when the suppression read fails, rather than assuming not-suppressed', async () => {
    suppressionResult.error = { message: 'permission denied for table email_suppressions' };
    const { sendChallengeReceivedEmail } = await loadSender();

    await expect(
      sendChallengeReceivedEmail('member@example.test', 'Alex', 'singles', 'ranked', 'ch-1')
    ).rejects.toThrow(/Suppression check failed, refusing to send/);
    expect(sent).toHaveLength(0);
  });

  it('never hands a .invalid address to the provider (00306: a guest added with no email)', async () => {
    preferenceResult.data = { notification_preferences: { email_challenges: true } };
    const { sendChallengeReceivedEmail, sendEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail(
      'guest+0b4c@no-email.invalid', 'Alex', 'singles', 'ranked', 'ch-1',
    );
    expect(outcome).toEqual({ sent: false, reason: 'suppressed' });
    await expect(sendEmail('Guest+0b4c@No-Email.INVALID', 'Hi', '<p>hi</p>')).rejects.toThrow(/undeliverable/);
    expect(sent).toHaveLength(0);
  });

  it('does not send to a suppressed address', async () => {
    suppressionResult.data = { email: 'member@example.test' };
    const { sendChallengeReceivedEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail('member@example.test', 'Alex', 'singles', 'ranked', 'ch-1');

    expect(outcome).toEqual({ sent: false, reason: 'suppressed' });
    expect(sent).toHaveLength(0);
  });

  it('sends a guest record (00292) nothing, not even transactional mail, and refuses when it cannot tell', async () => {
    guestResult.data = [{ id: 'guest' }];
    const { sendChallengeReceivedEmail, sendPlayerApprovedEmail } = await loadSender();

    expect(await sendChallengeReceivedEmail('guest@example.test', 'Alex', 'singles', 'ranked', 'ch-1'))
      .toEqual({ sent: false, reason: 'suppressed' });
    expect(await sendPlayerApprovedEmail('guest@example.test', 'Ann')).toEqual({ sent: false, reason: 'suppressed' });

    guestResult.data = null;
    guestResult.error = { message: 'column players.is_guest does not exist' };
    await expect(
      sendChallengeReceivedEmail('guest@example.test', 'Alex', 'singles', 'ranked', 'ch-1')
    ).rejects.toThrow(/Guest check failed, refusing to send/);
    expect(sent).toHaveLength(0);
  });

  it('does not send when the member has the category switched off', async () => {
    preferenceResult.data = { notification_preferences: { email_challenges: false } };
    const { sendChallengeReceivedEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail('member@example.test', 'Alex', 'singles', 'ranked', 'ch-1');

    expect(outcome).toEqual({ sent: false, reason: 'opted_out' });
    expect(sent).toHaveLength(0);
  });

  it('STILL SENDS when the preference read fails — but warns that opt-outs are not being honoured', async () => {
    preferenceResult.error = { message: 'connection reset' };
    const { sendChallengeReceivedEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail('member@example.test', 'Alex', 'singles', 'ranked', 'ch-1');

    expect(outcome).toEqual({ sent: true, providerMessageId: 'stub' });
    expect(sent).toHaveLength(1);
    // The point of the change: the old code did `void preferenceError`, so a
    // preference read broken for EVERY recipient of a digest run mailed
    // everyone who had opted out and left nothing at all to notice it by.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/opt-outs are NOT being honoured/);
  });

  it('warns once per process, not once per recipient', async () => {
    preferenceResult.error = { message: 'connection reset' };
    const { sendChallengeReceivedEmail } = await loadSender();

    for (let i = 0; i < 5; i++) {
      await sendChallengeReceivedEmail(`m${i}@example.test`, 'Alex', 'singles', 'ranked', 'ch-1');
    }

    expect(sent).toHaveLength(5);
    // This sits inside the per-recipient loop of every bulk send. Reporting
    // each occurrence turns one broken read into thousands of identical lines.
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
