'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Select, Input, Textarea, DatePicker, Button, PlayerPicker } from '@badminton/ui';
import { previewEloChange, getEventMultiplier, isLegalCustomPoints, customFormatHint } from '@badminton/shared';
import type { RatingSettings } from '@badminton/shared';
import { createChallenge } from '@/lib/actions';
import { findPrediction, type MatchupPrediction as Prediction } from '@/lib/prediction-match';
import { MatchupPrediction } from '@/components/matchup-prediction';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
import { motion } from 'framer-motion';
import {
  Swords,
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  Send,
  Loader2,
  Zap,
  Info,
  Calendar,
} from 'lucide-react';
import Link from 'next/link';

interface PlayerOption {
  id: string;
  full_name: string;
  handle: string | null;
  avatar_url?: string | null;
  // Null for a member who has set hide_from_leaderboard — see
  // lib/challengeable-opponents.ts. Nullable here rather than defaulted so the
  // two places that read it have to say what they do about it, instead of
  // silently printing a stand-in number for a rating that was withheld.
  singles_elo: number | null;
  doubles_elo: number | null;
}

export default function NewChallengeClient({
  initialOpponentId,
  ratingSettings,
  opponents,
  myId,
  predictions,
}: {
  initialOpponentId?: string;
  /**
   * platform_settings.rating_defaults, read by the server wrapper. Optional so
   * an un-updated caller still type-checks; null when the read failed, which
   * previewEloChange treats as "no overrides configured".
   */
  ratingSettings?: RatingSettings | null;
  /**
   * THE CHALLENGEABLE MEMBERS, resolved by the server wrapper and NOT by this
   * component. The list used to be built here, and it could not filter
   * `is_banned` because `authenticated` has no SELECT grant on that column —
   * so banned members were offered as opponents. See
   * lib/challengeable-opponents.ts. Optional so an un-updated caller still
   * type-checks; the picker is simply empty without it, which is what the old
   * browser-side read also produced when it failed.
   */
  opponents?: PlayerOption[];
  /** The viewer's player id, for matching a prediction to the picked sides. */
  myId?: string;
  /**
   * Every Data API prediction naming the viewer, read by the server wrapper,
   * already filtered by the predictions switch. Empty when it is off.
   */
  predictions?: Prediction[];
}) {
  const [type, setType] = useState<'singles' | 'doubles'>('singles');
  const [rated, setRated] = useState(true);
  // Custom shape: "best of X games to Y points". Held as text so the fields can
  // be cleared while typing; only sent when the Custom option is chosen.
  const [customGames, setCustomGames] = useState('3');
  const [customPoints, setCustomPoints] = useState('21');
  // Every challenge now carries an explicit shape, so the enum is only the
  // fallback the DB coalesces to when the custom columns are null.
  const isCustom = true;
  const format = Number(customGames) > 1 ? 'bo3_21' : 'single_21';
  // Checked here as well as by the CHECK constraint, so the form never submits
  // a shape the database will refuse.
  const pointsInvalid = isCustom && !isLegalCustomPoints(Number(customPoints));
  const [opponentId, setOpponentId] = useState(initialOpponentId ?? '');
  const [partnerId, setPartnerId] = useState('');
  const [opponentPartnerId, setOpponentPartnerId] = useState('');
  const [note, setNote] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [loading, setLoading] = useState(false);
  // NOT state any more. The list is resolved once per request by the server
  // wrapper and never changes while the form is open, so holding it in useState
  // would only add a way for it to go stale. useMemo keeps the array identity
  // stable for the pickers below.
  const players = useMemo<PlayerOption[]>(() => opponents ?? [], [opponents]);
  const [myElo, setMyElo] = useState({ singles: 400, doubles: 400 });
  // WHICH K-FACTOR THIS VIEWER IS ON, which is the other half of getting the
  // preview right. apply_match_result picks between the provisional and the
  // established K on `singles_provisional OR singles_matches_played <
  // provisional_threshold` (00127), read off the rater's OWN ratings row. The
  // form used to hardcode `provisional: true`, so an established member was
  // shown the placement K — on production, 64 where the ladder would apply 36.
  //
  // Opens provisional, matching the pre-fix behaviour, so the brief window
  // before the row loads cannot show an established member a bigger number than
  // they will get. In practice the preview needs an opponent, and the opponent
  // list arrives from the same load().
  const [myPlacement, setMyPlacement] = useState({
    singlesProvisional: true,
    doublesProvisional: true,
    singlesMatches: 0,
    doublesMatches: 0,
  });
  const [myName, setMyName] = useState('');
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // The placement columns come from the same embedded ratings row as the
      // Elo. `ratings` is selectable whole by any authenticated member
      // (ratings_select, 00005_rls.sql) with no column-level grants, so widening
      // this select cannot hit the 403-renders-as-empty-data failure.
      const { data: me } = await supabase
        .from('players')
        .select(
          'id, full_name, ratings(singles_elo, doubles_elo, singles_provisional, doubles_provisional, singles_matches_played, doubles_matches_played)'
        )
        .eq('user_id', user.id)
        .single();

      if (me) {
        const r = Array.isArray(me.ratings) ? me.ratings[0] : me.ratings;
        setMyElo({ singles: r?.singles_elo ?? 400, doubles: r?.doubles_elo ?? 400 });
        setMyPlacement({
          // `?? true` and `?? 0` are the pessimistic readings of a missing
          // value: both say "still in placement", which is the K the old code
          // always assumed and never overstates the delta.
          singlesProvisional: r?.singles_provisional ?? true,
          doublesProvisional: r?.doubles_provisional ?? true,
          singlesMatches: r?.singles_matches_played ?? 0,
          doublesMatches: r?.doubles_matches_played ?? 0,
        });
        setMyName(me.full_name ?? '');
      }

      // The opponent list is NOT read here any more. It arrives as a prop from
      // the server wrapper, which is the only place `is_banned` is readable —
      // see the `opponents` prop above and lib/challengeable-opponents.ts. What
      // stays in the browser is this viewer's own ratings row, which
      // ratings_select grants outright.
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ?opponent= (the profile QR target) can name someone who is no longer
  // challengeable — banned, deactivated, suspended, pending_approval — or the
  // scanner themselves. listChallengeableOpponents excludes all of those, so
  // absence from the list means the prefill is stale: clear it rather than
  // leave the form looking armed. UX only; validate_challenge_creation remains
  // the authority on whether the challenge is allowed.
  //
  // Its own effect now, because the list no longer arrives inside `load` — it
  // is a prop and is already there on the first render. Empty deps: this is a
  // one-shot judgement about the value the page was opened with, and re-running
  // it after the member deliberately picks somebody would be wrong.
  useEffect(() => {
    if (initialOpponentId && !players.some((p) => p.id === initialOpponentId)) {
      setOpponentId('');
      toast("That player can't be challenged right now.", 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const opponent = players.find((p) => p.id === opponentId);
  const prediction =
    myId && predictions && predictions.length > 0
      ? findPrediction(
          predictions,
          type,
          type === 'singles' ? [myId] : [myId, partnerId],
          type === 'singles' ? [opponentId] : [opponentId, opponentPartnerId],
        )
      : null;

  // Their rating, or nothing at all. previewEloChange is a pure function of the
  // two Elos, so leaving a fallback here would have let anyone recover a hidden
  // rating by reading the predicted delta — the control would have survived on
  // the screen and not in fact.
  const opponentElo = opponent
    ? (type === 'singles' ? opponent.singles_elo : opponent.doubles_elo)
    : null;
  const eloPreview = opponent && opponentElo !== null ? previewEloChange(
    type === 'singles' ? myElo.singles : myElo.doubles,
    opponentElo,
    (isCustom ? (Number(customGames) > 1 ? 'bo3_21' : 'single_21') : format) as 'single_21' | 'bo3_21' | 'single_15' | 'single_11',
    // The event multiplier, resolved HERE rather than inside the preview. A
    // challenge is the one case where the enum table is the right answer:
    // create_match_from_challenge stamps event_multiplier =
    // get_event_multiplier(event_type) (00003), which is EVENT_MULTIPLIERS entry
    // for entry — 1.00 rated, 0.00 casual. A tournament match is NOT this case,
    // which is why the preview no longer takes an enum at all.
    getEventMultiplier(rated ? 'rated_challenge' : 'casual'),
    type,
    // The viewer's own placement state and match count, not a hardcoded `true`
    // and a dropped count — the two arguments getKFactor combines with
    // provisional_threshold to reproduce apply_match_result's CASE.
    type === 'singles' ? myPlacement.singlesProvisional : myPlacement.doublesProvisional,
    undefined,
    type === 'singles' ? myPlacement.singlesMatches : myPlacement.doublesMatches,
    isCustom
      ? { gamesPerMatch: Number(customGames) || 3, pointsPerGame: Number(customPoints) || 21 }
      : undefined,
    ratingSettings,
  ) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!opponentId) { toast('Select an opponent', 'error'); return; }
    if (pointsInvalid) { toast(customFormatHint(Number(customGames), Number(customPoints)), 'error'); return; }
    setLoading(true);
    try {
      const res = await createChallenge({
        type,
        rated_flag: rated,
        event_type: rated ? 'rated_challenge' : 'casual',
        // The enum stays the fallback the DB coalesces to; the custom columns
        // win when present (migration 00031).
        format: (isCustom
          ? (Number(customGames) > 1 ? 'bo3_21' : 'single_21')
          : format) as 'single_21' | 'bo3_21' | 'single_15' | 'single_11',
        ...(isCustom
          ? { games_per_match: Number(customGames) || 3, points_per_game: Number(customPoints) || 21 }
          : {}),
        opponent_id: opponentId,
        partner_id: type === 'doubles' && partnerId ? partnerId : undefined,
        opponent_partner_id: type === 'doubles' && opponentPartnerId ? opponentPartnerId : undefined,
        note: note || undefined,
        scheduled_date: scheduledDate || undefined,
        scheduled_time: scheduledTime || undefined,
      });
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast('Challenge sent!', 'success');
      router.push('/challenges');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create challenge', 'error');
    }
    setLoading(false);
  }

  // Rating is pinned to the END of the row, not glued into the name and not a
  // subtitle under it. In the name it made the search match "(1423)" as though
  // it were part of someone's name; under the name it read as a caption rather
  // than the stat it is.
  const playerOptions = players.map((p) => ({
    id: p.id,
    name: p.full_name,
    handle: p.handle,
    avatarUrl: p.avatar_url ?? null,
    // Absent, not zero and not a dash-with-a-number-behind-it: a member who
    // has opted out of the leaderboard simply has no figure on this row.
    trailing: (type === 'singles' ? p.singles_elo : p.doubles_elo) === null
      ? undefined
      : String(type === 'singles' ? p.singles_elo : p.doubles_elo),
  }));

  // Nobody can fill two slots on the court. Each select drops whoever is
  // already chosen elsewhere, while keeping its own current value so the field
  // still shows what it is set to. This has to be symmetric now that the fields
  // are grouped by side: the old one-directional filters only worked because
  // Opponent was always picked first.
  const availableFor = (current: string) =>
    playerOptions.filter(
      (p) => p.id === current || ![opponentId, partnerId, opponentPartnerId].includes(p.id),
    );

  return (
    <div className="max-w-lg mx-auto space-y-5 pb-28 px-4 sm:px-0">
      {/* Back link */}
      <Link
        href="/challenges"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors duration-150 group min-h-[44px] py-2"
      >
        <ArrowLeft className="w-4 h-4 transition-transform duration-150 group-hover:-translate-x-0.5" />
        Back to Challenges
      </Link>

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Page header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-11 h-11 rounded-xl bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)] flex items-center justify-center glow-red shrink-0">
            <Swords className="w-5 h-5 text-[var(--color-accent)]" />
          </div>
          <div>
            <p className="eyebrow">Create</p>
            <h1 className="display-lg">New Challenge</h1>
          </div>
        </div>

        <div className="card-elevated rounded-xl p-5 bg-court-lines">
          <form onSubmit={handleSubmit} className="space-y-5">

            {/* Match Type Toggle */}
            <div>
              <label className="eyebrow block mb-2">Match Type</label>
              <div className="flex gap-2">
                {(['singles', 'doubles'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={`flex-1 min-h-[44px] py-2.5 rounded-xl text-sm font-bold capitalize transition-all duration-200 press border ${
                      type === t
                        ? 'bg-[color-mix(in_oklab,var(--color-accent)_15%,transparent)] border-[color-mix(in_oklab,var(--color-accent)_30%,transparent)] text-[var(--color-accent)] glow-red'
                        : 'bg-white/[0.03] border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border-hover)]'
                    }`}
                  >
                    {t === 'singles' ? (
                      <span className="flex items-center justify-center gap-1.5">
                        <Swords className="w-3.5 h-3.5" /> Singles
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-1.5">
                        <Swords className="w-3.5 h-3.5" /> Doubles
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Grouped by side. Listing Opponent between "Your Partner" and
                "Opponent's Partner" interleaved the two halves, so the form read
                as three unrelated people instead of two pairs. Your side first,
                since that is the half the player already knows. */}
            {type === 'doubles' ? (
              <>
                <div className="space-y-3">
                  <label className="eyebrow block">Your Side</label>
                  {/* Static, not a disabled <Select> — you are never a choice,
                      and a greyed-out dropdown reads as "not available yet". */}
                  <div>
                    <label className="eyebrow block mb-2">You</label>
                    <div className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-white/[0.03] px-3 min-h-[44px] text-sm text-[var(--text-secondary)]">
                      <span>{myName || 'You'}</span>
                      <span className="mono text-xs text-[var(--text-muted)]">{myElo.doubles}</span>
                    </div>
                  </div>
                  <PlayerPicker
                    label="Partner"
                    value={partnerId}
                    onChange={setPartnerId}
                    players={availableFor(partnerId)}
                    placeholder="Search for a partner…"
                  />
                </div>

                <div className="space-y-3">
                  <label className="eyebrow block">Opponents</label>
                  <PlayerPicker
                    label="Opponent"
                    value={opponentId}
                    onChange={setOpponentId}
                    players={availableFor(opponentId)}
                    placeholder="Search for an opponent…"
                  />
                  <PlayerPicker
                    label="Their Partner"
                    value={opponentPartnerId}
                    onChange={setOpponentPartnerId}
                    players={availableFor(opponentPartnerId)}
                    placeholder="Search…"
                  />
                </div>
              </>
            ) : (
              <PlayerPicker
                label="Opponent"
                value={opponentId}
                onChange={setOpponentId}
                players={availableFor(opponentId)}
                placeholder="Search for an opponent…"
              />
            )}

            {/* The four presets were just (games, points) pairs — "Best of 3 to
                21" is 3 and 21 — so the dropdown only added a step. Pick the two
                numbers directly; the defaults are the old bo3_21. */}
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Best of (games)"
                  value={customGames}
                  onChange={(e) => setCustomGames(e.target.value)}
                  options={[
                    { value: '1', label: '1 game' },
                    { value: '3', label: 'Best of 3' },
                    { value: '5', label: 'Best of 5' },
                    { value: '7', label: 'Best of 7' },
                  ]}
                />
                <Input
                  label="Points per game"
                  type="text"
                  inputMode="numeric"
                  value={customPoints}
                  onChange={(e) => setCustomPoints(e.target.value.replace(/\D/g, '').slice(0, 2))}
                  placeholder="21"
                />
                <p className="col-span-2 text-xs text-[var(--mute)]">
                  {customFormatHint(Number(customGames), Number(customPoints))}
                </p>
            </div>

            {/* Rated Toggle */}
            <div>
              <label className="eyebrow block mb-2">Rating Impact</label>
              <button
                type="button"
                onClick={() => setRated(!rated)}
                className={`w-full min-h-[44px] py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all duration-200 press border ${
                  rated
                    ? 'bg-[color-mix(in_oklab,var(--color-gold)_10%,transparent)] border-[color-mix(in_oklab,var(--color-gold)_25%,transparent)] text-[var(--color-gold)] glow-gold'
                    : 'bg-white/[0.03] border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-hover)]'
                }`}
              >
                <Zap className={`w-4 h-4 transition-transform duration-200 ${rated ? 'scale-110' : ''}`} />
                {rated ? 'Rated Match' : 'Casual (No Elo change)'}
              </button>
            </div>

            {/* The preview's absence, explained. Without this the panel simply
                does not appear for an opponent who has opted out of the
                leaderboard, which reads as a bug on a screen where it shows up
                for everybody else. It says what is true and stops — whose
                choice it was, not what their rating is. */}
            {!eloPreview && rated && opponent && (
              <div className="card-surface rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Info className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  <span className="eyebrow">Elo Preview</span>
                </div>
                <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                  {opponent.full_name.split(' ')[0]} has chosen not to show their rating, so there is
                  nothing to preview against. The match still counts and still moves your Elo.
                </p>
              </div>
            )}

            {/* Elo Preview */}
            {eloPreview && rated && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
                className="card-surface rounded-xl p-4 overflow-hidden"
              >
                <div className="flex items-center gap-2 mb-3">
                  <Info className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  <span className="eyebrow">Elo Preview</span>
                </div>
                <div className="flex justify-between gap-3">
                  <div className="flex items-center gap-2 bg-[color-mix(in_oklab,var(--color-success)_5%,transparent)] rounded-lg px-3 py-2 flex-1">
                    <TrendingUp className="w-4 h-4 text-[var(--color-success)] shrink-0" />
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Win</p>
                      <p className="nums text-base font-black text-[var(--color-success)]">+{eloPreview.winDelta}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 bg-[color-mix(in_oklab,var(--color-accent)_5%,transparent)] rounded-lg px-3 py-2 flex-1">
                    <TrendingDown className="w-4 h-4 text-[var(--color-accent)] shrink-0" />
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Loss</p>
                      <p className="nums text-base font-black text-[var(--color-accent)]">{eloPreview.lossDelta}</p>
                    </div>
                  </div>
                </div>
                {/* THE TWO THINGS THE FIGURES ABOVE CANNOT SAY. Both are now
                    true of the numbers rather than of the defaults: the K, the
                    threshold and the rating bounds all come from the same
                    settings row apply_match_result rates the match from. What is
                    left is the sweep bonus, which needs a scoreline that does
                    not exist yet, and the opponent's own delta, which is rated
                    off THEIR matches played and is not the mirror of this one. */}
                <p className="mt-3 text-[11px] leading-snug text-[var(--text-muted)]">
                  Your change, at your current K-factor. Winning without dropping a game counts for a little more.
                </p>
              </motion.div>
            )}

            {prediction && (
              <MatchupPrediction
                probability={prediction.probability}
                sideLabel={type === 'singles' ? 'you' : 'your side'}
                model={prediction.model}
                madeAt={prediction.madeAt}
              />
            )}

            {/* Scheduled Date/Time */}
            <div>
              <label className="eyebrow block mb-2">
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5" />
                  When to Play (optional)
                </span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <DatePicker
                  value={scheduledDate}
                  onChange={setScheduledDate}
                  placeholder="Pick a date"
                />
                <input
                  id="scheduled_time"
                  name="scheduled_time"
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl px-3 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklab,var(--color-accent)_40%,transparent)] focus:border-transparent transition-colors min-h-[44px] w-full"
                />
              </div>
            </div>

            <Textarea
              label="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Any message for your opponent..."
            />

            <Button
              type="submit"
              disabled={loading || pointsInvalid}
              size="lg"
              className="w-full min-h-[52px] btn-primary-cta press"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
              ) : (
                <Send className="w-4 h-4 mr-2 transition-transform duration-150 group-hover:translate-x-0.5" />
              )}
              Send Challenge
            </Button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
