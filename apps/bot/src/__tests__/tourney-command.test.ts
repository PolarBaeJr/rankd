import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /tourney: running a tournament on the day from Discord, as the linked exec.
// fetch is stubbed, so what these pin is the wire (which console action, with
// which arguments, the caller in the body) and the words. The pickers are
// chained off the tournament already picked, and a value that was typed rather
// than picked gets no choices and no read.

import {
  COMMAND_DEFINITIONS,
  CONSOLE_NOT_LINKED,
  CONSOLE_PASSKEY_REQUIRED,
  DEFERRED_COMMANDS,
  TOURNEY_PICKERS,
  dispatch,
  handleConsoleModal,
  handleTourneyAutocomplete,
  parseGameScores,
  type BotResponse,
} from '../commands.js';

const CALLER = '424242424242';
const CONTEXT = { discordUserId: CALLER, guildId: 'g1' };
const T1 = '22222222-3333-4444-8555-666666666666';
const MATCH = '33333333-4444-4555-8666-777777777777';
const ENTRY = '44444444-5555-4666-8777-888888888888';
const PLAYER = '55555555-6666-4777-8888-999999999999';
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

function tourney(name: string, options: { name: string; value: unknown }[] = []) {
  return dispatch('tourney', sub(name, [{ name: 'tournament', value: T1 }, ...options]), CONTEXT);
}

/** The body of the nth POST, as the console route reads it. */
function sent(index: number): { path: string; body: { discordUserId: string; args: unknown[] } } {
  const [url, init] = fetchSpy.mock.calls[index] as [string, RequestInit];
  return { path: url.replace(BASE, ''), body: JSON.parse(String(init.body)) };
}

const MATCH_ROW = { id: MATCH, label: 'Final', sideA: 'Smith', sideB: 'Jones', status: 'ready' };

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

describe('/tourney definition', () => {
  const definition = COMMAND_DEFINITIONS.find((c) => c.name === 'tourney') as {
    default_member_permissions?: string;
    dm_permission?: boolean;
    options: { name: string; options: { name: string; required?: boolean }[] }[];
  };

  it('is hidden from members and guild-only', () => {
    expect(definition.default_member_permissions).toBe('0');
    expect(definition.dm_permission).toBe(false);
  });

  it('starts every subcommand from the tournament, and puts required options first', () => {
    for (const subcommand of definition.options) {
      expect(subcommand.options[0]?.name, subcommand.name).toBe('tournament');
      const required = subcommand.options.map((o) => o.required === true);
      expect(required, subcommand.name).toEqual([...required].sort((a, b) => Number(b) - Number(a)));
    }
  });

  // suspend opens a modal, which a deferred interaction cannot.
  it('acknowledges for itself rather than through DEFERRED_COMMANDS', () => {
    expect(DEFERRED_COMMANDS.has('tourney')).toBe(false);
    expect(TOURNEY_PICKERS.has('tourney')).toBe(true);
  });
});

describe('parseGameScores', () => {
  it('keeps the first number of each game first', () => {
    expect(parseGameScores('21-15 18-21, 21:19', 'side A first')).toEqual({
      ok: true,
      games: [[21, 15], [18, 21], [21, 19]],
    });
  });

  it('names the order in its help', () => {
    const parsed = parseGameScores('abc', 'side A first, as shown in the picker');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toContain('side A first, as shown in the picker');
  });

  it('refuses a level game', () => {
    expect(parseGameScores('21-21', 'x').ok).toBe(false);
  });
});

describe('/tourney entries', () => {
  it.each([
    ['checkin', `p:${ENTRY}`, '/api/discord/actions/checkInParticipant', [ENTRY]],
    ['checkin', `pr:${ENTRY}`, '/api/discord/actions/checkInPair', [ENTRY]],
    ['noshow', `p:${ENTRY}`, '/api/discord/actions/markParticipantNoShow', [ENTRY]],
    ['noshow', `pr:${ENTRY}`, '/api/discord/actions/markPairNoShow', [ENTRY]],
    ['undo-checkin', `pr:${ENTRY}`, '/api/discord/actions/undoCheckIn', [ENTRY, true]],
    ['undo-checkin', `p:${ENTRY}`, '/api/discord/actions/undoCheckIn', [ENTRY, false]],
  ])('%s %s runs %s', async (name, entry, path, args) => {
    fetchSpy.mockResolvedValue(json({ ok: true, data: null }));
    await finished(await tourney(name, [{ name: 'entry', value: entry }]));
    expect(sent(0)).toEqual({ path, body: { discordUserId: CALLER, args } });
  });

  it('refuses an entry that was typed rather than picked', async () => {
    const response = await tourney('checkin', [{ name: 'entry', value: 'Smith' }]);
    expect((response.data as { content: string }).content).toBe('Pick a player or pair from the list.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a tournament that was typed rather than picked', async () => {
    const response = await dispatch('tourney', sub('resume', [{ name: 'tournament', value: 'Autumn' }]), CONTEXT);
    expect((response.data as { content: string }).content).toBe('Pick a tournament from the list.');
  });
});

describe('/tourney result', () => {
  it('reads the match, sends the games side A first, and echoes the names', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ ok: true, data: { matches: [MATCH_ROW] } }))
      .mockResolvedValueOnce(json({ ok: true, data: null }));
    const content = await finished(
      await tourney('result', [
        { name: 'match', value: MATCH },
        { name: 'scores', value: '21-15 19-21 21-17' },
      ])
    );
    const readUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(readUrl.pathname).toBe('/console/api/discord/reads/tournament-matches');
    expect(readUrl.searchParams.get('tournamentId')).toBe(T1);
    expect(readUrl.searchParams.get('id')).toBe(MATCH);
    expect(sent(1)).toEqual({
      path: '/api/discord/actions/enterMatchResultFromScores',
      body: { discordUserId: CALLER, args: [MATCH, [{ a: 21, b: 15 }, { a: 19, b: 21 }, { a: 21, b: 17 }]] },
    });
    expect(content).toBe('Recorded: Smith 21-15 19-21 21-17 Jones');
  });

  it('refuses a score that decides nothing before anything is read', async () => {
    const response = await tourney('result', [
      { name: 'match', value: MATCH },
      { name: 'scores', value: '21-15 15-21' },
    ]);
    expect((response.data as { content: string }).content).toContain('same number of games');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a match that is not in the tournament, writing nothing', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, data: { matches: [] } }));
    const content = await finished(
      await tourney('result', [
        { name: 'match', value: MATCH },
        { name: 'scores', value: '21-15' },
      ])
    );
    expect(content).toContain('not in this tournament');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('/tourney match commands', () => {
  it('walkover sends the side and the reason', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ ok: true, data: { matches: [MATCH_ROW] } }))
      .mockResolvedValueOnce(json({ ok: true, data: null }));
    const content = await finished(
      await tourney('walkover', [
        { name: 'match', value: MATCH },
        { name: 'winner', value: 'b' },
        { name: 'reason', value: 'Opponent injured' },
      ])
    );
    expect(sent(1).body.args).toEqual([MATCH, 'b', 'Opponent injured']);
    expect(content).toContain('Jones goes through');
  });

  it('court and live send the console arguments', async () => {
    fetchSpy.mockImplementation(async (url: string) =>
      url.includes('/reads/') ? json({ ok: true, data: { matches: [MATCH_ROW] } }) : json({ ok: true, data: null })
    );
    await finished(await tourney('court', [{ name: 'match', value: MATCH }, { name: 'court', value: '3' }]));
    await finished(await tourney('live', [{ name: 'match', value: MATCH }, { name: 'state', value: 'stop' }]));
    expect(sent(1)).toEqual({ path: '/api/discord/actions/setMatchCourt', body: { discordUserId: CALLER, args: [MATCH, '3'] } });
    expect(sent(3)).toEqual({ path: '/api/discord/actions/setMatchLive', body: { discordUserId: CALLER, args: [MATCH, false] } });
  });
});

describe('/tourney tournament commands', () => {
  it('status, resume and fee send the console arguments', async () => {
    fetchSpy.mockResolvedValue(json({ ok: true, data: null }));
    await finished(await tourney('status', [{ name: 'status', value: 'completed' }]));
    await finished(await tourney('resume'));
    await finished(
      await tourney('fee', [
        { name: 'player', value: PLAYER },
        { name: 'state', value: 'paid' },
        { name: 'method', value: 'cash' },
      ])
    );
    await finished(await tourney('fee', [{ name: 'player', value: PLAYER }, { name: 'state', value: 'unpaid' }]));
    expect(sent(0)).toEqual({ path: '/api/discord/actions/updateTournamentStatus', body: { discordUserId: CALLER, args: [T1, 'completed'] } });
    expect(sent(1)).toEqual({ path: '/api/discord/actions/resumeTournament', body: { discordUserId: CALLER, args: [T1] } });
    expect(sent(2).body.args).toEqual([{ tournament_id: T1, player_id: PLAYER, method: 'cash' }]);
    expect(sent(3)).toEqual({ path: '/api/discord/actions/markTournamentFeeUnpaid', body: { discordUserId: CALLER, args: [T1, PLAYER] } });
  });

  it('suspend opens a modal, and its submit sends the reason', async () => {
    const modal = await tourney('suspend');
    expect(modal.type).toBe(9);
    const customId = (modal.data as { custom_id: string }).custom_id;
    expect(customId).toBe(`cadm:tsuspend:${T1}`);

    fetchSpy.mockResolvedValue(json({ ok: true, data: null }));
    const content = await finished(
      handleConsoleModal(
        customId,
        [{ type: 1, components: [{ type: 4, custom_id: 'reason', value: 'Rain' }] }] as never,
        CONTEXT
      )
    );
    expect(sent(0)).toEqual({ path: '/api/discord/actions/suspendTournament', body: { discordUserId: CALLER, args: [T1, 'Rain'] } });
    expect(content).toContain('Play suspended');
  });

  it('checkin-link answers with the link, ephemerally', async () => {
    fetchSpy.mockResolvedValue(json({ ok: true, data: 'tok-123' }));
    const content = await finished(await tourney('checkin-link', [{ name: 'action', value: 'rotate' }]));
    expect(sent(0).path).toBe('/api/discord/actions/rotateTournamentCheckinToken');
    expect(content).toContain('https://club.example.invalid/tournaments/checkin?token=tok-123');
    expect(content).toContain('old one no longer works');
  });

  it.each([
    ['not_linked', CONSOLE_NOT_LINKED],
    ['passkey_required', CONSOLE_PASSKEY_REQUIRED],
  ])('maps %s as the other console commands do', async (refusal, words) => {
    fetchSpy.mockResolvedValue(json({ ok: false, refusal }));
    expect(await finished(await tourney('resume'))).toBe(words);
  });

  it('shows a coded refusal and hides an uncoded one', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: false, error: 'Tournament is not suspended', code: 'TRN-1' }));
    expect(await finished(await tourney('resume'))).toContain('Tournament is not suspended');
    fetchSpy.mockResolvedValueOnce(json({ ok: false, error: 'duplicate key value violates' }));
    expect(await finished(await tourney('resume'))).toBe('Something went wrong running that in the console.');
  });
});

describe('/tourney pickers', () => {
  function focus(subcommandName: string, name: string, tournament: string) {
    return handleTourneyAutocomplete(
      sub(subcommandName, [
        { name: 'tournament', value: tournament },
        { name, value: 'smi', focused: true },
      ]),
      CONTEXT
    ) as Promise<{ type: number; data: { choices: { name: string; value: string }[] } }>;
  }

  it('lists tournaments for the tournament slot', async () => {
    fetchSpy.mockResolvedValue(json({ ok: true, data: { tournaments: [{ id: T1, label: 'Autumn Classic' }] } }));
    const answer = await handleTourneyAutocomplete(
      sub('resume', [{ name: 'tournament', value: 'aut', focused: true }]),
      CONTEXT
    );
    expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).pathname).toBe('/console/api/discord/reads/tournaments');
    expect(answer).toEqual({ type: 8, data: { choices: [{ name: 'Autumn Classic', value: T1 }] } });
  });

  it.each([
    ['checkin', 'entry', 'tournament-entries', { entries: [{ value: `p:${ENTRY}`, label: 'Smith' }] }, `p:${ENTRY}`],
    ['result', 'match', 'tournament-matches', { matches: [MATCH_ROW] }, MATCH],
    ['fee', 'player', 'tournament-fees', { fees: [{ playerId: PLAYER, label: 'Smith', paid: false }] }, PLAYER],
  ])('%s reads %s from %s, scoped to the picked tournament', async (subcommandName, name, read, data, value) => {
    fetchSpy.mockResolvedValue(json({ ok: true, data }));
    const answer = await focus(subcommandName, name, T1);
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/console/api/discord/reads/${read}`);
    expect(url.searchParams.get('tournamentId')).toBe(T1);
    expect(url.searchParams.get('q')).toBe('smi');
    expect(answer.data.choices[0]?.value).toBe(value);
  });

  it('gives no choices and reads nothing when the tournament is not a uuid', async () => {
    const answer = await focus('result', 'match', 'Autumn Classic');
    expect(answer).toEqual({ type: 8, data: { choices: [] } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
