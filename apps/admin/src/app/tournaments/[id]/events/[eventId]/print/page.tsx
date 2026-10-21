import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { formatClubEventTime, groupLabel, isDoublesEvent, TOURNAMENT_EVENT_TYPE_LABELS } from '@badminton/shared';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { readTournamentCourts } from '@/lib/tournament-courts';
import type { PairWithPlayers, ParticipantWithPlayer, TournamentMatchRow } from '@/lib/tournament-types';
import { getName } from '../components/entry-name';
import { PrintButton } from './print-button';

// A SHEET FOR THE WALL. The event's groups (who is in which) and every match
// in the order it is played, with a court, a time and empty score boxes, so
// the desk can pin it up and players can find their next game. The admin
// chrome stays on screen; `.print-sheet` in globals.css is the only thing the
// printer sees.

export default async function EventPrintPage({ params }: { params: Promise<{ id: string; eventId: string }> }) {
  const { id: tournamentId, eventId } = await params;
  await requireCapability('tournaments.page');
  const supabase = createAdminClient();

  const [{ data: tournament }, { data: event }] = await Promise.all([
    supabase.from('tournaments').select('id, name, start_date').eq('id', tournamentId).single(),
    supabase.from('tournament_events').select('*').eq('id', eventId).eq('tournament_id', tournamentId).single(),
  ]);
  if (!tournament || !event) notFound();
  const doubles = isDoublesEvent(event.event_type);

  const [{ data: pairData }, { data: participantData }, { data: matchData }, courts] = await Promise.all([
    doubles
      ? supabase
          .from('tournament_pairs')
          .select(
            '*, player1:players!tournament_pairs_player1_id_fkey(id, full_name), player2:players!tournament_pairs_player2_id_fkey(id, full_name)',
          )
          .eq('event_id', eventId)
      : Promise.resolve({ data: [] }),
    supabase.from('tournament_participants').select('*, player:players!player_id(id, full_name)').eq('event_id', eventId),
    supabase.from('tournament_matches').select('*').eq('event_id', eventId),
    readTournamentCourts(supabase, tournamentId),
  ]);

  const pairs = (pairData ?? []) as unknown as PairWithPlayers[];
  const participants = (participantData ?? []) as unknown as ParticipantWithPlayer[];
  // A doubles event's solo entrants (00102) are participants too.
  const entries: Array<PairWithPlayers | ParticipantWithPlayer> = doubles ? [...pairs, ...participants] : participants;
  const names = new Map<string, string>();
  for (const pair of pairs) names.set(pair.id, getName(pair, true));
  for (const participant of participants) names.set(participant.id, getName(participant, false));
  const courtLabel = new Map((courts ?? []).map((court) => [court.id, court.label]));

  const groupCount = (event as { group_count?: number | null }).group_count ?? 1;
  const groupOf = (entry: { group_number?: number | null }) => entry.group_number ?? null;
  const groups =
    groupCount >= 2
      ? Array.from({ length: groupCount }, (_, i) => i + 1).map((group) => ({
          title: `Group ${groupLabel(group)}`,
          rows: entries.filter((entry) => groupOf(entry as { group_number?: number | null }) === group),
        }))
      : [{ title: 'Entries', rows: entries }];
  const seedOf = (entry: PairWithPlayers | ParticipantWithPlayer) => (entry as { seed_number?: number | null }).seed_number ?? null;
  for (const group of groups) {
    group.rows.sort((a, b) => (seedOf(a) ?? 999) - (seedOf(b) ?? 999) || (names.get(a.id) ?? '').localeCompare(names.get(b.id) ?? ''));
  }

  const side = (match: TournamentMatchRow, which: 'a' | 'b') => {
    const id = which === 'a' ? (match.pair_a_id ?? match.participant_a_id) : (match.pair_b_id ?? match.participant_b_id);
    return id ? (names.get(id) ?? 'TBD') : 'TBD';
  };
  const matches = ((matchData ?? []) as TournamentMatchRow[])
    .filter((match) => !match.is_bye && match.status !== 'voided')
    .sort(
      (a, b) =>
        (a.scheduled_time ?? '').localeCompare(b.scheduled_time ?? '') ||
        (a.stage ?? 0) - (b.stage ?? 0) ||
        a.round_number - b.round_number ||
        (a.group_number ?? 0) - (b.group_number ?? 0) ||
        (a.match_number ?? a.bracket_position) - (b.match_number ?? b.bracket_position),
    );
  const showTime = matches.some((match) => match.scheduled_time);
  const showGroup = groupCount >= 2;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/tournaments/${tournamentId}/events/${eventId}`}
          className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)]"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to the event
        </Link>
        <PrintButton />
      </div>

      <div className="print-sheet rounded-xl border border-[var(--border)] bg-white p-8 text-black">
        <header className="mb-6 border-b border-black/20 pb-4">
          <div className="text-xs uppercase tracking-[0.18em] text-black/60">{tournament.name}</div>
          <h1 className="mt-1 text-3xl font-bold">
            {event.name ?? TOURNAMENT_EVENT_TYPE_LABELS[event.event_type as keyof typeof TOURNAMENT_EVENT_TYPE_LABELS]}
          </h1>
        </header>

        <section className="mb-8">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.14em]">{groupCount >= 2 ? 'Groups' : 'Entries'}</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 print:grid-cols-3">
            {groups.map((group) => (
              <div key={group.title} className="break-inside-avoid rounded-lg border border-black/30 p-3">
                <div className="mb-2 font-bold">{group.title}</div>
                {group.rows.length === 0 ? (
                  <div className="text-sm text-black/50">Nobody yet</div>
                ) : (
                  <ol className="list-decimal space-y-1 pl-5 text-sm">
                    {group.rows.map((entry) => (
                      <li key={entry.id}>
                        {names.get(entry.id)}
                        {seedOf(entry) ? <span className="text-black/50"> (seed {seedOf(entry)})</span> : null}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.14em]">Match schedule</h2>
          {matches.length === 0 ? (
            <p className="text-sm text-black/60">No matches yet. Make the draw first.</p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b-2 border-black text-left">
                  <th className="py-1.5 pr-2">#</th>
                  <th className="py-1.5 pr-2">Round</th>
                  {showGroup && <th className="py-1.5 pr-2">Group</th>}
                  {showTime && <th className="py-1.5 pr-2">Time</th>}
                  <th className="py-1.5 pr-2">Court</th>
                  <th className="py-1.5 pr-2">Match</th>
                  <th className="w-32 py-1.5">Score</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((match, i) => (
                  <tr key={match.id} className="break-inside-avoid border-b border-black/20">
                    <td className="py-2 pr-2 align-top">{i + 1}</td>
                    <td className="py-2 pr-2 align-top">{match.round_name ?? `Round ${match.round_number}`}</td>
                    {showGroup && (
                      <td className="py-2 pr-2 align-top">{match.group_number ? groupLabel(match.group_number) : ''}</td>
                    )}
                    {showTime && (
                      <td className="whitespace-nowrap py-2 pr-2 align-top">
                        {match.scheduled_time ? formatClubEventTime(match.scheduled_time) : ''}
                      </td>
                    )}
                    <td className="py-2 pr-2 align-top">
                      {(match.court_id && courtLabel.get(match.court_id)) ?? match.court ?? ''}
                    </td>
                    <td className="py-2 pr-2 align-top">
                      {side(match, 'a')} <span className="text-black/50">vs</span> {side(match, 'b')}
                    </td>
                    <td className="py-2 align-top">
                      <div className="h-6 border-b border-black/40" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
