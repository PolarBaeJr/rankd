import 'server-only';

// A HEIC OR HEIF SCREENSHOT, TURNED INTO A JPEG ON THE SERVER, for the
// server's receipt read (receipt-ocr-server.ts) and the proof routes
// (fee-submissions.ts inlineProof).
//
// sharp's libvips here has no HEVC decoder, so sharp alone refuses a HEIC.
// heic-decode runs libheif as WASM (libheif-js), from node_modules: next.config.js
// keeps both packages external and traces them into the standalone bundle.
// sharp then only encodes the decoded pixels. Nothing is logged here; a
// failure throws and the caller logs it by its kind.

// heic-decode's own list of major brands (its lib.js isHeic), not
// sniffReceipt's: a brand it refuses would only throw later.
const HEIC_DECODE_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'];

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** An ISO box file whose major brand heic-decode decodes. */
export function isHeicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== 'ftyp') return false;
  return HEIC_DECODE_BRANDS.includes(ascii(bytes, 8, 12));
}

/** The first image of a HEIC or HEIF as a JPEG. Throws when it cannot be decoded. */
export async function heicToJpeg(bytes: Uint8Array): Promise<Buffer> {
  const decode = (await import('heic-decode')).default;
  const img = await decode({ buffer: bytes });
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } })
    .jpeg({ quality: 85 })
    .toBuffer();
}
