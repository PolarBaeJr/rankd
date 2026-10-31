'use client';

import { useState, useTransition, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin, Check, Loader2, AlertCircle, Play, Square, ArrowRight } from 'lucide-react';
import {
  allowedTournamentCourts, courtKey, courtLabel, courtsInOrder, parseFormatConfig, stageCourtLabels, type FormatConfig, type TournamentCourt,
} from '@badminton/shared';
import { SearchFilter } from '@badminton/ui';
import { setMatchCourt, setMatchReadyForPlayer, setMatchLive } from '@/lib/tournament-actions';
import {
  deskRows, nextCallable, deskCounts, buildEntryMaps, deskEventPlaying, deskRowGroup, groupsInPlay,
  filterDeskRows, deskRoundLine, deskRowMatchesSearch, deskGroupLabel, deskGroupChipLabel, deskPools, deskCourtSuggestion,
  type DeskState,
} from '@/lib/live-desk';
import type {
  TournamentMatchRow,
  TournamentEventRow,
  ParticipantWithPlayer,
  PairWithPlayers,
} from '@/lib/tournament-types';
import { getName } from './entry-name';
import { ScoreEntryDialog } from './ScoreEntryDialog';

// ---------------------------------------------------------------------------
// COURT MANAGEMENT — where an event is RUN rather than recorded.
//
// "give us a location setter / show which location the match is at before the
// score ... so we can tell them where to play through the app", then "this
// should follow the order of the matches, and should be showing 'next one'",
// then "this should show 'active match' and also allow insert of data on this
// side instead of the main thing". Four asks, one screen, and together they
// describe the desk's actual job end to end:
//
//     name the court -> confirm they are here -> call them on -> record it
//
// Until now the last step lived somewhere else and the middle two did not exist.
//
// A TAB RATHER THAN CONTROLS BOLTED TO THE BRACKET, and the reason is structural
// rather than aesthetic: the bracket's match card is a single <button> wrapping
// the whole card (BracketTab), so a text input or a ready pill inside it would
// nest interactive elements. This row therefore follows RoundRobinTab's pattern
// instead — a plain <div> with its own inline controls.
//
// THE ORDER, THE STATES AND "NEXT" are worked out in lib/live-desk.ts, with the
// reasoning, because the live strip above the event's tabs shows the same list
// and has to agree with this tab about it.
// ---------------------------------------------------------------------------

interface Props {
  matches: TournamentMatchRow[];
  /** Needed by the shared ScoreEntryDialog — it resolves the per-round shape from it. */
  event: TournamentEventRow;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
  /** tournaments.draw.checkin.mark.write — courts, ready marks, start/stop. */
  canManageCourts: boolean;
  /** tournaments.results.enter.write — a DIFFERENT key. See participant-controls.ts. */
  canEnterResult: boolean;
  /** The tournament's courts (00273); null before that migration, empty when it lists none. */
  courts: TournamentCourt[] | null;
  /** Courts a live match is on anywhere in the tournament. See deskCourtSuggestion. */
  busyCourtIds: string[];
}

/** One person on one side of a match — the unit the ready control acts on. */
interface DeskPlayer {
  playerId: string;
  name: string;
}

interface DeskSide {
  entryId: string | null;
  label: string;
  players: DeskPlayer[];
  /** The entry's round-robin group, null outside a group stage. */
  group: number | null;
}

const entryGroup = (e: unknown): number | null =>
  (e as { group_number?: number | null }).group_number ?? null;

/**
 * A TINTED SURFACE THAT ACTUALLY RENDERS.
 *
 * Tailwind's opacity modifier CANNOT be applied to an arbitrary `var()` colour:
 * `bg-[var(--color-success)]/12` compiles to NOTHING AT ALL, because the compiler
 * has no way to split a runtime custom property into colour channels. It is not a
 * warning and not a fallback — the declaration is simply absent from the
 * stylesheet, so the element renders untinted and the class looks like it worked.
 *
 * THIS IS NOT HYPOTHETICAL AND IT IS WHY THE READY PILLS LOOKED "DIMMED". A pill
 * in the ready state asked for green text, a 12% green fill and a 40% green
 * border; only `text-[var(--color-success)]` compiles, so it rendered as green
 * text on the default surface with the default border — legible, but nothing like
 * the filled chip it was meant to be, and indistinguishable at a glance from the
 * not-ready state beside it. Grepped against the compiled stylesheet, 71 sites
 * across both apps make the same mistake; this file no longer does.
 *
 * color-mix() is the house answer — globals.css already uses it for exactly this
 * (`color-mix(in oklab, var(--win) 30%, transparent)`) — and every token here is
 * a hex literal, which is what makes it mixable.
 */
function tint(token: string, fill: number, edge: number): React.CSSProperties {
  return { ...tintSurface(token, fill, edge), color: `var(${token})` };
}

/**
 * The same fill and edge WITHOUT setting `color`, for a container.
 *
 * A row is tinted green while its match is on court, and `color` on a container
 * is inherited: every child in there carries an explicit text colour today, so
 * nothing leaks — but the next <p> somebody adds without one would come out
 * green on a live row and black on every other, which is the kind of bug that
 * gets called a theme problem. Splitting the two makes the leak impossible
 * rather than merely absent.
 */
function tintSurface(token: string, fill: number, edge: number): React.CSSProperties {
  return {
    background: `color-mix(in oklab, var(${token}) ${fill}%, transparent)`,
    borderColor: `color-mix(in oklab, var(${token}) ${edge}%, transparent)`,
  };
}

export function CourtManagementTab({
  matches,
  event,
  participants,
  pairs,
  isDoubles,
  canManageCourts,
  canEnterResult,
  courts,
  busyCourtIds,
}: Props) {
  // Entry id -> the people behind it. A singles entry is one person; a doubles
  // entry is two, and 00135 exists because knowing one of four has turned up is
  // worth something.
  const sides = useMemo(() => {
    const map = new Map<string, DeskSide>();
    if (isDoubles) {
      for (const p of pairs) {
        const people: DeskPlayer[] = [];
        if (p.player1) people.push({ playerId: p.player1.id, name: p.player1.full_name });
        if (p.player2) people.push({ playerId: p.player2.id, name: p.player2.full_name });
        // getName, not a locally joined string: the dialog and the bracket both
        // render the shared form, and a pair reading "A & B" here while the
        // bracket says "A / B" is the kind of drift that makes an exec ask
        // whether they are looking at the same match.
        map.set(p.id, { entryId: p.id, label: getName(p, isDoubles), players: people, group: entryGroup(p) });
      }
    } else {
      for (const p of participants) {
        map.set(p.id, {
          entryId: p.id,
          label: getName(p, isDoubles),
          players: p.player ? [{ playerId: p.player.id, name: p.player.full_name }] : [],
          group: entryGroup(p),
        });
      }
    }
    return map;
  }, [isDoubles, pairs, participants]);

  // What the shared ScoreEntryDialog needs, derived FRESH rather than reused from
  // `sides` above: its contract is Record<string, string> keyed by entry id, and
  // its doubles label has to match the bracket's.
  const { nameMap, seedMap, placeableEntries } = useMemo(() => {
    const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
    return buildEntryMaps(entries, (e) => getName(e, isDoubles));
  }, [isDoubles, pairs, participants]);

  /**
   * THE OPEN DIALOG, HELD AS AN ID RATHER THAN A ROW.
   *
   * RoundRobinTab and BracketTab both stash the match OBJECT, which means the
   * dialog goes on rendering the row as it was when it was clicked. That is
   * survivable there; here it is not, because this tab is the one that repaints
   * constantly — every court, ready mark and start on the whole event nudges it.
   * Looking the row up again on each render means the dialog always shows the
   * live one.
   *
   * LOOKED UP IN `matches`, THE UNFILTERED LIST, on purpose. Entering a score
   * makes the match `completed`, which drops it out of the working list below —
   * and the dialog's after-game summary is rendered AFTER that happens. Resolving
   * against the filtered list would unmount the dialog at the exact moment it had
   * something to say.
   */
  const [scoreMatchId, setScoreMatchId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // WHICH GROUPS THIS DESK RUNS. See filterDeskRows. Remembered per device and
  // per event, read after mount so the server render matches.
  const groupsKey = `court-desk-groups:${event.id}`;
  const [myGroups, setMyGroups] = useState<number[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(groupsKey) ?? '[]');
      if (Array.isArray(saved)) setMyGroups(saved.filter((g): g is number => typeof g === 'number'));
    } catch { /* no storage: start with every group */ }
  }, [groupsKey]);
  function pickGroups(next: number[]) {
    setMyGroups(next);
    try { window.localStorage.setItem(groupsKey, JSON.stringify(next)); } catch { /* not remembered */ }
  }
  const scoreMatch = scoreMatchId ? matches.find((m) => m.id === scoreMatchId) ?? null : null;

  // The union of what the two half-tabs ask. See deskEventPlaying for why.
  const eventPlaying = deskEventPlaying(event.status, event.format as string);

  const rows = useMemo(() => {
    const sideOf = (entryId: string | null): DeskSide =>
      (typeof entryId === 'string' ? sides.get(entryId) : undefined) ??
      { entryId: null, label: 'TBD', players: [], group: null };

    return deskRows(matches, sideOf, isDoubles);
  }, [matches, sides, isDoubles]);

  const cfg = useMemo(
    () => (event.format === 'staged' ? parseFormatConfig(event.format_config) : null),
    [event.format, event.format_config],
  );
  const inPlay = groupsInPlay(rows);
  const pools = deskPools(inPlay, cfg);
  const { rows: myRows, active: activeGroups } = filterDeskRows(rows, myGroups);

  // One "next", never a live match and never a TBD one. See nextCallable.
  const nextRow = nextCallable(myRows);
  const busy = useMemo(() => new Set(busyCourtIds), [busyCourtIds]);
  const nextSuggestion = nextRow
    ? deskCourtSuggestion(nextRow, courts, busy, courts ? allowedTournamentCourts(courts, stageCourtLabels(cfg, nextRow.match)) : null)
    : null;

  const { live: liveCount, callable: callableCount, waiting: waitingCount, uncourted } = deskCounts(myRows);

  // The search narrows the list only, after next and the counts are worked out.
  const shown = myRows.filter((row) => deskRowMatchesSearch(row, query, cfg));

  if (rows.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-[var(--text-muted)]">
        Nothing left to call — every match in this event has been played.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {/* THE SUMMARY, WHICH IS THE ONE THING WORTH READING BEFORE THE LIST. It
            answers "what am I calling next" without scrolling, which is the ask,
            and it names the match rather than just counting — a desk holding a
            phone wants the two names it is about to shout. */}
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-2">
          {nextRow ? (
            <div className="flex items-start gap-2">
              <ArrowRight className="w-4 h-4 text-[var(--color-accent)] mt-0.5 shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-[var(--color-accent)] font-semibold">
                  Next up
                </p>
                <p className="text-sm text-[var(--text-primary)] break-words" role="status">
                  {nextRow.a.label} <span className="text-[var(--text-muted)]">vs</span> {nextRow.b.label}
                </p>
                <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mt-0.5">
                  {deskRoundLine(nextRow.match, deskRowGroup(nextRow), cfg)}
                  {' · '}
                  {courtLabel(nextRow.match.court) ?? 'no court yet'}
                  {nextSuggestion && ` · ${courtLabel(nextSuggestion.label)} is free`}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)]" role="status">
              {liveCount > 0
                ? `Nothing to call — ${liveCount === 1 ? 'the last match is' : `all ${liveCount} remaining matches are`} on court.`
                : 'Nothing can be called yet — every remaining match is waiting on an earlier result.'}
            </p>
          )}
          <div className="flex items-start gap-2 text-xs text-[var(--text-muted)] pt-1 border-t border-[var(--border)]">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
            {/* THE UNCOURTED COUNT SURVIVED THE SORT CHANGE, because it is
                genuinely useful — it just no longer decides the order. */}
            <p role="status">
              {activeGroups.length > 0 && `${activeGroups.map((g) => deskGroupLabel(g, cfg)).join(', ')}: `}
              {liveCount} on court · {callableCount} ready to call · {waitingCount} waiting
              {uncourted > 0 && ` · ${uncourted} with no court yet (entrants see “Court TBC”)`}
            </p>
          </div>
        </div>

        {inPlay.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Groups this desk is running">
            <span className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mr-1">My groups</span>
            <GroupChip label="All" pressed={activeGroups.length === 0} onClick={() => pickGroups([])} />
            {pools.map((pool) => {
              const all = pool.groups.every((g) => activeGroups.includes(g));
              return (
                <GroupChip
                  key={pool.key}
                  label={pool.label}
                  pressed={all}
                  onClick={() => pickGroups(
                    all
                      ? activeGroups.filter((x) => !pool.groups.includes(x))
                      : [...activeGroups, ...pool.groups.filter((g) => !activeGroups.includes(g))],
                  )}
                />
              );
            })}
            {inPlay.map((g) => (
              <GroupChip
                key={g}
                label={deskGroupChipLabel(g, cfg)}
                pressed={activeGroups.includes(g)}
                onClick={() => pickGroups(
                  activeGroups.includes(g) ? activeGroups.filter((x) => x !== g) : [...activeGroups, g],
                )}
              />
            ))}
          </div>
        )}

        <SearchFilter
          value={query}
          onChange={setQuery}
          label="Search matches by name, court or match number"
          placeholder="Search a name, court or M12"
          resultCount={shown.length}
          noun="match"
          nounPlural="matches"
        />

        {shown.length === 0 && (
          <p className="p-4 text-center text-sm text-[var(--text-muted)]">No unplayed match fits that search.</p>
        )}

        {shown.map(({ match, a, b, state }) => (
          <DeskRow
            key={match.id}
            match={match}
            group={deskRowGroup({ match, a, b })}
            cfg={cfg}
            a={a}
            b={b}
            state={state}
            isNext={nextRow?.match.id === match.id}
            canManageCourts={canManageCourts}
            canEnterResult={canEnterResult && eventPlaying}
            onEnterScore={() => setScoreMatchId(match.id)}
            courts={courts}
            busy={busy}
          />
        ))}
      </div>

      {/* THE SHARED DIALOG, NOT A SECOND SCORE FORM. It already owns the per-round
          shape (resolveMatchShape), best-of-3, legal-score and time-exceeded
          validation, the walkover / void / slot-repair paths, and the after-game
          summary with the entrants' tournament stats. A fork would have drifted
          from all of it inside a week, which is the thing this repo has spent the
          day removing.

          It refreshes the route itself on save, so the list below re-derives its
          states and its "next" from the new data with nothing wired between them. */}
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

function GroupChip({ label, pressed, onClick }: { label: string; pressed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`min-w-[40px] min-h-[36px] px-3 text-xs font-semibold uppercase tracking-wide border transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none ${
        pressed
          ? 'bg-[var(--color-accent)] border-[var(--color-accent)] text-white'
          : 'bg-[var(--bg-elevated)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-hover)]'
      }`}
    >
      {label}
    </button>
  );
}

function DeskRow({
  match,
  group,
  cfg,
  a,
  b,
  state,
  isNext,
  canManageCourts,
  canEnterResult,
  onEnterScore,
  courts,
  busy,
}: {
  match: TournamentMatchRow;
  group: number | null;
  cfg: FormatConfig | null;
  a: DeskSide;
  b: DeskSide;
  state: DeskState;
  isNext: boolean;
  canManageCourts: boolean;
  canEnterResult: boolean;
  onEnterScore: () => void;
  courts: TournamentCourt[] | null;
  busy: ReadonlySet<string>;
}) {
  // A staged match's stage courts (its pool's, in a groups stage); null is any court.
  const allowed = courts ? allowedTournamentCourts(courts, stageCourtLabels(cfg, match)) : null;
  const suggestion = state === 'callable' ? deskCourtSuggestion({ match }, courts, busy, allowed) : null;
  const readyIds = new Set(match.ready_player_ids ?? []);
  const everyone = [...a.players, ...b.players];
  const readyCount = everyone.filter((p) => readyIds.has(p.playerId)).length;
  const label = courtLabel(match.court);

  // THE THREE STATES, FINDABLE AT A GLANCE ON A PHONE. Colour AND a word, never
  // colour alone — this is read at arm's length under gym lighting, and a badge
  // that only differs by hue is a badge that differs by nothing.
  const badge =
    state === 'live'
      ? { text: 'On court', style: tint('--color-success', 14, 45) }
      : isNext
        ? { text: 'Next up', style: tint('--color-accent', 14, 50) }
        : state === 'callable'
          ? { text: 'Ready to call', style: undefined, cls: 'border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)]' }
          : { text: 'Waiting', style: undefined, cls: 'border-[var(--border)] text-[var(--text-muted)]' };

  return (
    <div
      className={`border p-3 space-y-3 ${
        state === 'live' || isNext ? '' : 'border-[var(--border)] bg-[var(--bg-elevated)]'
      }`}
      // Inline for the two tinted states, for the reason `tint` documents: the
      // Tailwind form of this renders nothing.
      style={
        state === 'live'
          ? tintSurface('--color-success', 6, 35)
          : isNext
            ? tintSurface('--color-accent', 6, 40)
            : undefined
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span
            className={`inline-flex items-center px-2 py-0.5 mb-1 border text-[10px] font-bold uppercase tracking-wider ${badge.cls ?? ''}`}
            style={badge.style}
          >
            {badge.text}
          </span>
          <p className="text-sm text-[var(--text-primary)] break-words">
            {a.label} <span className="text-[var(--text-muted)]">vs</span> {b.label}
          </p>
          <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mt-0.5">
            {deskRoundLine(match, group, cfg)}
            {everyone.length > 0 ? ` · ${readyCount} of ${everyone.length} here` : ''}
          </p>
          {/* A WAITING ROW SAYS WHY. Without this the desk sees "TBD vs TBD" and
              wonders whether something is broken, which is how the READY label
              got reported as a bug in the first place. */}
          {state === 'waiting' && (
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              Waiting on an earlier result to fill {!a.entryId && !b.entryId ? 'both slots' : 'a slot'}.
            </p>
          )}
        </div>
        <span className={`shrink-0 text-sm font-semibold ${label ? 'text-[var(--color-accent)]' : 'text-[var(--text-muted)]'}`}>
          {label ?? 'No court'}
        </span>
      </div>

      {courts?.length ? (
        <CourtPicker
          matchId={match.id}
          court={match.court}
          courtId={match.court_id ?? null}
          courts={courts}
          allowed={allowed}
          busy={busy}
          suggestion={suggestion}
          disabled={!canManageCourts}
        />
      ) : (
        <CourtField matchId={match.id} current={match.court ?? ''} disabled={!canManageCourts} />
      )}

      {everyone.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {everyone.map((p) => (
            <ReadyPill
              key={p.playerId}
              matchId={match.id}
              player={p}
              ready={readyIds.has(p.playerId)}
              disabled={!canManageCourts}
            />
          ))}
        </div>
      )}

      {/* CALL ON / RECORD. Two controls, two capabilities, and the row is honest
          about which it is offering — see participant-controls.ts for why running
          the door and deciding who won are not the same key. */}
      <div className="flex flex-wrap gap-1.5">
        {/* Keyed on the court so a refusal for the old court clears once the desk picks another. */}
        {state !== 'waiting' && canManageCourts && (
          <StartStopButton key={match.court ?? ''} matchId={match.id} live={state === 'live'} />
        )}
        {state !== 'waiting' && canEnterResult && (
          <button
            type="button"
            onClick={onEnterScore}
            aria-label={`Enter the score for ${a.label} versus ${b.label}`}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-3 border border-[var(--border)] bg-[var(--bg-surface)] text-xs font-medium text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            Enter score
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * PUTTING A MATCH ON COURT.
 *
 * "this should show 'active match'" needed a writer before it could need a badge:
 * `tournament_matches.status` has admitted 'live' since 00001 and nothing in
 * either app has ever written it — see 00136 for the trace. This is that writer's
 * control, and pressing it is also what finally shows an entrant "On court now"
 * on their own phone, a label the player app has carried all along for a state
 * nothing could produce.
 *
 * Stop is a CORRECTION, not an outcome — the way out of 'live' is a result, and
 * an exec who pressed Start on the wrong row should not have to invent one.
 */
function StartStopButton({ matchId, live }: { matchId: string; live: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await setMatchLive(matchId, !live);
            if (!res.ok) { setError(res.error); return; }
            router.refresh();
          })
        }
        className={`inline-flex items-center gap-1.5 min-h-[44px] px-3 border text-xs font-semibold uppercase tracking-wide transition-colors duration-150 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
          live ? 'border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)]' : ''
        }`}
        style={live ? undefined : tint('--color-success', 14, 45)}
      >
        {pending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
        ) : live ? (
          <Square className="w-3.5 h-3.5" aria-hidden />
        ) : (
          <Play className="w-3.5 h-3.5" aria-hidden />
        )}
        {live ? 'Take off court' : 'Send on court'}
      </button>
      {error && <p className="mt-1 text-[11px] text-[var(--color-accent)]" role="alert">{error}</p>}
    </div>
  );
}

/**
 * The court, as an exec types it.
 *
 * A TEXT BOX AND NOT A PICKER while the tournament lists no courts, and 00135
 * argues it at length: a picker would be a setup step somebody has to remember
 * at 9am on a Saturday. Once the organiser lists courts (00273) the desk gets
 * CourtPicker instead. `courtLabel`
 * absorbs "Court 3" as readily as "3", so the desk does not have to be taught a
 * convention either.
 *
 * SAVES ON BLUR AS WELL AS ON SUBMIT. This is typed one-handed between calling
 * matches; requiring a deliberate second press to commit is how a court gets set
 * on the console and never reaches anybody's phone.
 *
 * A HALF-TYPED COURT SURVIVES A REPAINT, which matters more now than it did.
 * This tab repaints on every tournament write in the event — a score landing on
 * another court, somebody's phone marking them ready — and the desk may well be
 * mid-keystroke when one arrives. `value` is component state seeded once from the
 * prop, so a re-render with a new `current` leaves what is being typed alone; and
 * since the list is now ordered by the draw's own sequence, no state change can
 * reorder the row out from under the cursor either. Both halves of that are
 * needed: keeping the state but moving the node loses the focus instead.
 */
function CourtField({ matchId, current, disabled }: { matchId: string; current: string; disabled: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(current);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function commit() {
    if (value.trim() === current.trim()) return;
    setError(null);
    startTransition(async () => {
      const res = await setMatchCourt(matchId, value);
      if (!res.ok) {
        setError(res.error);
        setValue(current);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      <label className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-[var(--text-muted)] shrink-0" aria-hidden />
        <span className="sr-only">Court for this match</span>
        <input
          type="text"
          inputMode="text"
          maxLength={32}
          value={value}
          disabled={disabled || pending}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            // Escape abandons the edit rather than committing a half-typed
            // court to twenty phones.
            if (e.key === 'Escape') { setValue(current); e.currentTarget.blur(); }
          }}
          placeholder="Court — e.g. 3"
          className="flex-1 min-w-0 min-h-[44px] px-3 bg-[var(--bg-surface)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-60"
        />
        {pending && <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" aria-hidden />}
      </label>
      {error && <p className="mt-1 text-[11px] text-[var(--color-accent)]" role="alert">{error}</p>}
    </div>
  );
}

/**
 * The court, picked from the tournament's own list (00273).
 *
 * A SELECT RATHER THAN THE TEXT BOX once a tournament lists its courts: the
 * server refuses any other name, so offering a free box would only invite a
 * refusal. Courts a live match is on are marked "in use" and still offered,
 * because the list can be stale (see deskCourtSuggestion) and the database is
 * the real guard. Saves on change. "Use Court Y" is the one-tap form of the
 * same write for a callable match whose court is missing or busy.
 */
function CourtPicker({
  matchId,
  court,
  courtId,
  courts,
  allowed,
  busy,
  suggestion,
  disabled,
}: {
  matchId: string;
  court: string | null;
  courtId: string | null;
  courts: TournamentCourt[];
  /** The stage's courts, or null for any. Only these are offered. */
  allowed: TournamentCourt[] | null;
  busy: ReadonlySet<string>;
  suggestion: TournamentCourt | null;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const current = courtId
    ? courts.find((c) => c.id === courtId) ?? null
    : courts.find((c) => courtLabel(court) != null && courtKey(c.label) === courtKey(court)) ?? null;
  // A court typed before the list existed and not on it: shown, not offered.
  const stray = !current && courtLabel(court) ? court : null;
  const options = (allowed ?? courtsInOrder(courts)).filter((c) => c.active || c.id === current?.id);
  // On a court outside its stage's list (set before the list changed): shown, not offered.
  const outside = current && allowed && !allowed.some((c) => c.id === current.id) ? current : null;

  function save(label: string) {
    setError(null);
    startTransition(async () => {
      const res = await setMatchCourt(matchId, label);
      if (!res.ok) { setError(res.error); return; }
      router.refresh();
    });
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-[var(--text-muted)] shrink-0" aria-hidden />
        <label className="flex-1 min-w-0">
          <span className="sr-only">Court for this match</span>
          <select
            value={current?.id ?? (stray ? '__stray' : '')}
            disabled={disabled || pending}
            onChange={(e) => {
              const picked = courts.find((c) => c.id === e.target.value);
              save(picked?.label ?? '');
            }}
            className="w-full min-h-[44px] px-3 bg-[var(--bg-surface)] border border-[var(--border)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-60"
          >
            <option value="">No court</option>
            {stray && <option value="__stray" disabled>{courtLabel(stray)} (not on the list)</option>}
            {outside && <option value={outside.id} disabled>{courtLabel(outside.label)} (not this group's court)</option>}
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {courtLabel(c.label)}
                {!c.active ? ' (off)' : busy.has(c.id) && c.id !== current?.id ? ' (in use)' : ''}
              </option>
            ))}
          </select>
        </label>
        {pending && <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" aria-hidden />}
      </div>
      {suggestion && !disabled && (
        <button
          type="button"
          disabled={pending}
          onClick={() => save(suggestion.label)}
          className="mt-1.5 inline-flex items-center gap-1.5 min-h-[44px] px-3 border border-[var(--border)] bg-[var(--bg-surface)] text-xs font-medium text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-colors duration-150 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          Use {courtLabel(suggestion.label)}
        </button>
      )}
      {error && <p className="mt-1 text-[11px] text-[var(--color-accent)]" role="alert">{error}</p>}
    </div>
  );
}

/**
 * "She is standing right here and has not touched her phone."
 *
 * Gated on tournaments.draw.checkin.mark.write rather than a key of its own: it is
 * the same act of recording that somebody has turned up, at match granularity
 * instead of event granularity. Audited, unlike the member's own tap — see
 * lib/tournament-actions/scheduling.ts.
 *
 * IT NOW SAYS WHEN IT FAILS, which it did not. The click handler used to be
 * `if (res.ok) router.refresh()` with no else, so any refusal — a suspended
 * tournament, a finished match, or PostgREST not having reloaded its schema cache
 * after 00135 created the function — was dropped on the floor and the pill simply
 * did nothing. That is an unfalsifiable bug report waiting to happen, and 00136
 * argues it was very likely the one behind "this doesnt work".
 */
function ReadyPill({
  matchId,
  player,
  ready,
  disabled,
}: {
  matchId: string;
  player: DeskPlayer;
  ready: boolean;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={disabled || pending}
        aria-pressed={ready}
        aria-label={`${ready ? 'Clear' : 'Mark'} ${player.name} as ready`}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await setMatchReadyForPlayer(matchId, player.playerId, !ready);
            if (!res.ok) { setError(res.error); return; }
            router.refresh();
          })
        }
        className={`inline-flex items-center gap-1.5 min-h-[44px] px-3 border text-xs font-medium transition-colors duration-150 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
          ready ? '' : 'border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
        }`}
        // THE FILL THAT WAS MISSING. See `tint`: the Tailwind form of this
        // compiled to nothing, which is why a ready pill was reported as dimmed.
        style={ready ? tint('--color-success', 14, 40) : undefined}
      >
        {pending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
        ) : ready ? (
          <Check className="w-3.5 h-3.5" aria-hidden />
        ) : null}
        {player.name}
      </button>
      {error && <p className="mt-1 text-[11px] text-[var(--color-accent)] max-w-[16rem]" role="alert">{error}</p>}
    </div>
  );
}
