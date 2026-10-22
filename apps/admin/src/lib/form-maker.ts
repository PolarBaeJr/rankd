import type { Fetch } from './google-forms';

// THE FORM MAKER, AS THE CONSOLE CALLS IT (00296).
//
// An Apps Script web app the owner deploys once under the club's Google
// account (integrations/google-forms/form-maker.gs). It copies a template
// Form, writes what lib/managed-form-content.ts computes, and answers JSON.
// The console holds its /exec address and a shared secret, read here and only
// here, server side. Unset, nothing in this file calls Google.
//
// The script answers every outcome with HTTP 200 and {ok, code}: Apps Script
// cannot set a status. Google answers the POST with a redirect to the output,
// which fetch follows.
//
// NOTHING HERE IS LOGGED OR PUT IN AN ERROR MESSAGE that could carry the
// secret or the script's body: a failure is a short code.

export const FORM_MAKER_URL_ENV = 'GOOGLE_FORM_MAKER_URL';
export const FORM_MAKER_SECRET_ENV = 'GOOGLE_FORM_MAKER_SECRET';
export const FORM_MAKER_TIMEOUT_MS = 60_000;

export interface FormMaker {
  url: string;
  secret: string;
}

export type FormMakerState = { state: 'not_configured' } | { state: 'invalid' } | { state: 'ready'; maker: FormMaker };

/** The maker's address and secret, from the environment. `invalid` says nothing about which is wrong. */
export function readFormMaker(env: Record<string, string | undefined> = process.env): FormMakerState {
  const url = env[FORM_MAKER_URL_ENV]?.trim() ?? '';
  const secret = env[FORM_MAKER_SECRET_ENV]?.trim() ?? '';
  if (url === '' && secret === '') return { state: 'not_configured' };
  if (!url.startsWith('https://script.google.com/macros/s/') || !url.endsWith('/exec') || secret.length < 32) {
    return { state: 'invalid' };
  }
  return { state: 'ready', maker: { url, secret } };
}

export type FormMakerCode =
  | 'unauthorized'
  | 'bad_request'
  | 'template_missing'
  | 'folder_missing'
  | 'form_unknown'
  | 'payment_section_missing'
  | 'question_missing'
  | 'google_refused'
  | 'unreachable'
  | 'timeout'
  | 'bad_response';

const SCRIPT_CODES: ReadonlySet<string> = new Set([
  'unauthorized',
  'bad_request',
  'template_missing',
  'folder_missing',
  'form_unknown',
  'payment_section_missing',
  'question_missing',
  'google_refused',
]);

export class FormMakerError extends Error {
  constructor(readonly code: FormMakerCode) {
    super(`Form maker: ${code}`);
    this.name = 'FormMakerError';
  }
}

export type FormMakerAction = 'create' | 'update' | 'close' | 'open';

export interface CreatedForm {
  formId: string;
  responderUrl: string;
  editUrl: string;
  accepting: boolean;
  waiverVersion: string;
}

// The shapes 00296 holds the stored values to.
const FORM_ID = /^[A-Za-z0-9_-]{1,200}$/;
const RESPONDER_URL = /^https:\/\/docs\.google\.com\/forms\/\S+\/viewform/;
const EDIT_URL = /^https:\/\/docs\.google\.com\/forms\/d\/[A-Za-z0-9_-]+\/edit/;

/** One call to the maker. Resolves with its answer on ok, throws FormMakerError otherwise. */
export async function callFormMaker(
  maker: FormMaker,
  action: FormMakerAction,
  payload: Record<string, unknown>,
  deps: { fetch: Fetch },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await deps.fetch(maker.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, secret: maker.secret, action }),
      redirect: 'follow',
      signal: AbortSignal.timeout(FORM_MAKER_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    throw new FormMakerError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable');
  }
  if (!response.ok) throw new FormMakerError('unreachable');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // An HTML page: the deployment is not "Anyone", or Google's sign-in page.
    throw new FormMakerError('bad_response');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FormMakerError('bad_response');
  const answer = body as Record<string, unknown>;
  if (answer.ok !== true) {
    const code = typeof answer.code === 'string' && SCRIPT_CODES.has(answer.code) ? answer.code : 'bad_response';
    throw new FormMakerError(code as FormMakerCode);
  }
  if (action === 'create') parseCreatedForm(answer);
  return answer;
}

/** The maker's answer to create, refused unless every value has the shape the table holds it to. */
export function parseCreatedForm(answer: Record<string, unknown>): CreatedForm {
  const { formId, responderUrl, editUrl, accepting, waiverVersion } = answer;
  if (
    typeof formId !== 'string' ||
    !FORM_ID.test(formId) ||
    typeof responderUrl !== 'string' ||
    !RESPONDER_URL.test(responderUrl) ||
    typeof editUrl !== 'string' ||
    !EDIT_URL.test(editUrl) ||
    typeof accepting !== 'boolean' ||
    (waiverVersion !== undefined && waiverVersion !== null && typeof waiverVersion !== 'string') ||
    (typeof waiverVersion === 'string' && waiverVersion.trim().length > 40)
  ) {
    throw new FormMakerError('bad_response');
  }
  return {
    formId,
    responderUrl,
    editUrl,
    accepting,
    waiverVersion: typeof waiverVersion === 'string' ? waiverVersion.trim() : '',
  };
}
