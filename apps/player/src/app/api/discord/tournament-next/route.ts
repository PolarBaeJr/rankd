import { NextResponse } from 'next/server';
import { formatClubEventTime, isDoublesEvent, isOutOfEvent, type TournamentEventType } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import { resolveDiscordMember } from '@/lib/discord-member';
import {
  eventTypeLabel,
  loadEntryNames,
  matchRef,
  publicBase,
  sideIds,
  tournamentsOn,
  type MatchRow,
} from '@/lib/discord-tournament-text';

export const dynamic = 'force-dynamic';

// /tournaments next: the caller's own next tournament match.
//
// The caller is the Discord id the bot read off the interaction, sent as a
// header and resolved through player_discord_links; nothing in the request
// names a club player. Only the link is needed, not the play gate: this reads
// the caller's own entries and writes nothing.
//
// Their open entries are their participant rows and the pairs they are half of,
// in active tournaments, not withdrawn or disqualified. Of the matches those
// entries are in, the next one is the first that is on court, then waiting to
// be called, then scheduled with both sides known, then any other, and within
// that the earliest round.

const SNOWFLAKE = /^\d{5,25}$/;
const PLAYABLE = ['pending', 'ready', 'live'];

function rank(m: MatchRow, sides: { a: string | null; b: string | null }): number {
  if (m.status === 'live') return 0;
  if (m.status === 'ready') return 1;
  return sides.a && sides.b ? 2 : 3;
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const discordUserId = request.headers.get('x-discord-user-id') ?? '';
  if (!SNOWFLAKE.test(discordUserId)) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const supabase = createServiceRoleClient();
  const caller = await resolveDiscordMember(supabase, discordUserId);
  if (!caller.ok) {
    if (caller.refusal === 'unavailable') {
      return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
    }
    return NextResponse.json({ linked: false });
  }
  if (!(await tournamentsOn(supabase))) return NextResponse.json({ linked: true, match: null });
  const playerId = caller.player.id;

  const [participantRes, pairRes] = await Promise.all([
    supabase.from('tournament_participants').select('id, event_id, status').eq('player_id', playerId),
    supabase
      .from('tournament_pairs')
      .select('id, event_id, status')
      .or(`player1_id.eq.${playerId},player2_id.eq.${playerId}`),
  ]);
  if (participantRes.error || pairRes.error) {
    console.error('[discord] tournament next entries read failed');
    return NextResponse.json({ error: 'entries_unavailable' }, { status: 503 });
  }
  const entries = [
    ...((participantRes.data ?? []) as { id: string; event_id: string; status: string }[]),
    ...((pairRes.data ?? []) as { id: string; event_id: string; status: string }[]),
  ].filter((e) => !isOutOfEvent(e.status));
  if (entries.length === 0) return NextResponse.json({ linked: true, match: null });

  const { data: events, error: eventsError } = await supabase
    .from('tournament_events')
    .select('id, event_type, tournament:tournaments(id, name, status, suspended_at, suspension_reason)')
    .in('id', [...new Set(entries.map((e) => e.event_id))]);
  if (eventsError) {
    console.error('[discord] tournament next events read failed:', eventsError.message);
    return NextResponse.json({ error: 'entries_unavailable' }, { status: 503 });
  }
  type TournamentEmbed = { id: string; name: string; status: string; suspended_at: string | null; suspension_reason: string | null };
  const activeEvents = new Map<string, { event_type: string; tournament: TournamentEmbed }>();
  for (const e of (events ?? []) as { id: string; event_type: string; tournament: TournamentEmbed | TournamentEmbed[] | null }[]) {
    const tournament = Array.isArray(e.tournament) ? e.tournament[0] : e.tournament;
    if (tournament?.status === 'active') activeEvents.set(e.id, { event_type: e.event_type, tournament });
  }
  const myEntries = new Set(entries.filter((e) => activeEvents.has(e.event_id)).map((e) => e.id));
  if (myEntries.size === 0) return NextResponse.json({ linked: true, match: null });

  const eventIds = [...activeEvents.keys()];
  const { data: matchRows, error: matchesError } = await supabase
    .from('tournament_matches')
    .select('id, event_id, round_number, bracket_position, round_name, court, scheduled_time, status, scores, is_bye, phase, participant_a_id, participant_b_id, pair_a_id, pair_b_id, winner_participant_id, winner_pair_id')
    .in('event_id', eventIds)
    .in('status', PLAYABLE)
    .order('round_number')
    .order('bracket_position');
  if (matchesError) {
    console.error('[discord] tournament next matches read failed:', matchesError.message);
    return NextResponse.json({ error: 'matches_unavailable' }, { status: 503 });
  }

  type NextRow = MatchRow & { event_id: string; scheduled_time: string | null };
  const candidates = ((matchRows ?? []) as unknown as NextRow[])
    .filter((m) => !m.is_bye)
    .map((m) => {
      const doubles = isDoublesEvent(activeEvents.get(m.event_id)!.event_type as TournamentEventType);
      return { m, doubles, sides: sideIds(m, doubles) };
    })
    .filter(({ sides }) => (sides.a && myEntries.has(sides.a)) || (sides.b && myEntries.has(sides.b)))
    .sort((x, y) => rank(x.m, x.sides) - rank(y.m, y.sides) || x.m.round_number - y.m.round_number);
  const next = candidates[0];
  if (!next) return NextResponse.json({ linked: true, match: null });

  const names = await loadEntryNames(supabase, [next.m.event_id]);
  if (names === 'unavailable') return NextResponse.json({ error: 'names_unavailable' }, { status: 503 });

  const opponentId = next.sides.a && myEntries.has(next.sides.a) ? next.sides.b : next.sides.a;
  const event = activeEvents.get(next.m.event_id)!;
  const base = publicBase();
  return NextResponse.json({
    linked: true,
    match: {
      tournament: event.tournament.name,
      event: eventTypeLabel(event.event_type),
      round: `${next.m.round_name ?? `Round ${next.m.round_number}`} (${matchRef(next.m)})`,
      opponents: opponentId ? names.get(opponentId) ?? 'To be decided' : 'To be decided',
      status: next.m.status,
      court: next.m.court,
      scheduledTime: next.m.scheduled_time ? formatClubEventTime(next.m.scheduled_time) : null,
      suspended: event.tournament.suspended_at ? { reason: event.tournament.suspension_reason ?? null } : null,
      url: base ? `${base}/tournaments/${event.tournament.id}/events/${next.m.event_id}` : null,
    },
  });
}
