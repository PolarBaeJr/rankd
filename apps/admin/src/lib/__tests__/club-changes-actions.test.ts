import { describe, it, expect, beforeEach, vi } from 'vitest';

// THE CLUB CHANGES ACTIONS (00286). Every parameter is a POST field, the text
// of a posted line comes from the server's own read of the drafts, and an
// announcement that cannot go out is refused before anything is written.

type Row = Record<string, unknown>;

const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const K_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const UNKNOWN_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const SEEDED_ID = 'bbbbbbbb-0000-4000-8000-000000000003';
const MANUAL_ID = 'bbbbbbbb-0000-4000-8000-000000000004';

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  actor: {} as Row,
  rpcCalls: [] as { name: string; args: Row }[],
  rpcError: null as { message: string } | null,
  announcements: [] as Row[],
  announceThrows: false,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let payload: Row = {};
    const matching = () => (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        (store.db[table] ??= []).push({ id: `new-${(store.db[table] ?? []).length}`, ...payload });
        return { data: [payload], error: null };
      }
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      if (op === 'delete') {
        const hit = matching();
        store.db[table] = (store.db[table] ?? []).filter((r) => !hit.includes(r));
        return { data: hit, error: null };
      }
      return { data: matching(), error: null };
    };
    const api = {
      select() { return api; },
      order() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      async maybeSingle() { const res = run(); return { data: res.data?.[0] ?? null, error: res.error }; },
      async single() { const res = run(); return { data: res.data?.[0] ?? null, error: res.error }; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return {
    from: (table: string) => query(table),
    rpc: async (name: string, args: Row) => {
      store.rpcCalls.push({ name, args });
      if (store.rpcError) return { data: null, error: store.rpcError };
      return { data: 'eeeeeeee-0000-4000-8000-000000000001', error: null };
    },
  };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('server-only', () => ({}));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({ requireCapability: async () => store.actor }));
vi.mock('../actions/announcements', () => ({
  createAnnouncement: async (data: Row) => {
    if (store.announceThrows) throw new Error('push service down');
    const row = { id: 'cccccccc-0000-4000-8000-000000000001', ...data };
    store.announcements.push(row);
    return row;
  },
}));

import {
  addClubChangeLine,
  announceClubChangeEntry,
  deleteClubChangeLine,
  postClubChanges,
  rewordClubChangeLine,
} from '../actions/club-changes';

function draft(overrides: Row): Row {
  return {
    source: 'setting',
    subject: 'rating_defaults',
    field: 'singles_k_established',
    from_value: 32,
    to_value: 24,
    text_override: null,
    override_to_value: null,
    first_actor_id: ADMIN_ID,
    last_actor_id: ADMIN_ID,
    revision: 3,
    created_at: '2026-10-08T00:00:00Z',
    changed_at: '2026-10-08T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  store.actor = { id: ADMIN_ID, role: 'admin' };
  store.rpcCalls = [];
  store.rpcError = null;
  store.announcements = [];
  store.announceThrows = false;
  store.db = {
    club_change_drafts: [
      draft({ id: K_ID }),
      draft({ id: UNKNOWN_ID, field: 'secret_knob', revision: 1 }),
      draft({ id: SEEDED_ID, subject: 'features', field: 'challenges_enabled', from_value: null, to_value: true, revision: 1 }),
      draft({ id: MANUAL_ID, source: 'manual', subject: null, field: null, from_value: null, to_value: null, text_override: 'Courts 3 and 4 are doubles only.', revision: 1 }),
    ],
    club_change_entries: [],
    seasons: [{ id: 'season-1', active_flag: true }],
    audit_logs: [],
  };
});

describe('postClubChanges', () => {
  it('posts the server sentence, never text from the client, and discards no-op lines', async () => {
    const res = await postClubChanges({
      items: [{ id: K_ID, revision: 3 }, { id: MANUAL_ID, revision: 1 }],
      announce: false,
      // A forged field a client could add. It must be ignored.
      ...({ lines: ['Free money for everyone'] } as object),
    });
    expect(res.ok).toBe(true);
    expect(store.rpcCalls).toHaveLength(1);
    const args = store.rpcCalls[0]!.args;
    expect(args.p_lines).toEqual([
      'Singles K-factor (established players) changed from 32 to 24',
      'Courts 3 and 4 are doubles only.',
    ]);
    expect(args.p_revisions).toEqual([3, 1]);
    expect(args.p_discard_ids).toEqual([SEEDED_ID]);
    expect(args.p_actor).toBe(ADMIN_ID);
  });

  it('refuses a line whose revision moved since the page loaded', async () => {
    const res = await postClubChanges({ items: [{ id: K_ID, revision: 2 }], announce: false });
    expect(res.ok).toBe(false);
    expect(store.rpcCalls).toHaveLength(0);
  });

  it('refuses an unknown line until it is reworded', async () => {
    const res = await postClubChanges({ items: [{ id: UNKNOWN_ID, revision: 1 }], announce: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/needs wording/);
    expect(store.rpcCalls).toHaveLength(0);
  });

  it('refuses a malformed id', async () => {
    const res = await postClubChanges({ items: [{ id: "x' OR 1=1", revision: 1 }], announce: false });
    expect(res.ok).toBe(false);
    expect(store.rpcCalls).toHaveLength(0);
  });

  it('maps a stale refusal from the database to a sentence', async () => {
    store.rpcError = { message: 'stale_changed: a line changed since the page loaded' };
    const res = await postClubChanges({ items: [{ id: K_ID, revision: 3 }], announce: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Reload the page/);
  });

  it('refuses the announcement before posting when the viewer cannot announce', async () => {
    store.actor = {
      id: ADMIN_ID,
      role: 'player',
      is_exec: true,
      permission_role: 'custom',
      permission_grants: ['changelog.page', 'changelog.post.write'],
      permission_revokes: ['announcements.create.write'],
    };
    const res = await postClubChanges({ items: [{ id: K_ID, revision: 3 }], announce: true });
    expect(res.ok).toBe(false);
    expect(store.rpcCalls).toHaveLength(0);
  });

  it('refuses the announcement before posting when no season is running', async () => {
    store.db.seasons = [];
    const res = await postClubChanges({ items: [{ id: K_ID, revision: 3 }], announce: true });
    expect(res.ok).toBe(false);
    expect(store.rpcCalls).toHaveLength(0);
  });

  it('announces to everyone and links the announcement to the entry', async () => {
    store.db.club_change_entries = [{ id: 'eeeeeeee-0000-4000-8000-000000000001', announcement_id: null }];
    const res = await postClubChanges({
      items: [{ id: K_ID, revision: 3 }],
      title: 'Ratings update',
      intro: 'Two changes this week.',
      announce: true,
    });
    expect(res.ok && res.data.announced).toBe(true);
    expect(store.announcements[0]).toMatchObject({
      title: 'Ratings update',
      target_audience: 'all',
      status: 'published',
      body: 'Two changes this week.\n\n- Singles K-factor (established players) changed from 32 to 24',
    });
    expect(store.db.club_change_entries![0]!.announcement_id).toBe('cccccccc-0000-4000-8000-000000000001');
  });

  it('keeps the entry when the announcement fails, and says so', async () => {
    store.announceThrows = true;
    const res = await postClubChanges({ items: [{ id: K_ID, revision: 3 }], announce: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ announced: false, announceFailed: true });
  });
});

describe('the pending lines', () => {
  it('adds a trimmed manual line and refuses an empty or overlong one', async () => {
    expect((await addClubChangeLine('  New   shuttles from Monday.  ')).ok).toBe(true);
    expect(store.db.club_change_drafts!.at(-1)).toMatchObject({ source: 'manual', text_override: 'New shuttles from Monday.' });
    expect((await addClubChangeLine('   ')).ok).toBe(false);
    expect((await addClubChangeLine('x'.repeat(301))).ok).toBe(false);
  });

  it('rewords a line against the value the admin saw, and bumps its revision', async () => {
    expect((await rewordClubChangeLine(K_ID, 'Established players now move a little slower.')).ok).toBe(true);
    expect(store.db.club_change_drafts![0]).toMatchObject({
      text_override: 'Established players now move a little slower.',
      override_to_value: 24,
      revision: 4,
    });
    expect((await rewordClubChangeLine(K_ID, '')).ok).toBe(true);
    expect(store.db.club_change_drafts![0]).toMatchObject({ text_override: null, override_to_value: null });
  });

  it('will not empty a line that was added by hand', async () => {
    expect((await rewordClubChangeLine(MANUAL_ID, '')).ok).toBe(false);
  });

  it('deletes a line and records it', async () => {
    expect((await deleteClubChangeLine(K_ID)).ok).toBe(true);
    expect(store.db.club_change_drafts!.some((r) => r.id === K_ID)).toBe(false);
    expect(store.db.audit_logs![0]).toMatchObject({ action_type: 'club_change_draft_deleted', target_id: K_ID });
    expect((await deleteClubChangeLine(K_ID)).ok).toBe(false);
  });
});

describe('announceClubChangeEntry', () => {
  it('announces an entry once, and refuses a second time', async () => {
    store.db.club_change_entries = [
      { id: 'eeeeeeee-0000-4000-8000-000000000002', title: null, intro: null, lines: ['A line.'], announcement_id: null },
    ];
    expect((await announceClubChangeEntry('eeeeeeee-0000-4000-8000-000000000002')).ok).toBe(true);
    expect(store.announcements[0]).toMatchObject({ title: 'Club changes', body: '- A line.' });
    expect((await announceClubChangeEntry('eeeeeeee-0000-4000-8000-000000000002')).ok).toBe(false);
  });
});
