import { describe, it, expect } from 'vitest';
import {
  loginSchema,
  profileSchema,
  challengeCreateSchema,
  matchResultSchema,
  disputeSchema,
  sessionCreateSchema,
  tournamentCreateSchema,
  tournamentSuspendSchema,
  tournamentStatusUpdateSchema,
  adminPlayerUpdateSchema,
  walkoverReportSchema,
  disputeResolveSchema,
  feeMarkSchema,
  feeSubmissionSchema,
  seasonFeeSchema,
  sessionGroupSchema,
  manualFeeSchema,
  feePastePreviewSchema,
  feeTierSchema,
  tournamentFeeMarkSchema,
  reinstatementSchema,
  reinstatementPaymentSchema,
  adminMatchCreateSchema,
  banSchema,
  playerFlagsSchema,
  reliabilityAdjustSchema,
  legalAcceptanceSchema,
  legalDocumentUpdateSchema,
  eventWaiverTemplateUpdateSchema,
  sessionIntentSchema,
  otherIncomeSchema,
  clubExpenseSchema,
} from '../schemas';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('loginSchema', () => {
  it('accepts a valid email', () => {
    expect(loginSchema.safeParse({ email: 'player@example.com' }).success).toBe(true);
  });
  it('rejects a malformed email', () => {
    expect(loginSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});

describe('profileSchema', () => {
  it('accepts a valid profile', () => {
    expect(
      profileSchema.safeParse({
        first_name: 'Alice',
        last_name: 'Lovelace',
        display_name: 'Ali',
        bio: 'Hello',
      }).success,
    ).toBe(true);
  });
  it('accepts a mononym (no last name)', () => {
    expect(profileSchema.safeParse({ first_name: 'Cher', last_name: '' }).success).toBe(true);
  });
  it('rejects an empty first name', () => {
    expect(profileSchema.safeParse({ first_name: '' }).success).toBe(false);
  });
  it('rejects a last name longer than 40 chars', () => {
    expect(
      profileSchema.safeParse({ first_name: 'Alice', last_name: 'x'.repeat(41) }).success,
    ).toBe(false);
  });
  it('rejects a bio longer than 500 chars', () => {
    expect(
      profileSchema.safeParse({ first_name: 'Alice', bio: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
});

describe('challengeCreateSchema', () => {
  const base = {
    type: 'singles' as const,
    rated_flag: true,
    format: 'bo3_21' as const,
    opponent_id: UUID_A,
  };
  it('accepts a valid singles challenge', () => {
    expect(challengeCreateSchema.safeParse(base).success).toBe(true);
  });
  it('accepts a valid doubles challenge with partner', () => {
    expect(
      challengeCreateSchema.safeParse({
        ...base,
        type: 'doubles',
        partner_id: UUID_B,
      }).success,
    ).toBe(true);
  });
  it('rejects an unknown format', () => {
    expect(
      challengeCreateSchema.safeParse({ ...base, format: 'bo5_21' }).success,
    ).toBe(false);
  });
  it('rejects a non-UUID opponent_id', () => {
    expect(
      challengeCreateSchema.safeParse({ ...base, opponent_id: 'not-a-uuid' }).success,
    ).toBe(false);
  });
  it('accepts 21 points per game and a best of 7', () => {
    expect(challengeCreateSchema.safeParse({ ...base, points_per_game: 21 }).success).toBe(true);
    expect(challengeCreateSchema.safeParse({ ...base, games_per_match: 7 }).success).toBe(true);
  });
  it('accepts a game played to 30 and rejects one played to 31', () => {
    expect(challengeCreateSchema.safeParse({ ...base, points_per_game: 30 }).success).toBe(true);
    expect(challengeCreateSchema.safeParse({ ...base, points_per_game: 31 }).success).toBe(false);
  });
  it('defaults event_type to rated_challenge', () => {
    const result = challengeCreateSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.event_type).toBe('rated_challenge');
  });
});

describe('matchResultSchema', () => {
  const game = { game_number: 1, side_a_score: 21, side_b_score: 15 };
  it('accepts a 1-game result', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [game],
        completed: true,
      }).success,
    ).toBe(true);
  });
  it('rejects 0 games', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [],
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('rejects more than 7 games', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: Array.from({ length: 8 }, (_, i) => ({ ...game, game_number: i + 1 })),
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('accepts a five-game 3-2 result', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [
          { game_number: 1, side_a_score: 21, side_b_score: 15 },
          { game_number: 2, side_a_score: 15, side_b_score: 21 },
          { game_number: 3, side_a_score: 21, side_b_score: 19 },
          { game_number: 4, side_a_score: 18, side_b_score: 21 },
          { game_number: 5, side_a_score: 21, side_b_score: 17 },
        ],
        completed: true,
      }).success,
    ).toBe(true);
  });
  it('accepts a seven-game 4-3 result', () => {
    const scores: [number, number][] = [[21, 15], [15, 21], [21, 19], [18, 21], [21, 17], [19, 21], [30, 29]];
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: scores.map(([a, b], i) => ({ game_number: i + 1, side_a_score: a, side_b_score: b })),
        completed: true,
      }).success,
    ).toBe(true);
  });
  it('rejects a negative score', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [{ game_number: 1, side_a_score: -1, side_b_score: 15 }],
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('accepts 39-38, the cap of a game to 30', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [{ game_number: 1, side_a_score: 39, side_b_score: 38 }],
        completed: true,
      }).success,
    ).toBe(true);
  });
  it('rejects a score above 39', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [{ game_number: 1, side_a_score: 40, side_b_score: 15 }],
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('rejects a tied game', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [{ game_number: 1, side_a_score: 21, side_b_score: 21 }],
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('rejects a winner_side that did not win a majority of games', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'b',
        games: [game],
        completed: true,
      }).success,
    ).toBe(false);
    expect(
      matchResultSchema.safeParse({
        winner_side: 'b',
        games: [
          { game_number: 1, side_a_score: 21, side_b_score: 15 },
          { game_number: 2, side_a_score: 15, side_b_score: 21 },
          { game_number: 3, side_a_score: 21, side_b_score: 19 },
        ],
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('accepts a valid bo3 result where the winner took 2 of 3 games', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [
          { game_number: 1, side_a_score: 21, side_b_score: 15 },
          { game_number: 2, side_a_score: 15, side_b_score: 21 },
          { game_number: 3, side_a_score: 21, side_b_score: 19 },
        ],
        completed: true,
      }).success,
    ).toBe(true);
  });
});

describe('disputeSchema', () => {
  it('accepts a valid dispute', () => {
    expect(
      disputeSchema.safeParse({
        match_id: UUID_A,
        reason_category: 'score_wrong',
        description: 'The score was misreported as 21-19.',
      }).success,
    ).toBe(true);
  });
  it('rejects a description shorter than 10 chars', () => {
    expect(
      disputeSchema.safeParse({
        match_id: UUID_A,
        reason_category: 'score_wrong',
        description: 'too short',
      }).success,
    ).toBe(false);
  });
});

describe('sessionCreateSchema', () => {
  it('accepts a valid session', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Tuesday Open',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
      }).success,
    ).toBe(true);
  });
  it('rejects a name shorter than 2 chars', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'A',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
      }).success,
    ).toBe(false);
  });
  it('accepts a valid weekly recurrence', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Tuesday Open',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
        repeat_until: '2026-05-08',
      }).success,
    ).toBe(true);
  });
  it('rejects a repeat_until before the start date', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Tuesday Open',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
        repeat_until: '2026-04-03',
      }).success,
    ).toBe(false);
  });
  it('accepts a weekly recurrence with excluded dates', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Tuesday Open',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
        repeat_until: '2026-05-08',
        excluded_dates: ['2026-04-17', '2026-05-01'],
      }).success,
    ).toBe(true);
  });
  it('rejects more than 40 excluded dates', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Tuesday Open',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
        repeat_until: '2026-05-08',
        excluded_dates: Array.from({ length: 41 }, (_, i) => `2026-04-${i}`),
      }).success,
    ).toBe(false);
  });
  // The default is what keeps every pre-existing caller — none of which sends
  // repeat_frequency — on the weekly behaviour they were written against.
  it('defaults repeat_frequency to weekly', () => {
    const parsed = sessionCreateSchema.safeParse({
      name: 'Tuesday Open',
      date: '2026-04-10',
      location: 'Lorne Davies Complex',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.repeat_frequency).toBe('weekly');
  });
  // A weekend camp: two consecutive days, made in one submit.
  it('accepts a daily recurrence spanning a weekend', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Spring Camp',
        date: '2026-04-11',
        location: 'Lorne Davies Complex',
        repeat_until: '2026-04-12',
        repeat_frequency: 'daily',
      }).success,
    ).toBe(true);
  });
  it('rejects a repeat_frequency it does not know', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Spring Camp',
        date: '2026-04-11',
        location: 'Lorne Davies Complex',
        repeat_until: '2026-04-12',
        repeat_frequency: 'fortnightly',
      }).success,
    ).toBe(false);
  });
});

describe('tournamentCreateSchema', () => {
  const base = {
    name: 'Spring Open',
    scope: 'open' as const,
    type: 'internal' as const,
    format: 'singles' as const,
    start_date: '2026-05-01',
  };
  it('accepts a valid tournament with defaults', () => {
    const result = tournamentCreateSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event_multiplier).toBeCloseTo(1.15);
      expect(result.data.placement_bonus_enabled).toBe(true);
    }
  });
  it('bounds event_multiplier by ELO_MULTIPLIER_BOUNDS', () => {
    expect(tournamentCreateSchema.safeParse({ ...base, event_multiplier: 0.25 }).success).toBe(true);
    expect(tournamentCreateSchema.safeParse({ ...base, event_multiplier: 5 }).success).toBe(true);
    expect(tournamentCreateSchema.safeParse({ ...base, event_multiplier: 0.24 }).success).toBe(false);
    expect(tournamentCreateSchema.safeParse({ ...base, event_multiplier: 5.01 }).success).toBe(false);
  });
  // The scope/type rejection tests went with 00108: those columns decided
  // nothing and were dropped, so asserting that a bad value for them is
  // refused was asserting a rule about a field that no longer exists.
});

describe('tournamentSuspendSchema', () => {
  it('accepts a valid suspension', () => {
    expect(
      tournamentSuspendSchema.safeParse({ tournament_id: UUID_A, reason: 'Venue flooded' }).success,
    ).toBe(true);
  });
  it('rejects an empty reason', () => {
    expect(
      tournamentSuspendSchema.safeParse({ tournament_id: UUID_A, reason: '' }).success,
    ).toBe(false);
  });
});

describe('tournamentStatusUpdateSchema', () => {
  it('accepts each of the four statuses the column allows', () => {
    for (const status of ['draft', 'active', 'completed', 'archived'] as const) {
      expect(
        tournamentStatusUpdateSchema.safeParse({ tournament_id: UUID_A, status }).success, status,
      ).toBe(true);
    }
  });

  // The action took `status: string` and handed it to `.update({ status })`, so
  // a plausible-looking word nobody defined reached the column — and a rejected
  // UPDATE resolves rather than throws.
  it('rejects a status the tournament lifecycle has never had', () => {
    expect(
      tournamentStatusUpdateSchema.safeParse({ tournament_id: UUID_A, status: 'finished' }).success,
    ).toBe(false);
  });
});

describe('adminPlayerUpdateSchema (Phase 2 enum simplification guard)', () => {
  it('accepts each of the 4 valid statuses', () => {
    for (const status of ['competitive', 'recreational', 'suspended', 'pending_approval'] as const) {
      const result = adminPlayerUpdateSchema.safeParse({ status, reason: 'test' });
      expect(result.success).toBe(true);
    }
  });
  it('rejects legacy player statuses', () => {
    for (const status of ['eligible_competitive', 'competitive_associate', 'alumni_external', 'inactive']) {
      const result = adminPlayerUpdateSchema.safeParse({ status, reason: 'test' });
      expect(result.success).toBe(false);
    }
  });
  // THE ROLE CASES ARE GONE BECAUSE THE FIELD IS. This schema used to accept
  // 'player' / 'admin' and refuse the legacy names, because updatePlayer wrote
  // `role`. It does not: role, is_exec and is_trainer ARE console access, and the
  // club owner moved that to the Permissions page alone.
  //
  // Rewritten to the new claim rather than deleted, and the claim is deliberately
  // NOT "the parse fails". Zod strips unknown keys, so a payload naming role
  // still parses — what matters is that it does not survive, and that the runtime
  // guard refuses it outright besides (see apps/admin's player-field-access
  // suite, which asserts an ADMIN is refused and that nothing is written).
  it('carries no console-access column at all, whatever a payload names', () => {
    for (const field of ['role', 'is_exec', 'is_trainer'] as const) {
      const parsed = adminPlayerUpdateSchema.parse({ [field]: field === 'role' ? 'admin' : true, reason: 'test' });
      expect(field in parsed, `${field} survived the parse`).toBe(false);
    }
    // Including the legacy role names this used to name one by one — there is no
    // enum left for them to be outside of.
    for (const role of ['moderator', 'coach_executive', 'player', 'admin']) {
      expect('role' in adminPlayerUpdateSchema.parse({ role, reason: 'test' })).toBe(false);
    }
  });
  it('requires reason', () => {
    expect(adminPlayerUpdateSchema.safeParse({ status: 'competitive' }).success).toBe(false);
  });
  it('rejects an Elo outside the 100-1500 cap', () => {
    expect(
      adminPlayerUpdateSchema.safeParse({ singles_elo: 50, reason: 'test' }).success,
    ).toBe(false);
    expect(
      adminPlayerUpdateSchema.safeParse({ singles_elo: 1600, reason: 'test' }).success,
    ).toBe(false);
  });
  it('accepts an Elo within the 100-1500 cap', () => {
    expect(
      adminPlayerUpdateSchema.safeParse({ singles_elo: 1500, reason: 'test' }).success,
    ).toBe(true);
  });
});

describe('walkoverReportSchema', () => {
  it('accepts each walkover_type', () => {
    for (const walkover_type of ['withdrawal', 'no_show'] as const) {
      const result = walkoverReportSchema.safeParse({
        challenge_id: UUID_A,
        forfeit_player_id: UUID_B,
        walkover_type,
      });
      expect(result.success).toBe(true);
    }
  });
  it('rejects an unknown walkover_type', () => {
    expect(
      walkoverReportSchema.safeParse({
        challenge_id: UUID_A,
        forfeit_player_id: UUID_B,
        walkover_type: 'noshow',
      }).success,
    ).toBe(false);
  });
  it('does not require games (walkovers legitimately have none)', () => {
    expect(
      walkoverReportSchema.safeParse({
        challenge_id: UUID_A,
        forfeit_player_id: UUID_B,
        walkover_type: 'no_show',
        notice_hours: 2,
      }).success,
    ).toBe(true);
  });
});

describe('feeMarkSchema', () => {
  it('accepts a minimal valid input', () => {
    expect(
      feeMarkSchema.safeParse({ player_id: UUID_A, season_id: UUID_B }).success,
    ).toBe(true);
  });
  it('accepts optional amount_cents and method', () => {
    expect(
      feeMarkSchema.safeParse({
        player_id: UUID_A,
        season_id: UUID_B,
        amount_cents: 1500,
        method: 'e-transfer',
      }).success,
    ).toBe(true);
  });
  it('rejects a non-UUID player_id', () => {
    expect(
      feeMarkSchema.safeParse({ player_id: 'not-a-uuid', season_id: UUID_B }).success,
    ).toBe(false);
  });
  it('rejects a non-UUID season_id', () => {
    expect(feeMarkSchema.safeParse({ player_id: UUID_A, season_id: 'not-a-uuid' }).success).toBe(false);
  });
  it('rejects a non-positive or fractional amount_cents', () => {
    expect(
      feeMarkSchema.safeParse({ player_id: UUID_A, season_id: UUID_B, amount_cents: 0 }).success,
    ).toBe(false);
    expect(
      feeMarkSchema.safeParse({ player_id: UUID_A, season_id: UUID_B, amount_cents: -100 }).success,
    ).toBe(false);
    expect(
      feeMarkSchema.safeParse({ player_id: UUID_A, season_id: UUID_B, amount_cents: 15.5 }).success,
    ).toBe(false);
  });
  it('rejects a method longer than 40 chars', () => {
    expect(
      feeMarkSchema.safeParse({
        player_id: UUID_A,
        season_id: UUID_B,
        method: 'x'.repeat(41),
      }).success,
    ).toBe(false);
  });
});

describe('seasonFeeSchema', () => {
  it('accepts non-negative integer fees', () => {
    expect(
      seasonFeeSchema.safeParse({ competitive_fee_cents: 4000, recreational_fee_cents: 0 }).success,
    ).toBe(true);
  });
  it('rejects a negative fee', () => {
    expect(
      seasonFeeSchema.safeParse({ competitive_fee_cents: -1, recreational_fee_cents: 0 }).success,
    ).toBe(false);
  });
  it('rejects a fractional fee', () => {
    expect(
      seasonFeeSchema.safeParse({ competitive_fee_cents: 40.5, recreational_fee_cents: 0 }).success,
    ).toBe(false);
  });
});

describe('sessionGroupSchema', () => {
  it('accepts the known groups', () => {
    expect(sessionGroupSchema.safeParse('competitive').success).toBe(true);
    expect(sessionGroupSchema.safeParse('recreational').success).toBe(true);
    expect(sessionGroupSchema.safeParse('all').success).toBe(true);
  });
  it('rejects an unknown group', () => {
    expect(sessionGroupSchema.safeParse('varsity').success).toBe(false);
  });
});

describe('feePastePreviewSchema', () => {
  it('accepts pasted text against a season', () => {
    expect(feePastePreviewSchema.safeParse({ season_id: UUID_A, text: 'jane@sfu.ca' }).success).toBe(true);
  });
  it('rejects empty text', () => {
    expect(feePastePreviewSchema.safeParse({ season_id: UUID_A, text: '' }).success).toBe(false);
  });
  it('rejects text over 50,000 characters', () => {
    expect(feePastePreviewSchema.safeParse({ season_id: UUID_A, text: 'x'.repeat(50001) }).success).toBe(false);
    expect(feePastePreviewSchema.safeParse({ season_id: UUID_A, text: 'x'.repeat(50000) }).success).toBe(true);
  });
  it('rejects a non-UUID season_id', () => {
    expect(feePastePreviewSchema.safeParse({ season_id: 'nope', text: 'jane@sfu.ca' }).success).toBe(false);
  });
  it('rejects an unknown key, being strict', () => {
    expect(
      feePastePreviewSchema.safeParse({ season_id: UUID_A, text: 'jane@sfu.ca', player_ids: [UUID_B] }).success,
    ).toBe(false);
  });
});

describe('manualFeeSchema', () => {
  it('accepts a name against a season', () => {
    expect(
      manualFeeSchema.safeParse({ season_id: UUID_A, manual_name: 'Jane Doe' }).success,
    ).toBe(true);
  });
  it('accepts optional amount_cents and method', () => {
    expect(
      manualFeeSchema.safeParse({
        season_id: UUID_A,
        manual_name: 'Jane Doe',
        amount_cents: 2500,
        method: 'cash',
      }).success,
    ).toBe(true);
  });
  it('rejects an empty name', () => {
    expect(manualFeeSchema.safeParse({ season_id: UUID_A, manual_name: '' }).success).toBe(false);
  });
  it('normalises an optional email to the trimmed lowercase form the column requires', () => {
    const r = manualFeeSchema.safeParse({ season_id: UUID_A, manual_name: 'Jane Doe', email: '  Jane.Doe@SFU.ca ' });
    expect(r.success && r.data.email).toBe('jane.doe@sfu.ca');
  });
  it('treats a blank email as absent rather than invalid', () => {
    for (const email of ['', '   ']) {
      const r = manualFeeSchema.safeParse({ season_id: UUID_A, manual_name: 'Jane Doe', email });
      expect(r.success).toBe(true);
      expect(r.success && r.data.email).toBeUndefined();
    }
  });
  it('rejects a malformed or oversized email', () => {
    expect(manualFeeSchema.safeParse({ season_id: UUID_A, manual_name: 'Jane Doe', email: 'jane' }).success).toBe(false);
    const long = `${'a'.repeat(250)}@x.ca`;
    expect(manualFeeSchema.safeParse({ season_id: UUID_A, manual_name: 'Jane Doe', email: long }).success).toBe(false);
  });
  it('rejects a name longer than 80 chars', () => {
    expect(
      manualFeeSchema.safeParse({ season_id: UUID_A, manual_name: 'x'.repeat(81) }).success,
    ).toBe(false);
  });
  it('rejects a non-UUID season_id', () => {
    expect(manualFeeSchema.safeParse({ season_id: 'nope', manual_name: 'Jane' }).success).toBe(false);
  });
});

describe('feeTierSchema', () => {
  const base = {
    tournament_id: UUID_A,
    name: 'Member',
    amount_cents: 500,
    is_default: true,
  };
  it('accepts a valid tier', () => {
    expect(feeTierSchema.safeParse(base).success).toBe(true);
  });
  it('rejects an empty name', () => {
    expect(feeTierSchema.safeParse({ ...base, name: '' }).success).toBe(false);
  });
  it('rejects a negative amount_cents', () => {
    expect(feeTierSchema.safeParse({ ...base, amount_cents: -1 }).success).toBe(false);
  });
});

describe('tournamentFeeMarkSchema', () => {
  it('accepts a minimal valid input', () => {
    expect(
      tournamentFeeMarkSchema.safeParse({ tournament_id: UUID_A, player_id: UUID_B }).success,
    ).toBe(true);
  });
  it('accepts an amount_cents of 0', () => {
    expect(
      tournamentFeeMarkSchema.safeParse({
        tournament_id: UUID_A,
        player_id: UUID_B,
        amount_cents: 0,
      }).success,
    ).toBe(true);
  });
  it('rejects a non-UUID player_id', () => {
    expect(
      tournamentFeeMarkSchema.safeParse({ tournament_id: UUID_A, player_id: 'x' }).success,
    ).toBe(false);
  });
});

describe('reinstatementSchema', () => {
  it('accepts a minimal valid input', () => {
    expect(reinstatementSchema.safeParse({ player_id: UUID_A }).success).toBe(true);
  });
  it('accepts an amount_cents of 0', () => {
    expect(
      reinstatementSchema.safeParse({ player_id: UUID_A, amount_cents: 0 }).success,
    ).toBe(true);
  });
  it('rejects a non-UUID player_id', () => {
    expect(reinstatementSchema.safeParse({ player_id: 'x' }).success).toBe(false);
  });
});

describe('reinstatementPaymentSchema', () => {
  it('accepts $0 — a free reinstatement is a recorded decision, not a blank', () => {
    expect(
      reinstatementPaymentSchema.safeParse({ fee_id: UUID_A, amount_cents: 0 }).success,
    ).toBe(true);
  });
  // The row already exists by the time this is called, so a missing amount
  // would be indistinguishable from never having recorded one — which is the
  // exact state the action exists to clear.
  it('requires an amount', () => {
    expect(reinstatementPaymentSchema.safeParse({ fee_id: UUID_A }).success).toBe(false);
  });
  it('rejects a negative amount', () => {
    expect(
      reinstatementPaymentSchema.safeParse({ fee_id: UUID_A, amount_cents: -1 }).success,
    ).toBe(false);
  });
});

describe('adminMatchCreateSchema', () => {
  const base = {
    match_type: 'singles' as const,
    format: 'single_21' as const,
    rated_flag: false,
    side_a_players: [UUID_A],
    side_b_players: [UUID_B],
    winner_side: 'a' as const,
    games: [{ game_number: 1, side_a_score: 21, side_b_score: 15 }],
  };

  it('accepts two different players', () => {
    expect(adminMatchCreateSchema.safeParse(base).success).toBe(true);
  });

  // The bug this guards: the schema checked only that each side had 1-2 UUIDs,
  // so the same player on both sides passed validation, the match row was
  // committed, and the participant batch then died on
  // UNIQUE(match_id, player_id) — leaving a completed match with a winner and
  // no participants while the action reported success.
  it('rejects the same player on both sides', () => {
    expect(
      adminMatchCreateSchema.safeParse({
        ...base, side_a_players: [UUID_A], side_b_players: [UUID_A],
      }).success,
    ).toBe(false);
  });

  // Same constraint, same orphan: two of the same partner on one doubles side.
  it('rejects the same player twice on one side', () => {
    expect(
      adminMatchCreateSchema.safeParse({
        ...base, match_type: 'doubles', side_a_players: [UUID_A, UUID_A], side_b_players: [UUID_B],
      }).success,
    ).toBe(false);
  });
});

describe('banSchema', () => {
  it('accepts a valid ban', () => {
    expect(banSchema.safeParse({ player_id: UUID_A, reason: 'Repeated no-shows' }).success).toBe(true);
  });
  it('rejects a reason shorter than 2 chars', () => {
    expect(banSchema.safeParse({ player_id: UUID_A, reason: 'x' }).success).toBe(false);
  });
});

// IT CARRIED is_exec TOO, and that made updatePlayerFlags a second way to hand
// somebody a console level from the Fees page — is_exec is one of the three
// columns admin_access_level resolves from. Console access has one editing path
// now (/permissions → setConsoleAccess), so this schema is the fee flag alone.
// The assertions are rewritten to the new contract rather than deleted: the
// interesting claim is that is_exec CANNOT come back through here.
describe('playerFlagsSchema', () => {
  it('accepts either value of the fee flag', () => {
    for (const fee_exempt of [true, false]) {
      expect(playerFlagsSchema.safeParse({ fee_exempt }).success).toBe(true);
    }
  });
  it('requires the flag', () => {
    expect(playerFlagsSchema.safeParse({}).success).toBe(false);
  });
  it('rejects non-boolean values', () => {
    expect(playerFlagsSchema.safeParse({ fee_exempt: 'yes' }).success).toBe(false);
  });
  // Zod strips unknown keys rather than refusing them, so the guarantee is not
  // "the parse fails" — it is that is_exec does not survive the parse. Belt as
  // well as braces at the action: updatePlayerFlags names fee_exempt explicitly
  // in its .update() rather than spreading the payload, so an extra key has
  // nowhere to land even if this ever stopped stripping.
  it('drops is_exec instead of carrying it through', () => {
    const parsed = playerFlagsSchema.parse({ is_exec: true, fee_exempt: false });
    expect(parsed).toEqual({ fee_exempt: false });
    expect('is_exec' in parsed).toBe(false);
  });
});

describe('reliabilityAdjustSchema', () => {
  const base = {
    player_id: UUID_A,
    no_shows: 2,
    late_cancellations: 1,
    early_withdrawals: 0,
    walkover_flag: false,
    reason: 'Corrected after admin review',
  };
  it('accepts a valid adjustment', () => {
    expect(reliabilityAdjustSchema.safeParse(base).success).toBe(true);
  });
  it('rejects a negative count', () => {
    expect(reliabilityAdjustSchema.safeParse({ ...base, no_shows: -1 }).success).toBe(false);
  });
  it('rejects an empty reason', () => {
    expect(reliabilityAdjustSchema.safeParse({ ...base, reason: '' }).success).toBe(false);
  });
});

describe('legalAcceptanceSchema', () => {
  const allTrue = {
    waiver_accepted: true,
    code_of_conduct_accepted: true,
    terms_accepted: true,
    age_attestation: true,
  };
  it('accepts all four literals true', () => {
    expect(legalAcceptanceSchema.safeParse(allTrue).success).toBe(true);
  });
  it('rejects any false literal', () => {
    for (const key of ['waiver_accepted', 'code_of_conduct_accepted', 'terms_accepted', 'age_attestation'] as const) {
      expect(legalAcceptanceSchema.safeParse({ ...allTrue, [key]: false }).success).toBe(false);
    }
  });
  it('rejects a missing field', () => {
    expect(
      legalAcceptanceSchema.safeParse({ waiver_accepted: true, code_of_conduct_accepted: true, terms_accepted: true }).success,
    ).toBe(false);
  });
});

describe('legalDocumentUpdateSchema', () => {
  const base = {
    document: 'waiver' as const,
    content: 'x'.repeat(100),
    bump_version: false,
  };
  it('accepts a valid update for each document', () => {
    for (const document of ['waiver', 'code_of_conduct', 'terms_of_use', 'privacy_policy'] as const) {
      expect(legalDocumentUpdateSchema.safeParse({ ...base, document }).success).toBe(true);
    }
  });
  it('rejects an unknown document', () => {
    expect(
      legalDocumentUpdateSchema.safeParse({ ...base, document: 'refund_policy' }).success,
    ).toBe(false);
  });
  it('rejects content shorter than 50 chars', () => {
    expect(legalDocumentUpdateSchema.safeParse({ ...base, content: 'too short' }).success).toBe(false);
  });
  it('rejects content longer than 50000 chars', () => {
    expect(
      legalDocumentUpdateSchema.safeParse({ ...base, content: 'x'.repeat(50001) }).success,
    ).toBe(false);
  });
});

// The per-season event waiver template (00074). Keyed by season uuid, not a
// document name — a template is NOT a legal_documents row, and there is no
// bump_version because nobody accepts a template directly.
describe('eventWaiverTemplateUpdateSchema', () => {
  const base = {
    season_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    content: 'x'.repeat(100),
  };
  it('accepts a valid update', () => {
    expect(eventWaiverTemplateUpdateSchema.safeParse(base).success).toBe(true);
  });
  it('rejects a season_id that is not a uuid', () => {
    // The action passes this straight to a uuid column; a document-style key
    // like 'waiver' would blow up at the database instead of here.
    expect(
      eventWaiverTemplateUpdateSchema.safeParse({ ...base, season_id: 'fall-2026' }).success,
    ).toBe(false);
  });
  it('rejects content shorter than 50 chars', () => {
    // Stops a stray keystroke becoming the wording every event that term
    // starts from.
    expect(
      eventWaiverTemplateUpdateSchema.safeParse({ ...base, content: 'too short' }).success,
    ).toBe(false);
  });
  it('rejects content longer than 50000 chars', () => {
    expect(
      eventWaiverTemplateUpdateSchema.safeParse({ ...base, content: 'x'.repeat(50001) }).success,
    ).toBe(false);
  });
});

describe('disputeResolveSchema', () => {
  it('accepts each resolution_type', () => {
    for (const resolution_type of ['accepted', 'edited', 'voided', 'converted_to_casual'] as const) {
      const result = disputeResolveSchema.safeParse({
        dispute_id: UUID_A,
        resolution_type,
        resolution_note: 'ok',
      });
      expect(result.success).toBe(true);
    }
  });
  it('rejects an unknown resolution_type', () => {
    expect(
      disputeResolveSchema.safeParse({
        dispute_id: UUID_A,
        resolution_type: 'denied',
        resolution_note: 'ok',
      }).success,
    ).toBe(false);
  });
  it('rejects more than 7 edited games', () => {
    expect(
      disputeResolveSchema.safeParse({
        dispute_id: UUID_A,
        resolution_type: 'edited',
        resolution_note: 'ok',
        edited_winner_side: 'a',
        edited_games: Array.from({ length: 8 }, (_, i) => ({
          game_number: i + 1,
          side_a_score: i % 2 === 0 ? 21 : 15,
          side_b_score: i % 2 === 0 ? 15 : 21,
        })),
      }).success,
    ).toBe(false);
  });
  it('rejects edited games with a tied game', () => {
    expect(
      disputeResolveSchema.safeParse({
        dispute_id: UUID_A,
        resolution_type: 'edited',
        resolution_note: 'ok',
        edited_winner_side: 'a',
        edited_games: [{ game_number: 1, side_a_score: 21, side_b_score: 21 }],
      }).success,
    ).toBe(false);
  });
  it('rejects an edited_winner_side that did not win a majority of edited games', () => {
    expect(
      disputeResolveSchema.safeParse({
        dispute_id: UUID_A,
        resolution_type: 'edited',
        resolution_note: 'ok',
        edited_winner_side: 'b',
        edited_games: [{ game_number: 1, side_a_score: 21, side_b_score: 15 }],
      }).success,
    ).toBe(false);
  });
  it('accepts a consistent edited resolution', () => {
    expect(
      disputeResolveSchema.safeParse({
        dispute_id: UUID_A,
        resolution_type: 'edited',
        resolution_note: 'ok',
        edited_winner_side: 'a',
        edited_games: [{ game_number: 1, side_a_score: 21, side_b_score: 15 }],
      }).success,
    ).toBe(true);
  });
});

describe('sessionIntentSchema', () => {
  it('accepts the known intents', () => {
    expect(sessionIntentSchema.parse('going')).toBe('going');
    expect(sessionIntentSchema.parse('declined')).toBe('declined');
  });
  it('rejects an unknown intent, empty string, or undefined', () => {
    expect(sessionIntentSchema.safeParse('maybe').success).toBe(false);
    expect(sessionIntentSchema.safeParse('').success).toBe(false);
    expect(sessionIntentSchema.safeParse(undefined).success).toBe(false);
  });
});

// The two non-fee ledgers (00073). Both are money, so both are validated at the
// trust boundary before the service-role client — which bypasses RLS — writes
// anything.
describe('otherIncomeSchema / clubExpenseSchema', () => {
  const income = { season_id: UUID_A, category: 'donation', description: 'Alumni gift', amount_cents: 15000 };
  const expense = { season_id: UUID_A, category: 'shuttles', description: '6 tubes', amount_cents: 8400 };

  it('accepts a minimal valid entry on each', () => {
    expect(otherIncomeSchema.safeParse(income).success).toBe(true);
    expect(clubExpenseSchema.safeParse(expense).success).toBe(true);
  });

  // season_id is the ONLY thing that decides which season a row counts toward.
  // reinstatement_fees had no season column, had to be bucketed by paid_at, and
  // a payment taken between terms then belonged to no season and showed in no
  // total (00069). An optional season here would recreate that hole.
  it('requires a season on both ledgers', () => {
    expect(otherIncomeSchema.safeParse({ ...income, season_id: undefined }).success).toBe(false);
    expect(clubExpenseSchema.safeParse({ ...expense, season_id: undefined }).success).toBe(false);
    expect(clubExpenseSchema.safeParse({ ...expense, season_id: 'not-a-uuid' }).success).toBe(false);
  });

  // A category outside the list would be rejected by the database CHECK in
  // 00073 anyway; catching it here turns a 500 into a field error, and keeps
  // the console's vocabulary and the database's from drifting apart.
  it('rejects a category the database would refuse', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, category: 'shuttlecocks' }).success).toBe(false);
    expect(otherIncomeSchema.safeParse({ ...income, category: 'shuttles' }).success).toBe(false);
  });

  // Cents are integers. A fractional cent is not money, and a negative amount
  // on an expense would ADD to the net position instead of subtracting from it,
  // turning a typo into a club that looks solvent.
  it('rejects fractional and negative amounts', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, amount_cents: 84.5 }).success).toBe(false);
    expect(clubExpenseSchema.safeParse({ ...expense, amount_cents: -8400 }).success).toBe(false);
    expect(otherIncomeSchema.safeParse({ ...income, amount_cents: -1 }).success).toBe(false);
  });

  // $0.00 is a legitimate entry: a promised donation that came to nothing, or
  // shuttles somebody donated. Refusing it would push the admin to delete the
  // trail instead of recording the outcome.
  it('accepts a zero amount', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, amount_cents: 0 }).success).toBe(true);
    expect(otherIncomeSchema.safeParse({ ...income, amount_cents: 0 }).success).toBe(true);
  });

  // A blank description makes a ledger line nobody can identify later. Trimmed,
  // so spaces do not sneak past the minimum.
  it('rejects a blank or whitespace-only description', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, description: '' }).success).toBe(false);
    expect(clubExpenseSchema.safeParse({ ...expense, description: '   ' }).success).toBe(false);
  });

  // Quantity is a unit count for the spend ("6 tubes"), not an amount. Zero or
  // fractional tubes is a typo.
  it('accepts a positive quantity and rejects zero or fractional', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, quantity: 6 }).success).toBe(true);
    expect(clubExpenseSchema.safeParse({ ...expense, quantity: 0 }).success).toBe(false);
    expect(clubExpenseSchema.safeParse({ ...expense, quantity: 1.5 }).success).toBe(false);
  });

  // Quantity belongs to expenses only — "3 donations" is not a thing this
  // ledger records, and an unknown key must not silently become a column.
  it('does not carry quantity through on other income', () => {
    const parsed = otherIncomeSchema.parse({ ...income, quantity: 3 } as never);
    expect('quantity' in parsed).toBe(false);
  });

  // A receipt is evidence for a payment the row already asserts (00231), so the
  // spend records with or without one. A receipt can be lost on the way home or
  // emailed instead of handed over, and an expense that could not be filed
  // without a photograph would be an expense nobody files.
  it('accepts an expense with no receipt, and one with a path', () => {
    expect(clubExpenseSchema.safeParse(expense).success).toBe(true);
    expect(
      clubExpenseSchema.safeParse({ ...expense, receipt_path: `${UUID_B}/${UUID_A}.jpg` }).success,
    ).toBe(true);
  });

  // Expenses only, for the same reason quantity is: a donation has nobody to
  // reimburse and therefore no evidence of a reimbursement to hold. 00231's
  // widened club_ledger_reimbursement_is_expense CHECK refuses it at the
  // database too, so this keeps the validator and the constraint agreeing.
  it('does not carry receipt_path through on other income', () => {
    const parsed = otherIncomeSchema.parse({ ...income, receipt_path: 'a/b.jpg' } as never);
    expect('receipt_path' in parsed).toBe(false);
  });

  // Several files, items and tax lines (00313), each bounded like its table.
  it('bounds the receipt files, items and tax lines of an expense', () => {
    const file = { path: `${UUID_B}/${UUID_A}.heic`, content_type: 'image/heic' };
    const item = { description: 'Shuttle tube', line_total_cents: 2997, tax_code: 'J', is_club: true };
    const tax = { label: 'GST', rate_ppm: 50000, printed_cents: 150, codes: ['J'] };
    const ok = (over: object) => clubExpenseSchema.safeParse({ ...expense, ...over }).success;

    expect(ok({ receipts: [file, { ...file, content_type: 'application/pdf' }], items: [item], tax_lines: [tax] })).toBe(true);
    expect(ok({ receipts: Array.from({ length: 21 }, () => file) })).toBe(false);
    expect(ok({ receipts: [{ ...file, content_type: 'image/gif' }] })).toBe(false);
    expect(ok({ items: [{ ...item, description: '' }] })).toBe(false);
    expect(ok({ items: [{ ...item, description: 'x'.repeat(121) }] })).toBe(false);
    expect(ok({ items: [{ ...item, discount_cents: 100 }] })).toBe(false);
    expect(ok({ items: [{ ...item, tax_code: 'gst' }] })).toBe(false);
    expect(ok({ items: [{ ...item, line_total_cents: -500 }] })).toBe(true);
    expect(ok({ tax_lines: [{ ...tax, rate_ppm: 500001 }] })).toBe(false);
    expect(ok({ tax_lines: Array.from({ length: 11 }, () => tax) })).toBe(false);
    expect(ok({ tax_lines: [{ ...tax, label: 'x'.repeat(25) }] })).toBe(false);
    expect(ok({ vendor: 'x'.repeat(81) })).toBe(false);
    expect(ok({ receipt_total_cents: -1 })).toBe(false);
  });

  // The date the money moved, which is not the date the entry was typed: an
  // exec writing up September's receipts in October has to be able to say
  // September. It never changes which season the row counts toward.
  it('accepts an explicit ISO paid_at and rejects a bare date', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, paid_at: '2026-09-15T12:00:00.000Z' }).success).toBe(true);
    expect(clubExpenseSchema.safeParse({ ...expense, paid_at: '2026-09-15' }).success).toBe(false);
  });
});

describe('feeSubmissionSchema (00253)', () => {
  const base = {
    feeId: '00000000-0000-4000-8000-000000000001',
    duesSeasonId: null,
    reference: 'CA7Hd2k9',
    screenshotPath: 'user/receipt.png',
  };

  it('takes the method the browser read, or none', () => {
    expect(feeSubmissionSchema.safeParse(base).success).toBe(true);
    expect(feeSubmissionSchema.safeParse({ ...base, detectedMethod: null }).success).toBe(true);
    expect(feeSubmissionSchema.safeParse({ ...base, detectedMethod: 'e_transfer' }).success).toBe(true);
    expect(feeSubmissionSchema.safeParse({ ...base, detectedMethod: 'sfu_rec' }).success).toBe(true);
  });

  it('refuses a method a receipt cannot carry', () => {
    expect(feeSubmissionSchema.safeParse({ ...base, detectedMethod: 'cash' }).success).toBe(false);
    expect(feeSubmissionSchema.safeParse({ ...base, detectedMethod: 'online_portal' }).success).toBe(false);
  });

  it('lets a 4 character reference through to the action, which checks it by method', () => {
    expect(feeSubmissionSchema.safeParse({ ...base, reference: '4821' }).success).toBe(true);
    expect(feeSubmissionSchema.safeParse({ ...base, reference: '482' }).success).toBe(false);
  });

  it('is still strict', () => {
    expect(feeSubmissionSchema.safeParse({ ...base, method: 'sfu_rec' }).success).toBe(false);
  });
});
