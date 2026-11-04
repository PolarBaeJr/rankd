'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import { Button, Dialog, Dropdown, Input, useConfirm } from '@badminton/ui';
import {
  courtLabel,
  describeStageScoring,
  stagedMatchRules,
  type FormatConfig,
  type TournamentCourt,
} from '@badminton/shared';
import { enterMatchResult, setMatchCourt, setMatchLive, skipMatchForNow } from '@/lib/tournament-actions';
import {
  autoCallFailureText,
  courtCardOptions,
  inlineScoreVerdict,
  liveEntrants,
  nextMatchForCourt,
  type AutoCallReport,
  type DeskRow,
} from '@/lib/live-desk';
import { useToast } from '@/components/toast-provider';
import type { ActionResult } from '@/lib/action-result';
import type { TournamentMatchRow } from '@/lib/tournament-types';

export type CourtSide = { entryId: string | null; label: string; absent?: boolean };
export type CourtDeskRow = DeskRow<TournamentMatchRow, CourtSide>;

/** Saves a score from the card. The desk's is enterMatchResult; a court helper's is passed in. */
export type CourtScoreSave = (
  matchId: string,
  scores: Array<{ a: number; b: number }>,
  winner: 'a' | 'b',
) => Promise<ActionResult<{ autoCall: AutoCallReport } | undefined>>;

/** Voids the match on court, with the reason typed on the card. */
export type CourtVoid = (
  matchId: string,
  reason: string,
) => Promise<ActionResult<{ autoCall: AutoCallReport } | undefined>>;

interface Props {
  court: TournamentCourt;
  /** "Group A", shown before the court when the card sits in a group's column. */
  groupName?: string | null;
  /** The event's whole working list (deskRows), so an entrant on another court is never called twice. */
  rows: CourtDeskRow[];
  courts: TournamentCourt[];
  cfg: FormatConfig;
  isLive: boolean;
  canEnterResult: boolean;
  canManageCourts: boolean;
  /** A match from another event is live on this court. */
  busyElsewhere: boolean;
  /** Opens the full score dialog: cut short, walkover, void. Without it the Options menu has no "Cut short, walkover". */
  onMore?: (matchId: string) => void;
  /** Saves the score; enterMatchResult when not given. */
  save?: CourtScoreSave;
  /** Voids the match on court. Given only to someone who may (the void key, or a helper row on this court). */
  voidMatch?: CourtVoid;
}

/**
 * ONE COURT, RUN FROM THE STAGES TAB: the match on it now with its score form,
 * and the match it takes next, which is the one the server puts on when this
 * result is saved (nextMatchForCourt with this match's entrants let off).
 */
export function CourtCard({
  court, groupName, rows, courts, cfg, isLive, canEnterResult, canManageCourts, busyElsewhere, onMore, save, voidMatch,
}: Props) {
  const onCourt = rows.find((r) => r.state === 'live' && r.match.court_id === court.id) ?? null;
  const next = nextMatchForCourt(rows, court, courts, cfg, { busyEntries: liveEntrants(rows, onCourt?.match.id) });
  const name = courtLabel(court.label) ?? court.label;
  const optionIds = courtCardOptions({ more: !!onMore && canEnterResult, skip: canEnterResult, void: !!voidMatch });
  // Keyed by match, so a void reason typed for one match never carries to the next on this court.
  const options = onCourt && optionIds.length > 0 ? (
    <CourtOptions
      key={onCourt.match.id}
      row={onCourt}
      courtName={name}
      optionIds={optionIds}
      onMore={onMore ? () => onMore(onCourt.match.id) : undefined}
      voidMatch={voidMatch}
    />
  ) : null;

  return (
    <div
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4 space-y-3"
      role="region"
      aria-label={groupName ? `${groupName}, ${name}` : name}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-2xl font-bold text-[var(--text-primary)]">
          {groupName && <span className="text-[var(--text-muted)]">{groupName}, </span>}
          {name}
        </h4>
        <span className={`text-xs font-semibold uppercase tracking-wide ${onCourt ? 'text-[var(--color-success)]' : 'text-[var(--text-muted)]'}`}>
          {onCourt ? 'On court' : busyElsewhere ? 'In use by another event' : 'Free'}
        </span>
      </div>

      {onCourt ? (
        <div className="space-y-3">
          <p className="text-base font-semibold text-[var(--text-primary)] break-words">
            {onCourt.a.label} <span className="text-sm font-normal text-[var(--text-muted)]">vs</span> {onCourt.b.label}
          </p>
          {isLive && canEnterResult && (
            <InlineScore key={onCourt.match.id} row={onCourt} cfg={cfg} save={save} options={options} />
          )}
          {isLive && !canEnterResult && options && <div className="flex flex-wrap items-center gap-2">{options}</div>}
        </div>
      ) : (
        !busyElsewhere && isLive && canManageCourts && next && <PutOnCourt row={next} court={court} />
      )}

      <div className="pt-3 border-t border-[var(--border)]">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-accent)]">
          {isLive ? 'Next up' : 'First up'}
        </p>
        <p className="text-sm text-[var(--text-primary)] break-words">
          {next ? (
            <>
              {next.a.label} <span className="text-[var(--text-muted)]">vs</span> {next.b.label}
              {next.match.match_number != null && <span className="text-[var(--text-muted)]"> · M{next.match.match_number}</span>}
            </>
          ) : (
            <span className="text-[var(--text-muted)]">Nothing to call on this court yet.</span>
          )}
        </p>
        {!isLive && (
          <p className="mt-1 text-xs text-[var(--text-muted)]">Matches go on court when the tournament starts.</p>
        )}
      </div>
    </div>
  );
}

function InlineScore({
  row, cfg, options, save: saveScore,
}: { row: CourtDeskRow; cfg: FormatConfig; options: ReactNode; save?: CourtScoreSave }) {
  const router = useRouter();
  const { toast } = useToast();
  const { match } = row;
  const rules = stagedMatchRules(cfg, match);
  const stage = match.stage != null ? cfg.stages[match.stage - 1] : undefined;
  const bestOf = rules?.bestOf ?? 1;
  const blank = () => ({ a: rules?.startA ? String(rules.startA) : '', b: rules?.startB ? String(rules.startB) : '' });
  const [games, setGames] = useState(() => Array.from({ length: bestOf === 1 ? 1 : 2 }, blank));
  const [saving, setSaving] = useState(false);
  const verdict = inlineScoreVerdict(games, rules, { a: row.a.label, b: row.b.label });

  function set(i: number, side: 'a' | 'b', value: string) {
    setGames((gs) => gs.map((g, j) => (j === i ? { ...g, [side]: value } : g)));
  }

  async function save() {
    if (!verdict.winner) return;
    setSaving(true);
    const res = saveScore
      ? await saveScore(match.id, verdict.scores, verdict.winner)
      : await enterMatchResult(match.id, verdict.scores, verdict.winner, false);
    setSaving(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast('Score saved', 'success');
    const failure = autoCallFailureText(res.data?.autoCall);
    const called = res.data?.autoCall?.called ?? [];
    if (failure) toast(failure, 'error');
    else if (called.length > 0) toast(`${called.map((c) => c.court).join(', ')}: next match is on`, 'success');
    router.refresh();
  }

  const input =
    'w-full min-w-0 min-h-[56px] px-3 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-lg font-mono text-center '
    + 'text-[var(--text-primary)] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-60';

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => { e.preventDefault(); void save(); }}
      aria-label={`Score for ${row.a.label} versus ${row.b.label}`}
    >
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 text-sm text-[var(--text-muted)]">
        <span className="truncate text-center">{row.a.label}</span>
        <span aria-hidden />
        <span className="truncate text-center">{row.b.label}</span>
      </div>
      {games.map((g, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            value={g.a}
            disabled={saving}
            onChange={(e) => set(i, 'a', e.target.value)}
            aria-label={`${row.a.label}, game ${i + 1}`}
            className={input}
          />
          <span className="text-sm text-[var(--text-muted)]">-</span>
          <input
            type="text"
            inputMode="numeric"
            value={g.b}
            disabled={saving}
            onChange={(e) => set(i, 'b', e.target.value)}
            aria-label={`${row.b.label}, game ${i + 1}`}
            className={input}
          />
        </div>
      ))}
      {stage && <p className="text-xs text-[var(--text-muted)]">{describeStageScoring(stage.scoring)}</p>}
      {verdict.error && <p role="alert" className="text-sm text-[var(--color-danger)]">{verdict.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={saving} disabled={!verdict.winner || saving}>
          {verdict.winner ? `Save: ${verdict.winner === 'a' ? row.a.label : row.b.label} wins` : 'Save score'}
        </Button>
        {games.length < bestOf && (
          <Button type="button" variant="ghost" disabled={saving} onClick={() => setGames((gs) => [...gs, blank()])}>
            Add game
          </Button>
        )}
        {options}
      </div>
    </form>
  );
}

function PutOnCourt({ row, court }: { row: CourtDeskRow; court: TournamentCourt }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function put() {
    setPending(true);
    setError(null);
    if (row.match.court_id !== court.id) {
      const moved = await setMatchCourt(row.match.id, court.label);
      if (!moved.ok) { setError(moved.error); setPending(false); return; }
    }
    const res = await setMatchLive(row.match.id, true);
    setPending(false);
    if (!res.ok) { setError(res.error); return; }
    router.refresh();
  }

  return (
    <div className="space-y-1">
      <Button variant="success" loading={pending} disabled={pending} onClick={put}>
        Put {row.a.label} vs {row.b.label} on court
      </Button>
      {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}

/**
 * The card's secondary actions in one menu beside Save score. Rendered keyed
 * by the match on court, so the void dialog's typed reason belongs to one
 * match. Inside the score form, so the trigger is type="button".
 */
function CourtOptions({
  row, courtName, optionIds, onMore, voidMatch,
}: {
  row: CourtDeskRow;
  courtName: string;
  optionIds: ReturnType<typeof courtCardOptions>;
  onMore?: () => void;
  voidMatch?: CourtVoid;
}) {
  const skip = useSkipForNow(row, courtName);
  const voiding = useVoidOnCourt(row, courtName, voidMatch);
  const busy = skip.pending || voiding.pending;
  const items = optionIds.flatMap((id) => {
    if (id === 'more' && onMore) return [{ label: 'Cut short, walkover…', onClick: onMore, disabled: busy }];
    if (id === 'skip') return [{ label: 'Skip for now', onClick: () => void skip.run(), disabled: busy }];
    if (id === 'void' && voidMatch) return [{ label: 'Void match', onClick: voiding.ask, danger: true, disabled: busy }];
    return [];
  });

  return (
    <>
      <Dropdown
        trigger={
          <Button type="button" variant="ghost" loading={skip.pending} aria-haspopup="menu">
            Options
            <ChevronDown className="w-4 h-4" aria-hidden />
          </Button>
        }
        items={items}
      />
      {voiding.dialog}
    </>
  );
}

/**
 * A team is not at the court (00314): the match goes behind every other match
 * this court can take, and the next one goes on. It comes back once nothing
 * else is waiting.
 */
function useSkipForNow(row: CourtDeskRow, courtName: string) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);

  async function run() {
    const ok = await confirm({
      title: 'Skip this match for now?',
      message: `${row.a.label} vs ${row.b.label} goes to the back of ${courtName}'s queue, and the next match goes on. It comes back when nothing else is waiting.`,
      confirmLabel: 'Skip for now',
    });
    if (!ok) return;
    setPending(true);
    const res = await skipMatchForNow(row.match.id);
    setPending(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    const failure = autoCallFailureText(res.data?.autoCall);
    if (failure) toast(failure, 'error');
    else if (res.data?.back) toast(`Nothing else can go on ${courtName}, so this match is back on.`, 'success');
    else if ((res.data?.autoCall?.called ?? []).length > 0) toast(`Skipped. ${courtName}: next match is on`, 'success');
    else toast('Skipped for now.', 'success');
    router.refresh();
  }

  return { pending, run };
}

/**
 * A team is not coming: the match is voided, with a reason, and the court
 * takes its next match. A Dialog of its own rather than useConfirm, whose
 * message cannot hold a typed input.
 */
function useVoidOnCourt(row: CourtDeskRow, courtName: string, voidMatch: CourtVoid | undefined) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);

  async function submit() {
    if (!voidMatch || !reason.trim()) return;
    setPending(true);
    const res = await voidMatch(row.match.id, reason.trim());
    setPending(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    setOpen(false);
    setReason('');
    const failure = autoCallFailureText(res.data?.autoCall);
    if (failure) toast(failure, 'error');
    else if ((res.data?.autoCall?.called ?? []).length > 0) toast(`Voided. ${courtName}: next match is on`, 'success');
    else toast('Match voided.', 'success');
    router.refresh();
  }

  const dialog = open ? (
    <Dialog open onClose={() => { if (!pending) setOpen(false); }} title="Void this match?">
      <form
        className="space-y-4"
        // The dialog renders inside the score form's React tree, and a submit
        // bubbles through the portal: without the stop, voiding would save the
        // typed score too.
        onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); void submit(); }}
      >
        <p className="text-sm text-[var(--text-muted)]">
          {row.a.label} vs {row.b.label} is voided and counts for neither side. {courtName} takes its next match.
        </p>
        <Input
          label="Reason"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          placeholder="For example: the other team did not come"
          autoFocus
        />
        <div className="flex justify-between gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" variant="danger" loading={pending} disabled={!reason.trim() || pending}>
            Void match
          </Button>
        </div>
      </form>
    </Dialog>
  ) : null;

  return { pending, ask: () => setOpen(true), dialog };
}
