import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { discordServiceUnauthorized, isAuthorizedDiscordService } from '@/lib/discord-service-auth';
import { checkDiscordManager, managerInput } from '@/lib/discord-manager';

export const dynamic = 'force-dynamic';

// May this person change the club's bot setup from this server? Asked by
// /setup and /config before they do anything, so a refusal arrives before
// /setup has created a single role. See discord-manager.ts.
//
// A refusal is a 200 with a named reason, as on force-link: the app answered,
// and the bot turns the reason into a sentence. Only a failed read is a 503.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const input = managerInput(body);
  if (!input) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const setup = (body as { setup?: unknown }).setup === true;

  const check = await checkDiscordManager(createServiceRoleClient(), { ...input, setup });
  if (!check.ok && check.refusal === 'unavailable') {
    return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
  }
  return NextResponse.json(check);
}
