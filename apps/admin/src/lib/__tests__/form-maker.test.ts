// The form maker as the console calls it (00296). The script answers every
// outcome with HTTP 200 and {ok, code}, so what matters: an unset or malformed
// address or secret calls nothing; every failure is a short code and never
// the secret; and a create answer is refused unless every value has the shape
// the table holds it to.

import { describe, it, expect, vi } from 'vitest';
import { callFormMaker, FormMakerError, parseCreatedForm, readFormMaker } from '../form-maker';

const URL_OK = 'https://script.google.com/macros/s/abc_DEF-123/exec';
const SECRET = 's'.repeat(48);
const MAKER = { url: URL_OK, secret: SECRET };

const CREATED = {
  ok: true,
  formId: 'form_1',
  responderUrl: 'https://docs.google.com/forms/d/e/abc/viewform',
  editUrl: 'https://docs.google.com/forms/d/form_1/edit',
  accepting: true,
  waiverVersion: '2026-09',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FormMakerError);
    expect(String((err as Error).message)).not.toContain(SECRET);
    return (err as FormMakerError).code;
  }
  throw new Error('expected a FormMakerError');
}

describe('readFormMaker', () => {
  it('is not configured with neither value set', () => {
    expect(readFormMaker({})).toEqual({ state: 'not_configured' });
    expect(readFormMaker({ GOOGLE_FORM_MAKER_URL: ' ', GOOGLE_FORM_MAKER_SECRET: '' })).toEqual({
      state: 'not_configured',
    });
  });

  it('is invalid with only one, a foreign address, a non-exec address, or a short secret', () => {
    expect(readFormMaker({ GOOGLE_FORM_MAKER_URL: URL_OK }).state).toBe('invalid');
    expect(readFormMaker({ GOOGLE_FORM_MAKER_SECRET: SECRET }).state).toBe('invalid');
    expect(
      readFormMaker({ GOOGLE_FORM_MAKER_URL: 'https://example.com/macros/s/x/exec', GOOGLE_FORM_MAKER_SECRET: SECRET }).state,
    ).toBe('invalid');
    expect(
      readFormMaker({
        GOOGLE_FORM_MAKER_URL: 'https://script.google.com/macros/s/x/dev',
        GOOGLE_FORM_MAKER_SECRET: SECRET,
      }).state,
    ).toBe('invalid');
    expect(readFormMaker({ GOOGLE_FORM_MAKER_URL: URL_OK, GOOGLE_FORM_MAKER_SECRET: 'short' }).state).toBe('invalid');
  });

  it('is ready with an exec address and a long secret', () => {
    expect(readFormMaker({ GOOGLE_FORM_MAKER_URL: URL_OK, GOOGLE_FORM_MAKER_SECRET: SECRET })).toEqual({
      state: 'ready',
      maker: MAKER,
    });
  });
});

describe('callFormMaker', () => {
  it('posts the payload with the secret and action, and returns the answer', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: true, accepting: false }));
    const answer = await callFormMaker(MAKER, 'close', { formId: 'form_1', closedMessage: 'Closed.' }, { fetch });
    expect(answer).toEqual({ ok: true, accepting: false });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(URL_OK);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('follow');
    expect(JSON.parse(String(init?.body))).toEqual({
      formId: 'form_1',
      closedMessage: 'Closed.',
      secret: SECRET,
      action: 'close',
    });
  });

  it('a payload cannot replace the secret or the action', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: true }));
    await callFormMaker(MAKER, 'open', { formId: 'f', secret: 'mine', action: 'create' }, { fetch });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(body.secret).toBe(SECRET);
    expect(body.action).toBe('open');
  });

  it('turns every failure into a code', async () => {
    const reject = (err: Error) => ({ fetch: vi.fn(async () => Promise.reject(err)) });
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    expect(await codeOf(callFormMaker(MAKER, 'open', {}, reject(timeout)))).toBe('timeout');
    expect(await codeOf(callFormMaker(MAKER, 'open', {}, reject(new TypeError('fetch failed'))))).toBe('unreachable');
    expect(await codeOf(callFormMaker(MAKER, 'open', {}, { fetch: async () => json({}, 500) })))
      .toBe('unreachable');
    expect(
      await codeOf(callFormMaker(MAKER, 'open', {}, { fetch: async () => new Response('<html>Sign in</html>') })),
    ).toBe('bad_response');
    expect(await codeOf(callFormMaker(MAKER, 'open', {}, { fetch: async () => json([1]) }))).toBe('bad_response');
    expect(
      await codeOf(callFormMaker(MAKER, 'open', {}, { fetch: async () => json({ ok: false, code: 'form_unknown' }) })),
    ).toBe('form_unknown');
    // A code the script does not send is not passed through.
    expect(
      await codeOf(callFormMaker(MAKER, 'open', {}, { fetch: async () => json({ ok: false, code: SECRET }) })),
    ).toBe('bad_response');
  });

  it('refuses a create answer the table would not hold', async () => {
    expect(await callFormMaker(MAKER, 'create', {}, { fetch: async () => json(CREATED) })).toEqual(CREATED);
    expect(
      await codeOf(callFormMaker(MAKER, 'create', {}, { fetch: async () => json({ ...CREATED, formId: 'a b' }) })),
    ).toBe('bad_response');
  });
});

describe('parseCreatedForm', () => {
  it('takes a well-formed answer, trimming the waiver version', () => {
    expect(parseCreatedForm({ ...CREATED, waiverVersion: ' 2026-09 ' })).toEqual({
      formId: 'form_1',
      responderUrl: CREATED.responderUrl,
      editUrl: CREATED.editUrl,
      accepting: true,
      waiverVersion: '2026-09',
    });
    expect(parseCreatedForm({ ...CREATED, waiverVersion: undefined }).waiverVersion).toBe('');
  });

  it('refuses links off Google Forms, a missing flag and an overlong version', () => {
    for (const bad of [
      { responderUrl: 'https://example.com/forms/d/e/abc/viewform' },
      { editUrl: 'javascript:alert(1)' },
      { accepting: 'yes' },
      { waiverVersion: 'v'.repeat(41) },
      { waiverVersion: 3 },
    ]) {
      expect(() => parseCreatedForm({ ...CREATED, ...bad })).toThrow(FormMakerError);
    }
  });
});
