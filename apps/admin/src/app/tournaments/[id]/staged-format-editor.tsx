'use client';

import { useId, useState } from 'react';
import { Button, Input, Select, Switch } from '@badminton/ui';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
  STAGE_TIEBREAKS,
  describeStageScoring,
  type FormatConfig,
  type FormatStage,
  type GroupsStage,
  type SlotRef,
  type StageTiebreak,
} from '@badminton/shared';
import {
  STAGED_PRESETS,
  addCategory,
  addMatch,
  addStage,
  changeStageKind,
  moveStage,
  parseCourts,
  presetConfig,
  removeCategory,
  removeStage,
  replaceStage,
  setHeadStart,
  setPools,
  setScoring,
  slotOptionsFor,
  slotValue,
  stagedEditorErrors,
  type StagedPresetName,
} from '@/lib/staged-editor';
import { PointsTableEditor } from './points-table-editor';

// THE STAGED FORMAT (00272), set out stage by stage. A preset fills it in; every
// field can then be changed. Drawn stages are read-only, and categories and head
// starts are fixed once anything is drawn, because the matches already carry
// them (stagedConfigEditRefusal says the same on the server).

const TIEBREAK_LABELS: Record<StageTiebreak, string> = {
  wins: 'Wins',
  point_diff: 'Point difference',
  points_for: 'Points scored',
  points_against_low: 'Fewest points conceded',
  game_diff: 'Game difference',
  h2h: 'Head to head',
  seed: 'Seed',
};

const KIND_OPTIONS = [
  { value: 'groups', label: 'Groups' },
  { value: 'knockout', label: 'Knockout' },
  { value: 'matches', label: 'Named matches' },
];

const num = (raw: string) => (raw.trim() === '' ? Number.NaN : Number(raw));
const shown = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? '' : String(n));

const card = 'rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-3';
const heading = 'text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]';
const iconButton = 'p-2 rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none';

export function StagedFormatEditor({
  value,
  onChange,
  drawn,
  stored,
  external,
}: {
  value: FormatConfig;
  onChange: (next: FormatConfig) => void;
  /** 1-based stage numbers that have matches. Empty when creating. */
  drawn: ReadonlySet<number>;
  /** The config as saved, which a drawn stage must still match. null when creating. */
  stored: FormatConfig | null;
  /** An unrated event (external, or a club event's) moves nobody's rating, so no stage may be rated. */
  external: boolean;
}) {
  const locked = drawn.size > 0;
  const errors = stagedEditorErrors(value, stored, drawn);
  return (
    <div className="space-y-4">
      {/* A preset sets out the stages; the points table is kept as it was. */}
      {!locked && <PresetPicker external={external} onPick={(cfg) => onChange({ ...cfg, points: value.points })} />}

      <CategoriesEditor value={value} onChange={onChange} locked={locked} />

      <div className="space-y-3">
        <p className={heading}>Stages</p>
        {value.stages.map((stage, i) => (
          <StageCard
            key={`${stage.key}-${i}`}
            cfg={value}
            index={i}
            locked={drawn.has(i + 1)}
            laterLocked={[...drawn].some((n) => n > i + 1)}
            prevLocked={drawn.has(i)}
            external={external}
            onChange={onChange}
          />
        ))}
        <div className="flex flex-wrap gap-2">
          {KIND_OPTIONS.map((k) => (
            <Button
              key={k.value}
              type="button"
              variant="ghost"
              size="sm"
              disabled={value.stages.length >= 8}
              onClick={() => onChange(addStage(value, k.value as FormatStage['kind']))}
            >
              <Plus className="w-4 h-4 mr-1" /> {k.label} stage
            </Button>
          ))}
        </div>
      </div>

      {/* Never locked by a drawn stage: the table is read once, at finalisation. */}
      <PointsTableEditor
        format="staged"
        lastStageKind={value.stages[value.stages.length - 1]?.kind ?? null}
        value={value.points}
        onChange={(points) => onChange({ ...value, points: points ?? undefined })}
      />

      {errors.length > 0 && (
        <div
          className="rounded-lg border p-3 text-sm space-y-1"
          style={{
            borderColor: 'color-mix(in oklab, var(--color-danger) 40%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--color-danger) 6%, transparent)',
          }}
          role="alert"
        >
          <p className="font-medium text-[var(--color-danger)]">Fix these before saving:</p>
          <ul className="list-disc pl-5 text-[var(--text-secondary)]">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function PresetPicker({ external, onPick }: { external: boolean; onPick: (cfg: FormatConfig) => void }) {
  const [name, setName] = useState<StagedPresetName>('groupsThenTopKnockout');
  const [advance, setAdvance] = useState('4');
  const topN = name === 'groupsThenTopKnockout';
  const [pools, setPoolsText] = useState('4');
  const [groupsPerPool, setGroupsPerPool] = useState('2');
  const [groupSize, setGroupSize] = useState('4');
  const [courtsPerPool, setCourtsPerPool] = useState('2');
  const [groupTarget, setGroupTarget] = useState('15');
  const [finalsTarget, setFinalsTarget] = useState('21');
  const [bronze, setBronze] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function apply() {
    const p = num(pools);
    const per = num(courtsPerPool);
    const courts = Number.isInteger(p) && Number.isInteger(per) && p > 0 && per > 0
      ? Array.from({ length: p }, (_, i) => Array.from({ length: per }, (_, c) => String(i * per + c + 1)))
      : null;
    const res = presetConfig(name, {
      pools: p,
      groupsPerPool: num(groupsPerPool),
      groupSize: num(groupSize),
      courts,
      groupTarget: num(groupTarget),
      finalsTarget: num(finalsTarget),
      bronze,
      advance: num(advance),
    }, external);
    if (!res.ok) { setError(res.error); return; }
    setError(null);
    onPick(res.config);
  }

  return (
    <div className={card}>
      <p className={heading}>Start from a preset</p>
      <Select
        label="Preset"
        value={name}
        onChange={(e) => setName(e.target.value as StagedPresetName)}
        options={STAGED_PRESETS}
      />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Input label={topN ? 'Groups' : 'Pools'} type="number" min={1} max={32} value={pools} onChange={(e) => setPoolsText(e.target.value)} />
        {topN ? (
          <Select
            label="How many go through"
            value={advance}
            onChange={(e) => setAdvance(e.target.value)}
            options={[2, 4, 8, 16, 32].map((n) => ({ value: String(n), label: n === 2 ? '2 (a final)' : `${n}` }))}
          />
        ) : (<>
          <Input label="Groups per pool" type="number" min={1} max={8} value={groupsPerPool} onChange={(e) => setGroupsPerPool(e.target.value)} />
          <Input label="Teams per group" type="number" min={2} max={16} value={groupSize} onChange={(e) => setGroupSize(e.target.value)} />
        </>)}
        <Input label={topN ? 'Courts per group' : 'Courts per pool'} type="number" min={0} max={16} value={courtsPerPool} onChange={(e) => setCourtsPerPool(e.target.value)} />
        <Input label="Group games to" type="number" min={5} max={30} value={groupTarget} onChange={(e) => setGroupTarget(e.target.value)} />
        <Input label="Finals to" type="number" min={5} max={30} value={finalsTarget} onChange={(e) => setFinalsTarget(e.target.value)} />
      </div>
      {topN && (
        <p className="text-xs text-[var(--text-muted)]">
          Every group winner goes through first, then the best runners-up across the groups, then the best thirds,
          until {advance} are in. The groups fill evenly from whoever turns up.
        </p>
      )}
      {(name === 'poolsThenSemisFinal' || (topN && num(advance) >= 4)) && (
        <Switch label="Play for third place" checked={bronze} onChange={setBronze} />
      )}
      {error && <p className="text-xs text-[var(--color-danger)]" role="alert">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--text-muted)]">Replaces the stages below. Everything can still be changed after.</p>
        <Button type="button" size="sm" variant="ghost" onClick={apply}>Use preset</Button>
      </div>
    </div>
  );
}

function CategoriesEditor({ value, onChange, locked }: { value: FormatConfig; onChange: (cfg: FormatConfig) => void; locked: boolean }) {
  const [newLabel, setNewLabel] = useState('');
  const cats = value.categories;
  return (
    <div className={card}>
      <p className={heading}>Team categories and head starts</p>
      {locked && (
        <p className="text-xs text-[var(--text-muted)]">Fixed once the first stage is drawn: the matches already carry them.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {cats.map((c, i) => (
          <div key={c.key} className="flex items-end gap-1">
            <Input
              label={`Category ${i + 1}`}
              value={c.label}
              disabled={locked}
              onChange={(e) => onChange({ ...value, categories: cats.map((x) => (x.key === c.key ? { ...x, label: e.target.value } : x)) })}
            />
            <button
              type="button"
              className={iconButton}
              aria-label={`Remove category ${c.label}`}
              disabled={locked || cats.length <= 1}
              onClick={() => onChange(removeCategory(value, c.key))}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
      {!locked && cats.length < 12 && (
        <div className="flex items-end gap-2">
          <Input label="New category" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Juniors" />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={newLabel.trim() === ''}
            onClick={() => { onChange(addCategory(value, newLabel.trim())); setNewLabel(''); }}
          >
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="text-sm" aria-label="Head starts: points the row team starts on against the column team">
          <thead>
            <tr>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] px-2 py-1">Starts on, against</th>
              {cats.map((c) => <th key={c.key} className="text-xs font-medium text-[var(--text-muted)] px-2 py-1">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {cats.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="text-left text-xs font-medium text-[var(--text-secondary)] px-2 py-1">{row.label}</th>
                {cats.map((col) => (
                  <td key={col.key} className="px-1 py-1">
                    {row.key === col.key ? (
                      <span className="block w-16 text-center text-[var(--text-muted)]">0</span>
                    ) : (
                      <input
                        type="number"
                        min={0}
                        max={20}
                        aria-label={`${row.label} starts on, against ${col.label}`}
                        disabled={locked}
                        value={shown(value.headStarts[row.key]?.[col.key] ?? 0)}
                        onChange={(e) => onChange(setHeadStart(value, row.key, col.key, num(e.target.value)))}
                        className="w-16 px-2 min-h-[40px] text-center bg-[var(--bg-surface)] border border-[var(--border)] rounded-[8px] text-[var(--text-primary)] disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Read across: the row&rsquo;s team starts on that many points against the column&rsquo;s. Used only in stages with
        head starts turned on.
      </p>
    </div>
  );
}

function TiebreakList({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: StageTiebreak[];
  onChange: (next: StageTiebreak[]) => void;
  disabled: boolean;
}) {
  const rest = STAGE_TIEBREAKS.filter((t) => !value.includes(t));
  const move = (i: number, by: -1 | 1) => {
    const next = [...value];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-[var(--text-secondary)]">{label}</p>
      <ol className="space-y-1">
        {value.map((t, i) => (
          <li key={t} className="flex items-center gap-1">
            <span className="text-xs font-mono text-[var(--text-muted)] w-5">{i + 1}.</span>
            <span className="text-sm text-[var(--text-primary)] flex-1">{TIEBREAK_LABELS[t]}</span>
            <button type="button" className={iconButton} aria-label={`Move ${TIEBREAK_LABELS[t]} up`} disabled={disabled || i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button type="button" className={iconButton} aria-label={`Move ${TIEBREAK_LABELS[t]} down`} disabled={disabled || i === value.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            <button type="button" className={iconButton} aria-label={`Remove ${TIEBREAK_LABELS[t]}`} disabled={disabled || value.length <= 1} onClick={() => onChange(value.filter((x) => x !== t))}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
      </ol>
      {!disabled && rest.length > 0 && (
        <Select
          aria-label={`Add to ${label.toLowerCase()}`}
          value=""
          placeholder="Then by..."
          onChange={(e) => onChange([...value, e.target.value as StageTiebreak])}
          options={rest.map((t) => ({ value: t, label: TIEBREAK_LABELS[t] }))}
        />
      )}
    </div>
  );
}

function SlotPicker({
  cfg,
  index,
  inMatch,
  label,
  value,
  onChange,
  disabled,
}: {
  cfg: FormatConfig;
  index: number;
  inMatch: boolean;
  label: string;
  value: SlotRef;
  onChange: (ref: SlotRef) => void;
  disabled: boolean;
}) {
  const options = slotOptionsFor(cfg, index, inMatch, value);
  return (
    <Select
      label={label}
      value={slotValue(value)}
      disabled={disabled}
      searchable="auto"
      onChange={(e) => {
        const picked = options.find((o) => o.value === e.target.value);
        if (picked) onChange(picked.ref);
      }}
      options={options.map((o) => ({ value: o.value, label: o.label }))}
    />
  );
}

function StageCard({
  cfg,
  index,
  locked,
  laterLocked,
  prevLocked,
  external,
  onChange,
}: {
  cfg: FormatConfig;
  index: number;
  locked: boolean;
  laterLocked: boolean;
  prevLocked: boolean;
  external: boolean;
  onChange: (cfg: FormatConfig) => void;
}) {
  const stage = cfg.stages[index]!;
  const set = (next: FormatStage) => onChange(replaceStage(cfg, index, next));
  const s = stage.scoring;
  const earlierKeys = cfg.stages.slice(0, index).map((x) => ({ value: x.key, label: x.name }));
  // A stage cannot move past a drawn one, nor be removed while drawn.
  const fixedOrder = locked || laterLocked;

  return (
    <section className={card} aria-label={`Stage ${index + 1}`}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[10rem]">
          <Input
            label={`Stage ${index + 1} name`}
            value={stage.name}
            disabled={locked}
            onChange={(e) => set({ ...stage, name: e.target.value })}
          />
        </div>
        <div className="w-40">
          <Select
            label="Kind"
            value={stage.kind}
            disabled={locked}
            onChange={(e) => onChange(changeStageKind(cfg, index, e.target.value as FormatStage['kind']))}
            options={KIND_OPTIONS}
          />
        </div>
        <button type="button" className={iconButton} aria-label={`Move stage ${index + 1} up`} disabled={fixedOrder || prevLocked || index === 0} onClick={() => onChange(moveStage(cfg, index, -1))}>
          <ArrowUp className="w-4 h-4" />
        </button>
        <button type="button" className={iconButton} aria-label={`Move stage ${index + 1} down`} disabled={fixedOrder || index === cfg.stages.length - 1} onClick={() => onChange(moveStage(cfg, index, 1))}>
          <ArrowDown className="w-4 h-4" />
        </button>
        <button type="button" className={iconButton} aria-label={`Remove stage ${index + 1}`} disabled={fixedOrder || cfg.stages.length <= 1} onClick={() => onChange(removeStage(cfg, index))}>
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      {locked && <p className="text-xs text-[var(--text-muted)]">Drawn, so its settings are fixed. Redraw it to start again.</p>}

      <div className="space-y-2">
        <p className={heading}>Scoring</p>
        <div className="flex flex-wrap items-end gap-3 whitespace-nowrap">
          <div className="min-w-[9rem] flex-1">
            <Select
              label="Games"
              value={String(s.bestOf)}
              disabled={locked}
              onChange={(e) => set(setScoring(stage, { bestOf: Number(e.target.value) as 1 | 3 | 5 | 7 }))}
              options={[1, 3, 5, 7].map((n) => ({ value: String(n), label: n === 1 ? 'One game' : `Best of ${n}` }))}
            />
          </div>
          <div className="w-24">
            <Input id={`stage-${index}-to`} label="To" type="number" min={5} max={30} disabled={locked} value={shown(s.target)} onChange={(e) => set(setScoring(stage, { target: num(e.target.value) }))} />
          </div>
          <div className="w-32">
            <Input
              id={`stage-${index}-cap`}
              label="Cap (optional)"
              type="number"
              min={5}
              max={60}
              disabled={locked || !s.winByTwo}
              value={shown(s.cap)}
              placeholder="None"
              onChange={(e) => set(setScoring(stage, { cap: e.target.value.trim() === '' ? null : num(e.target.value) }))}
            />
          </div>
          <div className="flex gap-2">
            <div className="w-24">
              <Input
                id={`stage-${index}-walkover-winner`}
                label="Walkover"
                type="number"
                min={0}
                max={60}
                disabled={locked}
                placeholder={String(s.target)}
                aria-label="Walkover winner's score"
                value={shown(s.forfeit?.winner)}
                onChange={(e) => set(setScoring(stage, {
                  forfeit: e.target.value.trim() === '' ? null : { winner: num(e.target.value), loser: s.forfeit?.loser ?? 0 },
                }))}
              />
            </div>
            <div className="w-24">
              <Input
                id={`stage-${index}-walkover-loser`}
                label="to"
                type="number"
                min={0}
                max={60}
                disabled={locked || !s.forfeit}
                placeholder="0"
                aria-label="Walkover loser's score"
                value={shown(s.forfeit?.loser)}
                onChange={(e) => s.forfeit && set(setScoring(stage, { forfeit: { winner: s.forfeit.winner, loser: num(e.target.value) } }))}
              />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Switch
            label="Win by two"
            checked={s.winByTwo}
            disabled={locked}
            onChange={(v) => set(setScoring(stage, { winByTwo: v, cap: v ? s.cap : null }))}
          />
          <Switch label="Head starts" checked={s.handicap} disabled={locked} onChange={(v) => set(setScoring(stage, { handicap: v }))} />
          <Switch
            label="Rated"
            description={external ? 'This event moves nobody’s rating.' : s.handicap ? 'A stage with head starts is never rated.' : undefined}
            checked={stage.rated && !external && !s.handicap}
            disabled={locked || external || s.handicap}
            onChange={(v) => set({ ...stage, rated: v })}
          />
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {describeStageScoring(s)}. A blank walkover score means the winner gets {Number.isNaN(s.target) ? 'the target' : s.target} to 0.
        </p>
      </div>

      <div className="space-y-2">
        <p className={heading}>Who plays</p>
        {stage.entrants.from === 'field' ? (
          <Select
            label="The whole field, seeded by"
            value={stage.entrants.order}
            disabled={locked}
            onChange={(e) => set({ ...stage, entrants: { from: 'field', order: e.target.value as 'elo' | 'random' | 'manual' } })}
            options={[
              { value: 'elo', label: 'Rating' },
              { value: 'random', label: 'Random draw' },
              { value: 'manual', label: 'Seeds as set by hand' },
            ]}
          />
        ) : (
          <SlotsEditor cfg={cfg} index={index} locked={locked} onChange={onChange} earlierKeys={earlierKeys} />
        )}
        {index > 0 && stage.kind !== 'matches' && (
          <Switch
            label="Take the whole field instead"
            checked={stage.entrants.from === 'field'}
            disabled={locked}
            onChange={(v) => set({ ...stage, entrants: v ? { from: 'field', order: 'elo' } : { from: 'slots', slots: [] } })}
          />
        )}
      </div>

      {stage.kind === 'groups' && <GroupsFields stage={stage} locked={locked} onChange={set} />}

      {stage.kind === 'knockout' && (
        <div className="space-y-2">
          <p className={heading}>Knockout</p>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Draw size"
              value={String(stage.size)}
              disabled={locked}
              onChange={(e) => set({ ...stage, size: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}
              options={[{ value: 'auto', label: 'Fit the entrants' }, ...[2, 4, 8, 16, 32, 64, 128].map((n) => ({ value: String(n), label: `${n}` }))]}
            />
            <Select
              label="Placed"
              value={stage.seeding}
              disabled={locked}
              onChange={(e) => set({ ...stage, seeding: e.target.value as 'standard' | 'as_listed' })}
              options={[
                { value: 'standard', label: 'By seed (1 meets the last)' },
                { value: 'as_listed', label: 'In listed order, top to bottom' },
              ]}
            />
          </div>
          <Switch label="Play for third place" checked={stage.thirdPlace} disabled={locked} onChange={(v) => set({ ...stage, thirdPlace: v })} />
        </div>
      )}

      {stage.kind === 'matches' && (
        <div className="space-y-2">
          <p className={heading}>Matches</p>
          {stage.matches.map((m, mi) => {
            const setMatch = (patch: Partial<typeof m>) =>
              set({ ...stage, matches: stage.matches.map((x, j) => (j === mi ? { ...x, ...patch } : x)) });
            return (
              <div key={m.label} className="rounded-lg border border-[var(--border)] p-3 space-y-2">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Input label={`Match ${mi + 1} name`} value={m.name} disabled={locked} onChange={(e) => setMatch({ name: e.target.value })} />
                  </div>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`Remove ${m.name || `match ${mi + 1}`}`}
                    disabled={locked || stage.matches.length <= 1}
                    onClick={() => set({ ...stage, matches: stage.matches.filter((_, j) => j !== mi) })}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <SlotPicker cfg={cfg} index={index} inMatch label="Side A" value={m.a} disabled={locked} onChange={(a) => setMatch({ a })} />
                  <SlotPicker cfg={cfg} index={index} inMatch label="Side B" value={m.b} disabled={locked} onChange={(b) => setMatch({ b })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Winner finishes (optional)"
                    type="number"
                    min={1}
                    disabled={locked}
                    value={shown(m.winnerPlace)}
                    placeholder="Not placed"
                    onChange={(e) => setMatch({ winnerPlace: e.target.value.trim() === '' ? undefined : num(e.target.value) })}
                  />
                  <Input
                    label="Loser finishes (optional)"
                    type="number"
                    min={1}
                    disabled={locked}
                    value={shown(m.loserPlace)}
                    placeholder="Not placed"
                    onChange={(e) => setMatch({ loserPlace: e.target.value.trim() === '' ? undefined : num(e.target.value) })}
                  />
                </div>
              </div>
            );
          })}
          {!locked && stage.matches.length < 64 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(addMatch(cfg, index))}>
              <Plus className="w-4 h-4 mr-1" /> Add a match
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function SlotsEditor({
  cfg,
  index,
  locked,
  onChange,
  earlierKeys,
}: {
  cfg: FormatConfig;
  index: number;
  locked: boolean;
  onChange: (cfg: FormatConfig) => void;
  earlierKeys: Array<{ value: string; label: string }>;
}) {
  const stage = cfg.stages[index]!;
  if (stage.entrants.from !== 'slots') return null;
  const src = stage.entrants;
  const setSource = (next: typeof src) => onChange(replaceStage(cfg, index, { ...stage, entrants: next }));
  const fresh = slotOptionsFor(cfg, index, false, src.slots[0] ?? { type: 'seed', n: 1 }).find((o) => o.ref.type !== 'seed');
  return (
    <div className="space-y-2">
      {src.slots.map((ref, ri) => (
        <div key={ri} className="flex items-end gap-2">
          <div className="flex-1">
            <SlotPicker
              cfg={cfg}
              index={index}
              inMatch={false}
              label={`Place ${ri + 1}`}
              value={ref}
              disabled={locked}
              onChange={(r) => setSource({ ...src, slots: src.slots.map((x, j) => (j === ri ? r : x)) })}
            />
          </div>
          <button
            type="button"
            className={iconButton}
            aria-label={`Remove place ${ri + 1}`}
            disabled={locked || src.slots.length <= 1}
            onClick={() => setSource({ ...src, slots: src.slots.filter((_, j) => j !== ri) })}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      {!locked && fresh && (
        <Button type="button" size="sm" variant="ghost" onClick={() => setSource({ ...src, slots: [...src.slots, fresh.ref] })}>
          <Plus className="w-4 h-4 mr-1" /> Add a place
        </Button>
      )}
      <Switch
        label="Reseed these entrants by their record"
        description="Off: they are seeded in the order listed above."
        checked={src.reseed != null}
        disabled={locked}
        onChange={(v) => setSource(v
          ? { ...src, reseed: { by: ['wins', 'point_diff'], scope: 'source_stage' } }
          : { from: 'slots', slots: src.slots })}
      />
      {src.reseed && (
        <div className="space-y-2 pl-3 border-l border-[var(--border)]">
          <TiebreakList
            label="Reseed by"
            value={src.reseed.by}
            disabled={locked}
            onChange={(by) => setSource({ ...src, reseed: { ...src.reseed!, by } })}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select
              label="Counting"
              value={src.reseed.scope}
              disabled={locked}
              onChange={(e) => setSource({ ...src, reseed: { ...src.reseed!, scope: e.target.value as 'source_stage' | 'all_prior' } })}
              options={[
                { value: 'source_stage', label: 'One stage only' },
                { value: 'all_prior', label: 'Every earlier stage' },
              ]}
            />
            {src.reseed.scope === 'source_stage' && (
              <Select
                label="Which stage"
                value={src.reseed.stage ?? ''}
                disabled={locked}
                onChange={(e) => {
                  const { stage: _drop, ...rest } = src.reseed!;
                  setSource({ ...src, reseed: e.target.value === '' ? rest : { ...rest, stage: e.target.value } });
                }}
                options={[{ value: '', label: 'The stage the places come from' }, ...earlierKeys]}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GroupsFields({ stage, locked, onChange }: { stage: GroupsStage; locked: boolean; onChange: (s: GroupsStage) => void }) {
  const courtsMode = stage.courts?.mode ?? 'none';
  const gamesHintId = useId();
  return (
    <div className="space-y-2">
      <p className={heading}>Groups</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Input label="Pools" type="number" min={1} max={32} disabled={locked} value={shown(stage.pools)} onChange={(e) => onChange(setPools(stage, num(e.target.value)))} />
        <Input label="Groups per pool" type="number" min={1} max={8} disabled={locked} value={shown(stage.groupsPerPool)} onChange={(e) => onChange({ ...stage, groupsPerPool: num(e.target.value) })} />
        <Input
          label="Teams per group"
          type="number"
          min={2}
          max={16}
          disabled={locked}
          value={stage.groupSize === 'auto' ? '' : shown(stage.groupSize)}
          placeholder="Even split"
          onChange={(e) => onChange({ ...stage, groupSize: e.target.value.trim() === '' ? 'auto' : num(e.target.value) })}
        />
        <Input
          label="Games per team"
          type="number"
          min={1}
          max={15}
          disabled={locked}
          value={shown(stage.gamesPerTeam)}
          placeholder="Everyone plays everyone"
          aria-describedby={gamesHintId}
          onChange={(e) => onChange({ ...stage, gamesPerTeam: e.target.value.trim() === '' ? undefined : num(e.target.value) })}
        />
        <Select
          label="Dealt into groups"
          value={stage.assignment}
          disabled={locked}
          onChange={(e) => onChange({ ...stage, assignment: e.target.value as GroupsStage['assignment'] })}
          options={[
            { value: 'snake', label: 'Snake by seed' },
            { value: 'random', label: 'Random' },
            { value: 'manual', label: 'By hand' },
          ]}
        />
        <Select
          label="Pool winner"
          value={stage.poolRanking}
          disabled={locked}
          onChange={(e) => onChange({ ...stage, poolRanking: e.target.value as GroupsStage['poolRanking'] })}
          options={[
            { value: 'none', label: 'Not ranked' },
            { value: 'best_group_winner', label: 'Best group winner' },
          ]}
        />
        <Select
          label="Courts"
          value={courtsMode}
          disabled={locked}
          onChange={(e) => onChange({
            ...stage,
            courts: e.target.value === 'per_pool'
              ? { mode: 'per_pool', pools: Array.from({ length: Math.max(1, stage.pools || 1) }, (_, i) => [String(i + 1)]) }
              : e.target.value === 'shared' ? { mode: 'shared', courts: ['1', '2'] } : null,
          })}
          options={[
            { value: 'none', label: 'Set on the day' },
            { value: 'per_pool', label: 'Each pool its own' },
            { value: 'shared', label: 'Shared by every pool' },
          ]}
        />
      </div>
      <p id={gamesHintId} className="text-xs text-[var(--text-muted)]">
        Games per team: each group plays this many rounds. In a group with an odd number of teams one team sits out each round, so some play one fewer.
      </p>
      {stage.courts?.mode === 'per_pool' && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {stage.courts.pools.map((list, pi) => (
            <CourtsInput
              key={pi}
              label={`G${pi + 1} courts`}
              value={list}
              disabled={locked}
              onChange={(next) => stage.courts?.mode === 'per_pool' && onChange({
                ...stage,
                courts: { mode: 'per_pool', pools: stage.courts.pools.map((x, j) => (j === pi ? next : x)) },
              })}
            />
          ))}
        </div>
      )}
      {stage.courts?.mode === 'shared' && (
        <CourtsInput
          label="Courts"
          value={stage.courts.courts}
          disabled={locked}
          onChange={(next) => onChange({ ...stage, courts: { mode: 'shared', courts: next } })}
        />
      )}
      <Switch
        label="Interleave the groups"
        description="Alternate matches between groups, so nobody plays twice in a row."
        checked={stage.interleave}
        disabled={locked}
        onChange={(v) => onChange({ ...stage, interleave: v })}
      />
      <TiebreakList label="Group tables ranked by" value={stage.tiebreaks} disabled={locked} onChange={(tiebreaks) => onChange({ ...stage, tiebreaks })} />
    </div>
  );
}

/** Court names as typed text, parsed on blur so a half-typed "1, " is not cut short. */
function CourtsInput({ label, value, disabled, onChange }: { label: string; value: string[]; disabled: boolean; onChange: (next: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <Input
      label={label}
      value={text}
      disabled={disabled}
      placeholder="1, 2"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { const next = parseCourts(text); onChange(next); setText(next.join(', ')); }}
    />
  );
}
