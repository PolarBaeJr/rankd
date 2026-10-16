// WHAT THE SYSTEM HOLDS ABOUT A MEMBER, TABLE BY TABLE, AND WHAT THE EXPORT
// DOES WITH EACH ONE.
//
// THE GOVERNING IDEA OF THIS WHOLE FEATURE. The defence against creating a
// false record of compliance is NOT including everything. It is ENUMERATING
// THE WITHHOLDINGS. An export that says what it is not giving you is
// defensible; one that silently omits is not, because the member cannot tell
// the difference between "the club holds nothing about me here" and "the club
// holds something and this file did not look". Every disposition below
// therefore carries a `why` that lands in the file the member downloads, and
// the coverage test next door refuses to let a new table exist without one.
//
// NO I/O IN THIS FILE, deliberately. The coverage test imports it and compares
// it against the migration SQL; a single import of the Supabase client here
// would make that test need an environment.
//
// THE PARTITION IS TOTAL, and that is the point. An FK-only scan of the schema
// is not enough: five tables name a member with no foreign key at all (see
// NON_FK_PLAYER_TABLES). So the test asserts that EVERY table any migration
// creates and no migration drops lands in exactly one of four buckets, and
// names the offenders when one does not. A new table then fails a test instead
// of being quietly absent from a statutory access response.

/**
 * What the export does with a table.
 *
 *   export      Wholly the requester's. Rows go into `data` as they are, minus
 *               any `withheldColumns`.
 *   project     Jointly about the requester and somebody else. Rows go into
 *               `data` rewritten requester-relative: their own fields verbatim,
 *               every other member reduced to an opaque per-export pseudonym or
 *               a role descriptor. NEVER a uuid and never a name.
 *   counted     Considered and found to record an OFFICIAL ACT rather than a
 *               personal record: the member, wearing an officer's hat, changed
 *               a club-wide object. The export carries the count and not the
 *               rows, on the same reasoning the plan applies to club_ledger --
 *               a count, not the club cashbook. This is the "N/A" disposition:
 *               the table was considered and is not the requester's record.
 *   withheld    Never in the file. The `why` is, with a row count.
 *   withheld_pending_owner_decision
 *               Officer free text written ABOUT the member. 00117 and 00118
 *               exist specifically to keep this text away from members; an
 *               export including it reverses that intent, and the FIPPA s.13 /
 *               s.19 / s.22 exceptions are not something to adjudicate in code.
 *               Surfaced with a row count so the owner can see the stakes.
 */
export type Disposition =
  | 'export'
  | 'project'
  | 'counted'
  | 'withheld'
  | 'withheld_pending_owner_decision';

export interface ExportTable {
  /**
   * Every column on this table that names a member, foreign key or not. The
   * coverage test checks this against the FK columns it finds in the migration
   * SQL, so a new `... REFERENCES players(id)` column fails a test.
   */
  playerColumns: readonly string[];
  disposition: Disposition;
  /** When set, only these columns leave the database row. */
  columns?: readonly string[];
  /** Columns deliberately dropped or projected. Never in `columns`. */
  withheldColumns?: readonly string[];
  /** In plain sentences, because it is printed in the member's file. */
  why: string;
}

/**
 * `players`, minus the one column that is somebody else.
 *
 * READ WITH THE SERVICE CLIENT, NOT THE `players_self` VIEW. 00032:59 defines
 * that view as `SELECT * FROM players WHERE user_id = auth.uid()`, and Postgres
 * EXPANDS the star at view-creation time into the column list as it stood then.
 * 00134 only does `ALTER VIEW ... SET`, never a redefinition, so every column
 * added after 00032 is absent from it: handle and member_code (00092),
 * competition_category (00111), exec_bio (00130), skill_tier (00127),
 * passkey_setup (00121), inactivity_notice_sent_at (00060), inactive_since
 * (00062), the permission_* four (00087, 00093), is_trainer (00054),
 * membership_type (00040), privilege_claim_review (00132), elo_review (00163)
 * and exec_hidden (00225). An export built on that view would be short by
 * fourteen columns and would look perfectly healthy.
 *
 * THE PERMISSION COLUMNS ARE INCLUDED ON PURPOSE. permission_role,
 * permission_baseline_id, permission_grants and permission_revokes are facts
 * about the member's own account and they are entitled to them. Nothing in this
 * export can become privilege escalation: the route is read-only, performs no
 * writes, and no value in the file is accepted back as input anywhere.
 *
 * (`builtin_role` does not exist on this table -- the two role columns are
 * `role` and `permission_role`.)
 */
export const PLAYER_EXPORT_COLUMNS = [
  'id',
  'user_id',
  'email',
  'phone',
  'first_name',
  'last_name',
  'full_name',
  'display_name',
  'handle',
  'member_code',
  'avatar_url',
  'bio',
  'exec_bio',
  'exec_photo_url',
  'exec_title',
  'exec_hidden',
  'status',
  'role',
  'is_exec',
  'is_trainer',
  'is_banned',
  'banned_at',
  // THE TIE-BREAK CASE, AND IT IS INCLUDED. This is the reason the club
  // sanctioned THEM and the single most likely subject of an access request.
  // It is resolved by checking the product rather than by argument: it is
  // ALREADY shown to the banned member today. getAccountStanding()
  // (packages/shared/src/utils/account-standing.ts) folds it verbatim into the
  // suspension detail -- `Your account is suspended for "<ban_reason>"` -- and
  // standing-banner.tsx:40 renders that detail under the top bar on every page
  // of the app. Exporting it therefore changes nothing about what the member
  // can see, which is exactly the test that settles it.
  'ban_reason',
  'active_flag',
  'eligibility_flag',
  'fee_exempt',
  'membership_type',
  'competition_category',
  'skill_tier',
  'passkey_setup',
  'hide_from_leaderboard',
  'show_activity_status',
  'profile_visibility',
  'media_consent',
  'media_consent_changed_at',
  'notification_preferences',
  'tours_seen',
  'onboarding_completed',
  'joined_at',
  'created_at',
  'updated_at',
  'last_active_at',
  'inactive_since',
  'inactivity_notice_sent_at',
  'deletion_requested_at',
  'waiver_reset_at',
  'privilege_claim_review',
  'elo_review',
  'permission_role',
  'permission_baseline_id',
  'permission_grants',
  'permission_revokes',
] as const;

/**
 * The only column on `players` that is not about the requester.
 *
 * `banned_by` is the OFFICER who applied the ban -- another member's uuid, and
 * the single players-to-players foreign key on the table. A uuid is a joinable
 * identifier across the rest of the app, so handing one out turns the export
 * into a lookup key. The export emits `banned_by_role` instead, which says "a
 * club officer" and nothing more; it is a different key so that this name can
 * stay out of every allowlist.
 */
export const PLAYER_WITHHELD_COLUMNS = ['banned_by'] as const;

/**
 * The only keys an `audit_logs` / `tournament_audit_log` jsonb payload may keep.
 *
 * THE JSONB IS THE DANGER, not the row around it.
 * apps/admin/src/lib/auditable-player.ts exists because four admin actions
 * wrote whole `select('*')` player rows into `old_value`, and there are
 * production rows holding a real email address. A payload can therefore embed
 * ANOTHER member's row, and nothing in the row says which member it is about.
 * So both jsonb columns go through this allowlist rather than shipping raw.
 *
 * DUPLICATED FROM THE CONSOLE'S LIST RATHER THAN IMPORTED, on the same
 * reasoning realtime-publication.test.ts gives for duplicating itself: these
 * are separate workspaces with no path between them, and neither app's defence
 * may depend on the other's file. The cost of the duplication is that this list
 * can drift; the cost of importing across the workspace boundary is a build
 * dependency from the member app onto the console.
 *
 * The consequence is a real withholding and the export declares it: the
 * member's own name, email and phone are dropped from an audit PAYLOAD even
 * where the payload is their own row. They are exported in full from `players`,
 * which is where they belong.
 */
export const AUDIT_JSONB_ALLOWLIST = [
  'id',
  'status',
  'role',
  'is_exec',
  'is_trainer',
  'exec_title',
  'exec_hidden',
  'is_banned',
  'banned_at',
  'ban_reason',
  'active_flag',
  'eligibility_flag',
  'fee_exempt',
  'membership_type',
  'competition_category',
  'member_code',
  'deletion_requested_at',
  'hide_from_leaderboard',
  'show_activity_status',
  'profile_visibility',
  'media_consent',
  'media_consent_changed_at',
  'onboarding_completed',
  'joined_at',
  'created_at',
  'updated_at',
  'last_active_at',
  'inactive_since',
  'inactivity_notice_sent_at',
  'waiver_reset_at',
  'permission_role',
  'permission_baseline_id',
  'permission_grants',
  'permission_revokes',
  'skill_tier',
  'passkey_setup',
  'tours_seen',
  'privilege_claim_review',
  'elo_review',
] as const;

/**
 * THE THREE TABLES WHERE ZERO ROWS IS A BUG, NOT AN ABSENCE.
 *
 * `players` is filtered on the id the verified session resolved to, so exactly
 * one row exists by construction. `ratings` (UNIQUE player_id, 00001:189) and
 * `reliability_metrics` (UNIQUE player_id, 00001:570) are seeded per member and
 * hold at most and at least one row each. An empty answer from any of them
 * means the read was refused or the row is missing, and either way the file
 * would be wrong while looking complete -- so the assembler treats these as
 * ASSERTIONS and fails the whole request.
 */
export const EXACTLY_ONE_ROW = ['players', 'ratings', 'reliability_metrics'] as const;

export const EXPORT_TABLES: Record<string, ExportTable> = {
  // ---------------------------------------------------------------
  // EXPORT -- wholly the requester's
  // ---------------------------------------------------------------
  players: {
    playerColumns: ['id', 'banned_by'],
    disposition: 'export',
    columns: PLAYER_EXPORT_COLUMNS,
    withheldColumns: PLAYER_WITHHELD_COLUMNS,
    // The `show_activity_status` sentence is not padding. Audit 2.5 removed the
    // Settings switch for that column because it governed nothing, and handing
    // the stored value back without saying so would recreate exactly the
    // confidence the switch manufactured.
    why: 'Your own membership record: who you are, your standing with the club, your settings and the permissions your account holds. Two notes on the settings in it: show_activity_status is a stored value that governs nothing in the app today, which is why there is no longer a switch for it, and last_active_at is visible to club officers but to no other member. It also records whether you allow photos and video of you, and when you last changed that.',
  },
  ratings: {
    playerColumns: ['player_id'],
    disposition: 'export',
    why: 'Your singles and doubles ratings and every counter behind them.',
  },
  reliability_metrics: {
    playerColumns: ['player_id'],
    disposition: 'export',
    why: 'Your reliability record: no-shows, late cancellations, early withdrawals, walkovers received and disputes you were involved in. This is derived data that counts against you, which is exactly why you are entitled to see it.',
  },
  season_final_ratings: {
    playerColumns: ['player_id'],
    disposition: 'export',
    why: 'Your rating as it stood when each past season was archived.',
  },
  session_attendance: {
    playerColumns: ['player_id', 'marked_by'],
    disposition: 'export',
    // marked_by is the OFFICER who marked the attendance (00008:16), not the
    // member. Projected to a role descriptor under `marked_by_role` rather
    // than exported, for the same reason as players.banned_by: a uuid is a
    // joinable identifier across the rest of the app.
    withheldColumns: ['marked_by'],
    why: 'Every club session you checked into or were marked at, and how you were marked.',
  },
  session_rsvp: {
    playerColumns: ['player_id'],
    disposition: 'export',
    why: 'Every session you said you were going to, and the reminder we sent or tried to send you for it.',
  },
  club_event_signups: {
    playerColumns: ['player_id'],
    disposition: 'export',
    why: 'Every club event you signed up for, and when.',
  },
  waiver_acceptances: {
    playerColumns: ['player_id'],
    disposition: 'export',
    why: 'Every legal document you accepted, when, whether you attested to being of age, and the browser string your device sent at the time.',
  },
  event_waiver_acceptances: {
    playerColumns: ['player_id'],
    disposition: 'export',
    why: 'Every tournament waiver you accepted, and the browser string your device sent at the time.',
  },
  announcement_reads: {
    playerColumns: ['player_id'],
    disposition: 'export',
    why: 'Which club announcements you have opened, and when.',
  },
  notifications: {
    playerColumns: ['player_id'],
    disposition: 'export',
    why: 'Every in-app notification addressed to you, including the ones you have not read.',
  },
  digest_deliveries: {
    playerColumns: ['player_id'],
    disposition: 'export',
    why: 'Every weekly digest email we tried to send you and what happened to it.',
  },
  email_suppressions: {
    // NO PLAYER COLUMN AT ALL (00037:25-36). The primary key is the address,
    // so this read is matched on the email currently on your players row.
    playerColumns: [],
    disposition: 'export',
    why: 'Whether your email address is on the do-not-send list, why it got there, and the raw delivery report from the mail provider that put it there.',
  },
  player_discord_links: {
    playerColumns: ['player_id'],
    disposition: 'export',
    why: 'Your linked Discord account, when you linked it and when we last synced your roles.',
  },
  feedback_reports: {
    playerColumns: ['player_id'],
    disposition: 'export',
    // 00172:76-84 keeps the Discord handle even when player_id is set, and a
    // reporter who never linked an account has ONLY that. So the read matches
    // player_id OR the discord_user_id on the member's link row; matching
    // player_id alone would silently drop a member's own bug reports.
    why: 'Every bug report and piece of feedback you filed, from the website or from Discord.',
  },

  // ---------------------------------------------------------------
  // PROJECT -- jointly about the requester and somebody else
  // ---------------------------------------------------------------
  head_to_head_stats: {
    playerColumns: ['player_a_id', 'player_b_id'],
    disposition: 'project',
    withheldColumns: ['player_a_id', 'player_b_id'],
    // THE TRAP: `CHECK (player_a_id < player_b_id)` (00001:509) means the
    // member is in the a slot for some opponents and the b slot for the rest,
    // purely by uuid ordering. A naive `.eq('player_a_id', me)` returns
    // roughly HALF the rows and looks perfectly healthy. Both columns are
    // queried and each row is then rewritten requester-relative.
    why: 'Your record against each opponent, rewritten so the wins and points are yours. The opponent is named by a pseudonym that is stable only inside this file, because who you played is also information about them.',
  },
  partnership_stats: {
    playerColumns: ['player_a_id', 'player_b_id'],
    disposition: 'project',
    withheldColumns: ['player_a_id', 'player_b_id'],
    // Same CHECK, same trap, same fix. 00001:527.
    why: 'Your record with each doubles partner. The partner is named by a pseudonym that is stable only inside this file.',
  },
  match_participants: {
    playerColumns: ['player_id'],
    disposition: 'project',
    why: 'Your own line in every club match you played: your rating before and after, the rating change, your points and games. Your opponents have an identical line of their own and it is theirs, not yours, so they appear only as a pseudonym and a side of the net.',
  },
  matches: {
    playerColumns: ['submitted_by', 'confirmed_by', 'forfeit_player_id'],
    disposition: 'project',
    withheldColumns: ['submitted_by', 'confirmed_by', 'forfeit_player_id'],
    why: 'Every club match you played. Who submitted the score, who confirmed it and who forfeited are reduced to "you" or a pseudonym.',
  },
  match_games: {
    // No player reference of any kind; reached through the requester's own
    // match_participants rows.
    playerColumns: [],
    disposition: 'project',
    why: 'The game-by-game scores of the matches you played. There is nothing in these rows that names a person, so they are included in full.',
  },
  challenges: {
    playerColumns: ['created_by'],
    disposition: 'project',
    withheldColumns: ['created_by'],
    // `note` is the challenger's own words. Theirs when they wrote it; the
    // other member's personal information when they did not, so existence is
    // kept and the text withheld.
    why: 'Every challenge you created or were named in. The note is included when you wrote it; when somebody else wrote it, the export records that there was one and withholds the text, because those are their words.',
  },
  challenge_participants: {
    playerColumns: ['player_id'],
    disposition: 'project',
    why: 'Your own side of every challenge: your role, your side of the net and whether you confirmed. Everybody else on the challenge appears as a pseudonym.',
  },
  tournament_participants: {
    playerColumns: ['player_id', 'checked_in_by', 'added_by'],
    disposition: 'project',
    withheldColumns: ['checked_in_by', 'added_by'],
    why: 'Every tournament event you entered: your seed, your finishing position, your rating before and after, and your status. A status of no_show or disqualified counts against you, which is why it matters most here.',
  },
  tournament_pairs: {
    playerColumns: ['player1_id', 'player2_id', 'checked_in_by', 'added_by'],
    disposition: 'project',
    withheldColumns: ['player1_id', 'player2_id', 'checked_in_by', 'added_by'],
    why: 'Every doubles pair you were half of. Your partner appears as a pseudonym. The pair name is included because you may have chosen it, though it is often a real name and so is stripped of anything that is not yours.',
  },
  tournament_matches: {
    playerColumns: ['result_entered_by', 'ready_player_ids'],
    disposition: 'project',
    withheldColumns: ['result_entered_by'],
    // ready_player_ids is a bare uuid[] of everybody the door has marked
    // ready, so it is filtered down to the requester's own id.
    why: 'The draw matches you appear in. The "ready" list is filtered down to you alone, because the rest of it is other entrants. Who entered the result is reduced to "you" or a club officer.',
  },
  tournament_event_waitlist: {
    playerColumns: ['player_id', 'resolved_by'],
    disposition: 'export',
    // resolved_by is the OFFICER who promoted or removed the member (00278),
    // not the member. Projected to a role descriptor under `resolved_by_role`,
    // for the same reason as session_attendance.marked_by.
    withheldColumns: ['resolved_by'],
    why: 'Every tournament event waitlist you joined, when, and whether you were entered from it, left it, were skipped or were removed.',
  },
  data_api_predictions: {
    playerColumns: ['side1_p1', 'side1_p2', 'side2_p1', 'side2_p2'],
    disposition: 'project',
    // The consumer and the key are the club's arrangement with an outside
    // party, not the member's data. The model name is withheld by the club's
    // decision: it identifies the consumer as surely as the consumer id would.
    withheldColumns: ['side1_p1', 'side1_p2', 'side2_p1', 'side2_p2', 'consumer_id', 'key_id', 'model'],
    why: 'Win predictions an outside model made about matchups you are in, rewritten so the probability is your side\'s chance. Your partner and opponents appear as pseudonyms. Which outside party made each prediction is withheld. Predictions never changed your rating.',
  },
  // Google Form registrations (00283). The member's own form responses, and
  // what became of each entry in them. The emails and names a response
  // carried are not kept for members at all (a CHECK forbids it), and the
  // ones typed for a partner are withheld: they are somebody else's.
  registration_imports: {
    playerColumns: ['submitter_player_id'],
    disposition: 'project',
    // key_id is the club's arrangement with its own form script; payload_hash
    // is a digest of the response body and says nothing on its own.
    withheldColumns: ['submitter_player_id', 'key_id', 'payload_hash', 'submitter_name', 'submitter_email'],
    why: 'Every Google Form response of yours the club imported, when it arrived, and the answer the form was given.',
  },
  registration_import_entries: {
    playerColumns: ['entrant_id', 'requested_partner_id', 'undone_by'],
    disposition: 'project',
    // A row where somebody else named you as their partner is theirs: you get
    // that it exists and what became of it, never who they are. The officer
    // who undid an entry is a role, as everywhere else.
    withheldColumns: [
      'entrant_id',
      'requested_partner_id',
      'undone_by',
      'external_name',
      'external_email',
      'partner_name',
      'partner_email',
      'confirm_email_error',
    ],
    why: 'Each entry your form responses asked for, whether it was entered, waited for you or your partner, or was refused or undone, and entries another member\'s form named you as their partner in, without saying who they are.',
  },
  registration_import_forms: {
    playerColumns: ['created_by'],
    disposition: 'counted',
    why: 'Google Forms you bound to a tournament or club event, as an officer. Counted rather than listed: the binding is a club object.',
  },
  legacy_tournament_participants: {
    playerColumns: ['player_id', 'partner_id'],
    disposition: 'project',
    withheldColumns: ['partner_id'],
    why: 'Your entries in the tournaments that predate the current draw system. Your partner appears as a pseudonym.',
  },
  tournament_bonus_grants: {
    // subject_id is uuid NOT NULL and "Deliberately not a foreign key"
    // (00188:43-58): it holds a players.id for a 'rating' grant and a
    // tournament_participants.id for a 'participant_credit' one. So the match
    // is against the member's own id OR one of their own participant row ids.
    playerColumns: ['subject_id'],
    disposition: 'project',
    withheldColumns: ['subject_id'],
    why: 'Rating and placement bonuses granted to you at a tournament, and what actually landed after the clamp.',
  },
  tournament_audit_log: {
    playerColumns: ['performed_by'],
    disposition: 'project',
    withheldColumns: ['performed_by'],
    why: 'Tournament administration you performed yourself. The details payload is filtered to the same allowlist as the main audit log.',
  },
  walkovers: {
    playerColumns: ['reported_by', 'forfeit_player_id', 'admin_confirmed_by'],
    disposition: 'project',
    withheldColumns: ['reported_by', 'forfeit_player_id', 'admin_confirmed_by'],
    why: 'Walkovers you reported or forfeited, and whether a rating penalty was applied. Who reported, who forfeited and who confirmed are reduced to "you", a pseudonym or a club officer.',
  },
  disputes: {
    playerColumns: ['opened_by', 'resolved_by', 'claimed_by'],
    disposition: 'project',
    withheldColumns: ['opened_by', 'resolved_by', 'claimed_by', 'resolution_note'],
    // THE NUANCE. The full description goes out when opened_by is the
    // requester, because they wrote it. When they are merely a participant in
    // the disputed match the description is the OTHER member's account of
    // events and is that person's personal information, so the export keeps
    // existence, reason_category, status and the dates and withholds the text.
    // resolution_note is an officer's verdict and is withheld either way --
    // see WITHHELD_PENDING_OWNER_DECISION below.
    why: 'Disputes you opened or were involved in. Your own description is included in full because you wrote it. Where somebody else opened the dispute, the export keeps the category, the status and the dates and withholds their account of events, because that is their information about you rather than yours.',
  },
  club_fees: {
    playerColumns: ['player_id', 'marked_by'],
    disposition: 'project',
    withheldColumns: ['marked_by'],
    // manual_email (00252) never reaches an export. Its CHECK only allows it on
    // a player_id NULL row, which no requester's row is, and the claim trigger
    // clears it in the same UPDATE that sets player_id.
    why: 'Every membership, tournament, club event and reinstatement fee recorded against you, including the ban start and reason a missed fee carries.',
  },
  fee_submissions: {
    // player_id reaches players only through the composite key into club_fees
    // (00248), so the FK scan finds reviewed_by alone; both are listed.
    playerColumns: ['player_id', 'reviewed_by'],
    disposition: 'project',
    withheldColumns: ['reviewed_by', 'screenshot_path'],
    why: 'Every payment receipt you sent the club (e-transfer or Campus Rec): the reference, how it was paid, when you sent it, and whether an exec confirmed or rejected it, with the reason they gave. Which exec reviewed it is reduced to their role. Receipts you reviewed as an officer are other members\' payments and are not listed.',
  },
  club_ledger: {
    playerColumns: ['paid_by', 'marked_by', 'reimbursed_by'],
    disposition: 'project',
    withheldColumns: ['paid_by', 'marked_by', 'reimbursed_by'],
    // Rows where paid_by is the requester are their own money out of pocket
    // and come through. Rows where they are only marked_by or reimbursed_by
    // record an OFFICIAL ACT, so the export carries a count and not the club
    // cashbook.
    why: 'Club money that was yours: expenses you paid out of pocket and what you were reimbursed. Entries you merely recorded or authorised as an officer are counted, not listed, because the club cashbook is not your personal information.',
  },
  audit_logs: {
    playerColumns: ['actor_id', 'target_id'],
    disposition: 'project',
    withheldColumns: ['actor_id'],
    // THE ASYMMETRY THAT MATTERS. `target_type = 'player' AND target_id = me`
    // is the half done TO them -- approvals, rating edits, bans, permission
    // changes -- and it is the half they would not expect to be able to see.
    // `actor_id = me` is what they did. Non-player target_type values are left
    // unresolved on purpose: guessing which table a target_id belongs to would
    // put another table's row into the file under a label nobody checked.
    why: 'The club\'s record of administrative actions taken about you, and of actions you took yourself. Where you were the one acting on somebody else, the export keeps the action and the date and withholds the payload and your reason, because a record of what was done to another member is their information.',
  },
  announcements: {
    playerColumns: ['author_id'],
    disposition: 'project',
    withheldColumns: ['author_id'],
    why: 'Club announcements you wrote. Reduced to the title and the dates: the announcement itself was published to the whole club and is not a record about you.',
  },
  sessions: {
    playerColumns: ['host_player_id'],
    disposition: 'project',
    withheldColumns: ['host_player_id'],
    why: 'Only enough of each club session to make your attendance and RSVP rows legible, plus a flag where you hosted it. The club calendar is not personal information and is not exported under that label.',
  },
  tournaments: {
    playerColumns: ['created_by'],
    disposition: 'project',
    withheldColumns: ['created_by'],
    why: 'Only enough of each tournament to make your entries legible, plus a flag where you created it.',
  },
  club_events: {
    playerColumns: ['created_by'],
    disposition: 'project',
    withheldColumns: ['created_by'],
    why: 'Only enough of each club event to make your sign-ups legible, plus a flag where you created it.',
  },
  tournament_events: {
    playerColumns: [],
    disposition: 'project',
    why: 'Only enough of each tournament event to make your entries and draw matches legible.',
  },
  discord_role_revocations: {
    // Keyed on discord_user_id and deliberately carrying no player_id,
    // "because the player it used to belong to may not exist any more"
    // (00165:111-121).
    playerColumns: [],
    disposition: 'project',
    why: 'A queued instruction to strip club roles from a Discord account, included only where that account is the one currently linked to you.',
  },
  console_passkey_grace: {
    // A bare `user_id uuid` (the auth user id) with no foreign key (00262).
    playerColumns: ['user_id'],
    disposition: 'export',
    why: 'When you first opened the admin console without a console passkey. The console opens without one for 14 days from then. Only people with console access have a row.',
  },
  passkey_credentials: {
    playerColumns: ['player_id'],
    disposition: 'project',
    withheldColumns: ['public_key', 'counter', 'credential_id'],
    why: 'That you have passkeys, how many, when each was enrolled and last used, and on what kind of device. The key material itself is withheld.',
  },
  push_subscriptions: {
    playerColumns: ['player_id'],
    disposition: 'project',
    withheldColumns: ['p256dh_key', 'auth_key'],
    why: 'That you have push notifications enabled on a browser and when you enabled it. The sending credential is withheld and the endpoint is truncated.',
  },
  calendar_feed_tokens: {
    playerColumns: ['player_id'],
    disposition: 'project',
    withheldColumns: ['token'],
    why: 'That you have a personal calendar feed, and when it was created. The token is withheld.',
  },
  discord_link_tokens: {
    playerColumns: ['consumed_by'],
    disposition: 'project',
    withheldColumns: ['token_hash', 'consumed_by'],
    why: 'Discord account-linking invitations you used, and when. The token hash is withheld.',
  },

  // ---------------------------------------------------------------
  // COUNTED -- an official act, not a personal record
  // ---------------------------------------------------------------
  legal_documents: {
    playerColumns: ['updated_by'],
    disposition: 'counted',
    why: 'Club legal documents you published a version of, as an officer. Counted rather than listed: the documents are club-wide and public, and editing one is an official act rather than a record about you.',
  },
  platform_settings: {
    playerColumns: ['updated_by'],
    disposition: 'counted',
    why: 'Club-wide settings you last changed, as an officer. Counted rather than listed, for the same reason.',
  },
  permission_baselines: {
    playerColumns: ['created_by', 'updated_by'],
    disposition: 'counted',
    why: 'Permission templates you created or edited, as an officer. Counted rather than listed. The permissions YOUR account holds are in your players row above.',
  },
  club_change_drafts: {
    // Bare uuids with no foreign key (00286), so the officer who made a change
    // can be deleted without losing the line.
    playerColumns: ['first_actor_id', 'last_actor_id'],
    disposition: 'counted',
    why: 'Club change lines waiting to be posted that your edits as an officer started or last changed. Counted rather than listed, for the same reason.',
  },
  club_change_entries: {
    // A bare uuid with no foreign key (00286).
    playerColumns: ['posted_by'],
    disposition: 'counted',
    why: 'Club change entries you posted to members, as an officer. Counted rather than listed: the entries are club-wide.',
  },
  event_waiver_templates: {
    playerColumns: ['updated_by'],
    disposition: 'counted',
    why: 'Tournament waiver templates you last edited, as an officer. Counted rather than listed. The waivers you ACCEPTED are exported in full.',
  },
  discord_outbox: {
    playerColumns: ['requested_by'],
    disposition: 'counted',
    why: 'Discord messages you asked the console to send, as an officer. Counted rather than listed: the message is a club-wide post.',
  },
  data_api_consumers: {
    playerColumns: ['created_by'],
    disposition: 'counted',
    why: 'Outside organisations you wrote down as data API recipients, as an officer. Counted rather than listed: the row is about that organisation and the club\'s agreement with it, not about you.',
  },
  data_api_keys: {
    // key_hash is withheld for the same reason discord_link_tokens withholds
    // its token hash: it is a credential probe, and nothing about it is a fact
    // about the officer who minted it.
    playerColumns: ['minted_by', 'revoked_by'],
    disposition: 'counted',
    withheldColumns: ['key_hash'],
    why: 'Data API keys you minted or revoked, as an officer. Counted rather than listed: issuing a key is an official act on behalf of the club, and the key itself is about the organisation that received it. The stored hash of a key is never exported. If you want to know what the data API publishes ABOUT YOU, that is your ratings row above, reduced to a pseudonym.',
  },
  tournament_category_requests: {
    playerColumns: ['requested_by', 'resolved_by'],
    disposition: 'counted',
    why: 'Team category changes you asked for or decided in a staged tournament event, as an officer. Counted rather than listed: the request is about a team\'s head start, not about you.',
  },

  // ---------------------------------------------------------------
  // WITHHELD -- never in the file, reason given
  // ---------------------------------------------------------------
  passkey_challenges: {
    // RLS is on with ZERO policies and 00181:63-65 says outright: "No
    // policies: every access goes through the two SECURITY DEFINER functions
    // below. There is nothing here a member should read, including their own
    // rows." `user_id` is a bare uuid with explicitly no foreign key
    // (00181:42-56), and it is NULL for a discoverable-credential login, so
    // even matching the requester's rows is unreliable.
    playerColumns: ['user_id'],
    disposition: 'withheld',
    withheldColumns: ['challenge_hash'],
    why: 'Sign-in ceremony scratch space with a life of about five minutes, holding a challenge hash and nothing else. Migration 00181 states that there is nothing here a member should read, including their own rows. The count below is of rows currently naming your account, which will normally be zero.',
  },
  session_checkin_tokens: {
    playerColumns: [],
    disposition: 'withheld',
    withheldColumns: ['token'],
    why: 'Check-in tokens are issued per session and not per member, so they are not your personal information at all. Holding the token IS the proof of being at the door, so it is never exported.',
  },
  tournament_checkin_tokens: {
    playerColumns: [],
    disposition: 'withheld',
    withheldColumns: ['token'],
    why: 'Check-in tokens are issued per tournament and not per member, so they are not your personal information at all. Holding the token IS the proof of being at the door, so it is never exported.',
  },

  // ---------------------------------------------------------------
  // WITHHELD PENDING OWNER DECISION -- officer free text about the member
  // ---------------------------------------------------------------
  //
  // Migrations 00117 and 00118 moved this text out of member-readable tables
  // specifically to keep it away from members, into tables with no grant for
  // `authenticated` and RLS on with no policy. An export that included it would
  // reverse that intent in one commit, and the FIPPA s.13 (advice and
  // recommendations), s.19 (health or safety) and s.22 (unreasonable invasion
  // of a third party's privacy) exceptions are not something to adjudicate in
  // code. Each is surfaced WITH A ROW COUNT so the owner can see the stakes.
  varsity_notes: {
    playerColumns: ['player_id', 'author_id'],
    disposition: 'withheld_pending_owner_decision',
    withheldColumns: ['note'],
    why: 'Trainer notes written about you (00001:531). Withheld pending a decision by the club, under the FIPPA s.13 advice-and-recommendations and s.22 third-party exceptions.',
  },
  match_admin_notes: {
    playerColumns: ['author_id'],
    disposition: 'withheld_pending_owner_decision',
    withheldColumns: ['note'],
    why: 'An officer\'s private note on a match you played, including the reason for a void or a demotion (00117:206). Withheld pending a decision by the club, under the FIPPA s.13 and s.22 exceptions.',
  },
  tournament_participant_notes: {
    playerColumns: ['author_id'],
    disposition: 'withheld_pending_owner_decision',
    withheldColumns: ['note'],
    why: 'An officer\'s private note on your tournament entry, including the reason for a withdrawal or a disqualification (00118:209-249). Withheld pending a decision by the club, under the FIPPA s.13 and s.22 exceptions.',
  },
  tournament_pair_notes: {
    playerColumns: ['author_id'],
    disposition: 'withheld_pending_owner_decision',
    withheldColumns: ['note'],
    why: 'An officer\'s private note on a doubles pair you were half of (00118:209-249). Withheld pending a decision by the club, under the FIPPA s.13 and s.22 exceptions.',
  },
  tournament_match_notes: {
    playerColumns: ['author_id'],
    disposition: 'withheld_pending_owner_decision',
    withheldColumns: ['note'],
    why: 'An officer\'s private note on a draw match you appear in (00118:209-249). Withheld pending a decision by the club, under the FIPPA s.13 and s.22 exceptions.',
  },
  walkover_admin_notes: {
    playerColumns: ['author_id'],
    disposition: 'withheld_pending_owner_decision',
    withheldColumns: ['note'],
    why: 'An officer\'s verdict on a walkover you were part of (00118:209-249). Withheld pending a decision by the club, under the FIPPA s.13 and s.22 exceptions.',
  },
};

/**
 * THE COLUMN-LEVEL WITHHOLDINGS THAT ARE NOT A WHOLE TABLE.
 *
 * Every entry appears in the file's `withheld` stanza in its own right, because
 * a member reading a `passkey_credentials` list with no key material has no way
 * to tell that the key material was considered and refused rather than never
 * looked for.
 *
 * WHAT THE PLAN EXPECTED TO FIND HERE AND WHAT IS ACTUALLY THERE. Five officer
 * free-text COLUMNS were meant to be on this list -- matches.admin_note,
 * walkovers.admin_notes, tournament_participants.notes, tournament_pairs.notes
 * and tournament_matches.notes. All five are GONE: 00122:373-375 dropped the
 * first, tournament_pairs.notes and tournament_matches.notes, and 00125:657-658
 * dropped tournament_participants.notes and walkovers.admin_notes. 00117 and
 * 00118 wrote the drops out for a later hand and that hand came. The only
 * survivor of that family is disputes.resolution_note.
 */
export const WITHHELD_COLUMNS: readonly {
  table: string;
  column: string;
  why: string;
}[] = [
  {
    table: 'passkey_credentials',
    column: 'public_key',
    why: 'Key material. Not exported under any circumstances.',
  },
  {
    table: 'passkey_credentials',
    column: 'counter',
    why: 'Clone-detection state. Exporting it would help somebody hide a cloned authenticator.',
  },
  {
    table: 'passkey_credentials',
    column: 'credential_id',
    why: 'A stable cross-site identifier for your authenticator. It identifies the device rather than describing you, and putting it in a downloadable file spreads it.',
  },
  {
    table: 'push_subscriptions',
    column: 'p256dh_key',
    why: 'Half of the credential that lets a server push a notification to that browser. Those two keys and the endpoint together ARE the sending credential.',
  },
  {
    table: 'push_subscriptions',
    column: 'auth_key',
    why: 'The other half of the same credential.',
  },
  {
    table: 'push_subscriptions',
    column: 'endpoint',
    why: 'Truncated to the push service host. The full endpoint is the third part of the sending credential.',
  },
  {
    table: 'calendar_feed_tokens',
    column: 'token',
    why: 'A plaintext bearer credential (00013:11-15). Exporting it would make this downloaded file a live, unauthenticated feed link to your schedule, and it would then follow the file into every backup and every email it is attached to.',
  },
  {
    table: 'discord_link_tokens',
    column: 'token_hash',
    why: 'Credential material for the account-linking flow.',
  },
  {
    table: 'disputes',
    column: 'resolution_note',
    why: 'An officer\'s written verdict on a dispute. Withheld pending a decision by the club, under the FIPPA s.13 advice-and-recommendations exception. It is the last survivor of the officer free-text columns; the other five were dropped outright by 00122 and 00125.',
  },
  {
    table: 'challenges',
    column: 'note',
    why: 'Included when you wrote the challenge. Withheld when somebody else did, because those are their words.',
  },
  {
    table: 'disputes',
    column: 'description',
    why: 'Included when you opened the dispute. Withheld when somebody else did, because it is their account of events and therefore their personal information.',
  },
  {
    table: 'audit_logs',
    column: 'old_value / new_value',
    why: 'Filtered to an allowlist of standing columns -- status, role, bans, permissions, dates. Four console actions once wrote whole member rows into these columns and some production rows still hold an email address, and nothing in a payload says which member it is about. Your own name, email and phone are exported in full from your players row instead.',
  },
  {
    table: 'audit_logs',
    column: 'reason (on actions you took)',
    why: 'Withheld on rows where you acted on another member. Your reason for an administrative act names and describes that member, so it is their personal information rather than yours.',
  },
  {
    table: 'players',
    column: 'banned_by',
    why: 'The officer who applied a ban. Replaced by banned_by_role, which says "a club officer" and nothing more: a member uuid is a joinable identifier across the rest of the app, so handing one out would turn this file into a lookup key.',
  },
  {
    table: 'session_attendance',
    column: 'marked_by',
    why: 'The officer who marked your attendance (00008:16). Replaced by marked_by_role, for the same reason.',
  },
  {
    table: 'cron_config',
    column: '(the whole table)',
    why: 'Never read by this export, filtered or not: the table holds the shared reminder secret and holds nothing about any member.',
  },
];

/**
 * TABLES THAT NAME A MEMBER WITH NO FOREIGN KEY, which is why the coverage
 * test's partition has to be TOTAL rather than FK-derived. An FK-only scan
 * misses every one of these, and each of them holds personal information.
 *
 * All four are in EXPORT_TABLES above; this list exists so the partition can
 * account for them without the FK scan finding them.
 */
export const NON_FK_PLAYER_TABLES: Record<string, string> = {
  email_suppressions:
    'Keyed on the email address, with no player column at all (00037:25-36). Matched on the address currently on your players row.',
  passkey_challenges:
    'A bare `user_id uuid` with explicitly no foreign key (00181:42-56), and null for a discoverable-credential login.',
  discord_role_revocations:
    'Keyed on discord_user_id and deliberately carrying no player_id, because the player it used to belong to may not exist any more (00165:111-121).',
  console_passkey_grace:
    'A bare `user_id uuid` (the auth user id) with no foreign key (00262), and only for people with console access.',
  tournament_bonus_grants:
    '`subject_id uuid NOT NULL`, "Deliberately not a foreign key" (00188:43-58): a players.id for a rating grant, a tournament_participants.id for a participant credit.',
  club_change_drafts:
    'Bare `first_actor_id` and `last_actor_id` uuids with no foreign key (00286): the officer whose edit started or last changed a pending line.',
  club_change_entries:
    'A bare `posted_by` uuid with no foreign key (00286): the officer who posted the entry.',
};

/**
 * Tables that hold nothing about any member.
 *
 * Four of these are read anyway and say so in EXPORT_TABLES -- match_games and
 * tournament_events as the context that makes the member's own rows legible,
 * and the two check-in token tables as declared withholdings. Being read is not
 * the same as being about a person, and this list records the second thing.
 */
export const NOT_ABOUT_PLAYERS: Record<string, string> = {
  cron_config:
    'Scheduled-job configuration, including the shared reminder secret. Never read by this export.',
  schema_migrations: 'Which migrations have been applied.',
  seasons: 'The club\'s seasons. A club-wide object.',
  tournament_fee_tiers: 'Tournament price tiers. A club-wide object.',
  tournament_courts: 'The courts of a tournament (00273). A venue object, with no player reference.',
  match_games:
    'Game scores hanging off a match id, with no player reference. Exported as the context for the member\'s own matches.',
  tournament_events:
    'An event within a tournament, with no player reference. Exported in minimal form as the context for the member\'s own entries.',
  session_checkin_tokens:
    'One token per session, not per member. Withheld and declared.',
  tournament_checkin_tokens:
    'One token per tournament, not per member. Withheld and declared.',
  discord_settings: 'Bot configuration.',
  discord_guilds: 'Which Discord servers the bot is in.',
  discord_guild_roles: 'The bot\'s role mapping per server.',
  discord_server_roles: 'A catalogue of roles discovered on a Discord server.',
  discord_self_roles: 'Which roles members may give themselves. A club-wide menu.',
  discord_session_pings: 'Which session announcements the bot has already pinged.',
  discord_announcement_posts: 'Which announcements the bot has already posted.',
  discord_match_posts: 'Which match results the bot has already posted.',
  discord_feedback_posts: 'Which feedback reports the bot has already relayed.',
  discord_tournament_events: 'Which tournament events the bot has already posted.',
  discord_club_events: 'Which club events the bot has already posted to the Discord Events tab.',
  discord_signup_drafts:
    'Pre-account scratch, purged within 30 minutes, no player id. A Discord /signup in progress, before any account exists (00281).',
  discord_signup_attempts:
    'A rate-limit ledger for Discord /signup, purged after a day, no player id. The email is kept only as a digest (00281).',
  guest_waiver_signings:
    'Waiver signings by guests who are not members and have no account. There is no member column; it holds non-members\' names and emails, which a member export cannot reach.',
  guest_waiver_invites:
    'Waiver emails owed to non-members a form entered (00283). No member column; it holds non-members\' emails, which a member export cannot reach.',
  club_event_external_signups:
    'Non-members a form signed up for a club event (00284). No member column; it holds non-members\' names and emails.',
};

/**
 * Tables a migration created and a later migration dropped.
 *
 * The coverage test SUBTRACTS these, because a parser that only looks for
 * CREATE TABLE finds six tables that no longer exist and would demand a
 * disposition for each.
 */
export const DROPPED_TABLES: Record<string, string> = {
  club_expenses: 'Folded into club_ledger and dropped (00159:217).',
  other_income: 'Folded into club_ledger and dropped (00159:218).',
  event_feedback: 'Superseded by feedback_reports and dropped (00176:512).',
  tournament_fees: 'Folded into club_fees and dropped (00095:287).',
  reinstatement_fees: 'Folded into club_fees and dropped (00095:288).',
  season_snapshots: 'Superseded by season_final_ratings and dropped (00162:131).',
};

/**
 * Scratch tables that exist only inside a migration body and never in the
 * schema. A NAMED LIST rather than a regex, because a regex that happened to
 * exclude them would also exclude a real table somebody named badly, and
 * nothing would say so.
 *
 *   _00128_acl_before  00128:144, `CREATE TEMP TABLE ... ON COMMIT DROP`
 *   _00134_acl_before  00134:382, created TEMP and dropped at 376 and 629
 *   _mp_guard_probe    00207:790, the merge-guard test harness
 */
export const MIGRATION_SCRATCH_TABLES = [
  '_00128_acl_before',
  '_00134_acl_before',
  '_mp_guard_probe',
] as const;

/**
 * Personal information the system holds that this export CANNOT reach, stated
 * in the file rather than omitted from it.
 *
 * This is the enumerate-the-withholdings idea applied to the export's own
 * limits rather than to its policy choices. A member who is told the auth
 * schema exists and is answered by hand can ask for it; a member handed a file
 * that silently stops at the PostgREST boundary cannot.
 */
export const DECLARED_GAPS: readonly { gap: string; detail: string }[] = [
  {
    gap: 'The database\'s `auth` schema',
    detail:
      'Three tables hold personal information that no application code can read, because PostgREST exposes only the exposed schemas and `auth` is not one of them. `auth.users` holds your real email address and your sign-in timestamps. `auth.identities` holds the (provider, provider_id) pairs that resolve you across Google and email sign-in. `auth.audit_log_entries` holds roughly 730 production rows carrying a real email address in payload.actor_username. Answering for these is an owner-run psql step, written out in docs/ops/member-data-export.md.',
  },
  {
    gap: 'Stored files',
    detail:
      'The export carries the PATHS of your profile photo (players.avatar_url), your officer photo (players.exec_photo_url), any screenshot attached to feedback you filed (feedback_reports.image_path, 00174) and any receipt attached to an expense you paid (club_ledger.receipt_path, 00231), and whether the club holds the screenshot you sent with an e-transfer receipt (fee_submissions.screenshot_path, 00248, shown as screenshot_held). A photograph of you is personal information. The binaries themselves are not embedded in this file, because that would turn kilobytes of JSON into megabytes of base64; they are available on request.',
  },
  {
    gap: 'History under a merged-away account id',
    detail:
      'If two of your accounts were ever merged, merge_players rewrites your player id across many tables, and its guard sees only CASCADE references, so rows in tables that SET NULL instead can be left under an id nobody queries. This export reads your CURRENT player id only, so history stranded under a merged-away id may be missing from it.',
  },
  {
    gap: 'Suppressions against a previous email address',
    detail:
      'email_suppressions is keyed on the address itself and holds no player column (00037:25-36), so it is matched against the address currently on your record. If your address has changed, a suppression filed against the old one is not reachable by this export.',
  },
  {
    gap: 'Tournament administration recorded ABOUT you',
    detail:
      'tournament_audit_log has no target column: when an officer withdraws or disqualifies somebody, the row is keyed by the OFFICER in performed_by and you appear inside the free-form details payload. So the rows exported here are the ones you performed yourself. Officer actions about you are in that table and are not retrievable by this export.',
  },
  {
    gap: 'A point-in-time snapshot',
    detail:
      'This file is assembled by reading about fifty tables one after another, not in a single transaction. Rows may have changed between the assembly_started_at and assembly_completed_at timestamps in the manifest. Nothing here is a consistent snapshot of one instant, and it is not represented as one.',
  },
];

/**
 * The organisations this system sends member personal information to.
 *
 * WHY THIS IS IN THE EXPORT AND NOT ONLY IN THE PRIVACY POLICY. An access
 * request is answered with a list of the information held, and "held" includes
 * information the club has handed to somebody else to process on its behalf.
 * A member reading a file that enumerates fifty tables down to the column would
 * reasonably conclude it was complete, and it would not be: none of these rows
 * live only on the server.
 *
 * WHAT IS DELIBERATELY NOT ON THIS LIST. PostHog is wired into the code
 * (`lib/posthog.ts`, and `components/posthog-identify.tsx` would send the
 * player uuid via `identify()`) but `NEXT_PUBLIC_POSTHOG_KEY` is NOT set in
 * production, so both the browser and the server client short-circuit and no
 * member data reaches it. Verified against prod's env on 2026-09-21 by reading
 * key NAMES only. It is left off because naming a recipient that receives
 * nothing is its own inaccuracy, and a member cannot check the claim. If that
 * key is ever set, this list gains an entry in the same commit.
 *
 * Each `what` describes the narrowest true thing, not the category. "Your email
 * address" is checkable by the member; "personal data" is not.
 */
export const DISCLOSURE_RECIPIENTS: readonly {
  organisation: string;
  what: string;
  why: string;
}[] = [
  {
    organisation: 'Resend',
    what:
      'Your email address, and the delivery result for every message the club sent you, including bounces and complaints.',
    why: 'Sends the club\'s email: sign-in codes, session reminders and announcements. Its suppression records are mirrored back into email_suppressions, which is in this export.',
  },
  {
    organisation: 'Sentry',
    what:
      'Whatever was in scope at the moment the app hit an error, which can include your player id and, historically, whole member rows.',
    why: 'Collects crash and error reports so faults get fixed. The club scrubs known-sensitive fields before sending, but an error payload is not an enumerable dataset and is described here as the open-ended thing it is.',
  },
  {
    organisation: 'Discord',
    what:
      'Your Discord account id if you linked one, plus anything you typed into a bot command or a feedback form.',
    why: 'Runs the club\'s server and the bot that posts sessions and takes sign-ups. A Discord id alongside the club roster identifies you on its own.',
  },
  {
    organisation: 'Google',
    what:
      'Your email address and Google account id, if you sign in with Google. Nothing if you use an email code.',
    why: 'Provides the "Sign in with Google" option. The club receives the identifier from Google rather than sending it, but the sign-in itself tells Google you use this app.',
  },
  {
    organisation: 'Cloudflare',
    what:
      'Your IP address and the requests you make, in transit. Cloudflare terminates TLS, so request contents pass through it.',
    why: 'Fronts example.com for DNS, TLS and denial-of-service protection. Every visitor transits it before reaching the club\'s own hardware.',
  },
  {
    organisation: 'Google Drive (backups)',
    what:
      'A complete nightly copy of the club database, encrypted before it leaves the club\'s hardware.',
    why: 'Off-site backup, so a failure of the club\'s own machine is not permanent data loss. The copy is encrypted at rest and Google cannot read its contents.',
  },
];

/** Pinned by the coverage test so the manifest cannot drift from the registry. */
export const TABLES_CONSIDERED = Object.keys(EXPORT_TABLES).length;
