import { Layers, Trophy } from 'lucide-react';
import {
  describeStageScoring,
  stagedMatchHeading,
  type FormatConfig,
  type StageView,
} from '@badminton/shared';
import { Draw, type DrawMatch } from './Draw';

/** A staged match with its sides already read off the pair or participant columns. */
export interface StagedPlayerMatch extends DrawMatch {
  stage: number | null;
  pool_number: number | null;
  group_number: number | null;
  slot: number | null;
  match_label: string | null;
  match_number: number | null;
  is_third_place: boolean;
  handicap_a: number;
  handicap_b: number;
}

function formatScores(scores: Array<{ a: number; b: number }> | null): string {
  if (!scores || scores.length === 0) return '';
  return scores.map((s) => `${s.a}–${s.b}`).join(', ');
}

/**
 * A STAGED EVENT (00272), stage by stage: each groups stage as its pools and
 * group tables, each knockout as a draw, each set of named matches as a list
 * with the places they are waiting on until they are known.
 */
export function Stages({
  cfg,
  views,
  matches,
  nameOf,
  seedOf,
  decidedLabels = {},
  title,
  subtitle,
}: {
  cfg: FormatConfig;
  views: StageView[];
  matches: StagedPlayerMatch[];
  nameOf: Record<string, string>;
  seedOf: Record<string, number | null>;
  /** A match decided off court or by retirement (00329), as it reads. */
  decidedLabels?: Record<string, string>;
  title: string;
  subtitle: string;
}) {
  return (
    <>
      {views.map((view) => {
        const own = matches.filter((m) => m.stage === view.number);
        if (view.stage.kind === 'knockout' && own.length > 0) {
          return (
            <div key={view.stage.key} className="card-elevated rounded-2xl overflow-hidden">
              <Draw
                matches={own.filter((m) => !m.is_third_place)}
                thirdPlace={own.find((m) => m.is_third_place) ?? null}
                nameOf={nameOf}
                seedOf={seedOf}
                heading={
                  <>
                    <Trophy className="w-4 h-4 text-[var(--color-gold)]" />
                    <h2 className="display-md">{view.stage.name}</h2>
                  </>
                }
                title={title}
                subtitle={`${subtitle} · ${view.stage.name}`}
              />
            </div>
          );
        }
        if (own.length === 0 && view.fixtures.length === 0) return null;
        const sorted = [...own].sort((x, y) =>
          (x.slot ?? x.round_number) - (y.slot ?? y.round_number) || (x.match_number ?? 0) - (y.match_number ?? 0));
        return (
          <div key={view.stage.key} className="card-elevated rounded-2xl overflow-hidden">
            <div className="p-4 pb-0 mb-3">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-[var(--color-accent)]" />
                <h2 className="display-md">{view.stage.name}</h2>
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-1">{describeStageScoring(view.stage.scoring)}</p>
            </div>
            <div className="px-4 pb-4 space-y-4">
              {view.pools.map((pool) => (
                <div key={pool.pool} className="space-y-2">
                  {pool.label && <h3 className="eyebrow">{pool.label}</h3>}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {pool.groups.map((g) => (
                      <div key={`${g.pool}-${g.group}`} className="border border-[var(--border)] rounded-xl overflow-hidden">
                        <p className="px-3 py-2 text-sm font-semibold text-[var(--text-primary)] border-b border-[var(--border)]">{g.label}</p>
                        <table className="w-full text-sm" aria-label={`${g.label} table`}>
                          <thead>
                            <tr className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                              <th className="text-left px-3 py-1 w-6">#</th>
                              <th className="text-left px-2 py-1">Team</th>
                              <th className="px-2 py-1 w-8">W</th>
                              <th className="px-2 py-1 w-8">L</th>
                              <th className="px-2 py-1 w-10">+/-</th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.rows.map((r) => {
                              const diff = r.pointsFor - r.pointsAgainst;
                              return (
                                <tr
                                  key={r.id}
                                  className="border-t border-[var(--border)]"
                                  style={r.qualified ? { backgroundColor: 'color-mix(in oklab, var(--color-success) 10%, transparent)' } : undefined}
                                >
                                  <td className={`nums px-3 py-1.5 ${r.advancingPlace ? 'text-[var(--color-accent)] font-bold' : 'text-[var(--text-muted)]'}`}>{r.place}</td>
                                  <td className="px-2 py-1.5 text-[var(--text-primary)] truncate">
                                    {nameOf[r.id] ?? 'Unknown'}
                                    {r.qualified && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--color-success)]">Through</span>}
                                  </td>
                                  <td className="nums px-2 py-1.5 text-center">{r.wins}</td>
                                  <td className="nums px-2 py-1.5 text-center">{r.losses}</td>
                                  <td className="nums px-2 py-1.5 text-center">{diff > 0 ? '+' : ''}{diff}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {own.length === 0 && view.fixtures.map((f) => (
                <div key={f.label} className="border border-[var(--border)] rounded-xl p-3">
                  <p className="eyebrow mb-1">{f.name}</p>
                  <p className="text-sm text-[var(--text-secondary)]">
                    {f.a.entry ? nameOf[f.a.entry] ?? f.a.slot : f.a.slot}
                    <span className="text-[var(--text-dim)]"> vs </span>
                    {f.b.entry ? nameOf[f.b.entry] ?? f.b.slot : f.b.slot}
                  </p>
                </div>
              ))}

              {sorted.length > 0 && (
                <div className="space-y-2">
                  {sorted.map((m) => {
                    const fixture = m.match_label ? view.fixtures.find((f) => f.label === m.match_label) : undefined;
                    const done = m.status === 'completed' || m.status === 'walkover';
                    const side = (id: string | null, slot: string | undefined, start: number) => (
                      <>
                        {id ? nameOf[id] ?? 'TBD' : slot ?? 'TBD'}
                        {start > 0 && <span className="text-[11px] text-[var(--text-muted)]"> (starts at {start})</span>}
                        {done && id && id === m.winnerId && <span className="sr-only"> (Winner)</span>}
                      </>
                    );
                    return (
                      <div key={m.id} className="border border-[var(--border)] rounded-xl overflow-hidden">
                        <p className="px-2.5 pt-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                          {m.match_number != null ? `M${m.match_number} · ` : ''}{stagedMatchHeading(cfg, m)}
                        </p>
                        <div className="flex items-center">
                          <div className={`flex-1 p-2.5 text-sm truncate ${done && m.aId && m.aId === m.winnerId ? 'match-winner' : 'text-[var(--text-secondary)]'}`}>
                            {side(m.aId, fixture?.a.slot, m.handicap_a)}
                          </div>
                          <div className="nums px-3 text-xs text-[var(--text-dim)] py-2.5 border-x border-[var(--border)] shrink-0">
                            {done ? decidedLabels[m.id] ?? (formatScores(m.scores) || 'W/O') : 'vs'}
                          </div>
                          <div className={`flex-1 p-2.5 text-sm text-right truncate ${done && m.bId && m.bId === m.winnerId ? 'match-winner' : 'text-[var(--text-secondary)]'}`}>
                            {side(m.bId, fixture?.b.slot, m.handicap_b)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
