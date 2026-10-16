// The console's Google Forms reader (00287). Google is a fake fetch and the
// database a fake that records every RPC. What matters: unconfigured it does
// nothing at all; one form's refusal never stops another; the watermark moves
// only after a whole, settled read, and reads start a minute before it; a 429
// that survives its retries ends the round and releases the forms not
// reached; and no RPC or receipt carries more than ids, counts and codes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const captured: unknown[] = [];
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn((err: unknown, extra: unknown) => captured.push({ err, extra })),
  captureMessage: vi.fn(),
}));

const { runRegistrationFormPoll, WATERMARK_OVERLAP_MS } = await import('../registration-form-poll');
const { resetGoogleTokenCache, GOOGLE_TOKEN_URL } = await import('../google-forms');

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'reader@example.com',
  private_key: PEM,
  private_key_id: 'kid',
});

const EVENT = '00000000-0000-4000-8000-000000000001';
const MAPPING = {
  EMAIL_QUESTION: 'Email address',
  NAME_QUESTION: 'Full name',
  EVENT_QUESTION: 'Events',
  EVENTS: { Singles: EVENT },
  DEFAULT_EVENT_ID: '',
  PARTNERS: {},
};

function form(id: string, formId: string, watermark: string | null = null) {
  return {
    id,
    form_id: formId,
    target_kind: 'tournament',
    tournament_id: 't',
    club_event_id: null,
    read_mapping: MAPPING,
    poll_watermark: watermark,
    claimed_at: `2026-10-09T12:00:00.123456+00:00`,
  };
}

const FORM_ITEMS = {
  items: [
    { title: 'Email address', questionItem: { question: { questionId: 'qe' } } },
    { title: 'Full name', questionItem: { question: { questionId: 'qn' } } },
    { title: 'Events', questionItem: { question: { questionId: 'qv' } } },
  ],
};

function response(id: string, at: string, email = 'p@example.org') {
  return {
    responseId: id,
    lastSubmittedTime: at,
    answers: {
      qe: { questionId: 'qe', textAnswers: { answers: [{ value: email }] } },
      qn: { questionId: 'qn', textAnswers: { answers: [{ value: 'Pat Player' }] } },
      qv: { questionId: 'qv', textAnswers: { answers: [{ value: 'Singles' }] } },
    },
  };
}

interface Rpc {
  fn: string;
  args: Record<string, unknown>;
}

let rpcs: Rpc[];
let claimed: ReturnType<typeof form>[];
let importResult: (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
let googleRequests: string[];
let google: (url: URL) => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function admin() {
  return {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === 'claim_registration_form_polls') return { data: claimed, error: null };
      if (fn === 'forms_api_import_registration') return importResult(args);
      return { data: true, error: null };
    }),
  } as never;
}

function deps(env: Record<string, string | undefined> = { GOOGLE_FORMS_SERVICE_ACCOUNT_JSON: KEY }) {
  return {
    env,
    now: () => Date.parse('2026-10-09T12:00:00Z'),
    sleep: vi.fn(async () => undefined),
    fetch: vi.fn(async (url: string) => {
      if (url === GOOGLE_TOKEN_URL) return json(200, { access_token: 'tok', expires_in: 3600 });
      googleRequests.push(url);
      return google(new URL(url));
    }),
  };
}

const receipts = () => rpcs.filter((r) => r.fn === 'record_registration_form_poll').map((r) => r.args);
const imports = () => rpcs.filter((r) => r.fn === 'forms_api_import_registration').map((r) => r.args);

beforeEach(() => {
  resetGoogleTokenCache();
  rpcs = [];
  claimed = [];
  googleRequests = [];
  captured.length = 0;
  importResult = () => ({
    data: [{ item: 1, event_id: EVENT, status: 'pending', reason: null, replayed: false }],
    error: null,
  });
  google = () => json(200, {});
});

describe('unconfigured', () => {
  it('makes no claim and no Google call without the key', async () => {
    const d = deps({});
    const run = await runRegistrationFormPoll(admin(), d);
    expect(run).toMatchObject({ skipped: 'not_configured', claimed: 0 });
    expect(rpcs).toEqual([]);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(captured).toEqual([]);
  });

  it('makes no claim and no Google call with a key it cannot read', async () => {
    const d = deps({ GOOGLE_FORMS_SERVICE_ACCOUNT_JSON: '{"private_key": "x"' });
    const run = await runRegistrationFormPoll(admin(), d);
    expect(run).toMatchObject({ skipped: 'invalid_key', claimed: 0 });
    expect(rpcs).toEqual([]);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('makes no Google call when no form is due', async () => {
    const d = deps();
    const run = await runRegistrationFormPoll(admin(), d);
    expect(run.claimed).toBe(0);
    expect(d.fetch).not.toHaveBeenCalled();
  });
});

describe('a round', () => {
  it('imports each new response through the console door and advances the watermark', async () => {
    claimed = [form('b1', 'form-1', '2026-10-09T11:00:00.000Z')];
    google = (url) =>
      url.pathname.endsWith('/responses')
        ? json(200, {
            responses: [
              response('r2', '2026-10-09T11:30:00.250Z'),
              response('r1', '2026-10-09T11:10:00Z', 'q@example.org'),
            ],
          })
        : json(200, FORM_ITEMS);
    const run = await runRegistrationFormPoll(admin(), deps());

    const listUrl = new URL(googleRequests[0]!);
    const since = new Date(Date.parse('2026-10-09T11:00:00.000Z') - WATERMARK_OVERLAP_MS);
    expect(listUrl.searchParams.get('filter')).toBe(`timestamp >= ${since.toISOString().replace('.000Z', 'Z')}`);

    // Oldest first, each the payload the script would have sent.
    expect(imports().map((a) => (a.p_payload as { response_id: string }).response_id)).toEqual(['r1', 'r2']);
    expect(imports()[0]).toEqual({
      p_binding_id: 'b1',
      p_payload: {
        form_id: 'form-1',
        response_id: 'r1',
        submitted_at: '2026-10-09T11:10:00.000Z',
        email: 'q@example.org',
        name: 'Pat Player',
        entries: [{ event_id: EVENT }],
      },
    });
    expect(receipts()).toEqual([
      {
        p_binding_id: 'b1',
        p_claimed_at: '2026-10-09T12:00:00.123456+00:00',
        p_read: true,
        p_watermark: '2026-10-09T11:30:00.250Z',
        p_imported: 2,
        p_error: null,
      },
    ]);
    expect(run).toMatchObject({ claimed: 1, read: 1, imported: 2, errors: 0 });
  });

  it('counts a replay as read, not imported, and skips forms.get when nothing is new', async () => {
    claimed = [form('b1', 'form-1'), form('b2', 'form-2')];
    importResult = () => ({
      data: [{ item: 1, event_id: EVENT, status: 'pending', reason: null, replayed: true }],
      error: null,
    });
    google = (url) => {
      if (url.pathname === '/v1/forms/form-2/responses') return json(200, {});
      return url.pathname.endsWith('/responses')
        ? json(200, { responses: [response('r1', '2026-10-09T11:10:00Z')] })
        : json(200, FORM_ITEMS);
    };
    const run = await runRegistrationFormPoll(admin(), deps());
    expect(googleRequests.filter((u) => u.endsWith('/forms/form-2'))).toEqual([]);
    const byBinding = Object.fromEntries(receipts().map((r) => [r.p_binding_id, r]));
    expect(byBinding.b1).toMatchObject({ p_read: true, p_imported: 0, p_watermark: '2026-10-09T11:10:00.000Z' });
    expect(byBinding.b2).toMatchObject({ p_read: true, p_imported: 0, p_watermark: null, p_error: null });
    expect(run.imported).toBe(0);
  });

  it('keeps one form\'s refusal to that form', async () => {
    claimed = [form('denied', 'form-x'), form('fine', 'form-ok')];
    google = (url) => {
      if (url.pathname.includes('form-x')) return json(403, { error: { message: 'The caller does not have permission' } });
      return url.pathname.endsWith('/responses')
        ? json(200, { responses: [response('r1', '2026-10-09T11:10:00Z')] })
        : json(200, FORM_ITEMS);
    };
    const run = await runRegistrationFormPoll(admin(), deps());
    const byBinding = Object.fromEntries(receipts().map((r) => [r.p_binding_id, r]));
    expect(byBinding.denied).toMatchObject({ p_read: false, p_error: 'forbidden', p_watermark: null });
    expect(byBinding.fine).toMatchObject({ p_read: true, p_error: null, p_imported: 1 });
    expect(run).toMatchObject({ read: 1, errors: 1, imported: 1 });
    // An expected refusal is the card's business, not Sentry's.
    expect(captured).toEqual([]);
  });

  it('holds the watermark when an import fails, and tells Sentry without the payload', async () => {
    claimed = [form('b1', 'form-1', '2026-10-09T11:00:00.000Z')];
    google = (url) =>
      url.pathname.endsWith('/responses')
        ? json(200, { responses: [response('r1', '2026-10-09T11:10:00Z', 'secret@example.org')] })
        : json(200, FORM_ITEMS);
    importResult = () => ({ data: null, error: { message: 'deadlock detected' } });
    await runRegistrationFormPoll(admin(), deps());
    expect(receipts()[0]).toMatchObject({ p_read: false, p_watermark: null, p_error: 'import_failed' });
    expect(JSON.stringify(captured)).not.toContain('secret@example.org');
    expect(captured).toHaveLength(1);
  });

  it('skips a response the Data API would refuse, settles it, and says so', async () => {
    claimed = [form('b1', 'form-1')];
    google = (url) =>
      url.pathname.endsWith('/responses')
        ? json(200, { responses: [response('r1', '2026-10-09T11:10:00Z', 'not an address')] })
        : json(200, FORM_ITEMS);
    await runRegistrationFormPoll(admin(), deps());
    expect(imports()).toEqual([]);
    expect(receipts()[0]).toMatchObject({
      p_read: true,
      p_watermark: '2026-10-09T11:10:00.000Z',
      p_error: 'responses_skipped',
    });
  });

  it('refuses to import when the mapped questions are not on the form', async () => {
    claimed = [form('b1', 'form-1')];
    google = (url) =>
      url.pathname.endsWith('/responses')
        ? json(200, { responses: [response('r1', '2026-10-09T11:10:00Z')] })
        : json(200, { items: [{ title: 'Email', questionItem: { question: { questionId: 'qe' } } }] });
    await runRegistrationFormPoll(admin(), deps());
    expect(imports()).toEqual([]);
    expect(receipts()[0]).toMatchObject({ p_read: false, p_error: 'questions_missing' });
  });

  it('stops importing a form switched off mid-read', async () => {
    claimed = [form('b1', 'form-1')];
    google = (url) =>
      url.pathname.endsWith('/responses')
        ? json(200, { responses: [response('r1', '2026-10-09T11:10:00Z'), response('r2', '2026-10-09T11:11:00Z')] })
        : json(200, FORM_ITEMS);
    importResult = () => ({
      data: [{ item: 0, event_id: null, status: 'refused', reason: 'not_found', replayed: false }],
      error: null,
    });
    await runRegistrationFormPoll(admin(), deps());
    expect(imports()).toHaveLength(1);
    expect(receipts()[0]).toMatchObject({ p_read: false, p_error: 'not_bound' });
  });

  it('records a stored mapping that no longer parses without calling Google for it', async () => {
    claimed = [{ ...form('b1', 'form-1'), read_mapping: { EMAIL_QUESTION: '' } as never }];
    const d = deps();
    await runRegistrationFormPoll(admin(), d);
    expect(googleRequests).toEqual([]);
    expect(receipts()[0]).toMatchObject({ p_error: 'mapping_invalid', p_read: false });
  });
});

describe('rate limits and auth', () => {
  it('ends the round on a 429 that survives its retries and releases the forms not reached', async () => {
    claimed = Array.from({ length: 5 }, (_, i) => form(`b${i}`, `form-${i}`));
    google = () => json(429, {}, { 'retry-after': '1' });
    const d = deps();
    const run = await runRegistrationFormPoll(admin(), d);
    expect(run.stopped).toBe('rate_limited');
    const errors = receipts().filter((r) => r.p_error === 'rate_limited');
    const released = receipts().filter((r) => r.p_error === null && r.p_read === false);
    // The three that started say so; the two never reached keep their place.
    expect(errors).toHaveLength(3);
    expect(released).toHaveLength(2);
    expect(receipts()).toHaveLength(5);
    expect(d.sleep).toHaveBeenCalled();
  });

  it('records a refused key on every claimed form, once, with no Forms API call', async () => {
    claimed = [form('b1', 'form-1'), form('b2', 'form-2')];
    const d = deps();
    d.fetch.mockImplementation(async (url: string) =>
      url === GOOGLE_TOKEN_URL ? json(400, { error: 'invalid_grant' }) : json(200, {}),
    );
    const run = await runRegistrationFormPoll(admin(), d);
    expect(run.stopped).toBe('auth');
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(receipts().map((r) => r.p_error)).toEqual(['auth', 'auth']);
  });
});

describe('what leaves the reader', () => {
  it('puts no answer or address in any receipt', async () => {
    claimed = [form('b1', 'form-1')];
    google = (url) =>
      url.pathname.endsWith('/responses')
        ? json(200, { responses: [response('r1', '2026-10-09T11:10:00Z', 'hidden@example.org')] })
        : json(200, FORM_ITEMS);
    const run = await runRegistrationFormPoll(admin(), deps());
    expect(JSON.stringify(receipts())).not.toContain('hidden@example.org');
    expect(JSON.stringify(run)).not.toContain('hidden@example.org');
    expect(JSON.stringify(run)).not.toContain('Pat Player');
  });
});
