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

describe('/event edit', () => {
  const editInput = {
    title: 'Pub night',
    kind: 'social',
    description: 'Upstairs',
    location: 'The Pub',
    starts_at: '2026-11-04T19:00',
    ends_at: '2026-11-04T22:00',
    signup_opens_at: null,
    signup_closes_at: null,
    capacity: 20,
    cost_dollars: null,
    publish: true,
  };
  const current = () =>
    json({ ok: true, data: { events: [{ id: EVENT_ID, label: 'Pub night', status: 'published', editInput }] } });

  it('overlays only what was typed and sends the reason, keeping it published', async () => {
    fetchSpy.mockResolvedValueOnce(current()).mockResolvedValueOnce(json({ ok: true }));
    const response = await dispatch(
      'event',
      sub('edit', [
        { name: 'event', value: EVENT_ID },
        { name: 'reason', value: 'Venue changed' },
        { name: 'location', value: 'The Other Pub' },
        { name: 'capacity', value: 30 },
        { name: 'ends', value: '2026-11-04 23:00' },
      ]),
      CONTEXT
    );
    expect(await finished(response)).toContain('Its Discord event follows');
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/discord/actions/editClubEvent`);
    expect(JSON.parse(String(init.body)).args).toEqual([
      EVENT_ID,
      { ...editInput, location: 'The Other Pub', capacity: 30, ends_at: '2026-11-04T23:00' },
      'Venue changed',
    ]);
  });

  it('refuses a short reason, a malformed start and an empty edit before calling the console', async () => {
    const answer = async (options: { name: string; value: unknown }[]) =>
      ((await dispatch('event', sub('edit', [{ name: 'event', value: EVENT_ID }, ...options]), CONTEXT)) as BotResponse)
        .data as { content: string };
    expect((await answer([{ name: 'reason', value: 'why' }, { name: 'title', value: 'X' }])).content).toContain('at least 5');
    expect((await answer([{ name: 'reason', value: 'Moved again' }, { name: 'starts', value: 'next friday' }])).content).toContain(
      'YYYY-MM-DD HH:MM'
    );
    expect((await answer([{ name: 'reason', value: 'Moved again' }])).content).toContain('at least one');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an event that was typed rather than picked, reading nothing', async () => {
    const response = (await dispatch(
      'event',
      sub('edit', [
        { name: 'event', value: 'pub night' },
        { name: 'reason', value: 'Venue changed' },
        { name: 'title', value: 'Pub night two' },
      ]),
      CONTEXT
    )) as BotResponse;
    expect((response.data as { content: string }).content).toContain('Pick an event');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an end before the start it would land on, writing nothing', async () => {
    fetchSpy.mockResolvedValueOnce(current());
    const response = await dispatch(
      'event',
      sub('edit', [
        { name: 'event', value: EVENT_ID },
        { name: 'reason', value: 'Starts later now' },
        { name: 'starts', value: '2026-11-04 23:30' },
      ]),
      CONTEXT
    );
    expect(await finished(response)).toContain('end has to be after the start');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
  it('says why when the console refuses, instead of showing an empty list', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: false, refusal: 'passkey_required' }));
    const answer = await handleEventAutocomplete(sub('signups', [{ name: 'event', value: '', focused: true }]), CONTEXT);
    expect((answer.data as { choices: { name: string }[] }).choices).toEqual([
      { name: "Add a console passkey in the console's Settings first", value: 'refused' },
    ]);
    fetchSpy.mockResolvedValueOnce(json({ ok: false, error: 'boom' }, 500));
    const failed = await handleEventAutocomplete(sub('signups', [{ name: 'event', value: '', focused: true }]), CONTEXT);
    expect((failed.data as { choices: unknown[] }).choices).toEqual([]);
  });
});

describe('/event signups', () => {
  const EVENT = {
    id: EVENT_ID,
    label: 'Oct 30, 2026, 7:00 PM · Halloween social · Social',
    title: 'Halloween social',
    when: 'Oct 30, 2026, 7:00 PM',
    status: 'published',
    capacity: 20,
    url: 'https://club.example.invalid/admin/events/' + EVENT_ID,
  };

  type Embed = { title: string; url?: string; description: string };

  async function answer(): Promise<{ content?: string; embeds?: Embed[]; flags?: number; allowed_mentions?: unknown }> {
    const response = await dispatch('event', sub('signups', [{ name: 'event', value: EVENT_ID }]), CONTEXT);
    expect(response.type).toBe(5);
    expect(response.data).toEqual({ flags: 64 });
    const final = await response.finish!();
    return final.data as never;
  }

  it('asks the console as the caller, so the console decides who may see the list', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: { event: EVENT, taken: 0, signups: [], people: [] } }));
    await answer();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/discord/reads/event-signups?id=${EVENT_ID}`);
    expect(init.headers['x-discord-user-id']).toBe(CALLER);
  });

  it('shows the next published event when none is picked', async () => {
    const DRAFT_ID = '99999999-8888-4777-8666-555555555555';
    fetchSpy
      .mockResolvedValueOnce(
        json({
          ok: true,
          data: {
            events: [
              { id: DRAFT_ID, label: 'Draft', status: 'draft' },
              { id: EVENT_ID, label: EVENT.label, status: 'published' },
            ],
          },
        })
      )
      .mockResolvedValueOnce(json({ ok: true, data: { event: EVENT, taken: 0, signups: [], people: [] } }));
    const response = await dispatch('event', sub('signups', []), CONTEXT);
    const data = (await response.finish!()).data as { embeds?: Embed[] };
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE}/api/discord/reads/events`);
    expect(fetchSpy.mock.calls[1]![0]).toBe(`${BASE}/api/discord/reads/event-signups?id=${EVENT_ID}`);
    expect(data.embeds![0]!.title).toBe('Halloween social');
  });

  it('says so when no event is picked and none is coming up', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: { events: [] } }));
    const response = await dispatch('event', sub('signups', []), CONTEXT);
    const data = (await response.finish!()).data as { content?: string };
    expect(data.content).toContain('No club events coming up');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('says what the console said when the caller lacks the sign-ups permission', async () => {
    fetchSpy.mockResolvedValueOnce(
      json({ ok: false, error: 'Your permissions do not include this. Ask an admin.', code: 'AUTH-104' })
    );
    const data = await answer();
    expect(data.embeds).toBeUndefined();
    expect(data.flags).toBe(64);
    expect(data.content).toBe('Your permissions do not include this. Ask an admin.');
  });

  it('points an unlinked caller at /link', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: false, refusal: 'not_linked' }));
    const data = await answer();
    expect(data.embeds).toBeUndefined();
    expect(data.content).toContain('/link');
  });

  it('says so when the event is gone', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: { event: null } }));
    expect((await answer()).content).toBe('That event no longer exists.');
  });

  it('labels each person by where they came from when the console says so', async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        ok: true,
        data: {
          event: EVENT,
          taken: 3,
          people: [
            { name: 'Ada Member', kind: 'member', source: 'app', checkedIn: true, noShow: false, walkIn: false },
            { name: 'Eve Outside', kind: 'external', source: 'form', checkedIn: false, noShow: false, walkIn: false },
            { name: 'Gus Guest', kind: 'guest', source: 'manual', checkedIn: false, noShow: false, walkIn: true },
          ],
          waitlist: [],
        },
      })
    );
    const lines = (await answer()).embeds![0]!.description!.split('\n');
    expect(lines.slice(2)).toEqual(['1. Ada Member (app, checked in)', '2. Eve Outside (form)', '3. Gus Guest (manual)']);
  });

  it('shows the event, the count against the cap, and a numbered list with plain-word markers', async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        ok: true,
        data: {
          event: EVENT,
          taken: 2,
          signups: ['Ada Member', 'Eve Outside', 'Gus *Guest*'],
          people: [
            { name: 'Ada Member', kind: 'member', checkedIn: true, noShow: false, walkIn: false },
            { name: 'Eve Outside', kind: 'external', checkedIn: false, noShow: false, walkIn: true },
            { name: 'Gus *Guest*', kind: 'guest', checkedIn: false, noShow: true, walkIn: false },
          ],
          waitlist: ['Wes Waiting'],
        },
      })
    );
    const data = await answer();
    expect(data.flags).toBe(64);
    expect(data.allowed_mentions).toEqual({ parse: [] });
    const embed = data.embeds![0]!;
    expect(embed.title).toBe('Halloween social');
    expect(embed.url).toBe(EVENT.url);
    expect(embed.description).toBe(
      [
        'Oct 30, 2026, 7:00 PM · 2 signed up / 20 · 1 waitlisted',
        '',
        '1. Ada Member (checked in)',
        '2. Eve Outside (external, walk-in)',
        '3. Gus \\*Guest\\* (guest, no-show)',
        '4. Wes Waiting (waitlisted)',
      ].join('\n')
    );
  });

  it('leaves the cap out of an uncapped event and says when nobody has signed up', async () => {
    fetchSpy.mockResolvedValueOnce(
      json({ ok: true, data: { event: { ...EVENT, capacity: null, status: 'draft' }, taken: 0, signups: [], people: [] } })
    );
    const embed = (await answer()).embeds![0]!;
    expect(embed.description).toBe('Oct 30, 2026, 7:00 PM · 0 signed up · Draft\n\nNobody has signed up yet.');
  });

  it('still lists names from an older console that sends only plain names', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: { event: { id: EVENT_ID, label: 'Pub night', capacity: null }, signups: ['Ada'] } }));
    const embed = (await answer()).embeds![0]!;
    expect(embed.title).toBe('Pub night');
    expect(embed.description).toBe('1 signed up\n\n1. Ada');
  });

  it('fits a long list under the embed limit and counts the rest, with the link', async () => {
    const people = Array.from({ length: 300 }, (_, i) => ({
      name: `Member number ${String(i + 1).padStart(3, '0')} with a longish name`,
      kind: 'member',
      checkedIn: false,
      noShow: false,
      walkIn: false,
    }));
    fetchSpy.mockResolvedValueOnce(
      json({ ok: true, data: { event: { ...EVENT, capacity: 300 }, taken: 300, signups: people.map((p) => p.name), people } })
    );
    const description = (await answer()).embeds![0]!.description;
    expect(description.length).toBeLessThanOrEqual(4096);
    const shown = description.split('\n').filter((line) => /^\d+\. /.test(line)).length;
    expect(shown).toBeGreaterThan(10);
    expect(shown).toBeLessThan(300);
    expect(description.endsWith(`...and ${300 - shown} more, see the website: ${EVENT.url}`)).toBe(true);
  });

  it('says to see the website without a link when the console has no public address', async () => {
    const people = Array.from({ length: 300 }, (_, i) => ({
      name: `Member ${i} ${'x'.repeat(30)}`,
      kind: 'member',
      checkedIn: false,
      noShow: false,
      walkIn: false,
    }));
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: { event: { ...EVENT, url: null }, taken: 300, people } }));
    const embed = (await answer()).embeds![0]!;
    expect(embed.url).toBeUndefined();
    expect(embed.description).toMatch(/\.\.\.and \d+ more, see the website\.$/);
  });
});
