import { describe, it, expect, vi, beforeEach } from 'vitest';

// /schedule: the caller's own two weeks, decided and formatted by the app.

const { fetchSchedule } = vi.hoisted(() => ({ fetchSchedule: vi.fn() }));

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchSchedule,
}));

import { COMMAND_DEFINITIONS, DEFERRED_COMMANDS, dispatch } from '../commands.js';

const CONTEXT = { discordUserId: '424242424242', guildId: 'g1' };

beforeEach(() => {
  fetchSchedule.mockReset();
});

describe('/schedule', () => {
  it('is open to every member and deferred, so the reply is ephemeral', () => {
    const definition = COMMAND_DEFINITIONS.find((c) => c.name === 'schedule') as {
      default_member_permissions?: string;
      options: unknown[];
    };
    expect(definition.default_member_permissions).toBeUndefined();
    expect(definition.options).toEqual([]);
    expect(DEFERRED_COMMANDS.has('schedule')).toBe(true);
  });

  it('tells an unlinked member to link, in a sentence without an em dash', async () => {
    fetchSchedule.mockResolvedValue({ linked: false });
    const response = await dispatch('schedule', [], CONTEXT);
    const content = (response.data as { content: string; flags: number }).content;
    expect(content).toContain('/link');
    expect(content).not.toContain('\u2014');
    expect((response.data as { flags: number }).flags).toBe(64);
  });

  it('renders the days and the feed links', async () => {
    fetchSchedule.mockResolvedValue({
      linked: true,
      days: [{ label: 'Tue, Oct 20', items: ['7:00 PM Club night · Gym'] }],
      feed: { https: 'https://club.example.invalid/api/calendar/t', webcal: 'webcal://club.example.invalid/api/calendar/t' },
      calendarUrl: 'https://club.example.invalid/calendar',
    });
    const response = await dispatch('schedule', [], CONTEXT);
    const data = response.data as { flags: number; allowed_mentions: unknown; embeds: { description: string }[] };
    expect(data.flags).toBe(64);
    expect(data.allowed_mentions).toEqual({ parse: [] });
    expect(data.embeds[0]!.description).toContain('**Tue, Oct 20**');
    expect(data.embeds[0]!.description).toContain('webcal://club.example.invalid/api/calendar/t');
    expect(data.embeds[0]!.description).toContain('https://club.example.invalid/calendar');
  });

  it('leaves the feed link out when the app withholds it', async () => {
    fetchSchedule.mockResolvedValue({ linked: true, days: [], feed: null, calendarUrl: 'https://club.example.invalid/calendar' });
    const response = await dispatch('schedule', [], CONTEXT);
    const description = (response.data as { embeds: { description: string }[] }).embeds[0]!.description;
    expect(description).toContain('Nothing on your schedule');
    expect(description).not.toContain('webcal');
  });
});
