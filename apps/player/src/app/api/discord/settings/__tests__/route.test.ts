import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/discord/settings is the only writer discord_settings has.
//
// THE WHITELIST IS THE POINT OF THIS FILE. Six relays read this table to decide
// where they broadcast the club's business, and the table is service-role only
// precisely so nothing member-facing can reach it. An endpoint that upserted
// whatever key arrived would turn "hold the service secret" into "write any
// config those relays trust" — the same shape as a server action exporting a
// parameter no UI passes.
//
// The second thing is null. Every relay reads a missing key as "post nothing",
// so deleting the row is the only way to turn one back off; writing '' instead
// leaves a channel id of '' that two of the routes' `?? null` would not catch.

let settingsRows: { key: string; value: string | null }[] = [];
let readError: { message: string } | null = null;
const upserted = vi.fn();
const deletedIn = vi.fn();

// The caller check has its own tests; here every caller may.
const { checkDiscordManager } = vi.hoisted(() => ({
  checkDiscordManager: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; refusal: string }),
}));
vi.mock('@/lib/discord-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discord-manager')>()),
  checkDiscordManager,
}));

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => Promise.resolve({ data: readError ? null : settingsRows, error: readError }),
      upsert: (rows: unknown) => {
        upserted(rows);
        return Promise.resolve({ error: null });
      },
      delete: () => ({
        in: (column: string, values: unknown) => {
          deletedIn(column, values);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  }),
}));

import { GET, POST } from '../route';

const CHANNEL = '123456789012345678';

function post(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/settings', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    // Every bot write names who ran the command and where (discord-manager.ts).
    body: JSON.stringify(
      body && typeof body === 'object' && !Array.isArray(body)
        ? { discordUserId: '111111111111111111', guildId: '222222222222222222', ...body }
        : body
    ),
  });
}

function get(auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/settings', {
    headers: { authorization: auth },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsRows = [];
  readError = null;
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
});

describe('the whitelist', () => {
  it('refuses a key it does not govern, and writes nothing', async () => {
    const response = await POST(post({ settings: { reminder_secret: 'x' } }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unknown_setting', detail: 'reminder_secret' });
    expect(upserted).not.toHaveBeenCalled();
  });

  it('refuses the whole payload when one key is unknown', async () => {
    // VALIDATED IN FULL BEFORE ANYTHING IS WRITTEN. A loop that wrote as it
    // went would leave the good half applied, and "the announcement channel
    // moved but nothing else did" is a state the error message does not
    // describe and nobody asked for.
    const response = await POST(
      post({ settings: { announcement_channel_id: CHANNEL, nonsense: 'x' } })
    );

    expect(response.status).toBe(400);
    expect(upserted).not.toHaveBeenCalled();
  });

  it('accepts every channel key', async () => {
    const keys = [
      'announcement_channel_id',
      'session_ping_channel_id',
      'match_results_channel_id',
      'feedback_channel_id',
      'event_feedback_channel_id',
      'audit_channel_id',
    ];
    for (const key of keys) {
      const response = await POST(post({ settings: { [key]: CHANNEL } }));
      expect(response.status, key).toBe(200);
    }
    expect(upserted).toHaveBeenCalledTimes(keys.length);
  });
});

describe('validation', () => {
  it('refuses a channel id that is not a snowflake', async () => {
    // Not paranoia about our own bot: the picker is fine, but this route is
    // reachable by anything holding the service secret, and a bad id here is a
    // relay that 400s every five minutes with nobody watching.
    const response = await POST(post({ settings: { announcement_channel_id: '#general' } }));
    expect(response.status).toBe(400);
    expect(upserted).not.toHaveBeenCalled();
  });

  it('no longer writes the club-wide tournament times or location', async () => {
    // Each tournament keeps its own since 00304, and the old keys are only a
    // fallback for a tournament with none set. A bot older than that must not
    // be able to move the fallback for every tournament at once.
    const retired: [string, string][] = [
      ['tournament_event_start_time', '09:00'],
      ['tournament_event_end_time', '18:00'],
      ['tournament_event_location', 'Court 1'],
    ];
    for (const [key, value] of retired) {
      expect((await POST(post({ settings: { [key]: value } }))).status, key).toBe(400);
    }
    expect(upserted).not.toHaveBeenCalled();
  });

  it('holds the ping lead time to something the cron can actually hit', async () => {
    // The floor tracks the schedule, not taste: the ping job runs every five
    // minutes, so a lead time under that is missed as often as it is hit.
    expect((await POST(post({ settings: { session_ping_lead_minutes: '60' } }))).status).toBe(200);
    expect((await POST(post({ settings: { session_ping_lead_minutes: '2' } }))).status).toBe(400);
    expect((await POST(post({ settings: { session_ping_lead_minutes: '90.5' } }))).status).toBe(400);
  });

  it('accepts the three session ping role ids, and only as role ids', async () => {
    // /config ping_roles writes these. Without them in the whitelist the only
    // way to name a ping role was SQL on production.
    for (const key of [
      'session_ping_all_role_id',
      'session_ping_competitive_role_id',
      'session_ping_recreational_role_id',
    ]) {
      expect((await POST(post({ settings: { [key]: '1547801288119558234' } }))).status, key).toBe(200);
      expect((await POST(post({ settings: { [key]: '@session ping' } }))).status, key).toBe(400);
    }
  });
});

describe('clearing a setting', () => {
  it('DELETES the row rather than writing an empty string', async () => {
    // The distinction the relays actually make. `''` is a value: `?? null`
    // hands it straight through, and the relay posts to a channel id of ''.
    const response = await POST(post({ settings: { announcement_channel_id: null } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, written: 0, cleared: 1 });
    expect(deletedIn).toHaveBeenCalledWith('key', ['announcement_channel_id']);
    expect(upserted).not.toHaveBeenCalled();
  });

  it('still refuses to clear a key it does not govern', async () => {
    const response = await POST(post({ settings: { reminder_secret: null } }));
    expect(response.status).toBe(400);
    expect(deletedIn).not.toHaveBeenCalled();
  });

  it('writes and clears in the same call', async () => {
    const response = await POST(
      post({ settings: { announcement_channel_id: CHANNEL, audit_channel_id: null } })
    );

    expect(await response.json()).toEqual({ ok: true, written: 1, cleared: 1 });
    expect(upserted).toHaveBeenCalledWith([{ key: 'announcement_channel_id', value: CHANNEL }]);
    expect(deletedIn).toHaveBeenCalledWith('key', ['audit_channel_id']);
  });
});

describe('GET', () => {
  it('reports only the keys this route governs', async () => {
    // reminder_secret lives in cron_config rather than here, but the principle
    // stands for anything a later migration drops in this table: /config show
    // renders whatever comes back, into a channel.
    settingsRows = [
      { key: 'announcement_channel_id', value: CHANNEL },
      { key: 'something_else', value: 'secret' },
    ];

    const body = await (await GET(get())).json();

    expect(body.settings).toEqual({ announcement_channel_id: CHANNEL });
  });

  it('says a failed read failed rather than answering "nothing is configured"', async () => {
    // A failed PostgREST read arrives as data:null with an error, never a
    // throw. Degrading it to {} would tell the club every relay is unset —
    // which is the exact screen they are running this command to look at.
    readError = { message: 'permission denied' };

    const response = await GET(get());

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('settings_unavailable');
  });
});

describe('the service gate', () => {
  it('refuses an unauthenticated write', async () => {
    const response = await POST(post({ settings: { announcement_channel_id: CHANNEL } }, 'Bearer wrong'));
    expect(response.status).toBe(401);
    expect(upserted).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated read', async () => {
    expect((await GET(get('Bearer wrong'))).status).toBe(401);
  });
});

describe('the caller check', () => {
  it('refuses a caller the club does not allow, and writes nothing', async () => {
    checkDiscordManager.mockResolvedValueOnce({ ok: false, refusal: 'not_permitted' });
    const response = await POST(post({ settings: { announcement_channel_id: '333333333333333333' } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'not_permitted' });
  });
});
