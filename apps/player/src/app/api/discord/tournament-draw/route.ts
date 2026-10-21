import { NextResponse } from 'next/server';
import { groupLabel, isDoublesEvent, isPoolToBracket, playsRoundRobin } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import {
  PAIR_COLUMNS,
  PARTICIPANT_COLUMNS,
  eventTypeLabel,
  matchLine,
  pairDisplayName,
  participantDisplayName,
  publicBase,
  sideIds,
  tournamentsOn,
  type MatchRow,
} from '@/lib/discord-tournament-text';

export const dynamic = 'force-dynamic';

// /tournaments draw: one event's draw as text, for anybody in the server. The
// draw is public on the website, so nothing here is per caller.
//
// The knockout is one line per match, side A first ("R1 #3 Smith 21-15 21-18
// Jones"), a section per round. A round robin or pool is its standings, wins
// and losses from the completed matches. The bot splits the sections across
// embeds; `truncated` says the line cap here was reached and the website has
// the rest.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINES = 400;

type Section = { title: string; lines: string[] };

function notFound() {
  return NextResponse.json({ found: false });
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const eventId = new URL(request.url).searchParams.get('eventId') ?? '';
  if (!UUID.test(eventId)) return notFound();

  const supabase = createServiceRoleClient();
  if (!(await tournamentsOn(supabase))) return notFound();

  const { data: event, error: eventError } = await supabase
    .from('tournament_events')
    .select('id, tournament_id, event_type, status, format, tournament:tournaments(id, name, status, suspended_at, suspension_reason)')
    .eq('id', eventId)
    .maybeSingle();
  if (eventError) {
    console.error('[discord] tournament draw event read failed:', eventError.message);
    return NextResponse.json({ error: 'draw_unavailable' }, { status: 503 });
  }
  const tournamentEmbed = event?.tournament;
  const tournament = (Array.isArray(tournamentEmbed) ? tournamentEmbed[0] : tournamentEmbed) as
    | { id: string; name: string; status: string; suspended_at: string | null; suspension_reason: string | null }
    | null
    | undefined;
  // A draft is not found, as on the website.
  if (!event || !tournament || tournament.status === 'draft') return notFound();

  const doubles = isDoublesEvent(event.event_type);

  // The event page's own reads, column for column. A STAGED event also needs
  // the stage columns, asked for with the old list as the fallback because
  // PostgREST fails the whole request on a column the database has not got.
  const entriesRes = doubles
    ? await supabase.from('tournament_pairs').select(PAIR_COLUMNS).eq('event_id', eventId).order('seed_number')
    : await supabase.from('tournament_participants').select(PARTICIPANT_COLUMNS).eq('event_id', eventId).order('seed_number');
  if (entriesRes.error) {
    console.error('[discord] tournament draw entries read failed:', entriesRes.error.message);
    return NextResponse.json({ error: 'draw_unavailable' }, { status: 503 });
  }

  const staged = event.format === 'staged';
  const stagedRes = staged
    ? await supabase
      .from('tournament_matches')
      .select('id, round_number, bracket_position, round_name, court, status, scores, is_bye, is_third_place, phase, participant_a_id, participant_b_id, pair_a_id, pair_b_id, winner_participant_id, winner_pair_id, ready_player_ids, stage, pool_number, group_number, slot, match_label, match_number, handicap_a, handicap_b')
      .eq('event_id', eventId)
      .order('round_number')
      .order('bracket_position')
    : null;
  const stagedColumnsMissing = stagedRes?.error != null
    && (stagedRes.error.code === '42703' || stagedRes.error.code === 'PGRST204');
  const matchesRes = stagedRes && !stagedColumnsMissing
    ? stagedRes
    : await supabase
      .from('tournament_matches')
      .select('id, round_number, bracket_position, round_name, court, status, scores, is_bye, is_third_place, phase, participant_a_id, participant_b_id, pair_a_id, pair_b_id, winner_participant_id, winner_pair_id, ready_player_ids')
      .eq('event_id', eventId)
      .order('round_number')
      .order('bracket_position');
  if (matchesRes.error) {
    console.error('[discord] tournament draw matches read failed:', matchesRes.error.message);
    return NextResponse.json({ error: 'draw_unavailable' }, { status: 503 });
  }

  const entries = (entriesRes.data ?? []) as unknown as Record<string, unknown>[];
  const names = new Map<string, string>(
    entries.map((e) => [e.id as string, doubles ? pairDisplayName(e) : participantDisplayName(e)]),
  );
  const matches = ((matchesRes.data ?? []) as unknown as MatchRow[]).filter((m) => !m.is_bye);

  // Which matches are pool play: the pool phase of a pool_to_bracket event,
  // every match of a round robin, and a staged event's pooled matches.
  const isPool = (m: MatchRow) =>
    staged ? m.pool_number != null : isPoolToBracket(event.format) ? m.phase === 'pool' : playsRoundRobin(event.format);

  const sections: Section[] = [];
  const pools = new Map<string, MatchRow[]>();
  for (const m of matches.filter(isPool)) {
    const key = staged ? `${m.stage ?? 1}:${m.pool_number ?? m.group_number ?? 1}` : String(m.group_number ?? 1);
    pools.set(key, [...(pools.get(key) ?? []), m]);
  }
  for (const [key, poolMatches] of pools) {
    const record = new Map<string, { won: number; lost: number }>();
    for (const m of poolMatches) {
      const ids = sideIds(m, doubles);
      for (const id of [ids.a, ids.b]) if (id && !record.has(id)) record.set(id, { won: 0, lost: 0 });
      if ((m.status !== 'completed' && m.status !== 'walkover') || !ids.winner) continue;
      const loser = ids.winner === ids.a ? ids.b : ids.a;
      record.get(ids.winner)!.won += 1;
      if (loser) record.get(loser)!.lost += 1;
    }
    const standings = [...record.entries()].sort(
      ([, a], [, b]) => b.won - a.won || a.lost - b.lost,
    );
    const number = Number(key.split(':').pop());
    sections.push({
      title: pools.size === 1 && !staged ? 'Round robin' : `Pool ${groupLabel(number)}`,
      lines: standings.map(([id, r], i) => `${i + 1}. ${names.get(id) ?? 'TBD'} ${r.won}-${r.lost}`),
    });
  }

  const rounds = new Map<string, MatchRow[]>();
  for (const m of matches.filter((m) => !isPool(m))) {
    const title = m.round_name ?? `Round ${m.round_number}`;
    rounds.set(title, [...(rounds.get(title) ?? []), m]);
  }
  for (const [title, roundMatches] of rounds) {
    sections.push({ title, lines: roundMatches.map((m) => matchLine(m, doubles, names)) });
  }

  // Cut whole lines at the cap, never a line in half.
  let budget = MAX_LINES;
  let truncated = false;
  const capped: Section[] = [];
  for (const section of sections) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    if (section.lines.length > budget) truncated = true;
    capped.push({ title: section.title, lines: section.lines.slice(0, budget) });
    budget -= section.lines.length;
  }

  const base = publicBase();
  return NextResponse.json({
    found: true,
    tournament: { id: tournament.id, name: tournament.name },
    event: { id: event.id, label: eventTypeLabel(event.event_type), status: event.status },
    suspended: tournament.suspended_at
      ? { reason: tournament.suspension_reason ?? null }
      : null,
    url: base ? `${base}/tournaments/${tournament.id}/events/${event.id}` : null,
    sections: capped,
    truncated,
  });
}
