import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /tournaments enter, draw, next and results, and the list's 1.1.1 additions.
// fetch is stubbed, so what these pin is the wire (which member-app route, the
// caller as a header or in the body, never anything else) and the words: each
// refusal its own sentence, a timeout on `enter` never claiming nothing
// happened, and a draw split under every Discord embed limit.

import {
  COMMAND_DEFINITIONS,
  DEFERRED_COMMANDS,
  MEMBER_TOURNAMENT_PICKERS,
  dispatch,
  drawEmbeds,
  handleTournamentAutocomplete,
} from '../commands.js';

const CALLER = '424242424242';
const CONTEXT = { discordUserId: CALLER, guildId: 'g1' };
const T1 = '22222222-3333-4444-8555-666666666666';
const E1 = '11111111-2222-4333-8444-555555555555';

const fetchSpy = vi.fn();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sub(name: string, options: { name: string; value: unknown; focused?: boolean }[] = []) {
  return [{ type: 1, name, options }] as never;
}

interface Answer {
  type: number;
  data: {
    content?: string;
    flags?: number;
    allowed_mentions?: unknown;
    embeds?: { title?: string; description: string }[];
    choices?: { name: string; value: string }[];
  };
}

async function run(name: string, options: { name: string; value: unknown }[] = []): Promise<Answer> {
  return (await dispatch('tournaments', sub(name, options), CONTEXT)) as unknown as Answer;
}

function calledUrl(index = 0): URL {
  return new URL(String(fetchSpy.mock.calls[index]?.[0]));
}

beforeEach(() => {
  process.env.APP_API_URL = 'https://club.example.invalid';
  process.env.DISCORD_SERVICE_SECRET = 'secret';
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/tournaments definition', () => {
  const definition = COMMAND_DEFINITIONS.find((c) => c.name === 'tournaments') as {
    default_member_permissions?: string;
    options: { name: string; type: number; options: { name: string; autocomplete?: boolean }[] }[];
  };

  it('is for everybody, with the five subcommands', () => {
    expect(definition.default_member_permissions).toBeUndefined();
    expect(definition.options.map((o) => o.name)).toEqual(['list', 'enter', 'draw', 'next', 'results']);
  });

  it('is deferred, and its pickers are routed to the member app', () => {
    expect(DEFERRED_COMMANDS.has('tournaments')).toBe(true);
    expect(MEMBER_TOURNAMENT_PICKERS.has('tournaments')).toBe(true);
  });

  it('autocompletes every tournament and event option', () => {
    for (const subcommand of definition.options) {
      for (const o of subcommand.options) expect(o.autocomplete, `${subcommand.name} ${o.name}`).toBe(true);
    }
  });
});

describe('/tournaments list', () => {
  const listBody = {
    tournaments: [
      {
        id: 't1',
        name: 'Autumn Classic',
        startDate: '2026-10-10',
        endDate: null,
        events: ['mens_singles'],
        registrationOpen: false,
        eligible: true,
        inProgress: true,
      },
    ],
    linked: true,
    page: 1,
    totalPages: 1,
    total: 1,
    query: null,
    recentlyFinished: [{ id: 't0', name: 'Summer Smash', startDate: '2026-10-04', endDate: null }],
  };

  it('is still the list with no subcommand, as an old registration sends it', async () => {
    fetchSpy.mockResolvedValue(json(listBody));
    const answer = (await dispatch('tournaments', undefined, CONTEXT)) as unknown as Answer;
    expect(calledUrl().pathname).toBe('/api/discord/tournaments');
    expect(answer.data.flags).toBe(64);
  });

  it('marks a tournament in progress and lists the ones finished this week', async () => {
    fetchSpy.mockResolvedValue(json(listBody));
    const description = (await run('list')).data.embeds?.[0]?.description ?? '';
    expect(description).toContain('**Happening now**');
    expect(description).toContain('Finished this week');
    expect(description).toContain('Summer Smash');
  });

  it('says so when nothing is on, coming up or just finished', async () => {
    fetchSpy.mockResolvedValue(json({ ...listBody, tournaments: [], total: 0, recentlyFinished: [] }));
    expect((await run('list')).data.content).toBe(
      'Nothing is on or coming up right now. Past tournaments are on the website.'
    );
  });
});

describe('/tournaments enter', () => {
  const enter = () => run('enter', [{ name: 'tournament', value: T1 }, { name: 'event', value: E1 }]);

  it('posts the caller and the event, and nothing else', async () => {
    fetchSpy.mockResolvedValue(json({ ok: true, event: "Men's Singles" }));
    const answer = await enter();
    expect(calledUrl().pathname).toBe('/api/discord/tournament-entry');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ discordUserId: CALLER, eventId: E1 });
    expect(answer.data.content).toContain("You're entered in Men's Singles");
    expect(answer.data.flags).toBe(64);
    expect(answer.data.allowed_mentions).toEqual({ parse: [] });
  });

  it('refuses an event that was typed rather than picked, without calling the app', async () => {
    const answer = await run('enter', [{ name: 'tournament', value: T1 }, { name: 'event', value: 'mens' }]);
    expect(answer.data.content).toBe('Pick an event from the list.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [{ refusal: 'not_linked' }, '/link'],
    [{ refusal: 'lapsed' }, 'paused for inactivity'],
    [{ refusal: 'standing' }, "can't enter tournaments"],
    [{ refusal: 'feature_off' }, 'switched off'],
    [{ refusal: 'waiver' }, 'legal documents'],
    [{ refusal: 'not_found' }, "isn't open to entries"],
    [{ refusal: 'website', url: 'https://club.example.invalid/tournaments/t1/events/e1' }, 'https://club.example.invalid/tournaments/t1/events/e1'],
    [{ refusal: 'rule', message: 'Registration is closed' }, 'Registration is closed'],
  ])('turns %o into its own sentence', async (refusal, words) => {
    fetchSpy.mockResolvedValue(json({ ok: false, ...refusal }));
    expect((await enter()).data.content).toContain(words);
  });

  it('never says nothing happened when the app does not answer', async () => {
    fetchSpy.mockRejectedValue(new DOMException('The operation was aborted', 'TimeoutError'));
    const content = (await enter()).data.content ?? '';
    expect(content).toContain("can't tell whether you were entered");
    expect(content).toContain('website');
  });
});

describe('/tournaments draw', () => {
  const draw = {
    found: true,
    tournament: { id: T1, name: 'Autumn Classic' },
    event: { id: E1, label: "Men's Singles", status: 'live' },
    suspended: null,
    url: 'https://club.example.invalid/tournaments/t1/events/e1',
    sections: [{ title: 'Final', lines: ['R1 #1 Alex Smith 21-15 Bo Jones'] }],
    truncated: false,
  };

  it('reads the picked event and renders it with a link to the full draw', async () => {
    fetchSpy.mockResolvedValue(json(draw));
    const answer = await run('draw', [{ name: 'tournament', value: T1 }, { name: 'event', value: E1 }]);
    expect(calledUrl().pathname).toBe('/api/discord/tournament-draw');
    expect(calledUrl().searchParams.get('eventId')).toBe(E1);
    const embed = answer.data.embeds?.[0];
    expect(embed?.title).toBe("Autumn Classic · Men's Singles");
    expect(embed?.description).toContain('R1 #1 Alex Smith 21-15 Bo Jones');
    expect(embed?.description).toContain(`[Full draw](${draw.url})`);
    expect(answer.data.flags).toBe(64);
  });

  it('splits a big draw under every embed limit and points at the website', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `R1 #${i + 1} ${'Player Name'.repeat(3)} v ${'Other Name'.repeat(3)}`);
    const embeds = drawEmbeds({ ...draw, found: true, sections: [{ title: 'Round 1', lines }] }) as {
      title?: string;
      description: string;
    }[];
    expect(embeds.length).toBeLessThanOrEqual(10);
    let total = 0;
    for (const e of embeds) {
      expect(e.description.length).toBeLessThanOrEqual(4096);
      total += e.description.length + (e.title?.length ?? 0);
    }
    expect(total).toBeLessThanOrEqual(6000);
    const last = embeds[embeds.length - 1]!.description;
    expect(last).toContain('More on the website.');
    expect(last).toContain('[Full draw]');
  });

  it('says the draw was cut when the app reached its own cap', () => {
    const embeds = drawEmbeds({ ...draw, found: true, truncated: true }) as { description: string }[];
    expect(embeds[0]!.description).toContain('More on the website.');
  });

  it('says when play is suspended', () => {
    const embeds = drawEmbeds({ ...draw, found: true, suspended: { reason: 'Fire alarm' } }) as { description: string }[];
    expect(embeds[0]!.description).toContain('Play is suspended: Fire alarm');
  });
});

describe('/tournaments next', () => {
  it('reads with the caller as a header and shows the match', async () => {
    fetchSpy.mockResolvedValue(
      json({
        linked: true,
        match: {
          tournament: 'Autumn Classic',
          event: "Men's Singles",
          round: 'Semi-finals (R2 #1)',
          opponents: 'Bo Jones',
          status: 'ready',
          court: '3',
          scheduledTime: null,
          suspended: null,
          url: null,
        },
      })
    );
    const answer = await run('next');
    expect(calledUrl().pathname).toBe('/api/discord/tournament-next');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-discord-user-id']).toBe(CALLER);
    expect(answer.data.content).toContain('Against: Bo Jones');
    expect(answer.data.content).toContain('Waiting to be called · Court 3');
  });

  it('asks an unlinked caller to link', async () => {
    fetchSpy.mockResolvedValue(json({ linked: false }));
    expect((await run('next')).data.content).toContain('/link');
  });

  it('says when there is nothing coming up', async () => {
    fetchSpy.mockResolvedValue(json({ linked: true, match: null }));
    expect((await run('next')).data.content).toBe('You have no tournament match coming up.');
  });
});

describe('/tournaments results', () => {
  it('shows what is on court and the latest results', async () => {
    fetchSpy.mockResolvedValue(
      json({
        found: true,
        tournament: { id: T1, name: 'Autumn Classic' },
        suspended: null,
        live: ["Men's Singles R2 #1 Cy Lee v Alex Smith · on court · Court 2"],
        recent: ["Men's Singles R1 #1 Alex Smith 21-15 Bo Jones"],
        url: null,
      })
    );
    const answer = await run('results', [{ name: 'tournament', value: T1 }]);
    expect(calledUrl().searchParams.get('tournamentId')).toBe(T1);
    const description = answer.data.embeds?.[0]?.description ?? '';
    expect(description).toContain('**On court now**');
    expect(description).toContain('**Latest results**');
  });
});

describe('/tournaments pickers', () => {
  it('lists tournaments for the tournament slot', async () => {
    fetchSpy.mockResolvedValue(json({ choices: [{ id: T1, label: 'Autumn Classic' }] }));
    const answer = (await handleTournamentAutocomplete(
      sub('draw', [{ name: 'tournament', value: 'aut', focused: true }])
    )) as unknown as Answer;
    expect(calledUrl().pathname).toBe('/api/discord/tournament-picker');
    expect(calledUrl().searchParams.get('q')).toBe('aut');
    expect(answer.data.choices).toEqual([{ name: 'Autumn Classic', value: T1 }]);
  });

  it("lists the picked tournament's open events for enter", async () => {
    fetchSpy.mockResolvedValue(json({ choices: [{ id: E1, label: "Men's Singles" }] }));
    await handleTournamentAutocomplete(
      sub('enter', [
        { name: 'tournament', value: T1 },
        { name: 'event', value: '', focused: true },
      ])
    );
    expect(calledUrl().searchParams.get('tournamentId')).toBe(T1);
    expect(calledUrl().searchParams.get('open')).toBe('1');
  });

  it('offers no events until a tournament is picked', async () => {
    const answer = (await handleTournamentAutocomplete(
      sub('draw', [
        { name: 'tournament', value: 'Autumn' },
        { name: 'event', value: '', focused: true },
      ])
    )) as unknown as Answer;
    expect(answer.data.choices).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers empty choices rather than throwing when the app is down', async () => {
    fetchSpy.mockRejectedValue(new Error('down'));
    const answer = (await handleTournamentAutocomplete(
      sub('draw', [{ name: 'tournament', value: '', focused: true }])
    )) as unknown as Answer;
    expect(answer).toEqual({ type: 8, data: { choices: [] } });
  });
});
