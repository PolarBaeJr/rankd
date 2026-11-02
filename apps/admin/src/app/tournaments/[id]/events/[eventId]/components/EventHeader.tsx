'use client';

import { useRef, useState } from 'react';
import { Badge, Button, useConfirm } from '@badminton/ui';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
  anyStageRated,
  eventStatusLabel,
  parseFormatConfig,
  nextPowerOf2,
  describeMatchShape,
  TOURNAMENT_EVENT_FORMAT_LABELS,
  isPoolToBracket,
  endsInKnockout,
  playsRoundRobin,
  statusStepsFor,
  currentPhase,
  effectiveWindows,
  formatWindowInstant,
  windowState,
} from '@badminton/shared';
import type { TournamentEventType, TournamentEventStatus } from '@badminton/shared';
import {
  setEventStatus,
  generateSingleEliminationBracket,
  generateRoundRobinMatches,
  finalizeEvent,
  lockDraw,
  unlockDraw,
  updateTournamentEvent,
  drawStage,
} from '@/lib/tournament-actions';
import { autoCallFailureText } from '@/lib/live-desk';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Trophy, Users, CheckCircle, Swords, BarChart3, ChevronRight, Lock, Unlock, SlidersHorizontal, RefreshCw, Clock } from 'lucide-react';
import { EventSettingsDialog } from './EventSettingsDialog';
import { EventWindowsDialog } from './EventWindowsDialog';
import { regenerateDrawControl, type DrawCapabilities } from '@/lib/participant-controls';
import type { SiblingEvent } from '../../../event-format-fields';
import type { TournamentEventRow } from '@/lib/tournament-types';

interface Props {
  tournament: Record<string, unknown>;
  event: Record<string, unknown>;
  siblingEvents: SiblingEvent[];
  isDoubles: boolean;
  totalEntries: number;
  checkedIn: number;
  totalMatches: number;
  /** Progress: decided slots, byes included. Feeds the stats row and Finalize. */
  completedMatches: number;
  /**
   * Matches somebody actually played — isPlayedMatch, so byes are excluded.
   * The redraw is the only control that asks this narrower question; see
   * EventControlCenter for why the two counts must stay apart.
   */
  playedMatches: number;
  /**
   * Matches on court right now (isInProgressMatch). Not a result, and so not in
   * `playedMatches` — but a redraw deletes them from under the people playing
   * them, which is why the button has to know about them separately.
   */
  liveMatches: number;
  /**
   * Matches carrying an unreversed rating that are not already counted as
   * played. Normally zero; see summariseRedrawBlockers.
   */
  ratedMatches: number;
  /** How many matches the CURRENT phase holds — what a redraw would replace. */
  phaseMatches: number;
  /** How many matches the POOL half holds, and how many are decided. */
  poolTotal: number;
  poolDecided: number;
  /** Only `generate` is read here; the rest belong to the participants tab. */
  drawCapabilities: DrawCapabilities;
  /** Does the draw that exists right now carry a 3rd place playoff match? */
  hasThirdPlace: boolean;
  /** A staged event: the stage numbers that have matches. Empty otherwise. */
  stagesDrawn: number[];
}

export function EventHeader({ tournament, event, siblingEvents, isDoubles, totalEntries, checkedIn, totalMatches, completedMatches, playedMatches, liveMatches, ratedMatches, phaseMatches, poolTotal, poolDecided, drawCapabilities, hasThirdPlace, stagesDrawn }: Props) {
  const [loading, setLoading] = useState(false);
  const [lockLoading, setLockLoading] = useState(false);
  const [regenLoading, setRegenLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [windowsOpen, setWindowsOpen] = useState(false);
  // The third-place playoff is a generation-time choice, so it lives next to the
  // button that generates. It is NOT persisted on the event — the generated
  // match is the record — so this is deliberately plain local state that resets
  // with the page, which is also what makes it honest: it can only ever describe
  // the draw that is about to be built, never one that already exists.
  // DEFAULT ON, at the club owner's instruction. A club running a knockout
  // almost always plays off for third — leaving it unticked meant the common
  // case needed a deliberate act and the rare one did not, and a draw generated
  // without it cannot be given one afterwards without regenerating.
  //
  // offerThirdPlace still gates whether the box is shown at all, so a draw with
  // no semi-final round is unaffected by this default.
  const [thirdPlace, setThirdPlace] = useState(true);
  // The SECOND third-place choice: the one made inside the Regenerate confirm.
  // It cannot share `thirdPlace` above — that state describes a draw that does
  // not exist yet and defaults ON, whereas regenerating starts from whatever the
  // existing draw actually has. A ref rather than state because the confirm
  // dialog stores the message element it was handed and re-rendering EventHeader
  // does not re-render it; the checkbox owns its own state (ThirdPlaceChoice
  // below) and writes the answer out through here.
  const regenThirdPlace = useRef(hasThirdPlace);
  // The same trick again, for the OTHER choice a redraw makes: whether to draw
  // at all. See DrawModeChoice.
  const regenExactDraw = useRef(false);
  const { toast } = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const drawLocked = event.draw_locked as boolean;

  const status = event.status as TournamentEventStatus;
  const eventType = event.event_type as TournamentEventType;
  const format = event.format as string;
  // The stepper's steps come from the SAME function setEventStatus derives its
  // transition table from, so the progress bar and the server cannot disagree
  // about what happens next.
  const STATUS_STEPS = statusStepsFor(format);
  const poolToBracket = isPoolToBracket(format);
  // A STAGED EVENT (00272) is drawn a stage at a time from its Stages tab. The
  // header's only draw is stage 1 at check-in; there is no whole-event redraw
  // and no third-place tick box, because both live in the config.
  const staged = format === 'staged';
  const stagedCfg = staged ? parseFormatConfig(event.format_config) : null;
  const firstStage = stagedCfg?.stages[0];
  const undrawnStages = stagedCfg ? stagedCfg.stages.filter((_, i) => !stagesDrawn.includes(i + 1)).map((s) => s.name) : [];
  const statusLabel = (s: TournamentEventStatus) => eventStatusLabel(format, s);
  const phaseNow = currentPhase(format, status);
  const currentStepIdx = STATUS_STEPS.indexOf(status);
  const groupCount = (event.group_count as number | null) ?? 1;
  const qualifiersPerGroup = (event.qualifiers_per_group as number | null) ?? (groupCount >= 2 ? 2 : 4);
  // THE KNOCKOUT'S FIELD IS THE QUALIFIERS, NOT THE ENTRY LIST (00107). Sizing
  // it from totalEntries would tell an exec running 24 people in 4 groups that
  // they were about to get a 32-slot bracket with 24 byes, when what the format
  // actually produces is an 8-slot draw. A flat pool is one group, so the same
  // two numbers describe both shapes.
  const fieldSize = poolToBracket
    ? Math.min(groupCount >= 2 ? groupCount * qualifiersPerGroup : qualifiersPerGroup, totalEntries)
    : totalEntries;
  const bracketSize = nextPowerOf2(fieldSize);
  const byes = bracketSize - fieldSize;
  // Offered only where it means something: a knockout draw. A round robin
  // already produces a full ordering, and a 2-entry draw is a final with no
  // semi-finals to lose.
  // endsInKnockout, not `!== 'round_robin'`: a pool_to_bracket event ends in a
  // knockout and wants a playoff exactly as a single-elimination one does.
  const thirdPlaceApplies = endsInKnockout(format) && bracketSize >= 4;
  // ...and at the moment the draw is generated, which is now three moments: the
  // first press at check-in, the press that draws a pool_to_bracket event's
  // knockout out of its finished pool, and a redraw once a bracket exists.
  const offerThirdPlace = thirdPlaceApplies
    && (poolToBracket ? status === 'pool_live' : status === 'checkin');
  // Same rule the server applies: the format is editable until a draw exists.
  // A staged event's stages not yet drawn stay editable until it is finalised
  // (updateTournamentEventImpl refuses a change to a drawn one). A legacy
  // event's points table is read only at finalisation, so it too stays
  // editable until then (00275): past the draw the dialog offers it alone.
  const settingsEditable = status !== 'completed';
  const pointsOnlySettings = !staged
    && (totalMatches > 0 || (status !== 'registration' && status !== 'checkin'));
  const seededFromPool = Boolean(event.seeded_from_event_id);
  // Mirrors generateSingleEliminationBracketImpl exactly. Kept in step by the
  // dialog reading the same two fields the generator reads — a third rule here
  // would be a promise about the draw that the server does not keep.
  //
  // A pool_to_bracket event is pool-seeded from its OWN pool, so it is drawn on
  // the same terms: not at all when the pool is flat (the finishing order is a
  // total order everybody played for), and within qualification tiers when it
  // has groups.
  const ownPoolSeeded = poolToBracket;
  const drawIsRandomised = poolToBracket
    ? groupCount >= 2 && event.seeding_method !== 'manual'
    : !seededFromPool && event.seeding_method !== 'manual';

  async function handleAction() {
    setLoading(true);
    try {
      if (status === 'registration') {
        // Same `res.ok` shape as the two generator calls below it, and for the
        // same reason: the refusals are sentences the exec has to read.
        const res = await setEventStatus(event.id as string, 'checkin');
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        toast('Check-in opened', 'success');
      } else if (status === 'checkin' && staged) {
        if (!firstStage) { toast('The stages are not set out correctly. Fix them in Event Settings.', 'error'); setLoading(false); return; }
        const res = await drawStage(event.id as string, firstStage.key);
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        toast(`${firstStage.name} drawn`, 'success');
      } else if (status === 'checkin') {
        // WHICH HALF IS BUILT FIRST. playsRoundRobin covers both round_robin and
        // pool_to_bracket, because the first thing a pool_to_bracket event
        // builds IS a round robin — same action, same generator; the server
        // labels its matches and leaves the event in the pool states.
        const res = playsRoundRobin(format)
          ? await generateRoundRobinMatches(event.id as string)
          // A pool-seeded draw's size is only known server-side, so the flag is
          // passed as ticked and the server skips it if the resulting draw turns
          // out to have no semi-final round. offerThirdPlace gates the CHECKBOX,
          // not the request, so a stale `true` from a size that has since
          // changed cannot smuggle a playoff into a two-entry draw.
          : await generateSingleEliminationBracket(event.id as string, offerThirdPlace && thirdPlace);
        // Generation refuses for ordinary reasons — an unfinished pool, a locked
        // draw — and the exec needs to read which one, so the message is shown
        // rather than swallowed by a generic failure toast.
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        toast(poolToBracket ? 'Round robin generated' : 'Bracket generated', 'success');
      } else if (status === 'pool_generated') {
        const res = await setEventStatus(event.id as string, 'pool_live');
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        toast('Round robin is live!', 'success');
      } else if (status === 'pool_live') {
        // THE ONE PRESS THE WHOLE FORMAT EXISTS FOR: the pool is played out and
        // the qualifiers go into a knockout without re-entering anything and
        // without checking in again. The server refuses if a single pool match
        // is still open, and says which.
        const res = await generateSingleEliminationBracket(event.id as string, offerThirdPlace && thirdPlace);
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        toast('Knockout drawn from the round-robin standings', 'success');
      } else if (status === 'bracket_generated') {
        const res = await setEventStatus(event.id as string, 'live');
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        const called = staged ? res.data?.autoCall?.called.length ?? 0 : 0;
        toast(
          called > 0 ? `Tournament is live! ${called} match${called === 1 ? '' : 'es'} put on court` : 'Tournament is live!',
          'success',
        );
        const autoCallFailure = autoCallFailureText(res.data?.autoCall);
        if (autoCallFailure) toast(autoCallFailure, 'error');
      } else if (status === 'live') {
        await finalizeEvent(event.id as string);
        toast('Event finalized', 'success');
      }
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Action failed', 'error');
    }
    setLoading(false);
  }

  const regenerateLegacy = regenerateDrawControl(
    { status, drawLocked, playedMatches, liveMatches, ratedMatches },
    drawCapabilities,
  );
  const regenerate = staged ? { ...regenerateLegacy, show: false } : regenerateLegacy;
  const eventLabel = TOURNAMENT_EVENT_TYPE_LABELS[eventType] ?? eventType;

  /**
   * REDRAW THE EVENT, IN PLACE.
   *
   * Calls the same two actions the primary button calls at check-in, on an
   * event that already has a bracket. Both delete every match for the event and
   * rebuild from the current field, and both leave the event's status exactly
   * where they found it (statusAfterDraw, tournament-actions/brackets.ts) — so
   * there is no state to move and nothing to put back if it refuses.
   *
   * OFFERED AT `live` AS WELL AS `bracket_generated`. The owner pressed "Start
   * Tournament" and the button vanished with no way back, and most live events
   * have nothing played. What decides it is not the status but the match rows:
   * `playedMatches`, `liveMatches` and `ratedMatches` grey the button here and
   * assertDrawIsRebuildable refuses on the server, and all three count the same
   * things. Neither is the guarantee — delete_phase_matches (00144) re-asks them
   * of the rows it actually deletes and rolls the delete back — but they are why
   * an exec is told before the click rather than after.
   *
   * IT IS NOT A THIN RE-RUN. Everything the first generation checked is checked
   * again, because the field can have changed underneath it: a pool-seeded
   * event re-reads the pool standings and re-promotes the qualifiers (the pool
   * may have been edited, and a qualifier may have withdrawn since), a doubles
   * event re-runs assertNobodyLeftUnpaired, the whole drawn field is re-tested
   * for event-waiver signatures, and an unseeded field is re-seeded by rating.
   * That re-checking is the point: the reason to redraw is usually that the
   * field is not what it was.
   */
  async function handleRegenerate() {
    // Reset before every open — the ref outlives the dialog, and `hasThirdPlace`
    // may have changed since the last one.
    regenThirdPlace.current = hasThirdPlace;
    regenExactDraw.current = !drawIsRandomised;

    const ok = await confirm({
      title: status === 'live'
        ? `Redraw the ${eventLabel} while it is running?`
        : `Regenerate the ${eventLabel} draw?`,
      message: (
        <div className="space-y-3">
          <p>
            The {phaseMatches === 1 ? 'one match' : `${phaseMatches} matches`} in
            {' '}{phaseNow === 'pool' ? 'the round robin' : 'the current draw'}
            {' '}are deleted and a new draw is built from{' '}
            {phaseNow === 'bracket' && poolToBracket
              ? 'the round-robin standings as they stand now'
              : `the ${totalEntries === 1 ? 'entry' : `${totalEntries} entries`} in the event right now`}. Match numbers, courts and who plays whom all change, so anyone
            who has already been told their first-round opponent will have the wrong one.
          </p>
          {/* THE LIVE PARAGRAPH SAYS THE TWO THINGS THE EXEC CANNOT SEE FROM THE
              SCREEN: that the console has no idea whether a match is on court
              right now (nothing writes tournament_matches.court or the 'live'
              match status, so a match sits at "ready" from the moment its two
              names are known until a score is typed in), and that the event is
              not being un-started. Both are consequences of this button that
              the bracket behind the dialog does not show. */}
          {status === 'live' && (
            <p>
              This event is under way. Nothing has been played yet as far as the console can tell —
              but a match that is being played right now looks exactly like one that has not started,
              because it only stops being &ldquo;ready&rdquo; when a score is entered. Check the courts
              before you do this. The event stays live either way; only the matches are replaced.
            </p>
          )}
          <p>
            Everyone in the new draw is notified that the bracket has been published, again.
            {seededFromPool && ' The field is re-read from the pool standings, so a pool result edited since the first draw is picked up.'}
            {phaseNow === 'pool' && ' The knockout has not been drawn yet, so nothing downstream depends on these fixtures.'}
            {' '}Nothing that has been played is touched: if any result, walkover or forfeit has been
            recorded, this is refused rather than done. Byes do not count as played.
          </p>
          {/* WHAT "REGENERATE" ACTUALLY DOES, which is the thing the club owner
              could not tell from pressing it: the draw is DRAWN AGAIN, at
              random within the seeding tiers, so a second press really does
              give a different bracket. It used to be a pure function of the
              seeds and produced an identical draw every time — "regenerate draw
              doesnt change anything" was an accurate bug report. The two cases
              that still redraw identically say so here rather than leave the
              exec pressing the button a third time to find out. */}
          {endsInKnockout(format) && phaseNow !== 'pool' && (
            (seededFromPool || ownPoolSeeded) ? (
              <p>
                {ownPoolSeeded && groupCount >= 2
                  ? 'This knockout is seeded from this event\u2019s own group stage. Group winners stay in the top tier and runners-up in the next, but who meets whom inside a tier is drawn again \u2014 and group-mates are kept apart in round one where the field allows it.'
                  : 'This event is seeded from a pool, so the draw follows the pool standings exactly and will come out the same unless a pool result has changed.'}
              </p>
            ) : (
              <DrawModeChoice
                defaultExact={!drawIsRandomised}
                onChange={(v) => { regenExactDraw.current = v; }}
              />
            )
          )}
          {thirdPlaceApplies && (
            <ThirdPlaceChoice
              defaultChecked={hasThirdPlace}
              onChange={(v) => { regenThirdPlace.current = v; }}
            />
          )}
        </div>
      ),
      confirmLabel: status === 'live' ? 'Redraw the live event' : 'Regenerate draw',
      danger: true,
    });
    if (!ok) return;

    setRegenLoading(true);
    // THE CHOICE HAS TO LAND BEFORE THE DRAW, because the generator reads it off
    // the event row. Written only when it actually changed — an event already on
    // the setting the exec picked needs no update, no audit row and no chance to
    // fail. A pool-seeded event never gets here: it has no checkbox, because
    // seeding_method is not consulted on that path at all.
    //
    // Turning the draw back on writes 'elo' rather than restoring a previous
    // 'random'. The two differ: 'random' shuffles the whole field and ignores
    // ratings, 'elo' draws within rating tiers. 'elo' is the default every
    // event in the club already carries; 'random' is chosen when the event is
    // created. A 'random' event that stays drawn is never rewritten here,
    // because its mode does not change.
    const modeShouldChange = !seededFromPool && !poolToBracket && endsInKnockout(format)
      && regenExactDraw.current === drawIsRandomised;
    if (modeShouldChange) {
      const modeRes = await updateTournamentEvent(event.id as string, {
        seeding_method: regenExactDraw.current ? 'manual' : 'elo',
      });
      if (!modeRes.ok) { toast(modeRes.error, 'error'); setRegenLoading(false); return; }
    }
    // Dispatched on format exactly as handleAction does — a round robin sitting
    // at bracket_generated has its own delete-and-rebuild and no playoff.
    // WHICH HALF IS REBUILT is decided by the phase the event is IN, not by its
    // format alone — a pool_to_bracket event redraws its pool while the pool is
    // the current phase and its knockout once the knockout is. The server makes
    // the same decision from the same status and deletes only that half.
    const res = (phaseNow === 'pool' || format === 'round_robin')
      ? await generateRoundRobinMatches(event.id as string)
      // Same reasoning as the check-in press: `thirdPlaceApplies` gates the
      // CHECKBOX, not the request, and createThirdPlaceMatch skips a draw with
      // no semi-final round rather than refusing the whole generation.
      : await generateSingleEliminationBracket(event.id as string, thirdPlaceApplies && regenThirdPlace.current);
    if (!res.ok) { toast(res.error, 'error'); setRegenLoading(false); return; }
    toast('Draw regenerated', 'success');
    router.refresh();
    setRegenLoading(false);
  }

  const actionLabel: Record<string, string> = {
    registration: 'Open Check-In',
    // A plain round robin has no bracket; the button draws its fixtures.
    checkin: staged ? `Draw ${firstStage?.name ?? 'Stage 1'}`
      : poolToBracket || format === 'round_robin' ? 'Generate Round Robin' : 'Generate Bracket',
    pool_generated: 'Start Round Robin',
    // THE BUTTON SAYS WHAT IT DOES. "Next Step" on the one press the format
    // exists for would leave the exec guessing whether it starts the knockout
    // or ends the event.
    pool_live: 'Draw the Knockout',
    bracket_generated: poolToBracket ? 'Start Knockout' : 'Start Tournament',
    live: 'Finalize Tournament',
  };

  // A pool-seeded event usually has NOBODY entered yet — its field arrives at
  // generation, promoted from the pool. Gating on checked-in entries would make
  // the one button that can fill it permanently unpressable.
  const poolOutstanding = Math.max(0, poolTotal - poolDecided);
  const actionDisabled =
    (status === 'checkin' && checkedIn < 2 && !seededFromPool)
    // The knockout cannot be drawn out of a half-played pool — the server
    // refuses, and it should not take a click to find that out.
    || (status === 'pool_live' && poolOutstanding > 0)
    // Finalizing refuses unless every match is decided (finalize.ts), and it
    // refused AFTER the click — an exec pressed the one obvious button at the
    // end of an event and got an error for a state the page already knew about.
    // totalMatches/completedMatches are already props, so the button can say so
    // before it is pressed rather than after.
    || (status === 'live' && completedMatches < totalMatches)
    // A staged event finishes with its last stage, so every stage has to be drawn.
    || (status === 'live' && undrawnStages.length > 0)
    || (status === 'checkin' && staged && !firstStage);

  // The windows (00276). select('*') names every column, so a database without
  // the migration has nothing to edit. The check-in window never opens
  // check-in by itself: when it is open and the event is still taking
  // entries, the primary button says so and the exec decides.
  const windowsAvailable = 'registration_opens_at' in event;
  const checkinWindow = windowsAvailable ? effectiveWindows({ event, tournament }).checkin : null;
  const checkinOpensAt = checkinWindow?.opens_at ?? null;
  const checkinWindowOpened = status === 'registration' && checkinOpensAt !== null
    && windowState(checkinOpensAt, checkinWindow?.closes_at, new Date()) === 'open';

  // Why it is disabled, not just that it is. "Finalize" greyed with no reason
  // sends someone hunting through the bracket for what is missing.
  const actionHint =
    status === 'checkin' && checkedIn < 2 && !seededFromPool
      ? 'At least two players must be checked in'
      : status === 'pool_live' && poolOutstanding > 0
        ? `${poolOutstanding} round-robin match${poolOutstanding === 1 ? '' : 'es'} still to be played`
      : status === 'live' && completedMatches < totalMatches
        ? `${totalMatches - completedMatches} match${totalMatches - completedMatches === 1 ? '' : 'es'} still to be decided`
      : status === 'live' && undrawnStages.length > 0
        ? `${undrawnStages.join(', ')} still to be drawn`
      : status === 'checkin' && staged && !firstStage
        ? 'The stages are not set out correctly. Fix them in Event Settings.'
      : checkinWindowOpened && checkinOpensAt
        ? `Check-in window opened at ${formatWindowInstant(checkinOpensAt)}. Open check-in?`
        : undefined;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6 space-y-5">
      {/* Title + Badges */}
      <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)] flex items-center justify-center">
              <Trophy className="w-5 h-5 text-[var(--color-accent)]" />
            </div>
            <div>
              <h1 className="text-2xl font-bold font-display text-[var(--text-primary)]">
                {TOURNAMENT_EVENT_TYPE_LABELS[eventType] ?? eventType}
              </h1>
              <p className="text-sm text-[var(--text-muted)] mt-0.5">
                {tournament.name as string}
              </p>
            </div>
          </div>
          <div className="flex gap-2 mt-3 ml-[52px]">
            <span
              className="text-xs font-semibold px-2.5 py-1 rounded-full"
              role="status"
              style={{
                color: TOURNAMENT_EVENT_STATUS_COLORS[status],
                backgroundColor: `${TOURNAMENT_EVENT_STATUS_COLORS[status]}15`,
              }}
            >
              <span className="sr-only">Event status: </span>{statusLabel(status)}
            </span>
            <Badge variant="default">
              {TOURNAMENT_EVENT_FORMAT_LABELS[format as keyof typeof TOURNAMENT_EVENT_FORMAT_LABELS] ?? format}
            </Badge>
            {event.external_event === true && <Badge variant="default">External, unrated</Badge>}
            {staged && event.external_event !== true && stagedCfg && !anyStageRated(stagedCfg) && <Badge variant="default">Unrated</Badge>}
            {poolToBracket && (
              <Badge variant="default">
                {groupCount >= 2
                  ? `${groupCount} groups, top ${qualifiersPerGroup} each`
                  : `Top ${qualifiersPerGroup} qualify`}
              </Badge>
            )}
            {/* NOT ON A POOL_TO_BRACKET EVENT. Every match there carries its
                own shape from the round ladder, so the event-level value is
                never played to — the badge announced "Best of 3 to 21" above a
                first round played to 11. The Bracket tab's "Played to" strip is
                where the real shapes live. */}
            {!isPoolToBracket(event.format as string) && !staged && (
              <Badge variant="default">{describeMatchShape(event as unknown as TournamentEventRow)}</Badge>
            )}
            {/* THE ONLY PLACE seed_by IS VISIBLE AFTER THE DRAW, which is why
                it covers pool_to_bracket too. Once a draw exists Event Settings
                offers only the points table (see pointsOnlySettings below), so
                the criterion is frozen and has no form left to disable; this
                badge is the read-only view of it. Gating on
                `seededFromPool` alone hid it on the one format that ranks its
                OWN pool: pool_to_bracket has no seeded_from_event_id by
                construction, yet brackets.ts picks its qualifiers by seed_by and
                finalize.ts ranks its non-qualifiers by the same column. */}
            {(seededFromPool || poolToBracket) && (
              <Badge variant="default">
                {seededFromPool ? 'Seeded from pool by ' : 'Pool ranked by '}
                {(event.seed_by as string) === 'points' ? 'points' : 'wins'}
              </Badge>
            )}
            {drawLocked && <Badge variant="default">Draw Locked</Badge>}
          </div>
        </div>

        {/* items-start, because the children are not the same shape. Lock Draw
            is a bare Button; Regenerate and the primary action are each a column
            of button-plus-hint. Flex stretches by default, so the bare button
            grew to the height of a neighbour's button AND its caption — which is
            why Lock Draw stood taller than Finalize Tournament with a gap of
            dead border underneath it. */}
        <div className="flex items-start gap-2">
          {settingsEditable && (
            <Button
              variant="ghost"
              aria-label="Event settings"
              className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
              onClick={() => setSettingsOpen(true)}
            >
              <SlidersHorizontal className="w-4 h-4 mr-1" />
              Settings
            </Button>
          )}
          {settingsEditable && windowsAvailable && (
            <Button
              variant="ghost"
              aria-label="Registration and check-in windows"
              className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
              onClick={() => setWindowsOpen(true)}
            >
              <Clock className="w-4 h-4 mr-1" />
              Windows
            </Button>
          )}
          {['pool_generated', 'pool_live', 'bracket_generated', 'live'].includes(status) && (
            <Button
              variant="ghost"
              loading={lockLoading}
              aria-label={drawLocked ? 'Unlock draw' : 'Lock draw'}
              className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
              onClick={async () => {
                setLockLoading(true);
                try {
                  if (drawLocked) {
                    await unlockDraw(event.id as string);
                    toast('Draw unlocked', 'success');
                  } else {
                    await lockDraw(event.id as string);
                    toast('Draw locked', 'success');
                  }
                  router.refresh();
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Failed', 'error');
                }
                setLockLoading(false);
              }}
            >
              {drawLocked ? <Unlock className="w-4 h-4 mr-1" /> : <Lock className="w-4 h-4 mr-1" />}
              {drawLocked ? 'Unlock Draw' : 'Lock Draw'}
            </Button>
          )}
          {/* SECONDARY WEIGHT, DELIBERATELY. It sits in the same ghost row as
              Lock Draw and never competes with the primary button — starting the
              tournament stays the obvious next step, and redrawing is the thing
              you go looking for. */}
          {regenerate.show && (
            <div className="flex flex-col items-end gap-1">
              <Button
                variant="ghost"
                loading={regenLoading}
                disabled={regenerate.blockedReason !== null}
                aria-label={`Regenerate the ${eventLabel} draw`}
                // describedby rather than title, for the same reason the primary
                // button uses it: a title attribute wins the accessible name
                // computation and the button would announce as its own excuse.
                aria-describedby={regenerate.blockedReason ? 'regenerate-draw-hint' : undefined}
                className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                onClick={handleRegenerate}
              >
                <RefreshCw className="w-4 h-4 mr-1" />
                Regenerate Draw
              </Button>
              {regenerate.blockedReason && (
                <p id="regenerate-draw-hint" className="text-xs text-[var(--text-muted)] max-w-[15rem] text-right">
                  {regenerate.blockedReason}
                </p>
              )}
            </div>
          )}
          {status !== 'completed' && (
            <div className="flex flex-col items-end gap-1">
              <Button
                onClick={handleAction}
                loading={loading}
                disabled={actionDisabled}
                // describedby, NOT title: a title attribute won the accessible
                // name computation, so the button announced as "11 matches still
                // to be decided" and lost "Finalize Tournament" — the action it
                // performs. The reason is already on screen below, so point at
                // that instead and it is announced as a description.
                aria-describedby={actionHint ? 'event-action-hint' : undefined}
                className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
              >
                {actionLabel[status] ?? 'Next Step'}
              </Button>
              {actionHint && (
                <p id="event-action-hint" className="text-xs text-[var(--text-muted)] max-w-[15rem] text-right">{actionHint}</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Third-place playoff — a generation-time choice, so it sits with the
          button that acts on it rather than in Event Settings, which is about
          the event's format and stays editable for a different window. */}
      {offerThirdPlace && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={thirdPlace}
              onChange={(e) => setThirdPlace(e.target.checked)}
              className="mt-0.5 accent-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
            />
            <span>
              <span className="text-sm font-medium text-[var(--text-primary)] block">
                Include a 3rd place playoff
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                The two semi-final losers play for 3rd, scheduled alongside the final. It is a rated match
                like any other, and it needs a court. Without it both semi-finalists finish joint 3rd.
              </span>
            </span>
          </label>
        </div>
      )}

      {/* Status Stepper */}
      <div className="flex items-center gap-1" role="progressbar" aria-label={`Event progress: ${statusLabel(status)}`} aria-valuenow={currentStepIdx + 1} aria-valuemin={1} aria-valuemax={STATUS_STEPS.length}>
        {STATUS_STEPS.map((step, i) => {
          const isActive = i === currentStepIdx;
          const isPast = i < currentStepIdx;
          const color = TOURNAMENT_EVENT_STATUS_COLORS[step];
          return (
            <div key={step} className="flex items-center gap-1 flex-1">
              <div
                className={`h-1.5 flex-1 rounded-full transition-all ${
                  isPast || isActive ? '' : 'bg-[var(--border)]'
                }`}
                style={isPast || isActive ? { backgroundColor: color } : undefined}
              />
              {i < STATUS_STEPS.length - 1 && (
                <ChevronRight className="w-3 h-3 text-[var(--text-muted)] flex-shrink-0" />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-[var(--text-muted)] uppercase tracking-wider px-1">
        {STATUS_STEPS.map((step) => (
          <span key={step} className={step === status ? 'text-[var(--text-primary)] font-semibold' : ''}>
            {statusLabel(step)}
          </span>
        ))}
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={<Users className="w-4 h-4" />}
          label="Registered"
          value={`${totalEntries}${event.max_participants ? `/${event.max_participants}` : ''}`}
          color="var(--color-info)"
        />
        <StatCard
          icon={<CheckCircle className="w-4 h-4" />}
          label="Checked In"
          value={`${checkedIn}/${totalEntries}`}
          color="var(--color-success)"
        />
        <StatCard
          icon={<Swords className="w-4 h-4" />}
          label="Matches"
          value={`${completedMatches}/${totalMatches}`}
          color="var(--color-accent)"
        />
        <StatCard
          icon={<BarChart3 className="w-4 h-4" />}
          label={staged ? 'Stages' : 'Bracket Info'}
          value={
            // Before the knockout is drawn there is no bracket size to report —
            // the field is decided by the pool, not by how many entered — so a
            // pool_to_bracket event shows what it is playing right now.
            staged
              ? `${stagedCfg ? stagedCfg.stages.length - undrawnStages.length : 0}/${stagedCfg?.stages.length ?? 0} drawn`
              : (poolToBracket && phaseNow !== 'bracket') || format === 'round_robin'
              ? `${totalEntries} entries`
              : `${bracketSize}-slot${byes > 0 ? ` (${byes} skip${byes > 1 ? 's' : ''})` : ''}`
          }
          color="var(--color-warning)"
        />
      </div>

      {settingsOpen && (
        <EventSettingsDialog
          event={event as unknown as TournamentEventRow}
          siblings={siblingEvents}
          // The header already counts the field for its stats row; the settings
          // dialog needs the same number to tell an exec how many byes their
          // draw would actually have (00124).
          totalEntries={totalEntries}
          stagesDrawn={stagesDrawn}
          pointsOnly={pointsOnlySettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {windowsOpen && (
        <EventWindowsDialog
          eventId={event.id as string}
          event={event}
          tournament={tournament}
          onClose={() => setWindowsOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The third-place tick box, asked again at the moment of regenerating.
 *
 * THE CHOICE HAS TO BE MADE HERE, not inherited. It is not stored on the event —
 * the generated match IS the record — so a regenerate that reused the header's
 * `thirdPlace` state would have silently DROPPED the playoff every time
 * (`offerThirdPlace` is false outside `checkin`, so the flag passed would be
 * false), and one that hard-coded the new default ON would silently ADD one to
 * every draw that had deliberately gone without. Neither is a choice anybody
 * made. So it is pre-ticked from the draw that exists and shown where the exec
 * can see it before they agree.
 *
 * ITS OWN COMPONENT, WITH ITS OWN STATE, because ConfirmProvider stores the
 * message element it was handed: an input controlled by EventHeader's state
 * would never repaint inside the dialog. This one repaints itself and reports
 * out through onChange.
 */
function ThirdPlaceChoice({ defaultChecked, onChange }: { defaultChecked: boolean; onChange: (v: boolean) => void }) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => { setChecked(e.target.checked); onChange(e.target.checked); }}
        className="mt-0.5 accent-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
      />
      <span>
        <span className="text-sm font-medium text-[var(--text-primary)] block">
          Include a 3rd place playoff
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          {defaultChecked
            ? 'The current draw has one. Untick to redraw without it.'
            : 'The current draw does not have one. Tick to add it to the new draw.'}
          {' '}The two semi-final losers play for 3rd, scheduled alongside the final. It is a rated
          match like any other, and it needs a court.
        </span>
      </span>
    </label>
  );
}

/**
 * WHETHER THE DRAW IS DRAWN, offered where the exec finds out that it is.
 *
 * The bracket is made at random within the seeding tiers, which is what makes
 * Regenerate produce a different draw instead of the byte-identical one the
 * club owner reported. `seeding_method = 'manual'` is the opt-out: place the
 * field exactly where its seed numbers say, and redraw identically for ever.
 *
 * IT HAS TO BE HERE AND NOT ONLY IN EVENT SETTINGS. The exec who wants it is
 * the one who hand-set every seed, pressed this button, and watched the draw
 * move, which is after a draw exists, and Event Settings then offers only the
 * points table (the format must not change under matches that exist). The seeding method is
 * not a format: nothing about the existing matches depends on it, and the
 * server lets it through on its own for exactly that reason.
 *
 * Its own component with its own state, for the same reason ThirdPlaceChoice is
 * — see the note there.
 */
function DrawModeChoice({ defaultExact, onChange }: { defaultExact: boolean; onChange: (v: boolean) => void }) {
  const [exact, setExact] = useState(defaultExact);
  return (
    <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5">
      <input
        type="checkbox"
        checked={exact}
        onChange={(e) => { setExact(e.target.checked); onChange(e.target.checked); }}
        className="mt-0.5 accent-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
      />
      <span>
        <span className="text-sm font-medium text-[var(--text-primary)] block">
          Follow the seed numbers exactly
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          {exact
            ? 'On: every entrant goes to the bracket position their seed number says, so this draw and every later one come out identical.'
            : 'Off: the draw is made at random within the seeding tiers. Seeds 1 and 2 stay at opposite ends and every tier keeps one place per half, quarter and eighth, but who lands where inside a tier is drawn — which is why a redraw gives a different bracket.'}
          {' '}Tick this only if the seeds have been set by hand and the draw has to match them.
        </span>
      </span>
    </label>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] p-3">
      <div className="flex items-center gap-1.5 mb-1" style={{ color }}>
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-medium">{label}</span>
      </div>
      <p className="text-lg font-bold text-[var(--text-primary)] font-mono">{value}</p>
    </div>
  );
}
