'use client';

import { useState } from 'react';
import { Button, Dialog, Input, Select, Switch } from '@badminton/ui';
import {
  getEventRules, tallyGames, isLegalGameScore, isLegalGameCount, resolveMatchShape, describeMatchShape, eventRatingLine,
  parseFormatConfig, stagedMatchRules, stagedMatchRated, isLegalGame, isLegalCutShortGame, validateMatch,
} from '@badminton/shared';
import type { TournamentMatchFormat, MatchFormat } from '@badminton/shared';
import {
  enterMatchResult, enterWalkover, voidMatch, unvoidMatch, setMatchEntry, recordDoubleNoShow,
  editMatchResult, getMatchOutcomeSummary, getCurrentHeadStarts,
} from '@/lib/tournament-actions';
import type { MatchOutcomeSummary, EntryEventSummary, CurrentHeadStarts } from '@/lib/tournament-actions';
import { autoCallFailureText } from '@/lib/live-desk';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import type { TournamentEventRow, TournamentMatchRow } from '@/lib/tournament-types';

interface Props {
  match: TournamentMatchRow;
  event: TournamentEventRow;
  nameMap: Record<string, string>;
  seedMap: Record<string, number>;
  isDoubles: boolean;
  // Every entry still eligible to be placed in the draw, for the slot editor.
  entries: Array<{ id: string; name: string }>;
  onClose: () => void;
}

// Which panel the dialog opens on. A voided match can only be restored, and a
// match missing a side cannot be scored — so the dialog leads with the action
// that is actually available instead of an unusable score form.
//
// 'correct' is the panel for a match that ALREADY has a result. It is separate
// from 'score' rather than a mode of it because the two do different things to
// the ladder: 'score' rates a match for the first time and refuses anything
// already decided, while 'correct' reverses the existing rating and re-applies
// it. Sharing one Submit button between them is how somebody ends up pressing
// "enter" on a settled match and being told, opaquely, that it is not playable.
//
// 'summary' is where a SCORED match lands. Everything else in this dialog is a
// form; that one is a read of what the write did, and nothing on it can write
// anything back — see the note on `showSummary`.
type View = 'score' | 'walkover' | 'slots' | 'restore' | 'correct' | 'summary';

export function ScoreEntryDialog({ match, event, nameMap, seedMap, isDoubles, entries, onClose }: Props) {
  // THE MATCH'S OWN SHAPE, FALLING BACK TO THE EVENT'S (00108).
  //
  // Every rule in this dialog — how many score rows to draw, whether a game is
  // possible, whether the match has been clinched, what the refusal messages
  // name — is decided from this one value, and enterMatchResultImpl resolves it
  // from the SAME function on the same two rows. A draw played 11s in round one
  // and best-of-3 in the final has a different answer in every round, and if
  // the dialog resolved from the event while the server resolved from the
  // match, a 21-19 first-round game would be accepted by one and refused by the
  // other — which is the exact class of disagreement this dialog was last fixed
  // for.
  const shape = resolveMatchShape(match, event);
  const matchFormat = shape.match_format as TournamentMatchFormat;
  // The typed shape wins over the enum, so a round shortened to one game to 15
  // offers one score row rather than three.
  //
  // A match in a staged event is judged by its stage's rules instead, the same
  // stagedMatchRules call enterMatchResultImpl makes. Null on a staged row means
  // the stored config no longer reads, and the server refuses that match too.
  const isStaged = match.stage != null;
  // "Apply the current head start" (00279), on the correction view only: the
  // starts the two teams' categories give today, used in place of the ones
  // recorded on the row once the exec has switched it on and the server has
  // said they differ.
  const [headStarts, setHeadStarts] = useState<CurrentHeadStarts | null>(null);
  const [applyHeadStart, setApplyHeadStart] = useState(false);
  const [headStartNote, setHeadStartNote] = useState<string | null>(null);
  const [headStartLoading, setHeadStartLoading] = useState(false);
  const recordedRules = isStaged ? stagedMatchRules(parseFormatConfig(event.format_config), match) : null;
  const stagedRules = recordedRules && applyHeadStart && headStarts?.current
    ? { ...recordedRules, startA: headStarts.current.a, startB: headStarts.current.b }
    : recordedRules;
  const maxGames = stagedRules?.bestOf ?? getEventRules(shape).bestOf;
  // Scores are entered as totals including the head start, so an empty game
  // starts on each side's start rather than blank.
  // Whether this match moves ratings at all: an external event never does, and
  // a staged event can switch rating off for itself or for one stage (00272).
  const rated = event.external_event !== true && stagedMatchRated(event, match.stage);
  const startA = stagedRules?.startA ?? 0;
  const startB = stagedRules?.startB ?? 0;
  const emptyGame = () => ({ a: startA > 0 ? String(startA) : '', b: startB > 0 ? String(startB) : '' });
  const isUnplayed = (g: { a: string; b: string }) => {
    const e = emptyGame();
    return g.a === e.a && g.b === e.b;
  };
  // Named on screen, because a round that is NOT played to the event's shape is
  // otherwise indistinguishable from one that is — and the exec typing the
  // score is the person who needs to know which.
  const shapeLabel = describeMatchShape(shape);
  const shapeIsOverridden = match.games_per_match != null || match.points_per_game != null || match.match_format != null;

  const aId = isDoubles ? match.pair_a_id : match.participant_a_id;
  const bId = isDoubles ? match.pair_b_id : match.participant_b_id;
  const nameA = nameMap[aId ?? ''] ?? 'Side A';
  const nameB = nameMap[bId ?? ''] ?? 'Side B';
  const seedA = seedMap[aId ?? ''];
  const seedB = seedMap[bId ?? ''];

  const isVoided = match.status === 'voided';
  const isDecided = match.status === 'completed' || match.status === 'walkover';
  const hasBothSides = Boolean(aId && bId);

  const [view, setView] = useState<View>(
    isVoided ? 'restore' : isDecided ? 'correct' : hasBothSides ? 'score' : 'slots',
  );
  // Prefilled from the recorded result when there is one, so a correction that
  // only changes the third game does not make the exec retype the first two —
  // and, more importantly, so the form starts from what is actually on the row
  // rather than from blank, which would silently propose wiping the scoreline.
  // A walkover has no scores, so it starts empty and the reason field carries
  // the explanation.
  const recorded = (match.scores as Array<{ a: number; b: number }> | null) ?? [];
  const [games, setGames] = useState<Array<{ a: string; b: string }>>(
    recorded.length > 0
      ? recorded.map((g) => ({ a: String(g.a), b: String(g.b) }))
      : Array.from({ length: maxGames === 1 ? 1 : 2 }, emptyGame)
  );
  const [loading, setLoading] = useState(false);
  // The gym slot ends before the game does often enough that this needs to be
  // one tap away, not a support request (00047). It only widens what the server
  // will accept — the server re-checks the score against the same rules either
  // way, so flipping it cannot smuggle in an impossible scoreline.
  const [timeExceeded, setTimeExceeded] = useState(false);
  const [walkoverLoading, setWalkoverLoading] = useState(false);
  const [walkoverReason, setWalkoverReason] = useState('');
  const [slotPick, setSlotPick] = useState<{ a: string; b: string }>({ a: '', b: '' });
  const { toast } = useToast();
  const router = useRouter();

  // Shared with the challenge result form so the two cannot disagree about who
  // won the same scoreline.
  const { winner: tallyWinner } = tallyGames(
    games.map((g) => ({ side_a_score: g.a, side_b_score: g.b })),
  );

  // Every filled row must be a plain non-negative integer. <input type="number">
  // accepts "e", "E" and "+" as scientific notation, and parseInt(x) || 0 below
  // would turn that into a recorded score of ZERO — type "e" instead of "8" and
  // the match is saved wrong, silently, with no error anywhere.
  const filled = games.filter((g) => (g.a !== '' || g.b !== '') && !isUnplayed(g));
  const scoresAreIntegers = filled.every(
    (g) => /^\d+$/.test(g.a.trim()) && /^\d+$/.test(g.b.trim()),
  );

  // tallyGames only asks who scored more, so 21-15 counts as a won game even in
  // an event played to 30. The dialog then showed "Winner: X" in green for a
  // scoreline the server correctly refuses, and the rejection toast was the only
  // hint. Judge each game against THIS event's target before claiming a winner.
  //
  // The correction view judges a staged match by the clock flag already on the
  // row, because that is what editMatchResultImpl checks it against.
  const cutShort = view === 'correct' ? match.time_exceeded === true : timeExceeded;
  const parsedGames = filled.map((g) => ({ a: parseInt(g.a, 10), b: parseInt(g.b, 10) }));
  const stagedCheck = stagedRules && scoresAreIntegers && parsedGames.length > 0
    ? validateMatch(parsedGames, stagedRules, { cutShort, sideNames: { a: nameA, b: nameB } })
    : null;
  const gamesAreLegal = scoresAreIntegers && (isStaged
    ? stagedRules != null && parsedGames.every((g) => (cutShort ? isLegalCutShortGame(g, stagedRules) : isLegalGame(g, stagedRules)))
    : filled.every((g) => isLegalGameScore(
      parseInt(g.a, 10), parseInt(g.b, 10),
      matchFormat as unknown as MatchFormat,
      shape.games_per_match, shape.points_per_game, timeExceeded,
    )));

  // ...AND the match has to be over. tallyGames only asks who won MORE games,
  // so a best-of-3 sitting at 1-0 named a winner: the dialog went green, Submit
  // lit up, and the server — which checks the clinch and always has — bounced it
  // with a toast. Exactly the bug the paragraph above fixed for a single game's
  // score, one layer up and still live.
  //
  // isLegalGameCount is the SAME function the server decides with, so the two
  // cannot drift into disagreeing about whether a match has ended. The clock
  // does not relax this: a best-of-3 called at 1-0 has no winner to record
  // however the games themselves ended, so timeExceeded is deliberately not
  // consulted here (it governs how a GAME may end, not whether a MATCH has).
  const aGamesWon = filled.filter((g) => parseInt(g.a, 10) > parseInt(g.b, 10)).length;
  const bGamesWon = filled.filter((g) => parseInt(g.b, 10) > parseInt(g.a, 10)).length;
  const matchIsDecided = isStaged
    ? stagedCheck?.ok === true
    : scoresAreIntegers &&
    isLegalGameCount(
      Math.max(aGamesWon, bGamesWon),
      Math.min(aGamesWon, bGamesWon),
      matchFormat as unknown as MatchFormat,
      shape.games_per_match,
    );

  // Only a legal, fully-numeric, FINISHED scoreline names a winner. Everything
  // downstream — the green highlight, the Elo preview, submit — keys off this.
  const autoWinner = scoresAreIntegers && gamesAreLegal && matchIsDecided ? tallyWinner : null;
  // Submit is disabled without a winner, so a staged scoreline says why on the
  // status line rather than in a toast nobody can reach.
  const stagedReason = isStaged && !autoWinner && filled.length > 0
    ? stagedRules
      ? (stagedCheck && !stagedCheck.ok ? stagedCheck.error : null)
      : 'This stage\'s rules could not be read. Reload the page and try again.'
    : null;

  // The dialog holds a snapshot of the match row, so any mutation invalidates
  // what it is displaying — close and let the refreshed bracket re-open it.
  function done(message: string) {
    toast(message, 'success');
    onClose();
    router.refresh();
  }

  // WHAT THE RESULT DID, shown instead of closing — for a SCORED match only.
  //
  // It is the same rule as `done` and not an exception to it: the stale snapshot
  // this dialog is holding is never rendered again once `summary` is set. Every
  // figure on that panel comes out of the payload just fetched, and the panel
  // offers one button, which closes. `router.refresh()` still fires, so the
  // bracket behind it is rebuilding while the exec reads it.
  //
  // Only the two paths that RECORD A SCORE come here. A walkover, a void, a
  // restore and a slot repair all still close: they change who is in the draw
  // rather than what somebody's tournament looks like, and a summary of a
  // walkover is a table of unchanged numbers.
  const [summary, setSummary] = useState<MatchOutcomeSummary | null>(null);
  async function showSummary(message: string) {
    toast(message, 'success');
    router.refresh();
    const res = await getMatchOutcomeSummary(match.id);
    // A refused or failed read is not worth a second error on top of a
    // successful save — fall back to the old behaviour and close.
    if (!res.ok) { onClose(); return; }
    setSummary(res.data);
    setView('summary');
  }

  function addGame() {
    if (games.length < maxGames) {
      setGames([...games, emptyGame()]);
    }
  }

  async function handleSubmit() {
    // Say WHICH problem it is. "Cannot determine winner" for a 21-15 game in an
    // event to 30 sends an exec looking for the wrong mistake.
    if (!scoresAreIntegers) { toast('Scores must be whole numbers', 'error'); return; }
    if (isStaged && !stagedRules) { toast('This stage\'s rules could not be read. Reload the page and try again.', 'error'); return; }
    if (stagedCheck && !stagedCheck.ok) { toast(stagedCheck.error, 'error'); return; }
    if (!gamesAreLegal) {
      toast(`That scoreline cannot end a game to ${getEventRules(shape).target}`, 'error');
      return;
    }
    // TWO DIFFERENT PROBLEMS, and telling them apart is the whole point of
    // saying anything. "Games are level" for a best-of-3 at 1-0 is simply
    // false, and sends an exec hunting a tie that is not there.
    if (!matchIsDecided) {
      const needed = Math.floor(getEventRules(shape).bestOf / 2) + 1;
      toast(
        `${Math.max(aGamesWon, bGamesWon)}-${Math.min(aGamesWon, bGamesWon)} does not finish this match — ${needed} games are needed to win`,
        'error',
      );
      return;
    }
    if (!autoWinner) { toast('Games are level — enter the scores that decide the match', 'error'); return; }
    setLoading(true);
    try {
      const scores = games
        .filter(g => (g.a || g.b) && !isUnplayed(g))
        .map(g => ({ a: parseInt(g.a) || 0, b: parseInt(g.b) || 0 }));
      const res = await enterMatchResult(match.id, scores, autoWinner, timeExceeded);
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      const autoCallFailure = autoCallFailureText(res.data?.autoCall);
      if (autoCallFailure) toast(autoCallFailure, 'error');
      await showSummary('Score submitted');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  // Change a result that is already recorded, without voiding it first.
  //
  // The reason is mandatory here as well as on the server. The server refusal is
  // the boundary; requiring it in the form is what stops the exec discovering it
  // after they have already retyped three games.
  // Change a result that is already recorded, without voiding it first.
  //
  // `winner` is passed explicitly rather than taken from autoWinner, because a
  // WALKOVER has no scoreline to derive one from. Gating the button on
  // autoWinner made the server's scoreless-walkover correction — which exists,
  // and is tested — unreachable from the console: the only way to fix a walkover
  // awarded to the wrong side was to void it, losing the record that it was a
  // walkover at all.
  //
  // The reason is mandatory here as well as on the server. The server refusal is
  // the boundary; requiring it in the form is what stops the exec discovering it
  // after they have already retyped three games.
  async function handleCorrect(winner: 'a' | 'b') {
    if (!walkoverReason.trim()) { toast('Enter a reason for changing the result', 'error'); return; }
    setLoading(true);
    try {
      const scores = games
        .filter(g => (g.a || g.b) && !isUnplayed(g))
        .map(g => ({ a: parseInt(g.a) || 0, b: parseInt(g.b) || 0 }));
      const res = await editMatchResult(
        match.id, scores, winner, walkoverReason,
        applyHeadStart ? { applyCurrentHeadStart: true } : undefined,
      );
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      if (scores.length > 0) {
        await showSummary(rated ? 'Result changed, ratings re-applied' : 'Result changed');
      } else {
        done(rated ? 'Walkover re-awarded, ratings re-applied' : 'Walkover re-awarded');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  // The switch asks the server first, and stays off with the reason shown when
  // there is nothing to apply: a stage without head starts, a side that cannot
  // be read, or starts that already match the teams' categories.
  async function toggleHeadStart(on: boolean) {
    setHeadStartNote(null);
    if (!on) { setApplyHeadStart(false); return; }
    setHeadStartLoading(true);
    const res = await getCurrentHeadStarts(match.id);
    setHeadStartLoading(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    const info = res.data;
    if (!info.current) {
      setHeadStartNote('This match has no current head start to apply: its stage is played without head starts, or one of its sides cannot be read.');
      return;
    }
    if (!info.applicable) {
      setHeadStartNote('Only a played match with a recorded score can take the current head start.');
      return;
    }
    if (info.current.a === info.recorded.a && info.current.b === info.recorded.b) {
      setHeadStartNote(`The current head start is the one already recorded (${nameA} ${info.recorded.a}, ${nameB} ${info.recorded.b}), so there is nothing to apply.`);
      return;
    }
    setHeadStarts(info);
    setApplyHeadStart(true);
  }

  async function handleWalkover(winner: 'a' | 'b') {
    if (!walkoverReason.trim()) { toast('Enter a reason', 'error'); return; }
    setWalkoverLoading(true);
    try {
      const res = await enterWalkover(match.id, winner, walkoverReason);
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done('Walkover recorded');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleDoubleNoShow() {
    setWalkoverLoading(true);
    try {
      const res = await recordDoubleNoShow(match.id, walkoverReason || 'Neither side present');
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done('Recorded — neither side present');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleVoid() {
    setWalkoverLoading(true);
    try {
      const res = await voidMatch(match.id, walkoverReason || 'Voided by admin');
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done('Match voided');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleRestore() {
    setWalkoverLoading(true);
    try {
      const res = await unvoidMatch(match.id, walkoverReason || 'Restored by admin');
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done('Match restored — enter the result when it has been played');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleSetSlot(side: 'a' | 'b', entryId: string | null) {
    setWalkoverLoading(true);
    try {
      const res = await setMatchEntry(match.id, side, entryId, walkoverReason || 'Draw corrected by admin');
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done(entryId ? 'Entry placed' : 'Slot cleared');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  // Anyone already in this match is not a candidate for its other slot.
  const slotOptions = (occupiedByOther: string | null) => [
    { value: '', label: 'Select entry…' },
    ...entries
      .filter((e) => e.id !== aId && e.id !== bId && e.id !== occupiedByOther)
      .map((e) => ({ value: e.id, label: e.name })),
  ];

  function renderSlotRow(side: 'a' | 'b') {
    const id = side === 'a' ? aId : bId;
    const otherId = side === 'a' ? bId : aId;
    const pick = slotPick[side];

    return (
      <div className="space-y-2 rounded-lg border border-[var(--border)] p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
            Side {side.toUpperCase()}
          </span>
          <span className="text-sm text-[var(--text-primary)]">
            {id ? (nameMap[id] ?? 'Unknown') : <em className="text-[var(--text-muted)]">Empty</em>}
          </span>
        </div>
        {id ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => handleSetSlot(side, null)}
            loading={walkoverLoading}
            className="w-full text-[var(--color-danger)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
          >
            Clear this slot
          </Button>
        ) : (
          <div className="flex gap-2">
            <Select
              aria-label={`Entry for side ${side.toUpperCase()}`}
              value={pick}
              onChange={(e) => setSlotPick({ ...slotPick, [side]: e.target.value })}
              options={slotOptions(otherId)}
              className="flex-1"
            />
            <Button
              size="sm"
              onClick={() => handleSetSlot(side, pick)}
              disabled={!pick}
              loading={walkoverLoading}
              className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            >
              Place
            </Button>
          </div>
        )}
      </div>
    );
  }

  const title = view === 'summary'
    ? 'Result Recorded'
    : isVoided
    ? 'Restore Voided Match'
    : view === 'slots'
    ? 'Fix Match Slots'
    : view === 'correct'
    ? 'Change Recorded Result'
    : 'Enter Match Score';

  // What the row says today, so the exec can see what they are replacing rather
  // than trusting the prefilled boxes to be the same thing.
  const recordedWinnerId = isDoubles ? match.winner_pair_id : match.winner_participant_id;
  // Whether the exec has typed anything at all, which is what distinguishes
  // "rescore this match" from "re-award this walkover".
  const anyScoreTyped = games.some((g) => g.a !== '' || g.b !== '');
  const recordedSummary = recorded.length > 0
    ? recorded.map((g) => `${g.a}-${g.b}`).join(', ')
    : match.status === 'walkover'
    // `notes` FIRST, walkover_reason SECOND, and the order is the whole point.
    // The exec's own sentence now lives in tournament_match_notes and reaches
    // this component through `match.notes`, which the page nulls for anyone
    // without the capability to read it. `walkover_reason` is the bounded
    // public phrase ("Opponent withdrew from the event") and is all that is
    // left for a viewer who may not see the note — or for a walkover recorded
    // before the sentence moved.
    ? `walkover${match.notes || match.walkover_reason ? ` — ${match.notes || match.walkover_reason}` : ''}`
    : 'no scores recorded';

  // NOTHING BELOW THIS LINE IS REACHED once the result has landed, and that is
  // the point: every form in this dialog is built from `match`, which the write
  // has just made stale. The summary is rendered from the payload alone.
  if (view === 'summary' && summary) {
    return (
      <Dialog open={true} onClose={onClose} title={title}>
        <OutcomeSummary summary={summary} unrated={!rated} external={event.external_event === true} onClose={onClose} />
      </Dialog>
    );
  }

  return (
    <Dialog open={true} onClose={onClose} title={title}>
      <div className="space-y-5">
        {/* WHAT THIS MATCH IS PLAYED TO, shown only when it is NOT the event's
            shape (00108). Always showing it would be noise on the thousands of
            matches that inherit; showing it when a round has been shortened is
            the difference between an exec typing 21-19 into a game to 11 and
            finding out from a refusal, and knowing before they start. */}
        {shapeIsOverridden && (
          <p className="text-xs text-[var(--text-muted)]" role="status">
            This round is played to <span className="font-semibold text-[var(--text-primary)]">{shapeLabel}</span>.
          </p>
        )}
        {/* Players header */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-elevated)]">
          <div className="text-center flex-1">
            {seedA && <span className="text-[10px] text-[var(--text-muted)] font-mono block">[{seedA}]</span>}
            <span className={`text-sm font-semibold ${autoWinner === 'a' ? 'text-[var(--color-success)]' : 'text-[var(--text-primary)]'}`}>
              {aId ? nameA : 'TBD'}
            </span>
          </div>
          <span className="text-xs text-[var(--text-muted)] px-3 font-bold">VS</span>
          <div className="text-center flex-1">
            {seedB && <span className="text-[10px] text-[var(--text-muted)] font-mono block">[{seedB}]</span>}
            <span className={`text-sm font-semibold ${autoWinner === 'b' ? 'text-[var(--color-success)]' : 'text-[var(--text-primary)]'}`}>
              {bId ? nameB : 'TBD'}
            </span>
          </div>
        </div>

        {/* Restore — the only thing a voided match can do */}
        {view === 'restore' && (
          <>
            <p className="text-sm text-[var(--text-muted)]">
              This match was voided{match.notes ? `: “${match.notes}”` : ''}. Restoring puts it back in
              play with no result.{rated && ' Any Elo the voided result applied is reversed, so replaying it counts once.'}
            </p>
            <Input
              label="Reason"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Why is this match being restored?"
            />
            <Button onClick={handleRestore} loading={walkoverLoading} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Restore Match
            </Button>
          </>
        )}

        {/* Slot editor — the escape hatch for a next-round slot nothing will fill */}
        {view === 'slots' && (
          <>
            {!hasBothSides && (
              <p className="text-sm text-[var(--text-muted)]">
                One side of this match is empty, usually because the match feeding it was voided or was
                a branch of byes. Place an entry here, or send the side that is present through unopposed.
              </p>
            )}
            <Input
              label="Reason"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Why is the draw being changed?"
            />
            {renderSlotRow('a')}
            {renderSlotRow('b')}

            {/* Exactly one side present: push them forward unopposed. Recorded as
                a walkover, which is unrated when there is no opponent. */}
            {(Boolean(aId) !== Boolean(bId)) && (
              <Button
                size="sm"
                onClick={() => handleWalkover(aId ? 'a' : 'b')}
                loading={walkoverLoading}
                className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
              >
                Advance {aId ? nameA : nameB} unopposed
              </Button>
            )}

            {hasBothSides && (
              <Button variant="ghost" size="sm" onClick={() => setView('score')} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Back to Score Entry
              </Button>
            )}
          </>
        )}

        {/* Correction — the override for a match that already has a result */}
        {view === 'correct' && (
          <>
            <div className="rounded-lg border border-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_8%,transparent)] p-3 space-y-1">
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Currently recorded: {recordedWinnerId ? (nameMap[recordedWinnerId] ?? 'Unknown') : 'no winner'} — {recordedSummary}
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                {rated
                  ? 'Saving reverses the Elo, statistics and streak this result applied, then re-applies them from the corrected one.'
                  : 'This match is unrated, so saving moves nobody\u2019s rating.'} The match is never counted twice, and the change is recorded in the audit
                log with both the old and the new result.
              </p>
            </div>

            {/* Said out loud rather than left to be discovered. Ratings ARE
                corrected, and so are the placings and points — those are
                absolute writes derived from the finished bracket, so redoing
                them is idempotent. Placement BONUSES are the exception: they
                were added into the players' ratings and there is no reversal,
                so a changed placing on an event that already paid them is
                reported rather than quietly re-paid. The old copy here told the
                exec to "adjust those by hand", which the console cannot do —
                there is no editor for final_position or points. */}
            {event.status === 'completed' && (
              <p className="text-xs text-[var(--color-warning)]">
                This event is already finalised. The correction fixes {rated ? 'the ratings and ' : ''}the match record, and
                the final placings and points are recalculated automatically. Placement bonuses are not —
                if this changes who finished where and bonuses were already paid, you will be told so.
              </p>
            )}

            {isDoubles && isStaged && match.status === 'completed' && recorded.length > 0 && (
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3">
                <Switch
                  checked={applyHeadStart}
                  onChange={toggleHeadStart}
                  disabled={headStartLoading}
                  label="Apply the current head start"
                  description="Recompute this match's head start from the teams' current categories and check the corrected score against it."
                />
                {headStartNote && (
                  <p className="pb-3 text-xs text-[var(--text-muted)]" role="status">{headStartNote}</p>
                )}
                {applyHeadStart && headStarts?.current && (
                  <p className="pb-3 text-xs text-[var(--text-primary)]" role="status">
                    Recorded: {nameA} {headStarts.recorded.a}, {nameB} {headStarts.recorded.b}.
                    {' '}Current: {nameA} {headStarts.current.a}, {nameB} {headStarts.current.b}.
                    {' '}Every corrected game total must include the new head start.
                  </p>
                )}
              </div>
            )}

            {(startA > 0 || startB > 0) && (
              <p className="text-xs text-[var(--text-muted)]">
                {startA > 0 && <>{nameA} starts at {startA}. </>}
                {startB > 0 && <>{nameB} starts at {startB}. </>}
                Enter each game&apos;s total including the head start.
              </p>
            )}

            {games.map((g, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-xs text-[var(--text-muted)] w-16">Game {i + 1}</span>
                <Input
                  type="number"
                  aria-label={`Corrected game ${i + 1} score for ${nameA}`}
                  value={g.a}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, a: e.target.value };
                    setGames(updated);
                  }}
                  placeholder="0"
                  className="text-center"
                />
                <span className="text-[var(--text-muted)]">-</span>
                <Input
                  type="number"
                  aria-label={`Corrected game ${i + 1} score for ${nameB}`}
                  value={g.b}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, b: e.target.value };
                    setGames(updated);
                  }}
                  placeholder="0"
                  className="text-center"
                />
              </div>
            ))}

            {games.length < maxGames && (
              <Button variant="ghost" size="sm" onClick={addGame} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">+ Add Game</Button>
            )}

            {/* MOUNTED WHETHER OR NOT THERE IS A WINNER, with one line of
                text-sm reserved (the min-h is its line-height). autoWinner
                turning truthy is the SAME render that un-disables Save
                Corrected Result below, so mounting this conditionally shifted
                that button down a line at the exact moment it became
                clickable, and the exec's first real click at it lands where it
                no longer is.
                It is also a live region, and one of those has to be in the DOM
                BEFORE its content changes to be announced dependably: mounted
                conditionally, this never announced reliably either. */}
            <div className="min-h-[1.25rem] text-center text-sm" role="status" aria-live="polite">
              {autoWinner && (
                <span className="text-[var(--color-success)] font-medium">
                  New winner: {autoWinner === 'a' ? nameA : nameB}
                </span>
              )}
              {stagedReason && (
                <span className="text-[var(--text-muted)]">{stagedReason}</span>
              )}
            </div>

            <Input
              label="Reason (required)"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Why is the recorded result wrong?"
            />

            {/* No scores typed at all — a walkover being re-awarded, not a match
                being rescored. There is no scoreline to derive a winner from, so
                the side is named outright. */}
            {!anyScoreTyped ? (
              <>
                <p className="text-xs text-[var(--text-muted)]">
                  No scores entered, so this stays a walkover. Choose who it should be awarded to, or type
                  the real scores above to turn it into a played match.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => handleCorrect('a')} loading={loading} disabled={!aId || !walkoverReason.trim()} className="flex-1 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                    Award to {nameA}
                  </Button>
                  <Button size="sm" onClick={() => handleCorrect('b')} loading={loading} disabled={!bId || !walkoverReason.trim()} className="flex-1 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                    Award to {nameB}
                  </Button>
                </div>
              </>
            ) : (
              <Button
                onClick={() => autoWinner && handleCorrect(autoWinner)}
                loading={loading}
                disabled={!autoWinner || !walkoverReason.trim()}
                className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
              >
                Save Corrected Result
              </Button>
            )}
            {/* Voiding stays reachable from here: a result that should never have
                existed is erased, not corrected, and the two are different
                things to the standings. */}
            <Button variant="ghost" size="sm" onClick={() => setView('walkover')} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Void this match instead
            </Button>
          </>
        )}

        {/* Game scores */}
        {view === 'score' && (
          <>
            {(startA > 0 || startB > 0) && (
              <p className="text-xs text-[var(--text-muted)]">
                {startA > 0 && <>{nameA} starts at {startA}. </>}
                {startB > 0 && <>{nameB} starts at {startB}. </>}
                Enter each game&apos;s total including the head start.
              </p>
            )}

            {games.map((g, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-xs text-[var(--text-muted)] w-16">Game {i + 1}</span>
                <Input
                  type="number"
                  value={g.a}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, a: e.target.value };
                    setGames(updated);
                  }}
                  placeholder="0"
                  className="text-center"
                />
                <span className="text-[var(--text-muted)]">-</span>
                <Input
                  type="number"
                  value={g.b}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, b: e.target.value };
                    setGames(updated);
                  }}
                  placeholder="0"
                  className="text-center"
                />
              </div>
            ))}

            {games.length < maxGames && (
              <Button variant="ghost" size="sm" onClick={addGame} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">+ Add Game</Button>
            )}

            {/* Time exceeded — the score stands as it was when time was called */}
            <div className="rounded-lg bg-[var(--bg-elevated)] px-3">
              <Switch
                checked={timeExceeded}
                onChange={setTimeExceeded}
                label="Time exceeded"
                description="Court time ran out mid-game — record the score as it stood."
              />
            </div>

            {/* Winner indicator. Always mounted, one line of text-sm reserved:
                see the correction view above for both halves of why. Submit
                Score is disabled on !autoWinner exactly as Save Corrected
                Result is, so the render that enables it is the render this line
                pushed it down by. */}
            <div className="min-h-[1.25rem] text-center text-sm" role="status" aria-live="polite">
              {autoWinner && (
                <span className="text-[var(--color-success)] font-medium">
                  Winner: {autoWinner === 'a' ? nameA : nameB}
                </span>
              )}
              {stagedReason && (
                <span className="text-[var(--text-muted)]">{stagedReason}</span>
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" onClick={() => setView('walkover')} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Walkover / Void
              </Button>
              <Button onClick={handleSubmit} loading={loading} disabled={!autoWinner} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Submit Score
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setView('slots')} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Fix match slots
            </Button>
          </>
        )}

        {/* Walkover/Void section */}
        {view === 'walkover' && (
          <>
            <Input
              label="Reason"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Reason for walkover or void..."
            />
            {/* Every entry point here except Void needs a match that is still
                playable — the server refuses a walkover or a no-show on a
                decided match — so a settled match is offered Void alone rather
                than three buttons that can only fail. Correcting it is the
                other option, and it is the panel this one was reached from. */}
            {!isDecided && (
              <>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => handleWalkover('a')} loading={walkoverLoading} disabled={!aId} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                    Walkover → {nameA}
                  </Button>
                  <Button size="sm" onClick={() => handleWalkover('b')} loading={walkoverLoading} disabled={!bId} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                    Walkover → {nameB}
                  </Button>
                </div>
                {/* Neither side present. Distinct from a walkover, which needs
                    somebody to award it to, and from a plain void, which says
                    nothing about why. Disabled unless BOTH sides are known — one
                    empty side is an unopposed walkover, not a no-show. */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleDoubleNoShow}
                  loading={walkoverLoading}
                  disabled={!aId || !bId}
                  className="w-full text-[var(--color-warning)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                >
                  Neither side turned up
                </Button>
                <p className="text-xs text-[var(--text-muted)]">
                  &ldquo;Neither side turned up&rdquo; marks both entries as a no-show — which counts toward
                  their reliability record — and leaves the next round empty for you to fill.
                </p>
              </>
            )}
            <p className="text-xs text-[var(--text-muted)]">
              Voiding erases the match: {rated ? 'any Elo it applied is reversed and ' : ''}its winner is taken back out
              of the next round. It can be restored later.
            </p>
            {/* Gated on the event, because this panel is reached on a live event
                too and there is nothing to reopen there. Only the match that
                decided the event clears the standings, which is why this says
                "if": voiding any other match recomputes them and leaves the
                event finalised. */}
            {event.status === 'completed' && (
              <p className="text-xs text-[var(--color-warning)]">
                This event is already finalised. If this was the match that decided it, voiding clears
                the final placings and points and puts the event back to live, so the result can be
                re-entered and the event finalised again.
              </p>
            )}
            <Button size="sm" variant="ghost" onClick={handleVoid} loading={walkoverLoading} className="w-full text-[var(--color-danger)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Void Match
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setView(isDecided ? 'correct' : hasBothSides ? 'score' : 'slots')} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Back
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ============================================================
// After the game: what it did to each side's tournament
// ============================================================
//
// THE EVENT'S FIGURES, NOT A CAREER. "elo_before -> elo_after" is where this
// entrant started the day and where they are now, and elo_change is the whole
// event's swing rather than this match's (00083) — three numbers that finally
// agree, which they did not before that migration. It is deliberately not a
// per-match delta: an exec looking at a scored quarter-final wants "is this
// player up or down on the day", and the per-match figure is already in the
// audit log for anyone who wants it.
//
// It doubles as confirmation that the RIGHT result landed. The score, the
// winner and the record are read back out of the database after the write, so
// a scoreline typed into the wrong card shows up here as the wrong name in
// green — which is the check that used to require closing the dialog and
// finding the card again.
function OutcomeSummary({ summary, unrated, external, onClose }: { summary: MatchOutcomeSummary; unrated: boolean; external: boolean; onClose: () => void }) {
  const scoreline = summary.scores && summary.scores.length > 0
    ? summary.scores.map((g) => `${g.a}-${g.b}`).join(', ')
    : null;

  return (
    <div className="space-y-4">
      <div className="rounded-[8px] bg-[var(--bg-elevated)] px-3 py-2">
        <p className="text-sm text-[var(--text-primary)]">
          {summary.roundName ?? 'This match'}
          {scoreline ? <> — <span className="font-mono">{scoreline}</span></> : null}
          {summary.status === 'walkover' ? ' — walkover' : ''}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {[summary.a, summary.b].map((entry, i) =>
          entry ? <EntrySummaryCard key={entry.entryId} entry={entry} doubles={summary.doubles} />
                : <div key={i} />,
        )}
      </div>

      {/* SAID, NOT LEFT BLANK. tournament_pairs has no elo columns — the rating
          movement from a doubles match goes to the two players' own ladders and
          there is no pair row for it to land on — so the panel names the gap
          rather than showing an empty rating line that reads as "no change". */}
      {unrated ? (
        <p className="text-xs text-[var(--text-muted)]">
          {external ? 'External event: ' : 'Unrated match: '}this result moves nobody&rsquo;s rating.
        </p>
      ) : summary.doubles && (
        <p className="text-xs text-[var(--text-muted)]">
          Rating movement is not tracked per pair: a doubles result moves each player&rsquo;s own doubles
          rating, which is on their player page rather than on this event&rsquo;s entry.
        </p>
      )}

      {!summary.eventFinalised && (
        <p className="text-xs text-[var(--text-muted)]">
          Points and final placings are written when the event is finalised, so they are still blank.
        </p>
      )}

      <div className="flex justify-end pt-1">
        <Button onClick={onClose} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
          Done
        </Button>
      </div>
    </div>
  );
}

function EntrySummaryCard({ entry, doubles }: { entry: EntryEventSummary; doubles: boolean }) {
  // THE DELTA IS DERIVED FROM THE TWO RATINGS BESIDE IT, not read from
  // elo_change, so the three figures on the row always reconcile. The rule, and
  // why the two can differ at the rating ceiling, is on eventRatingLine in
  // @badminton/shared, which the member's own event page uses as well.
  const rating = eventRatingLine(entry.eloBefore, entry.eloAfter, entry.eloChange);
  const hasBoth = rating?.before != null && rating.after != null;
  const delta = rating?.delta ?? null;
  const up = (delta ?? 0) > 0;
  const down = (delta ?? 0) < 0;

  return (
    <div
      className={`rounded-[8px] border p-3 space-y-2 ${
        entry.isWinner
          ? 'border-[var(--color-success)] bg-[color-mix(in_srgb,var(--color-success)_8%,transparent)]'
          : 'border-[var(--border)]'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-[var(--text-primary)]">{entry.name}</span>
        {entry.isWinner && (
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-success)]">Won</span>
        )}
      </div>

      <dl className="space-y-1 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--text-muted)]">In this event</dt>
          <dd className="font-mono text-[var(--text-secondary)]">
            {entry.won}&ndash;{entry.played - entry.won}
            <span className="sr-only"> won and lost of {entry.played} played</span>
          </dd>
        </div>

        {!doubles && delta != null && (
          <div className="flex justify-between gap-2">
            <dt className="text-[var(--text-muted)]">Rating</dt>
            <dd className="font-mono text-[var(--text-secondary)]">
              {hasBoth && <>{rating.before} &rarr; {rating.after} </>}
              <span className={up ? 'text-[var(--color-success)]' : down ? 'text-[var(--color-danger)]' : 'text-[var(--text-muted)]'}>
                <span className="sr-only">{up ? 'gained' : down ? 'lost' : 'no change'} </span>
                ({up ? '+' : ''}{delta})
              </span>
            </dd>
          </div>
        )}

        {entry.points != null && entry.points > 0 && (
          <div className="flex justify-between gap-2">
            <dt className="text-[var(--text-muted)]">Points</dt>
            <dd className="font-mono text-[var(--text-secondary)]">{entry.points}</dd>
          </div>
        )}

        {entry.finalPosition != null && (
          <div className="flex justify-between gap-2">
            <dt className="text-[var(--text-muted)]">Finished</dt>
            <dd className="font-mono text-[var(--text-secondary)]">#{entry.finalPosition}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
