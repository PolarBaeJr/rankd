// The fake PostgREST's answers for the parity check (scripts/parity.mjs).
//
// The rows are the ones apps/data-api/src/__tests__/routes.test.ts answers
// with, bait columns ("leak") included, so the parity check sees every
// whitelist the read routes apply. Both services get exactly these answers.

export const REF_A = 'a'.repeat(64);
export const REF_B = 'b'.repeat(64);
export const REF_C = 'c'.repeat(64);
export const REF_D = 'd'.repeat(64);
export const MATCH_REF = 'd'.repeat(64);
export const EXT_REF_A = 'f'.repeat(64);
export const EXT_REF_B = '9'.repeat(64);
export const SEASON = '15af1db0-ac97-499d-b583-98082a921368';
export const TOURNAMENT = '22222222-0000-0000-0000-000000000001';
export const EVENT = '33333333-0000-0000-0000-000000000001';

export function playerRow(ref) {
  return {
    player_ref: ref,
    singles_elo: 1180,
    doubles_elo: 1042,
    singles_provisional: false,
    doubles_provisional: true,
    singles_matches_played: 0,
    doubles_matches_played: 0,
    singles_wins: 0,
    singles_losses: 0,
    doubles_wins: 0,
    doubles_losses: 0,
    updated_at: '2026-09-14T04:11:55.123456+00:00',
  };
}

export function matchRow(i = 0) {
  return {
    match_ref: MATCH_REF,
    source: 'club',
    status: 'confirmed',
    counts_toward_stats: true,
    played_at: `2026-09-1${i % 10}T04:11:55.123456+00:00`,
    updated_at: '2026-09-14T05:00:00+00:00',
    season_id: SEASON,
    season_name: 'Fall 2026',
    discipline: 'singles',
    kind: 'ranked',
    rated: true,
    format: 'best_of_3',
    games_per_match: 3,
    points_per_game: 21,
    walkover: null,
    winner_side: 'a',
    score_summary: '21-15, 21-18',
    games: [
      { game: 1, a: 21, b: 15, notes: 'leak' },
      { game: 2, a: 21, b: 18 },
    ],
    sides: {
      a: [
        {
          player_ref: REF_A,
          won: true,
          rating: { before: 1200, after: 1216, delta: 16, player_id: 'leak' },
          points_scored: 42,
          points_allowed: 33,
          games_won: 2,
          games_lost: 0,
          full_name: 'leak',
          email: 'leak',
        },
      ],
      b: [{ player_ref: REF_B, won: false, rating: null, points_scored: 33, points_allowed: 42, games_won: 0, games_lost: 2 }],
    },
    tournament: null,
    notes: 'leak',
    walkover_reason: 'leak',
    player_id: 'leak',
  };
}

export function seasonRow() {
  return {
    id: SEASON,
    name: 'Fall 2026',
    term: 'fall',
    year: 2026,
    start_date: '2026-09-01',
    end_date: '2026-12-15',
    active: true,
    club_matches: 3,
    tournament_matches: 2,
    players_with_matches: 4,
    sessions: 10,
    tournaments: 1,
    events: 2,
    hidden_flag: false,
  };
}

function tournamentRow() {
  return {
    id: TOURNAMENT,
    name: 'Fall Open',
    season_id: SEASON,
    season_name: 'Fall 2026',
    start_date: '2026-10-01',
    end_date: '2026-10-02',
    status: 'completed',
    suspended: false,
    event_multiplier: 1.5,
    placement_bonus_enabled: true,
    max_events_per_player: 2,
    suspension_reason: 'leak',
    waiver_text: 'leak',
  };
}

function eventRow() {
  return {
    id: EVENT,
    event_type: 'mens_doubles',
    format: 'single_elimination',
    match_format: 'best_of_3',
    games_per_match: 3,
    points_per_game: 21,
    max_participants: 16,
    seeding_method: 'elo',
    elo_multiplier: 1,
    placement_bonus_enabled: true,
    status: 'completed',
    group_count: null,
    qualifiers_per_group: null,
    seeded_from_event_id: null,
    external_event: false,
    notes: 'leak',
  };
}

function stagedEventRow() {
  const scoring = { best_of: 1, target: 21, win_by_two: true, cap: 30, handicap: true, forfeit: null };
  return {
    ...eventRow(),
    event_type: 'open_doubles',
    format: 'staged',
    rated: false,
    current_stage: 2,
    stages: [
      {
        index: 1,
        key: 'groups',
        name: 'Group stage',
        kind: 'groups',
        rated: false,
        scoring: { ...scoring, forfeit: { winner: 21, loser: 0, court: 'leak' } },
        pools: 2,
        groups_per_pool: 2,
        group_size: 'auto',
        tiebreaks: ['wins', 'leak', 'point_diff', 7],
        size: null,
        third_place: null,
        matches: null,
        courts: { mode: 'shared', courts: ['leak'] },
        entrants: 'leak',
        assignment: 'leak',
      },
      {
        index: 2,
        key: 'finals',
        name: 'Finals',
        kind: 'matches',
        rated: false,
        scoring,
        pools: null,
        groups_per_pool: null,
        group_size: null,
        tiebreaks: null,
        size: null,
        third_place: null,
        matches: [{ label: 'final', name: 'Final', winner_place: 1, loser_place: 2, court: 'leak', a: 'leak' }],
      },
    ],
    categories: [
      { key: 'mens', label: "Men's", note: 'leak' },
      { key: 'womens', label: "Women's" },
    ],
    head_starts: { womens: { mens: 3, mixed: 'leak' }, mixed: 'leak' },
    points_table: { by_place: [50, 30, 'leak'], rest: 5, participation: 1, per_win: 2, bonuses: 'leak' },
    leak: 'leak',
  };
}

const DRAW_STAGE_COLUMNS = [
  { stage: 1, pool_number: 1, group_number: 2, slot: 1, match_label: null, handicap_a: 3, handicap_b: 0, court_id: 'leak' },
  { stage: 2, pool_number: null, group_number: null, slot: null, match_label: 'final', handicap_a: 5, handicap_b: 0 },
  { stage: 1, pool_number: 2, group_number: 1, slot: 2, match_label: null, handicap_a: 0, handicap_b: 0 },
];

function entrants() {
  return [
    {
      event_id: EVENT,
      player_refs: [REF_A, REF_B],
      seed: 1,
      status: 'active',
      final_position: 1,
      group_number: null,
      points: null,
      elo_before: null,
      elo_after: null,
      elo_change: null,
      combined_elo: 2216,
      external: false,
      external_ref: null,
      pair_name: 'leak',
    },
    {
      event_id: EVENT,
      player_refs: [],
      seed: null,
      status: 'registered',
      final_position: null,
      group_number: 1,
      points: 2,
      elo_before: null,
      elo_after: null,
      elo_change: null,
      combined_elo: null,
      external: true,
      external_ref: EXT_REF_A,
      pair_name: 'leak',
      external1_name: 'leak',
      external2_name: 'leak',
    },
  ];
}

function draw() {
  return [
    {
      match_ref: MATCH_REF,
      round_number: 1,
      round_name: 'Final',
      phase: 'bracket',
      bracket_position: 1,
      match_number: 1,
      is_bye: false,
      is_third_place: false,
      scheduled_time: '2026-10-02T20:00:00+00:00',
      status: 'completed',
      winner_to: null,
      loser_to: null,
      withheld: false,
      sides: {
        a: [{ player_ref: REF_A, external: false, external_ref: null }],
        b: [{ player_ref: REF_B, external: false, external_ref: null }],
      },
      winner_side: 'a',
      games: [{ game: 1, a: 21, b: 10 }],
      court: 'leak',
      walkover_reason: 'leak',
    },
    {
      match_ref: 'e'.repeat(64),
      round_number: 1,
      round_name: 'Semi',
      phase: 'bracket',
      bracket_position: 2,
      match_number: 2,
      is_bye: false,
      is_third_place: false,
      scheduled_time: null,
      status: 'disputed',
      winner_to: { match_ref: MATCH_REF, position: 'b' },
      loser_to: null,
      withheld: true,
      sides: { a: [{ player_ref: REF_A }], b: [] },
      winner_side: 'a',
      games: [{ game: 1, a: 21, b: 19 }],
    },
    {
      match_ref: 'c'.repeat(64),
      round_number: 1,
      round_name: null,
      phase: 'group',
      bracket_position: 3,
      match_number: 3,
      is_bye: false,
      is_third_place: false,
      scheduled_time: null,
      status: 'completed',
      winner_to: null,
      loser_to: null,
      withheld: false,
      sides: {
        a: [{ player_ref: null, external: true, external_ref: EXT_REF_A, name: 'leak' }],
        b: [{ player_ref: null, external: true, external_ref: EXT_REF_B }],
      },
      winner_side: 'b',
      games: [{ game: 1, a: 9, b: 15 }],
    },
  ];
}

/**
 * Every RPC the services call, beyond data_api_verify_key, as a function of
 * the call's arguments. The two write functions answer one row per item.
 */
export function rpcAnswers() {
  const published = new Set([REF_A, REF_B]);
  const players = [playerRow(REF_A), playerRow(REF_B)];
  return {
    data_api_players: () => players,
    data_api_player_by_ref: (b) => players.filter((p) => p.player_ref === b.p_player_ref),
    data_api_active_season: () => [seasonRow()],
    data_api_player_published: (b) => (published.has(b.p_player_ref) ? [{ published: true }] : []),
    data_api_matches: (b) =>
      Array.from({ length: Math.min(Number(b.p_limit) || 1, 3) }, (_, i) => matchRow(i)),
    data_api_match_by_ref: (b) => (b.p_match_ref === MATCH_REF ? [matchRow()] : []),
    data_api_head_to_head: () => [
      { relation: 'opponents', discipline: 'singles', matches: 3, wins: 2, losses: 1 },
      { relation: 'partners', discipline: 'doubles', matches: 1, wins: 1, losses: 0 },
    ],
    data_api_player_seasons: () => [
      {
        season_id: SEASON,
        season_name: 'Fall 2026',
        active: true,
        start_date: '2026-09-01',
        discipline: 'singles',
        matches: 3,
        wins: 2,
        losses: 1,
        games_won: 5,
        games_lost: 3,
        points_scored: 150,
        points_allowed: 120,
        final_singles_elo: null,
        final_doubles_elo: null,
      },
      {
        season_id: '44444444-0000-0000-0000-000000000001',
        season_name: 'Summer 2026',
        active: false,
        start_date: '2026-05-01',
        discipline: null,
        matches: null,
        wins: null,
        losses: null,
        games_won: null,
        games_lost: null,
        points_scored: null,
        points_allowed: null,
        final_singles_elo: 1210,
        final_doubles_elo: 1100,
      },
    ],
    data_api_rating_history: () => [
      {
        at: '2026-09-14T04:11:55+00:00',
        discipline: 'singles',
        kind: 'match',
        source: 'club',
        match_ref: MATCH_REF,
        before: 1200,
        after: 1216,
        delta: 16,
        player_id: 'leak',
      },
    ],
    data_api_seasons: (b) => (b.p_season_id === undefined || b.p_season_id === SEASON ? [seasonRow()] : []),
    data_api_season_header: (b) => (b.p_season_id === SEASON ? [{ id: SEASON, name: 'Fall 2026', active: true }] : []),
    data_api_season_standings: () => [
      {
        source: 'live',
        player_ref: REF_A,
        singles_elo: 1216,
        doubles_elo: 1000,
        singles_rank: 1,
        doubles_rank: 2,
        matches: 3,
        wins: 2,
        losses: 1,
        full_name: 'leak',
      },
    ],
    data_api_tournaments: (b) =>
      b.p_tournament_id === undefined || b.p_tournament_id === TOURNAMENT ? [tournamentRow()] : [],
    data_api_tournament_events: (b) => (b.p_tournament_id === TOURNAMENT ? [eventRow()] : []),
    data_api_tournament_entrants: () => entrants(),
    data_api_tournament_draw: () => draw(),
    data_api_tournament_events_v2: (b) => (b.p_tournament_id === TOURNAMENT ? [stagedEventRow()] : []),
    data_api_tournament_entrants_v2: () =>
      entrants().map((r, i) => ({ ...r, team_category: i === 0 ? 'mens' : 'womens' })),
    data_api_tournament_draw_v2: () => draw().map((r, i) => ({ ...r, ...DRAW_STAGE_COLUMNS[i] })),
    data_api_sessions: () => [
      {
        id: '55555555-0000-0000-0000-000000000001',
        name: 'Tuesday drop-in',
        season_id: SEASON,
        season_name: 'Fall 2026',
        date: '2027-01-19',
        starts_at: '2027-01-20T02:00:00+00:00',
        ends_at: '2027-01-20T04:00:00+00:00',
        location: 'Gym',
        status: 'scheduled',
        track: 'drop_in',
        require_scan_to_check_in: true,
        rsvp_going: 12,
        attended: 0,
        notes: 'leak',
      },
    ],
    data_api_club_events: () => [
      {
        id: '66666666-0000-0000-0000-000000000001',
        title: 'Social',
        kind: 'social',
        location: 'Hall',
        starts_at: '2027-01-25T02:00:00+00:00',
        ends_at: null,
        status: 'published',
        cancelled_at: null,
        capacity: 40,
        cost_cents: 500,
        signup_opens_at: null,
        signup_closes_at: null,
        signups: 7,
        description: 'leak',
      },
    ],
    data_api_write_predictions: (b) =>
      (Array.isArray(b.p_predictions) ? b.p_predictions : []).map((_, i) => ({
        item: i,
        status: i % 2 === 0 ? 'created' : 'replaced',
        reason: null,
      })),
    data_api_delete_predictions: (b) =>
      (Array.isArray(b.p_matchups) ? b.p_matchups : []).map((_, i) => ({
        item: i,
        status: i % 2 === 0 ? 'deleted' : 'not_found',
        reason: null,
      })),
    data_api_import_registration: (b) => {
      const entries = Array.isArray(b.p_payload?.entries) ? b.p_payload.entries : [];
      return entries.map((e, i) => ({
        item: i + 1,
        event_id: e.event_id,
        status: ['entered', 'pending', 'refused'][i % 3],
        reason: i % 3 === 0 ? null : 'event_full',
        replayed: false,
      }));
    },
  };
}
