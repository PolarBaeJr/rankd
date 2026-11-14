'use client';

import { useEffect, useRef, useState } from 'react';
import {
  getRoundName, eventIsPlaying, computeDrawLayout, fitScale, splitPairLabel, courtLabel,
  SKIP_SLOT_LABEL, SKIP_STATUS_LABEL, groupDrawRounds, focusRoundIndex, ALL_OPEN_MAX_ROUNDS, matchResultLabel,
} from '@badminton/shared';
import type { DrawSide } from '@badminton/shared';
import { ScoreEntryDialog, type DecidedOptions } from './ScoreEntryDialog';
import { RoundLadder } from './RoundLadder';
import { Trophy, ChevronDown } from 'lucide-react';
import { getName } from './entry-name';
import { buildEntryMaps } from '@/lib/live-desk';
import type {
  TournamentEventRow,
  TournamentMatchRow,
  ParticipantWithPlayer,
  PairWithPlayers,
  GameScore,
} from '@/lib/tournament-types';

/**
 * THE CONSOLE'S HALF OF THE CONVERGING DRAW.
 *
 * Where every offset comes from is `computeDrawLayout` in @badminton/shared —
 * the same function the player app's chart is built on, so the two diagrams
 * cannot drift the way the two hand-maintained copies of this geometry did
 * (92px cards here, 100px there). This file owns the SIZES it draws at and the
 * markup; it owns no arithmetic.
 *
 * The sizes are picked from the bottom up: 88px is 44px at the 0.5 zoom floor,
 * and the whole card is the button, so the smallest tap target this tab will
 * open at is exactly the minimum.
 */
const META_H = 18;                // card meta strip (match number / court)
const SIDE_H = 23;                // one entrant's row
const FOOT_H = 24;                // card footer strip (status / action)
const CARD_H = META_H + SIDE_H * 2 + FOOT_H;   // 88
const CARD_GAP = 12;              // gap between sibling cards in the first round
const COL_W = 196;                // width of a round column
// DO NOT NARROW THIS TO CLAW BACK PANE WIDTH: while the height binds, the zoom
// is budget/h, so a narrower sheet is drawn at the SAME zoom and merely ends up
// smaller — cutting LINK_W increases the dead margin it was meant to close.
const LINK_W = 28;                // width of the connector gutter between rounds
const HEAD_H = 30;                // round heading strip above the diagram
// Heading + the explanatory sentence under the playoff card, measured for the
// sentence WRAPPING at COL_W rather than for one line: this number only feeds
// the diagram's height, and being short by a line clips the caption.
const PLAYOFF_CAPTION_H = 76;

/**
 * HOW THICK A CONNECTOR IS PAINTED, which is not how thick the engine says it
 * is. `computeDrawLayout` emits mathematical hairlines — 1 on whichever axis the
 * segment has no extent on — and a literal 1px span filled with a 14%-alpha
 * border token, then multiplied down by the zoom, was invisible on screen.
 *
 * Thickened HERE, at the paint, and not in the shared geometry: the engine's 1
 * is what bracket-layout.test.ts identifies risers by and measures its edge and
 * centre-line landings against. Each segment grows on its hairline axis and is
 * backed off by half the growth, so the line stays centred on the coordinate
 * those assertions are about.
 */
const LINK_PX = 2;

const GEOMETRY = {
  cardH: CARD_H,
  cardGap: CARD_GAP,
  colW: COL_W,
  linkW: LINK_W,
  headH: HEAD_H,
  playoffCaptionH: PLAYOFF_CAPTION_H,
};

/** Zoom stops. 1 is always reachable so "actual size" exists. */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 1;
/** Below this, a card is too small to press. Bounds the DEFAULT only. */
const ZOOM_USABLE_FLOOR = 0.5;
/**
 * The share of the window the diagram may claim before it scrolls inside its
 * own box. Used for the fit arithmetic as well as for the cap, so the scale
 * that "Fit" reports is the scale that actually fits.
 *
 * 0.88, up from 0.78, because once the diagram is taller than it is wide the
 * HEIGHT is what binds and the width pays for it. The gain is exactly the ratio
 * of the two shares, ~13%, and it is safe to compute against because `viewportH`
 * is derived from window.innerHeight (never from the box's own clientHeight,
 * which is content-driven until the cap bites) and the same constant sets the
 * maxHeight cap below — so what "Fit" reports stays what actually fits.
 *
 * WHERE IT BITES, measured on a 1080px window / 1975px pane. A 64 draw
 * (2436x1618) is the size this is for: fit 0.520 -> 0.587, so 1268px of diagram
 * becomes 1430px. A 32 (1988x818) is width-bound at 0.993 and does not move. A
 * 128 (2884x3218) does not move either, and it is worth saying why: its fit is
 * 0.262, and 0.295 is still under ZOOM_USABLE_FLOOR, so the default is the 0.5
 * floor before and after. The dead margin on a 128 is closed by centring the
 * viewport, not by this.
 *
 * The price: the diagram may now claim 88vh, so the RoundLadder and the sentence
 * above it are likelier to be scrolled off. 0.82 keeps most of the gain if that
 * turns out to be the wrong trade.
 */
const VIEWPORT_H_SHARE = 0.88;

interface Props {
  /** Decided off court and Retired in the score dialog (00329). */
  decided?: DecidedOptions;
  event: TournamentEventRow;
  matches: TournamentMatchRow[];
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
  /**
   * 'bracket' when this is the knockout half of a pool_to_bracket event, null
   * on a single_elimination event whose matches carry no phase (00107).
   */
  phase?: 'bracket' | null;
}

/**
 * Zoom controls. Its own component so the bracket body below stays readable,
 * and so the buttons keep working while the diagram is transformed — a scaled
 * button is a smaller hit target, and these must not shrink with the bracket.
 */
function ZoomBar({
  zoom, onZoom, fitBoth, fitWidth,
}: { zoom: number; onZoom: (z: number) => void; fitBoth: number; fitWidth: number }) {
  const step = (delta: number) =>
    onZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((zoom + delta) * 20) / 20)));

  // Nothing to zoom: the diagram already fits AND is being shown at full size.
  // Showing a dead control on every eight-player event is noise.
  //
  // The second half of that condition is load-bearing. Gated on the fit alone,
  // someone who zoomed out on a narrow window and then widened it past the point
  // where the draw fits lost the controls while the bracket was still scaled —
  // a shrunken diagram with no way back to 100%.
  if (fitBoth >= 1 && zoom >= 1) return null;

  const btn =
    'px-2 py-1 border border-[var(--border)] text-[11px] uppercase tracking-[0.08em] ' +
    'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ' +
    'disabled:opacity-40 disabled:hover:text-[var(--text-muted)]';

  return (
    <div className="flex items-center justify-end gap-2 mb-3">
      <button type="button" className={btn} onClick={() => step(-0.1)} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out">−</button>
      <span className="text-[11px] font-mono text-[var(--text-muted)] w-10 text-center" aria-live="polite">
        {Math.round(zoom * 100)}%
      </span>
      <button type="button" className={btn} onClick={() => step(0.1)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in">+</button>
      {/* WHOLE DRAW, not just its width, and that is the control this tab was
          missing. A converging chart is short and wide; fitting the width alone
          reports a comfortable number and still leaves the reader scrolling —
          which is what "unreadable above 32" was. "Fit width" stays for the big
          draws where the whole-draw scale is too small to read at all. */}
      <button type="button" className={btn} onClick={() => onZoom(fitBoth)}>Fit</button>
      <button type="button" className={btn} onClick={() => onZoom(fitWidth)}>Fit width</button>
      <button type="button" className={btn} onClick={() => onZoom(1)}>100%</button>
    </div>
  );
}

export function BracketTab({ event, matches, participants, pairs, isDoubles, phase = null, decided }: Props) {
  const [scoreMatch, setScoreMatch] = useState<TournamentMatchRow | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportW, setViewportW] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  // null means "the user has not touched the controls", which is what lets the
  // default track the window while a deliberate 100% survives a resize.
  const [userZoom, setUserZoom] = useState<number | null>(null);

  // Measured rather than assumed: the page is full-width on this route, so the
  // available space depends on the window, the sidebar and the scrollbar, and
  // any figure hard-coded here would be wrong on somebody's screen. The HEIGHT
  // is taken from the window rather than from the box, because the box's own
  // height is content-driven until the cap bites — measuring it would fit the
  // diagram to whatever height the diagram already had.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      setViewportW(el.clientWidth);
      setViewportH(Math.max(320, Math.round(window.innerHeight * VIEWPORT_H_SHARE)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // The third-place playoff shares round_number with the final so the two are
  // scheduled together, but it is held OUT of the tree on purpose: as a real
  // sibling of the final it is a round of two feeding a round of one — the
  // exact shape of "these two matches feed that one" — and every elbow in the
  // semi-finals would be drawn from that false premise. It is placed by the
  // layout engine instead, in the clear space under the final.
  const thirdPlace = matches.find((m) => m.is_third_place) ?? null;
  const treeMatches = matches.filter((m) => !m.is_third_place);
  // eventIsPlaying rather than `=== 'live'` (00107). It reads the same on a
  // single_elimination event; on a pool_to_bracket one it is what keeps the
  // knockout scoreable at `live` while the pool tab stays scoreable at
  // `pool_live`.
  const isLive = eventIsPlaying(event.status) || event.status === 'bracket_generated';

  const layout = computeDrawLayout(treeMatches, GEOMETRY, { thirdPlace: !!thirdPlace });

  // Names, seeds, and the candidates the slot editor may place into an orphaned
  // bracket position, built the same way the Court Management tab builds them.
  const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
  const { nameMap, seedMap, placeableEntries } = buildEntryMaps(entries, (e) => getName(e, isDoubles));

  function getEntryName(id: string | null) {
    if (!id) return 'TBD';
    return nameMap[id] ?? 'TBD';
  }

  function getSeed(id: string | null) {
    if (!id) return null;
    return seedMap[id] ?? null;
  }

  if (treeMatches.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center">
        <Trophy className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)] opacity-50" />
        <p className="text-sm text-[var(--text-muted)]">Bracket not generated yet.</p>
      </div>
    );
  }

  // The "played to" strip names each round ONCE, even though a converging draw
  // heads most of them twice — the shape is a property of the round, not of the
  // half, and two identical selects side by side would invite somebody to set
  // them differently.
  // THE HIGHEST round_number, not the COUNT of rounds. getRoundName counts back
  // from the final — `totalRounds - roundNumber + 1` — so the two arguments have
  // to be in the same numbering. Handed a count, a draw whose rounds are not
  // numbered 1..R goes negative and prints "Round of 0.0078125". Only the
  // fallback is affected, since the generator stamps round_name on every row,
  // which is exactly why it would have gone unnoticed.
  const lastRoundNumber = treeMatches.reduce((max, m) => Math.max(max, m.round_number), 0);

  const roundsInOrder: Array<{ roundNumber: number; matches: TournamentMatchRow[]; name: string }> = [];
  for (const col of layout.columns) {
    if (roundsInOrder.some((r) => r.roundNumber === col.roundNumber)) continue;
    const roundMatches = treeMatches.filter((m) => m.round_number === col.roundNumber);
    roundsInOrder.push({
      roundNumber: col.roundNumber,
      matches: roundMatches,
      name: roundMatches[0]?.round_name ?? getRoundName(col.roundNumber, lastRoundNumber),
    });
  }
  roundsInOrder.sort((a, b) => a.roundNumber - b.roundNumber);

  const fitBoth = fitScale(layout, viewportW, viewportH, ZOOM_MIN);
  const fitWidth = viewportW > 0 && layout.width > 0
    ? Math.min(1, Math.max(ZOOM_MIN, viewportW / layout.width))
    : 1;

  // THE WHOLE DRAW, BUT NEVER SMALLER THAN THE FLOOR. A 128-slot draw fitted
  // whole to this pane lands near 25%, which turns an 88px card into a 22px one
  // — the bracket is on screen and none of it can be read or pressed. So the
  // default is clamped UP to the floor rather than abandoned: at 0.5 the card is
  // exactly 44px, the minimum tap target, and the reader still sees most of the
  // chart's width instead of the left quarter of it.
  //
  // Measured on a 1192px pane: a 32-draw opens whole at 60%, a 64-draw at the
  // 50% floor showing 98% of its width, a 128-draw at 50% showing 83%. The old
  // fallback — open at 100% and scroll — put a 64-draw's reader back where the
  // complaint started, looking at a quarter of the sheet.
  const zoom = userZoom ?? Math.min(1, Math.max(fitBoth, ZOOM_USABLE_FLOOR));

  const roundNameOf = (roundNumber: number) =>
    roundsInOrder.find((r) => r.roundNumber === roundNumber)?.name
    ?? getRoundName(roundNumber, lastRoundNumber);

  // WHICH HALF, spoken. Sighted readers get the half from where the card is on
  // the sheet; a screen reader gets nothing from that, and in a converging draw
  // "Semi-Final" on its own is now ambiguous between two cards.
  const roundLabelOf = (roundNumber: number, side: DrawSide) => {
    const name = roundNameOf(roundNumber);
    return side === 'centre' ? name : `${name}, ${side === 'left' ? 'top' : 'bottom'} half`;
  };

  // THE PHONE'S DRAW: one list a round, the same fallback the player app has
  // and on the same shared rule for which round opens (draw-rounds.ts). The
  // chart below is `hidden md:block`, so its viewport measures 0 wide on a
  // phone, which fitScale and fitWidth both already read as "not measured"
  // and answer with 1 rather than dividing by it.
  const phoneRounds = groupDrawRounds(layout);
  const phoneAllOpen = phoneRounds.length <= ALL_OPEN_MAX_ROUNDS;
  const phoneFocus = focusRoundIndex(phoneRounds, (m) => m.status);

  return (
    <>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4" role="region" aria-label="Tournament bracket">
        {/* WHAT EACH ROUND IS PLAYED TO (00108), above the diagram rather than
            on the round headings themselves. The headings sit inside the CSS
            transform that zooms the bracket, so a select there would shrink with
            it — at "fit" on a 32-draw it would be a four-pixel control. Here it
            is always full size and always in one place.

            The ladder owns its own layout now: it was a wrapping flex row of one
            select per round, which repeated "Same as the event (Best of 3 to
            21)" once per round and broke mid-sequence. See RoundLadder. */}
        <RoundLadder
          event={event}
          rounds={roundsInOrder}
          thirdPlace={thirdPlace}
          phase={phase}
        />

        {/* THE DRAW READS INWARDS FROM BOTH EDGES, which is not how anybody
            expects a bracket to read until they are told once. */}
        <p className="hidden md:block mb-3 text-[11px] text-[var(--text-muted)]">
          {layout.mode === 'converging'
            ? 'The top half runs inwards from the left, the bottom half inwards from the right, and they meet at the final in the middle.'
            : 'This draw’s rounds do not halve, so it is shown as a plain left-to-right ladder.'}
        </p>
        <p className="md:hidden mb-3 text-[11px] text-[var(--text-muted)]">
          On a phone the draw is a list, one round at a time. Tap a match to score or correct it.
        </p>

        <div className="md:hidden space-y-2">
          {phoneRounds.map((r, i) => (
            <PhoneRound
              key={r.roundNumber}
              title={roundNameOf(r.roundNumber)}
              count={r.nodes.length}
              open={phoneAllOpen || i === phoneFocus}
            >
              {r.nodes.map((node) => (
                <MatchCard
                  key={node.id}
                  m={node.match}
                  // "left" for the layout only: a list row is never mirrored.
                  // The spoken label still names the node's real half.
                  side="left"
                  roundLabel={roundLabelOf(node.roundNumber, node.side)}
                  isDoubles={isDoubles}
                  isLive={isLive}
                  getEntryName={getEntryName}
                  getSeed={getSeed}
                  onEnterScore={() => setScoreMatch(node.match)}
                />
              ))}
            </PhoneRound>
          ))}
          {thirdPlace && (
            <PhoneRound
              title="3rd Place Playoff"
              count={1}
              open={phoneAllOpen || phoneFocus === phoneRounds.length - 1}
            >
              <MatchCard
                m={thirdPlace}
                side="left"
                roundLabel="3rd Place Playoff"
                isDoubles={isDoubles}
                isLive={isLive}
                getEntryName={getEntryName}
                getSeed={getSeed}
                onEnterScore={() => setScoreMatch(thirdPlace)}
              />
              <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                The two beaten semi-finalists, one from each half. The winner does not advance to the final.
              </p>
            </PhoneRound>
          )}
        </div>

        <div className="hidden md:block">
          <ZoomBar zoom={zoom} onZoom={setUserZoom} fitBoth={fitBoth} fitWidth={fitWidth} />

          {/* Two nested boxes because a CSS transform does not change layout size:
              the scaled diagram would still reserve its FULL width and height, so
              a zoomed-out bracket left a screen of blank card behind it and the
              scrollbars never shrank. The outer box scrolls, the middle box is
              sized to the SCALED dimensions, and only the inner one is
              transformed.

              The height cap is unconditional and costs a short draw nothing: a
              max-height only bites once the content exceeds it, so an eight-player
              bracket still flows with the page and grows no inner scrollbar. */}
          <div
            ref={viewportRef}
            className="bracket-viewport overflow-auto"
            style={{ maxHeight: `${Math.round(VIEWPORT_H_SHARE * 100)}vh` }}
          >
            <div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
              <div
                className="relative"
                style={{
                  width: layout.width,
                  height: layout.height,
                  transform: `scale(${zoom})`,
                  transformOrigin: 'top left',
                }}
              >
                {/* Round headings. One per column, so a converging draw names
                    each round over both of its halves. */}
                {layout.columns.map((col) => (
                  <div
                    key={col.key}
                    className="absolute flex items-center justify-center"
                    style={{ left: col.x, top: 0, width: COL_W, height: HEAD_H }}
                  >
                    <h3
                      className={`text-[11px] font-bold uppercase tracking-[0.12em] ${
                        col.side === 'centre' ? 'text-[var(--color-warning)]' : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {roundsInOrder.find((r) => r.roundNumber === col.roundNumber)?.name
                        ?? getRoundName(col.roundNumber, lastRoundNumber)}
                    </h3>
                  </div>
                ))}

                {/* The connector work, as flat boxes the engine positioned. */}
                <div className="absolute inset-x-0" style={{ top: HEAD_H, height: layout.bodyH }} aria-hidden="true">
                  {/* The two axes grow independently, not as an either/or: a
                      stub or an entry is a hairline in h with a real w, a riser
                      the other way round, and nothing guarantees a segment can
                      only ever be one of the two. See LINK_PX. */}
                  {layout.connectors.map((c) => (
                    <span
                      key={c.key}
                      className="absolute bg-[var(--draw-link)]"
                      style={{
                        left: c.w === 1 ? c.x - (LINK_PX - 1) / 2 : c.x,
                        top: c.h === 1 ? c.y - (LINK_PX - 1) / 2 : c.y,
                        width: c.w === 1 ? LINK_PX : c.w,
                        height: c.h === 1 ? LINK_PX : c.h,
                      }}
                    />
                  ))}
                </div>

                <div className="absolute inset-x-0" style={{ top: HEAD_H, height: layout.bodyH }}>
                  {layout.nodes.map((node) => (
                    <div
                      key={node.id}
                      className="absolute"
                      style={{ left: node.x, top: node.y, width: COL_W }}
                    >
                      <MatchCard
                        m={node.match}
                        side={node.side}
                        roundLabel={roundLabelOf(node.roundNumber, node.side)}
                        isDoubles={isDoubles}
                        isLive={isLive}
                        getEntryName={getEntryName}
                        getSeed={getSeed}
                        onEnterScore={() => setScoreMatch(node.match)}
                      />
                    </div>
                  ))}

                  {/* THE 3RD PLACE PLAYOFF, in the clear space under the final.
                      The centre column carries one card, so a converging draw has
                      a whole column of room exactly where the reader is already
                      looking — and it is the other match that ends somebody's
                      tournament, decided on the same day.

                      NO LINE TOUCHES IT, and that is a change from the linear
                      draw, which reached a dashed elbow back to the semi-finals.
                      In a converging draw the two beaten semi-finalists are on
                      OPPOSITE sides of the final, so there is no single path back
                      to draw and any line long enough to reach one of them has to
                      cross the final — which would say something about the final.
                      The caption does the work instead, and now has to, since a
                      reader can no longer infer "leads nowhere" from a line that
                      is not there. */}
                  {thirdPlace && layout.thirdPlace && (
                    <div
                      className="absolute"
                      style={{ left: layout.thirdPlace.x, top: layout.thirdPlace.y, width: COL_W }}
                    >
                      <MatchCard
                        m={thirdPlace}
                        side="centre"
                        roundLabel="3rd Place Playoff"
                        isDoubles={isDoubles}
                        isLive={isLive}
                        getEntryName={getEntryName}
                        getSeed={getSeed}
                        onEnterScore={() => setScoreMatch(thirdPlace)}
                      />
                      <h3 className="mt-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                        3rd Place Playoff
                      </h3>
                      <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                        The two beaten semi-finalists, one from each half. Decides 3rd and 4th — the
                        winner does not advance to the final.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
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

/**
 * ONE COLLAPSIBLE ROUND of the phone list, as a native <details>, for the
 * reasons the player app's RoundDisclosure gives: the keyboard behaviour, the
 * expanded state and find-in-page come with it. `open` is re-applied when the
 * prop changes, so the open round follows play as results land.
 */
function PhoneRound({
  title, count, open, children,
}: {
  title: string;
  count: number;
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} className="group rounded-md border border-[var(--border)] overflow-hidden">
      <summary className="flex items-center justify-between gap-2 px-3 min-h-[44px] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--text-muted)]">{title}</span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-[var(--text-muted)]">
            {count} {count === 1 ? 'match' : 'matches'}
          </span>
          <ChevronDown aria-hidden className="w-3.5 h-3.5 text-[var(--text-muted)] transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="space-y-2 px-3 pb-3 pt-1">{children}</div>
    </details>
  );
}

interface CardProps {
  m: TournamentMatchRow;
  side: DrawSide;
  roundLabel: string;
  isDoubles: boolean;
  isLive: boolean;
  getEntryName: (id: string | null) => string;
  getSeed: (id: string | null) => number | null;
  onEnterScore: () => void;
}

function MatchCard({ m, side, roundLabel, isDoubles, isLive, getEntryName, getSeed, onEnterScore }: CardProps) {
  const aId = isDoubles ? m.pair_a_id : m.participant_a_id;
  const bId = isDoubles ? m.pair_b_id : m.participant_b_id;
  const winnerId = isDoubles ? m.winner_pair_id : m.winner_participant_id;
  const isCompleted = m.status === 'completed' || m.status === 'walkover';
  const isSkip = m.is_bye;
  const isReady = m.status === 'ready' && aId && bId;
  const canEnterScore =
    isLive && (isReady || m.status === 'live' || m.status === 'pending') && aId && bId && !isCompleted && !isSkip;
  // A voided match, or one missing a side, used to render with NO action at all
  // — which is exactly how a bracket got stuck on TBD forever. Both now open the
  // dialog, on its restore or slot-editing panel.
  const isVoided = m.status === 'voided';
  const canRecover = isLive && !isCompleted && !isSkip && !canEnterScore;
  // ...and a match that already HAS a result used to render with no action
  // either, which is what made editMatchResult unreachable: the only way to fix
  // a wrong scoreline was to void it, restore it and type it again. A decided
  // match now opens the dialog on its correction panel.
  //
  // A skip is excluded. It is "completed" with a winner the generator placed
  // there, and it has no scoreline to correct — the slot editor on the next
  // round is the tool for a wrong bye.
  //
  // Not gated on isLive: an event flips to 'completed' the moment it is
  // finalised, and finalising is when a wrong result gets noticed. The server
  // allows a correction on a live OR completed event, so gating the button on
  // isLive would hide the affordance exactly where it is wanted.
  const canChangeResult = isCompleted && !isSkip;

  // THE WHOLE CARD IS THE BUTTON, where it used to be the 26px footer strip.
  // All four of those states already opened the same dialog, so the split
  // bought nothing and cost the tab its tap target: 26px was under the 44px
  // minimum at 100%, never mind at the scale a 32-draw opens at. An 88px card
  // is still 44px at the 0.5 zoom floor, which is why 88 is the number.
  const actionable = !!(canEnterScore || canRecover || canChangeResult);
  const actionLabel =
    canEnterScore ? 'Enter Score'
    : canRecover ? (isVoided ? 'Restore Match' : 'Fix Slots')
    : null;

  const scores = m.scores as GameScore[] | null;
  // Either side can be the empty one — the generator gives the skip to whichever
  // slot the seed landed in, not always slot B.
  const sideLabel = (id: string | null) => (isSkip && !id ? SKIP_SLOT_LABEL : getEntryName(id));
  // NO WINNER IS ANNOUNCED ON A SKIP. It is 'completed' with a winner the
  // generator put there, so this clause was telling a screen reader that
  // somebody won a match nobody played.
  // *** THE SCORELINE IS ON THE FOOTER STRIP, NOT ON THE ENTRANT ROWS, AND THAT
  // REVERSES THE CALL THIS CARD WAS BUILT ON. ***
  //
  // It used to print one side's digits per row — "21 15 21" over "19 21 18" —
  // and the note here defended that as "how a printed draw sheet has always
  // shown it". The defence was true and beside the point: a printed draw sheet
  // is not 196px wide. Those eight mono characters cost the row 53px plus its
  // gap, which left the name field 97.2px, and a stacked doubles partner —
  // "Bartholomew Fairweather" at 112.1px — did not fit in it. The comment on
  // `Side` recorded that as a residue and named the price of closing it: moving
  // the score off the entrant rows. This is that move.
  //
  // WHAT IT COSTS: the reader no longer sees at a glance which side took which
  // game from the digits' own alignment. That is a smaller loss than it sounds —
  // the games are printed as pairs in A's reading order, the winner's row already
  // carries the success wash and the inset bar, and the loser's name is struck
  // through — and it is the same trade the player app's chart card made, for the
  // same reason and at a wider column than this one.
  //
  // SPACE-SEPARATED PAIRS rather than the player card's ", ": 17 mono characters
  // instead of 19, on a strip that also has to carry a status word.
  // Decided off court or by retirement (00329) reads as what it was.
  const scoreLine = m.result_kind
    ? matchResultLabel(m)
    : scores?.length ? scores.map((g) => `${g.a}–${g.b}`).join(' ') : null;

  // THE SCORE IS IN HERE BECAUSE THE STRIP CANNOT ALWAYS SHOW IT. The note on
  // the scoreline below has always said the full thing was "spelled out in the
  // card's aria-label" and justified clipping digits on that basis -- but it was
  // not: this label carried the round, the entrants, the winner and the action,
  // and never the digits. So a best-of-5 lost the tail of its score from the
  // strip and there was nowhere else to read it, for anybody. Now the strip
  // clips and the accessible name is complete, which is what the trade-off was
  // always claimed to be.
  const label = `${roundLabel}. Match ${m.match_number ?? ''}: ${sideLabel(aId)} vs ${sideLabel(bId)}${
    isCompleted && !isSkip ? `, winner: ${getEntryName(winnerId)}` : ''
  }${scoreLine ? `. Score: ${scoreLine}` : ''}${actionable ? `. ${actionLabel ?? 'Change the recorded result'}` : ''}`;

  const body = (
    <>
      <div
        className={`flex items-center justify-between px-2 text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-elevated)] border-b border-[var(--border)] shrink-0 ${
          side === 'right' ? 'flex-row-reverse' : ''
        }`}
        style={{ height: META_H }}
      >
        <span>{m.match_number ? `M${m.match_number}` : ''}</span>
        {/* courtLabel rather than `Court ${m.court}`: the desk types this free
            hand and half of them type "Court 3", which the old template turned
            into "Court Court 3" in a 196px-wide card. Still BLANK when unset —
            unlike the player's own match row, which says "Court TBC", because
            here the reader is the person who would be assigning it and an
            18px meta strip at 0.68 scale is the wrong place for a prompt. The
            Desk tab is where the uncourted matches are listed. */}
        <span>{courtLabel(m.court) ?? ''}</span>
      </div>

      <Side
        name={isSkip && !aId ? SKIP_SLOT_LABEL : getEntryName(aId)}
        seed={getSeed(aId)}
        isPlaceholder={!aId}
        // A BYE IS NOT A WIN, and the guard is needed because the DATA says it
        // is: the generator completes a skip with the real entrant already in
        // winner_*_id. Without !isSkip the entrant who merely walked into the
        // next round got the success colour, the bold weight and an sr-only
        // "(Winner)" for a match nobody played. Same position the rest of the
        // codebase takes — tournament-withdrawal.test.ts:133 has
        // isPlayedMatch({ status: 'completed', is_bye: true }) === false.
        won={isCompleted && !isSkip && winnerId === aId}
        // An empty slot has no result to strike through — a skip match is
        // "completed" with a winner, so without the id guard SKIP renders struck.
        lost={isCompleted && !!winnerId && !!aId && winnerId !== aId}
        mirrored={side === 'right'}
      />
      <div className="border-t border-[var(--border)]" />
      <Side
        name={isSkip && !bId ? SKIP_SLOT_LABEL : getEntryName(bId)}
        seed={getSeed(bId)}
        isPlaceholder={!bId}
        won={isCompleted && !isSkip && winnerId === bId}
        lost={isCompleted && !!winnerId && !!bId && winnerId !== bId}
        mirrored={side === 'right'}
      />

      <div
        className={`shrink-0 border-t border-[var(--border)] flex items-center justify-center gap-2 bg-[var(--bg-elevated)] ${
          canEnterScore ? 'text-[var(--color-accent)]' : canRecover ? 'text-[var(--color-warning)]' : ''
        }`}
        style={{ height: FOOT_H }}
      >
        {/* THE SCORELINE FIRST, and it is the only thing here allowed to
            truncate. `games_per_match` is legal up to 7 (00031), so something has
            to give on a long match whatever this does, and the scoreline is the
            part whose full text is one press away in the score dialog and already
            spelled out in the card's aria-label (it is now -- see `label`
            above; it was not when this note was first written). Everything beside it is
            `shrink-0`, so the strip degrades by clipping digits off the right
            rather than by pushing the status or the action out of the card.
            MEASURED in headless Chrome, against the 194px the strip has inside
            the card's borders. A completed best-of-3 — what every event in the
            club is set to — needs 147px, a live match with one game 100px, a skip
            107px, a pending card 62px. What does NOT fit, and clips: a best-of-5
            (219px), and a walkover or voided result that also carries three games
            (222px and 202px), where the status word and "· Change" are both on the
            strip as well. Those keep their words and lose digits, which is the
            right way round — the words are what the digits cannot say. */}
        {scoreLine && (
          // `title` because `truncate` is a visual crop and nothing else: the
          // digits it removes are a result, not decoration. Hover recovers them
          // for a mouse, the aria-label for a reader.
          <span title={scoreLine} className="min-w-0 truncate font-mono text-[10px] text-[var(--text-secondary)]">
            {scoreLine}
          </span>
        )}
        {actionLabel ? (
          <span className="shrink-0 text-xs font-medium">{actionLabel}</span>
        ) : (
          <>
            {/* THE STATUS WORD IS SUPPRESSED FOR EXACTLY ONE STATUS, and only
                when the scoreline is there to say it instead. A completed match's
                word is "Final", and a scoreline beside a winner in the success
                colour is that word said better — printing both would spend a
                third of a 180px strip agreeing with itself. Every other status is
                something the digits do NOT say: a walkover, a voided result, a
                skip, a match still pending. Those keep their word.
                "Change" survives because it is an affordance and not a report:
                editMatchResult is reachable only by pressing this card, and a
                decided match with nothing on it saying so is how the whole
                correction path went unfound before. */}
            {!(scoreLine && m.status === 'completed') && (
              <span className="shrink-0"><StatusLabel status={m.status} isSkip={!!isSkip} /></span>
            )}
            {canChangeResult && <span className="shrink-0 text-[10px] text-[var(--text-muted)]">· Change</span>}
          </>
        )}
      </div>
    </>
  );

  const shell =
    `w-full flex flex-col border overflow-hidden transition-colors text-left ${
      isReady && isLive
        ? 'border-[color-mix(in_srgb,var(--color-accent)_50%,transparent)] shadow-[0_0_0_1px_rgba(204,0,0,0.18)]'
        : isSkip
        ? 'border-dashed border-[var(--border)] opacity-60'
        : 'border-[var(--border)]'
    }`;

  if (!actionable) {
    return (
      <div role="group" aria-label={label} style={{ height: CARD_H }} className={shell}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onEnterScore}
      aria-label={label}
      style={{ height: CARD_H }}
      className={`${shell} hover:border-[var(--border-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]`}
    >
      {body}
    </button>
  );
}

function Side({
  name,
  seed,
  isPlaceholder,
  won,
  lost,
  mirrored,
}: {
  name: string;
  seed: number | null;
  isPlaceholder: boolean;
  won: boolean;
  lost: boolean;
  /**
   * The bottom half of a converging draw runs right to left, so its cards are
   * mirrored: the seed sits on the OUTSIDE edge and the name reads inwards,
   * towards the final. Without this the two halves read as one long chart with a
   * gap in it rather than as two pointing at each other.
   */
  mirrored: boolean;
}) {
  return (
    <div
      className={`flex-1 min-h-0 flex items-center gap-1.5 px-2 text-[13px] ${
        mirrored ? 'flex-row-reverse text-right' : ''
      } ${
        // Inset bar rather than a real border so the winner's name stays on the
        // same baseline as the loser's. The wash is spelled out as color-mix
        // because Tailwind 3 silently drops `/10` on an arbitrary var() colour.
        won
          ? mirrored
            ? 'bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] shadow-[inset_-2px_0_0_var(--color-success)]'
            : 'bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] shadow-[inset_2px_0_0_var(--color-success)]'
          : 'bg-[var(--bg-card)]'
      }`}
    >
      <span className={`w-4 shrink-0 font-mono text-[10px] text-[var(--text-muted)] ${mirrored ? 'text-left' : 'text-right'}`}>
        {seed ? seed : ''}
      </span>
      {/* A DOUBLES PAIR IS TWO LINES, one partner each, AND THE LONGEST OF THEM
          NOW FITS.
          MEASURED against the compiled CSS with the real Barlow files. A pair
          label is two whole names joined — "Jonathan Smithson / Katarzyna
          Kowalski" is 228.5px at 13px — so unstacked it printed about eight
          characters of thirty-eight and named neither of them. Stacking fixed
          most of that and left a residue this note used to record: the field was
          97.2px once a best-of-3's digits were on the row, and "Bartholomew
          Fairweather" is 112.1px at 10px, so the longest partner name still
          ellipsized.
          THE DIGITS HAVE GONE TO THE FOOTER, which is what that residue was
          waiting for — see the note on `scoreLine`. The field is now the 196px
          column less its 1px borders, 16px of padding, the 16px seed gutter and
          6px of gap: 156px, on EVERY card rather than only on the unplayed ones.
          Re-measured in headless Chrome at that field: 112.1px, and 114.0px on
          the winner's row, where `font-semibold` costs it another two pixels.
          Neither truncates, so the longest name in the sample fits with 42px over.
          STILL 10px, NOT 11, and this is the measurement that settles it: the two
          entrant rows are `flex-1` inside an 88px card and come out 21.5px, while
          two 10px lines at leading-[1.05] measure 21.0px. Two 11px lines would be
          23.1px — the overflow-hidden shave this card has already been bitten by
          once. The width is the win here; the type size is not on offer without
          moving CARD_H, and CARD_H is what makes the whole card a 44px tap target
          at the 0.5 zoom floor.
          A singles name, or a pair with a name of its own, is one line at 13px
          exactly as before. `title` carries the full label for a mouse; the
          card's aria-label already carries it for a reader. */}
      <span
        className={`flex-1 min-w-0 flex flex-col justify-center ${
          won
            ? 'text-[var(--color-success)] font-semibold'
            : lost
            ? 'text-[var(--text-muted)] line-through'
            : isPlaceholder
            ? 'text-[var(--text-muted)] italic'
            : 'text-[var(--text-secondary)]'
        }`}
        title={name}
      >
        {(() => {
          const lines = splitPairLabel(name);
          return lines.length === 1
            ? <span className="truncate">{name}</span>
            : lines.map((line, i) => (
                // leading-[1.05], not [1.1]: the entrant row is 23px and two
                // 10px lines at 1.1 come to 22px of text in a 21.5px box, which
                // the card's overflow-hidden was shaving.
                <span key={i} className="truncate text-[10px] leading-[1.05]">{line}</span>
              ));
        })()}
      </span>
      {won && <span className="sr-only">(Winner)</span>}
    </div>
  );
}

function StatusLabel({ status, isSkip }: { status: string; isSkip: boolean }) {
  if (status === 'walkover') {
    return <span className="text-[10px] font-medium text-[var(--color-warning)]" role="status">⚠ WALKOVER</span>;
  }
  if (status === 'voided') {
    return <span className="text-[10px] font-medium text-[var(--color-danger)]" role="status">✕ VOIDED</span>;
  }
  if (isSkip) {
    return <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">{SKIP_STATUS_LABEL}</span>;
  }
  if (status === 'completed') {
    return <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-success)]">Final</span>;
  }
  if (status === 'live') {
    return <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-accent)]" role="status">In progress</span>;
  }
  if (status === 'ready') {
    return <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">Ready</span>;
  }
  return <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Pending</span>;
}
