import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /session: console commands on Discord. The bot only plumbs options into one
// console action as the linked exec; every rule lives in the console. These
// tests stub fetch, so what they pin is the wire: the URL keeps the console's
// path prefix, the body names the caller and the console's own arguments, and
// each kind of answer becomes the right sentence.

import {
  COMMAND_DEFINITIONS,
  CONSOLE_NOT_AVAILABLE,
  CONSOLE_NOT_CONFIGURED,
  CONSOLE_NOT_LINKED,
  CONSOLE_PASSKEY_REQUIRED,
  DEFERRED_COMMANDS,
  SESSION_PICKERS,
  dispatch,
  handleConsoleModal,
  handleSessionAutocomplete,
  isConsoleModal,
  type BotResponse,
} from '../commands.js';
import { adminSend } from '../api.js';

const CALLER = '424242424242';
const CONTEXT = { discordUserId: CALLER, guildId: 'g1' };
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const BASE = 'https://club.example.invalid/console';

const fetchSpy = vi.fn();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sub(name: string, options: { name: string; value: unknown; focused?: boolean }[] = []) {
  return [{ type: 1, name, options }] as never;
}

async function finished(response: BotResponse): Promise<string> {
  expect(response.type).toBe(5);
  expect(response.data).toEqual({ flags: 64 });
  const final = await response.finish!();
  const data = final.data as { content: string; flags: number; allowed_mentions: unknown };
  expect(data.flags).toBe(64);
  expect(data.allowed_mentions).toEqual({ parse: [] });
  return data.content;
}

beforeEach(() => {
  process.env.ADMIN_API_URL = `${BASE}/`;
  process.env.DISCORD_SERVICE_SECRET = 'secret';
  process.env.APP_PUBLIC_URL = 'https://club.example.invalid';
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/session definition', () => {
  const definition = COMMAND_DEFINITIONS.find((c) => c.name === 'session') as {
    default_member_permissions?: string;
    dm_permission?: boolean;
    options: { name: string; options: { name: string; required?: boolean }[] }[];
  };

  it('is hidden from members and guild-only', () => {
    expect(definition.default_member_permissions).toBe('0');
    expect(definition.dm_permission).toBe(false);
  });

  it('puts every required option before the optional ones', () => {
    for (const subcommand of definition.options) {
      const required = subcommand.options.map((o) => o.required === true);
      expect(required, subcommand.name).toEqual([...required].sort((a, b) => Number(b) - Number(a)));
    }
  });

  // archive and delete open a modal, which a deferred interaction cannot.
  it('acknowledges for itself rather than through DEFERRED_COMMANDS', () => {
    expect(DEFERRED_COMMANDS.has('session')).toBe(false);
    expect(SESSION_PICKERS.has('session')).toBe(true);
  });
});

describe('adminSend', () => {
  it('keeps the console path prefix and does not follow redirects', async () => {
    fetchSpy.mockResolvedValue(json({ ok: true, data: null }));
    await adminSend('/api/discord/actions/archiveSession', { discordUserId: CALLER, args: [] });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/discord/actions/archiveSession`);
    expect(init.redirect).toBe('manual');
    expect(init.headers.authorization).toBe('Bearer secret');
  });
});

describe('/session subcommands', () => {
  it('says so when the console is not configured, without a network call', async () => {
    delete process.env.ADMIN_API_URL;
    const response = await dispatch('session', sub('list'), CONTEXT);
    expect((response.data as { content: string }).content).toBe(CONSOLE_NOT_CONFIGURED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates a weekly series with the console action field names', async () => {
    fetchSpy.mockResolvedValue(
      json({ ok: true, data: { count: 2, sessions: [{ id: 'a', date: '2026-10-20' }, { id: 'b', date: '2026-10-27' }] } })
    );
    const response = await dispatch(
      'session',
      sub('create', [
        { name: 'date', value: '2026-10-20' },
        { name: 'start', value: '7:00' },
        { name: 'end', value: '21:00' },
        { name: 'location', value: 'Main gym' },
        { name: 'track', value: 'all' },
        { name: 'repeat_weekly_until', value: '2026-10-27' },
      ]),
      CONTEXT
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await finished(response)).toBe('Created 2 sessions: 2026-10-20, 2026-10-27');
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body).toEqual({
      discordUserId: CALLER,
      args: [
        {
          name: 'Practice Session',
          date: '2026-10-20',
          time: '07:00',
          end_time: '21:00',
          location: 'Main gym',
          track: 'all',
          repeat_until: '2026-10-27',
          repeat_frequency: 'weekly',
        },
      ],
    });
  });

  it('refuses a malformed date before calling the console', async () => {
    const response = await dispatch(
      'session',
      sub('create', [
        { name: 'date', value: '20/10/2026' },
        { name: 'start', value: '19:00' },
        { name: 'end', value: '21:00' },
        { name: 'location', value: 'Gym' },
        { name: 'track', value: 'all' },
      ]),
      CONTEXT
    );
    expect(response.type).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('edits by overlaying only what was typed onto the console input', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        json({
          ok: true,
          data: {
            sessions: [
              {
                id: SESSION_ID,
                label: 'Oct 20, 2026 7:00 PM · Club night · Gym',
                status: 'open',
                track: 'all',
                editInput: { name: 'Club night', date: '2026-10-20', time: '19:00', location: 'Gym', notes: 'Bring water', track: 'all' },
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(json({ ok: true }));
    const response = await dispatch(
      'session',
      sub('edit', [
        { name: 'session', value: SESSION_ID },
        { name: 'reason', value: 'Gym booking moved' },
        { name: 'location', value: 'Gym B' },
      ]),
      CONTEXT
    );
    expect(await finished(response)).toContain('Updated');
    const body = JSON.parse(fetchSpy.mock.calls[1]![1].body);
    expect(body.args).toEqual([
      SESSION_ID,
      { name: 'Club night', date: '2026-10-20', time: '19:00', location: 'Gym B', notes: 'Bring water', track: 'all' },
      'Gym booking moved',
    ]);
  });

  it('renders the refusals', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: false, refusal: 'not_linked' }));
    expect(await finished(await dispatch('session', sub('list'), CONTEXT))).toBe(CONSOLE_NOT_LINKED);

    fetchSpy.mockResolvedValueOnce(json({ ok: false, refusal: 'passkey_required' }));
    expect(await finished(await dispatch('session', sub('list'), CONTEXT))).toBe(CONSOLE_PASSKEY_REQUIRED);

    fetchSpy.mockResolvedValueOnce(
      json({ ok: false, error: 'Your permissions do not include this. Ask an admin.', code: 'AUTH-104', ref: 'abc' })
    );
    expect(await finished(await dispatch('session', sub('list'), CONTEXT))).toBe(
      'Your permissions do not include this. Ask an admin. (AUTH-104.abc)'
    );
  });

  it('never shows an uncoded error, which may be raw database text', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: false, error: 'duplicate key value violates unique constraint "x"' }));
    const text = await finished(await dispatch('session', sub('list'), CONTEXT));
    expect(text).not.toContain('duplicate key');
    expect(text).toContain('Something went wrong');
  });

  it('caps a coded error at 300 characters', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: false, error: 'x'.repeat(1000), code: 'VAL-100' }));
    const text = await finished(await dispatch('session', sub('list'), CONTEXT));
    expect(text.length).toBeLessThanOrEqual(300);
  });

  it.each([404, 307])('says the command is not available yet when an old console answers %s', async (status) => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status, headers: status === 307 ? { location: '/login' } : {} }));
    expect(await finished(await dispatch('session', sub('list'), CONTEXT))).toBe(CONSOLE_NOT_AVAILABLE);
  });

  it('says the command is not available yet for a login page answered as 200 HTML', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await finished(await dispatch('session', sub('list'), CONTEXT))).toBe(CONSOLE_NOT_AVAILABLE);
  });

  it('sends the check-in link only in the ephemeral reply', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: 'a'.repeat(48) }));
    const text = await finished(
      await dispatch('session', sub('checkin', [{ name: 'session', value: SESSION_ID }]), CONTEXT)
    );
    expect(text).toContain(`https://club.example.invalid/checkin/${'a'.repeat(48)}`);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE}/api/discord/actions/getOrCreateSessionCheckinToken`);
  });
});

describe('/session archive and delete modals', () => {
  it('opens a reason modal for archive, with no network call', async () => {
    const response = await dispatch('session', sub('archive', [{ name: 'session', value: SESSION_ID }]), CONTEXT);
    expect(response.type).toBe(9);
    expect((response.data as { custom_id: string }).custom_id).toBe(`cadm:sarchive:${SESSION_ID}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says on the delete modal that RSVPs and attendance go with it', async () => {
    const response = await dispatch('session', sub('delete', [{ name: 'session', value: SESSION_ID }]), CONTEXT);
    expect(JSON.stringify(response.data)).toMatch(/RSVP.*attendance/);
  });

  it('round-trips the modal into the console action', async () => {
    const opened = await dispatch('session', sub('archive', [{ name: 'session', value: SESSION_ID }]), CONTEXT);
    const customId = (opened.data as { custom_id: string }).custom_id;
    expect(isConsoleModal(customId)).toBe(true);
    fetchSpy.mockResolvedValueOnce(json({ ok: true }));
    const response = handleConsoleModal(
      customId,
      [{ type: 1, components: [{ type: 4, custom_id: 'reason', value: 'Gym closed for exams' }] }],
      CONTEXT
    );
    expect(await finished(response)).toBe('Session archived.');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/discord/actions/archiveSession`);
    expect(JSON.parse(init.body)).toEqual({ discordUserId: CALLER, args: [SESSION_ID, 'Gym closed for exams'] });
  });

  it('refuses a short reason without calling the console', () => {
    const response = handleConsoleModal(
      `cadm:sdelete:${SESSION_ID}`,
      [{ type: 1, components: [{ type: 4, custom_id: 'reason', value: 'no' }] }],
      CONTEXT
    );
    expect(response.type).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('/session pickers', () => {
  it('lists sessions by id with a short timeout and at most 25 choices', async () => {
    const sessions = Array.from({ length: 30 }, (_, i) => ({ id: `id-${i}`, label: `Session ${i}` }));
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: { sessions } }));
    const answer = await handleSessionAutocomplete(
      sub('archive', [{ name: 'session', value: 'club', focused: true }]),
      CONTEXT
    );
    const choices = (answer.data as { choices: { value: string }[] }).choices;
    expect(choices).toHaveLength(25);
    expect(choices[0]!.value).toBe('id-0');
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE}/api/discord/reads/sessions?q=club`);
    expect(fetchSpy.mock.calls[0]![1].headers['x-discord-user-id']).toBe(CALLER);
  });

  it('suggests locations for the location option', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: { locations: ['Main gym'] } }));
    const answer = await handleSessionAutocomplete(
      sub('create', [{ name: 'location', value: 'ma', focused: true }]),
      CONTEXT
    );
    expect((answer.data as { choices: unknown[] }).choices).toEqual([{ name: 'Main gym', value: 'Main gym' }]);
  });

  it('answers with no choices when the console is down', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('down'));
    const answer = await handleSessionAutocomplete(
      sub('archive', [{ name: 'session', value: '', focused: true }]),
      CONTEXT
    );
    expect((answer.data as { choices: unknown[] }).choices).toEqual([]);
  });
});
