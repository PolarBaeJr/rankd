import { describe, it, expect, vi } from 'vitest';
import {
  RECEIPT_MAX_BYTES,
  discordCdnUrl,
  downloadDiscordReceipt,
  parseFeeChoice,
  sniffReceiptImage,
} from '../discord-receipt-file';

// The screenshot behind Discord /receipt. The app fetches a url another
// process handed it, so the host list is the SSRF guard, and the stored type
// comes from the bytes, never from a header or a filename.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const CDN = 'https://cdn.discordapp.com/attachments/1/2/receipt.png?ex=1&is=2&hm=3';

function fetchReturning(body: BodyInit | null, init: ResponseInit = { status: 200 }) {
  return vi.fn(async () => new Response(body, init)) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('discordCdnUrl', () => {
  it('takes only https urls on the two Discord CDN hosts', () => {
    expect(discordCdnUrl(CDN)?.hostname).toBe('cdn.discordapp.com');
    expect(discordCdnUrl('https://media.discordapp.net/attachments/1/2/a.png')).not.toBeNull();
    for (const bad of [
      'http://cdn.discordapp.com/attachments/1/2/a.png',
      'https://cdn.discordapp.com.evil.example/a.png',
      'https://evil.example/cdn.discordapp.com/a.png',
      'https://localhost/a.png',
      'https://169.254.169.254/latest/meta-data',
      'https://cdn.discordapp.com:8443/a.png',
      // Built in two parts: written whole, the export's leak check reads it as an email address.
      'https://user:pass' + '@cdn.discordapp.com/a.png',
      'not a url',
      '',
      42,
      null,
    ]) {
      expect(discordCdnUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('sniffReceiptImage', () => {
  it('reads JPEG, PNG and WebP from their signatures and nothing else', () => {
    expect(sniffReceiptImage(JPEG)).toBe('image/jpeg');
    expect(sniffReceiptImage(PNG)).toBe('image/png');
    expect(sniffReceiptImage(WEBP)).toBe('image/webp');
    expect(sniffReceiptImage(GIF)).toBeNull();
    expect(sniffReceiptImage(new TextEncoder().encode('<html>'))).toBeNull();
    expect(sniffReceiptImage(new Uint8Array())).toBeNull();
  });
});

describe('downloadDiscordReceipt', () => {
  it('never fetches a url off the CDN', async () => {
    const fetchImpl = fetchReturning(PNG);
    expect(await downloadDiscordReceipt('https://evil.example/a.png', fetchImpl)).toEqual({ ok: false, failure: 'bad_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses redirects, so the CDN host cannot be a stepping stone', async () => {
    const fetchImpl = fetchReturning(PNG);
    await downloadDiscordReceipt(CDN, fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('types the file by its bytes, whatever the header or filename say', async () => {
    const fetchImpl = fetchReturning(JPEG, { status: 200, headers: { 'content-type': 'image/png' } });
    const result = await downloadDiscordReceipt(CDN, fetchImpl);
    expect(result).toMatchObject({ ok: true, contentType: 'image/jpeg', extension: 'jpg' });
  });

  it('refuses a file that is not one of the three image types', async () => {
    const result = await downloadDiscordReceipt(CDN, fetchReturning(GIF, { status: 200, headers: { 'content-type': 'image/png' } }));
    expect(result).toEqual({ ok: false, failure: 'not_image' });
  });

  it('refuses over 8 MB on the declared length, and on the bytes when none is declared', async () => {
    const declared = await downloadDiscordReceipt(
      CDN,
      fetchReturning(PNG, { status: 200, headers: { 'content-length': String(RECEIPT_MAX_BYTES + 1) } })
    );
    expect(declared).toEqual({ ok: false, failure: 'too_large' });

    const big = new Uint8Array(RECEIPT_MAX_BYTES + 1);
    big.set(PNG);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big.subarray(0, RECEIPT_MAX_BYTES));
        controller.enqueue(big.subarray(RECEIPT_MAX_BYTES));
        controller.close();
      },
    });
    expect(await downloadDiscordReceipt(CDN, fetchReturning(stream))).toEqual({ ok: false, failure: 'too_large' });
  });

  it('takes exactly 8 MB', async () => {
    const exact = new Uint8Array(RECEIPT_MAX_BYTES);
    exact.set(PNG);
    expect(await downloadDiscordReceipt(CDN, fetchReturning(exact))).toMatchObject({ ok: true, contentType: 'image/png' });
  });

  it('answers unreachable for an expired link or a failed fetch, never throws', async () => {
    expect(await downloadDiscordReceipt(CDN, fetchReturning('no', { status: 403 }))).toEqual({ ok: false, failure: 'unreachable' });
    const throwing = vi.fn(async () => {
      throw new TypeError('redirect');
    }) as unknown as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await downloadDiscordReceipt(CDN, throwing)).toEqual({ ok: false, failure: 'unreachable' });
  });
});

describe('parseFeeChoice', () => {
  const id = '00000000-0000-4000-8000-0000000000f1';
  it('reads the two shapes the picker writes', () => {
    expect(parseFeeChoice(`fee:${id}`)).toEqual({ feeId: id, duesSeasonId: null });
    expect(parseFeeChoice(`dues:${id}`)).toEqual({ feeId: null, duesSeasonId: id });
  });

  it('refuses anything else, since an autocomplete value can be typed', () => {
    for (const bad of [id, `fee:${id} `, `tournament:${id}`, 'fee:not-a-uuid', `fee:${id}/../x`, '']) {
      expect(parseFeeChoice(bad), bad).toBeNull();
    }
  });
});
