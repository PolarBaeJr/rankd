'use client';

import { useState } from 'react';
import { Badge, AvatarChip, Button, Dialog } from '@badminton/ui';
import { isDoublesEvent, placementBonusFor } from '@badminton/shared';
import type { TournamentEventType, TournamentBonusSettings } from '@badminton/shared';
import { undoMatchResult } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Crown, TrendingUp, TrendingDown, Medal, Undo2 } from 'lucide-react';
import { getName } from './entry-name';
import { finishLabel, knockoutRounds } from '@/lib/finish-labels';
import type {
  TournamentEventRow,
  TournamentMatchRow,
  ParticipantWithPlayer,
  PairWithPlayers,
  GameScore,
} from '@/lib/tournament-types';

interface Props {
  event: TournamentEventRow;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  matches: TournamentMatchRow[];
  isDoubles: boolean;
  bonusSettings: TournamentBonusSettings;
}

const POSITION_COLORS: Record<number, string> = {
  1: '#FFD700', 2: '#C0C0C0', 3: '#CD7F32', 4: '#CD7F32',
};

export function ResultsTab({ event, participants, pairs, matches, isDoubles, bonusSettings }: Props) {
  const [undoConfirmId, setUndoConfirmId] = useState<string | null>(null);
  const [undoLoading, setUndoLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
  const eventType = event.event_type as TournamentEventType;
  const bonuses = isDoubles ? bonusSettings.doubles : bonusSettings.singles;
  // Same two gates the finaliser applies. This column is a projection from
  // final_position, not stored history, so when bonuses are off it must show
  // nothing rather than a number nobody was ever awarded.
  // placement_bonus_enabled is `boolean | null`; both finaliser gates treat null
  // as "no bonus" (`!event.placement_bonus_enabled` / `event.x && ...`), so this
  // must coerce rather than compare against false.
  const bonusesApply = bonusSettings.enabled && !!event.placement_bonus_enabled;
  const completedMatchList = matches.filter((m) => m.status === 'completed' || m.status === 'walkover');
  // Was the third-place play-off actually PLAYED? Not "does the event have
  // one" — a generated-but-unplayed playoff separates nobody, and a voided one
  // un-separates them again.
  const playoffPlayed = completedMatchList.some((m) => (m as { is_third_place?: boolean | null }).is_third_place === true);
  const rounds = knockoutRounds(matches, event.format);

  async function handleUndo() {
    if (!undoConfirmId) return;
    setUndoLoading(true);
    try {
      const res = await undoMatchResult(undoConfirmId);
      if (!res.ok) { toast(res.error, 'error'); return; }
      toast('Match result undone', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to undo', 'error');
    }
    setUndoLoading(false);
    setUndoConfirmId(null);
  }

  // Sort by final position
  const ranked = entries
    .filter((e) => e.final_position)
    .sort((a, b) => (a.final_position ?? 0) - (b.final_position ?? 0));

  const unranked = entries.filter((e) => !e.final_position);

  const totalMatches = matches.length;
  const completedMatches = matches.filter((m) => m.status === 'completed' || m.status === 'walkover').length;

  const champion = ranked[0];
  // Singles-only Elo fields — only read when !isDoubles.
  const championSingles = champion as ParticipantWithPlayer | undefined;

  return (
    <div className="space-y-6">
      {/* Champion card */}
      {champion && champion.final_position === 1 && (
        <div className="rounded-xl border-2 border-[#FFD700]/30 bg-gradient-to-r from-[#FFD700]/5 to-transparent p-6 text-center">
          <Crown className="w-8 h-8 mx-auto mb-2 text-[#FFD700]" />
          <h2 className="text-2xl font-bold text-[#FFD700] font-display">CHAMPION</h2>
          <p className="text-lg text-[var(--text-primary)] font-semibold mt-1">
            {getName(champion, isDoubles)}
          </p>
          {!isDoubles && championSingles && championSingles.elo_change !== null && (
            <p className="text-sm text-[var(--color-success)] mt-1">
              Elo: {championSingles.elo_before} → {championSingles.elo_after} ({championSingles.elo_change > 0 ? '+' : ''}{championSingles.elo_change})
            </p>
          )}
        </div>
      )}

      {/* Results table */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Medal className="w-4 h-4" /> Final Standings
          </h3>
          <span className="text-xs text-[var(--text-muted)]">{completedMatches}/{totalMatches} matches played</span>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-4 py-2 w-14">Pos</th>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-4 py-2">{isDoubles ? 'Pair' : 'Player'}</th>
              {!isDoubles && (
                <>
                  <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-20">Elo Before</th>
                  <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-20">Elo After</th>
                  <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-16">Change</th>
                </>
              )}
              <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-16">Bonus</th>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-28">Finish</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((e) => {
              // Singles-only Elo fields — only read when !isDoubles.
              const p = e as ParticipantWithPlayer;
              const pos = e.final_position as number;
              const label = finishLabel(pos, rounds, playoffPlayed);
              const color = POSITION_COLORS[pos] ?? 'var(--text-muted)';
              const bonus = bonusesApply ? placementBonusFor(pos, bonuses) : 0;

              return (
                <tr key={e.id} className="border-b border-[var(--border)] last:border-b-0">
                  <td className="px-4 py-2.5">
                    <span className="font-mono font-bold text-sm" style={{ color }}>{pos}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {!isDoubles && <AvatarChip name={p.player?.full_name ?? ''} src={p.player?.avatar_url} size="sm" id={p.player?.id} />}
                      <span className="text-sm font-medium text-[var(--text-primary)]">{getName(e, isDoubles)}</span>
                    </div>
                  </td>
                  {!isDoubles && (
                    <>
                      <td className="px-3 py-2.5 text-sm text-center font-mono text-[var(--text-muted)]">{p.elo_before ?? '-'}</td>
                      <td className="px-3 py-2.5 text-sm text-center font-mono text-[var(--text-primary)]">{p.elo_after ?? '-'}</td>
                      <td className="px-3 py-2.5 text-sm text-center font-mono">
                        {p.elo_change !== null && p.elo_change !== undefined ? (
                          <span className={p.elo_change > 0 ? 'text-[var(--color-success)]' : p.elo_change < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--text-muted)]'}>
                            <span className="sr-only">{p.elo_change > 0 ? 'Gained' : p.elo_change < 0 ? 'Lost' : 'No change'}: </span>{p.elo_change > 0 ? '+' : ''}{p.elo_change}
                          </span>
                        ) : '-'}
                      </td>
                    </>
                  )}
                  <td className="px-3 py-2.5 text-sm text-center font-mono text-[var(--color-success)]">
                    {bonus > 0 ? `+${bonus}` : '-'}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full" role="status" style={{ color, backgroundColor: `${color}15` }}>
                      <span className="sr-only">Finish: </span>{label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Match Results with Undo */}
      {event.status !== 'completed' && completedMatchList.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)]">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Completed Matches</h3>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {completedMatchList.map((m) => {
              const scores = (m.scores as GameScore[] | null) ?? [];
              const scoreStr = scores.map((s) => `${s.a}-${s.b}`).join(', ');
              return (
                <div key={m.id} className="px-4 py-2.5 flex items-center justify-between">
                  <div className="text-sm text-[var(--text-primary)]">
                    Match #{m.match_number ?? '?'} — {m.round_name ?? `Round ${m.round_number}`}
                    {scoreStr && <span className="text-[var(--text-muted)] ml-2">({scoreStr})</span>}
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setUndoConfirmId(m.id)} aria-label={`Undo match ${m.match_number ?? ''} result`} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
                    <Undo2 className="w-3.5 h-3.5 mr-1" /> Undo
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Undo confirmation dialog */}
      <Dialog open={!!undoConfirmId} onClose={() => setUndoConfirmId(null)} title="Undo Match Result">
        <p className="text-sm text-[var(--text-muted)] mb-4">
          This will reset the match, reverse Elo changes, and remove the winner from the next match. Are you sure?
        </p>
        <div className="flex gap-2">
          <Button onClick={handleUndo} loading={undoLoading} className="flex-1 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
            Confirm Undo
          </Button>
          <Button variant="ghost" onClick={() => setUndoConfirmId(null)} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">Cancel</Button>
        </div>
      </Dialog>
    </div>
  );
}
