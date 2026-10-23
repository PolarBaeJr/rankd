import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /discord hands an exec the club's invite: the link as text and the same link
// as a QR code. It is the smallest command in the file and the one with the most
// ways to be quietly wrong, so four things are pinned here:
//
//   1. IT NEVER PRINTS A discord.gg CODE. The club's own subdomain is a
//      Cloudflare 301, and that redirect is the whole point: an invite can be
//      rotated without reprinting a poster. A raw code leaking into this reply
//      would be copied onto a slide and outlive the invite it names.
//   2. THE REPLY IS EPHEMERAL. This is the link an exec pastes somewhere
//      deliberately; the bot dropping it into a shared channel on their behalf
//      is the opposite of that.
//   3. A MISSING APP_PUBLIC_URL DEGRADES, IT DOES NOT THROW. Unlike /profile,
//      where the URL is the entire answer, here the link alone still works.
//   4. IT MAKES NO NETWORK CALL. That is what justifies keeping it out of
//      DEFERRED_COMMANDS, so it is asserted rather than assumed.
//
// Deliberately NO vi.mock of ../api.js: the handler imports nothing from it, and
// mocking it would hide exactly the network call assertion 4 exists to catch.

import { COMMAND_DEFINITIONS, DEFERRED_COMMANDS, dispatch } from '../commands.js';

const CTX = { discordUserId: '42', guildId: 'g1' };

type Reply = {
  type: number;
  data: {
    flags?: number;
    embeds?: {
      title?: string;
      color?: number;
      description?: string;
      image?: { url?: string };
      footer?: { text?: string };
    }[];
  };
};

async function run(context: Record<string, unknown> = CTX) {
  return (await dispatch('discord', [], context as never)) as unknown as Reply;
}

beforeEach(() => {
  process.env.APP_PUBLIC_URL = 'https://sfubadminton.com';
});

afterEach(() => {
  delete process.env.APP_PUBLIC_URL;
  vi.unstubAllGlobals();
});

describe('/discord', () => {
  it('replies immediately and only to the caller', async () => {
    const res = await run();

    expect(res.type).toBe(4);
    expect(res.data.flags).toBe(64);
  });

  it('prints the invite link as copyable text', async () => {
    // As well as encoding it in the QR, not instead of: a link can be pasted
    // into a message and a QR code cannot.
    const res = await run();

    expect(res.data.embeds?.[0]?.description).toContain('https://discord.sfubadminton.com');
  });

  // THE TRIPWIRE. It reads the whole serialised reply, not just the
  // description, because a discord.gg code could arrive in a title, a footer or
  // an image URL just as easily. If this ever fails, somebody has removed the
  // indirection layer that lets the club rotate its invite.
  it('never leaks a raw discord.gg code anywhere in the reply', async () => {
    expect(JSON.stringify(await run())).not.toContain('discord.gg');
  });

  it('points the embed image at the QR the player app serves', async () => {
    const res = await run();

    // Written out in full rather than built from the base, so a base with a
    // trailing slash cannot make this pass by agreeing with itself.
    expect(res.data.embeds?.[0]?.image?.url).toBe('https://sfubadminton.com/qr/discord.png');
  });

  it('still answers with the link when APP_PUBLIC_URL is unset', async () => {
    // Degrades to a link rather than to an apology: there is no image to point
    // at, and the useful half of this reply was never the picture.
    delete process.env.APP_PUBLIC_URL;

    const res = await run();

    expect(res.type).toBe(4);
    expect(res.data.embeds?.[0]?.image).toBeUndefined();
    expect(res.data.embeds?.[0]?.description).toContain('https://discord.sfubadminton.com');
  });

  it('makes no network call at all', async () => {
    // Not a detail: this is the entire argument for the command staying
    // undeferred. A fetch that throws is louder than a spy that only counts,
    // because it would also fail whatever the handler tried to do with it.
    const fetchSpy = vi.fn(() => {
      throw new Error('/discord must not make a network call');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await run();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the command definition', () => {
  const def = COMMAND_DEFINITIONS.find((c) => c.name === 'discord') as {
    default_member_permissions?: string;
    dm_permission?: boolean;
    options: unknown[];
  };

  it('is open to every member, like /socials', () => {
    expect(def).toBeDefined();
    expect(def.default_member_permissions).toBeUndefined();
  });

  it('takes no options, because the club has one invite', () => {
    // Pins a deliberate constraint, not an oversight. An option or a subcommand
    // here would only make room for a second invite to exist.
    expect(def.options).toEqual([]);
  });

  it('is not deferred, because there is nothing to wait for', () => {
    expect(DEFERRED_COMMANDS.has('discord')).toBe(false);
  });
});
