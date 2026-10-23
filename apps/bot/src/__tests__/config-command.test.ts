import { describe, it, expect, vi, beforeEach } from 'vitest';

// /config is the answer to "it is set up but nothing posts".
//
// Every relay reads discord_settings; nothing ever wrote it. The table is
// service-role only, so no member-facing page can reach it, and /setup stops at
// roles and the audit channel. Worse, an unconfigured relay is indistinguishable
// from a working one from outside — it runs on schedule, answers 200 and posts
// nothing. So `show` has to say why each one is quiet, and `channels` has to
// make the one failure that would otherwise be silent forever loud immediately.

// vi.hoisted, not bare consts: this file imports COMMANDS statically so the
// mock factories run during hoisting, before a plain `const` would have been
// initialised.
const { fetchDiscordSettings, writeDiscordSettings, createMessage, checkDiscordManager } = vi.hoisted(() => ({
  checkDiscordManager: vi.fn(),
  fetchDiscordSettings: vi.fn(),
  writeDiscordSettings: vi.fn(),
  createMessage: vi.fn(),
}));

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchDiscordSettings,
  writeDiscordSettings,
  checkDiscordManager,
  fetchServerSettings: async () => ({ servers: [] }),
}));

// g1 is one of the club's servers, where the club's relays are configured.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig: async () => ({ registry: new Map([['g1', {}]]), auditChannelId: undefined }),
}));

vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    createMessage = createMessage;
  },
}));

import { COMMAND_DEFINITIONS, DEFERRED_COMMANDS, dispatch } from '../commands.js';
import { CHANNEL_SETTINGS, VALUE_SETTINGS, ALL_SETTINGS } from '../settings.js';

const CTX = { discordUserId: '42', guildId: 'g1' };
// Who the app is asked about, and what every write carries.
const MANAGER = { discordUserId: '42', guildId: 'g1' };
const CHANNEL = '123456789012345678';

interface Reply {
  type: number;
  data: { content?: string; embeds?: { description?: string; footer?: { text: string } }[] };
}

/** Run a /config subcommand the way Discord delivers one: nested under type 1. */
async function run(sub: string, args: { name: string; type: number; value: unknown }[] = []) {
  const response = (await dispatch(
    'config',
    [{ name: sub, type: 1, options: args }] as never,
    CTX
  )) as unknown as Reply;
  return { ...response, data: response.data ?? {} };
}

function description(reply: Reply): string {
  return reply.data.embeds?.[0]?.description ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'token';
  fetchDiscordSettings.mockResolvedValue({ settings: {} });
  checkDiscordManager.mockResolvedValue(null);
  writeDiscordSettings.mockResolvedValue({ ok: true, written: 1, cleared: 0 });
  createMessage.mockResolvedValue(true);
});

describe('/config show', () => {
  it('says what each unset relay is NOT doing, not just that it is unset', async () => {
    // THE WHOLE REASON THE SUBCOMMAND EXISTS. "announcement_channel_id: unset"
    // is a fact about a database; "club announcements are not relayed" is the
    // thing the club was trying to find out, and the reason five relays sat
    // dead without anybody noticing.
    const reply = await run('show');

    const text = description(reply);
    expect(text).toContain('club announcements are not relayed');
    expect(text).toContain('nobody is pinged before a session');
    expect(text).toContain('finished matches are not posted');
  });

  it('renders a set channel as a channel mention', async () => {
    fetchDiscordSettings.mockResolvedValue({ settings: { announcement_channel_id: CHANNEL } });

    const text = description(await run('show'));

    expect(text).toContain(`<#${CHANNEL}>`);
    expect(text).not.toContain('club announcements are not relayed');
  });

  it('says out loud that tournaments do not have a channel', async () => {
    // The one exception in the whole feature, and the question this command
    // will otherwise be asked next: that relay makes Discord scheduled events
    // rather than posting messages, so it runs with nothing configured here.
    const reply = await run('show');
    expect(reply.data.embeds?.[0]?.footer?.text).toContain('not messages');
  });

  it('is only ever shown to the caller', async () => {
    // Channel ids are not secret, but this is server administration and the
    // reply is long. Ephemeral for the same reason /setup's is.
    expect((await run('show')).data.embeds).toBeDefined();
    expect((await run('show')) as unknown as { data: { flags?: number } }).toMatchObject({
      data: { flags: 64 },
    });
  });
});

describe('/config channels', () => {
  it('proves it can post before saving, by posting', async () => {
    await run('channels', [{ name: 'announcements', type: 7, value: CHANNEL }]);

    expect(createMessage).toHaveBeenCalledWith(CHANNEL, expect.objectContaining({
      content: expect.stringContaining('Announcements'),
    }));
    expect(writeDiscordSettings).toHaveBeenCalledWith({ announcement_channel_id: CHANNEL }, MANAGER);
  });

  it('SAVES NOTHING for a channel it cannot post in', async () => {
    // The failure this whole probe exists to stop. Discord's picker offers
    // channels by what the CALLER can see, not by what the bot can write to,
    // so a reasonable choice can be one the bot has no Send Messages in — and
    // every relay treats a failed post as transient and retries on the next
    // tick, quietly, for as long as the setting stands.
    createMessage.mockResolvedValue(false);

    const reply = await run('channels', [{ name: 'announcements', type: 7, value: CHANNEL }]);

    expect(writeDiscordSettings).not.toHaveBeenCalled();
    expect(reply.data.content).toContain('could not post');
    expect(reply.data.content).toContain('Send Messages');
  });

  it('keeps the channels that worked when one of them did not', async () => {
    // Partial rather than all-or-nothing, deliberately: a club changing three
    // channels and getting one wrong should not have to redo the two that were
    // fine, and the one that failed is named.
    createMessage.mockImplementation(async (channelId: string) => channelId !== '999999999999999999');

    const reply = await run('channels', [
      { name: 'announcements', type: 7, value: CHANNEL },
      { name: 'match_results', type: 7, value: '999999999999999999' },
    ]);

    expect(writeDiscordSettings).toHaveBeenCalledWith({ announcement_channel_id: CHANNEL }, MANAGER);
    expect(reply.data.content).toContain('Match results');
  });

  it('never pings anyone with its confirmation', async () => {
    // This lands in a channel the club just pointed a relay at. A setup note
    // that @-mentioned a role would be a poor introduction, and allowed_mentions
    // is the only thing that stops it — Discord parses mentions by default.
    await run('channels', [{ name: 'announcements', type: 7, value: CHANNEL }]);

    expect(createMessage).toHaveBeenCalledWith(
      CHANNEL,
      expect.objectContaining({ allowed_mentions: { parse: [] } })
    );
  });

  it('asks for a channel rather than reporting success over an empty payload', async () => {
    const reply = await run('channels');

    expect(writeDiscordSettings).not.toHaveBeenCalled();
    expect(reply.data.content).toContain('at least one');
  });
});

describe('/config ping_lead', () => {
  it('saves the lead time', async () => {
    const reply = await run('ping_lead', [{ name: 'ping_lead_minutes', type: 4, value: 90 }]);

    expect(writeDiscordSettings).toHaveBeenCalledWith({ session_ping_lead_minutes: '90' }, MANAGER);
    expect(reply.data.content).toContain('90');
  });

  it('refuses a lead time the ping job cannot hit, before the app sees it', async () => {
    const reply = await run('ping_lead', [{ name: 'ping_lead_minutes', type: 4, value: 2 }]);

    expect(writeDiscordSettings).not.toHaveBeenCalled();
    expect(reply.data.content).toContain('between 5 and 1440');
  });
});

describe('/config no longer sets tournament times', () => {
  it('has no tournament subcommand, and /config show does not list those settings', async () => {
    // Each tournament keeps its own times and location since 00304. Listing a
    // club-wide "not set, so events start at 09:00" here would be wrong.
    const config = COMMAND_DEFINITIONS.find((c) => c.name === 'config');
    const names = (config?.options as { name: string }[]).map((o) => o.name);
    expect(names).not.toContain('tournament');

    const reply = await run('show');
    const text = description(reply);
    expect(text).not.toContain('Tournament start time');
    expect(text).not.toContain('events start at 09:00');
    expect(reply.data.embeds?.[0]?.footer?.text).toContain('/tourney details');
  });
});

describe('/config clear', () => {
  it('sends null, which is what DELETES the row', async () => {
    // An empty string is not "unset": it survives the `?? null` two of the
    // relay routes use, and they would post to a channel id of ''.
    await run('clear', [{ name: 'setting', type: 3, value: 'announcements' }]);

    expect(writeDiscordSettings).toHaveBeenCalledWith({ announcement_channel_id: null }, MANAGER);
  });

  it('says what stops happening, not that something was cleared', async () => {
    const reply = await run('clear', [{ name: 'setting', type: 3, value: 'session_pings' }]);
    expect(reply.data.content).toContain('nobody is pinged before a session');
  });
});

describe('/config ping_roles', () => {
  // The ping job reads these keys before the /rolepicker fallback. Without this
  // subcommand the only way to set them was hand-written SQL on production.
  it('sets all three groups from every_session', async () => {
    await run('ping_roles', [{ name: 'every_session', type: 8, value: '1547801288119558234' }]);
    expect(writeDiscordSettings).toHaveBeenCalledWith({
      session_ping_all_role_id: '1547801288119558234',
      session_ping_competitive_role_id: '1547801288119558234',
      session_ping_recreational_role_id: '1547801288119558234',
    }, MANAGER);
  });

  it('lets a specific group override every_session', async () => {
    await run('ping_roles', [
      { name: 'every_session', type: 8, value: '11111111111111111' },
      { name: 'competitive', type: 8, value: '22222222222222222' },
    ]);
    expect(writeDiscordSettings).toHaveBeenCalledWith({
      session_ping_all_role_id: '11111111111111111',
      session_ping_competitive_role_id: '22222222222222222',
      session_ping_recreational_role_id: '11111111111111111',
    }, MANAGER);
  });

  it('writes nothing when no role was picked', async () => {
    const reply = await run('ping_roles');
    expect(writeDiscordSettings).not.toHaveBeenCalled();
    expect(reply.data.content).toContain('Pick at least one role');
  });

  it('shows the configured roles in /config show', async () => {
    fetchDiscordSettings.mockResolvedValue({
      settings: { session_ping_competitive_role_id: '22222222222222222' },
    });
    const reply = await run('show');
    const text = JSON.stringify(reply.data);
    expect(text).toContain('<@&22222222222222222>');
    expect(text).toContain('club-wide sessions ping nobody');
  });
});

describe('the command definition', () => {
  it('offers a picker for every channel setting, and only text channels', async () => {
    // Built from CHANNEL_SETTINGS rather than typed out, so a setting cannot
    // appear in /config show and be missing from the thing that sets it. Asserted
    // because the generated shape is the kind that silently loses an entry.
    const config = COMMAND_DEFINITIONS.find((c) => c.name === 'config');
    const channels = (config?.options as { name: string; options?: unknown[] }[]).find(
      (o) => o.name === 'channels'
    );
    const opts = channels?.options as { name: string; type: number; channel_types: number[] }[];

    expect(opts.map((o) => o.name)).toEqual(CHANNEL_SETTINGS.map((s) => s.option));
    for (const o of opts) {
      expect(o.type, o.name).toBe(7);
      // A voice channel or a category would be offered by the picker and then
      // fail on the first message the relay tried to post.
      expect(o.channel_types, o.name).toEqual([0, 5]);
    }
  });

  it('names the ping_lead options exactly as the specs do', async () => {
    // THE DRIFT THIS DESIGN IS EXPOSED TO. These options are typed out rather
    // than generated (they have per-option types and bounds), while the handler
    // reads them back by spec.option. A rename on one side and not the other is
    // silent twice over: the handler finds nothing to save, and validateValue's
    // `default: return null` waves the unknown option through, so the app's 400
    // reaches the member as "couldn't reach the club app".
    const config = COMMAND_DEFINITIONS.find((c) => c.name === 'config');
    const pingLead = (config?.options as { name: string; options?: unknown[] }[]).find(
      (o) => o.name === 'ping_lead'
    );
    const opts = pingLead?.options as { name: string }[];

    expect(opts.map((o) => o.name)).toEqual(VALUE_SETTINGS.map((s) => s.option));
  });

  it('lets every setting be cleared, including the ones /config channels sets', async () => {
    const config = COMMAND_DEFINITIONS.find((c) => c.name === 'config');
    const clear = (config?.options as { name: string; options?: unknown[] }[]).find(
      (o) => o.name === 'clear'
    );
    const choices = (clear?.options as { choices: { value: string }[] }[])[0].choices;

    expect(choices.map((c) => c.value)).toEqual(ALL_SETTINGS.map((s) => s.option));
  });

  it('is deferred, because it posts to Discord before it answers', async () => {
    // /config channels sends a message to every channel it was given and then
    // writes to the app. Three seconds is not enough, and the failure is
    // Discord telling the member the application did not respond.
    expect(DEFERRED_COMMANDS.has('config')).toBe(true);
  });
});

describe('/config answers to the club, not to Discord admin rights', () => {
  it('asks the app about the caller and the server before anything else', async () => {
    await run('show');
    expect(checkDiscordManager).toHaveBeenCalledWith(MANAGER);
  });

  it.each([
    ['not_linked', '/link'],
    ['not_permitted', 'Only club execs'],
    ['server_not_connected', 'not connected to the club'],
  ])('refuses %s and changes nothing', async (refusal, words) => {
    checkDiscordManager.mockResolvedValue(refusal);
    const reply = await run('channels', [{ name: 'announcements', type: 7, value: CHANNEL }]);
    expect(reply.data.content).toContain(words);
    expect(writeDiscordSettings).not.toHaveBeenCalled();
    expect(fetchDiscordSettings).not.toHaveBeenCalled();
  });
});
