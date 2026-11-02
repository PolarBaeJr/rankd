'use client';

import { useMemo, useState } from 'react';
import { ArrowRight, MapPin } from 'lucide-react';
import { allowedTournamentCourts, courtLabel, parseFormatConfig, stageCourtLabels, type TournamentCourt } from '@badminton/shared';
import type {
  TournamentMatchRow,
  TournamentEventRow,
  ParticipantWithPlayer,
  PairWithPlayers,
} from '@/lib/tournament-types';
import {
  deskRows, nextCallable, deskCounts, buildEntryMaps, deskEventPlaying, hasCourtsTab, deskCourtSuggestion,
} from '@/lib/live-desk';
import { getName } from './entry-name';
import { ScoreEntryDialog } from './ScoreEntryDialog';

// ---------------------------------------------------------------------------
// THE LIVE STRIP: what is on court and what is next, above every tab.
//
// The Court Management tab is where an event is run, but an exec reading the
// draw or the check-in list mid-event has to leave it to learn that a match has
// finished on court 3 and is waiting for its score. This bar carries the two
// facts worth interrupting any tab for: the matches on court with no result yet
// (tap one to score it), and the one to call next. Everything else stays on the
// courts tab, one button away.
//
// THE SAME LIST AS THE COURTS TAB, from lib/live-desk.ts, so the two never
// disagree about which match is next or how many are on court.
//
// No "on court for 12 minutes": nothing records when a match went live, and a
// duration guessed from updated_at would be reset by every ready mark.
// ---------------------------------------------------------------------------

interface Props {
  /** The WHOLE event, both halves, as the courts tab is given it. */
  matches: TournamentMatchRow[];
  event: TournamentEventRow;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
  /** tournaments.results.enter.write. Without it the chips are read-only text. */
  canEnterResult: boolean;
  /** The tournament's courts (00273) and the ones in use, for the free-court hint. */
  courts: TournamentCourt[] | null;
  busyCourtIds: string[];
  onOpenCourts: () => void;
}

export function LiveStrip({
  matches,
  event,
  participants,
  pairs,
  isDoubles,
  canEnterResult,
  courts,
  busyCourtIds,
  onOpenCourts,
}: Props) {
  const { nameMap, seedMap, placeableEntries } = useMemo(() => {
    const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
    return buildEntryMaps(entries, (e) => getName(e, isDoubles));
  }, [isDoubles, pairs, participants]);

  const rows = useMemo(() => {
    const sideOf = (entryId: string | null) =>
      entryId && nameMap[entryId] !== undefined
        ? { entryId, label: nameMap[entryId]! }
        : { entryId: null, label: 'TBD' };
    return deskRows(matches, sideOf, isDoubles);
  }, [matches, nameMap, isDoubles]);

  // HELD AS AN ID AND LOOKED UP IN `matches`, THE UNFILTERED LIST, for the reason
  // the courts tab gives: a score makes the match `completed`, which drops it out
  // of `rows`, and the dialog's after-game summary is rendered after that. Looked
  // up in `rows` the dialog would unmount at the moment it had something to say.
  const [scoreMatchId, setScoreMatchId] = useState<string | null>(null);
  const scoreMatch = scoreMatchId ? matches.find((m) => m.id === scoreMatchId) ?? null : null;

  const canScore = canEnterResult && deskEventPlaying(event.status, event.format as string);
  const cannotScore = canScore ? null
    : !canEnterResult ? 'You cannot enter scores for this event.' : 'Scores open when the tournament starts.';
  const onCourt = rows.filter((r) => r.state === 'live');
  const next = nextCallable(rows);
  const counts = deskCounts(rows);
  const cfg = useMemo(
    () => (event.format === 'staged' ? parseFormatConfig(event.format_config) : null),
    [event.format, event.format_config],
  );
  const allowed = next && courts ? allowedTournamentCourts(courts, stageCourtLabels(cfg, next.match)) : null;
  const suggested = next ? deskCourtSuggestion(next, courts, new Set(busyCourtIds), allowed) : null;

  // The same condition that adds the courts tab, so the button below can never
  // point at a tab that is not there.
  const show = hasCourtsTab(event.status) && rows.length > 0;

  return (
    <>
      {show && (
        <section
          aria-label="Live courts"
          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 space-y-2"
        >
          {onCourt.length > 0 && (
            <div className="flex items-center gap-2 min-w-0">
              <p className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Needs a score
              </p>
              <div className="flex gap-2 overflow-x-auto min-w-0 -my-1 py-1">
                {onCourt.map(({ match, a, b }) => {
                  const text = `${a.label} vs ${b.label}`;
                  const court = courtLabel(match.court) ?? 'No court';
                  const chip =
                    'inline-flex items-center gap-2 shrink-0 min-h-[44px] max-w-[18rem] px-3 rounded-md border text-xs ' +
                    'border-[color-mix(in_srgb,var(--color-success)_45%,transparent)] ' +
                    'bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)] text-[var(--text-primary)]';
                  const body = (
                    <>
                      <span className="truncate">{text}</span>
                      <span className="shrink-0 font-semibold text-[var(--color-success)]">{court}</span>
                    </>
                  );
                  return canScore ? (
                    <button
                      key={match.id}
                      type="button"
                      onClick={() => setScoreMatchId(match.id)}
                      aria-label={`Enter the score for ${a.label} versus ${b.label}, ${court}`}
                      className={`${chip} hover:border-[var(--color-success)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]`}
                    >
                      {body}
                    </button>
                  ) : (
                    <span key={match.id} className={chip} title={cannotScore ?? undefined}>{body}</span>
                  );
                })}
              </div>
            </div>
          )}
          {onCourt.length > 0 && cannotScore && (
            <p className="text-xs text-[var(--text-muted)]">{cannotScore}</p>
          )}

          <div className="flex items-start gap-2 min-w-0 text-xs">
            <ArrowRight className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--color-accent)]" aria-hidden />
            {next ? (
              <p className="min-w-0 text-[var(--text-primary)]">
                <span className="font-semibold uppercase tracking-wide text-[11px] text-[var(--color-accent)]">Up next </span>
                <span className="break-words">
                  {next.a.label} <span className="text-[var(--text-muted)]">vs</span> {next.b.label}
                </span>
                <span className="text-[var(--text-muted)]">
                  {' · '}{courtLabel(next.match.court) ?? 'no court yet'}
                  {suggested && ` · ${courtLabel(suggested.label)} is free`}
                </span>
              </p>
            ) : (
              <p className="min-w-0 text-[var(--text-muted)]">
                Nothing to call yet.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--line)]">
            <p className="text-xs text-[var(--text-muted)]" role="status">
              {counts.live} on court · {counts.callable} ready · {counts.waiting} waiting
            </p>
            <button
              type="button"
              onClick={onOpenCourts}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-md border border-[var(--line)] text-xs font-medium text-[var(--text-primary)] hover:border-[var(--border-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              <MapPin className="w-3.5 h-3.5" aria-hidden />
              Court management
            </button>
          </div>
        </section>
      )}

      {scoreMatch && (
        <ScoreEntryDialog
          match={scoreMatch}
          event={event}
          nameMap={nameMap}
          seedMap={seedMap}
          isDoubles={isDoubles}
          entries={placeableEntries}
          onClose={() => setScoreMatchId(null)}
        />
      )}
    </>
  );
}
