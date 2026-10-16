import { describe, it, expect, vi, beforeEach } from 'vitest';

// Discord /receipt and its picker.
//
// The receipt rules are fee-submission-core's (tested in
// lib/__tests__/fee-submission-core.test.ts), the download is
// discord-receipt-file's, and the caller checks are discord-member's. What this
// file pins is the route's own half: the caller is the resolved Discord id and
// never a body field, the gates are the web action's (fees switch, no waiver),
// every refusal that needs no file comes BEFORE the download, the file lands in
// the member's own auth folder typed by its bytes, a failed filing removes it,
// and nothing about the receipt comes back.

const USER_ID = '00000000-0000-4000-8000-00000000a0a0';
const PLAYER = {
  id: 'player-me',
  user_id: USER_ID,
  full_name: 'Me Myself',
  status: 'competitive',
  is_banned: false,
  active_flag: true,
  is_exec: false,
  fee_exempt: false,
};
const FEE_ID = '00000000-0000-4000-8000-0000000000f1';
const SEASON_ID = '00000000-0000-4000-8000-0000000000a1';
const CDN = 'https://cdn.discordapp.com/attachments/1/2/receipt.png?ex=1';

type Caller = { ok: true; player: Record<string, unknown> } | { ok: false; refusal: string };
let caller: Caller;
let member: Caller;
let checkError: Error | null;
let fileError: Error | null;
let download: { ok: true; bytes: Uint8Array; contentType: string; extension: string } | { ok: false; failure: string };
let uploadError: { message: string } | null;
let feeRows: unknown[];
let feeReadError: { message: string } | null;
let seasonRows: unknown[];
let eventRows: { id: string; title: string }[];
let etransferEmail: string | null;

const resolveDiscordPlayer = vi.fn(async (_client: unknown, _id: string, _checks?: unknown) => caller);
const checkFeeSubmission = vi.fn(async (..._args: unknown[]) => {
  if (checkError) throw checkError;
  return {};
});
const fileFeeSubmission = vi.fn(async (..._args: unknown[]) => {
  if (fileError) throw fileError;
});
const downloadDiscordReceipt = vi.fn(async (_url: unknown) => download);
const upload = vi.fn(async (_path: string, _bytes: Uint8Array, _options: unknown) => ({ error: uploadError }));
const remove = vi.fn(async (_paths: string[]) => ({ error: null }));
const feeQuery: Record<string, unknown> = {};

vi.mock('@/lib/discord-member', () => ({
  resolveDiscordPlayer: (client: unknown, id: string, checks?: unknown) => resolveDiscordPlayer(client, id, checks),
  resolveDiscordMember: vi.fn(async () => member),
}));
vi.mock('@/lib/fee-submission-core', () => ({
  checkFeeSubmission: (...args: unknown[]) => checkFeeSubmission(...args),
  fileFeeSubmission: (...args: unknown[]) => fileFeeSubmission(...args),
}));
vi.mock('@/lib/discord-receipt-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discord-receipt-file')>()),
  downloadDiscordReceipt: (url: unknown) => downloadDiscordReceipt(url),
}));
vi.mock('@/lib/club-socials', () => ({ getMembershipPayments: vi.fn(async () => ({ etransferEmail })) }));
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
  getActiveSeason: vi.fn(),
  createServiceRoleClient: () => ({
    storage: { from: () => ({ upload, remove }) },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          if (table === 'club_fees') feeQuery[column] = value;
          return chain;
        },
        in: (column: string, value: unknown) => {
          if (table === 'club_events') {
            const ids = value as string[];
            return Promise.resolve({ data: eventRows.filter((row) => ids.includes(row.id)), error: null });
          }
          feeQuery[`in:${column}`] = value;
          return chain;
        },
        is: (column: string) => {
          feeQuery[`is:${column}`] = true;
          return chain;
        },
        maybeSingle: () => Promise.resolve({ data: seasonRows[0] ?? null, error: null }),
        order: () => Promise.resolve({ data: feeReadError ? null : feeRows, error: feeReadError }),
      };
      return chain;
    },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const { ExpectedError } = await import('@badminton/shared');
const { POST, GET } = await import('../route');

let discordId = 100000;
function nextDiscordId() {
  discordId += 1;
  return String(discordId);
}

function post(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/receipts', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(callerId: string | null, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/receipts', {
    headers: { authorization: auth, ...(callerId ? { 'x-discord-user-id': callerId } : {}) },
  });
}

const body = (over: Record<string, unknown> = {}) => ({
  discordUserId: nextDiscordId(),
  fee: `fee:${FEE_ID}`,
  reference: 'CAabc123',
  attachmentUrl: CDN,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  caller = { ok: true, player: PLAYER };
  member = { ok: true, player: PLAYER };
  checkError = null;
  fileError = null;
  download = { ok: true, bytes: new Uint8Array([0xff, 0xd8, 0xff]), contentType: 'image/jpeg', extension: 'jpg' };
  uploadError = null;
  feeRows = [];
  feeReadError = null;
  seasonRows = [{ id: SEASON_ID, name: 'Fall 2026', competitive_fee_cents: 4000, recreational_fee_cents: 2500 }];
  etransferEmail = 'pay@example.org';
  eventRows = [{ id: 'event-1', title: 'Bowling night' }];
  for (const key of Object.keys(feeQuery)) delete feeQuery[key];
});

describe('POST /api/discord/receipts', () => {
  it('refuses a request without the service secret', async () => {
    const response = await POST(post(body(), 'Bearer wrong'));
    expect(response.status).toBe(401);
    expect(resolveDiscordPlayer).not.toHaveBeenCalled();
  });

  it('answers 400 for a missing or malformed caller id', async () => {
    for (const discordUserId of ['', 'abc', '12', 42]) {
      expect((await POST(post(body({ discordUserId })))).status).toBe(400);
    }
    expect(resolveDiscordPlayer).not.toHaveBeenCalled();
  });

  it('runs the web action gates: the fees switch, and no waiver', async () => {
    const request = body();
    await POST(post(request));
    expect(resolveDiscordPlayer).toHaveBeenCalledWith(expect.anything(), request.discordUserId, {
      feature: 'fees',
      waiver: false,
    });
  });

  it('passes the caller refusal through, not_linked included, and downloads nothing', async () => {
    for (const refusal of ['not_linked', 'standing', 'lapsed', 'feature_off']) {
      caller = { ok: false, refusal };
      const response = await POST(post(body()));
      expect(await response.json()).toEqual({ ok: false, refusal });
    }
    expect(downloadDiscordReceipt).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('answers 503, not "link your account", when the link read fails', async () => {
    caller = { ok: false, refusal: 'unavailable' };
    expect((await POST(post(body()))).status).toBe(503);
  });

  it('refuses a member with no website login, since there is no folder to store in', async () => {
    caller = { ok: true, player: { ...PLAYER, user_id: null } };
    expect(await (await POST(post(body()))).json()).toEqual({ ok: false, refusal: 'no_login' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses a fee value the picker would not write', async () => {
    for (const fee of ['', FEE_ID, `tournament:${FEE_ID}`, 'fee:../x']) {
      const response = await POST(post(body({ fee })));
      expect(await response.json()).toMatchObject({ ok: false, refusal: 'invalid' });
    }
    expect(checkFeeSubmission).not.toHaveBeenCalled();
  });

  it('checks the rules BEFORE the download, with dues and events only and no guessed method', async () => {
    checkError = new ExpectedError('You already have a submission waiting for this fee.');
    const response = await POST(post(body({ fee: `dues:${SEASON_ID}` })));
    expect(await response.json()).toEqual({
      ok: false,
      refusal: 'rule',
      message: 'You already have a submission waiting for this fee.',
    });
    expect(checkFeeSubmission.mock.calls[0]?.[2]).toEqual({
      feeId: null,
      duesSeasonId: SEASON_ID,
      reference: 'CAabc123',
      detectedMethod: null,
    });
    expect(checkFeeSubmission.mock.calls[0]?.[3]).toEqual({ feeTypes: ['dues', 'event'] });
    expect(downloadDiscordReceipt).not.toHaveBeenCalled();
  });

  it('acts as the resolved caller, ignoring any player named in the body', async () => {
    await POST(post(body({ playerId: 'someone-else', player_id: 'someone-else', userId: 'x' })));
    expect((checkFeeSubmission.mock.calls[0]?.[1] as { id: string }).id).toBe(PLAYER.id);
    expect((fileFeeSubmission.mock.calls[0]?.[1] as { id: string }).id).toBe(PLAYER.id);
  });

  it('passes a file refusal through and stores nothing', async () => {
    download = { ok: false, failure: 'not_image' };
    const response = await POST(post(body()));
    expect(await response.json()).toEqual({ ok: false, refusal: 'file', file: 'not_image' });
    expect(upload).not.toHaveBeenCalled();
    expect(fileFeeSubmission).not.toHaveBeenCalled();
  });

  it('downloads only the url from the body, and stores under the auth folder typed by the bytes', async () => {
    const response = await POST(post(body()));
    expect(await response.json()).toEqual({ ok: true });
    expect(downloadDiscordReceipt).toHaveBeenCalledWith(CDN);

    const [path, , options] = upload.mock.calls[0]!;
    expect(path).toMatch(new RegExp(`^${USER_ID}/[0-9a-f-]{36}\\.jpg$`));
    expect(options).toEqual({ contentType: 'image/jpeg', upsert: false });
    const filed = fileFeeSubmission.mock.calls[0]?.[2] as { screenshotPath: string; feeId: string };
    expect(filed).toMatchObject({ screenshotPath: path, feeId: FEE_ID, detectedMethod: null });
  });

  it('removes the upload when filing is refused, and answers the refusal', async () => {
    fileError = new ExpectedError('You already have a submission waiting for this fee.');
    const response = await POST(post(body()));
    expect(await response.json()).toMatchObject({ ok: false, refusal: 'rule' });
    expect(remove).toHaveBeenCalledWith([upload.mock.calls[0]![0]]);
  });

  it('removes the upload and answers 503 when filing fails for another reason', async () => {
    fileError = new Error('The receipt was not saved: boom');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await POST(post(body()));
    expect(response.status).toBe(503);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('answers 503 when the screenshot cannot be stored, and files nothing', async () => {
    uploadError = { message: 'mime type not allowed' };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await POST(post(body()))).status).toBe(503);
    expect(fileFeeSubmission).not.toHaveBeenCalled();
  });

  it('rate limits per Discord member, not per bot', async () => {
    const busy = nextDiscordId();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await POST(post(body({ discordUserId: busy })))).status).toBe(200);
    }
    expect((await POST(post(body({ discordUserId: busy })))).status).toBe(429);
    expect((await POST(post(body()))).status).toBe(200);
  });

  it('counts only attempts that reach the download, so refusals spend nothing', async () => {
    const careful = nextDiscordId();
    checkError = new ExpectedError('The reference is 6 to 32 letters, digits or hyphens, with no spaces');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await (await POST(post(body({ discordUserId: careful })))).json()).toMatchObject({ refusal: 'rule' });
    }
    checkError = null;
    expect((await POST(post(body({ discordUserId: careful })))).status).toBe(200);
  });
});

describe('GET /api/discord/receipts', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    id: FEE_ID,
    fee_type: 'event',
    season_id: null,
    club_event_id: 'event-1',
    amount_cents: 1500,
    paid_at: null,
    fee_submissions: [],
    ...over,
  });

  it('refuses a request without the service secret', async () => {
    expect((await GET(get('111111', 'Bearer wrong'))).status).toBe(401);
  });

  it('answers an empty list to an unlinked or missing caller', async () => {
    expect(await (await GET(get(null))).json()).toEqual({ fees: [] });
    member = { ok: false, refusal: 'not_linked' };
    expect(await (await GET(get('111111'))).json()).toEqual({ fees: [] });
  });

  it('lists this season dues with no row yet, and unpaid club events, for the caller only', async () => {
    feeRows = [event()];
    const response = await GET(get('111111'));
    const { fees } = (await response.json()) as { fees: { id: string; label: string }[] };
    expect(fees.map((fee) => fee.id)).toEqual([`dues:${SEASON_ID}`, `fee:${FEE_ID}`]);
    expect(fees[0]?.label).toContain('Fall 2026 membership');
    expect(fees[1]?.label).toContain('Bowling night');
    expect(feeQuery.player_id).toBe(PLAYER.id);
    expect(feeQuery['in:fee_type']).toEqual(['dues', 'event']);
  });

  it('reads paid rows too, and offers no dues once this season is paid, nor a paid event', async () => {
    feeRows = [
      event({ id: 'dues-row', fee_type: 'dues', season_id: SEASON_ID, club_event_id: null, amount_cents: 4000, paid_at: '2026-09-10' }),
      event({ paid_at: '2026-09-11' }),
    ];
    expect(await (await GET(get('111111'))).json()).toEqual({ fees: [] });
    expect(feeQuery['is:paid_at']).toBeUndefined();
  });

  it('labels an event whose name cannot be read generically rather than hiding it', async () => {
    eventRows = [];
    feeRows = [event()];
    seasonRows = [];
    const { fees } = (await (await GET(get('111111'))).json()) as { fees: { id: string; label: string }[] };
    expect(fees).toEqual([{ id: `fee:${FEE_ID}`, label: 'Club event - $15.00' }]);
  });

  it('uses the dues row when there is one, and skips a line with a receipt waiting', async () => {
    feeRows = [
      event({ id: 'dues-row', fee_type: 'dues', season_id: SEASON_ID, club_event_id: null, amount_cents: 4000 }),
      event({ fee_submissions: [{ id: 's1', status: 'submitted', reference: 'x', reject_reason: null, submitted_at: '2026-10-01' }] }),
    ];
    const { fees } = (await (await GET(get('111111'))).json()) as { fees: { id: string }[] };
    expect(fees.map((fee) => fee.id)).toEqual(['fee:dues-row']);
  });

  it('offers no dues to an exec or exempt member, and no events without an e-transfer address', async () => {
    member = { ok: true, player: { ...PLAYER, fee_exempt: true } };
    feeRows = [event()];
    etransferEmail = null;
    expect(await (await GET(get('111111'))).json()).toEqual({ fees: [] });
  });

  it('skips an unpriced event fee', async () => {
    seasonRows = [];
    feeRows = [event({ amount_cents: null })];
    expect(await (await GET(get('111111'))).json()).toEqual({ fees: [] });
  });

  it('answers 503 when the fee read fails', async () => {
    feeReadError = { message: 'boom' };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await GET(get('111111'))).status).toBe(503);
  });
});
