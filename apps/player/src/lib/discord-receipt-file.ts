// THE SCREENSHOT BEHIND DISCORD /receipt, fetched by the app itself.
//
// The bot hands over the attachment's url, not its bytes: an 8 MB body from
// the bot would cross the public edge, which has its own body limits, while a
// url is a few hundred bytes. So the app downloads it, and that makes this an
// outbound GET to an address another process supplied. Hence:
//
//   ONLY DISCORD'S CDN, over https, with redirects refused. Anything holding
//   the service secret could otherwise point the app at an internal address
//   and have the reply stored as a "receipt": an SSRF with a readback channel.
//
//   THE WEBSITE'S LIMITS (00248's bucket, the Membership form): JPEG, PNG or
//   WebP, at most 8 MiB. The size is refused early on content-length when it
//   is sent, and the body is read with a running cap either way, because the
//   header is advisory and absent on a chunked reply.
//
//   THE TYPE IS READ FROM THE BYTES. Not Discord's content_type, not the
//   response header, not the filename: the stored object's type and extension
//   come from the file's own signature, so a renamed file is refused here
//   rather than stored as something it is not.

export const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;

const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

const FETCH_TIMEOUT_MS = 10_000;

export type ReceiptImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export const RECEIPT_EXTENSIONS: Record<ReceiptImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type ReceiptFileFailure = 'bad_url' | 'unreachable' | 'too_large' | 'not_image';

/** A Discord CDN url, or null. Never fetches. */
export function discordCdnUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !DISCORD_CDN_HOSTS.has(parsed.hostname)) return null;
  // A port or credentials are never part of a real attachment url.
  if (parsed.port || parsed.username || parsed.password) return null;
  return parsed;
}

/** The image type from the file's own first bytes, or null. */
export function sniffReceiptImage(bytes: Uint8Array): ReceiptImageType | null {
  const startsWith = (signature: number[], offset = 0) =>
    bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // RIFF....WEBP
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** The body, or null once it passes `limit` bytes. Stops reading at the cap. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.byteLength > limit ? null : whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * Download a receipt screenshot from Discord's CDN. Never throws: every
 * failure is a code the route turns into a refusal.
 */
export async function downloadDiscordReceipt(
  raw: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; bytes: Uint8Array; contentType: ReceiptImageType; extension: string }
  | { ok: false; failure: ReceiptFileFailure }
> {
  const url = discordCdnUrl(raw);
  if (!url) return { ok: false, failure: 'bad_url' };

  try {
    const response = await fetchImpl(url.toString(), {
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, failure: 'unreachable' };

    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > RECEIPT_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, failure: 'too_large' };
    }

    const bytes = await readCapped(response, RECEIPT_MAX_BYTES);
    if (!bytes) return { ok: false, failure: 'too_large' };
    const contentType = sniffReceiptImage(bytes);
    if (!contentType) return { ok: false, failure: 'not_image' };
    return { ok: true, bytes, contentType, extension: RECEIPT_EXTENSIONS[contentType] };
  } catch (err) {
    console.error('[discord] receipt download failed:', err);
    return { ok: false, failure: 'unreachable' };
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FEE_CHOICE = new RegExp(`^(fee|dues):(${UUID})$`, 'i');

/**
 * The /receipt picker's value: `fee:<club_fees.id>` or `dues:<season id>`.
 * Hostile input (an autocomplete value can be typed), so anything else is null.
 */
export function parseFeeChoice(raw: string): { feeId: string | null; duesSeasonId: string | null } | null {
  const match = FEE_CHOICE.exec(raw);
  if (!match) return null;
  const id = (match[2] ?? '').toLowerCase();
  return match[1]?.toLowerCase() === 'fee' ? { feeId: id, duesSeasonId: null } : { feeId: null, duesSeasonId: id };
}
