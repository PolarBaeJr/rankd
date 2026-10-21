import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * CONSOLE COMMANDS ON DISCORD: the write route, at its edges.
 *
 * No service secret is a 401 with nothing run; an unlinked caller is a named
 * refusal; an unknown name is a 404; arguments of the wrong shape (including a
 * misspelt key, which an update would read as "clear this") are a 400; and a
 * good call runs the console's action INSIDE the actor store, as the linked
 * exec, handing back its ActionResult. The actions are mocked.
 */

const resolveDiscordActor = vi.fn();
vi.mock('@/lib/discord-actor', async () => {
  const store = await import('@/lib/discord-actor-store');
  return { ...store, resolveDiscordActor: (...a: unknown[]) => resolveDiscordActor(...a) };
});
vi.mock('@/lib/supabase-server', () => ({ createAdminClient: () => ({}) }));

const calls: { name: string; args: unknown[]; actorId: string | undefined }[] = [];
let answer: unknown = { ok: true, data: undefined };

async function record(name: string, args: unknown[]) {
  const { discordActorStore } = await import('@/lib/discord-actor-store');
  calls.push({ name, args, actorId: discordActorStore.getStore()?.playerId });
  return answer;
}

vi.mock('@/lib/actions/sessions', () => ({
  createSession: (...a: unknown[]) => record('createSession', a),
  updateSession: (...a: unknown[]) => record('updateSession', a),
  archiveSession: (...a: unknown[]) => record('archiveSession', a),
  deleteSession: (...a: unknown[]) => record('deleteSession', a),
  getOrCreateSessionCheckinToken: (...a: unknown[]) => record('getOrCreateSessionCheckinToken', a),
  rotateSessionCheckinToken: (...a: unknown[]) => record('rotateSessionCheckinToken', a),
}));
vi.mock('@/lib/actions/club-events', () => ({
  createClubEvent: (...a: unknown[]) => record('createClubEvent', a),
  updateClubEvent: (...a: unknown[]) => record('updateClubEvent', a),
  cancelClubEvent: (...a: unknown[]) => record('cancelClubEvent', a),
  deleteClubEvent: (...a: unknown[]) => record('deleteClubEvent', a),
}));

// The tournament actions. The six that return nothing and throw their refusals
// are recorded with `thrown` so the wrapping can be seen to turn a throw into
// an ActionResult.
let thrown: Error | null = null;
async function recordVoid(name: string, args: unknown[]) {
  await record(name, args);
  if (thrown) throw thrown;
}
vi.mock('@/lib/tournament-actions/participants', () => ({
  checkInParticipant: (...a: unknown[]) => record('checkInParticipant', a),
  checkInPair: (...a: unknown[]) => record('checkInPair', a),
  undoCheckIn: (...a: unknown[]) => record('undoCheckIn', a),
  markParticipantNoShow: (...a: unknown[]) => recordVoid('markParticipantNoShow', a),
  markPairNoShow: (...a: unknown[]) => recordVoid('markPairNoShow', a),
}));
vi.mock('@/lib/tournament-actions/results', () => ({
  enterMatchResult: (...a: unknown[]) => record('enterMatchResult', a),
  enterWalkover: (...a: unknown[]) => record('enterWalkover', a),
}));
vi.mock('@/lib/tournament-actions/scheduling', () => ({
  setMatchCourt: (...a: unknown[]) => record('setMatchCourt', a),
  setMatchLive: (...a: unknown[]) => record('setMatchLive', a),
}));
vi.mock('@/lib/actions/tournaments', () => ({
  updateTournamentStatus: (...a: unknown[]) => record('updateTournamentStatus', a),
  suspendTournament: (...a: unknown[]) => recordVoid('suspendTournament', a),
  resumeTournament: (...a: unknown[]) => recordVoid('resumeTournament', a),
}));
vi.mock('@/lib/actions/tournament-fees', () => ({
  markTournamentFeePaid: (...a: unknown[]) => recordVoid('markTournamentFeePaid', a),
  markTournamentFeeUnpaid: (...a: unknown[]) => recordVoid('markTournamentFeeUnpaid', a),
}));
vi.mock('@/lib/actions/tournament-checkin', () => ({
  getOrCreateTournamentCheckinToken: (...a: unknown[]) => record('getOrCreateTournamentCheckinToken', a),
  rotateTournamentCheckinToken: (...a: unknown[]) => record('rotateTournamentCheckinToken', a),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const { POST } = await import('../[name]/route');
const { ExpectedError } = await import('@badminton/shared');

const SECRET = 'test-service-secret';
const ID = '11111111-2222-4333-8444-555555555555';
const DISCORD_ID = '123456789012345678';

function call(name: string, body: unknown, secret: string | null = SECRET) {
  const request = new Request(`https://console.example.invalid/api/discord/actions/${name}`, {
    method: 'POST',
    headers: {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ name }) });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = SECRET;
  calls.length = 0;
  answer = { ok: true, data: undefined };
  thrown = null;
  resolveDiscordActor.mockReset();
  resolveDiscordActor.mockResolvedValue({ playerId: 'exec-1' });
});

describe('POST /api/discord/actions/[name]', () => {
  it('is a 401 without the service secret, and runs nothing', async () => {
    const res = await call('archiveSession', { discordUserId: DISCORD_ID, args: [ID, 'Rained out'] }, null);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(resolveDiscordActor).not.toHaveBeenCalled();
  });

  it('is a 401 with the wrong secret', async () => {
    const res = await call('archiveSession', { discordUserId: DISCORD_ID, args: [ID, 'Rained out'] }, 'nope');
    expect(res.status).toBe(401);
  });

  it('names an unlinked caller and runs nothing', async () => {
    resolveDiscordActor.mockResolvedValue('not_linked');
    const res = await call('archiveSession', { discordUserId: DISCORD_ID, args: [ID, 'Rained out'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, refusal: 'not_linked' });
    expect(calls).toHaveLength(0);
  });

  it('is a 503 when the link cannot be read, never not_linked', async () => {
    resolveDiscordActor.mockResolvedValue('unavailable');
    const res = await call('archiveSession', { discordUserId: DISCORD_ID, args: [ID, 'Rained out'] });
    expect(res.status).toBe(503);
  });

  it.each(['banPlayer', 'toString', '__proto__', 'constructor'])('is a 404 for %s', async (name) => {
    const res = await call(name, { discordUserId: DISCORD_ID, args: [] });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['archiveSession', [ID]],
    ['archiveSession', ['not-a-uuid', 'Rained out']],
    ['updateSession', [ID, { name: 'Club night', date: '2026-10-20', location: 'Gym', track: 'all', start_time: '19:00' }, 'Moved']],
    ['createSession', [{ name: 'Club night', date: '2026-10-20', location: 'Gym', track: 'everyone' }]],
  ])('is a 400 for bad arguments to %s', async (name, args) => {
    const res = await call(name, { discordUserId: DISCORD_ID, args });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('is a 400 for a malformed Discord id', async () => {
    const res = await call('archiveSession', { discordUserId: 'abc', args: [ID, 'Rained out'] });
    expect(res.status).toBe(400);
  });

  it('runs the action as the linked exec and returns its result', async () => {
    answer = { ok: false, error: 'Your permissions do not include this. Ask an admin.', code: 'AUTH-104', ref: 'r1' };
    const res = await call('archiveSession', { discordUserId: DISCORD_ID, args: [ID, 'Rained out'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(calls).toEqual([{ name: 'archiveSession', args: [ID, 'Rained out'], actorId: 'exec-1' }]);
  });

  it('turns the passkey policy refusal into passkey_required', async () => {
    answer = { ok: false, error: 'x', code: 'AUTH-105', ref: 'r2' };
    const res = await call('deleteClubEvent', { discordUserId: DISCORD_ID, args: [ID] });
    expect(await res.json()).toEqual({ ok: false, refusal: 'passkey_required' });
  });

  it('passes a well-formed session create through', async () => {
    const input = {
      name: 'Club night',
      date: '2026-10-20',
      time: '19:00',
      end_time: '21:00',
      location: 'Gym',
      track: 'all',
      repeat_until: '2026-11-20',
      repeat_frequency: 'weekly',
    };
    const res = await call('createSession', { discordUserId: DISCORD_ID, args: [input] });
    expect(res.status).toBe(200);
    expect(calls[0]!.args).toEqual([input]);
  });
});

describe('POST /api/discord/actions/[name]: tournaments', () => {
  const OTHER = '22222222-3333-4444-8555-666666666666';

  it.each([
    ['checkInParticipant', [ID]],
    ['checkInPair', [ID]],
    ['undoCheckIn', [ID, true]],
    ['markParticipantNoShow', [ID]],
    ['markPairNoShow', [ID]],
    ['enterWalkover', [ID, 'a', 'Did not turn up']],
    ['setMatchCourt', [ID, '2']],
    ['setMatchLive', [ID, false]],
    ['updateTournamentStatus', [ID, 'completed']],
    ['suspendTournament', [ID, 'Fire alarm']],
    ['resumeTournament', [ID]],
    ['markTournamentFeePaid', [{ tournament_id: ID, player_id: OTHER, method: 'cash' }]],
    ['markTournamentFeeUnpaid', [ID, OTHER]],
    ['getOrCreateTournamentCheckinToken', [ID]],
    ['rotateTournamentCheckinToken', [ID]],
  ])('runs %s with its arguments as the linked exec', async (name, args) => {
    const res = await call(name, { discordUserId: DISCORD_ID, args });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: undefined });
    expect(calls).toEqual([{ name, args, actorId: 'exec-1' }]);
  });

  it.each([
    ['undoCheckIn', [ID, 'yes']],
    ['enterWalkover', [ID, 'c', 'x']],
    ['setMatchCourt', [ID, 'x'.repeat(41)]],
    ['updateTournamentStatus', [ID, 'suspended']],
    ['suspendTournament', [ID, 'x']],
    // An amount would re-price the ledger row; only a method may be named.
    ['markTournamentFeePaid', [{ tournament_id: ID, player_id: OTHER, amount_cents: 0 }]],
    ['markTournamentFeeUnpaid', [ID]],
    ['enterMatchResultFromScores', [ID, []]],
    ['enterMatchResultFromScores', [ID, [{ a: 21, b: 100 }]]],
    ['enterMatchResultFromScores', [ID, Array.from({ length: 8 }, () => ({ a: 21, b: 10 }))]],
    ['enterMatchResultFromScores', [ID, [{ a: 21, b: 10, winner: 'a' }]]],
  ])('is a 400 for bad arguments to %s', async (name, args) => {
    const res = await call(name, { discordUserId: DISCORD_ID, args });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('turns a thrown refusal from a void action into an ActionResult', async () => {
    thrown = new ExpectedError('Tournament is not suspended');
    const res = await call('resumeTournament', { discordUserId: DISCORD_ID, args: [ID] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: 'Tournament is not suspended' });
  });

  it('turns a thrown passkey refusal from a void action into passkey_required', async () => {
    thrown = new ExpectedError('x', 'AUTH-105');
    const res = await call('markPairNoShow', { discordUserId: DISCORD_ID, args: [ID] });
    expect(await res.json()).toEqual({ ok: false, refusal: 'passkey_required' });
  });

  it('derives the winner from the games, side A first', async () => {
    const scores = [
      { a: 15, b: 21 },
      { a: 21, b: 18 },
      { a: 19, b: 21 },
    ];
    await call('enterMatchResultFromScores', { discordUserId: DISCORD_ID, args: [ID, scores] });
    expect(calls).toEqual([{ name: 'enterMatchResult', args: [ID, scores, 'b', false], actorId: 'exec-1' }]);
  });

  it('refuses a score that decides nothing, and runs nothing', async () => {
    const res = await call('enterMatchResultFromScores', {
      discordUserId: DISCORD_ID,
      args: [ID, [{ a: 21, b: 15 }, { a: 15, b: 21 }]],
    });
    expect(await res.json()).toEqual({ ok: false, error: 'No game winner' });
    expect(calls).toHaveLength(0);
  });
});
