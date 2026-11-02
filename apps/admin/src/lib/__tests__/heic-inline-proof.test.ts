import { afterEach, describe, expect, it, vi } from 'vitest';

// A HEIC or HEIF screenshot is answered by the proof routes as a converted
// JPEG (inlineProof), shown inline, since no desktop browser but Safari renders
// HEIC. The decoder is a fake here and every byte is made up: no receipt image
// is read anywhere in this file.

vi.mock('server-only', () => ({}));
vi.mock('../heic', () => ({
  heicToJpeg: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff])),
  isHeicBytes: vi.fn(() => true),
}));

import { heicToJpeg } from '../heic';
import { inlineProof } from '../fee-submissions';

const STORED = new Uint8Array([1, 2, 3, 4]);

function fakeAdmin() {
  const admin = {
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([STORED]), error: null }),
      }),
    },
  };
  return admin as unknown as Parameters<typeof inlineProof>[0];
}

afterEach(() => vi.restoreAllMocks());

describe('inlineProof', () => {
  it('answers a HEIC as the converted JPEG, inline and never sniffed', async () => {
    const response = await inlineProof(fakeAdmin(), 'forms/b/i/x.heic');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('Content-Disposition')).toBe('inline');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(heicToJpeg).toHaveBeenCalledWith(STORED);
  });

  it('answers a PNG as stored, inline', async () => {
    const response = await inlineProof(fakeAdmin(), 'p/sub-1.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Disposition')).toBe('inline');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(STORED);
  });

  it('answers a PDF as not found', async () => {
    expect((await inlineProof(fakeAdmin(), 'p/sub-1.pdf')).status).toBe(404);
  });

  it('answers a HEIC it cannot convert with a 502, logging neither the path nor the bytes', async () => {
    vi.mocked(heicToJpeg).mockRejectedValueOnce(new TypeError('input buffer is not a HEIC image'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await inlineProof(fakeAdmin(), 'forms/b/i/x.heic');
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Could not open that screenshot');
    expect(logged).toHaveBeenCalledWith('[fees] could not convert a HEIC screenshot:', 'TypeError');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('x.heic');
  });
});

// The real check, which decides whether the server's read converts a
// screenshot first: heic-decode's own major brands, not every ISO box file.
describe('isHeicBytes', () => {
  const header = (brand: string) => new TextEncoder().encode(`\u0000\u0000\u0000\u0018ftyp${brand}\u0000\u0000`);

  it('knows the brands heic-decode decodes', async () => {
    const { isHeicBytes } = await vi.importActual<typeof import('../heic')>('../heic');
    expect(isHeicBytes(header('heic'))).toBe(true);
    expect(isHeicBytes(header('mif1'))).toBe(true);
  });

  it('refuses a brand it does not, and anything that is not ftyp', async () => {
    const { isHeicBytes } = await vi.importActual<typeof import('../heic')>('../heic');
    expect(isHeicBytes(header('heim'))).toBe(false);
    expect(isHeicBytes(header('isom'))).toBe(false);
    expect(isHeicBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(isHeicBytes(new Uint8Array(0))).toBe(false);
  });
});
