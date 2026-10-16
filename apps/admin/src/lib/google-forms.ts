import { createSign } from 'node:crypto';

// THE GOOGLE FORMS API, READ ONLY, AS ONE SERVICE ACCOUNT (00287).
//
// The console reads the club's sign-up forms itself: one Google Cloud service
// account, every form in one Drive folder shared with that account's email.
// Its key JSON sits in GOOGLE_FORMS_SERVICE_ACCOUNT_JSON, read here and only
// here, server side. Unset, nothing in this file calls Google.
//
// Auth is the service account flow by hand rather than the googleapis package
// (tens of megabytes for two GET calls): an RS256 JWT signed with node:crypto,
// exchanged at Google's token endpoint for a one-hour access token, cached
// until a minute before it expires.
//
// NOTHING HERE IS LOGGED OR PUT IN AN ERROR MESSAGE that could carry the key,
// a token, an answer or an email. JSON.parse errors quote their input in
// current V8, so a parse failure of the key becomes a fixed string.

export const GOOGLE_FORMS_SECRET_ENV = 'GOOGLE_FORMS_SERVICE_ACCOUNT_JSON';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_FORMS_API = 'https://forms.googleapis.com/v1';
export const GOOGLE_FORMS_SCOPES = [
  'https://www.googleapis.com/auth/forms.body.readonly',
  'https://www.googleapis.com/auth/forms.responses.readonly',
] as const;

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | null;
}

export type ReaderState =
  | { state: 'not_configured' }
  | { state: 'invalid' }
  | { state: 'ready'; account: ServiceAccount };

/**
 * The service account, from the environment. `invalid` covers every way the
 * value can be wrong without saying which, so no part of it reaches a page.
 */
export function readServiceAccount(env: Record<string, string | undefined> = process.env): ReaderState {
  const raw = env[GOOGLE_FORMS_SECRET_ENV];
  if (!raw || raw.trim() === '') return { state: 'not_configured' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object') return { state: 'invalid' };
  const key = parsed as Record<string, unknown>;
  const clientEmail = typeof key.client_email === 'string' ? key.client_email.trim() : '';
  let privateKey = typeof key.private_key === 'string' ? key.private_key : '';
  // A key pasted through a dashboard can arrive with its newlines as the two
  // characters backslash and n.
  if (!privateKey.includes('\n') && privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');
  if (
    (key.type !== undefined && key.type !== 'service_account') ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clientEmail) ||
    !privateKey.includes('PRIVATE KEY')
  ) {
    return { state: 'invalid' };
  }
  return {
    state: 'ready',
    account: {
      clientEmail,
      privateKey,
      privateKeyId: typeof key.private_key_id === 'string' ? key.private_key_id : null,
    },
  };
}

/** What a page may show about the reader: never the key, at most the email to share the folder with. */
export function readerStatus(
  env: Record<string, string | undefined> = process.env,
): { state: 'not_configured' } | { state: 'invalid' } | { state: 'ready'; clientEmail: string } {
  const reader = readServiceAccount(env);
  return reader.state === 'ready' ? { state: 'ready', clientEmail: reader.account.clientEmail } : reader;
}

/**
 * A Google refusal or failure, as a short code the card turns into words.
 * The codes are the poll_error vocabulary of 00287 (lowercase, underscores).
 */
export type GoogleErrorCode =
  | 'auth'
  | 'forbidden'
  | 'form_not_found'
  | 'rate_limited'
  | 'google_unavailable'
  | 'google_refused';

export class GoogleFormsError extends Error {
  constructor(
    readonly code: GoogleErrorCode,
    readonly httpStatus: number | null,
  ) {
    // The status only: a Google error body can echo what was asked for.
    super(`Google Forms API: ${code}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`);
    this.name = 'GoogleFormsError';
  }
}

function codeFor(status: number): GoogleErrorCode {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'form_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'google_unavailable';
  return 'google_refused';
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** The signed assertion for the token endpoint. Exported for the test. */
export function signAssertion(account: ServiceAccount, nowSeconds: number): string {
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (account.privateKeyId) header.kid = account.privateKeyId;
  const claims = {
    iss: account.clientEmail,
    scope: GOOGLE_FORMS_SCOPES.join(' '),
    aud: GOOGLE_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  let signature: Buffer;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(account.privateKey);
  } catch {
    // A malformed PEM: say so without quoting it.
    throw new GoogleFormsError('auth', null);
  }
  return `${unsigned}.${base64url(signature)}`;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleDeps {
  fetch: Fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultGoogleDeps: GoogleDeps = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// One cached token per process, per key. A console replica holds its own.
let cachedToken: { forKey: string; token: string; expiresAt: number } | null = null;

/** Test hook: forget the cached token. */
export function resetGoogleTokenCache(): void {
  cachedToken = null;
}

function cacheKeyFor(account: ServiceAccount): string {
  return `${account.clientEmail}|${account.privateKeyId ?? ''}`;
}

/** An access token, from the cache while it has more than a minute left. */
export async function accessToken(account: ServiceAccount, deps: GoogleDeps): Promise<string> {
  const now = deps.now();
  const forKey = cacheKeyFor(account);
  if (cachedToken && cachedToken.forKey === forKey && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.token;
  }
  const assertion = signAssertion(account, Math.floor(now / 1000));
  let response: Response;
  try {
    response = await deps.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
  } catch {
    throw new GoogleFormsError('google_unavailable', null);
  }
  if (!response.ok) {
    // 400 invalid_grant is a bad, revoked or disabled key: auth, like a 401.
    throw new GoogleFormsError(response.status === 400 || response.status === 401 ? 'auth' : codeFor(response.status), response.status);
  }
  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new GoogleFormsError('google_unavailable', response.status);
  }
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new GoogleFormsError('auth', response.status);
  }
  const lifetime = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  cachedToken = { forKey, token: body.access_token, expiresAt: now + lifetime * 1000 };
  return body.access_token;
}

/** Counts every request made to Google in a round, and stops the round at its budget. */
export class ReadBudget {
  used = 0;
  constructor(readonly limit: number) {}
  get exhausted(): boolean {
    return this.used >= this.limit;
  }
  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }
}

export class BudgetExhausted extends Error {
  constructor() {
    super('Google read budget for this round is spent');
    this.name = 'BudgetExhausted';
  }
}

const MAX_429_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;

/**
 * One GET against the Forms API. A 429 is retried twice, after Retry-After
 * (capped) or a doubling wait, each retry counted against the budget; after
 * that it is a rate_limited error and the caller stops the round. A 401
 * drops the cached token so the next round signs a new one.
 */
async function getJson(
  url: string,
  account: ServiceAccount,
  deps: GoogleDeps,
  budget: ReadBudget,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    if (!budget.take()) throw new BudgetExhausted();
    const token = await accessToken(account, deps);
    let response: Response;
    try {
      response = await deps.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      throw new GoogleFormsError('google_unavailable', null);
    }
    if (response.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await deps.sleep(Math.min(wait, MAX_RETRY_WAIT_MS));
      continue;
    }
    if (!response.ok) {
      if (response.status === 401) resetGoogleTokenCache();
      throw new GoogleFormsError(codeFor(response.status), response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new GoogleFormsError('google_unavailable', response.status);
    }
  }
}

/** A question's id and the title of the item it belongs to, in form order. */
export interface FormQuestion {
  questionId: string;
  title: string;
}

/** forms.get, reduced to what the mapping needs: question ids to item titles. */
export async function getFormQuestions(
  formId: string,
  account: ServiceAccount,
  deps: GoogleDeps,
  budget: ReadBudget,
): Promise<FormQuestion[]> {
  const form = (await getJson(`${GOOGLE_FORMS_API}/forms/${encodeURIComponent(formId)}`, account, deps, budget)) as {
    items?: Array<{ title?: string; questionItem?: { question?: { questionId?: string } } }>;
  };
  const questions: FormQuestion[] = [];
  for (const item of form.items ?? []) {
    const questionId = item.questionItem?.question?.questionId;
    // Grids (questionGroupItem) and page breaks carry no single answer the
    // script maps by title, so they are left out here as well.
    if (typeof questionId === 'string' && typeof item.title === 'string') {
      questions.push({ questionId, title: item.title });
    }
  }
  return questions;
}

/** One response, reduced to its id, its time and its text answers by question id. */
export interface FormResponse {
  responseId: string;
  lastSubmittedTime: string;
  answers: Record<string, string[]>;
}

const RESPONSES_PAGE_SIZE = 500;

/** RFC 3339 at whole seconds, the form the responses filter documents. */
export function filterTimestamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * forms.responses.list from `since` (inclusive), every page. The filter is
 * on the response's last submit time, so an edited response comes back too.
 */
export async function listResponsesSince(
  formId: string,
  since: Date | null,
  account: ServiceAccount,
  deps: GoogleDeps,
  budget: ReadBudget,
): Promise<FormResponse[]> {
  const out: FormResponse[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: String(RESPONSES_PAGE_SIZE) });
    if (since) params.set('filter', `timestamp >= ${filterTimestamp(since)}`);
    if (pageToken) params.set('pageToken', pageToken);
    const page = (await getJson(
      `${GOOGLE_FORMS_API}/forms/${encodeURIComponent(formId)}/responses?${params.toString()}`,
      account,
      deps,
      budget,
    )) as {
      responses?: Array<{
        responseId?: string;
        lastSubmittedTime?: string;
        createTime?: string;
        answers?: Record<string, { questionId?: string; textAnswers?: { answers?: Array<{ value?: string }> } }>;
      }>;
      nextPageToken?: string;
    };
    for (const response of page.responses ?? []) {
      const submitted = response.lastSubmittedTime ?? response.createTime;
      if (typeof response.responseId !== 'string' || typeof submitted !== 'string') continue;
      const answers: Record<string, string[]> = {};
      for (const [questionId, answer] of Object.entries(response.answers ?? {})) {
        const values = (answer.textAnswers?.answers ?? [])
          .map((a) => a.value)
          .filter((v): v is string => typeof v === 'string');
        if (values.length > 0) answers[answer.questionId ?? questionId] = values;
      }
      out.push({ responseId: response.responseId, lastSubmittedTime: submitted, answers });
    }
    pageToken = typeof page.nextPageToken === 'string' && page.nextPageToken !== '' ? page.nextPageToken : undefined;
  } while (pageToken);
  return out;
}
