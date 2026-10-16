import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * THE NATIVE APP'S WRITE ROUTE, AT ITS EDGES.
 *
 * What is pinned here is everything the route decides for itself: no bearer is
 * a 401 with no action run, an unknown name is a 404, arguments of the wrong
 * shape are a 400 with no action run, and a good call runs the named action
 * INSIDE the actor store and hands back its ActionResult untouched under a
 * no-store 200. The actions are mocked; route-seam.test.ts runs a real one.
 */

const resolveAppActor = vi.fn();
vi.mock('@/lib/app-actor', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/app-actor')>();
  return { ...real, resolveAppActor: (r: Request) => resolveAppActor(r) };
});

const calls: { name: string; args: unknown[]; actorId: string | undefined }[] = [];
let answer: unknown = { ok: true, data: 'x' };

async function record(name: string, args: unknown[]) {
  const { appActorStore } = await import('@/lib/app-actor');
  calls.push({ name, args, actorId: appActorStore.getStore()?.user.id });
  return answer;
}

vi.mock('@/lib/actions/challenges', () => ({
  createChallenge: (...a: unknown[]) => record('createChallenge', a),
  acceptChallenge: (...a: unknown[]) => record('acceptChallenge', a),
  rejectChallenge: (...a: unknown[]) => record('rejectChallenge', a),
  cancelChallenge: (...a: unknown[]) => record('cancelChallenge', a),
}));
vi.mock('@/lib/actions/matches', () => ({
  submitMatchResult: (...a: unknown[]) => record('submitMatchResult', a),
  confirmMatchResult: (...a: unknown[]) => record('confirmMatchResult', a),
  disputeMatchResult: (...a: unknown[]) => record('disputeMatchResult', a),
  reportWalkover: (...a: unknown[]) => record('reportWalkover', a),
}));
vi.mock('@/lib/actions/sessions', () => ({
  checkInWithToken: (...a: unknown[]) => record('checkInWithToken', a),
}));

const { POST } = await import('../[name]/route');

const ID = '11111111-2222-4333-8444-555555555555';
const ACTOR = { user: { id: 'user-1' }, supabase: {} };

function call(name: string, body: unknown, raw = false) {
  const request = new Request(`https://site.example.invalid/api/app/actions/${name}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ name }) });
}

beforeEach(() => {
  calls.length = 0;
  answer = { ok: true, data: 'x' };
  resolveAppActor.mockReset();
  resolveAppActor.mockResolvedValue(ACTOR);
});

describe('POST /api/app/actions/[name]', () => {
  it('is a 401 with no bearer, and runs nothing', async () => {
    resolveAppActor.mockResolvedValue(null);
    const res = await call('acceptChallenge', { args: [ID] });
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(calls).toHaveLength(0);
  });

  it.each(['deleteMyAccount', 'toString', '__proto__', 'constructor'])('is a 404 for %s', async (name) => {
    const res = await call(name, { args: [] });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['acceptChallenge', { args: ['not-a-uuid'] }],
    ['acceptChallenge', { args: [ID, ID] }],
    ['acceptChallenge', { args: [] }],
    ['acceptChallenge', {}],
    ['acceptChallenge', null],
    ['createChallenge', { args: ['x'] }],
    ['submitMatchResult', { args: [ID] }],
    ['disputeMatchResult', { args: [ID, 'reason text'] }],
    ['checkInWithToken', { args: ['a'.repeat(65)] }],
    ['checkInWithToken', { args: [42] }],
  ])('is a 400 for %s with %j, and runs nothing', async (name, body) => {
    const res = await call(name, body);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('is a 400 for a body that is not JSON', async () => {
    const res = await call('acceptChallenge', '<html>', true);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('runs the action as the actor and returns its ActionResult under a no-store 200', async () => {
    const res = await call('acceptChallenge', { args: [ID] });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, data: 'x' });
    expect(calls).toEqual([{ name: 'acceptChallenge', args: [ID], actorId: 'user-1' }]);
  });

  it('passes a refusal through as a 200 with the code and ref', async () => {
    answer = { ok: false, error: 'Account suspended', code: 'ACC-102', ref: 'abcd1234' };
    const res = await call('rejectChallenge', { args: [ID] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
  });

  it('keeps the dispute arguments in the action order: match, description, category', async () => {
    await call('disputeMatchResult', { args: [ID, 'The second game was 21-19', 'score_wrong'] });
    expect(calls[0]).toEqual({
      name: 'disputeMatchResult',
      args: [ID, 'The second game was 21-19', 'score_wrong'],
      actorId: 'user-1',
    });
  });

  it('hands object arguments through whole', async () => {
    const input = { winner_side: 'a', games: [{ game_number: 1, side_a_score: 21, side_b_score: 10 }], completed: true };
    await call('submitMatchResult', { args: [ID, input] });
    expect(calls[0]?.args).toEqual([ID, input]);
  });
});
