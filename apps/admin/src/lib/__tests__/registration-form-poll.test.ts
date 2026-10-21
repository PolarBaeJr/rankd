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
let rpcReplies: Record<string, (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }>;
let uploads: { path: string; contentType: string; size: number }[];
let removed: string[];

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function admin() {
  return {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === 'claim_registration_form_polls') return { data: claimed, error: null };
      if (fn === 'forms_api_import_registration') return importResult(args);
      const reply = rpcReplies[fn];
      if (reply) return reply(args);
      return { data: true, error: null };
    }),
    storage: {
      from: () => ({
        upload: vi.fn(async (path: string, bytes: Uint8Array, opts: { contentType: string }) => {
          uploads.push({ path, contentType: opts.contentType, size: bytes.byteLength });
          return { data: { path }, error: null };
        }),
        remove: vi.fn(async (paths: string[]) => {
          removed.push(...paths);
          return { data: [], error: null };
        }),
      }),
    },
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
  rpcReplies = {};
  uploads = [];
  removed = [];
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

describe('an uploaded receipt (00288)', () => {
  const RECEIPT_MAPPING = { ...MAPPING, RECEIPT_QUESTION: 'E-transfer screenshot' };
  const ITEMS_WITH_UPLOAD = {
    items: [
      ...FORM_ITEMS.items,
      { title: 'E-transfer screenshot', questionItem: { question: { questionId: 'qf' } } },
    ],
  };
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  function withUpload(id: string, at: string, fileId: string) {
    const base = response(id, at);
    return {
      ...base,
      answers: {
        ...base.answers,
        qf: { questionId: 'qf', fileUploadAnswers: { answers: [{ fileId, fileName: 'my bank.png', mimeType: 'image/png' }] } },
      },
    };
  }

  const records = () => rpcs.filter((r) => r.fn === 'record_registration_import_receipt').map((r) => r.args);
  const settles = () => rpcs.filter((r) => r.fn === 'settle_registration_import_receipt').map((r) => r.args);

  function readsOneFormWithUpload(fileId = 'drive-1') {
    claimed = [{ ...form('b1', 'form-1'), read_mapping: RECEIPT_MAPPING }];
    google = (url) => {
      if (url.pathname.endsWith('/responses')) return json(200, { responses: [withUpload('r1', '2026-10-09T11:10:00Z', fileId)] });
      if (url.pathname.startsWith('/drive/')) return json(500, {});
      return json(200, ITEMS_WITH_UPLOAD);
    };
  }

  it('records the upload against the import, with no Drive call while importing', async () => {
    readsOneFormWithUpload();
    await runRegistrationFormPoll(admin(), deps());
    expect(records()).toEqual([
      { p_binding_id: 'b1', p_response_id: 'r1', p_drive_file_id: 'drive-1', p_mime_type: 'image/png' },
    ]);
    // The payload is the script's: the upload is not in it.
    expect(JSON.stringify(imports())).not.toContain('drive-1');
    expect(googleRequests.filter((u) => u.includes('/drive/'))).toEqual([]);
  });

  it('records a replay again and downloads nothing the database has not handed out', async () => {
    readsOneFormWithUpload();
    importResult = () => ({
      data: [{ item: 1, event_id: EVENT, status: 'pending', reason: null, replayed: true }],
      error: null,
    });
    rpcReplies.record_registration_import_receipt = () => ({ data: [{ outcome: 'unchanged', stale_path: null }], error: null });
    rpcReplies.claim_registration_import_receipts = () => ({ data: [], error: null });
    await runRegistrationFormPoll(admin(), deps());
    expect(records()).toHaveLength(1);
    expect(googleRequests.filter((u) => u.includes('/drive/'))).toEqual([]);
    expect(uploads).toEqual([]);
  });

  it('removes the object an upload replaced when nothing holds it', async () => {
    readsOneFormWithUpload('drive-2');
    rpcReplies.record_registration_import_receipt = () => ({
      data: [{ outcome: 'superseded', stale_path: 'forms/b1/i1/old.png' }],
      error: null,
    });
    await runRegistrationFormPoll(admin(), deps());
    expect(removed).toEqual(['forms/b1/i1/old.png']);
  });

  it('holds the watermark when the upload could not be recorded', async () => {
    readsOneFormWithUpload();
    rpcReplies.record_registration_import_receipt = () => ({ data: null, error: { message: 'deadlock detected' } });
    await runRegistrationFormPoll(admin(), deps());
    expect(receipts()[0]).toMatchObject({ p_read: false, p_watermark: null, p_error: 'import_failed' });
  });

  it('moves the watermark even when the download fails, and leaves the receipt claimed', async () => {
    readsOneFormWithUpload();
    rpcReplies.claim_registration_import_receipts = () => ({
      data: [{ id: 'rc1', import_id: 'i1', binding_id: 'b1', drive_file_id: 'drive-1', mime_type: 'image/png', attempts: 1 }],
      error: null,
    });
    const run = await runRegistrationFormPoll(admin(), deps());
    expect(receipts()[0]).toMatchObject({ p_read: true, p_watermark: '2026-10-09T11:10:00.000Z', p_error: null });
    expect(settles()).toEqual([]);
    expect(run.receipts).toMatchObject({ claimed: 1, downloaded: 0 });
  });

  it('downloads, checks and stores a claimed receipt, then files every round', async () => {
    rpcReplies.claim_registration_import_receipts = () => ({
      data: [{ id: 'rc1', import_id: '00000000-0000-4000-8000-0000000000a1', binding_id: '00000000-0000-4000-8000-0000000000b1', drive_file_id: 'drive-1', mime_type: 'image/png', attempts: 1 }],
      error: null,
    });
    rpcReplies.file_registration_import_receipts = () => ({ data: [{ receipt_id: 'rc1', outcome: 'filed' }], error: null });
    google = (url) => {
      if (url.searchParams.get('alt') === 'media') return new Response(PNG, { status: 200 });
      return json(200, { size: String(PNG.byteLength), mimeType: 'image/png' });
    };
    // No form is due: the receipts still run.
    const run = await runRegistrationFormPoll(admin(), deps());
    expect(run.claimed).toBe(0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.path).toMatch(
      /^forms\/00000000-0000-4000-8000-0000000000b1\/00000000-0000-4000-8000-0000000000a1\/[0-9a-f-]{36}\.png$/,
    );
    expect(uploads[0]!.contentType).toBe('image/png');
    expect(settles()).toEqual([
      { p_receipt_id: 'rc1', p_drive_file_id: 'drive-1', p_status: 'pending_fee', p_storage_path: uploads[0]!.path, p_size_bytes: PNG.byteLength },
    ]);
    expect(run.receipts).toMatchObject({ downloaded: 1, filed: { filed: 1 } });
  });

  it('downloads nothing once Google has refused the round, and still files', async () => {
    claimed = [form('b1', 'form-1')];
    const d = deps();
    d.fetch.mockImplementation(async (url: string) =>
      url === GOOGLE_TOKEN_URL ? json(400, { error: 'invalid_grant' }) : json(200, {}),
    );
    await runRegistrationFormPoll(admin(), d);
    expect(rpcs.some((r) => r.fn === 'claim_registration_import_receipts')).toBe(false);
    expect(rpcs.some((r) => r.fn === 'file_registration_import_receipts')).toBe(true);
  });
});

describe("a season's form (00290)", () => {
  const SEASON_MAPPING = {
    EMAIL_QUESTION: 'Email address',
    NAME_QUESTION: 'Full name',
    EVENT_QUESTION: '',
    EVENTS: {},
    DEFAULT_EVENT_ID: '',
    PARTNERS: {},
    RECEIPT_QUESTION: 'E-transfer screenshot',
  };
  const SEASON_ITEMS = {
    items: [
      { title: 'Email address', questionItem: { question: { questionId: 'qe' } } },
      { title: 'Full name', questionItem: { question: { questionId: 'qn' } } },
      { title: 'E-transfer screenshot', questionItem: { question: { questionId: 'qf' } } },
    ],
  };
  function duesResponse(id: string, at: string) {
    return {
      responseId: id,
      lastSubmittedTime: at,
      answers: {
        qe: { questionId: 'qe', textAnswers: { answers: [{ value: 'pat@example.org' }] } },
        qn: { questionId: 'qn', textAnswers: { answers: [{ value: 'Pat Player' }] } },
        qf: { questionId: 'qf', fileUploadAnswers: { answers: [{ fileId: 'drive-9', fileName: 'paid.png', mimeType: 'image/png' }] } },
      },
    };
  }
  function readsSeasonForm() {
    claimed = [
      { ...form('b9', 'form-9'), target_kind: 'season', tournament_id: null as never, read_mapping: SEASON_MAPPING as never },
    ];
    google = (url) => {
      if (url.pathname.endsWith('/responses')) return json(200, { responses: [duesResponse('r9', '2026-10-09T11:10:00Z')] });
      if (url.pathname.startsWith('/drive/')) return json(500, {});
      return json(200, SEASON_ITEMS);
    };
  }

  it('imports a response with no entries and records its screenshot', async () => {
    readsSeasonForm();
    // The database answers one pending row for a season's response.
    importResult = () => ({ data: [{ item: 1, event_id: null, status: 'pending', reason: null, replayed: false }], error: null });
    const run = await runRegistrationFormPoll(admin(), deps());
    expect(imports()).toEqual([
      {
        p_binding_id: 'b9',
        p_payload: {
          form_id: 'form-9',
          response_id: 'r9',
          submitted_at: '2026-10-09T11:10:00.000Z',
          email: 'pat@example.org',
          name: 'Pat Player',
          entries: [],
        },
      },
    ]);
    expect(rpcs.filter((r) => r.fn === 'record_registration_import_receipt').map((r) => r.args)).toEqual([
      { p_binding_id: 'b9', p_response_id: 'r9', p_drive_file_id: 'drive-9', p_mime_type: 'image/png' },
    ]);
    expect(run.forms[0]).toMatchObject({ read: true, imported: 1, replayed: 0, skipped: 0, error: null });
  });

  it('counts the one replayed row as a replay', async () => {
    readsSeasonForm();
    importResult = () => ({ data: [{ item: 1, event_id: null, status: 'pending', reason: null, replayed: true }], error: null });
    rpcReplies.record_registration_import_receipt = () => ({ data: [{ outcome: 'unchanged', stale_path: null }], error: null });
    const run = await runRegistrationFormPoll(admin(), deps());
    expect(run.forms[0]).toMatchObject({ read: true, imported: 0, replayed: 1 });
  });
});
