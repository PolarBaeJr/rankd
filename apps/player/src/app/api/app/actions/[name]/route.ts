import { NextResponse } from 'next/server';
import { z } from 'zod';
import { appActorStore, resolveAppActor } from '@/lib/app-actor';
import {
  createChallenge,
  acceptChallenge,
  rejectChallenge,
  cancelChallenge,
} from '@/lib/actions/challenges';
import {
  submitMatchResult,
  confirmMatchResult,
  disputeMatchResult,
  reportWalkover,
} from '@/lib/actions/matches';
import { checkInWithToken } from '@/lib/actions/sessions';

// The native app's writes. Each name runs the website's own server action,
// unchanged, as the member the bearer token belongs to: the same requirePlayer,
// feature switch, waiver check, notifications and emails as the button on the
// website. The zod tuples below only check the SHAPE of the arguments; every
// rule about what is allowed stays in the action and the database.
//
// Answers are the action's own ActionResult under a 200, so the app reads a
// refusal as a sentence. 401 means only "no usable bearer", and it is decided
// before anything is written.
//
// Rate limited at the edge on the /api/app prefix (docs/ops/rate-limits.md).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

const uuid = z.string().uuid();
const object = z.record(z.unknown());

// The tuple has already checked the shapes, and each action re-validates its
// own input with the shared schemas, so the call is typed loosely here.
type AnyAction = (...args: unknown[]) => Promise<unknown>;

const ACTIONS: Record<string, { args: z.ZodTypeAny; run: AnyAction }> = {
  createChallenge: { args: z.tuple([object]), run: createChallenge as AnyAction },
  acceptChallenge: { args: z.tuple([uuid]), run: acceptChallenge as AnyAction },
  rejectChallenge: { args: z.tuple([uuid]), run: rejectChallenge as AnyAction },
  cancelChallenge: { args: z.tuple([uuid]), run: cancelChallenge as AnyAction },
  submitMatchResult: { args: z.tuple([uuid, object]), run: submitMatchResult as AnyAction },
  confirmMatchResult: { args: z.tuple([uuid]), run: confirmMatchResult as AnyAction },
  // (matchId, reason, category): the description comes before the category.
  disputeMatchResult: { args: z.tuple([uuid, z.string(), z.string()]), run: disputeMatchResult as AnyAction },
  reportWalkover: { args: z.tuple([object]), run: reportWalkover as AnyAction },
  checkInWithToken: { args: z.tuple([z.string().max(64)]), run: checkInWithToken as AnyAction },
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const actor = await resolveAppActor(request);
  if (!actor) return reply({ error: 'Not signed in' }, 401);

  const { name } = await params;
  const action = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
  if (!action) return reply({ error: 'Unknown action' }, 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ error: 'Invalid request' }, 400);
  }
  const parsed = action.args.safeParse((body as { args?: unknown } | null)?.args);
  if (!parsed.success) return reply({ error: 'Invalid request' }, 400);

  const result = await appActorStore.run(actor, () => action.run(...(parsed.data as unknown[])));
  return reply(result, 200);
}
