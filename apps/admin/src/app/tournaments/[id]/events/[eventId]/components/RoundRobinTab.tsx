'use client';

import { useState, useMemo } from 'react';
import { Badge } from '@badminton/ui';
import { ScoreEntryDialog, type DecidedOptions } from './ScoreEntryDialog';
import { RoundShapeControl } from './RoundShapeControl';
import {
  eventIsPlaying,
  groupLabel,
  isOutOfEvent,
  tallyRoundRobin,
  rankRoundRobin,
  poolQualifierCount,
  matchResultLabel,
  type SeedBy,
} from '@badminton/shared';
import { Trophy } from 'lucide-react';
import { getName } from './entry-name';
import type {
  TournamentEventRow,
  TournamentMatchRow,
  ParticipantWithPlayer,
  PairWithPlayers,
  GameScore,
} from '@/lib/tournament-types';

interface Props {
  /** Decided off court and Retired in the score dialog (00329). */
  decided?: DecidedOptions;
  event: TournamentEventRow;
  matches: TournamentMatchRow[];
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
  /**
   * 'pool' when this is the round-robin half of a pool_to_bracket event, null
   * on an ordinary round robin whose matches carry no phase (00107). It is what
   * the per-round shape control addresses its rounds within.
   */
  phase?: 'pool' | null;
}

export function RoundRobinTab({ event, matches, participants, pairs, isDoubles, phase = null, decided }: Props) {
  const [scoreMatch, setScoreMatch] = useState<TournamentMatchRow | null>(null);
  const allMatches = matches;
  // eventIsPlaying covers `pool_live` as well as `live` (00107), which is when
  // the round robin of a pool_to_bracket event is actually being played — the
  // Score button has to be there then or the format cannot record anything. The
  // pre-start statuses are kept alongside it exactly as before, so scores can
  // still be typed in from a drawn-but-not-started event.
  const isLive = eventIsPlaying(event.status) || event.status === 'bracket_generated' || event.status === 'pool_generated';

  const entries = useMemo<Array<ParticipantWithPlayer | PairWithPlayers>>(
    () => (isDoubles ? pairs : participants),
    [isDoubles, pairs, participants]
  );

  // 00106's columns are read structurally: they are not in the generated
  // Database type until the migration has been run and the types regenerated
  // against the database it changed. Same precedent as max_events_per_player.
  const groupCount = (event as { group_count?: number | null }).group_count ?? 1;
  const isGroupStage = groupCount >= 2;
  const qualifiersPerGroup = (event as { qualifiers_per_group?: number | null }).qualifiers_per_group ?? 2;

  const groupOf = useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of entries) {
      const g = (e as { group_number?: number | null }).group_number;
      if (g != null) map[e.id] = g;
    }
    return map;
  }, [entries]);

  // Build name/seed maps. Memoized so they can be stable dependencies of the
  // standings useMemo below (fixes the react-hooks/exhaustive-deps warning).
  const { nameMap, seedMap } = useMemo(() => {
    const nameMap: Record<string, string> = {};
    const seedMap: Record<string, number> = {};
    for (const e of entries) {
      nameMap[e.id] = getName(e, isDoubles);
      if (e.seed_number) seedMap[e.id] = e.seed_number;
    }
    return { nameMap, seedMap };
  }, [entries, isDoubles]);

  // Round robin has no advancement, so the slot editor is inert here — the list
  // exists only to satisfy the shared dialog's contract.
  const placeableEntries = useMemo(
    () => entries
      .filter((e) => e.status !== 'withdrawn' && e.status !== 'disqualified')
      .map((e) => ({ id: e.id, name: nameMap[e.id] ?? 'Unknown' })),
    [entries, nameMap],
  );

  // THE SERVER'S TALLY AND THE SERVER'S ORDER. tallyRoundRobin and
  // rankRoundRobin are what computeRoundRobinStandings runs, so this table puts
  // people in the order that decides who qualifies and who finishes where: head
  // to head, then game and point difference, and the external-event rule. The
  // first key matches the server too: a round robin's own table is read by
  // wins (finalize.ts), the pool of a pool_to_bracket event by its seed_by.
  //
  // A withdrawn or disqualified entry is not ranked, as on the server. Their
  // played matches still count in everyone else's row.
  const seedBy: SeedBy = phase === 'pool' ? ((event.seed_by as SeedBy | null) ?? 'wins') : 'wins';
  const external = event.external_event === true;
  const standings = useMemo(() => {
    const tallied = tallyRoundRobin(
      entries.map((e) => ({
        id: e.id,
        name: nameMap[e.id] ?? 'Unknown',
        group: groupOf[e.id] ?? null,
        out: isOutOfEvent(e.status),
      })),
      allMatches.map((m) => ({
        status: m.status,
        sideA: isDoubles ? m.pair_a_id : m.participant_a_id,
        sideB: isDoubles ? m.pair_b_id : m.participant_b_id,
        winner: isDoubles ? m.winner_pair_id : m.winner_participant_id,
        scores: (m.scores as GameScore[] | null) ?? null,
      })),
    );
    return rankRoundRobin(tallied, { seedBy, grouped: isGroupStage, external });
  }, [allMatches, entries, isDoubles, nameMap, groupOf, seedBy, isGroupStage, external]);

  // WHO QUALIFIES, read the way buildFieldFromOwnPool reads it: the first
  // poolQualifierCount entries of the order above. Drawn as a cut line under
  // the last qualifier of each group.
  const qualifiers = useMemo(
    () => new Set(standings.slice(0, poolQualifierCount(groupCount, event.qualifiers_per_group)).map((s) => s.id)),
    [standings, groupCount, event.qualifiers_per_group],
  );

  // ONE TABLE PER GROUP. A flat round robin is the single-table case and takes
  // the same path with one section and no heading. Filtering the order above by
  // group keeps each group's own order, because that order is depth-major and
  // a group's rows appear in it by groupRank.
  const groupSections = useMemo(() => {
    if (!isGroupStage) return [{ group: null as number | null, rows: standings }];
    const numbers = new Set<number>();
    for (const s of standings) {
      const g = groupOf[s.id];
      if (g != null) numbers.add(g);
    }
    // Every declared group gets a section even if nobody is in it yet, so an
    // empty group is visible rather than merely absent.
    for (let g = 1; g <= groupCount; g++) numbers.add(g);
    return [...numbers].sort((a, b) => a - b).map((group) => ({
      group,
      rows: standings.filter((s) => groupOf[s.id] === group),
    }));
  }, [isGroupStage, standings, groupOf, groupCount]);

  // Group matches by round
  const rounds: Record<number, TournamentMatchRow[]> = {};
  for (const m of allMatches) {
    if (!rounds[m.round_number]) rounds[m.round_number] = [];
    rounds[m.round_number]!.push(m);
  }
  const roundNumbers = Object.keys(rounds).map(Number).sort((a, b) => a - b);

  if (allMatches.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center">
        <Trophy className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)] opacity-50" />
        <p className="text-sm text-[var(--text-muted)]">Round robin matches not generated yet.</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {/* Standings — one table per group, or one table full stop. */}
        <div className={isGroupStage ? 'grid grid-cols-1 lg:grid-cols-2 gap-4' : ''}>
          {groupSections.map((section) => (
            <div
              key={section.group ?? 'all'}
              className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden"
              role="region"
              aria-label={section.group == null ? 'Round robin standings' : `Group ${groupLabel(section.group)} standings`}
            >
              <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  {section.group == null ? 'Standings' : `Group ${groupLabel(section.group)}`}
                </h3>
                {section.group != null && (
                  <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Top {qualifiersPerGroup} advance
                  </span>
                )}
              </div>
              <table className="w-full" aria-label={section.group == null ? 'Standings table' : `Group ${groupLabel(section.group)} standings table`}>
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-4 py-2 w-10">#</th>
                    <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-4 py-2">{isDoubles ? 'Pair' : 'Player'}</th>
                    <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-12">W</th>
                    <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-12">L</th>
                    <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-14">PF</th>
                    <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-14">PA</th>
                    <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-14">+/-</th>
                  </tr>
                </thead>
                <tbody>
                  {section.rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-4 text-center text-xs text-[var(--text-muted)]">
                        Nobody in this group yet.
                      </td>
                    </tr>
                  )}
                  {section.rows.map((s, i) => {
                    // THE CUT LINE, drawn under the last qualifying place rather
                    // than by colouring the rows above it. Colour would compete
                    // with the W/L columns, which are what the table is read for
                    // during play; a rule reads as a boundary at a glance and
                    // says nothing else.
                    const isCut = section.group != null && qualifiers.has(s.id)
                      && i + 1 < section.rows.length && !qualifiers.has(section.rows[i + 1]!.id);
                    return (
                      <tr
                        key={s.id}
                        className={`border-b last:border-b-0 ${isCut ? 'border-[var(--color-accent)]' : 'border-[var(--border)]'}`}
                      >
                        <td className="px-4 py-2 text-sm font-mono text-[var(--text-muted)]">{i + 1}</td>
                        <td className="px-4 py-2 text-sm font-medium text-[var(--text-primary)]">{s.name}</td>
                        <td className="px-3 py-2 text-sm text-center font-mono text-[var(--color-success)]">{s.wins}</td>
                        <td className="px-3 py-2 text-sm text-center font-mono text-[var(--color-danger)]">{s.losses}</td>
                        <td className="px-3 py-2 text-sm text-center font-mono text-[var(--text-muted)]">{s.pointsFor}</td>
                        <td className="px-3 py-2 text-sm text-center font-mono text-[var(--text-muted)]">{s.pointsAgainst}</td>
                        <td className={`px-3 py-2 text-sm text-center font-mono ${s.pointsFor - s.pointsAgainst > 0 ? 'text-[var(--color-success)]' : s.pointsFor - s.pointsAgainst < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--text-muted)]'}`}>
                          {s.pointsFor - s.pointsAgainst > 0 ? '+' : ''}{s.pointsFor - s.pointsAgainst}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* Matches by Round */}
        {roundNumbers.map((roundNum) => (
          <div key={roundNum} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">
                {rounds[roundNum]?.[0]?.round_name ?? `Round ${roundNum}`}
              </h3>
              <RoundShapeControl
                event={event}
                matches={rounds[roundNum] ?? []}
                phase={phase}
                roundNumber={roundNum}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {(rounds[roundNum] ?? []).map((m) => {
                const aId = isDoubles ? m.pair_a_id : m.participant_a_id;
                const bId = isDoubles ? m.pair_b_id : m.participant_b_id;
                const winnerId = isDoubles ? m.winner_pair_id : m.winner_participant_id;
                const isCompleted = m.status === 'completed' || m.status === 'walkover';
                // A voided round robin match is just as unplayable as a voided
                // bracket match — the Score button offered here always failed
                // with "not in a playable state". Offer the restore instead.
                const isVoided = m.status === 'voided';
                const canScore = isLive && aId && bId && !isCompleted && !isVoided;
                const canRestore = isLive && isVoided;
                // A decided pool match had no action at all, exactly as a decided
                // bracket match did — so the only way to fix a wrong scoreline
                // here was void, restore, retype. That route is worse in a pool
                // than in a bracket: a voided match is excluded from the
                // standings, so the table is wrong for as long as the round trip
                // takes, and the pool's finishing order is what seeds the next
                // event. Not gated on isLive, because a wrong result is usually
                // spotted after the event is completed.
                const canChangeResult = isCompleted && !m.is_bye;

                return (
                  <div key={m.id} className="flex items-center justify-between p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-[10px] font-mono text-[var(--text-muted)]">M{m.match_number}</span>
                      {/* Round 1 of every group shares one round_number, so the
                          round heading cannot say which group a fixture is in —
                          the fixture has to. Read off side A: both sides of a
                          group fixture are in the same group by construction. */}
                      {isGroupStage && groupOf[aId ?? ''] != null && (
                        <span className="text-[10px] font-semibold text-[var(--color-accent)] uppercase tracking-wider">
                          {groupLabel(groupOf[aId ?? '']!)}
                        </span>
                      )}
                      <span className={`text-sm truncate ${isCompleted && winnerId === aId ? 'text-[var(--color-success)] font-semibold' : 'text-[var(--text-primary)]'}`}>
                        {nameMap[aId ?? ''] ?? 'TBD'}{isCompleted && winnerId === aId && <span className="sr-only"> (Winner)</span>}
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">vs</span>
                      <span className={`text-sm truncate ${isCompleted && winnerId === bId ? 'text-[var(--color-success)] font-semibold' : 'text-[var(--text-primary)]'}`}>
                        {nameMap[bId ?? ''] ?? 'TBD'}{isCompleted && winnerId === bId && <span className="sr-only"> (Winner)</span>}
                      </span>
                    </div>
                    {isCompleted && (m.scores || m.result_kind) && (
                      <span className="text-xs font-mono text-[var(--text-muted)] ml-2">
                        {matchResultLabel(m)}
                      </span>
                    )}
                    {canScore && (
                      <button
                        onClick={() => setScoreMatch(m)}
                        aria-label={`Enter score for match ${m.match_number ?? ''}`}
                        className="text-xs text-[var(--color-accent)] font-medium ml-2 hover:underline focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none rounded"
                      >
                        Score
                      </button>
                    )}
                    {canRestore && (
                      <button
                        onClick={() => setScoreMatch(m)}
                        aria-label={`Restore voided match ${m.match_number ?? ''}`}
                        className="text-xs text-[var(--color-warning)] font-medium ml-2 hover:underline focus-visible:ring-2 focus-visible:ring-[var(--color-warning)] focus-visible:outline-none rounded"
                      >
                        Restore
                      </button>
                    )}
                    {canChangeResult && (
                      <button
                        onClick={() => setScoreMatch(m)}
                        aria-label={`Change the recorded result for match ${m.match_number ?? ''}`}
                        className="text-xs text-[var(--text-muted)] font-medium ml-2 hover:underline hover:text-[var(--color-warning)] focus-visible:ring-2 focus-visible:ring-[var(--color-warning)] focus-visible:outline-none rounded"
                      >
                        Change
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {scoreMatch && (
        <ScoreEntryDialog
          match={scoreMatch}
          event={event}
          nameMap={nameMap}
          seedMap={seedMap}
          isDoubles={isDoubles}
          entries={placeableEntries}
          onClose={() => setScoreMatch(null)}
          decided={decided}
        />
      )}
    </>
  );
}
