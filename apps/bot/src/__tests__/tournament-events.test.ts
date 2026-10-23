import { describe, it, expect, vi, beforeEach } from 'vitest';

// Two properties this file exists to pin down:
//
//  1. CALL DISCORD FIRST, RECORD SECOND — on create and update. A crash between
//     the two is a duplicate somebody notices, not an announcement that
//     silently never happened.
//  2. RECORD THE TOURNAMENT'S TIMES, NOT THE CLAMPED ONES. A start already gone
//     is pushed forward so Discord will accept it; storing that pushed value
//     would make every subsequent tick see a difference and PATCH forever.

const fetchTournamentActions = vi.fn();
const recordTournamentEvent = vi.fn();
const clearTournamentEvent = vi.fn();
const createScheduledEvent = vi.fn();
const modifyScheduledEvent = vi.fn();
const deleteScheduledEvent = vi.fn();
const hasManageEvents = vi.fn();
const loadConfig = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchTournamentActions,
  recordTournamentEvent,
  clearTournamentEvent,
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig,
}));
vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    createScheduledEvent = createScheduledEvent;
    modifyScheduledEvent = modifyScheduledEvent;
    deleteScheduledEvent = deleteScheduledEvent;
    hasManageEvents = hasManageEvents;
  },
}));

const CREATE = {
  kind: 'create' as const,
  tournamentId: 't1',
  discordEventId: null,
  name: 'Fall Open',
  // Clamped: the tournament's own start is in the past, so the send value was
  // pushed forward by the app.
  startsAt: '2026-09-01T20:00:00.000Z',
  endsAt: '2026-09-02T01:00:00.000Z',
  syncedStartsAt: '2026-08-30T16:00:00.000Z',
  syncedEndsAt: '2026-09-02T01:00:00.000Z',
  patchTimes: true,
  location: 'SFU Burnaby',
  description: 'Events: Men’s Singles',
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  loadConfig.mockResolvedValue({ registry: new Map([['g1', {}]]), auditChannelId: null });
  fetchTournamentActions.mockResolvedValue({ actions: [CREATE], skipped: [] });
  hasManageEvents.mockResolvedValue(true);
  createScheduledEvent.mockResolvedValue('evt-1');
  modifyScheduledEvent.mockResolvedValue('ok');
  deleteScheduledEvent.mockResolvedValue(true);
  recordTournamentEvent.mockResolvedValue({ ok: true });
  clearTournamentEvent.mockResolvedValue({ ok: true });
});

describe('tournament events', () => {
  it('creates, then records — never the other way round', async () => {
    const order: string[] = [];
    createScheduledEvent.mockImplementation(async () => {
      order.push('create');
      return 'evt-1';
    });
    recordTournamentEvent.mockImplementation(async () => {
      order.push('record');
      return { ok: true };
    });

    const { runTournamentEvents } = await import('../tournament-events.js');
    const result = await runTournamentEvents();

    expect(order).toEqual(['create', 'record']);
    expect(result.created).toBe(1);
  });

  it('records the TOURNAMENT’s times, not the clamped ones it sent', async () => {
    // The bug this prevents: storing the clamped start makes the app see a
    // difference on the very next tick and PATCH the same event forever.
    const { runTournamentEvents } = await import('../tournament-events.js');
    await runTournamentEvents();

    expect(createScheduledEvent).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ startsAt: CREATE.startsAt })
    );
    expect(recordTournamentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        syncedStartsAt: CREATE.syncedStartsAt,
        syncedEndsAt: CREATE.syncedEndsAt,
      })
    );
  });

  it('does NOT record an event Discord refused', async () => {
    // An uncreated event has to stay due, or a bot restart turns into a
    // permanently missing announcement.
    createScheduledEvent.mockResolvedValue(null);

    const { runTournamentEvents } = await import('../tournament-events.js');
    const result = await runTournamentEvents();

    expect(recordTournamentEvent).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('refuses to touch Discord at all without MANAGE_EVENTS', async () => {
    // Every call would 403, and a 403 names no permission. Bailing with one log
    // line beats a run of identical anonymous failures.
    hasManageEvents.mockResolvedValue(false);

    const { runTournamentEvents } = await import('../tournament-events.js');
    const result = await runTournamentEvents();

    expect(createScheduledEvent).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('still tries when the permission CHECK itself fails', async () => {
    // The preflight exists to explain a failure, not to become one. A broken
    // check must not stop work that would have succeeded.
    hasManageEvents.mockRejectedValue(new Error('network'));

    const { runTournamentEvents } = await import('../tournament-events.js');
    const result = await runTournamentEvents();

    expect(createScheduledEvent).toHaveBeenCalled();
    expect(result.created).toBe(1);
  });

  it('skips the permission check entirely when there is nothing to do', async () => {
    fetchTournamentActions.mockResolvedValue({ actions: [], skipped: [] });

    const { runTournamentEvents } = await import('../tournament-events.js');
    await runTournamentEvents();

    expect(hasManageEvents).not.toHaveBeenCalled();
  });

  it('deletes the Discord event BEFORE forgetting the mapping', async () => {
    // The one place the ordering inverts: clearing the row first would strand a
    // live event with nothing pointing at it and nothing to clean it up.
    const order: string[] = [];
    deleteScheduledEvent.mockImplementation(async () => {
      order.push('delete');
      return true;
    });
    clearTournamentEvent.mockImplementation(async () => {
      order.push('clear');
      return { ok: true };
    });
    fetchTournamentActions.mockResolvedValue({
      actions: [{ ...CREATE, kind: 'cancel', discordEventId: 'evt-1' }],
      skipped: [],
    });

    const { runTournamentEvents } = await import('../tournament-events.js');
    const result = await runTournamentEvents();

    expect(order).toEqual(['delete', 'clear']);
    expect(result.cancelled).toBe(1);
  });

  it('keeps the mapping when the Discord delete fails', async () => {
    deleteScheduledEvent.mockResolvedValue(false);
    fetchTournamentActions.mockResolvedValue({
      actions: [{ ...CREATE, kind: 'cancel', discordEventId: 'evt-1' }],
      skipped: [],
    });

    const { runTournamentEvents } = await import('../tournament-events.js');
    const result = await runTournamentEvents();

    expect(clearTournamentEvent).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('sends a fallback location rather than an empty one', async () => {
    // entity_metadata.location is REQUIRED for an EXTERNAL event: Discord
    // rejects the whole call without it, so an unset setting cannot become ''.
    fetchTournamentActions.mockResolvedValue({
      actions: [{ ...CREATE, location: null }],
      skipped: [],
    });

    const { runTournamentEvents } = await import('../tournament-events.js');
    await runTournamentEvents();

    const payload = createScheduledEvent.mock.calls[0]?.[1] as { location: string };
    expect(payload.location.length).toBeGreaterThan(0);
    // RECORDED AS NULL, the app's value: recording the fallback would read as
    // a changed location on every tick (00304).
    expect(recordTournamentEvent).toHaveBeenCalledWith(expect.objectContaining({ location: null }));
  });

  it("records the app's location with the mapping", async () => {
    const { runTournamentEvents } = await import('../tournament-events.js');
    await runTournamentEvents();
    expect(recordTournamentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ location: CREATE.location })
    );
  });

  it('one guild failing does not stop the others', async () => {
    loadConfig.mockResolvedValue({ registry: new Map([['g1', {}], ['g2', {}]]), auditChannelId: null });
    fetchTournamentActions.mockImplementation(async (guildId: string) => {
      if (guildId === 'g1') throw new Error('app down');
      return { actions: [CREATE], skipped: [] };
    });

    const { runTournamentEvents } = await import('../tournament-events.js');
    const result = await runTournamentEvents();

    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('updates through PATCH rather than creating a second event', async () => {
    fetchTournamentActions.mockResolvedValue({
      actions: [{ ...CREATE, kind: 'update', discordEventId: 'evt-1' }],
      skipped: [],
    });

    const { runTournamentEvents } = await import('../tournament-events.js');
    const result = await runTournamentEvents();

    expect(createScheduledEvent).not.toHaveBeenCalled();
    expect(modifyScheduledEvent).toHaveBeenCalledWith('g1', 'evt-1', expect.anything(), true);
    expect(result.updated).toBe(1);
  });

  it('carries patchTimes through to the API call', async () => {
    // The flag is the whole defence against retrying a refused retime forever,
    // and a run that dropped it on the floor would look identical from here
    // until a tournament was renamed mid-run.
    fetchTournamentActions.mockResolvedValue({
      actions: [{ ...CREATE, kind: 'update', discordEventId: 'evt-1', patchTimes: false }],
      skipped: [],
    });

    const { runTournamentEvents } = await import('../tournament-events.js');
    await runTournamentEvents();

    expect(modifyScheduledEvent).toHaveBeenCalledWith('g1', 'evt-1', expect.anything(), false);
  });

  it('RECORDS an update whose event is gone, rather than retrying it forever', async () => {
    // An exec deleting the event from the Events tab by hand leaves a mapping
    // pointing at a 404. A PATCH cannot bring it back, so re-sending the same
    // diff every fifteen minutes until the tournament completes achieves
    // nothing. Recording settles it; the cancel path clears the row later,
    // where a 404 delete already counts as done.
    modifyScheduledEvent.mockResolvedValue('gone');
    fetchTournamentActions.mockResolvedValue({
      actions: [{ ...CREATE, kind: 'update', discordEventId: 'evt-1' }],
      skipped: [],
    });

    const { runTournamentEvents } = await import('../tournament-events.js');
    const result = await runTournamentEvents();

    expect(recordTournamentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tournamentId: 't1', discordEventId: 'evt-1' })
    );
    expect(createScheduledEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stale: 1, updated: 0, failed: 0 });
  });

  it('does NOT record an update Discord merely refused', async () => {
    modifyScheduledEvent.mockResolvedValue('failed');
    fetchTournamentActions.mockResolvedValue({
      actions: [{ ...CREATE, kind: 'update', discordEventId: 'evt-1' }],
      skipped: [],
    });

    const { runTournamentEvents } = await import('../tournament-events.js');
    const result = await runTournamentEvents();

    expect(recordTournamentEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1, stale: 0, updated: 0 });
  });
});
