export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { PageHeader } from '@badminton/ui';
import { busyCourtIds, eventIsPlaying, isDoublesEvent, type TournamentEventType } from '@badminton/shared';
import { createAdminClient } from '@/lib/supabase-server';
import { requireConsoleUser } from '@/lib/court-helper-gate';
import { readMyCourts } from '@/lib/court-helpers';
import { getReleaseFlags } from '@/lib/release-flags';
import { readMyCourtsFingerprint } from '@/lib/live-fingerprint';
import { readLiveCourtUse, readTournamentCourts } from '@/lib/tournament-courts';
import type { PairWithPlayers, ParticipantWithPlayer, TournamentEventRow, TournamentMatchRow } from '@/lib/tournament-types';
import { LiveTournament } from '../tournaments/live-tournament';
import { MyCourtsBoard, type BoardEvent } from './my-courts-board';
import { RefreshOnReturn } from './refresh-on-return';

// A COURT HELPER'S PAGE (00310). Every court this person was named to in an
// running tournament, with the match on it now, its score form and the match it
// takes next. Open to every console level (BASELINE_SECTIONS); what it shows
// is decided by the helper rows, and the save is checked again on the server.
export default async function MyCourtsPage() {
  const { viewer } = await requireConsoleUser();
  const supabase = createAdminClient();
  // What quiet refresh compares its probe against, started before the page's
  // own reads so a change during the render reads as a change.
  const fingerprintRead = getReleaseFlags().then((flags) =>
    flags.quiet_refresh ? readMyCourtsFingerprint(supabase, viewer.id as string).catch(() => null) : undefined,
  );
  const mine = await readMyCourts(supabase, viewer.id as string);

  if (mine.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="My courts" />
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center space-y-2">
          <p className="text-sm text-[var(--text-muted)]">You are not helping on any court right now.</p>
          <Link href="/dashboard" className="text-sm text-[var(--color-accent)] hover:underline">
            Back to the dashboard
          </Link>
        </div>
      </div>
    );
  }

  const byTournament = new Map<string, { name: string; courtIds: string[] }>();
  for (const row of mine) {
    const entry = byTournament.get(row.tournament_id) ?? { name: row.tournament_name, courtIds: [] };
    entry.courtIds.push(row.court_id);
    byTournament.set(row.tournament_id, entry);
  }

  const [releaseFlags, sections] = await Promise.all([getReleaseFlags(), Promise.all(
    [...byTournament.entries()].map(async ([tournamentId, { name, courtIds }]) => {
      const [courts, liveUse, { data: events }] = await Promise.all([
        readTournamentCourts(supabase, tournamentId).catch(() => null),
        readLiveCourtUse(supabase, tournamentId).catch(() => null),
        supabase.from('tournament_events').select('*').eq('tournament_id', tournamentId).eq('format', 'staged'),
      ]);
      const playing = ((events ?? []) as TournamentEventRow[]).filter((ev) => eventIsPlaying(ev.status as string));
      const boardEvents: BoardEvent[] = await Promise.all(
        playing.map(async (event) => {
          const isDoubles = isDoublesEvent(event.event_type as TournamentEventType);
          const [{ data: matches }, { data: pairs }, { data: participants }] = await Promise.all([
            supabase.from('tournament_matches').select('*').eq('event_id', event.id).order('round_number').order('bracket_position'),
            isDoubles
              ? supabase
                  .from('tournament_pairs')
                  .select('*, player1:players!tournament_pairs_player1_id_fkey(id, full_name, avatar_url), player2:players!tournament_pairs_player2_id_fkey(id, full_name, avatar_url)')
                  .eq('event_id', event.id)
              : Promise.resolve({ data: [] }),
            isDoubles
              ? Promise.resolve({ data: [] })
              : supabase
                  .from('tournament_participants')
                  .select('*, player:players!player_id(id, full_name, avatar_url)')
                  .eq('event_id', event.id),
          ]);
          return {
            event,
            isDoubles,
            matches: (matches ?? []) as TournamentMatchRow[],
            pairs: (pairs ?? []) as unknown as PairWithPlayers[],
            participants: (participants ?? []) as unknown as ParticipantWithPlayer[],
          };
        }),
      );
      return {
        tournamentId,
        name,
        courts: courts ?? [],
        courtIds,
        busyCourtIds: courts && liveUse ? [...busyCourtIds(courts, liveUse)] : [],
        events: boardEvents,
      };
    }),
  )]);
  const fingerprint = await fingerprintRead;

  return (
    <div className="space-y-6">
      <RefreshOnReturn quiet={fingerprint !== undefined ? { probe: '/my-courts/fingerprint', fingerprint } : undefined} />
      <PageHeader title="My courts" sub="The courts you are keeping score on. Save the score when a match ends; the next match goes on by itself." />
      {sections.map((section) => (
        <section key={section.tournamentId} className="space-y-3" aria-label={section.name}>
          {/* Refreshes when the desk or another helper changes a match, so the
              court shows what is on it now. One channel per tournament. */}
          <LiveTournament
            channel={`admin-my-courts-${section.tournamentId}`}
            tournamentId={section.tournamentId}
            eventIds={section.events.map((e) => e.event.id)}
            draw
            quiet={fingerprint !== undefined}
          />
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">{section.name}</h2>
          <MyCourtsBoard
            courts={section.courts}
            courtIds={section.courtIds}
            busyCourtIds={section.busyCourtIds}
            events={section.events}
            courtVoid={releaseFlags.desk_helper_void}
            skipAbsent={releaseFlags.auto_call_skips_absent}
          />
        </section>
      ))}
    </div>
  );
}
