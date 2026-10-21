import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import * as Sentry from '@sentry/nextjs';
import { isDoublesEvent, isExpectedFailure } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import { resolveDiscordPlayer, type PlayRefusal } from '@/lib/discord-member';
import { enterEventCore, type EntryPlayer } from '@/lib/tournament-entry-core';
import { eventTypeLabel, publicBase } from '@/lib/discord-tournament-text';

export const dynamic = 'force-dynamic';

// /tournaments enter: the caller enters a singles event as themselves.
//
// THE CALLER IS THE ACTOR, resolved from the Discord id through
// player_discord_links, and the checks before the entry are the web's own:
// standing, the tournaments switch and the club's legal documents
// (resolveDiscordPlayer). The entry itself is enterEventCore, the body of the
// web's registerForEvent, so every rule (window, capacity, membership,
// category, the per-member cap) is the same code.
//
// TWO KINDS OF ENTRY STAY ON THE WEBSITE, answered as 'website' with the link:
//   - a tournament with its own event waiver. Accepting it is a SIGNED record,
//     and Discord never creates one: eventWaiverAccepted is never sent.
//   - a doubles event. Entering one alone is agreeing to be paired with
//     whoever the exec chooses, and that sentence is the website's dialog.
//
// A refusal is a 200 with a code, as on the challenges route; 'rule' carries
// the app's own sentence.

type Refusal = PlayRefusal | 'not_found' | 'website' | 'rule';

function refuse(refusal: Refusal, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, refusal, ...extra });
}

const SNOWFLAKE = /^\d{5,25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const discordUserId = typeof payload.discordUserId === 'string' ? payload.discordUserId : '';
  const eventId = typeof payload.eventId === 'string' ? payload.eventId : '';
  if (!SNOWFLAKE.test(discordUserId) || !UUID.test(eventId)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const caller = await resolveDiscordPlayer(supabase, discordUserId, { feature: 'tournaments' });
  if (!caller.ok) {
    if (caller.refusal === 'unavailable') {
      return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
    }
    return refuse(caller.refusal);
  }

  const { data: event, error: eventError } = await supabase
    .from('tournament_events')
    .select('id, tournament_id, event_type, tournament:tournaments(status, waiver_text)')
    .eq('id', eventId)
    .maybeSingle();
  if (eventError) {
    console.error('[discord] tournament entry event read failed:', eventError.message);
    return NextResponse.json({ error: 'event_unavailable' }, { status: 503 });
  }
  const tournamentEmbed = event?.tournament;
  const tournament = (Array.isArray(tournamentEmbed) ? tournamentEmbed[0] : tournamentEmbed) as
    | { status: string; waiver_text: string | null }
    | null
    | undefined;
  if (!event || !tournament || tournament.status === 'draft') return refuse('not_found');

  if (tournament.waiver_text?.trim() || isDoublesEvent(event.event_type)) {
    const base = publicBase();
    return refuse('website', {
      url: base ? `${base}/tournaments/${event.tournament_id}/events/${event.id}` : null,
    });
  }

  let tournamentId: string;
  try {
    // No options: no event waiver to accept (refused above) and no doubles
    // acknowledgement (refused above). No user agent: nothing is signed.
    ({ tournamentId } = await enterEventCore(supabase, caller.player as EntryPlayer, eventId, {}, null));
  } catch (err) {
    if (isExpectedFailure(err)) return refuse('rule', { message: (err as Error).message });
    throw err;
  }

  try {
    revalidatePath('/tournaments');
    revalidatePath(`/tournaments/${tournamentId}`);
    revalidatePath(`/tournaments/${tournamentId}/events/${eventId}`);
  } catch (err) {
    Sentry.captureException(err, { extra: { step: 'discord-tournament-entry-revalidate', eventId } });
  }

  return NextResponse.json({ ok: true, event: eventTypeLabel(event.event_type) });
}
