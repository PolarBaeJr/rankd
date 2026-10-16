// A form's uploaded receipt on its way into fee-proofs (00288). Google is a
// fake fetch and the database a fake that records every RPC. What matters:
// the type is decided by the file's first bytes, never by what the uploader's
// device said; a file too big or of the wrong type is refused before it is
// downloaded; a refusal about one file settles that file and the rest carry
// on; a refusal about the whole round (the Drive API off, the budget spent)
// releases the receipts it did not reach without using up their attempts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const { sniffReceipt, drainFormReceipts, RECEIPT_MAX_BYTES } = await import('../form-receipts');
const { ReadBudget, resetGoogleTokenCache, GOOGLE_TOKEN_URL } = await import('../google-forms');

const ACCOUNT = {
  clientEmail: 'reader@example.com',
  privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
  privateKeyId: 'kid',
};

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0);

describe('the first bytes decide the type', () => {
  it.each([
    ['JPEG', JPEG, 'jpg', 'image/jpeg'],
    ['PNG', PNG, 'png', 'image/png'],
    ['WebP', text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), 'webp', 'image/webp'],
    ['HEIC', text('\u0000\u0000\u0000\u0018ftypheic\u0000\u0000'), 'heic', 'image/heic'],
    ['HEIF', text('\u0000\u0000\u0000\u0018ftypmif1\u0000\u0000'), 'heif', 'image/heif'],
    ['PDF', text('%PDF-1.7\n'), 'pdf', 'application/pdf'],
  ])('knows a %s', (_name, input, ext, contentType) => {
    expect(sniffReceipt(input)).toEqual({ ext, contentType });
  });

  it.each([
    ['an HTML page', text('<!doctype html><html>')],
    ['an MP4, which is also ftyp', text('\u0000\u0000\u0000\u0018ftypisom\u0000\u0000')],
    ['a GIF', text('GIF89a')],
    ['nothing', new Uint8Array(0)],
    ['a RIFF that is not WebP', text('RIFF\u0000\u0000\u0000\u0000WAVEfmt ')],
  ])('refuses %s', (_name, input) => {
    expect(sniffReceipt(input)).toBeNull();
  });
});

interface Rpc {
  fn: string;
  args: Record<string, unknown>;
}

let rpcs: Rpc[];
let queue: unknown[];
let uploads: string[];
let drive: (url: URL) => Response;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

function admin() {
  return {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === 'claim_registration_import_receipts') return { data: queue, error: null };
      if (fn === 'file_registration_import_receipts') return { data: [], error: null };
      return { data: true, error: null };
    }),
    storage: {
      from: () => ({
        upload: vi.fn(async (path: string) => {
          uploads.push(path);
          return { data: { path }, error: null };
        }),
        remove: vi.fn(async () => ({ data: [], error: null })),
      }),
    },
  } as never;
}

const deps = () => ({
  now: () => 0,
  sleep: vi.fn(async () => undefined),
  fetch: vi.fn(async (url: string) =>
    url === GOOGLE_TOKEN_URL ? json(200, { access_token: 'tok', expires_in: 3600 }) : drive(new URL(url)),
  ),
});

const receipt = (id: string) => ({
  id,
  import_id: '00000000-0000-4000-8000-0000000000a1',
  binding_id: '00000000-0000-4000-8000-0000000000b1',
  drive_file_id: `file-${id}`,
  mime_type: 'image/png',
  attempts: 1,
});

const settled = () =>
  rpcs
    .filter((r) => r.fn === 'settle_registration_import_receipt')
    .map((r) => [r.args.p_receipt_id, r.args.p_status]);

beforeEach(() => {
  resetGoogleTokenCache();
  rpcs = [];
  queue = [];
  uploads = [];
  drive = (url) =>
    url.searchParams.get('alt') === 'media'
      ? new Response(PNG, { status: 200 })
      : json(200, { size: String(PNG.byteLength), mimeType: 'image/png' });
});

describe('bringing receipts in', () => {
  it('refuses a file too big or of the wrong type from its metadata, without downloading it', async () => {
    queue = [receipt('big'), receipt('gif')];
    drive = (url) => {
      if (url.searchParams.get('alt') === 'media') throw new Error('downloaded');
      return url.pathname.endsWith('file-big')
        ? json(200, { size: String(RECEIPT_MAX_BYTES + 1), mimeType: 'image/png' })
        : json(200, { size: '10', mimeType: 'image/gif' });
    };
    const d = deps();
    await drainFormReceipts(admin(), ACCOUNT, d, new ReadBudget(20), { downloads: true, deadline: 1 });
    expect(settled()).toEqual([
      ['big', 'too_large'],
      ['gif', 'bad_type'],
    ]);
    expect(uploads).toEqual([]);
  });

  it('refuses a file whose bytes are not what its type says', async () => {
    queue = [receipt('fake')];
    drive = (url) =>
      url.searchParams.get('alt') === 'media'
        ? new Response(text('<html>'), { status: 200 })
        : json(200, { size: '6', mimeType: 'image/png' });
    await drainFormReceipts(admin(), ACCOUNT, deps(), new ReadBudget(20), { downloads: true, deadline: 1 });
    expect(settled()).toEqual([['fake', 'bad_type']]);
    expect(uploads).toEqual([]);
  });

  it('settles a file Drive will not hand over, and carries on with the next', async () => {
    queue = [receipt('gone'), receipt('fine')];
    drive = (url) => {
      if (url.pathname.endsWith('file-gone')) return json(404, {});
      return url.searchParams.get('alt') === 'media'
        ? new Response(PNG, { status: 200 })
        : json(200, { size: '9', mimeType: 'image/png' });
    };
    await drainFormReceipts(admin(), ACCOUNT, deps(), new ReadBudget(20), { downloads: true, deadline: 1 });
    expect(settled()).toEqual([
      ['gone', 'drive_forbidden'],
      ['fine', 'pending_fee'],
    ]);
    expect(uploads).toHaveLength(1);
  });

  it('releases what the budget cannot reach, as pending_download', async () => {
    queue = [receipt('first'), receipt('second')];
    // Two requests per receipt: the first fits, the second does not.
    const budget = new ReadBudget(3);
    const run = await drainFormReceipts(admin(), ACCOUNT, deps(), budget, { downloads: true, deadline: 1 });
    expect(settled()).toEqual([
      ['first', 'pending_fee'],
      ['second', 'pending_download'],
    ]);
    expect(run).toMatchObject({ downloaded: 1, released: 1, stopped: 'budget' });
  });

  it('claims no more than the budget can download', async () => {
    await drainFormReceipts(admin(), ACCOUNT, deps(), new ReadBudget(7), { downloads: true, deadline: 1 });
    expect(rpcs.find((r) => r.fn === 'claim_registration_import_receipts')?.args).toEqual({ p_limit: 3 });
  });

  it('releases every receipt when the Drive API is off, using none of their attempts', async () => {
    queue = [receipt('a'), receipt('b')];
    drive = () => json(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } });
    const run = await drainFormReceipts(admin(), ACCOUNT, deps(), new ReadBudget(20), { downloads: true, deadline: 1 });
    expect(settled()).toEqual([
      ['a', 'pending_download'],
      ['b', 'pending_download'],
    ]);
    expect(run.stopped).toBe('forbidden');
  });

  it('files every round, even with downloads off', async () => {
    const d = deps();
    await drainFormReceipts(admin(), ACCOUNT, d, new ReadBudget(20), { downloads: false, deadline: 1 });
    expect(rpcs.map((r) => r.fn)).toEqual(['file_registration_import_receipts']);
    expect(d.fetch).not.toHaveBeenCalled();
  });
});
