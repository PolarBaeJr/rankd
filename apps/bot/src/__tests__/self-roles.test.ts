import { describe, it, expect, vi, beforeEach } from 'vitest';

// The self-serve ping roles. What is pinned here is mostly about the two things
// that make this safe rather than the happy path:
//
//   - a button is REVALIDATED against the app, never trusted, because a picker
//     message outlives the configuration behind it;
//   - a sweep-managed role can never become self-serve, because the nightly
//     reconcile would strip it from everyone who clicked and both halves would
//     look broken.

const fetchSelfRoles = vi.fn();
const addSelfRole = vi.fn();
const removeSelfRole = vi.fn();
const addRole = vi.fn();
const removeRole = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchSelfRoles,
  addSelfRole,
  removeSelfRole,
}));

// g1 is one of the club's servers; 'elsewhere' is somebody else's.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig: async () => ({ registry: new Map([['g1', {}]]), auditChannelId: undefined }),
}));

vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    addRole = addRole;
    removeRole = removeRole;
  },
}));

const OFFERED = [
  { roleId: '900', label: 'Competitive nights', emoji: '🏸', sortOrder: 1 },
  { roleId: '901', label: 'Rec nights', emoji: null, sortOrder: 2 },
];

const CTX = { discordUserId: '42', guildId: 'g1' };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  fetchSelfRoles.mockResolvedValue({ roles: OFFERED, truncated: false });
  addRole.mockResolvedValue('ok');
  removeRole.mockResolvedValue('ok');
});

describe('/rolepicker post', () => {
  it('renders one button per offered role, carrying the role id', async () => {
    const { dispatch } = await import('../commands.js');
    const res = (await dispatch('rolepicker', [{ name: 'post', type: 1, options: [] }], CTX)) as {
      data: { components: { components: { custom_id: string; label: string }[] }[] };
    };

    const buttons = res.data.components.flatMap((row) => row.components);
    expect(buttons.map((b) => b.custom_id)).toEqual(['selfrole:900', 'selfrole:901']);
    expect(buttons.map((b) => b.label)).toEqual(['Competitive nights', 'Rec nights']);
  });

  it('splits into rows of five, which is Discord’s hard limit', async () => {
    fetchSelfRoles.mockResolvedValue({
      roles: Array.from({ length: 7 }, (_, i) => ({
        roleId: `r${i}`, label: `Role ${i}`, emoji: null, sortOrder: i,
      })),
      truncated: false,
    });
    const { dispatch } = await import('../commands.js');
    const res = (await dispatch('rolepicker', [{ name: 'post', type: 1, options: [] }], CTX)) as {
      data: { components: { components: unknown[] }[] };
    };

    expect(res.data.components.map((r) => r.components.length)).toEqual([5, 2]);
  });

  it('is PUBLIC — a picker nobody else can click is useless', async () => {
    const { dispatch } = await import('../commands.js');
    const res = (await dispatch('rolepicker', [{ name: 'post', type: 1, options: [] }], CTX)) as {
      data: { flags?: number };
    };
    expect(res.data.flags).toBeUndefined();
  });
});

describe('/rolepicker add', () => {
  it('reads arguments from the SUBCOMMAND, not the top level', async () => {
    // Discord nests them. Reading the outer list finds nothing and looks like
    // the user left a required field blank, which Discord would never allow.
    addSelfRole.mockResolvedValue({ ok: true });
    const { dispatch } = await import('../commands.js');
    await dispatch(
      'rolepicker',
      [{
        name: 'add', type: 1,
        options: [
          { name: 'role', value: '900' },
          { name: 'label', value: 'Competitive nights' },
          { name: 'emoji', value: '🏸' },
          { name: 'order', value: 3 },
        ],
      }],
      CTX
    );

    expect(addSelfRole).toHaveBeenCalledWith({
      guildId: 'g1',
      roleId: '900',
      label: 'Competitive nights',
      emoji: '🏸',
      sortOrder: 3,
    });
  });

  it('explains a sweep-managed role instead of reporting a generic failure', async () => {
    const { SweepManagedRoleError } = await import('../api.js');
    addSelfRole.mockRejectedValue(new SweepManagedRoleError('sweep-managed'));
    const { dispatch } = await import('../commands.js');
    const res = (await dispatch(
      'rolepicker',
      [{ name: 'add', type: 1, options: [
        { name: 'role', value: '900' }, { name: 'label', value: 'Competitive' },
      ] }],
      CTX
    )) as { data: { content: string; flags: number } };

    expect(res.data.flags).toBe(64);
    expect(res.data.content).toContain('nightly sync');
    expect(res.data.content).not.toContain('reach the club app');
  });
});

describe('a picker button', () => {
  it('adds the role when the member does not hold it', async () => {
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:900', CTX, [])) as {
      data: { content: string; flags: number };
    };

    expect(addRole).toHaveBeenCalledWith('g1', '42', '900');
    expect(removeRole).not.toHaveBeenCalled();
    expect(res.data.flags).toBe(64);
    expect(res.data.content).toContain('Added');
  });

  it('removes the role when the member already holds it', async () => {
    const { handleSelfRoleButton } = await import('../commands.js');
    await handleSelfRoleButton('selfrole:900', CTX, ['900', '123']);

    expect(removeRole).toHaveBeenCalledWith('g1', '42', '900');
    expect(addRole).not.toHaveBeenCalled();
  });

  it('REVALIDATES against the app and refuses a role no longer on offer', async () => {
    // The button came from a message that may be months older than the config.
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:999', CTX, [])) as {
      data: { content: string };
    };

    expect(addRole).not.toHaveBeenCalled();
    expect(res.data.content).toContain('not on offer');
  });

  it('names the real cause when the role sits above the bot', async () => {
    // roleCall RESOLVES with an outcome rather than throwing, so a try/catch
    // would have reported this as success.
    addRole.mockResolvedValue('forbidden');
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:900', CTX, [])) as {
      data: { content: string };
    };

    expect(res.data.content).toContain('above my own');
  });

  it('does not claim success when the call merely failed', async () => {
    addRole.mockResolvedValue('failed');
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:900', CTX, [])) as {
      data: { content: string };
    };
    expect(res.data.content).not.toContain('Added');
  });
});

describe('isSelfRoleButton', () => {
  it('claims only its own custom_ids', async () => {
    const { isSelfRoleButton } = await import('../commands.js');
    expect(isSelfRoleButton('selfrole:900')).toBe(true);
    expect(isSelfRoleButton('something-else')).toBe(false);
    expect(isSelfRoleButton(undefined)).toBe(false);
    expect(isSelfRoleButton(null)).toBe(false);
  });
});

describe('/rolepicker outside the club', () => {
  it('says so instead of failing on the write', async () => {
    const { dispatch } = await import('../commands.js');
    const reply = (await dispatch(
      'rolepicker',
      [{ name: 'list', type: 1, options: [] }],
      { discordUserId: '42', guildId: 'elsewhere' }
    )) as { data: { content: string } };
    expect(reply.data.content).toContain("club's own Discord server");
  });
});
