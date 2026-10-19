import { z } from 'zod';
import { MIN_ELO, MAX_ELO, CUSTOM_FORMAT_BOUNDS, ELO_MULTIPLIER_BOUNDS, pointsCap } from '../utils/constants';
import {
  EXPENSE_CATEGORY_VALUES,
  OTHER_INCOME_CATEGORY_VALUES,
  type ExpenseCategory,
  type OtherIncomeCategory,
} from '../utils/finance-categories';
import { CLUB_EVENT_KINDS, CLUB_WALL_CLOCK_PATTERN } from '../utils/club-events';

// Empty optional strings come from form fields where the user left the input blank.
// Coerce them to undefined so downstream code doesn't have to discriminate "" vs unset.
const blankAsUndefined = (schema: z.ZodTypeAny) =>
  z.preprocess((val) => (val === '' ? undefined : val), schema.optional());

const phoneSchema = blankAsUndefined(
  z.string().regex(/^\+?[0-9 ()-]{7,20}$/, 'Invalid phone number')
);
const displayNameSchema = blankAsUndefined(
  z.string().min(2, 'Display name must be at least 2 characters').max(40)
);
// players.first_name / last_name (00023). Mononyms are real names, so a
// single character is enough and a last name is optional.
const firstNameSchema = z.string().min(1, 'First name is required').max(40);
const lastNameSchema = blankAsUndefined(z.string().max(40));
// HTML <input type="date"> emits YYYY-MM-DD; <input type="time"> emits HH:MM (with optional :SS).
const isoDateSchema = blankAsUndefined(
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date')
);
const isoTimeSchema = blankAsUndefined(
  z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Invalid time')
);

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const profileSchema = z.object({
  first_name: firstNameSchema,
  last_name: lastNameSchema,
  display_name: displayNameSchema,
  phone: phoneSchema,
  bio: z.string().max(500).optional(),
  hide_from_leaderboard: z.boolean().optional(),
  // The activity-status flag was removed from this schema with the switch that
  // was its only writer (audit §2.5 — it read and wrote a column no screen
  // ever consulted). The COLUMN is untouched: whatever members already set is
  // still there, and if a surface that actually discloses activity is ever
  // built, this is where the field comes back, next to that surface.
  // 00111 — which tournament draw this member competes in, labelled "Gender" in
  // the app since 00129.
  //
  // BOTH SCHEMAS NOW ACCEPT IT. 00111 kept it out of adminPlayerUpdateSchema on
  // purpose and a test pinned the absence; 00129 reverses that premise on the
  // club owner's instruction, because the field is write-once for a member and
  // an exec has to be able to change it afterwards. WHAT BOUNDS THE MEMBER IS NO
  // LONGER A SCHEMA — it is the guard_competition_category_lock_trg trigger,
  // which is the only place it could be: `authenticated` holds UPDATE on the
  // column, so a shape check in TypeScript never saw the writes it was meant to
  // stop.
  //
  // `null` is a value a member may SEND, not just one they may leave out —
  // `.optional()` alone would make "unset it" indistinguishable from "did not
  // touch it". The database refuses a member's clear (see 00129 on why a
  // permitted retraction makes the lock a two-step formality); the schema still
  // carries it, because a member who has never declared one sends exactly this.
  competition_category: z.enum(['mens', 'womens']).nullable().optional(),
});

// What a NEW member is asked, on the web onboarding page and in Discord
// /signup, which is profileSchema with two answers made required. profileSchema
// itself is unchanged: Settings writes through it, and an existing member with
// no last name must still be able to save.
//
// The events question replaces competition_category here rather than sitting
// beside it, because "not answered" and "Open events only" both arrive at the
// column as NULL and only an explicit answer can tell them apart. 'open' is
// stored as NULL (categoryFromSignupAnswer).
export const onboardingProfileSchema = profileSchema.omit({ competition_category: true }).extend({
  last_name: z.string().trim().min(1, 'Last name is required').max(40),
  event_category: z.enum(['mens', 'womens', 'open'], {
    errorMap: () => ({ message: 'Choose which events you play in tournaments' }),
  }),
});

/**
 * 00130 — the club's PUBLIC blurb for one officer, shown on /exec.
 *
 * A SCHEMA OF ITS OWN rather than another key on profileSchema, because it is
 * not part of the same act. profileSchema is what a member submits from
 * Settings about themselves; this is what an officer publishes under the club's
 * name from the exec panel, and the two have different write paths, different
 * gates and different audiences. Folding it in would mean the Settings form
 * could carry it, which is the exact coupling this migration exists to undo.
 *
 * `.max(500)` matches profileSchema's `bio`. The database has no CHECK on
 * either column, so this is the whole cap for both, and keeping them equal
 * means an exec's existing bio always fits when 00130 copies it across.
 *
 * NOT `.optional()`. `''` is a real, meaningful value here — it is an officer
 * clearing their public blurb, and /exec then omits the paragraph entirely.
 * Optionality would make "clear it" indistinguishable from "did not send it".
 */
export const EXEC_BIO_MAX_LENGTH = 500;

export const execBioSchema = z.object({
  exec_bio: z.string().max(EXEC_BIO_MAX_LENGTH),
});

// Optional custom shape: "best of X games to Y points". When set these win over
// the preset (see migration 00031). Best-of must be odd so a majority always
// exists; the bounds keep a "best of 99 to 500" off the ladder. Shared by the
// player challenge form and admin entry, so both sides accept exactly what the
// challenges_custom_format_sane CHECK does.
const customFormatFields = {
  games_per_match: z
    .number().int()
    .min(CUSTOM_FORMAT_BOUNDS.minGames)
    .max(CUSTOM_FORMAT_BOUNDS.maxGames)
    .refine((n) => n % 2 === 1, 'Games must be an odd number')
    .optional(),
  points_per_game: z
    .number().int()
    .min(CUSTOM_FORMAT_BOUNDS.minPoints)
    .max(CUSTOM_FORMAT_BOUNDS.maxPoints)
    .optional(),
};

export const challengeCreateSchema = z.object({
  type: z.enum(['singles', 'doubles']),
  rated_flag: z.boolean(),
  format: z.enum(['bo3_21', 'single_21', 'single_15', 'single_11']),
  ...customFormatFields,
  event_type: z.enum(['rated_challenge', 'casual']).default('rated_challenge'),
  opponent_id: z.string().uuid(),
  partner_id: z.string().uuid().optional(),
  opponent_partner_id: z.string().uuid().optional(),
  session_id: z.string().uuid().optional(),
  scheduled_date: isoDateSchema,
  scheduled_time: isoTimeSchema,
  note: z.string().max(500).optional(),
});

// A sanity bound only: the deuce cap of the highest target anyone can set (a
// game to 30 caps at 39). Which scores can actually end a game is
// isLegalGameScore, judged against that match's own target. Player and admin
// entry share it.
const matchGameSchema = z.object({
  game_number: z.number().int().positive(),
  side_a_score: z.number().int().min(0).max(pointsCap(CUSTOM_FORMAT_BOUNDS.maxPoints)),
  side_b_score: z.number().int().min(0).max(pointsCap(CUSTOM_FORMAT_BOUNDS.maxPoints)),
});

// Server-side integrity checks mirroring apply_match_result: no tied games,
// and the claimed winner must have won a strict majority of the games.
const refineGamesMatchWinner = (
  games: z.infer<typeof matchGameSchema>[],
  winnerSide: 'a' | 'b',
  ctx: z.RefinementCtx,
  gamesPath: string,
  winnerPath: string
) => {
  let aWins = 0;
  let bWins = 0;
  games.forEach((g, i) => {
    if (g.side_a_score === g.side_b_score) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Game scores cannot be tied',
        path: [gamesPath, i],
      });
    } else if (g.side_a_score > g.side_b_score) {
      aWins++;
    } else {
      bWins++;
    }
  });
  const winnerGames = winnerSide === 'a' ? aWins : bWins;
  const loserGames = winnerSide === 'a' ? bWins : aWins;
  if (winnerGames <= loserGames) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'winner_side does not match game scores',
      path: [winnerPath],
    });
  }
};

// match_id is intentionally absent: submitMatchResult creates the match from challengeId,
// so the caller cannot have a match_id at submit time. confirmMatchResult / disputeMatchResult
// take the matchId as a separate argument.
export const matchResultSchema = z.object({
  winner_side: z.enum(['a', 'b']),
  games: z.array(matchGameSchema).min(1).max(CUSTOM_FORMAT_BOUNDS.maxGames),
  completed: z.boolean(),
}).superRefine((val, ctx) => {
  refineGamesMatchWinner(val.games, val.winner_side, ctx, 'games', 'winner_side');
});

export const disputeSchema = z.object({
  match_id: z.string().uuid(),
  reason_category: z.enum([
    'score_wrong', 'winner_wrong', 'format_wrong', 'incomplete', 'abuse', 'rules_violation', 'other',
  ]),
  description: z.string().min(10, 'Description must be at least 10 characters'),
});

export const sessionGroupSchema = z.enum(['competitive', 'recreational', 'all']);

export const sessionCreateSchema = z.object({
  name: z.string().min(2),
  date: z.string(),
  time: isoTimeSchema,
  end_time: isoTimeSchema,
  location: z.string().min(2),
  notes: z.string().max(500).optional(),
  season_id: z.string().uuid().optional(),
  track: sessionGroupSchema.default('all'),
  // Recurrence: when set, sessions repeat up to and including this date.
  // YYYY-MM-DD strings compare correctly lexicographically.
  repeat_until: z.string().optional(),
  // How the series steps. 'weekly' keeps the original behaviour — same weekday,
  // +7 days — and is the default so every existing caller is unchanged.
  //
  // 'daily' is what makes a MULTI-DAY EVENT expressible: a Saturday-Sunday camp
  // is two rows one day apart, not one row with two dates. That is deliberate.
  // A session is the unit the whole app counts — check-in opens against it,
  // attendance hangs off it, reminders fire per row — so a weekend camp really
  // is two doors on two nights, and modelling it as two rows means every one of
  // those behaviours works with no change. The cost is that it READS as two
  // rows in Upcoming and members RSVP to each day.
  //
  // This does NOT make an OVERNIGHT session possible: a 9pm-1am night still
  // needs `sessions` to carry an end DATE, which it does not (see 00110 — the
  // generated ends_at is club_local_instant(date, end_time), same date). That
  // is a migration, and a separate change.
  repeat_frequency: z.enum(['daily', 'weekly']).default('weekly'),
  // Dates to skip within the series (same YYYY-MM-DD format as `date`).
  // Only meaningful alongside repeat_until; stray exclusions without a series
  // are ignored server-side rather than rejected. Capped at the series max.
  excluded_dates: z.array(z.string()).max(40).optional(),
  // When both times are present, the session must end after it starts.
  // Zero-padded HH:MM[:SS] strings compare correctly lexicographically.
}).refine((d) => !d.time || !d.end_time || d.end_time > d.time, {
  message: 'End time must be after start time',
  path: ['end_time'],
}).refine((d) => !d.repeat_until || d.repeat_until >= d.date, {
  message: 'Repeat-until date must be on or after the start date',
  path: ['repeat_until'],
});

// ONE PARTIAL EDIT, APPLIED TO SEVERAL NIGHTS — the payload the /sessions bulk
// bar sends. Every key is optional because an ABSENT key means "leave this
// column exactly as it is", which is the only thing that can be meant across a
// selection: there is no single current value shared by twelve Tuesdays.
//
// DELIBERATELY NOT isoTimeSchema. That helper is wrapped in blankAsUndefined
// (top of this file), which preprocesses '' -> undefined — so reusing it would
// turn "clear the time" into "leave the time alone" and silently delete the one
// state this schema exists to express. The regex is spelled out here so that ''
// FAILS instead of being normalized into a third meaning.
//
// .nullable() ONLY on the two nullable columns. sessions.start_time and
// end_time really are NULL for a night with no time set — that is the "TIME NOT
// SET" the console shows — so `null` has to parse for them and mean "clear it".
// name, location and track are NOT NULL / column-defaulted, so `null` must not
// parse for those.
//
// THE ABSENCE OF A KEY IS THE ALLOWLIST. date, status, notes, season_id,
// host_player_id and require_scan_to_check_in are all out (the arguments are in
// patchSession's header), and .strict() makes an attempt to send one a loud
// rejection rather than zod's default silent strip.
//
// NO end > start refine HERE, on purpose: a patch may move only one of the two
// times, so the check needs the STORED row, which this schema never sees. It
// lives in assertTimeOrder beside the action that has read the row.
export const sessionPatchSchema = z.object({
  name: z.string().min(2).optional(),
  location: z.string().min(2).optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Invalid time').nullable().optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Invalid time').nullable().optional(),
  track: sessionGroupSchema.optional(),
}).strict();

// Admin-only attendance marks; players self-insert 'checked_in' rows via RLS.
export const attendanceStatusSchema = z.enum(['present', 'no_show', 'excused']);

export const attendanceMarkSchema = z.object({
  session_id: z.string().uuid(),
  player_id: z.string().uuid(),
  status: attendanceStatusSchema,
});

// Ahead-of-time session RSVP: players signal whether they intend to attend.
export const sessionIntentSchema = z.enum(['going', 'declined']);

// A club wall-clock time from a datetime-local input; blank is null.
const clubWallClockSchema = z.string().regex(CLUB_WALL_CLOCK_PATTERN, 'Invalid date and time');
const optionalClubWallClock = z.preprocess(
  (val) => (val === '' || val === undefined ? null : val),
  clubWallClockSchema.nullable(),
);

export const tournamentCreateSchema = z.object({
  name: z.string().min(2),
  // .min(1), because `tournaments.start_date` is NOT NULL and a blank date
  // input posts "" rather than being absent. Without this the empty string
  // passes validation, reaches Postgres, and comes back as
  // `invalid input syntax for type date: ""` — which a production build
  // redacts to "An error occurred in the Server Components render", so the
  // officer sees an unexplained crash instead of "Start date is required".
  // end_date below is optional and separately coerced to null by the action;
  // it is start_date, the required one, that had no floor.
  start_date: z.string().min(1),
  end_date: z.string().optional(),
  event_multiplier: z.number().min(ELO_MULTIPLIER_BOUNDS.min).max(ELO_MULTIPLIER_BOUNDS.max).default(1.15),
  placement_bonus_enabled: z.boolean().default(true),
  // Which membership groups may register. Defaults to all three so a tournament
  // created without touching this stays open, matching the column default.
  // Rejects the empty array: that bars everyone, and is only ever the shape you
  // get from a form with nothing ticked.
  allowed_memberships: z
    .array(z.enum(['internal', 'alumni', 'external']))
    .min(1, 'Pick at least one group')
    .default(['internal', 'alumni', 'external']),
  waiver_text: z.string().max(50000).optional(),
  // How many of this tournament's events one member may enter (00098).
  // NULLABLE IS THE FEATURE: null is uncapped and is the default, so a
  // tournament created without touching the field behaves exactly as every
  // tournament did before the cap existed.
  //
  // Refuses zero and below, matching the column CHECK. A cap of zero means
  // "nobody may enter anything", which is what not opening registration is
  // for; allowing it to be stored would make every entry path in both apps
  // responsible for telling it apart from null.
  //
  // The upper bound is deliberately loose — a tournament cannot have more
  // events than it has events, so a cap above that is merely redundant rather
  // than dangerous, and nothing here loops over it.
  max_events_per_player: z.number().int().min(1).max(100).nullable().optional(),
  // The tournament-wide registration and check-in windows (00276), as club
  // wall-clock strings. Each event inherits any bound it leaves blank.
  registration_opens_at: optionalClubWallClock,
  registration_closes_at: optionalClubWallClock,
  checkin_opens_at: optionalClubWallClock,
  checkin_closes_at: optionalClubWallClock,
});

// A club event as the console form posts it (00244). Mirrors the table's
// CHECKs so a bad field is a sentence rather than a constraint name. Times are
// club wall-clock strings, converted to instants by the action; cost is in
// dollars here and stored as integer cents. No status and no created_by: the
// action decides both.
const optionalText = (max: number) =>
  z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? null : val),
    z.string().trim().max(max).nullable().optional(),
  );

export const clubEventSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(120),
    kind: z.enum(CLUB_EVENT_KINDS),
    description: optionalText(4000),
    location: optionalText(200),
    starts_at: clubWallClockSchema,
    ends_at: optionalClubWallClock,
    signup_opens_at: optionalClubWallClock,
    signup_closes_at: optionalClubWallClock,
    capacity: z.number().int().min(1).nullable(),
    cost_dollars: z.number().min(0).max(1000).nullable(),
    publish: z.boolean(),
  })
  .strict()
  // Zero-padded YYYY-MM-DDTHH:MM strings compare correctly lexicographically.
  .refine((d) => !d.ends_at || d.ends_at > d.starts_at, {
    message: 'The end must be after the start',
    path: ['ends_at'],
  })
  .refine((d) => !d.signup_opens_at || !d.signup_closes_at || d.signup_closes_at > d.signup_opens_at, {
    message: 'Sign-ups must close after they open',
    path: ['signup_closes_at'],
  })
  .transform(({ cost_dollars, ...rest }) => ({
    ...rest,
    cost_cents: cost_dollars === null ? null : Math.round(cost_dollars * 100),
  }));

export type ClubEventInput = z.input<typeof clubEventSchema>;

export const tournamentSuspendSchema = z.object({
  tournament_id: z.string().uuid(),
  reason: z.string().min(2, 'Reason is required').max(500),
});

// The four statuses a tournament row may be moved to.
//
// updateTournamentStatus took `status: string` and passed it straight into
// `.update({ status })`, so any string a caller cared to send reached the
// column — 'complete', 'Completed', 'finished'. The CHECK constraint refuses
// most of them, but a rejected UPDATE resolves rather than throws in
// supabase-js, and the caller then went on to fan a "registration open"
// notification out to the whole club for a status change that never landed.
// Shaped like tournamentSuspendSchema so parseOrThrow's message carries the
// field prefix the exec needs to read it.
export const tournamentStatusUpdateSchema = z.object({
  tournament_id: z.string().uuid(),
  status: z.enum(['draft', 'active', 'completed', 'archived']),
});

export const adminPlayerUpdateSchema = z.object({
  status: z.enum([
    'competitive', 'recreational', 'suspended', 'pending_approval',
  ]).optional(),
  // "Inactive" is not a status — it is active_flag. mark-inactive-players
  // clears it after the configured threshold, and removePlayer clears it too,
  // and until now nothing in the console could set it back. The Status control
  // presents both as one list; this is the half that is not the enum.
  active_flag: z.boolean().optional(),
  // NO role / is_exec / is_trainer, and their absence is the point rather than
  // an oversight. Those three ARE console access, and console access is set on
  // the admin console's Permissions page — one path, with a self-edit refusal,
  // grant closure in both directions and a required reason. This schema feeds
  // updatePlayer(), which now refuses them outright (see
  // assertNoConsoleAccessFields); dropping them here is what stops a payload
  // ever being able to name one in the first place.
  //
  // Which group of the club they belong to. Independent of the level markers —
  // an exec is still an internal member. Drives tournament eligibility.
  membership_type: z.enum(['internal', 'alumni', 'external']).optional(),
  singles_elo: z.number().int().min(MIN_ELO).max(MAX_ELO).optional(),
  doubles_elo: z.number().int().min(MIN_ELO).max(MAX_ELO).optional(),
  // The exec's public-page fields and the fee marker. exec_title is their role
  // label on the public /exec page; fee_exempt exempts a non-exec contributor
  // from club fees. Neither hands out console access, which is why they survive
  // here while is_exec itself does not.
  exec_title: blankAsUndefined(z.string().max(60)),
  fee_exempt: z.boolean().optional(),
  // Photo for the public /exec page. Separate from avatar_url so a profile
  // picture change never alters the club's public page.
  exec_photo_url: blankAsUndefined(z.string().url().max(500)),
  // 00225 — keeps an officer off the public /exec page while leaving both
  // is_exec (their console access) and active_flag (their membership) alone.
  // The third public-page field, and like the two above it hands out nothing:
  // get_executives() is the only reader.
  exec_hidden: z.boolean().optional(),
  // 00129 — the member's Gender, which they set once and an exec changes after
  // that. ADDED DELIBERATELY, REVERSING 00111: that migration kept the key out
  // of this schema and a test pinned the absence, on the reading that only the
  // member ever sets it. The club owner has since asked for the field to lock,
  // and a lock with no exec key is a field nobody can ever correct.
  //
  // It is on NEITHER PLAYER_FIELD_FLOOR NOR PLAYER_FIELD_PRIVILEGED in the
  // admin app's player-field-access.ts, which is what makes it writable by any
  // holder of players.update.write — an exec — rather than admin-only. That is
  // a decision, not an omission; see the note there.
  //
  // Nullable for the same reason the member's schema is: an exec clearing it
  // back to "prefer not to say" is a correction they must be able to make, and
  // it is the ONLY route back to NULL that exists after 00129.
  competition_category: z.enum(['mens', 'womens']).nullable().optional(),
  reason: z.string().min(2, 'Reason is required'),
});

export const eventFeedbackSchema = z
  .object({
    tournament_id: z.string().uuid(),
    rating: z.number().int().min(1).max(5).optional(),
    comment: blankAsUndefined(z.string().max(2000)),
  })
  .refine((d) => d.rating !== undefined || (d.comment != null && d.comment.length > 0), {
    message: 'Add a rating or a comment',
  });
export type EventFeedbackInput = z.infer<typeof eventFeedbackSchema>;

export const walkoverReportSchema = z.object({
  challenge_id: z.string().uuid(),
  forfeit_player_id: z.string().uuid(),
  walkover_type: z.enum(['withdrawal', 'no_show']),
  notice_hours: z.number().int().optional(),
});

export const disputeResolveSchema = z.object({
  dispute_id: z.string().uuid(),
  resolution_type: z.enum(['accepted', 'edited', 'voided', 'converted_to_casual']),
  resolution_note: z.string().min(2),
  edited_winner_side: z.enum(['a', 'b']).optional(),
  edited_games: z.array(matchGameSchema).max(CUSTOM_FORMAT_BOUNDS.maxGames).optional(),
}).superRefine((val, ctx) => {
  if (val.edited_games && val.edited_games.length > 0 && val.edited_winner_side) {
    refineGamesMatchWinner(val.edited_games, val.edited_winner_side, ctx, 'edited_games', 'edited_winner_side');
  }
});

export const adminPlayerCreateSchema = z.object({
  first_name: firstNameSchema,
  last_name: lastNameSchema,
  email: z.string().email('Invalid email address'),
  status: z.enum([
    'competitive', 'recreational', 'suspended', 'pending_approval',
  ]).optional(),
  // 'admin' intentionally absent: admin accounts are promoted from existing
  // members (updatePlayer), never created directly.
  role: z.enum(['player']).optional(),
  is_exec: z.boolean().optional(),
  is_trainer: z.boolean().optional(),
});

export const adminMatchCreateSchema = z.object({
  match_type: z.enum(['singles', 'doubles']),
  format: z.enum(['bo3_21', 'single_21', 'single_15', 'single_11']),
  ...customFormatFields,
  rated_flag: z.boolean(),
  side_a_players: z.array(z.string().uuid()).min(1).max(2),
  side_b_players: z.array(z.string().uuid()).min(1).max(2),
  winner_side: z.enum(['a', 'b']),
  // A best-of-7 is seven games, so the old cap of 3 would have rejected every
  // custom shape longer than the presets.
  games: z.array(matchGameSchema).min(1).max(CUSTOM_FORMAT_BOUNDS.maxGames),
  admin_note: z.string().max(500).optional(),
}).superRefine((v, ctx) => {
  // Nobody plays themselves. The two sides were validated only for length, so
  // the same UUID could appear on both sides (or twice on one side) and the
  // action would happily build two participant rows for one player — which
  // match_participants' UNIQUE(match_id, player_id) then refuses, AFTER the
  // match row has already been committed. Rejecting it here is the cheap half
  // of that fix; matches.ts still has to survive the write failing, because a
  // concurrent delete can produce one that no schema can see coming.
  const all = [...v.side_a_players, ...v.side_b_players];
  if (new Set(all).size !== all.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['side_b_players'],
      message: 'A player can only appear once in a match — check both sides.',
    });
  }
});

export const feeMarkSchema = z.object({
  player_id: z.string().uuid(),
  season_id: z.string().uuid(),
  amount_cents: z.number().int().positive().optional(),
  method: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
});

// Marks a named dues row paid (00290: a Google Form files one unpaid for a
// non-member). The row is named by id; the amount defaults to the row's own.
export const namedFeeMarkSchema = z.object({
  fee_id: z.string().uuid(),
  amount_cents: z.number().int().positive().optional(),
  method: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
});
export type NamedFeeMarkInput = z.infer<typeof namedFeeMarkSchema>;

// A member's payment receipt (00248, 00253). Exactly one of the two ids: feeId
// for a fee row that exists, duesSeasonId for this season's dues when the
// member has no dues row yet. detectedMethod is what the browser read off the
// screenshot, a hint the action clamps by the fee's kind. The reference is
// re-checked against the column's CHECK by isPlausibleReference once the stored
// method is known (4 characters is only enough for an SFU Rec receipt); the
// path against the member's own folder by the action.
export const feeSubmissionSchema = z
  .object({
    feeId: z.string().uuid().nullable(),
    duesSeasonId: z.string().uuid().nullable(),
    reference: z.string().trim().min(4, 'The reference is at least 4 characters').max(32, 'The reference is at most 32 characters'),
    screenshotPath: z.string().min(1, 'Attach a screenshot of your receipt').max(300),
    detectedMethod: z.enum(['e_transfer', 'sfu_rec']).nullable().optional(),
  })
  .strict()
  .refine((v) => (v.feeId === null) !== (v.duesSeasonId === null), {
    message: 'Say which fee this receipt is for',
    path: ['feeId'],
  });

// One-time season-fee waiver: stored as a paid row with amount_cents 0 and
// method 'waived', so income sums stay correct without a schema migration.
export const feeWaiveSchema = z.object({
  player_id: z.string().uuid(),
  season_id: z.string().uuid(),
});

export const seasonFeeSchema = z.object({
  competitive_fee_cents: z.number().int().min(0),
  recreational_fee_cents: z.number().int().min(0),
});

// Creating a season. term + year are the real inputs, NOT the name: seasons.name
// is derived from them by trg_set_season_name (00043) precisely so it can never
// drift. The console used to collect a free-text name and send only that, which
// left term and year null — both are NOT NULL with no default, so every attempt
// to create a season failed with a not-null violation.
//
// Enum order is fall -> spring -> summer, matching the academic year, so a
// season starting in September 2026 is Fall 2026 and the one after it is Spring
// 2027. `year` is the calendar year the TERM BEGINS IN, which is why Spring 2027
// carries 2027 and not 2026.
export const seasonCreateSchema = z.object({
  term: z.enum(['fall', 'spring', 'summer']),
  // Bounded so a typo cannot create "Fall 20226" and sort ahead of everything
  // forever. The lower bound predates the club's first digital season.
  year: z.number().int().min(2000).max(2100),
  start_date: z.string().min(1),
  end_date: z.string().min(1).optional(),
});

// A manual fee entry: someone who paid the club fee without an account. The
// admin records just a name against the active season.
//
// The email is optional (00252). When given, a later signup with that address
// claims the payment onto the new account. Normalised here the way the column
// CHECK demands (trimmed, lowercase), and a blank field means no email rather
// than an invalid one.
export const manualFeeSchema = z.object({
  season_id: z.string().uuid(),
  manual_name: z.string().min(1).max(80),
  email: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().trim().toLowerCase().email('Invalid email address').max(254).optional(),
  ),
  amount_cents: z.number().int().positive().optional(),
  method: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
});

// The /fees "Paste a list" preview: free text pasted by an exec (an e-transfer
// export, a column out of a spreadsheet) against the season it applies to. The
// cap is on the text; the parser caps the entries it will read out of it.
export const feePastePreviewSchema = z
  .object({
    season_id: z.string().uuid(),
    text: z.string().min(1).max(50000),
  })
  .strict();

export const feeTierSchema = z.object({
  tournament_id: z.string().uuid(),
  name: z.string().min(1).max(40),
  amount_cents: z.number().int().min(0),
  is_default: z.boolean(),
  // Which memberships this tier prices (00094). Absent and null both mean
  // "anyone", matching the column: a tier with no audience is the general
  // price, which is what every tier created before this feature is.
  //
  // An EMPTY ARRAY IS REFUSED rather than normalised to null. The column CHECK
  // refuses it too, and for the same reason 00040 refuses an empty
  // allowed_memberships: it is the shape a form produces when every box is
  // deselected, the author meant something by deselecting them, and quietly
  // reading it as "everybody" would price the opposite of what they asked for.
  applies_to: z
    .array(z.enum(['internal', 'alumni', 'external']))
    .min(1, 'Choose at least one membership, or leave it unset to price everyone.')
    .nullable()
    .optional(),
});

export const tournamentFeeMarkSchema = z.object({
  tournament_id: z.string().uuid(),
  player_id: z.string().uuid(),
  tier_id: z.string().uuid().optional(),
  amount_cents: z.number().int().nonnegative().optional(),
  method: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
});

export const reinstatementSchema = z.object({
  player_id: z.string().uuid(),
  amount_cents: z.number().int().nonnegative().optional(),
  method: z.string().max(40).optional(),
  // Same field and cap as club_fees.reference (00039/00059): the transaction
  // id that lets somebody reconcile this against a bank statement later.
  reference: z.string().max(120).optional(),
});

// Filling in the money on a reinstatement that has already happened. An exec
// may lift a ban but may not touch the ledger, so their unban leaves a row with
// no amount and no paid_at; this is how an admin records what was actually
// collected afterwards. amount_cents is required — the whole point of the call
// is to state a figure — and 0 is a legal figure, meaning the reinstatement
// really was free.
export const reinstatementPaymentSchema = z.object({
  fee_id: z.string().uuid(),
  amount_cents: z.number().int().nonnegative(),
  method: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
});

// ------------------------------------------------------------
// Non-fee ledgers (migration 00073): other income and expenses.
//
// season_id is REQUIRED on both, and is the only thing that decides which
// season a row counts toward. reinstatement_fees had to be bucketed by paid_at
// because it had no season column, and a payment taken between terms then fell
// outside every window and vanished from every total (00069). An optional
// season here would recreate that: a row with no season belongs to no total.
//
// paid_at is an optional ISO date string. It is the date the money moved, which
// is NOT the date the entry was typed — an exec writing up September's shuttle
// receipts in October needs to say September. Bucketing is still by season_id,
// so the date can be anything without moving the row between totals; the two
// jobs are deliberately separate.
// ------------------------------------------------------------

// Shared by both ledgers so they cannot drift on what a money entry looks like.
const ledgerEntryFields = {
  season_id: z.string().uuid(),
  description: z.string().trim().min(1, 'Describe what this was for').max(120),
  // Non-negative, not positive: $0.00 records that a promised donation came to
  // nothing, or a donated set of shuttles cost the club nothing, without
  // deleting the trail. Matches the CHECK in 00073.
  amount_cents: z.number().int().nonnegative(),
  paid_at: z.string().datetime().optional(),
  method: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
};

export const otherIncomeSchema = z.object({
  ...ledgerEntryFields,
  // z.enum needs a non-empty tuple; the const array from finance-categories is
  // the same vocabulary the database CHECK enforces.
  category: z.enum(
    OTHER_INCOME_CATEGORY_VALUES as unknown as [OtherIncomeCategory, ...OtherIncomeCategory[]],
  ),
});

export const clubExpenseSchema = z.object({
  ...ledgerEntryFields,
  category: z.enum(
    EXPENSE_CATEGORY_VALUES as unknown as [ExpenseCategory, ...ExpenseCategory[]],
  ),
  // Tubes of shuttles, hours of court. Optional; positive when given, because
  // "0 tubes" for a non-zero spend is a typo, not a fact.
  quantity: z.number().int().positive().optional(),
  // Who fronted the money (00077). Absent means the club account paid directly
  // and nobody is owed a reimbursement — a real case, not a missing value, so
  // it stays optional here. The console never defaults it: the dialog forces
  // the choice, because there is no edit action and delete is admin-only, so a
  // wrong value cannot be corrected by the exec who is out of pocket.
  //
  // Deliberately NOT derived from the acting user. The payer and the person
  // typing the row are different whenever an admin writes up an exec's receipt,
  // and reimbursing the typist is the bug this field exists to prevent.
  paid_by: z.string().uuid().optional(),
  // The photo of the receipt (00231). Optional, and it has to be: a receipt can
  // legitimately be lost on the way home or emailed rather than handed over, and
  // refusing the spend for want of a picture would either stop the money being
  // recorded or push somebody into attaching the wrong image.
  //
  // A STORAGE PATH, NEVER A URL. It is an object path in the private
  // expense-receipts bucket; the console signs a short-lived URL at the moment
  // somebody clicks. A signed URL stored in a row rots, and every older receipt
  // would be dead the next time anyone looked.
  //
  // Validated here only as "a string of sane length". The path is
  // CLIENT-SUPPLIED, so the shape is not the interesting question: addExpense
  // re-checks it against the uploader's own auth.uid(), because the service-role
  // client that signs it bypasses RLS and an arbitrary path would otherwise be a
  // read primitive for the whole bucket.
  receipt_path: z.string().max(512).optional(),
});

/**
 * Editing an expense an admin already recorded (00077).
 *
 * season_id is NOT here. Moving a spend between seasons changes two seasons'
 * net position in one write and there is no console flow that wants it — an
 * expense filed against the wrong term is a delete-and-re-record, done
 * deliberately, not a field to nudge. ref_no is not here either: the whole
 * value of a reference number is that it never moves.
 *
 * amount_cents and paid_by ARE here, and the action refuses them on a row that
 * has already been reimbursed. See updateExpense() for why that boundary is in
 * the action rather than in this schema — it depends on the stored row, which a
 * validator cannot see.
 */
export const clubExpenseUpdateSchema = clubExpenseSchema
  .omit({ season_id: true })
  .extend({ id: z.string().uuid() });

export const banSchema = z.object({
  player_id: z.string().uuid(),
  reason: z.string().min(2),
});

// fee_exempt ALONE. This carried is_exec too, which made the Fees page's flag
// writer a second way to hand somebody a console level — is_exec is what
// admin_access_level reads to resolve 'exec'. Console access now has exactly one
// editing path (/permissions → setConsoleAccess), so the flag this schema is
// named for is the only flag left in it. The capability keeps its name,
// `fees.playerflags.write`: capability strings are stored as data in
// permission_grants / permission_revokes / permission_baselines.capabilities,
// and renaming one orphans every live grant that names it.
export const playerFlagsSchema = z.object({
  fee_exempt: z.boolean(),
});

export const varsityNoteSchema = z.object({
  player_id: z.string().uuid(),
  note: z.string().min(2, 'Note must be at least 2 characters').max(2000),
});

export const reliabilityAdjustSchema = z.object({
  player_id: z.string().uuid(),
  no_shows: z.number().int().min(0),
  late_cancellations: z.number().int().min(0),
  early_withdrawals: z.number().int().min(0),
  walkover_flag: z.boolean(),
  reason: z.string().min(2, 'Reason must be at least 2 characters').max(500),
});

export const announcementSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  body: z.string().min(1, 'Body is required').max(5000),
  type: z.enum(['info', 'warning', 'urgent', 'event']),
  target_audience: z.enum(['all', 'competitive', 'recreational', 'eligible_only']),
  pinned: z.boolean(),
  send_push: z.boolean(),
  status: z.enum(['draft', 'published']),
  // Edit forms round-trip the stored timestamptz, so this is looser than isoDateSchema.
  expires_at: z.string().optional(),
});

// All four must be literally true — accepting is an affirmative act, so the
// server rejects anything short of an explicit check on every box.
export const legalAcceptanceSchema = z.object({
  waiver_accepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the liability waiver' }),
  }),
  code_of_conduct_accepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the code of conduct' }),
  }),
  terms_accepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms of use and privacy policy' }),
  }),
  age_attestation: z.literal(true, {
    errorMap: () => ({ message: 'You must confirm you are 19 or older, or have your parent/guardian\'s consent' }),
  }),
});

// A non-member signing the waiver and privacy policy (00254). No version
// fields, on purpose: the versions signed are read from legal_documents inside
// sign_guest_waiver, so a client cannot claim to have signed an older text.
export const guestWaiverSchema = z.object({
  full_name: z.string().trim().min(2, 'Enter your full name').max(100),
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254),
  age_attestation: z.literal(true, {
    errorMap: () => ({ message: 'You must be 19 or older to sign as an external' }),
  }),
  documents_accepted: z.literal(true, {
    errorMap: () => ({ message: 'Please accept the waiver and privacy policy' }),
  }),
  // 00255. Optional and off by default, so a form from before it still validates.
  media_consent: z.boolean().optional().default(false),
});

export type GuestWaiverInput = z.infer<typeof guestWaiverSchema>;

// A member's own photo and video consent (00255). No player id: the RPC
// resolves the caller from the session.
export const mediaConsentSchema = z.object({
  media_consent: z.boolean(),
});

export type MediaConsentInput = z.infer<typeof mediaConsentSchema>;

// A guest's photo and video consent, changed from their proof page by token.
export const guestMediaConsentSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{48}$/),
  media_consent: z.boolean(),
});

export type GuestMediaConsentInput = z.infer<typeof guestMediaConsentSchema>;

// Typing DELETE is an affirmative act — the server rejects anything else.
export const accountDeletionSchema = z.object({
  confirmation: z.literal('DELETE', {
    errorMap: () => ({ message: 'Type DELETE to confirm' }),
  }),
});

export const legalDocumentUpdateSchema = z.object({
  document: z.enum(['waiver', 'code_of_conduct', 'terms_of_use', 'privacy_policy']),
  content: z.string().min(50, 'Content must be at least 50 characters').max(50000),
  bump_version: z.boolean(),
});

// Just the document key — validated when an admin forces re-acceptance.
export const waiverDocumentSchema = z.enum([
  'waiver', 'code_of_conduct', 'terms_of_use', 'privacy_policy',
]);

// The per-season starting text for a tournament's event waiver (00074). Same
// length bounds as legalDocumentUpdateSchema — it is the same kind of text,
// and the 50-character floor is what stops a stray keystroke being saved as
// the wording every event that term starts from. No bump_version counterpart:
// a template is accepted by nobody, so there is no version to re-require
// (acceptance happens per tournament against the copied text).
export const eventWaiverTemplateUpdateSchema = z.object({
  season_id: z.string().uuid(),
  content: z.string().min(50, 'Content must be at least 50 characters').max(50000),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
export type OnboardingProfileInput = z.infer<typeof onboardingProfileSchema>;
export type ChallengeCreateInput = z.infer<typeof challengeCreateSchema>;
export type MatchResultInput = z.infer<typeof matchResultSchema>;
export type DisputeInput = z.infer<typeof disputeSchema>;
export type SessionCreateInput = z.infer<typeof sessionCreateSchema>;
export type SessionPatchInput = z.infer<typeof sessionPatchSchema>;
export type AttendanceStatusInput = z.infer<typeof attendanceStatusSchema>;
export type AttendanceMarkInput = z.infer<typeof attendanceMarkSchema>;
export type SessionIntentInput = z.infer<typeof sessionIntentSchema>;
export type TournamentCreateInput = z.infer<typeof tournamentCreateSchema>;
export type TournamentSuspendInput = z.infer<typeof tournamentSuspendSchema>;
export type TournamentStatusUpdateInput = z.infer<typeof tournamentStatusUpdateSchema>;
export type AdminPlayerUpdateInput = z.infer<typeof adminPlayerUpdateSchema>;
export type WalkoverReportInput = z.infer<typeof walkoverReportSchema>;
export type DisputeResolveInput = z.infer<typeof disputeResolveSchema>;
export type AdminPlayerCreateInput = z.infer<typeof adminPlayerCreateSchema>;
export type AdminMatchCreateInput = z.infer<typeof adminMatchCreateSchema>;
export type AnnouncementInput = z.infer<typeof announcementSchema>;
export type FeeMarkInput = z.infer<typeof feeMarkSchema>;
export type FeeSubmissionInput = z.infer<typeof feeSubmissionSchema>;
export type FeeWaiveInput = z.infer<typeof feeWaiveSchema>;
export type SeasonFeeInput = z.infer<typeof seasonFeeSchema>;
export type SeasonCreateInput = z.infer<typeof seasonCreateSchema>;
export type SessionGroupInput = z.infer<typeof sessionGroupSchema>;
export type ManualFeeInput = z.infer<typeof manualFeeSchema>;
export type FeePastePreviewInput = z.infer<typeof feePastePreviewSchema>;
export type FeeTierInput = z.infer<typeof feeTierSchema>;
export type TournamentFeeMarkInput = z.infer<typeof tournamentFeeMarkSchema>;
export type ReinstatementInput = z.infer<typeof reinstatementSchema>;
export type ReinstatementPaymentInput = z.infer<typeof reinstatementPaymentSchema>;
export type OtherIncomeInput = z.infer<typeof otherIncomeSchema>;
export type ClubExpenseInput = z.infer<typeof clubExpenseSchema>;
export type ClubExpenseUpdateInput = z.infer<typeof clubExpenseUpdateSchema>;
export type BanInput = z.infer<typeof banSchema>;
export type PlayerFlagsInput = z.infer<typeof playerFlagsSchema>;
export type VarsityNoteInput = z.infer<typeof varsityNoteSchema>;
export type ReliabilityAdjustInput = z.infer<typeof reliabilityAdjustSchema>;
export type LegalAcceptanceInput = z.infer<typeof legalAcceptanceSchema>;
export type AccountDeletionInput = z.infer<typeof accountDeletionSchema>;
export type LegalDocumentUpdateInput = z.infer<typeof legalDocumentUpdateSchema>;
export type WaiverDocumentInput = z.infer<typeof waiverDocumentSchema>;
export type EventWaiverTemplateUpdateInput = z.infer<typeof eventWaiverTemplateUpdateSchema>;
