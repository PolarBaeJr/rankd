// ASSEMBLING ONE MEMBER'S EXPORT, IN TYPESCRIPT, OVER THE SERVICE-ROLE CLIENT.
//
// WHY NOT RLS, which is the obvious answer and the wrong one. Several tables
// holding the member's own personal information have ZERO grants for
// `authenticated`, so an RLS-scoped export is incomplete BY CONSTRUCTION -- and
// it fails SILENTLY, because a denied PostgREST read arrives as an empty list
// rather than an error. `email_suppressions` (00037:48), `digest_deliveries`
// (00194:80), `feedback_reports` (00172:113), `passkey_challenges` (RLS on,
// zero policies, 00181:63-65), `tournament_bonus_grants` (RLS on, zero
// policies, 00188:60-62) and `players` itself (00032 revokes blanket SELECT, so
// even `select('*')` on your own row is refused) would all come back empty and
// the file would look complete.
//
// WHY NOT A SET OF SECURITY DEFINER RPCs. Forty of them is forty new pieces of
// authenticated surface, and the failure mode is the one this whole feature
// exists to avoid: a table added later gets no RPC and nobody notices.
//
// WHY NOT ONE BIG SECURITY DEFINER jsonb FUNCTION. Testability. The guard that
// keeps this correct compares a registry against the migration SQL, and that is
// tractable in TypeScript and miserable in PL/pgSQL.
//
// AND THE COST, STATED RATHER THAN HIDDEN: about fifty sequential reads are NOT
// a point-in-time snapshot. The manifest records assembly_started_at and
// assembly_completed_at and the declared gaps say outright that rows may have
// changed between them.
//
// THE CLIENT IS A PARAMETER so the coverage test can stub it. The route is what
// decides the client is the service-role one.
//
// TWO RULES HOLD EVERYWHERE BELOW, and both are checked by the coverage test:
//   1. Every read destructures `{ data, error }`. No `?? []`, no `|| []`.
//   2. Any read error fails the WHOLE request. A partial file is structurally
//      impossible, not merely unlikely.

import {
  selectAllPages,
  selectInChunks,
  selectAllInChunks,
  chunkIds,
  type ChunkResult,
} from '@badminton/shared';
import {
  EXPORT_TABLES,
  PLAYER_EXPORT_COLUMNS,
  WITHHELD_COLUMNS,
  DECLARED_GAPS,
  DISCLOSURE_RECIPIENTS,
  EXACTLY_ONE_ROW,
  TABLES_CONSIDERED,
} from './registry';
import {
  createPseudonymAllocator,
  officerDescriptor,
  pickColumns,
  dropColumns,
  filterAuditPayload,
  truncateEndpoint,
  rewritePredictionRelative,
  rewriteRequesterRelative,
} from './project';

type Row = Record<string, unknown>;

/** The narrow slice of the Supabase client this module uses, so it can be stubbed. */
export interface ExportClient {
  from(table: string): any;
}

export interface ExportDocument {
  manifest: {
    schema_version: number;
    player_id: string;
    assembly_started_at: string;
    assembly_completed_at: string;
    app_version: string | null;
    tables_considered: number;
    pseudonyms_allocated: number;
    about_this_file: readonly string[];
    tables: Record<string, { disposition: string; rows: number; why: string }>;
  };
  data: Record<string, Row[]>;
  withheld: { what: string; rows: number | null; why: string }[];
  declared_gaps: readonly { gap: string; detail: string }[];
  disclosure_recipients: readonly {
    organisation: string;
    what: string;
    why: string;
  }[];
}

export type AssembleResult =
  | { ok: true; document: ExportDocument }
  | { ok: false; failures: string[] };

/** Bumped when the shape of the document changes, so an old file stays readable. */
const SCHEMA_VERSION = 1;

/**
 * Every read in this file goes through here, and the reason is the two rules in
 * the header.
 *
 * WHY EVERY READ IS PAGED, including the ones keyed on a single player id.
 * Production sets PostgREST's `db-max-rows` to 1,000 and PostgREST TRUNCATES
 * SILENTLY at that number -- the sessions page under-counted every night for
 * months on exactly this. A silent truncation in an export is the same defect
 * as a `?? []`: the file is well formed and short. `selectAllPages` pages until
 * a short page comes back, which costs one extra request on a table with under
 * 500 rows and removes a per-table judgement call that would go stale. See
 * ROW_PAGE_SIZE in packages/shared/src/utils/query-chunks.ts.
 */
class Reader {
  readonly failures: string[] = [];

  constructor(private readonly supabase: ExportClient) {}

  private fail(table: string, message: string): void {
    this.failures.push(`${table}: ${message}`);
  }

  /** Every row a filter matches. */
  async all(table: string, filter: (q: any) => any, columns = '*'): Promise<Row[]> {
    const { data, error } = await selectAllPages<Row>((from, to) =>
      filter(this.supabase.from(table).select(columns)).range(from, to),
    );
    if (error) {
      this.fail(table, error.message);
      return [];
    }
    // selectAllPages returns a concrete array whenever it returns no error.
    return data as Row[];
  }

  /**
   * An `.in()` read that returns AT MOST ONE ROW PER ID -- a parent fetched by
   * primary key. `selectInChunks` keeps the request line under the 8,192-byte
   * limit (measured: 215 ids reach PostgREST, 220 get a 414).
   *
   * UNLIKE THE AUDIT PAGE'S CALL SITE, THE ERROR IS PROPAGATED. That site
   * tolerates a missing name; this one cannot tolerate a missing table.
   */
  async allInByKey(
    table: string,
    ids: readonly string[],
    filter: (q: any, batch: string[]) => any,
    columns = '*',
  ): Promise<Row[]> {
    const { data, error } = await selectInChunks<Row>(ids, (batch) =>
      filter(this.supabase.from(table).select(columns), batch) as PromiseLike<ChunkResult<Row>>,
    );
    if (error) {
      this.fail(table, error.message);
      return [];
    }
    return data as Row[];
  }

  /**
   * An `.in()` read that can return MANY ROWS PER ID. Both limits apply and
   * both are silent, so both are composed: chunk the ids for the request line,
   * page within each chunk for db-max-rows.
   */
  async allInByParent(
    table: string,
    ids: readonly string[],
    filter: (q: any, batch: string[]) => any,
    columns = '*',
  ): Promise<Row[]> {
    const { data, error } = await selectAllInChunks<Row>(ids, (batch, from, to) =>
      filter(this.supabase.from(table).select(columns), batch).range(from, to),
    );
    if (error) {
      this.fail(table, error.message);
      return [];
    }
    return data as Row[];
  }

  /**
   * A row count with no row bodies.
   *
   * THIS IS HOW THE WITHHELD STANZA GETS ITS NUMBER without the export ever
   * touching officer free text. `head: true` sends no body back, so the count
   * for `varsity_notes` can be honest about the stakes while the notes
   * themselves stay where 00117 and 00118 put them.
   */
  //
  // `column`, NOT '*'. PostgREST checks SELECT on every column a select list
  // names, even with `head: true` and no body coming back, so '*' is refused
  // outright on any table with column-level grants. data_api_consumers is one
  // (00241 withholds `player_ref_salt` from service_role), and that one 403 was
  // failing every member's whole export on staging. The filter column is always
  // readable, since the filter itself needs it, so counting by it is safe.
  async countOnly(table: string, column: string, filter: (q: any) => any): Promise<number> {
    const { count, error } = await filter(
      this.supabase.from(table).select(column, { count: 'exact', head: true }),
    );
    if (error) {
      this.fail(table, error.message);
      return 0;
    }
    return typeof count === 'number' ? count : 0;
  }
}

function ids(rows: readonly Row[], column: string): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const value = row[column];
    if (typeof value === 'string' && value.length > 0) out.add(value);
  }
  return [...out];
}

/** A PostgREST `.or()` disjunction over several columns against one value. */
function orEq(columns: readonly string[], value: string): string {
  return columns.map((c) => `${c}.eq.${value}`).join(',');
}

export async function assembleMemberExport(
  supabase: ExportClient,
  playerId: string,
): Promise<AssembleResult> {
  const startedAt = new Date().toISOString();
  const reader = new Reader(supabase);
  const data: Record<string, Row[]> = {};
  const counted: Record<string, number> = {};
  const withheldRows: Record<string, number> = {};
  const members = createPseudonymAllocator([playerId]);

  // ==========================================================
  // PHASE 1 -- the member's own row, which everything else needs
  // ==========================================================
  // GUARANTEED-ROW TABLES ARE ASSERTIONS, NOT READS. Zero rows here means the
  // read was refused or the row is missing, and either way the file would be
  // wrong while looking complete. See EXACTLY_ONE_ROW in the registry.
  const playerRows = await reader.all('players', (q) => q.eq('id', playerId));
  if (reader.failures.length > 0 || playerRows.length !== 1) {
    // Short-circuit rather than run fifty more reads keyed on an id list that
    // cannot be built. The failure list is what comes back either way.
    if (playerRows.length !== 1) {
      reader.failures.push(
        `players: expected exactly 1 row for the signed-in member, got ${playerRows.length}`,
      );
    }
    return { ok: false, failures: reader.failures };
  }
  const player = playerRows[0] as Row;
  const authUserId = typeof player.user_id === 'string' ? player.user_id : null;
  const email = typeof player.email === 'string' ? player.email : null;

  data.players = [
    {
      ...pickColumns(player, PLAYER_EXPORT_COLUMNS),
      // players.banned_by is the OFFICER, the one players-to-players foreign
      // key on the table. A member uuid is joinable across the rest of the app,
      // so it is replaced by a descriptor under a different key -- a different
      // key so that `banned_by` can stay out of every allowlist and the
      // coverage test can say so.
      banned_by_role: officerDescriptor(player.banned_by as string | null),
    },
  ];

  // ==========================================================
  // PHASE 2 -- the id lists the rest of the reads are keyed on
  // ==========================================================
  const ownMatchParticipants = await reader.all('match_participants', (q) =>
    q.eq('player_id', playerId),
  );
  const ownTournamentParticipants = await reader.all('tournament_participants', (q) =>
    q.eq('player_id', playerId),
  );
  const ownPairs = await reader.all('tournament_pairs', (q) =>
    q.or(orEq(['player1_id', 'player2_id'], playerId)),
  );
  const ownChallengeParticipants = await reader.all('challenge_participants', (q) =>
    q.eq('player_id', playerId),
  );
  const ownDiscordLinks = await reader.all('player_discord_links', (q) =>
    q.eq('player_id', playerId),
  );
  const ownWaitlist = await reader.all('tournament_event_waitlist', (q) =>
    q.eq('player_id', playerId),
  );
  const ownClubEventWaitlist = await reader.all('club_event_waitlist', (q) =>
    q.eq('player_id', playerId),
  );

  const matchIds = ids(ownMatchParticipants, 'match_id');
  const participantIds = ids(ownTournamentParticipants, 'id');
  const pairIds = ids(ownPairs, 'id');
  const eventIds = [...new Set([
    ...ids(ownTournamentParticipants, 'event_id'),
    ...ids(ownPairs, 'event_id'),
    ...ids(ownWaitlist, 'event_id'),
  ])];
  const discordUserId =
    ownDiscordLinks.length === 1 && typeof ownDiscordLinks[0]!.discord_user_id === 'string'
      ? (ownDiscordLinks[0]!.discord_user_id as string)
      : null;

  // A SECOND PSEUDONYM NAMESPACE, for tournament ENTRY ids rather than member
  // ids. A tournament_participants.id or tournament_pairs.id is not a member
  // uuid, but `tournament_participants` is readable by every signed-in member
  // (it is published to Realtime by 00113), so an entry id resolves to a person
  // in one hop. `entrant_N` keeps a draw legible without handing over the hop.
  const entrants = createPseudonymAllocator([...participantIds, ...pairIds], 'entrant');

  // ==========================================================
  // PHASE 3 -- everything keyed on phase 1 and phase 2
  // ==========================================================

  // ---- wholly theirs -------------------------------------------------------
  data.ratings = await reader.all('ratings', (q) => q.eq('player_id', playerId));
  data.reliability_metrics = await reader.all('reliability_metrics', (q) =>
    q.eq('player_id', playerId),
  );
  // THE OTHER TWO ASSERTIONS. `ratings` (UNIQUE player_id, 00001:189) and
  // `reliability_metrics` (UNIQUE player_id, 00001:570) hold exactly one row
  // per member, seeded at signup. Zero means the read was refused or the row is
  // missing; either way the file would be wrong while looking complete, so this
  // is a failure and not an empty section. The `players` assertion is in phase
  // 1, because nothing after it can run without that row.
  for (const table of EXACTLY_ONE_ROW) {
    const rows = data[table];
    if (rows && rows.length !== 1) {
      reader.failures.push(`${table}: expected exactly 1 row, got ${rows.length}`);
    }
  }
  data.season_final_ratings = await reader.all('season_final_ratings', (q) =>
    q.eq('player_id', playerId),
  );
  data.session_rsvp = await reader.all('session_rsvp', (q) => q.eq('player_id', playerId));
  data.waiver_acceptances = await reader.all('waiver_acceptances', (q) =>
    q.eq('player_id', playerId),
  );
  data.event_waiver_acceptances = await reader.all('event_waiver_acceptances', (q) =>
    q.eq('player_id', playerId),
  );
  data.announcement_reads = await reader.all('announcement_reads', (q) =>
    q.eq('player_id', playerId),
  );
  data.notifications = await reader.all('notifications', (q) => q.eq('player_id', playerId));
  data.digest_deliveries = await reader.all('digest_deliveries', (q) =>
    q.eq('player_id', playerId),
  );
  data.player_discord_links = ownDiscordLinks;

  // session_attendance is otherwise wholly theirs, but marked_by is the officer
  // who marked them (00008:16), so it goes the way players.banned_by does.
  const ownAttendance = await reader.all('session_attendance', (q) => q.eq('player_id', playerId));
  data.session_attendance = ownAttendance.map((row) => ({
    ...dropColumns(row, ['marked_by']),
    marked_by_role: officerDescriptor(row.marked_by as string | null),
  }));

  // email_suppressions has NO player column at all: the primary key is the
  // address (00037:25-36). Matched against the address on the row above, which
  // is why a previous address is a declared gap rather than a silent absence.
  data.email_suppressions = email
    ? await reader.all('email_suppressions', (q) => q.eq('email', email))
    : [];

  // feedback_reports matches player_id OR the linked Discord id. 00172:76-84
  // keeps the Discord handle even when player_id is set, and a reporter who
  // never linked an account has ONLY that -- so matching player_id alone would
  // silently drop a member's own bug reports.
  data.feedback_reports = await reader.all('feedback_reports', (q) =>
    discordUserId
      ? q.or(`player_id.eq.${playerId},discord_user_id.eq.${discordUserId}`)
      : q.eq('player_id', playerId),
  );

  // ---- the two pair-stats tables, and their shared trap --------------------
  // BOTH carry `CHECK (player_a_id < player_b_id)` -- head_to_head_stats at
  // 00001:509 and partnership_stats at 00001:527 -- so which slot the member
  // occupies is decided by uuid ordering, per opponent. `.eq('player_a_id',
  // me)` returns roughly HALF the rows and looks perfectly healthy. Both
  // columns are queried and every row is rewritten requester-relative, so the
  // raw a/b columns never ship.
  const headToHead = await reader.all('head_to_head_stats', (q) =>
    q.or(orEq(['player_a_id', 'player_b_id'], playerId)),
  );
  data.head_to_head_stats = headToHead.map((row) =>
    rewriteRequesterRelative(
      row,
      playerId,
      members,
      [
        ['player_a_wins', 'player_b_wins', 'wins'],
        ['player_a_points', 'player_b_points', 'points'],
      ],
      ['id', 'match_type', 'total_matches', 'last_played_at', 'updated_at'],
    ),
  );

  // Predictions (00282) are stored in a canonical side order, so the member may
  // be in any of the four slots: all four are queried, and every row is
  // rewritten with the member's side first.
  const predictions = await reader.all('data_api_predictions', (q) =>
    q.or(orEq(['side1_p1', 'side1_p2', 'side2_p1', 'side2_p2'], playerId)),
  );
  data.data_api_predictions = predictions.map((row) => rewritePredictionRelative(row, playerId, members));

  const partnerships = await reader.all('partnership_stats', (q) =>
    q.or(orEq(['player_a_id', 'player_b_id'], playerId)),
  );
  data.partnership_stats = partnerships.map((row) =>
    // A partnership's numbers are the PAIR's, not one half's, so there is no
    // a/b pair to split -- only the identity to project.
    rewriteRequesterRelative(row, playerId, members, [], [
      'id',
      'matches_played',
      'wins',
      'losses',
      'win_rate',
      'total_points_scored',
      'total_points_conceded',
      'avg_elo_delta',
      'last_played_at',
      'updated_at',
    ]),
  );

  // ---- club matches --------------------------------------------------------
  // Their own participant row only. pre_rating, post_rating, rating_delta,
  // points_scored and games_won are theirs; the opponent has an identical row
  // and it is the opponent's.
  data.match_participants = ownMatchParticipants;

  const allMatchParticipants = await reader.allInByParent(
    'match_participants',
    matchIds,
    (q, batch) => q.in('match_id', batch),
    'match_id, player_id, team_side',
  );
  const sidesByMatch = new Map<string, { member: string | null; team_side: unknown }[]>();
  for (const row of allMatchParticipants) {
    const key = row.match_id as string;
    if (!sidesByMatch.has(key)) sidesByMatch.set(key, []);
    sidesByMatch.get(key)!.push({
      member: members.forMember(row.player_id as string | null),
      team_side: row.team_side,
    });
  }

  const matches = await reader.allInByKey('matches', matchIds, (q, batch) => q.in('id', batch));
  data.matches = matches.map((row) => ({
    ...dropColumns(row, ['submitted_by', 'confirmed_by', 'forfeit_player_id']),
    submitted_by: members.forMember(row.submitted_by as string | null),
    confirmed_by: members.forMember(row.confirmed_by as string | null),
    forfeit_player: members.forMember(row.forfeit_player_id as string | null),
    participants: sidesByMatch.get(row.id as string) ?? null,
  }));

  data.match_games = await reader.allInByParent('match_games', matchIds, (q, batch) =>
    q.in('match_id', batch),
  );

  // ---- challenges ----------------------------------------------------------
  const createdChallenges = await reader.all('challenges', (q) => q.eq('created_by', playerId));
  const createdChallengeIds = new Set(ids(createdChallenges, 'id'));
  const namedChallengeIds = ids(ownChallengeParticipants, 'challenge_id').filter(
    (id) => !createdChallengeIds.has(id),
  );
  const namedChallenges = await reader.allInByKey('challenges', namedChallengeIds, (q, batch) =>
    q.in('id', batch),
  );
  const allChallenges = [...createdChallenges, ...namedChallenges];
  const challengeSides = await reader.allInByParent(
    'challenge_participants',
    ids(allChallenges, 'id'),
    (q, batch) => q.in('challenge_id', batch),
    'challenge_id, player_id, role, team_side, confirmation_status',
  );
  const sidesByChallenge = new Map<string, Row[]>();
  for (const row of challengeSides) {
    const key = row.challenge_id as string;
    if (!sidesByChallenge.has(key)) sidesByChallenge.set(key, []);
    sidesByChallenge.get(key)!.push({
      member: members.forMember(row.player_id as string | null),
      role: row.role,
      team_side: row.team_side,
      confirmation_status: row.confirmation_status,
    });
  }
  data.challenges = allChallenges.map((row) => {
    const mine = row.created_by === playerId;
    return {
      ...dropColumns(row, ['created_by', 'note']),
      created_by: members.forMember(row.created_by as string | null),
      // The note is the challenger's own words. Theirs when they wrote it;
      // somebody else's personal information when they did not, so existence
      // is kept and the text withheld.
      note: mine ? row.note : null,
      note_present: row.note !== null && row.note !== undefined,
      note_withheld: !mine && row.note !== null && row.note !== undefined,
      participants: sidesByChallenge.get(row.id as string) ?? null,
    };
  });
  data.challenge_participants = ownChallengeParticipants;

  // ---- tournaments ---------------------------------------------------------
  data.tournament_participants = ownTournamentParticipants.map((row) => ({
    ...dropColumns(row, ['checked_in_by', 'added_by']),
    checked_in_by_role: officerDescriptor(row.checked_in_by as string | null),
    added_by_role: officerDescriptor(row.added_by as string | null),
  }));

  data.tournament_pairs = ownPairs.map((row) => ({
    ...dropColumns(row, ['player1_id', 'player2_id', 'checked_in_by', 'added_by']),
    partner: members.forMember(
      (row.player1_id === playerId ? row.player2_id : row.player1_id) as string | null,
    ),
    checked_in_by_role: officerDescriptor(row.checked_in_by as string | null),
    added_by_role: officerDescriptor(row.added_by as string | null),
  }));

  // The member's own waitlist places (00278). resolved_by is the officer who
  // promoted or removed them, so it goes the way session_attendance.marked_by
  // does.
  data.tournament_event_waitlist = ownWaitlist.map((row) => ({
    ...dropColumns(row, ['resolved_by']),
    resolved_by_role: officerDescriptor(row.resolved_by as string | null),
  }));
  data.club_event_waitlist = ownClubEventWaitlist.map((row) => ({
    ...dropColumns(row, ['resolved_by']),
    resolved_by_role: officerDescriptor(row.resolved_by as string | null),
  }));

  // The draw matches the member's own entries appear in.
  //
  // ONE READ PER COLUMN, NOT ONE `.or()` OVER ALL FOUR, and the reason is the
  // 8,192-byte request line. `selectInChunks` sizes its batches at 110 ids for
  // ONE `.in()` list; folding four of those lists into a single `.or()`
  // multiplies the line by four and puts a full chunk at roughly 24KB, which
  // comes back as a 414 and NOT as anything the chunker knows how to survive.
  // Four plain `.in()` reads each stay inside the budget the shared helper was
  // measured for.
  //
  // Only the a/b slots are queried. winner_* and loser_* point at one of the
  // two sides of the same match by construction, so they cannot widen the set.
  const drawMatches: Row[] = [];
  const seenDrawMatches = new Set<string>();
  for (const [column, entryIds] of [
    ['participant_a_id', participantIds],
    ['participant_b_id', participantIds],
    ['pair_a_id', pairIds],
    ['pair_b_id', pairIds],
  ] as const) {
    const rows = await reader.allInByParent('tournament_matches', entryIds, (q, batch) =>
      q.in(column, batch),
    );
    for (const row of rows) {
      const key = row.id as string;
      if (seenDrawMatches.has(key)) continue;
      seenDrawMatches.add(key);
      drawMatches.push(row);
    }
  }
  const ENTRY_COLUMNS = [
    'participant_a_id',
    'participant_b_id',
    'pair_a_id',
    'pair_b_id',
    'winner_participant_id',
    'winner_pair_id',
    'loser_participant_id',
    'loser_pair_id',
  ];
  data.tournament_matches = drawMatches.map((row) => {
    const projected: Row = dropColumns(row, [
      ...ENTRY_COLUMNS,
      'result_entered_by',
      'ready_player_ids',
    ]);
    for (const column of ENTRY_COLUMNS) {
      projected[column] = entrants.forMember(row[column] as string | null);
    }
    projected.result_entered_by_role = officerDescriptor(row.result_entered_by as string | null);
    // ready_player_ids is a bare uuid[] of everybody the door has marked ready.
    // Filtered down to the member's own id: the rest of the array is other
    // entrants, and an array of member uuids is the most joinable thing in the
    // schema.
    projected.you_were_marked_ready = Array.isArray(row.ready_player_ids)
      ? (row.ready_player_ids as unknown[]).includes(playerId)
      : false;
    return projected;
  });

  data.legacy_tournament_participants = (
    await reader.all('legacy_tournament_participants', (q) =>
      q.or(orEq(['player_id', 'partner_id'], playerId)),
    )
  ).map((row) => ({
    ...dropColumns(row, ['partner_id']),
    partner: members.forMember(
      (row.player_id === playerId ? row.partner_id : row.player_id) as string | null,
    ),
  }));

  // tournament_bonus_grants.subject_id is `uuid NOT NULL` and "Deliberately not
  // a foreign key" (00188:43-58): a players.id for a 'rating' grant and a
  // tournament_participants.id for a 'participant_credit' one. So the match is
  // against the member's own id AND all of their own participant ids.
  data.tournament_bonus_grants = (
    await reader.allInByParent(
      'tournament_bonus_grants',
      [playerId, ...participantIds],
      (q, batch) => q.in('subject_id', batch),
    )
  ).map((row) => ({
    ...dropColumns(row, ['subject_id']),
    subject: row.subject_id === playerId ? 'you' : 'your tournament entry',
  }));

  data.tournament_audit_log = (
    await reader.all('tournament_audit_log', (q) => q.eq('performed_by', playerId))
  ).map((row) => ({
    ...dropColumns(row, ['performed_by', 'details']),
    performed_by: 'you',
    details: filterAuditPayload(row.details),
  }));

  // ---- walkovers and disputes ---------------------------------------------
  const walkovers = await reader.all('walkovers', (q) =>
    q.or(orEq(['reported_by', 'forfeit_player_id'], playerId)),
  );
  data.walkovers = walkovers.map((row) => ({
    ...dropColumns(row, ['reported_by', 'forfeit_player_id', 'admin_confirmed_by']),
    reported_by: members.forMember(row.reported_by as string | null),
    forfeit_player: members.forMember(row.forfeit_player_id as string | null),
    admin_confirmed_by_role: officerDescriptor(row.admin_confirmed_by as string | null),
  }));

  // Disputes they opened, plus disputes on matches they played. The second set
  // is the one with the nuance below.
  const openedDisputes = await reader.all('disputes', (q) => q.eq('opened_by', playerId));
  const matchDisputes = await reader.allInByParent('disputes', matchIds, (q, batch) =>
    q.in('match_id', batch),
  );
  const seenDisputes = new Set<string>();
  const allDisputes: Row[] = [];
  for (const row of [...openedDisputes, ...matchDisputes]) {
    const key = row.id as string;
    if (seenDisputes.has(key)) continue;
    seenDisputes.add(key);
    allDisputes.push(row);
  }
  data.disputes = allDisputes.map((row) => {
    const mine = row.opened_by === playerId;
    return {
      ...dropColumns(row, [
        'opened_by',
        'resolved_by',
        'claimed_by',
        'description',
        'resolution_note',
      ]),
      opened_by: members.forMember(row.opened_by as string | null),
      resolved_by_role: officerDescriptor(row.resolved_by as string | null),
      claimed_by_role: officerDescriptor(row.claimed_by as string | null),
      // THE NUANCE. The full description goes out when they opened the dispute,
      // because they wrote it. When they are merely a participant in the
      // disputed match, the description is the OTHER member's account of events
      // and is that person's personal information -- so existence,
      // reason_category, status and the dates come through and the text does
      // not. resolution_note is an officer's verdict and is withheld either
      // way, pending the owner's decision.
      description: mine ? row.description : null,
      description_withheld: !mine && row.description !== null && row.description !== undefined,
    };
  });

  // ---- money ---------------------------------------------------------------
  // Fees recorded against them are theirs. A fee they RECORDED as an officer is
  // somebody else's fee and an official act, so it is reduced to its existence.
  const ownFees = await reader.all('club_fees', (q) => q.eq('player_id', playerId));
  // The "not mine" half is filtered HERE rather than with `.neq('player_id',
  // playerId)`, because club_fees.player_id is nullable (a fee can be recorded
  // against a manual_name with no account) and PostgREST's `neq` excludes
  // NULLs. A fee an officer recorded against a walk-in would have vanished from
  // their own count with nothing anywhere to say so.
  const markedFees = (await reader.all('club_fees', (q) => q.eq('marked_by', playerId))).filter(
    (row) => row.player_id !== playerId,
  );
  data.club_fees = [
    ...ownFees.map((row) => ({
      ...dropColumns(row, ['marked_by']),
      marked_by_role: officerDescriptor(row.marked_by as string | null),
      your_role: 'the fee is yours',
    })),
    ...markedFees.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      your_role: 'you recorded this fee for another member, as an officer',
    })),
  ];

  // Receipts they sent (00248, 00253), with how they were paid. The screenshot
  // is a stored file, so the file says whether one is held rather than where;
  // the exec who reviewed it is a role. Receipts they reviewed as an officer
  // are somebody else's payment and are not read at all.
  data.fee_submissions = (await reader.all('fee_submissions', (q) => q.eq('player_id', playerId))).map(
    (row) => ({
      id: row.id,
      club_fee_id: row.club_fee_id,
      status: row.status,
      reference: row.reference,
      method: row.method,
      reject_reason: row.reject_reason,
      submitted_at: row.submitted_at,
      reviewed_at: row.reviewed_at,
      screenshot_held: row.screenshot_path != null,
      reviewed_by_role: officerDescriptor(row.reviewed_by as string | null),
    }),
  );

  // Ledger rows they PAID are their own money out of pocket. Rows where they
  // are only marked_by or reimbursed_by record an official act, so those are
  // reduced to their existence: the club cashbook is not personal information.
  const paidLedger = await reader.all('club_ledger', (q) => q.eq('paid_by', playerId));
  // Filtered in TypeScript for the same reason as club_fees: paid_by is
  // nullable (most ledger entries are club income, nobody's pocket) and `neq`
  // would drop every one of those rows.
  const officerLedger = (
    await reader.all('club_ledger', (q) => q.or(orEq(['marked_by', 'reimbursed_by'], playerId)))
  ).filter((row) => row.paid_by !== playerId);
  data.club_ledger = [
    ...paidLedger.map((row) => ({
      ...dropColumns(row, ['paid_by', 'marked_by', 'reimbursed_by']),
      paid_by: 'you',
      marked_by_role: officerDescriptor(row.marked_by as string | null),
      reimbursed_by_role: officerDescriptor(row.reimbursed_by as string | null),
    })),
    ...officerLedger.map((row) => ({
      id: row.id,
      ref_no: row.ref_no,
      created_at: row.created_at,
      your_role:
        row.marked_by === playerId
          ? 'you recorded this entry, as an officer'
          : 'you authorised this reimbursement, as an officer',
    })),
  ];

  // ---- the audit log, and its asymmetry ------------------------------------
  // THE HALF THEY WOULD NOT EXPECT is `target_type = 'player' AND target_id =
  // me`: approvals, rating edits, bans, permission changes, things done TO
  // them. They are squarely entitled to it and nothing in the app shows it.
  const aboutThem = await reader.all('audit_logs', (q) =>
    q.eq('target_type', 'player').eq('target_id', playerId),
  );
  const byThem = await reader.all('audit_logs', (q) => q.eq('actor_id', playerId));
  const seenAudit = new Set<string>();
  const auditRows: Row[] = [];
  for (const row of aboutThem) {
    seenAudit.add(row.id as string);
    auditRows.push({
      id: row.id,
      action_type: row.action_type,
      target_type: row.target_type,
      target: 'you',
      actor: row.actor_id === playerId ? 'you' : officerDescriptor(row.actor_id as string | null),
      reason: row.reason,
      // Both jsonb columns go through the allowlist, never raw. See
      // filterAuditPayload: four console actions wrote whole player rows into
      // these columns and some production rows still hold an email address.
      old_value: filterAuditPayload(row.old_value),
      new_value: filterAuditPayload(row.new_value),
      created_at: row.created_at,
    });
  }
  for (const row of byThem) {
    if (seenAudit.has(row.id as string)) continue;
    seenAudit.add(row.id as string);
    const aboutSelf = row.target_type === 'player' && row.target_id === playerId;
    // A row recording what they did to somebody ELSE is that person's personal
    // information. The action and the date are theirs; the payload and their
    // own written reason both name and describe the other member, so both stay
    // out. Non-player target_type values are left unresolved on purpose:
    // guessing which table a target_id belongs to would put another table's row
    // into the file under a label nobody checked.
    auditRows.push({
      id: row.id,
      action_type: row.action_type,
      target_type: row.target_type,
      target: aboutSelf
        ? 'you'
        : row.target_type === 'player'
          ? members.forMember(row.target_id as string | null)
          : `a ${String(row.target_type)}`,
      actor: 'you',
      reason: aboutSelf ? row.reason : null,
      old_value: null,
      new_value: null,
      payload_withheld: !aboutSelf,
      created_at: row.created_at,
    });
  }
  data.audit_logs = auditRows;

  // ---- credentials, metadata only -----------------------------------------
  data.passkey_credentials = (
    await reader.all('passkey_credentials', (q) => q.eq('player_id', playerId))
  ).map((row) => dropColumns(row, ['public_key', 'counter', 'credential_id']));

  data.push_subscriptions = (
    await reader.all('push_subscriptions', (q) => q.eq('player_id', playerId))
  ).map((row) => ({
    ...dropColumns(row, ['endpoint', 'p256dh_key', 'auth_key']),
    endpoint: truncateEndpoint(row.endpoint as string | null),
  }));

  // Existence and created_at only. The token is a plaintext bearer credential
  // (00013:11-15): exporting it would make this downloaded file a live
  // unauthenticated feed link, which then follows the file into every backup
  // and every email it is attached to.
  data.calendar_feed_tokens = (
    await reader.all('calendar_feed_tokens', (q) => q.eq('player_id', playerId), 'created_at')
  ).map((row) => ({ created_at: row.created_at }));

  data.discord_link_tokens = (
    await reader.all('discord_link_tokens', (q) => q.eq('consumed_by', playerId))
  ).map((row) => ({
    ...dropColumns(row, ['token_hash', 'consumed_by']),
    consumed_by: 'you',
  }));

  // A tombstone for a Discord account they have SINCE UNLINKED cannot be
  // attributed to them, by design: the table is keyed on discord_user_id and
  // deliberately carries no player_id, "because the player it used to belong to
  // may not exist any more" (00165:111-121).
  data.discord_role_revocations = discordUserId
    ? await reader.all('discord_role_revocations', (q) => q.eq('discord_user_id', discordUserId))
    : [];

  // Keyed on the AUTH user id with no foreign key (00262): when the member
  // first opened the console without a console passkey. Only console users
  // have a row.
  data.console_passkey_grace = authUserId
    ? await reader.all('console_passkey_grace', (q) => q.eq('user_id', authUserId), 'started_at')
    : [];

  // ---- club-wide context, kept to the minimum -----------------------------
  // NOT THE CLUB CALENDAR. Only enough of each parent object to make the
  // member's own rows legible, plus an "I created this" flag. Exporting the
  // whole schedule under the label of personal information would be a worse
  // answer than exporting none of it.
  const sessionIds = [
    ...new Set([...ids(ownAttendance, 'session_id'), ...ids(data.session_rsvp, 'session_id')]),
  ];
  data.sessions = (
    await reader.allInByKey(
      'sessions',
      sessionIds,
      (q, batch) => q.in('id', batch),
      'id, name, date, status, host_player_id',
    )
  ).map((row) => ({
    ...dropColumns(row, ['host_player_id']),
    you_hosted_this: row.host_player_id === playerId,
  }));
  const hostedSessions = await reader.all(
    'sessions',
    (q) => q.eq('host_player_id', playerId),
    'id, name, date, status',
  );
  for (const row of hostedSessions) {
    if (!sessionIds.includes(row.id as string)) {
      data.sessions.push({ ...row, you_hosted_this: true });
    }
  }

  data.tournament_events = await reader.allInByKey(
    'tournament_events',
    eventIds,
    (q, batch) => q.in('id', batch),
    'id, tournament_id, event_type, format, status',
  );
  const tournamentIds = [
    ...new Set([
      ...ids(data.tournament_events, 'tournament_id'),
      ...ids(data.event_waiver_acceptances, 'tournament_id'),
      ...ids(data.legacy_tournament_participants, 'tournament_id'),
    ]),
  ];
  data.tournaments = (
    await reader.allInByKey(
      'tournaments',
      tournamentIds,
      (q, batch) => q.in('id', batch),
      'id, name, start_date, end_date, status, created_by',
    )
  ).map((row) => ({
    ...dropColumns(row, ['created_by']),
    you_created_this: row.created_by === playerId,
  }));

  // Club events (00244): the member's sign-ups, then just enough of each event
  // to read them by, plus any event they created without signing up for it.
  data.club_event_signups = await reader.all('club_event_signups', (q) =>
    q.eq('player_id', playerId),
  );
  const clubEventIds = ids(data.club_event_signups, 'event_id');
  data.club_events = (
    await reader.allInByKey(
      'club_events',
      clubEventIds,
      (q, batch) => q.in('id', batch),
      'id, title, kind, starts_at, ends_at, location, status, created_by',
    )
  ).map((row) => ({
    ...dropColumns(row, ['created_by']),
    you_created_this: row.created_by === playerId,
  }));
  const createdClubEvents = await reader.all(
    'club_events',
    (q) => q.eq('created_by', playerId),
    'id, title, kind, starts_at, ends_at, location, status',
  );
  for (const row of createdClubEvents) {
    if (!clubEventIds.includes(row.id as string)) {
      data.club_events.push({ ...row, you_created_this: true });
    }
  }

  // Google Form registrations (00283). The member's own responses, then the
  // entries they asked for and the entries another member's form named them as
  // a partner in. Columns are named rather than starred, so a typed partner
  // name or email can never ride along.
  data.registration_imports = (
    await reader.all(
      'registration_imports',
      (q) => q.eq('submitter_player_id', playerId),
      'id, binding_id, response_id, submitted_at, result, superseded_by, created_at, updated_at',
    )
  ).map((row) =>
    dropColumns(row, ['submitter_player_id', 'key_id', 'payload_hash', 'submitter_name', 'submitter_email']),
  );
  const entryColumns =
    'id, import_id, item, tournament_event_id, club_event_id, category, wants_waitlist, status, reason, confirmed_at, confirm_email_sent_at, undone_at, undone_by, created_at, updated_at';
  const ownEntries = await reader.all(
    'registration_import_entries',
    (q) => q.eq('entrant_id', playerId),
    entryColumns,
  );
  const namedAsPartner = await reader.all(
    'registration_import_entries',
    (q) => q.eq('requested_partner_id', playerId),
    entryColumns,
  );
  const entriesAboutMember: Row[] = [
    ...ownEntries.map((row) => ({ ...row, you_are: 'the entrant' })),
    ...namedAsPartner
      .filter((row) => !ownEntries.some((own) => own.id === row.id))
      .map((row) => ({ ...dropColumns(row, ['import_id']), you_are: 'the named partner' })),
  ];
  data.registration_import_entries = entriesAboutMember.map((row) => ({
    ...dropColumns(row, [
      'entrant_id',
      'requested_partner_id',
      'undone_by',
      'external_name',
      'external_email',
      'partner_name',
      'partner_email',
      'confirm_email_error',
    ]),
    undone_by_role: officerDescriptor(row.undone_by as string | null),
  }));

  // Announcements they wrote, reduced to the title and the dates: the
  // announcement itself was published to the whole club.
  data.announcements = (
    await reader.all(
      'announcements',
      (q) => q.eq('author_id', playerId),
      'id, title, type, status, created_at, updated_at',
    )
    // author_id is dropped explicitly rather than merely left out of the
    // select list. The registry declares it withheld, and a column that is
    // withheld by virtue of a select list is one `select('*')` away from being
    // exported by accident.
  ).map((row) => ({ ...dropColumns(row, ['author_id']), you_wrote_this: true }));

  // ---- counted: official acts, not personal records -----------------------
  for (const [table, entry] of Object.entries(EXPORT_TABLES)) {
    if (entry.disposition !== 'counted') continue;
    counted[table] = await reader.countOnly(table, entry.playerColumns[0]!, (q) =>
      q.or(orEq(entry.playerColumns, playerId)),
    );
  }

  // ---- withheld: the count, never the rows --------------------------------
  // passkey_challenges.user_id is a bare uuid with explicitly no foreign key
  // (00181:42-56). The two enrol/login call sites pass the AUTH user id, and it
  // is NULL for a discoverable-credential login, so both ids are matched and
  // the count is expected to be zero almost always -- rows live about five
  // minutes. The rows themselves are never read: 00181:63-65 says outright
  // "There is nothing here a member should read, including their own rows."
  const challengeSubjects = authUserId ? [playerId, authUserId] : [playerId];
  withheldRows.passkey_challenges = await reader.countOnly('passkey_challenges', 'user_id', (q) =>
    q.in('user_id', challengeSubjects),
  );
  // Check-in tokens are per session and per tournament, not per member, so
  // there is nothing here that is the requester's at all. The count is stated
  // as zero rather than measured, because measuring it would mean counting
  // rows that are not about them.
  withheldRows.session_checkin_tokens = 0;
  withheldRows.tournament_checkin_tokens = 0;

  // Officer free text written ABOUT the member. COUNTED AND NEVER READ, so the
  // owner can see the stakes of the pending decision without the text moving.
  withheldRows.varsity_notes = await reader.countOnly('varsity_notes', 'player_id', (q) =>
    q.eq('player_id', playerId),
  );
  withheldRows.match_admin_notes = await countByParent(
    reader,
    'match_admin_notes',
    'match_id',
    matchIds,
  );
  withheldRows.tournament_participant_notes = await countByParent(
    reader,
    'tournament_participant_notes',
    'participant_id',
    participantIds,
  );
  withheldRows.tournament_pair_notes = await countByParent(
    reader,
    'tournament_pair_notes',
    'pair_id',
    pairIds,
  );
  withheldRows.tournament_match_notes = await countByParent(
    reader,
    'tournament_match_notes',
    'match_id',
    ids(data.tournament_matches, 'id'),
  );
  withheldRows.walkover_admin_notes = await countByParent(
    reader,
    'walkover_admin_notes',
    'walkover_id',
    ids(data.walkovers, 'id'),
  );

  // ==========================================================
  // ALL OR NOTHING
  // ==========================================================
  // Any read error fails the WHOLE request. There is no code path from here to
  // a document that is missing a table, which is the only way a file can be
  // trusted to mean what its manifest says.
  if (reader.failures.length > 0) return { ok: false, failures: reader.failures };

  const rowCounts: Record<string, { disposition: string; rows: number; why: string }> = {};
  for (const [table, entry] of Object.entries(EXPORT_TABLES)) {
    const rows =
      entry.disposition === 'counted'
        ? (counted[table] as number)
        : entry.disposition === 'export' || entry.disposition === 'project'
          ? (data[table] as Row[]).length
          : (withheldRows[table] as number);
    rowCounts[table] = { disposition: entry.disposition, rows, why: entry.why };
  }

  const withheld: { what: string; rows: number | null; why: string }[] = [];
  for (const [table, entry] of Object.entries(EXPORT_TABLES)) {
    if (entry.disposition !== 'withheld' && entry.disposition !== 'withheld_pending_owner_decision') {
      continue;
    }
    withheld.push({ what: table, rows: withheldRows[table] as number, why: entry.why });
  }
  for (const column of WITHHELD_COLUMNS) {
    withheld.push({
      what: `${column.table}.${column.column}`,
      // A column-level withholding has no row count of its own: the rows are in
      // `data`, it is the column that is not.
      rows: null,
      why: column.why,
    });
  }

  return {
    ok: true,
    document: {
      manifest: {
        schema_version: SCHEMA_VERSION,
        player_id: playerId,
        assembly_started_at: startedAt,
        assembly_completed_at: new Date().toISOString(),
        app_version: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
        tables_considered: TABLES_CONSIDERED,
        pseudonyms_allocated: members.count(),
        about_this_file: ABOUT_THIS_FILE,
        tables: rowCounts,
      },
      data,
      withheld,
      declared_gaps: DECLARED_GAPS,
      // Static, like the withholding rationales: the recipient list is a
      // property of the deployment rather than of the requesting member, so it
      // is not read per request.
      disclosure_recipients: DISCLOSURE_RECIPIENTS,
    },
  };
}

/** A parent-keyed count, chunked so the request line stays legal. */
async function countByParent(
  reader: Reader,
  table: string,
  column: string,
  parentIds: readonly string[],
): Promise<number> {
  if (parentIds.length === 0) return 0;
  let total = 0;
  // `chunkIds` and NOT a number written out here. selectInChunks itself is no
  // use for this (countOnly returns a number, not a ChunkResult it could
  // concatenate) but the SIZING must still come from IN_CHUNK_SIZE, which
  // query-chunks.ts names rather than inlines for exactly this reason: a second
  // hand-written batch size two files away would not move if the request-line
  // budget ever did, and the only symptom would be these counts starting to
  // 414.
  for (const batch of chunkIds(parentIds)) {
    total += await reader.countOnly(table, column, (q) => q.in(column, batch));
  }
  return total;
}

/**
 * The plain-language header of the file, so that a member who opens the JSON
 * and nothing else still knows what they are holding and what they are not.
 */
const ABOUT_THIS_FILE = [
  'This file is everything the SFU Badminton Club system holds about you that the app can reach.',
  'Some information is withheld. Every withholding is listed in the `withheld` section, with the reason in plain sentences. Nothing is left out silently.',
  'Some information the club holds is not reachable from the app at all. Those are listed in `declared_gaps` and can be answered by hand on request.',
  'Your information does not all sit on the club\'s own machine. The `disclosure_recipients` section names every outside organisation the club sends it to, what each one receives, and why.',
  'Other members appear only as `member_1`, `member_2` and so on, or as "a club officer". Those labels mean nothing outside this file, and no other member\'s id or name is in it: information about them is theirs to ask for, not yours.',
  'The `manifest.tables` section lists every table that was considered, its row count including zero, and what the export does with it. A count of zero means the table was read and held nothing about you.',
  'The tables were read one after another rather than in a single transaction, so rows may have changed between assembly_started_at and assembly_completed_at.',
] as const;
