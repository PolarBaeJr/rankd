// The forms the console makes (00296). The database is an in-memory fake,
// Google and the form maker a fake fetch. What matters: unconfigured nothing
// is read; a Form bound by hand is never touched; one claim makes one Form;
// a refusal leaves no binding; a Form that does not check out is bound OFF;
// a sync calls the maker only for what changed; a deleted target's Form is
// closed; a sync never throws; and no hook changes the result of the
// event's own action.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const captured: unknown[] = [];
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn((err: unknown) => captured.push(err)),
  captureMessage: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const afterCallbacks: (() => unknown)[] = [];
vi.mock('next/server', () => ({
  after: vi.fn((cb: () => unknown) => {
    afterCallbacks.push(cb);
  }),
}));

let allowed = true;
vi.mock('../permissions', () => ({
  accessLevelFor: vi.fn(() => 'exec'),
  permissionsOf: vi.fn(() => []),
  permits: vi.fn(() => allowed),
}));

const audits: { action_type: string; target_id?: unknown; new_value?: unknown }[] = [];
vi.mock('../audit', () => ({
  logAdminAudit: vi.fn(async (_client: unknown, entry: { action_type: string }) => {
    audits.push(entry);
  }),
}));

const capabilities: string[] = [];
vi.mock('../actions/_shared', () => ({
  requireCapability: vi.fn(async (capability: string) => {
    capabilities.push(capability);
    return { id: ACTOR };
  }),
}));
vi.mock('../notify', () => ({ notifyPlayers: vi.fn(async () => undefined) }));

// ---- the fake database --------------------------------------------------------

type Row = Record<string, unknown>;
let db: Record<string, Row[]>;
let dbCalls: number;
/** Tables whose reads answer an error. */
let failing: Set<string>;
/** A row another replica claims just before this one's insert. */
let raceRow: Row | null;
let accepting: { accepting: boolean; reason: string | null };
let nextId: number;

const MANAGED_TARGET_COLUMNS = ['club_event_id', 'tournament_id'];

function fakeAdmin() {
  return {
    from(table: string) {
      dbCalls += 1;
      const filters: ((row: Row) => boolean)[] = [];
      let op: 'select' | 'insert' | 'update' = 'select';
      let values: Row = {};
      let limit = Infinity;
      const exec = () => {
        const rows = (db[table] ??= []);
        if (failing.has(table)) return { data: null, error: { message: 'boom', code: 'XX000' } };
        if (op === 'insert') {
          if (table === 'managed_registration_forms') {
            if (raceRow) {
              rows.push(raceRow);
              raceRow = null;
            }
            const clash = rows.some(
              (r) =>
                r.state !== 'retired' &&
                MANAGED_TARGET_COLUMNS.some((c) => values[c] != null && r[c] === values[c]),
            );
            if (clash) return { data: null, error: { message: 'duplicate', code: '23505' } };
          }
          const row: Row = { id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, ...values };
          if (table === 'managed_registration_forms') {
            for (const column of [
              'binding_id',
              'form_id',
              'responder_url',
              'edit_url',
              'template_waiver_version',
              'accepting',
              'close_reason',
              'closed_at',
              'synced_fingerprint',
              'synced_at',
              'last_error',
            ]) {
              row[column] ??= null;
            }
          }
          if (table === 'registration_import_forms') row.read_mapping ??= null;
          rows.push(row);
          return { data: [{ ...row }], error: null };
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (op === 'update') {
          for (const r of matched) Object.assign(r, values);
          return { data: matched.map((r) => ({ ...r })), error: null };
        }
        return { data: matched.slice(0, limit).map((r) => ({ ...r })), error: null };
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => (filters.push((r) => r[column] === value), chain),
        neq: (column: string, value: unknown) => (filters.push((r) => r[column] !== value), chain),
        in: (column: string, list: unknown[]) => (filters.push((r) => list.includes(r[column])), chain),
        is: (column: string, value: unknown) => (filters.push((r) => (r[column] ?? null) === value), chain),
        order: () => chain,
        limit: (n: number) => ((limit = n), chain),
        insert: (v: Row) => ((op = 'insert'), (values = v), chain),
        update: (v: Row) => ((op = 'update'), (values = v), chain),
        delete: () => chain,
        maybeSingle: async () => {
          const result = exec();
          return result.error ? result : { data: result.data![0] ?? null, error: null };
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(exec()).then(resolve, reject),
      };
      return chain;
    },
    rpc: async (fn: string) => {
      dbCalls += 1;
      if (fn === 'registration_form_accepting') {
        if (failing.has('rpc')) return { data: null, error: { message: 'boom' } };
        return { data: [accepting], error: null };
      }
      return { data: null, error: null };
    },
  };
}

vi.mock('../supabase-server', () => ({ createAdminClient: () => fakeAdmin() }));

const managed = await import('../managed-forms');
const actions = await import('../actions/managed-forms');
const { createClubEvent } = await import('../actions/club-events');
const { resetGoogleTokenCache, GOOGLE_TOKEN_URL, GOOGLE_FORMS_API } = await import('../google-forms');
const { FORM_MAKER_CONSUMER_NAME, TEMPLATE_TITLES, managedMapping } = await import('../managed-form-content');

// ---- Google and the maker -----------------------------------------------------

const ACTOR = '00000000-0000-4000-8000-00000000a001';
const EVENT = '00000000-0000-4000-8000-00000000e001';
const CONSUMER = '00000000-0000-4000-8000-00000000c001';
const MAKER_URL = 'https://script.google.com/macros/s/fake/exec';
const SECRET = 'x'.repeat(48);
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'reader@example.com',
  private_key: PEM,
  private_key_id: 'kid',
});
const ENV = {
  GOOGLE_FORM_MAKER_URL: MAKER_URL,
  GOOGLE_FORM_MAKER_SECRET: SECRET,
  GOOGLE_FORMS_SERVICE_ACCOUNT_JSON: KEY,
};

const ALL_TITLES = [
  TEMPLATE_TITLES.common.name,
  TEMPLATE_TITLES.common.email,
  TEMPLATE_TITLES.common.waiver,
  TEMPLATE_TITLES.common.signature,
  TEMPLATE_TITLES.common.media,
  TEMPLATE_TITLES.common.receipt,
];

let makerCalls: Record<string, unknown>[];
let makerReply: (body: Record<string, unknown>) => Response | Promise<Response>;
let formTitles: string[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const CREATED = {
  ok: true,
  formId: 'made_form_1',
  responderUrl: 'https://docs.google.com/forms/d/e/abc/viewform',
  editUrl: 'https://docs.google.com/forms/d/made_form_1/edit',
  accepting: true,
  waiverVersion: '2026-09',
};

function deps(env: Record<string, string | undefined> = ENV) {
  return {
    env,
    now: () => Date.parse('2026-10-21T12:00:00Z'),
    sleep: vi.fn(async () => undefined),
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      if (url === GOOGLE_TOKEN_URL) return json({ access_token: 'tok', expires_in: 3600 });
      if (url.startsWith(GOOGLE_FORMS_API)) {
        return json({
          items: formTitles.map((title, i) => ({ title, questionItem: { question: { questionId: `q${i}` } } })),
        });
      }
      if (url === MAKER_URL) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        makerCalls.push(body);
        return makerReply(body);
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  };
}

const actions_ = () => makerCalls.map((c) => c.action);
const managedRows = () => db.managed_registration_forms ?? [];
const bindings = () => db.registration_import_forms ?? [];

beforeEach(() => {
  resetGoogleTokenCache();
  db = {
    club_events: [
      {
        id: EVENT,
        title: 'Social night',
        description: 'Bring shoes.',
        location: 'Gym',
        starts_at: '2026-11-03T02:00:00Z',
        cost_cents: 500,
        status: 'published',
      },
    ],
    platform_settings: [{ key: 'membership_payments', value: { etransfer_email: 'pay@example.org' } }],
    data_api_consumers: [{ id: CONSUMER, name: FORM_MAKER_CONSUMER_NAME }],
    registration_import_forms: [],
    managed_registration_forms: [],
  };
  dbCalls = 0;
  failing = new Set();
  raceRow = null;
  accepting = { accepting: true, reason: null };
  nextId = 1;
  makerCalls = [];
  makerReply = (body) => json(body.action === 'create' ? CREATED : { ok: true });
  formTitles = [...ALL_TITLES];
  audits.length = 0;
  captured.length = 0;
  capabilities.length = 0;
  afterCallbacks.length = 0;
  allowed = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function makeLive() {
  expect(await managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, deps())).toBe('created');
  makerCalls = [];
  audits.length = 0;
  return managedRows()[0]! as unknown as Parameters<typeof managed.syncManagedForm>[1];
}

// ---- making -------------------------------------------------------------------

describe('ensureManagedForm', () => {
  it('reads nothing and calls nobody without a form maker', async () => {
    const d = deps({ GOOGLE_FORMS_SERVICE_ACCOUNT_JSON: KEY });
    expect(await managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, d)).toBe('not_configured');
    expect(dbCalls).toBe(0);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('leaves a target with a Form bound by hand alone', async () => {
    db.registration_import_forms!.push({ id: 'hand', club_event_id: EVENT, target_kind: 'club_event' });
    expect(await managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, deps())).toBe('skipped');
    expect(makerCalls).toEqual([]);
    expect(managedRows()).toEqual([]);
  });

  it('fails closed when the bindings cannot be read', async () => {
    failing.add('registration_import_forms');
    await expect(managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, deps())).rejects.toThrow();
    expect(makerCalls).toEqual([]);
  });

  it('is busy while a fresh claim is being made', async () => {
    db.managed_registration_forms!.push({
      id: 'r1',
      target_kind: 'club_event',
      club_event_id: EVENT,
      state: 'creating',
      generation: 1,
      claimed_at: '2026-10-21T11:59:00Z',
    });
    expect(await managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, deps())).toBe('busy');
    expect(makerCalls).toEqual([]);
  });

  it('answers exists when another replica claimed and finished first', async () => {
    raceRow = { id: 'r1', target_kind: 'club_event', club_event_id: EVENT, state: 'live', generation: 1 };
    expect(await managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, deps())).toBe('exists');
    expect(makerCalls).toEqual([]);
    expect(managedRows()).toHaveLength(1);
  });

  it('a refusal from the maker is recorded and leaves no binding', async () => {
    makerReply = () => json({ ok: false, code: 'template_missing' });
    expect(await managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, deps())).toBe('failed');
    expect(managedRows()[0]).toMatchObject({ state: 'failed', last_error: 'template_missing', claimed_at: null });
    expect(bindings()).toEqual([]);
    // The setup's to fix, said on the card: not a fault.
    expect(captured).toEqual([]);
  });

  it('a paid event with no e-transfer email asks nobody', async () => {
    db.platform_settings = [];
    expect(await managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, deps())).toBe('failed');
    expect(managedRows()[0]).toMatchObject({ state: 'failed', last_error: 'etransfer_unset' });
    expect(makerCalls).toEqual([]);
  });

  it('a Form missing a question it reads is bound off, with no mapping', async () => {
    formTitles = ALL_TITLES.filter((t) => t !== TEMPLATE_TITLES.common.signature);
    expect(await managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, deps())).toBe('unverified');
    expect(bindings()).toHaveLength(1);
    expect(bindings()[0]).toMatchObject({ active: false, form_id: 'made_form_1', read_mapping: null });
    expect(managedRows()[0]).toMatchObject({ state: 'unverified', last_error: 'questions_missing' });
  });

  it('an empty template waiver version is not verified', async () => {
    makerReply = (body) => json(body.action === 'create' ? { ...CREATED, waiverVersion: '' } : { ok: true });
    expect(await managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, deps())).toBe('unverified');
    expect(managedRows()[0]).toMatchObject({ state: 'unverified', last_error: 'waiver_version_unset' });
    expect(bindings()[0]).toMatchObject({ active: false });
  });

  it('makes, binds on, maps and audits a Form that checks out', async () => {
    expect(await managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, deps())).toBe('created');
    expect(makerCalls).toHaveLength(1);
    expect(makerCalls[0]).toMatchObject({
      action: 'create',
      requestKey: `club_event:${EVENT}:1`,
      template: 'club_event',
      title: 'Social night',
      accepting: true,
      choices: null,
      secret: SECRET,
    });
    expect((makerCalls[0]!.payment as { text: string }).text).toContain('pay@example.org');
    expect(bindings()[0]).toMatchObject({
      active: true,
      consumer_id: CONSUMER,
      form_id: 'made_form_1',
      read_mapping: managedMapping('club_event', EVENT, null, true, '2026-09'),
    });
    expect(managedRows()[0]).toMatchObject({
      state: 'live',
      form_id: 'made_form_1',
      binding_id: bindings()[0]!.id,
      template_waiver_version: '2026-09',
      last_error: null,
    });
    const created = audits.find((a) => a.action_type === 'registration_form_created');
    expect(created).toMatchObject({ target_id: managedRows()[0]!.id });
    expect(audits.map((a) => a.action_type)).toContain('registration_form_bound');
    // The audit carries ids and codes, never a person.
    expect(JSON.stringify(audits)).not.toContain('pay@example.org');
  });

  it('a second press finds the Form and makes no other', async () => {
    await makeLive();
    expect(await managed.ensureManagedForm(fakeAdmin() as never, ACTOR, 'club_event', EVENT, deps())).toBe('exists');
    expect(makerCalls).toEqual([]);
    expect(bindings()).toHaveLength(1);
  });
});

// ---- keeping in step ------------------------------------------------------------

describe('syncManagedForm', () => {
  it('calls nothing when nothing changed', async () => {
    const row = await makeLive();
    const before = JSON.stringify(bindings());
    expect(await managed.syncManagedForm(fakeAdmin() as never, row, deps())).toBe('unchanged');
    expect(makerCalls).toEqual([]);
    expect(JSON.stringify(bindings())).toBe(before);
  });

  it('writes the content only when it changed', async () => {
    const row = await makeLive();
    db.club_events![0]!.title = 'Games night';
    expect(await managed.syncManagedForm(fakeAdmin() as never, row, deps())).toBe('updated');
    expect(actions_()).toEqual(['update']);
    expect(makerCalls[0]).toMatchObject({ formId: 'made_form_1', title: 'Games night' });
  });

  it('closes a full event and reopens it when a place frees', async () => {
    let row = await makeLive();
    accepting = { accepting: false, reason: 'full' };
    expect(await managed.syncManagedForm(fakeAdmin() as never, row, deps())).toBe('updated');
    expect(actions_()).toEqual(['close']);
    expect(managedRows()[0]).toMatchObject({ accepting: false, close_reason: 'full' });

    makerCalls = [];
    row = { ...managedRows()[0]! } as never;
    accepting = { accepting: true, reason: null };
    expect(await managed.syncManagedForm(fakeAdmin() as never, row, deps())).toBe('updated');
    expect(actions_()).toEqual(['open']);
    expect(managedRows()[0]).toMatchObject({ accepting: true, close_reason: null });
  });

  it('closes the Form of a deleted event, once', async () => {
    const row = await makeLive();
    db.club_events = [];
    expect(await managed.syncManagedForm(fakeAdmin() as never, row, deps())).toBe('updated');
    expect(actions_()).toEqual(['close']);
    expect(managedRows()[0]).toMatchObject({ accepting: false, close_reason: 'deleted' });

    makerCalls = [];
    expect(await managed.syncManagedForm(fakeAdmin() as never, { ...managedRows()[0]! } as never, deps())).toBe(
      'unchanged',
    );
    expect(makerCalls).toEqual([]);
  });

  it('never throws: a maker failure is a code on the row, and the row stays live', async () => {
    const row = await makeLive();
    db.club_events![0]!.title = 'Games night';
    makerReply = () => Promise.reject(new TypeError('fetch failed'));
    expect(await managed.syncManagedForm(fakeAdmin() as never, row, deps())).toBe('failed');
    expect(managedRows()[0]).toMatchObject({ state: 'live', last_error: 'unreachable' });
  });

  it('never throws: a database failure is sync_failed', async () => {
    const row = await makeLive();
    failing.add('rpc');
    expect(await managed.syncManagedForm(fakeAdmin() as never, row, deps())).toBe('failed');
    expect(managedRows()[0]).toMatchObject({ state: 'live', last_error: 'sync_failed' });
    expect(captured.length).toBeGreaterThan(0);
  });

  it('does nothing without a form maker', async () => {
    const row = await makeLive();
    dbCalls = 0;
    expect(await managed.syncManagedForm(fakeAdmin() as never, row, deps({}))).toBe('not_configured');
    expect(dbCalls).toBe(0);
  });
});

describe('runManagedFormSync', () => {
  it('skips without a form maker and reads nothing', async () => {
    expect(await managed.runManagedFormSync(fakeAdmin() as never, deps({}))).toMatchObject({ skipped: 'not_configured' });
    expect(dbCalls).toBe(0);
  });

  it('never makes a Form for a row the staging snapshot copied', async () => {
    db.managed_registration_forms!.push({
      id: 'r1',
      target_kind: 'club_event',
      club_event_id: EVENT,
      state: 'failed',
      last_error: 'staging_copy',
      binding_id: 'copied-binding',
      generation: 1,
      attempted_at: '2026-01-01T00:00:00Z',
    });
    const run = await managed.runManagedFormSync(fakeAdmin() as never, deps());
    expect(run.checked).toBe(0);
    expect(makerCalls).toEqual([]);
    await expect(
      managed.recheckManagedForm(fakeAdmin() as never, ACTOR, managedRows()[0] as never, deps()),
    ).rejects.toThrow('Replace');
    expect(makerCalls).toEqual([]);
  });

  it('retries a failed row once its wait is over', async () => {
    db.managed_registration_forms!.push({
      id: 'r1',
      target_kind: 'club_event',
      club_event_id: EVENT,
      state: 'failed',
      last_error: 'unreachable',
      binding_id: null,
      claimed_at: null,
      generation: 1,
      attempted_at: '2026-10-21T11:00:00Z',
    });
    const run = await managed.runManagedFormSync(fakeAdmin() as never, deps());
    expect(run.updated).toBe(1);
    expect(actions_()).toEqual(['create']);
    expect(managedRows()[0]).toMatchObject({ state: 'live' });
  });

  it('leaves a closed Form whose event is gone', async () => {
    await makeLive();
    Object.assign(managedRows()[0]!, { accepting: false, close_reason: 'deleted' });
    const run = await managed.runManagedFormSync(fakeAdmin() as never, deps());
    expect(run.checked).toBe(0);
    expect(makerCalls).toEqual([]);
  });
});

// ---- the buttons and the hooks ------------------------------------------------

describe('the actions', () => {
  it('refuse a malformed id or kind before reading or asking for a capability', async () => {
    expect((await actions.createManagedForm('club_event', 'nope')).ok).toBe(false);
    expect((await actions.createManagedForm('season' as never, EVENT)).ok).toBe(false);
    expect((await actions.recheckManagedForm("1' OR 1=1")).ok).toBe(false);
    expect((await actions.replaceManagedForm('')).ok).toBe(false);
    expect(capabilities).toEqual([]);
    expect(dbCalls).toBe(0);
  });

  it('ask for the capability that edits the target', async () => {
    await actions.createManagedForm('club_event', EVENT);
    await actions.createManagedForm('tournament', EVENT);
    expect(capabilities).toEqual(['events.manage.update.write', 'tournaments.manage.update.write']);
  });

  it('take the kind for a row from the stored row', async () => {
    db.managed_registration_forms!.push({
      id: '00000000-0000-4000-8000-00000000f001',
      target_kind: 'tournament',
      tournament_id: EVENT,
      club_event_id: null,
      state: 'retired',
      generation: 1,
    });
    expect((await actions.recheckManagedForm('00000000-0000-4000-8000-00000000f001')).ok).toBe(false);
    expect(capabilities).toEqual(['tournaments.manage.update.write']);
  });
});

describe('the hooks', () => {
  it('schedule nothing without a form maker', () => {
    vi.stubEnv('GOOGLE_FORM_MAKER_URL', '');
    vi.stubEnv('GOOGLE_FORM_MAKER_SECRET', '');
    managed.scheduleManagedFormCreate('club_event', EVENT, { id: ACTOR });
    managed.scheduleManagedFormSync('club_event', EVENT);
    managed.scheduleManagedFormSyncFor(['r1']);
    expect(afterCallbacks).toEqual([]);
    expect(dbCalls).toBe(0);
  });

  it('schedule no Form for a creator who may not edit the event', () => {
    vi.stubEnv('GOOGLE_FORM_MAKER_URL', MAKER_URL);
    vi.stubEnv('GOOGLE_FORM_MAKER_SECRET', SECRET);
    allowed = false;
    managed.scheduleManagedFormCreate('club_event', EVENT, { id: ACTOR });
    expect(afterCallbacks).toEqual([]);
  });

  it('a failing Form leaves the new event created', async () => {
    vi.stubEnv('GOOGLE_FORM_MAKER_URL', MAKER_URL);
    vi.stubEnv('GOOGLE_FORM_MAKER_SECRET', SECRET);
    vi.stubEnv('GOOGLE_FORMS_SERVICE_ACCOUNT_JSON', KEY);
    failing.add('managed_registration_forms');
    const result = await createClubEvent({
      title: 'Workshop',
      kind: 'workshop',
      description: null,
      location: null,
      starts_at: '2026-11-10T19:00',
      ends_at: null,
      signup_opens_at: null,
      signup_closes_at: null,
      capacity: null,
      cost_dollars: null,
      publish: true,
    } as never);
    expect(result.ok).toBe(true);
    expect(afterCallbacks).toHaveLength(1);
    // The callback settles, it does not reject, and Sentry hears about the fault.
    await expect(Promise.resolve(afterCallbacks[0]!())).resolves.toBeUndefined();
    expect(captured.length).toBeGreaterThan(0);
  });
});
