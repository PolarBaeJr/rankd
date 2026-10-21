import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /event: club events through the console's own actions, as the linked exec.

import {
  COMMAND_DEFINITIONS,
  DEFERRED_COMMANDS,
  EVENT_PICKERS,
  dispatch,
  handleConsoleModal,
  handleEventAutocomplete,
  type BotResponse,
} from '../commands.js';

const CALLER = '424242424242';
const CONTEXT = { discordUserId: CALLER, guildId: 'g1' };
const EVENT_ID = '11111111-2222-4333-8444-555555555555';
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
  return (final.data as { content: string }).content;
}

beforeEach(() => {
  process.env.ADMIN_API_URL = BASE;
  process.env.DISCORD_SERVICE_SECRET = 'secret';
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/event definition', () => {
  const definition = COMMAND_DEFINITIONS.find((c) => c.name === 'event') as {
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

  it('acknowledges for itself and has its own picker', () => {
    expect(DEFERRED_COMMANDS.has('event')).toBe(false);
    expect(EVENT_PICKERS.has('event')).toBe(true);
  });
});

describe('/event create', () => {
  it('sends every clubEventSchema field, with explicit nulls', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: { id: EVENT_ID } }));
    const response = await dispatch(
      'event',
      sub('create', [
        { name: 'title', value: 'Pub night' },
        { name: 'kind', value: 'social' },
        { name: 'starts', value: '2026-11-04 19:00' },
      ]),
      CONTEXT
    );
    expect(await finished(response)).toContain('draft');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/discord/actions/createClubEvent`);
    expect(JSON.parse(init.body).args).toEqual([
      {
        title: 'Pub night',
        kind: 'social',
        description: null,
        location: null,
        starts_at: '2026-11-04T19:00',
        ends_at: null,
        signup_opens_at: null,
        signup_closes_at: null,
        capacity: null,
        cost_dollars: null,
        publish: false,
      },
    ]);
  });

  it('refuses a start that is not YYYY-MM-DD HH:MM before calling the console', async () => {
    const response = await dispatch(
      'event',
      sub('create', [
        { name: 'title', value: 'Pub night' },
        { name: 'kind', value: 'social' },
        { name: 'starts', value: 'next tuesday 7' },
      ]),
      CONTEXT
    );
    expect(response.type).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('/event publish', () => {
  it('publishes the console input it was handed, unchanged but for publish', async () => {
    const editInput = { title: 'Pub night', kind: 'social', starts_at: '2026-11-04T19:00', capacity: 20, publish: false };
    fetchSpy
      .mockResolvedValueOnce(json({ ok: true, data: { events: [{ id: EVENT_ID, label: 'Pub night', status: 'draft', editInput }] } }))
      .mockResolvedValueOnce(json({ ok: true }));
    const response = await dispatch('event', sub('publish', [{ name: 'event', value: EVENT_ID }]), CONTEXT);
    expect(await finished(response)).toBe('Published: Pub night');
    expect(JSON.parse(fetchSpy.mock.calls[1]![1].body).args).toEqual([EVENT_ID, { ...editInput, publish: true }]);
  });
});

describe('/event cancel and delete', () => {
  it('opens a reason modal for cancel and sends the reason on submit', async () => {
    const opened = await dispatch('event', sub('cancel', [{ name: 'event', value: EVENT_ID }]), CONTEXT);
    expect(opened.type).toBe(9);
    const customId = (opened.data as { custom_id: string }).custom_id;
    expect(customId).toBe(`cadm:ecancel:${EVENT_ID}`);
    fetchSpy.mockResolvedValueOnce(json({ ok: true }));
    const text = await finished(
      handleConsoleModal(customId, [{ type: 1, components: [{ type: 4, custom_id: 'reason', value: 'Venue closed' }] }], CONTEXT)
    );
    expect(text).toContain('cancelled');
    expect(JSON.parse(fetchSpy.mock.calls[0]![1].body).args).toEqual([EVENT_ID, 'Venue closed']);
  });

  it('needs DELETE typed before deleting anything', () => {
    const response = handleConsoleModal(
      `cadm:edelete:${EVENT_ID}`,
      [{ type: 1, components: [{ type: 4, custom_id: 'confirm', value: 'delete?' }] }],
      CONTEXT
    );
    expect(response.type).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('points to cancel when people have signed up, and deletes nothing', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: { event: { id: EVENT_ID }, signups: ['A member'] } }));
    const text = await finished(
      handleConsoleModal(
        `cadm:edelete:${EVENT_ID}`,
        [{ type: 1, components: [{ type: 4, custom_id: 'confirm', value: 'DELETE' }] }],
        CONTEXT
      )
    );
    expect(text).toContain('/event cancel');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('deletes an event nobody signed up for', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ ok: true, data: { event: { id: EVENT_ID }, signups: [] } }))
      .mockResolvedValueOnce(json({ ok: true }));
    const text = await finished(
      handleConsoleModal(
        `cadm:edelete:${EVENT_ID}`,
        [{ type: 1, components: [{ type: 4, custom_id: 'confirm', value: 'DELETE' }] }],
        CONTEXT
      )
    );
    expect(text).toBe('Event deleted.');
    expect(fetchSpy.mock.calls[1]![0]).toBe(`${BASE}/api/discord/actions/deleteClubEvent`);
  });
});

describe('/event picker', () => {
  it('lists events by id', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: { events: [{ id: EVENT_ID, label: 'Pub night' }] } }));
    const answer = await handleEventAutocomplete(sub('publish', [{ name: 'event', value: 'pub', focused: true }]), CONTEXT);
    expect((answer.data as { choices: unknown[] }).choices).toEqual([{ name: 'Pub night', value: EVENT_ID }]);
  });
});
