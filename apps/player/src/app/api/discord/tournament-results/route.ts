import { NextResponse } from 'next/server';
import { isDoublesEvent, type TournamentEventType } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import {
  eventTypeLabel,
  loadEntryNames,
  matchLine,
  publicBase,
  tournamentsOn,
  type MatchRow,
} from '@/lib/discord-tournament-text';

export const dynamic = 'force-dynamic';

// /tournaments results: what is on court now in one tournament, and the last
// ten results, newest first. Public on the website, so nothing per caller. A
// draft is not found.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECENT_MAX = 10;

const MATCH_COLUMNS =
  'id, event_id, round_number, bracket_position, round_name, court, status, scores, is_bye, phase, participant_a_id, participant_b_id, pair_a_id, pair_b_id, winner_participant_id, winner_pair_id';

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const tournamentId = new URL(request.url).searchParams.get('tournamentId') ?? '';
  if (!UUID.test(tournamentId)) return NextResponse.json({ found: false });

  const supabase = createServiceRoleClient();
  if (!(await tournamentsOn(supabase))) return NextResponse.json({ found: false });

  const [tournamentRes, eventsRes] = await Promise.all([
    supabase
      .from('tournaments')
      .select('id, name, status, suspended_at, suspension_reason')
      .eq('id', tournamentId)
      .maybeSingle(),
    supabase.from('tournament_events').select('id, event_type').eq('tournament_id', tournamentId),
  ]);
  if (tournamentRes.error || eventsRes.error) {
    console.error('[discord] tournament results read failed');
    return NextResponse.json({ error: 'results_unavailable' }, { status: 503 });
  }
  const tournament = tournamentRes.data;
  if (!tournament || tournament.status === 'draft') return NextResponse.json({ found: false });

  const events = new Map(
    ((eventsRes.data ?? []) as { id: string; event_type: string }[]).map((e) => [e.id, e.event_type]),
  );
  const eventIds = [...events.keys()];
  type ResultRow = MatchRow & { event_id: string };
  let live: ResultRow[] = [];
  let recent: ResultRow[] = [];
  let names = new Map<string, string>();
  if (eventIds.length > 0) {
    const [liveRes, recentRes, loaded] = await Promise.all([
      supabase.from('tournament_matches').select(MATCH_COLUMNS).in('event_id', eventIds).eq('status', 'live')
        .order('round_number'),
      supabase.from('tournament_matches').select(MATCH_COLUMNS).in('event_id', eventIds)
        .in('status', ['completed', 'walkover'])
        .not('is_bye', 'is', true)
        .order('result_entered_at', { ascending: false, nullsFirst: false })
        .limit(RECENT_MAX),
      loadEntryNames(supabase, eventIds),
    ]);
    if (liveRes.error || recentRes.error || loaded === 'unavailable') {
      console.error('[discord] tournament results matches read failed');
      return NextResponse.json({ error: 'results_unavailable' }, { status: 503 });
    }
    live = (liveRes.data ?? []) as unknown as ResultRow[];
    recent = (recentRes.data ?? []) as unknown as ResultRow[];
    names = loaded;
  }

  const line = (m: ResultRow) => {
    const eventType = events.get(m.event_id) ?? '';
    return matchLine(m, isDoublesEvent(eventType as TournamentEventType), names, `${eventTypeLabel(eventType)} `);
  };
  const base = publicBase();
  return NextResponse.json({
    found: true,
    tournament: { id: tournament.id, name: tournament.name },
    suspended: tournament.suspended_at ? { reason: tournament.suspension_reason ?? null } : null,
    live: live.filter((m) => !m.is_bye).map(line),
    recent: recent.map(line),
    url: base ? `${base}/tournaments/${tournament.id}` : null,
  });
}
