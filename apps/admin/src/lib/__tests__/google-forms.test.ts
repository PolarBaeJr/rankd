// The Google Forms client (00287). Google is never called: fetch is a fake
// that records every request. What matters: the key never leaks into an
// error, the JWT is a valid RS256 signature over the right claims, one token
// serves a round and is renewed before it expires, every page is read, and a
// 429 is retried and then reported rather than hammered.

import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  accessToken,
  filterTimestamp,
  getFormQuestions,
  GoogleFormsError,
  GOOGLE_FORMS_SCOPES,
  GOOGLE_TOKEN_URL,
  listResponsesSince,
  ReadBudget,
  readerStatus,
  readServiceAccount,
  resetGoogleTokenCache,
  signAssertion,
  type GoogleDeps,
  type ServiceAccount,
} from '../google-forms';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const ACCOUNT: ServiceAccount = {
  clientEmail: 'reader@example.com',
  privateKey: PEM,
  privateKeyId: 'kid-1',
};

function keyJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'service_account',
    client_email: ACCOUNT.clientEmail,
    private_key: PEM,
    private_key_id: 'kid-1',
    ...overrides,
  });
}

interface Request {
  url: string;
  init?: RequestInit;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function harness(route: (req: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const sleeps: number[] = [];
  let now = Date.parse('2026-10-09T12:00:00Z');
  const deps: GoogleDeps = {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return route({ url, init });
    },
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return {
    deps,
    requests,
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const tokenReply = (token = 'tok-1', expires = 3600) => json(200, { access_token: token, expires_in: expires });

beforeEach(() => resetGoogleTokenCache());

describe('the service account in the environment', () => {
  it('is not configured when unset or blank, and nothing else is said', () => {
    expect(readServiceAccount({})).toEqual({ state: 'not_configured' });
    expect(readServiceAccount({ GOOGLE_FORMS_SERVICE_ACCOUNT_JSON: '  ' })).toEqual({ state: 'not_configured' });
  });

  it('is invalid, without quoting the value, when it is not a service account key', () => {
    const secretish = '{"private_key": "key-material-abc", "client_email": ';
    const result = readServiceAccount({ GOOGLE_FORMS_SERVICE_ACCOUNT_JSON: secretish });
    expect(result).toEqual({ state: 'invalid' });
    expect(JSON.stringify(result)).not.toContain('key-material');
    expect(readServiceAccount({ GOOGLE_FORMS_SERVICE_ACCOUNT_JSON: keyJson({ type: 'authorized_user' }) }).state).toBe(
      'invalid',
    );
    expect(readServiceAccount({ GOOGLE_FORMS_SERVICE_ACCOUNT_JSON: keyJson({ client_email: 'nope' }) }).state).toBe(
      'invalid',
    );
  });

  it('repairs a private key whose newlines arrived as backslash n', () => {
    const escaped = keyJson({ private_key: PEM.replace(/\n/g, '\\n') });
    const result = readServiceAccount({ GOOGLE_FORMS_SERVICE_ACCOUNT_JSON: escaped });
    expect(result.state).toBe('ready');
    if (result.state === 'ready') expect(result.account.privateKey).toBe(PEM);
  });

  it('shows a page the email to share the folder with, never the key', () => {
    const status = readerStatus({ GOOGLE_FORMS_SERVICE_ACCOUNT_JSON: keyJson() });
    expect(status).toEqual({ state: 'ready', clientEmail: ACCOUNT.clientEmail });
    expect(JSON.stringify(status)).not.toContain('PRIVATE KEY');
  });
});

describe('the token', () => {
  it('signs an RS256 assertion for the two read-only scopes', () => {
    const jwt = signAssertion(ACCOUNT, 1_700_000_000);
    const [header, claims, signature] = jwt.split('.');
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    expect(decode(header!)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    expect(decode(claims!)).toEqual({
      iss: ACCOUNT.clientEmail,
      scope: GOOGLE_FORMS_SCOPES.join(' '),
      aud: GOOGLE_TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  it('turns a malformed key into an auth error that does not quote it', () => {
    let caught: unknown;
    try {
      signAssertion({ ...ACCOUNT, privateKey: 'not a key' }, 1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GoogleFormsError);
    expect((caught as GoogleFormsError).code).toBe('auth');
    expect((caught as Error).message).not.toContain('not a key');
  });

  it('is fetched once and cached until a minute before it expires', async () => {
    let issued = 0;
    const h = harness(() => tokenReply(`tok-${++issued}`, 3600));
    expect(await accessToken(ACCOUNT, h.deps)).toBe('tok-1');
    h.advance(58 * 60_000);
    expect(await accessToken(ACCOUNT, h.deps)).toBe('tok-1');
    expect(h.requests).toHaveLength(1);
    const body = new URLSearchParams(String(h.requests[0]!.init!.body));
    expect(h.requests[0]!.url).toBe(GOOGLE_TOKEN_URL);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    h.advance(90_000);
    expect(await accessToken(ACCOUNT, h.deps)).toBe('tok-2');
    expect(h.requests).toHaveLength(2);
  });

  it('is not reused for a different key', async () => {
    let issued = 0;
    const h = harness(() => tokenReply(`tok-${++issued}`));
    await accessToken(ACCOUNT, h.deps);
    expect(await accessToken({ ...ACCOUNT, privateKeyId: 'kid-2' }, h.deps)).toBe('tok-2');
  });

  it('reports a refused key as auth', async () => {
    const h = harness(() => json(400, { error: 'invalid_grant' }));
    await expect(accessToken(ACCOUNT, h.deps)).rejects.toMatchObject({ code: 'auth', httpStatus: 400 });
  });
});

describe('reading a form', () => {
  const FORM = 'form-abc';

  it('maps question ids to item titles, leaving grids out', async () => {
    const h = harness(({ url }) =>
      url === GOOGLE_TOKEN_URL
        ? tokenReply()
        : json(200, {
            items: [
              { title: 'Email address', questionItem: { question: { questionId: 'q1' } } },
              { title: 'A grid', questionGroupItem: { questions: [{ questionId: 'g1' }] } },
              { title: 'Section', pageBreakItem: {} },
              { title: 'Full name', questionItem: { question: { questionId: 'q2' } } },
            ],
          }),
    );
    const questions = await getFormQuestions(FORM, ACCOUNT, h.deps, new ReadBudget(10));
    expect(questions).toEqual([
      { questionId: 'q1', title: 'Email address' },
      { questionId: 'q2', title: 'Full name' },
    ]);
    expect(h.requests[1]!.url).toBe('https://forms.googleapis.com/v1/forms/form-abc');
    expect((h.requests[1]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('reads every page, from the watermark, with the documented filter', async () => {
    const pages: Record<string, unknown> = {
      first: {
        responses: [
          {
            responseId: 'r1',
            lastSubmittedTime: '2026-10-09T11:00:00.123456Z',
            answers: { q1: { questionId: 'q1', textAnswers: { answers: [{ value: 'a@example.org' }] } } },
          },
        ],
        nextPageToken: 'p2',
      },
      p2: {
        responses: [
          {
            responseId: 'r2',
            createTime: '2026-10-09T11:01:00Z',
            lastSubmittedTime: '2026-10-09T11:05:00Z',
            answers: {
              q3: { questionId: 'q3', textAnswers: { answers: [{ value: 'Singles' }, { value: 'Doubles' }] } },
              f1: { questionId: 'f1', fileUploadAnswers: { answers: [{ fileId: 'x' }] } },
            },
          },
        ],
      },
    };
    const h = harness(({ url }) => {
      if (url === GOOGLE_TOKEN_URL) return tokenReply();
      const token = new URL(url).searchParams.get('pageToken') ?? 'first';
      return json(200, pages[token]);
    });
    const since = new Date('2026-10-09T10:59:00.500Z');
    const responses = await listResponsesSince(FORM, since, ACCOUNT, h.deps, new ReadBudget(10));
    expect(responses).toEqual([
      { responseId: 'r1', lastSubmittedTime: '2026-10-09T11:00:00.123456Z', answers: { q1: ['a@example.org'] } },
      { responseId: 'r2', lastSubmittedTime: '2026-10-09T11:05:00Z', answers: { q3: ['Singles', 'Doubles'] } },
    ]);
    const listed = h.requests.filter((r) => r.url !== GOOGLE_TOKEN_URL).map((r) => new URL(r.url));
    expect(listed).toHaveLength(2);
    expect(listed[0]!.pathname).toBe('/v1/forms/form-abc/responses');
    expect(listed[0]!.searchParams.get('filter')).toBe('timestamp >= 2026-10-09T10:59:00Z');
    expect(listed[1]!.searchParams.get('pageToken')).toBe('p2');
    expect(filterTimestamp(since)).toBe('2026-10-09T10:59:00Z');
  });

  it('reads everything with no filter the first time', async () => {
    const h = harness(({ url }) => (url === GOOGLE_TOKEN_URL ? tokenReply() : json(200, {})));
    expect(await listResponsesSince(FORM, null, ACCOUNT, h.deps, new ReadBudget(10))).toEqual([]);
    expect(new URL(h.requests[1]!.url).searchParams.has('filter')).toBe(false);
  });

  it('waits out a 429 as Retry-After says, then carries on', async () => {
    let calls = 0;
    const h = harness(({ url }) => {
      if (url === GOOGLE_TOKEN_URL) return tokenReply();
      calls += 1;
      return calls === 1 ? json(429, {}, { 'retry-after': '3' }) : json(200, { responses: [] });
    });
    const budget = new ReadBudget(10);
    await listResponsesSince(FORM, null, ACCOUNT, h.deps, budget);
    expect(h.sleeps).toEqual([3000]);
    expect(budget.used).toBe(2);
  });

  it('gives up after two retries with rate_limited, waits capped', async () => {
    const h = harness(({ url }) => (url === GOOGLE_TOKEN_URL ? tokenReply() : json(429, {}, { 'retry-after': '120' })));
    await expect(listResponsesSince(FORM, null, ACCOUNT, h.deps, new ReadBudget(10))).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(h.sleeps).toEqual([10_000, 10_000]);
  });

  it('names a refusal by what it means, and never echoes Google\'s body', async () => {
    for (const [status, code] of [
      [403, 'forbidden'],
      [404, 'form_not_found'],
      [500, 'google_unavailable'],
      [400, 'google_refused'],
    ] as const) {
      resetGoogleTokenCache();
      const h = harness(({ url }) =>
        url === GOOGLE_TOKEN_URL ? tokenReply() : json(status, { error: { message: 'secret detail a@example.org' } }),
      );
      const err = await listResponsesSince(FORM, null, ACCOUNT, h.deps, new ReadBudget(10)).catch((e) => e);
      expect(err).toMatchObject({ code, httpStatus: status });
      expect(String(err.message)).not.toContain('a@example.org');
    }
  });

  it('drops the cached token on a 401', async () => {
    let issued = 0;
    let first = true;
    const h = harness(({ url }) => {
      if (url === GOOGLE_TOKEN_URL) return tokenReply(`tok-${++issued}`);
      if (first) {
        first = false;
        return json(401, {});
      }
      return json(200, {});
    });
    await expect(listResponsesSince(FORM, null, ACCOUNT, h.deps, new ReadBudget(10))).rejects.toMatchObject({
      code: 'auth',
    });
    await listResponsesSince(FORM, null, ACCOUNT, h.deps, new ReadBudget(10));
    expect(issued).toBe(2);
  });

  it('stops at the read budget', async () => {
    const h = harness(({ url }) =>
      url === GOOGLE_TOKEN_URL ? tokenReply() : json(200, { responses: [], nextPageToken: 'more' }),
    );
    const budget = new ReadBudget(3);
    await expect(listResponsesSince(FORM, null, ACCOUNT, h.deps, budget)).rejects.toMatchObject({
      name: 'BudgetExhausted',
    });
    expect(budget.used).toBe(3);
  });
});
