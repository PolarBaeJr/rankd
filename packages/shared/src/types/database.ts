// Generated types matching the SQL schema

import type { SeedBy } from '../utils/standings';
import type { MembershipType } from '../utils/membership';

export type PlayerStatus =
  | 'competitive'
  | 'recreational'
  | 'pending_approval'
  | 'suspended';

export type UserRole = 'player' | 'admin';

export type MatchFormat = 'bo3_21' | 'single_21' | 'single_15' | 'single_11';

export type MatchTypeEnum = 'singles' | 'doubles';

export type EventType = 'rated_challenge' | 'casual' | 'tournament' | 'trial' | 'admin_entered';

export type ChallengeStatus =
  | 'proposed'
  | 'partially_confirmed'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'completed'
  | 'disputed'
  | 'walkover_pending'
  | 'walkover_confirmed';

export type ParticipantRole = 'challenger' | 'opponent' | 'partner' | 'opponent_partner';

export type TeamSide = 'a' | 'b';

export type ConfirmationStatus = 'pending' | 'accepted' | 'rejected';

export type ResultStatus =
  | 'pending_submission'
  | 'pending_confirmation'
  | 'confirmed'
  | 'disputed'
  | 'voided'
  | 'walkover'
  | 'incomplete';

export type SessionStatus = 'open' | 'closed';

export type TournamentStatus = 'draft' | 'active' | 'completed' | 'archived';

export type DisputeReason =
  | 'score_wrong'
  | 'winner_wrong'
  | 'format_wrong'
  | 'incomplete'
  | 'abuse'
  | 'rules_violation'
  | 'other';

export type DisputeStatus = 'open' | 'under_review' | 'resolved';
export type DisputeResolution = 'accepted' | 'edited' | 'voided' | 'converted_to_casual';

export type WalkoverType = 'withdrawal' | 'no_show';
export type WalkoverStatus = 'pending' | 'confirmed' | 'rejected';

export type NotificationType =
  | 'challenge_received'
  | 'challenge_accepted'
  | 'challenge_rejected'
  | 'challenge_expired'
  | 'challenge_cancelled'
  | 'result_pending'
  | 'result_confirmed'
  | 'dispute_opened'
  | 'dispute_resolved'
  | 'rank_changed'
  | 'session_reminder'
  | 'walkover_reported'
  | 'walkover_confirmed'
  | 'opponent_withdrew'
  | 'admin_alert'
  | 'general'
  | 'tournament_bracket_published'
  | 'tournament_match_ready'
  | 'tournament_match_result'
  | 'tournament_event_completed'
  | 'tournament_checkin_open';

// Table row types
export type AnnouncementType = 'info' | 'warning' | 'urgent' | 'event';
export type AnnouncementStatus = 'draft' | 'published';
export type AnnouncementAudience = 'all' | 'competitive' | 'recreational' | 'eligible_only';

/**
 * 00111 — players.competition_category. TWO VALUES NAMING DRAWS, not people,
 * and `null` (undeclared, which also stores "prefer not to say") is the third
 * state and the default one.
 *
 * Declared HERE rather than beside the rules in utils/competition-category.ts
 * because it is a column's type and `Player` below needs it — putting it in the
 * utils module would make the two files import each other. The rules, the
 * refusal sentences and the reasoning all live there; this is only the shape.
 */
export type CompetitionCategory = 'mens' | 'womens';

export interface Player {
  id: string;
  user_id: string | null;
  first_name: string;
  last_name: string | null;
  // Generated column (00023): read-only, never write it.
  full_name: string;
  display_name: string | null;
  /** 00092 — the username this member picked, or null until they pick one. Public, lowercase, unique case-insensitively. */
  handle: string | null;
  /** 00092 — the club's own membership code, seven characters, assigned once at approval and never reused. Null for a pending signup. Not a student number. */
  member_code: string | null;
  /**
   * 00111 — which tournament draw this member competes in, or null for
   * undeclared (which is also how "prefer not to say" is stored). Headed
   * "Gender" on screen since 00129; the two stored values still name draws,
   * which is why they are still 'mens' and 'womens'.
   *
   * WRITE-ONCE FOR THE MEMBER (00129). They set it from null themselves in
   * Settings and the database refuses every later change from them, including
   * back to null — a permitted retraction would make the lock a two-step
   * formality. After that it changes only through the console's member Edit
   * dialog, gated on players.update.write and audited with a reason.
   *
   * Shown on exactly two screens: the member's own Settings, and that dialog.
   * Nothing else in either app renders it — the tournament code reads it and
   * reports the CONSEQUENCE ("no eligible partner"), never the value.
   */
  competition_category: CompetitionCategory | null;
  email: string;
  phone: string | null;
  status: PlayerStatus;
  role: UserRole;
  active_flag: boolean;
  is_exec: boolean;
  // Varsity trainer (00054). Independent of role and is_exec: a trainer may be
  // an exec or an admin too, and the highest level they hold is the one that
  // applies. Grants the admin console, limited to reading the roster and
  // writing varsity notes.
  is_trainer: boolean;
  fee_exempt: boolean;
  is_banned: boolean;
  banned_at: string | null;
  banned_by: string | null;
  ban_reason: string | null;
  onboarding_completed: boolean;
  avatar_url: string | null;
  /**
   * The member's PERSONAL bio. Edited in Settings, shown on their ladder
   * profile at /leaderboard/[playerId] to signed-in members, and — since 00130
   * — published nowhere. It used to double as an exec's public blurb; that is
   * `exec_bio` now.
   */
  bio: string | null;
  /**
   * 00130 — the blurb shown under an officer on the PUBLIC /exec page, written
   * by that officer on that page. Only meaningful on an `is_exec` row.
   *
   * NO SELECT GRANT for `authenticated`, on purpose: get_executives() is
   * SECURITY DEFINER and is the only reader, so naming this column in a
   * `.from('players').select(...)` fails the whole request with a 403 that
   * arrives as empty data. It is also absent from the `players_self` view,
   * whose column list was frozen at 00032.
   */
  exec_bio: string | null;
  exec_title: string | null;
  /** 00225 — keeps this officer off the public /exec page. NOT NULL, defaults
   *  false, and read only by get_executives(). Orthogonal to is_exec (console
   *  access) and active_flag (membership), which is the whole reason it had to
   *  be its own column rather than one of those two doing a second job. */
  exec_hidden: boolean;
  waiver_reset_at: string | null;
  /** 00059 — when the "your membership is now inactive" notice was sent. Cleared whenever active_flag goes back to true. */
  inactivity_notice_sent_at: string | null;
  /** 00062 — when the inactivity clock deactivated this member. Starts the retention countdown; NULL = never purgeable. Cleared on every reactivation. */
  inactive_since: string | null;
  /** 00246 - which guided tours this member has finished or skipped: tour key to first-seen time. Written only by mark_tour_seen(), service role. */
  tours_seen: Record<string, string>;
  /** 00255 - photo and video consent for club promotion. Off by default; written only by set_my_media_consent(). No member grant, so read it through a server action. */
  media_consent: boolean;
  /** 00255 - when media_consent last changed, stamped by the database. NULL means never chosen. */
  media_consent_changed_at: string | null;
  joined_at: string;
  last_active_at: string;
  created_at: string;
  updated_at: string;
}

export interface Rating {
  id: string;
  player_id: string;
  singles_elo: number;
  doubles_elo: number;
  singles_matches_played: number;
  doubles_matches_played: number;
  singles_provisional: boolean;
  doubles_provisional: boolean;
  singles_k_factor: number;
  doubles_k_factor: number;
  singles_wins: number;
  singles_losses: number;
  doubles_wins: number;
  doubles_losses: number;
  singles_points_scored: number;
  singles_points_allowed: number;
  doubles_points_scored: number;
  doubles_points_allowed: number;
  singles_games_won: number;
  singles_games_lost: number;
  doubles_games_won: number;
  doubles_games_lost: number;
  current_singles_streak: number;
  best_singles_streak: number;
  current_doubles_streak: number;
  best_doubles_streak: number;
  created_at: string;
  updated_at: string;
}

export interface Season {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  active_flag: boolean;
  competitive_fee_cents: number;
  recreational_fee_cents: number;
  created_at: string;
  updated_at: string;
}

export type SessionGroup = 'competitive' | 'recreational' | 'all';

export type AttendanceStatus = 'checked_in' | 'present' | 'no_show' | 'excused';

export type SessionIntent = 'going' | 'declined';

export interface Session {
  id: string;
  season_id: string | null;
  name: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  location: string;
  host_player_id: string | null;
  status: SessionStatus;
  track: SessionGroup;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionAttendance {
  id: string;
  session_id: string;
  player_id: string;
  checked_in_at: string;
  status: AttendanceStatus;
  marked_by: string | null;
  marked_at: string | null;
}

export interface Challenge {
  id: string;
  type: MatchTypeEnum;
  rated_flag: boolean;
  format: MatchFormat;
  event_type: EventType;
  session_id: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  created_by: string;
  status: ChallengeStatus;
  note: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export interface ChallengeParticipant {
  id: string;
  challenge_id: string;
  player_id: string;
  role: ParticipantRole;
  team_side: TeamSide;
  confirmation_status: ConfirmationStatus;
  responded_at: string | null;
}

export interface Match {
  id: string;
  challenge_id: string | null;
  tournament_id: string | null;
  session_id: string | null;
  season_id: string | null;
  match_type: MatchTypeEnum;
  event_type: EventType;
  rated_flag: boolean;
  format: MatchFormat;
  format_weight: number;
  event_multiplier: number;
  completed_flag: boolean;
  winner_side: TeamSide | null;
  score_summary: string | null;
  played_at: string | null;
  submitted_by: string | null;
  confirmed_by: string | null;
  result_status: ResultStatus;
  walkover_type: WalkoverType | null;
  forfeit_player_id: string | null;
  notice_hours: number | null;
  elo_weight_override: number | null;
  admin_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface MatchParticipant {
  id: string;
  match_id: string;
  player_id: string;
  team_side: TeamSide;
  pre_rating: number;
  post_rating: number | null;
  rating_delta: number | null;
  points_scored: number;
  points_allowed: number;
  games_won: number;
  games_lost: number;
  win_flag: boolean | null;
}

export interface MatchGame {
  id: string;
  match_id: string;
  game_number: number;
  side_a_score: number;
  side_b_score: number;
}

export interface Walkover {
  id: string;
  challenge_id: string;
  match_id: string | null;
  reported_by: string;
  forfeit_player_id: string;
  walkover_type: WalkoverType;
  notice_hours: number | null;
  reported_at: string;
  grace_period_ends_at: string | null;
  admin_confirmed_by: string | null;
  admin_confirmed_at: string | null;
  admin_notes: string | null;
  status: WalkoverStatus;
  elo_penalty_applied: boolean;
  created_at: string;
  updated_at: string;
}

export interface Tournament {
  id: string;
  season_id: string | null;
  name: string;
  start_date: string;
  end_date: string | null;
  /** Default Elo multiplier for events created here — see 00109. */
  event_multiplier: number;
  placement_bonus_enabled: boolean;
  status: TournamentStatus;
  suspended_at: string | null;
  suspension_reason: string | null;
  waiver_text: string | null;
  /**
   * How many of this tournament's events one member may enter (00098).
   * NULL is uncapped, and is the default — see utils/tournament-entry-cap.
   */
  max_events_per_player: number | null;
  /**
   * Placement bonus amounts this tournament pays instead of the club's (00275),
   * in the flat platform_settings keys. NULL means the club's throughout.
   * Optional because a database without 00275 has no such column.
   */
  placement_bonus_amounts?: Record<string, unknown> | null;
  /**
   * The tournament's own daily times and venue (00304). PostgREST returns a
   * time as HH:MM:SS. Optional because a database without 00304 has none.
   */
  starts_time?: string | null;
  ends_time?: string | null;
  location?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// `TournamentParticipant` WAS HERE, and it is gone rather than renamed.
//
// It described legacy_tournament_participants — {tournament_id, player_id,
// partner_id, seed, placement, bonus_applied}, which is that table's row and
// nothing else. The name did not say so, and this file is `export *`d from the
// package root, so the shape most likely to be reached for when somebody wanted
// the LIVE tournament_participants row was the one describing the retired
// table. Nothing had made that mistake yet; the name was the trap, not a bug.
//
// The live event-based row is TournamentEventParticipant, further down this
// file — event_id, seed_number, status, check-in and Elo columns, no
// tournament_id and no partner_id. Its pair counterpart is TournamentPair.
// Note that TournamentParticipantStatus, which both of those use, is a
// different declaration that stays: it is live, and its name is only a
// near-miss for the one deleted here.

export interface Dispute {
  id: string;
  match_id: string;
  opened_by: string;
  reason_category: DisputeReason;
  description: string;
  status: DisputeStatus;
  resolution_type: DisputeResolution | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  player_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  read_flag: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AuditLog {
  id: string;
  actor_id: string | null;
  action_type: string;
  target_type: string;
  target_id: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

export interface HeadToHeadStat {
  id: string;
  player_a_id: string;
  player_b_id: string;
  match_type: MatchTypeEnum;
  total_matches: number;
  player_a_wins: number;
  player_b_wins: number;
  player_a_points: number;
  player_b_points: number;
  last_played_at: string | null;
  updated_at: string;
}

export interface PartnershipStat {
  id: string;
  player_a_id: string;
  player_b_id: string;
  matches_played: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_points_scored: number;
  total_points_conceded: number;
  avg_elo_delta: number;
  last_played_at: string | null;
  updated_at: string;
}

export interface VarsityNote {
  id: string;
  player_id: string;
  author_id: string;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface SeasonSnapshot {
  id: string;
  player_id: string;
  season_id: string;
  final_singles_elo: number;
  final_doubles_elo: number;
  singles_rank: number | null;
  doubles_rank: number | null;
  singles_matches_played: number;
  doubles_matches_played: number;
  singles_wins: number;
  singles_losses: number;
  doubles_wins: number;
  doubles_losses: number;
  captured_at: string;
}

export interface PlatformSetting {
  key: string;
  value: Record<string, unknown>;
  updated_by: string | null;
  updated_at: string;
}

export interface ReliabilityMetrics {
  id: string;
  player_id: string;
  challenges_issued: number;
  challenges_accepted: number;
  challenges_rejected: number;
  challenges_expired: number;
  matches_completed: number;
  no_shows: number;
  late_cancellations: number;
  early_withdrawals: number;
  walkovers_received: number;
  avg_confirmation_minutes: number;
  dispute_involvement_count: number;
  walkover_flag: boolean;
  updated_at: string;
}

/**
 * What a club_fees row is money FOR (00094).
 *
 * The three kinds used to be three tables. They differed only in this, which
 * is a column and not a schema — see 00094's header for the club owner's own
 * reason ("just wanted to have less db tables around").
 */
export type FeeType = 'dues' | 'tournament' | 'reinstatement' | 'event';

/**
 * The club's one fee ledger.
 *
 * Columns beyond the common five are per-kind, and which ones may be set is
 * enforced by club_fees_shape_check rather than by convention:
 *
 *   dues           season_id, and the other four NULL
 *   tournament     tournament_id (+ optional tier_id), a real player
 *   reinstatement  ban_started_at (+ ban_reason), a real player
 *   event          club_event_id, a real player (00248)
 *
 * EVERY QUERY FILTERS ON fee_type. Reading the ledger unfiltered is the leak
 * this type exists to make visible: /admin/fees gates club dues and
 * reinstatements behind two separate capabilities.
 */
export interface ClubFee {
  id: string;
  fee_type: FeeType;
  player_id: string | null;
  manual_name: string | null;
  /** NOT NULL for dues; nullable for the other two. See 00069 and 00094. */
  season_id: string | null;
  amount_cents: number | null;
  paid_at: string | null;
  marked_by: string | null;
  method: string | null;
  reference: string | null;
  /** fee_type 'tournament' only. */
  tournament_id: string | null;
  /** fee_type 'tournament' only — which tier priced it, at entry time. */
  tier_id: string | null;
  /** fee_type 'reinstatement' only — which ban episode this settled (00065). */
  ban_started_at: string | null;
  ban_reason: string | null;
  /** fee_type 'event' only: which club event it is the cost of (00248). */
  club_event_id: string | null;
  /** When an exec last sent a "please pay" reminder for this line (00248). */
  payment_reminded_at: string | null;
  created_at: string;
}

export interface TournamentFeeTier {
  id: string;
  tournament_id: string;
  name: string;
  amount_cents: number;
  is_default: boolean;
  sort_order: number;
  /**
   * Membership groups this tier prices; NULL means anyone (00094). Read by
   * selectFeeTier(), never by a page doing its own matching.
   */
  applies_to: MembershipType[] | null;
  created_at: string;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  type: AnnouncementType;
  author_id: string | null;
  pinned: boolean;
  send_push: boolean;
  target_audience: AnnouncementAudience;
  expires_at: string | null;
  status: AnnouncementStatus;
  created_at: string;
  updated_at: string;
}

export interface AnnouncementRead {
  id: string;
  announcement_id: string;
  player_id: string;
  read_at: string;
}

export interface PushSubscription {
  id: string;
  player_id: string;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  user_agent: string | null;
  active: boolean;
  created_at: string;
}

export type WaiverDocument = 'waiver' | 'code_of_conduct' | 'terms_of_use' | 'privacy_policy';

export interface LegalDocument {
  document: WaiverDocument;
  version: string;
  content: string;
  reacceptance_required_since: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface WaiverAcceptance {
  id: string;
  player_id: string;
  document: WaiverDocument;
  version: string;
  accepted_at: string;
  age_attestation: boolean;
  user_agent: string | null;
}

export interface EventWaiverAcceptance {
  id: string;
  player_id: string;
  tournament_id: string;
  waiver_hash: string;
  accepted_at: string;
  user_agent: string | null;
}

// Joined/view types
export interface PlayerWithRating extends Player {
  ratings: Rating;
}

export interface ChallengeWithParticipants extends Challenge {
  challenge_participants: (ChallengeParticipant & { player: Player })[];
  creator: Player;
}

export interface MatchWithDetails extends Match {
  match_participants: (MatchParticipant & { player: Player })[];
  match_games: MatchGame[];
}

// =============================================
// Tournament Event System Types
// =============================================

export type TournamentEventType =
  | 'mens_singles'
  | 'womens_singles'
  | 'open_singles'
  | 'mens_doubles'
  | 'womens_doubles'
  | 'mixed_doubles'
  | 'open_doubles';

/**
 * How an event is played.
 *
 * `pool_to_bracket` (00107) is BOTH of the other two, in one event row: a round
 * robin — optionally split into groups — is played first, then the qualifiers
 * are re-seeded into a knockout without ever leaving the event. It is a third
 * option beside the two-event pool→bracket link (`seeded_from_event_id`), which
 * is untouched and still works.
 *
 * `staged` (00272) is an event the organiser writes as a list of stages in
 * format_config; its matches carry a stage and no phase.
 */
export type TournamentEventFormat = 'single_elimination' | 'round_robin' | 'pool_to_bracket' | 'staged';

/**
 * Which half of a `pool_to_bracket` event a match belongs to (00107).
 *
 * NULL in the database — and `null` here — on every match of a
 * single_elimination or round_robin event: those have one phase, so naming it
 * would add a value nothing reads.
 */
export type TournamentMatchPhase = 'pool' | 'bracket';

export type TournamentMatchFormat = 'best_of_3_to_21' | 'one_game_21' | 'one_game_15' | 'one_game_11';

export type TournamentSeedingMethod = 'elo' | 'manual' | 'random';

/**
 * Where an event has got to.
 *
 * `pool_generated` and `pool_live` (00107) belong to the POOL half of a
 * `pool_to_bracket` event and are written on no other format. `bracket_generated`
 * and `live` keep their exact existing meanings — the KNOCKOUT is drawn, the
 * KNOCKOUT is running — so nothing that reads them changed meaning.
 */
export type TournamentEventStatus =
  | 'registration'
  | 'checkin'
  | 'pool_generated'
  | 'pool_live'
  | 'bracket_generated'
  | 'live'
  | 'completed';

export type TournamentParticipantStatus = 'registered' | 'checked_in' | 'withdrawn' | 'disqualified' | 'no_show';

export type TournamentMatchStatus = 'pending' | 'ready' | 'live' | 'completed' | 'walkover' | 'disputed' | 'voided';

export interface TournamentEvent {
  id: string;
  tournament_id: string;
  event_type: TournamentEventType;
  format: TournamentEventFormat;
  match_format: TournamentMatchFormat;
  // Typed shape (00046). NULL means the match_format enum still decides.
  games_per_match: number | null;
  points_per_game: number | null;
  // Pool this event draws its field from, and how to rank that pool (00046).
  seeded_from_event_id: string | null;
  // How the pool is ranked. Set when seeded_from_event_id is (00046), and
  // ALWAYS set on a pool_to_bracket event (00107), where the one row is both
  // the pool and the bracket and the two must not disagree about the order.
  seed_by: SeedBy | null;
  // The group shape (00106). On a pool_to_bracket event a flat pool is one
  // group, so qualifiers_per_group reads as "how many qualify".
  group_count: number | null;
  qualifiers_per_group: number | null;
  // How many top seeds must skip the first round of the knockout (00124). A
  // FLOOR the generator refuses to build under, never a placement instruction —
  // the bye count is fixed by the field size. 0 is the default and means no
  // promise was made. NOT NULL in the schema, so no coalesce anywhere.
  seed_skip_count: number;
  max_participants: number | null;
  seeding_method: TournamentSeedingMethod;
  elo_multiplier: number;
  placement_bonus_enabled: boolean;
  draw_locked: boolean;
  // External teams entered by name, unrated (00269). Set at creation only.
  external_event: boolean;
  // A legacy event's ladder points table (00275); NULL pays the format's
  // default. Optional because a database without 00275 has no such column.
  points_config?: unknown | null;
  status: TournamentEventStatus;
  created_at: string;
  updated_at: string;
}

export interface TournamentEventParticipant {
  id: string;
  event_id: string;
  player_id: string;
  seed_number: number | null;
  status: TournamentParticipantStatus;
  checked_in_at: string | null;
  checked_in_by: string | null;
  final_position: number | null;
  elo_before: number | null;
  elo_after: number | null;
  elo_change: number | null;
  points: number;
  added_by: string | null;
  notes: string | null;
  created_at: string;
}

export interface TournamentPair {
  id: string;
  event_id: string;
  // Both NULL on an external team (00269), whose people are external1_name and
  // external2_name instead. Never one of each.
  player1_id: string | null;
  player2_id: string | null;
  external1_name: string | null;
  external2_name: string | null;
  pair_name: string | null;
  seed_number: number | null;
  status: TournamentParticipantStatus;
  checked_in_at: string | null;
  checked_in_by: string | null;
  final_position: number | null;
  combined_elo: number | null;
  points: number;
  added_by: string | null;
  notes: string | null;
  created_at: string;
}

export interface TournamentMatch {
  id: string;
  event_id: string;
  // Which half of a pool_to_bracket event this match belongs to (00107). NULL
  // on every match of the other two formats — they have one phase.
  phase: TournamentMatchPhase | null;
  round_number: number;
  round_name: string | null;
  bracket_position: number;
  match_number: number | null;
  // This match's own shape, overriding the event's (00108). All three NULL —
  // every match written before 00108 — means the event decides, which is the
  // behaviour these columns replace nothing of. See resolveMatchShape.
  match_format: TournamentMatchFormat | null;
  games_per_match: number | null;
  points_per_game: number | null;
  participant_a_id: string | null;
  participant_b_id: string | null;
  pair_a_id: string | null;
  pair_b_id: string | null;
  winner_participant_id: string | null;
  winner_pair_id: string | null;
  loser_participant_id: string | null;
  loser_pair_id: string | null;
  scores: Array<{ a: number; b: number }> | null;
  winner_to_match_id: string | null;
  winner_to_position: 'a' | 'b' | null;
  // Where the LOSER goes — the mirror of winner_to_*, set on both semi-finals
  // when the draw includes a third-place playoff (00080). NULL everywhere else,
  // and both halves are NULL or neither (CHECK constraint).
  loser_to_match_id: string | null;
  loser_to_position: 'a' | 'b' | null;
  // This match decides 3rd vs 4th. It feeds nothing, and finalizeEvent reads it
  // to split the joint 3rd that both semi-final losers would otherwise get.
  is_third_place: boolean;
  court: string | null;
  // The tournament court (00273), console only. Absent before that migration.
  court_id?: string | null;
  scheduled_time: string | null;
  status: TournamentMatchStatus;
  walkover_winner: 'a' | 'b' | null;
  walkover_reason: string | null;
  result_entered_by: string | null;
  result_entered_at: string | null;
  is_bye: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TournamentAuditEntry {
  id: string;
  tournament_id: string | null;
  event_id: string | null;
  match_id: string | null;
  action: string;
  performed_by: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

// Joined types for tournament events
export interface TournamentEventParticipantWithPlayer extends TournamentEventParticipant {
  player: Player;
}

export interface TournamentPairWithPlayers extends TournamentPair {
  player1: Player;
  player2: Player;
}

export interface TournamentMatchWithParticipants extends TournamentMatch {
  participant_a: TournamentEventParticipantWithPlayer | null;
  participant_b: TournamentEventParticipantWithPlayer | null;
  pair_a: TournamentPairWithPlayers | null;
  pair_b: TournamentPairWithPlayers | null;
}
