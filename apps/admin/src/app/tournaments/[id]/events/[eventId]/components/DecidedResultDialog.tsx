'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog } from '@badminton/ui';
import { MAX_RETIREMENT_GAMES, retirementScoresRefusal } from '@badminton/shared';
import type { ActionResult } from '@/lib/action-result';
import type { DecidedKindResult, RetirementInput } from '@/lib/tournament-actions';
import { autoCallFailureText } from '@/lib/live-desk';
import { useToast } from '@/components/toast-provider';

export type DecidedKind = 'off_court' | 'retired';
export type OffCourtSave = (matchId: string, winnerSide: 'a' | 'b') => Promise<ActionResult<DecidedKindResult>>;
export type RetirementSave = (matchId: string, input: RetirementInput) => Promise<ActionResult<DecidedKindResult>>;

/** What happens to the side that retired, after the result. */
type Afterwards = 'stay' | 'sub' | 'leave';

/**
 * DECIDED OFF COURT and RETIRED (00329), from the score dialog and the court
 * card. Off court is a winner and nothing else: no scores, and nobody's rating
 * moves. Retired keeps the games as far as they got, whoever was ahead, and
 * the side still on court wins.
 *
 * "Substitute the injured partner" records the retirement only, then hands the
 * side to the sub, whose confirm records the injury and makes the sub in one
 * call. Without a sub to offer, the choice is stay or leave.
 *
 * NOT A <form>: Dialog renders in place, inside the court card's score form.
 */
export function DecidedResultForm({
  kind,
  matchId,
  nameA,
  nameB,
  isDoubles,
  saveOffCourt,
  saveRetirement,
  onSubInjured,
  onDone,
  onCancel,
}: {
  kind: DecidedKind;
  matchId: string;
  nameA: string;
  nameB: string;
  isDoubles: boolean;
  saveOffCourt: OffCourtSave;
  saveRetirement: RetirementSave;
  /** Doubles with substitutions on: opens the sub for the side that retired. */
  onSubInjured?: (side: 'a' | 'b') => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [side, setSide] = useState<'a' | 'b' | null>(null);
  const [games, setGames] = useState<Array<{ a: string; b: string }>>([{ a: '', b: '' }]);
  const [afterwards, setAfterwards] = useState<Afterwards>('stay');
  const [pending, setPending] = useState(false);
  const nameOf = (s: 'a' | 'b') => (s === 'a' ? nameA : nameB);

  const typed = games.filter((g) => g.a.trim() !== '' || g.b.trim() !== '');
  const scores = typed.map((g) => ({ a: Number(g.a.trim() || '0'), b: Number(g.b.trim() || '0') }));
  const scoreError = kind === 'retired' ? retirementScoresRefusal(scores) : null;

  async function save() {
    if (!side || pending || scoreError) return;
    setPending(true);
    const res = kind === 'off_court'
      ? await saveOffCourt(matchId, side)
      : await saveRetirement(matchId, { retiredSide: side, scores, leaves: afterwards === 'leave' });
    setPending(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    const winner = kind === 'off_court' ? nameOf(side) : nameOf(side === 'a' ? 'b' : 'a');
    const parts = [kind === 'off_court' ? `Decided off court: ${winner} wins.` : `${nameOf(side)} retired: ${winner} wins.`];
    if (res.data.left) {
      parts.push(`${nameOf(side)} left the event injured.`);
      if (res.data.left.leftForDesk > 0) parts.push(`The desk voids their other ${res.data.left.leftForDesk} match${res.data.left.leftForDesk === 1 ? '' : 'es'}.`);
    }
    toast(parts.join(' '), 'success');
    const failure = autoCallFailureText(res.data.autoCall);
    if (failure) toast(failure, 'error');
    router.refresh();
    if (kind === 'retired' && afterwards === 'sub' && onSubInjured) {
      onSubInjured(side);
      return;
    }
    onDone();
  }

  return (
    <div className="space-y-4">
      {kind === 'off_court' ? (
        <p className="text-sm text-[var(--text-muted)]">
          The two sides settled it without playing. The winner goes through and takes the win. No scores are recorded and nobody&apos;s rating moves.
        </p>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">
          Enter the games as far as they got; the last one can be unfinished. The side still on court wins, and it is rated as a walkover.
        </p>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-[var(--text-primary)]">{kind === 'off_court' ? 'Who won' : 'Who retired'}</legend>
        {(['a', 'b'] as const).map((s) => (
          <label key={s} className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
            <input
              type="radio"
              name={`decided-${kind}-${matchId}`}
              value={s}
              checked={side === s}
              onChange={() => setSide(s)}
            />
            {nameOf(s)}
          </label>
        ))}
      </fieldset>

      {kind === 'retired' && (
        <>
          <div className="space-y-2">
            <p className="text-sm font-medium text-[var(--text-primary)]">Games so far</p>
            {games.map((g, i) => (
              <div key={i} className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-2">
                <span className="text-xs text-[var(--text-muted)]">Game {i + 1}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={g.a}
                  aria-label={`${nameA}, game ${i + 1}`}
                  onChange={(e) => setGames((gs) => gs.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))}
                  className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-2 text-center font-mono text-[var(--text-primary)]"
                />
                <span className="text-[var(--text-muted)]">-</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={g.b}
                  aria-label={`${nameB}, game ${i + 1}`}
                  onChange={(e) => setGames((gs) => gs.map((x, j) => (j === i ? { ...x, b: e.target.value } : x)))}
                  className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-2 text-center font-mono text-[var(--text-primary)]"
                />
              </div>
            ))}
            {games.length < MAX_RETIREMENT_GAMES && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setGames((gs) => [...gs, { a: '', b: '' }])}>
                Add game
              </Button>
            )}
            {scoreError && <p role="alert" className="text-sm text-[var(--color-danger)]">{scoreError}</p>}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-[var(--text-primary)]">Afterwards</legend>
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input type="radio" name={`after-${matchId}`} checked={afterwards === 'stay'} onChange={() => setAfterwards('stay')} />
              They stay in the event
            </label>
            {isDoubles && onSubInjured && (
              <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <input type="radio" name={`after-${matchId}`} checked={afterwards === 'sub'} onChange={() => setAfterwards('sub')} />
                Substitute the injured partner
              </label>
            )}
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input type="radio" name={`after-${matchId}`} checked={afterwards === 'leave'} onChange={() => setAfterwards('leave')} />
              {isDoubles ? 'Team leaves the event (injury)' : 'They leave the event (injury)'}
            </label>
            {afterwards === 'leave' && (
              <p className="text-xs text-[var(--text-muted)]">Recorded as an injury, with no warning. Their matches still to play are voided.</p>
            )}
          </fieldset>
        </>
      )}

      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>Back</Button>
        <Button type="button" loading={pending} disabled={!side || pending || !!scoreError} onClick={() => void save()}>
          {kind === 'off_court' ? 'Record decided off court' : 'Record retirement'}
        </Button>
      </div>
    </div>
  );
}

export function DecidedResultDialog(props: Parameters<typeof DecidedResultForm>[0]) {
  return (
    <Dialog open onClose={props.onCancel} title={props.kind === 'off_court' ? 'Decided off court' : 'Retired'}>
      <DecidedResultForm {...props} />
    </Dialog>
  );
}
