// Row and joined-row shapes for the admin tournament pages/tabs, derived from
// the generated Database type. The *With* types mirror the exact joined
// selects issued by the page-level data fetching (tournaments/page.tsx and
// tournaments/[id]/events/[eventId]/page.tsx).
import type { Database } from '@badminton/shared';

type Tables = Database['public']['Tables'];

export type TournamentRow = Tables['tournaments']['Row'];
export type TournamentEventRow = Tables['tournament_events']['Row'] & {
  /** The group shape (00106) and, on a pool_to_bracket event, how many qualify. */
  group_count?: number | null;
  qualifiers_per_group?: number | null;
  /** How many top seeds must skip the first round (00124). NOT NULL, 0 = none. */
  seed_skip_count?: number | null;
};
// COLUMNS THE GENERATED TYPE DOES NOT KNOW ABOUT YET. database.gen.ts is
// generated from the live database, and 00107/00108 have not been applied there
// — the same situation 00106's group_number was in, which the code worked
// around with a cast at every read site. Declaring them once here is the same
// workaround done in one place, and it disappears of its own accord the next
// time the types are regenerated: an intersection with properties the base type
// already has is the base type.
export type TournamentMatchRow = Tables['tournament_matches']['Row'] & {
  /** Which half of a pool_to_bracket event this match is in (00107). */
  phase?: string | null;
  /** This match's own shape, overriding the event's (00108). */
  match_format?: string | null;
  games_per_match?: number | null;
  points_per_game?: number | null;
  /**
   * Who has said they are present and ready to play THIS match (00135) — the
   * member from their phone, or an exec at the desk on their behalf. One entry
   * per person, so a doubles match can be 3 of 4.
   *
   * NOT the same thing as `status === 'ready'`, which means only that both sides
   * are known. Optional here for the reason the block above gives: the page
   * selects `*`, so it arrives as soon as the migration is applied and is simply
   * absent before that.
   */
  ready_player_ids?: string[] | null;
  /**
   * The exec's own sentence about this match — a void reason, a no-show note,
   * the words behind a walkover.
   *
   * NOT a column. 00118 moved free text off `tournament_matches` into
   * `tournament_match_notes` and 00122 dropped the old column, so this arrives
   * joined, and the page nulls it for anyone without the capability to read a
   * private note. It belongs in this block rather than the generated types for
   * the opposite reason to the fields above: those are columns the types have
   * not caught up with, this one is a column that no longer exists.
   *
   * It went unnoticed because the generated types were stale enough to still
   * declare the dropped column — regenerating them for 00163 is what surfaced
   * the four read sites in ScoreEntryDialog.
   */
  notes?: string | null;
};
export type TournamentParticipantRow = Tables['tournament_participants']['Row'];
export type TournamentPairRow = Tables['tournament_pairs']['Row'];

export type PlayerSummary = Pick<Tables['players']['Row'], 'id' | 'full_name' | 'avatar_url'>;

export type RatingsSummary = Pick<
  Tables['ratings']['Row'],
  | 'singles_elo'
  | 'doubles_elo'
  | 'singles_provisional'
  | 'doubles_provisional'
  | 'singles_matches_played'
  | 'doubles_matches_played'
>;

// Singles participant with the player (+ ratings) embed. Supabase may return
// the ratings embed as object-or-array — normalize with pickOne.
export type ParticipantWithPlayer = TournamentParticipantRow & {
  player: (PlayerSummary & { ratings: RatingsSummary | RatingsSummary[] | null }) | null;
};

// Doubles pair with both player embeds.
export type PairWithPlayers = TournamentPairRow & {
  player1: PlayerSummary | null;
  player2: PlayerSummary | null;
};

// One member waiting for a place in a full event (00278), in queue order.
export type WaitlistEntry = {
  id: string;
  player_id: string;
  joined_at: string;
  player: PlayerSummary | null;
};

// One entrant asked to confirm their place (00325): ids and how it stands.
export type ConfirmationRow = {
  player_id: string;
  participant_id: string | null;
  pair_id: string | null;
  status: 'pending' | 'confirmed' | 'released' | 'unreached' | 'void';
};

// A waiting change to a played team's category (00279). A null category is
// Unset.
export type CategoryRequest = {
  id: string;
  pair_id: string;
  from_category: string | null;
  to_category: string | null;
  reason: string;
  requested_by: string | null;
  requested_at: string;
  requester: { full_name: string } | null;
};

// A tab entry is a pair (doubles events) or a participant (singles events).
export type TournamentEntry = ParticipantWithPlayer | PairWithPlayers;

// Shape of one game inside tournament_matches.scores (stored as Json).
export type GameScore = { a: number; b: number };

export type RoundRobinStanding = {
  id: string;
  name: string;
  wins: number;
  losses: number;
  pf: number;
  pa: number;
};

// tournaments/page.tsx selects `*, tournament_events(count)`, with a
// fallback plain `*` select if the joined query fails.
export type TournamentWithEventCount = TournamentRow & {
  tournament_events?: { count: number }[] | { count: number } | null;
};
