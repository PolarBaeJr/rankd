// The suppression list is the gate sender.ts's own comment calls "the gate that
// must never fail open". These assert that it does not.
//
// Resend is mocked, so no test here can put mail in front of anybody. That is
// deliberate rather than incidental: leaving RESEND_API_KEY unset would make
// these pass through a completely different code path (the throw in sendEmail)
// and prove nothing about the gate.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const send = vi.fn().mockResolvedValue({ data: { id: 'msg-1' }, error: null });
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

type Table = 'email_suppressions' | 'players';
type Answer = { data: unknown; error: { message: string } | null };
const answers: Record<Table, Answer> = {
  email_suppressions: { data: null, error: null },
  players: { data: null, error: null },
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: Table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => answers[table],
          // The guest read (00292); no guests here.
          eq: () => ({ limit: async () => ({ data: [], error: null }) }),
        }),
      }),
    }),
  }),
}));

async function loadSender() {
  // Fresh module each time: sender.ts memoises both the Resend and the
  // service-role client in module scope.
  vi.resetModules();
  return import('../email/sender');
}

describe('sendCategoryEmail suppression gate', () => {
  beforeEach(() => {
    send.mockClear();
    answers.email_suppressions = { data: null, error: null };
    answers.players = { data: null, error: null };
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    vi.stubEnv('NEXT_PUBLIC_PLAYER_URL', 'https://player.test');
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', 'unsubscribe-test-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not send when the address is suppressed', async () => {
    answers.email_suppressions = { data: { email: 'x@example.org' }, error: null };
    const { sendChallengeReceivedEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail('x@example.org', 'Opponent', 'singles', 'ladder', 'c1');

    expect(outcome).toEqual({ sent: false, reason: 'suppressed' });
    expect(send).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the suppression read errors', async () => {
    // A failed PostgREST read arrives as `data: null` with an error, never as a
    // throw. Discarding the error makes `blocked` falsy and mails somebody who
    // hard-bounced or filed a spam complaint — silently.
    answers.email_suppressions = { data: null, error: { message: 'JWT expired' } };
    const { sendChallengeReceivedEmail } = await loadSender();

    await expect(
      sendChallengeReceivedEmail('x@example.org', 'Opponent', 'singles', 'ladder', 'c1'),
    ).rejects.toThrow(/suppression/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('still sends when nothing is suppressed and the category is on', async () => {
    answers.players = { data: { notification_preferences: { email_challenges: true } }, error: null };
    const { sendChallengeReceivedEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail('x@example.org', 'Opponent', 'singles', 'ladder', 'c1');

    expect(outcome).toEqual({ sent: true, providerMessageId: 'msg-1' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps the preference read failing OPEN, as documented', async () => {
    // Deliberately the opposite call from the suppression read: a preference
    // lookup that misses must not silence a member's mail. Asserted so the
    // suppression fix is not later "tidied" into this one too.
    answers.players = { data: null, error: { message: 'JWT expired' } };
    const { sendChallengeReceivedEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail('x@example.org', 'Opponent', 'singles', 'ladder', 'c1');

    expect(outcome).toEqual({ sent: true, providerMessageId: 'msg-1' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('the missing unsubscribe secret is no longer silent', () => {
  // FIX-LIST #7. The degradation is deliberate — a notification without a
  // footer beats no notification — but it was also invisible: no log line, no
  // error, no difference an operator could see in a sent email. These pin the
  // half that changed, which is the reporting, not the fallback.
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    send.mockClear();
    answers.email_suppressions = { data: null, error: null };
    answers.players = { data: null, error: null };
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    vi.stubEnv('NEXT_PUBLIC_PLAYER_URL', 'https://player.test');
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it('names EMAIL_UNSUBSCRIBE_SECRET when that is what is missing', async () => {
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', '');
    const { sendChallengeReceivedEmail } = await loadSender();

    const outcome = await sendChallengeReceivedEmail('x@example.org', 'Opponent', 'singles', 'ladder', 'c1');

    // Still sent. That is the whole trade and it must not have moved.
    expect(outcome).toEqual({ sent: true, providerMessageId: 'msg-1' });
    expect(send).toHaveBeenCalledTimes(1);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('EMAIL_UNSUBSCRIBE_SECRET');
  });

  it('distinguishes the OTHER cause of the same null', async () => {
    // An absent base URL and an absent secret produce an identical `null` from
    // safeUnsubscribeUrl, and they are fixed in different places. A message
    // that guessed would send the operator to the wrong file.
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', 'unsubscribe-test-secret');
    vi.stubEnv('NEXT_PUBLIC_PLAYER_URL', '');
    const { sendChallengeReceivedEmail } = await loadSender();

    await sendChallengeReceivedEmail('x@example.org', 'Opponent', 'singles', 'ladder', 'c1');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('NEXT_PUBLIC_PLAYER_URL');
    expect(String(warn.mock.calls[0]![0])).not.toContain('EMAIL_UNSUBSCRIBE_SECRET');
  });

  it('says it once, not once per email', async () => {
    // The weekly digest alone would otherwise bury the log in a few hundred
    // identical lines, and a warning nobody can read is the state this exists
    // to leave.
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', '');
    const { sendChallengeReceivedEmail } = await loadSender();

    await sendChallengeReceivedEmail('a@example.org', 'Opponent', 'singles', 'ladder', 'c1');
    await sendChallengeReceivedEmail('b@example.org', 'Opponent', 'singles', 'ladder', 'c2');
    await sendChallengeReceivedEmail('c@example.org', 'Opponent', 'singles', 'ladder', 'c3');

    expect(send).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the secret IS set', async () => {
    // Otherwise the previous three would pass against a warning that fires
    // unconditionally, which would be worse than the silence it replaced.
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', 'unsubscribe-test-secret');
    const { sendChallengeReceivedEmail } = await loadSender();

    await sendChallengeReceivedEmail('x@example.org', 'Opponent', 'singles', 'ladder', 'c1');

    expect(send).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
