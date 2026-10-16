// The console's Google Form actions (00283). Every parameter is a client POST
// field, so: a malformed id is refused before anything is read, the capability
// asked for is the one the STORED row implies (never what the client says),
// and a non-member fee action refuses any row that is not a named tournament
// fee.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const capabilities: string[] = [];
vi.mock('../actions/_shared', () => ({
  requireCapability: vi.fn(async (capability: string) => {
    capabilities.push(capability);
    return { id: 'admin-1' };
  }),
}));
const audits: { action_type: string }[] = [];
vi.mock('../audit', () => ({
  logAdminAudit: vi.fn(async (_client: unknown, entry: { action_type: string }) => {
    audits.push(entry);
  }),
}));

let rows: Record<string, Record<string, unknown> | null>;
/** What an awaited list read of a table returns (default: one row). */
let lists: Record<string, Record<string, unknown>[]> = {};
const rpcs: { fn: string; args: unknown }[] = [];
const updates: { table: string; values: unknown }[] = [];
let reads = 0;

vi.mock('../supabase-server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      let mode: 'select' | 'update' = 'select';
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        insert: (values: unknown) => {
          updates.push({ table, values });
          mode = 'update';
          return chain;
        },
        update: (values: unknown) => {
          updates.push({ table, values });
          mode = 'update';
          return chain;
        },
        maybeSingle: async () => {
          reads += 1;
          return { data: mode === 'update' ? { id: 'new-id' } : (rows[table] ?? null), error: null };
        },
        then: (resolve: (value: unknown) => void) =>
          resolve({ data: mode === 'select' && lists[table] ? lists[table] : [{ id: 'row' }], error: null }),
      });
      return chain;
    },
    rpc: async (fn: string, args: unknown) => {
      rpcs.push({ fn, args });
      return { data: { ok: true }, error: null };
    },
  }),
}));

const actions = await import('../actions/registration-imports');

const ENTRY = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';
const TOURNAMENT = '33333333-3333-4333-8333-333333333333';
const CONSUMER = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  capabilities.length = 0;
  audits.length = 0;
  rpcs.length = 0;
  updates.length = 0;
  reads = 0;
  rows = {};
  lists = {};
});

describe('form registration actions', () => {
  it('refuses a malformed id before reading or asking for a capability', async () => {
    for (const result of [
      await actions.undoImportedEntry('not-a-uuid'),
      await actions.setRegistrationFormActive("1' OR 1=1", false),
      await actions.markNonMemberFeePaid('x', 'cash'),
      await actions.markNonMemberFeeUnpaid(''),
    ]) {
      expect(result.ok).toBe(false);
    }
    expect(reads).toBe(0);
    expect(capabilities).toEqual([]);
  });

  it('refuses a binding body with an unknown field or a bad form id', async () => {
    const base = {
      targetKind: 'tournament' as const,
      targetId: TOURNAMENT,
      consumerId: CONSUMER,
      formId: 'form_1',
      joinWaitlist: false,
      soloDoublesAck: false,
    };
    expect((await actions.bindRegistrationForm({ ...base, formId: 'bad id with spaces' })).ok).toBe(false);
    expect((await actions.bindRegistrationForm({ ...base, created_by: 'someone' } as never)).ok).toBe(false);
    expect(capabilities).toEqual([]);
  });

  it('binds with the capability of the target kind, and audits it', async () => {
    rows = { club_events: { id: EVENT }, data_api_consumers: { id: CONSUMER } };
    const result = await actions.bindRegistrationForm({
      targetKind: 'club_event',
      targetId: EVENT,
      consumerId: CONSUMER,
      formId: 'form_1',
      joinWaitlist: false,
      soloDoublesAck: false,
    });
    expect(result.ok).toBe(true);
    expect(capabilities).toEqual(['events.manage.update.write']);
    expect(audits.map((a) => a.action_type)).toEqual(['registration_form_bound']);
  });

  it('asks the remove capability the stored entry implies', async () => {
    rows = { registration_import_entries: { id: ENTRY, tournament_event_id: EVENT, club_event_id: null, pair_id: 'p1', status: 'entered' }, tournament_events: { tournament_id: TOURNAMENT } };
    expect((await actions.undoImportedEntry(ENTRY)).ok).toBe(true);
    expect(capabilities).toEqual(['tournaments.draw.pairs.remove.write']);
    expect(rpcs).toEqual([{ fn: 'undo_registration_import_entry', args: { p_entry_id: ENTRY, p_actor: 'admin-1' } }]);

    capabilities.length = 0;
    rows = { registration_import_entries: { id: ENTRY, tournament_event_id: null, club_event_id: EVENT, pair_id: null, status: 'entered' } };
    expect((await actions.undoImportedEntry(ENTRY)).ok).toBe(true);
    expect(capabilities).toEqual(['events.signups.remove.write']);
  });

  it('settles only a named tournament fee, never a member fee or dues', async () => {
    rows = { club_fees: { id: ENTRY, tournament_id: TOURNAMENT, manual_name: null, fee_type: 'tournament', paid_at: null } };
    expect((await actions.markNonMemberFeePaid(ENTRY, 'cash')).ok).toBe(false);
    rows = { club_fees: { id: ENTRY, tournament_id: null, manual_name: 'Guest', fee_type: 'dues', paid_at: null } };
    expect((await actions.markNonMemberFeePaid(ENTRY, 'cash')).ok).toBe(false);
    expect(updates).toEqual([]);

    rows = { club_fees: { id: ENTRY, tournament_id: TOURNAMENT, manual_name: 'Guest', fee_type: 'tournament', paid_at: null, amount_cents: 2500 } };
    expect((await actions.markNonMemberFeePaid(ENTRY, 'waived')).ok).toBe(false);
    expect((await actions.markNonMemberFeePaid(ENTRY, 'cash')).ok).toBe(true);
    expect(audits.map((a) => a.action_type)).toEqual(['tournament_fee_marked_paid']);
  });
});

describe('reading a form with Google (00287)', () => {
  const BINDING = '55555555-5555-4555-8555-555555555555';
  const mapping = {
    EMAIL_QUESTION: 'Email address',
    NAME_QUESTION: 'Full name',
    EVENT_QUESTION: 'Events',
    EVENTS: { Singles: EVENT },
    DEFAULT_EVENT_ID: '',
    PARTNERS: {},
  };

  it('refuses a malformed id or mapping before asking for a capability', async () => {
    expect((await actions.saveRegistrationFormMapping('nope', mapping)).ok).toBe(false);
    expect((await actions.saveRegistrationFormMapping(BINDING, { ...mapping, EXTRA: 'x' })).ok).toBe(false);
    expect((await actions.saveRegistrationFormMapping(BINDING, { ...mapping, EVENTS: { Singles: 'x' } })).ok).toBe(false);
    expect(capabilities).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('takes the target from the stored binding and resets the watermark', async () => {
    rows = { registration_import_forms: { id: BINDING, target_kind: 'tournament', tournament_id: TOURNAMENT, club_event_id: null } };
    lists = { tournament_events: [{ id: EVENT }] };
    const result = await actions.saveRegistrationFormMapping(BINDING, mapping);
    expect(result.ok).toBe(true);
    expect(capabilities).toEqual(['tournaments.manage.update.write']);
    expect(updates).toEqual([
      {
        table: 'registration_import_forms',
        values: expect.objectContaining({ read_mapping: mapping, poll_watermark: null, poll_error: null }),
      },
    ]);
    expect(audits.map((a) => a.action_type)).toEqual(['registration_form_bound']);
  });

  it('refuses an event that is not in the binding\'s tournament', async () => {
    rows = { registration_import_forms: { id: BINDING, target_kind: 'tournament', tournament_id: TOURNAMENT, club_event_id: null } };
    lists = { tournament_events: [] };
    expect((await actions.saveRegistrationFormMapping(BINDING, mapping)).ok).toBe(false);
    expect(updates).toEqual([]);
  });

  it('lets a club event form name only that event', async () => {
    rows = { registration_import_forms: { id: BINDING, target_kind: 'club_event', tournament_id: null, club_event_id: EVENT } };
    const club = { ...mapping, EVENT_QUESTION: '', EVENTS: {}, DEFAULT_EVENT_ID: TOURNAMENT };
    expect((await actions.saveRegistrationFormMapping(BINDING, club)).ok).toBe(false);
    expect((await actions.saveRegistrationFormMapping(BINDING, { ...club, DEFAULT_EVENT_ID: EVENT })).ok).toBe(true);
    expect(capabilities).toEqual(['events.manage.update.write', 'events.manage.update.write']);
  });

  it('stops reading with null', async () => {
    rows = { registration_import_forms: { id: BINDING, target_kind: 'tournament', tournament_id: TOURNAMENT, club_event_id: null } };
    expect((await actions.saveRegistrationFormMapping(BINDING, null)).ok).toBe(true);
    expect(updates[0]!.values).toMatchObject({ read_mapping: null });
  });
});
