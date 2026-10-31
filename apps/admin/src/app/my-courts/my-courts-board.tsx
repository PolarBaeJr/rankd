'use client';

import { useMemo } from 'react';
import { courtLabel, parseFormatConfig, type FormatConfig, type TournamentCourt } from '@badminton/shared';
import { enterCourtHelperResult } from '@/lib/tournament-actions';
import { deskRows, liveEntrants, nextMatchForCourt } from '@/lib/live-desk';
import { CourtCard, type CourtDeskRow, type CourtScoreSave } from '../tournaments/[id]/events/[eventId]/components/CourtCard';
import { getName } from '../tournaments/[id]/events/[eventId]/components/entry-name';
import type { PairWithPlayers, ParticipantWithPlayer, TournamentEventRow, TournamentMatchRow } from '@/lib/tournament-types';

export interface BoardEvent {
  event: TournamentEventRow;
  isDoubles: boolean;
  matches: TournamentMatchRow[];
  pairs: PairWithPlayers[];
  participants: ParticipantWithPlayer[];
}

interface Props {
  /** Every court of the tournament, so a stage's court rules read as at the desk. */
  courts: TournamentCourt[];
  /** The courts this person helps on. */
  courtIds: string[];
  busyCourtIds: string[];
  events: BoardEvent[];
}

const save: CourtScoreSave = (matchId, scores) => enterCourtHelperResult(matchId, scores);

/**
 * One tournament's courts for a helper. Each court shows the event whose match
 * is on it, else the event with a match waiting for it, else a free court.
 */
export function MyCourtsBoard({ courts, courtIds, busyCourtIds, events }: Props) {
  const boards = useMemo(
    () =>
      events.flatMap((e) => {
        const cfg = parseFormatConfig(e.event.format_config);
        if (!cfg) return [];
        const entries: Array<ParticipantWithPlayer | PairWithPlayers> = e.isDoubles ? e.pairs : e.participants;
        const nameMap: Record<string, string> = {};
        for (const entry of entries) nameMap[entry.id] = getName(entry, e.isDoubles);
        const sideOf = (entryId: string | null) =>
          entryId && nameMap[entryId] !== undefined ? { entryId, label: nameMap[entryId]! } : { entryId: null, label: 'TBD' };
        const rows: CourtDeskRow[] = deskRows(e.matches, sideOf, e.isDoubles);
        return [{ eventId: e.event.id, cfg, rows }];
      }),
    [events],
  );
  const courtsInUse = useMemo(() => new Set(busyCourtIds), [busyCourtIds]);
  const mine = courts.filter((c) => c.active && courtIds.includes(c.id));

  if (mine.length === 0) {
    return <p className="text-sm text-[var(--text-muted)]">None of your courts is in use at this tournament.</p>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {mine.map((court) => {
        const onCourt = (b: { rows: CourtDeskRow[] }) =>
          b.rows.some((r) => r.state === 'live' && r.match.court_id === court.id);
        const waiting = (b: { rows: CourtDeskRow[]; cfg: FormatConfig }) => {
          const live = b.rows.find((r) => r.state === 'live' && r.match.court_id === court.id);
          return !!nextMatchForCourt(b.rows, court, courts, b.cfg, { busyEntries: liveEntrants(b.rows, live?.match.id) });
        };
        const board = boards.find(onCourt) ?? boards.find(waiting) ?? boards[0];
        if (!board) {
          return (
            <div
              key={court.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4 space-y-1"
              role="region"
              aria-label={courtLabel(court.label) ?? court.label}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="text-2xl font-bold text-[var(--text-primary)]">{courtLabel(court.label) ?? court.label}</h4>
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Free</span>
              </div>
              <p className="text-sm text-[var(--text-muted)]">No event is being played at this tournament yet.</p>
            </div>
          );
        }
        return (
          <CourtCard
            key={court.id}
            court={court}
            rows={board.rows}
            courts={courts}
            cfg={board.cfg}
            isLive
            canEnterResult
            canManageCourts={false}
            busyElsewhere={courtsInUse.has(court.id) && !onCourt(board)}
            save={save}
          />
        );
      })}
    </div>
  );
}
