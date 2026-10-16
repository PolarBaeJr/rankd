// WHERE EVERY CAPABILITY IS ACTUALLY ENFORCED.
//
// 119 capabilities is 119 promises that something in the app checks something.
// This map is what keeps them honest: every entry names the file and function
// that stands behind it, and the drift test asserts the map is exhaustive, that
// no two capabilities claim the same enforcement point, and that any capability
// covering more than one call site says WHY those sites are one act.
//
// Without it the permission editor becomes a UI that lies — a tick box for
// something no gate reads.
//
// SEPARATE MODULE from ./access-level on purpose. The vocabulary is pulled into
// the EDGE middleware through canAccess(); this map is labels and prose, needed
// only by the editor and by tests, and there is no reason to ship it on every
// request. Same discipline as the deep import in the admin app's permissions.ts.
import { CAPABILITIES, type Area, type Capability } from './access-level';

export type CapabilityGate = {
  /** Shown to a human — in the editor, and in grant-closure refusals. */
  label: string;
  area: Area;
  /**
   * Tier-2 grouping for the editor. Non-null only where an area is too large to
   * render flat (tournaments at 44, fees at 18), and always the capability's
   * second path segment.
   */
  group: string | null;
  mode: 'page' | 'read' | 'write';
  /**
   * The enforcement point: `<file> <function>`, or `route <path>` where the
   * middleware's section check is the whole gate. `null` means NOT YET WIRED,
   * which is a loud state — see the assertion in the drift test. Nothing is
   * null any more: permissions.write was the last one, and it got its gate when
   * setPlayerPermissions landed.
   */
  gate: string | null;
  /** Further call sites this one capability gates. Requires `merged`. */
  also?: readonly string[];
  /** Why those sites are one capability rather than several. */
  merged?: string;
  /** Why this capability has no gate yet. Required when `gate` is null. */
  unwired?: string;
};

// Merge only where two sites are literally the same act reached twice. Never
// merge create with update; never merge a destructive act with a
// non-destructive one.
const MINT_A_TOKEN = 'Getting the token and rotating it are one act — minting a check-in secret.';
const MARK_OR_CLEAR = 'Marking and clearing an attendance mark are the same act in two directions.';
const SWITCHED_OFF = 'Opening a switched-off feature and using it are one act: being let into something members are kept out of.';

export const CAPABILITY_GATES: Record<Capability, CapabilityGate> = {
  // ---- players -----------------------------------------------------------
  'players.page': {
    label: 'Open the roster', area: 'players', group: null, mode: 'page',
    gate: 'route /players',
  },
  'players.read': {
    label: 'The roster', area: 'players', group: null, mode: 'read',
    gate: 'app/players/page.tsx roster fetch',
    also: [
      'app/players/[id]/page.tsx member record fetches',
      'app/dashboard/page.tsx active players count',
      'app/legal/media-consent/page.tsx member consent fetch',
      'app/legal/signatures/page.tsx member signatures fetch',
    ],
    merged: 'The list, one member’s record, the count of them, the members who allow photos and the members’ signatures list are five renderings of the same rows.',
  },
  'players.approve.write': {
    label: 'Approve a pending member', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts approvePlayer',
  },
  'players.create.write': {
    label: 'Add a member', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts createPlayer',
  },
  'players.update.write': {
    label: 'Edit a member', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts updatePlayer',
  },
  'players.waiver.resign.write': {
    label: 'Require a waiver re-signature', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts requireWaiverResignature',
  },
  'players.ban.write': {
    label: 'Ban a member', area: 'players', group: null, mode: 'write',
    gate: 'actions/reinstatement.ts banPlayer',
  },
  'players.reinstate.write': {
    label: 'Reinstate a member', area: 'players', group: null, mode: 'write',
    gate: 'actions/reinstatement.ts reinstatePlayer',
  },
  'players.editor.varsitynotes.write': {
    label: 'Varsity notes', area: 'players', group: null, mode: 'write',
    gate: 'actions/varsity.ts createVarsityNote',
    also: ['actions/varsity.ts deleteVarsityNote'],
    merged: 'Writing and withdrawing a coaching record are one authority over the same log.',
  },
  'players.deletion.cancel.write': {
    label: 'Cancel an account deletion', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts cancelAccountDeletion',
  },
  'players.remove.write': {
    label: 'Remove a member', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts removePlayer',
  },
  'players.merge.write': {
    label: 'Merge duplicate members', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts mergePlayers',
    also: ['actions/players.ts previewPlayerMerge'],
    merged: 'The preview is the dry run of the same act, over the same two rows.',
  },
  'players.reliability.write': {
    label: 'Adjust a reliability score', area: 'players', group: null, mode: 'write',
    gate: 'actions/reliability.ts adjustReliability',
  },
  'players.privilegedfields.write': {
    label: 'Privileged player fields', area: 'players', group: null, mode: 'write',
    gate: 'lib/player-field-access.ts assertPlayerFieldAccess',
  },
  // ONE GATE, AND IT HAS TO STAY ONE. This is the only place in the app that
  // reads this capability, and the reason it is safe to hand out at all is that
  // everything bounding it — closure on the target's set before and after, the
  // admin-only branches, the self-edit refusal — lives inside that one function.
  // A second reader would be a second place all of that has to be remembered.
  //
  // NOT assertPlayerFieldAccess, which is where the neighbouring capability is
  // read. The three level columns stay on PLAYER_FIELD_FLOOR there, refused to
  // everybody below admin and consulted by no capability. The member Edit dialog
  // does not offer console access at all any more, and updatePlayer refuses the
  // three columns from every caller, so this gate stands in front of the only
  // way a level is edited.
  'players.consoleaccess.write': {
    label: 'Give or take console access', area: 'players', group: null, mode: 'write',
    gate: 'actions/permissions.ts setConsoleAccess',
  },
  'players.discordlink.write': {
    label: 'Link a Discord account', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts forceLinkDiscordAccount',
    also: [
      'actions/players.ts previewDiscordForceLink',
      'app/players/[id]/page.tsx discord link fetch',
    ],
    merged:
      'The preview is the dry run of the same act, over the same row. The panel fetch ' +
      'is the third because the link row is not roster data and so is not covered by ' +
      'players.read: what it shows is the current state of the very act this ' +
      'capability performs, so the capability that performs it is what guards reading it.',
  },

  // ---- seasons -----------------------------------------------------------
  'seasons.page': {
    label: 'Open Seasons', area: 'seasons', group: null, mode: 'page',
    gate: 'app/seasons/page.tsx SeasonsPage',
  },
  'seasons.create.write': {
    label: 'Create a season', area: 'seasons', group: null, mode: 'write',
    gate: 'actions/seasons.ts createSeason',
  },
  'seasons.activate.write': {
    label: 'Make a season active', area: 'seasons', group: null, mode: 'write',
    gate: 'actions/seasons.ts setActiveSeason',
  },
  'seasons.end.write': {
    label: 'End a season', area: 'seasons', group: null, mode: 'write',
    gate: 'actions/seasons.ts endSeason',
  },
  'seasons.fees.write': {
    label: 'Set season fees', area: 'seasons', group: null, mode: 'write',
    gate: 'actions/seasons.ts updateSeasonFees',
  },

  // ---- sessions ----------------------------------------------------------
  'sessions.page': {
    label: 'Open Sessions', area: 'sessions', group: null, mode: 'page',
    gate: 'route /sessions',
  },
  'sessions.reminders.write': {
    label: 'Send session reminders', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts sendSessionReminders',
  },
  'sessions.create.write': {
    label: 'Create a session', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts createSession',
  },
  'sessions.update.write': {
    label: 'Edit a session', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts updateSession',
  },
  'sessions.archive.write': {
    label: 'Archive a session', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts archiveSession',
  },
  'sessions.checkin.token.write': {
    label: 'Session check-in token', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts getOrCreateSessionCheckinToken',
    also: ['actions/sessions.ts rotateSessionCheckinToken'],
    merged: MINT_A_TOKEN,
  },
  'sessions.attendance.write': {
    label: 'Mark session attendance', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts markAttendance',
    also: ['actions/sessions.ts clearAttendanceMark'],
    merged: MARK_OR_CLEAR,
  },
  'sessions.delete.write': {
    label: 'Delete a session', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts deleteSession',
  },

  // ---- matches -----------------------------------------------------------
  'matches.page': {
    label: 'Open Ladder matches', area: 'matches', group: null, mode: 'page',
    gate: 'route /matches',
  },
  'matches.void.write': {
    label: 'Void or boost a match, and set repeat challenge rules', area: 'matches', group: null, mode: 'write',
    gate: 'actions/matches.ts voidMatch',
    also: [
      'actions/matches.ts boostMatchRating',
      'actions/matches.ts updateRepeatChallengeSettings',
    ],
    merged:
      'One authority over how much a confirmed challenge moves two ratings. Voiding takes the change back, '
      + 'boosting scales it, and the repeat rules scale it before it lands; all three correct the same applied '
      + 'delta, and a void still unwinds the other two. It sits here rather than behind a new capability because '
      + 'the rule is meant to be an exec call and platform settings are admin-only.',
  },
  'matches.convert.write': {
    label: 'Convert a match to casual', area: 'matches', group: null, mode: 'write',
    gate: 'actions/matches.ts convertMatchToCasual',
  },
  'matches.create.write': {
    label: 'Record a match', area: 'matches', group: null, mode: 'write',
    gate: 'actions/matches.ts adminCreateMatch',
  },

  // ---- challenges --------------------------------------------------------
  'challenges.page': {
    label: 'Open Challenges', area: 'challenges', group: null, mode: 'page',
    gate: 'route /challenges',
  },
  'challenges.create.write': {
    label: 'Create a challenge', area: 'challenges', group: null, mode: 'write',
    gate: 'actions/matches.ts adminCreateChallenge',
  },
  'challenges.expire.write': {
    label: 'Force-expire a challenge', area: 'challenges', group: null, mode: 'write',
    gate: 'actions/matches.ts forceExpireChallenge',
  },

  // ---- announcements -----------------------------------------------------
  'announcements.page': {
    label: 'Open Announcements', area: 'announcements', group: null, mode: 'page',
    gate: 'route /announcements',
  },
  'announcements.create.write': {
    label: 'Post an announcement', area: 'announcements', group: null, mode: 'write',
    gate: 'actions/announcements.ts createAnnouncement',
  },
  'announcements.update.write': {
    label: 'Edit an announcement', area: 'announcements', group: null, mode: 'write',
    gate: 'actions/announcements.ts updateAnnouncement',
  },
  'announcements.discord.write': {
    label: 'Send a message to Discord', area: 'announcements', group: null, mode: 'write',
    gate: 'actions/discord-message.ts queueDiscordMessage',
  },
  'announcements.delete.write': {
    label: 'Delete an announcement', area: 'announcements', group: null, mode: 'write',
    gate: 'actions/announcements.ts deleteAnnouncement',
  },

  // ---- tournaments · manage ----------------------------------------------
  // No group: a page belongs to its AREA, not to one of the area's four jobs.
  // It was `tournaments.manage.read` and it never gated the manage DATA — it
  // gated the section, which is what the name now says.
  'tournaments.page': {
    label: 'Open Tournaments', area: 'tournaments', group: null, mode: 'page',
    gate: 'app/tournaments/[id]/page.tsx TournamentDetailPage',
  },
  'tournaments.manage.create.write': {
    label: 'Create a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts createTournament',
  },
  'tournaments.manage.update.write': {
    label: 'Edit a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts updateTournament',
  },
  'tournaments.manage.status.write': {
    label: 'Change tournament status', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts updateTournamentStatus',
  },
  'tournaments.manage.suspend.write': {
    label: 'Suspend a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts suspendTournament',
  },
  'tournaments.manage.resume.write': {
    label: 'Resume a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts resumeTournament',
  },
  'tournaments.manage.archive.write': {
    label: 'Archive a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts archiveTournament',
  },
  'tournaments.manage.delete.write': {
    label: 'Delete a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts deleteTournament',
  },
  'tournaments.manage.event.create.write': {
    label: 'Create an event', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'tournament-actions/events.ts createTournamentEvent',
  },
  'tournaments.manage.event.update.write': {
    label: 'Edit an event', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'tournament-actions/events.ts updateTournamentEvent',
  },
  'tournaments.manage.event.delete.write': {
    label: 'Delete an event', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'tournament-actions/events.ts deleteTournamentEvent',
  },
  'tournaments.manage.event.status.write': {
    label: 'Change event status', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'tournament-actions/events.ts setEventStatus',
  },

  // ---- tournaments · draw ------------------------------------------------
  'tournaments.draw.participants.add.write': {
    label: 'Add a participant', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts addParticipantToEvent',
    also: ['tournament-actions/participants.ts addParticipantsToEvent'],
    merged: 'One entrant or a whole selection of them, added to an event: one act at two sizes.',
  },
  'tournaments.draw.participants.remove.write': {
    label: 'Remove a participant', area: 'tournaments', group: 'draw', mode: 'write',
    // ONE SITE AGAIN. This used to merge the event-level removal with a
    // tournament-level one in actions/tournaments.ts, which DELETEd from
    // legacy_tournament_participants. That action was deleted along with the
    // dialog that was its only caller, so there is no second scope left to
    // argue about and the `merged` prose went with it.
    gate: 'tournament-actions/participants.ts removeParticipantFromEvent',
  },
  'tournaments.draw.checkin.token.write': {
    label: 'Tournament check-in token', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'actions/tournament-checkin.ts getOrCreateTournamentCheckinToken',
    also: ['actions/tournament-checkin.ts rotateTournamentCheckinToken'],
    merged: MINT_A_TOKEN,
  },
  'tournaments.draw.checkin.mark.write': {
    // DISPLAY TEXT ONLY, reconciled with the tab it now gates. The capability
    // STRING is untouched and must stay untouched: capability keys are stored as
    // DATA in permission_grants and permission_baselines.capabilities, so
    // renaming one orphans every live grant that holds it. The label is what an
    // exec reads in the permission editor; the key is what the database joins on.
    label: 'Check in and manage courts', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts checkInParticipant',
    also: [
      'tournament-actions/participants.ts checkInPair',
      'tournament-actions/participants.ts bulkCheckIn',
      'tournament-actions/scheduling.ts setMatchReadyForPlayer',
      'tournament-actions/scheduling.ts setMatchCourt',
      'tournament-actions/scheduling.ts setMatchLive',
    ],
    merged:
      'Everything the desk does to somebody BEFORE they play, by the one person standing at the table with the entry list. Check-in is the same act at three sizes — singles entrant, pair, whole event — and marking a member ready is that act again at match granularity: recording that a person has turned up. Setting the court is the reply the desk gives them in the same breath, and putting the match on court is the last act of the same sequence — check them in, name the court, confirm they are standing there, send them on. All six are joined here rather than minting new tournament keys, because "may check people in but may not tell them which court" is a distinction the club does not have and nobody could staff. RECORDING THE RESULT IS NOT HERE: that is tournaments.results.* and stays its own key, which is why the Court Management tab carries two levels of control on one screen.',
  },
  'tournaments.draw.noshow.write': {
    label: 'Mark a no-show', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts markParticipantNoShow',
    also: ['tournament-actions/participants.ts markPairNoShow'],
    merged: 'The participant and pair variants of one operation.',
  },
  'tournaments.draw.exit.write': {
    label: 'Withdraw or disqualify', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts exitDrawImpl',
  },
  'tournaments.draw.pairs.add.write': {
    label: 'Add a pair', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts addPairToEvent',
  },
  'tournaments.draw.pairs.remove.write': {
    label: 'Remove a pair', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts removePairFromEvent',
  },
  'tournaments.draw.seed.set.write': {
    label: 'Set a seed', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/seeding.ts updateParticipantSeed',
    also: ['tournament-actions/seeding.ts updatePairSeed'],
    merged: 'The participant and pair variants of one operation.',
  },
  'tournaments.draw.seed.auto.write': {
    label: 'Auto-seed by rating', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/seeding.ts autoSeedEventByElo',
  },
  'tournaments.draw.seed.clear.write': {
    label: 'Clear all seeds', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/seeding.ts clearSeeds',
  },
  'tournaments.draw.generate.write': {
    label: 'Generate the draw', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/brackets.ts generateSingleEliminationBracket',
    also: ['tournament-actions/brackets.ts generateRoundRobinMatches'],
    merged: 'Knockout or round robin — the same act, chosen by the event format.',
  },
  'tournaments.draw.lock.write': {
    label: 'Lock the draw', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/brackets.ts lockDraw',
  },
  'tournaments.draw.unlock.write': {
    label: 'Unlock the draw', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/brackets.ts unlockDraw',
  },
  'tournaments.draw.waivers.read': {
    label: 'Who has signed the event waiver', area: 'tournaments', group: 'draw', mode: 'read',
    gate: 'app/tournaments/[id]/events/[eventId]/page.tsx event-waiver fetch',
  },
  'tournaments.draw.entrycounts.read': {
    label: 'How many events each entrant has taken', area: 'tournaments', group: 'draw', mode: 'read',
    gate: 'app/tournaments/[id]/page.tsx entry-count fetch',
  },

  // ---- tournaments · results ---------------------------------------------
  'tournaments.results.enter.write': {
    label: 'Enter a result', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts enterMatchResult',
  },
  'tournaments.results.walkover.write': {
    label: 'Enter a walkover', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts enterWalkover',
  },
  'tournaments.results.void.write': {
    label: 'Void a tournament match', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts voidMatch',
  },
  'tournaments.results.unvoid.write': {
    label: 'Un-void a tournament match', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts unvoidMatch',
  },
  'tournaments.results.undo.write': {
    label: 'Undo a result', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts undoMatchResult',
  },
  'tournaments.results.edit.write': {
    label: 'Edit a recorded result', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts editMatchResult',
    also: [
      'tournament-actions/team-category.ts approvePairCategoryRequestImpl',
      'tournament-actions/team-category.ts declinePairCategoryRequestImpl',
    ],
    merged:
      'Correcting a recorded result and settling a category change for a team that has played are one act: '
      + 'both decide what head start a played match is judged by (00279). Declining the change is the same '
      + 'decision answered no.',
  },
  'tournaments.results.entry.write': {
    label: 'Edit a match slot', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts setMatchEntry',
  },
  'tournaments.results.doublenoshow.write': {
    label: 'Record a double no-show', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts recordDoubleNoShow',
  },
  'tournaments.results.bonuses.write': {
    label: 'Apply placement bonuses', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/finalize.ts applyPlacementBonuses',
  },
  'tournaments.results.standings.write': {
    label: 'Recompute standings', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/finalize.ts recomputeEventStandings',
  },
  'tournaments.results.finalize.write': {
    label: 'Finalise an event', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/finalize.ts finalizeEvent',
  },

  // ---- tournaments · fees ------------------------------------------------
  'tournaments.fees.read': {
    label: 'Tournament entry fees', area: 'tournaments', group: 'fees', mode: 'read',
    gate: 'app/tournaments/[id]/fees/page.tsx TournamentFeesPage',
  },
  'tournaments.fees.tier.create.write': {
    label: 'Create a fee tier', area: 'tournaments', group: 'fees', mode: 'write',
    gate: 'actions/tournament-fees.ts createFeeTier',
  },
  'tournaments.fees.tier.update.write': {
    label: 'Edit a fee tier', area: 'tournaments', group: 'fees', mode: 'write',
    gate: 'actions/tournament-fees.ts updateFeeTier',
  },
  'tournaments.fees.tier.delete.write': {
    label: 'Delete a fee tier', area: 'tournaments', group: 'fees', mode: 'write',
    gate: 'actions/tournament-fees.ts deleteFeeTier',
  },
  'tournaments.fees.markpaid.write': {
    label: 'Mark an entry fee paid', area: 'tournaments', group: 'fees', mode: 'write',
    gate: 'actions/tournament-fees.ts markTournamentFeePaid',
  },
  'tournaments.fees.markunpaid.write': {
    label: 'Mark an entry fee unpaid', area: 'tournaments', group: 'fees', mode: 'write',
    gate: 'actions/tournament-fees.ts markTournamentFeeUnpaid',
  },

  // ---- events ------------------------------------------------------------
  'events.page': {
    label: 'Open Club events', area: 'events', group: null, mode: 'page',
    gate: 'route /events',
  },
  'events.signups.read': {
    label: 'See who signed up for a club event', area: 'events', group: null, mode: 'read',
    gate: 'app/events/[id]/page.tsx signups fetch',
  },
  'events.signups.remove.write': {
    label: 'Remove a member from a club event', area: 'events', group: null, mode: 'write',
    gate: 'actions/club-events.ts removeClubEventSignup',
  },
  'events.manage.create.write': {
    label: 'Create a club event', area: 'events', group: null, mode: 'write',
    gate: 'actions/club-events.ts createClubEvent',
  },
  'events.manage.update.write': {
    label: 'Edit or publish a club event', area: 'events', group: null, mode: 'write',
    gate: 'actions/club-events.ts updateClubEvent',
  },
  'events.manage.cancel.write': {
    label: 'Cancel a club event', area: 'events', group: null, mode: 'write',
    gate: 'actions/club-events.ts cancelClubEvent',
  },
  'events.manage.delete.write': {
    label: 'Delete a club event', area: 'events', group: null, mode: 'write',
    gate: 'actions/club-events.ts deleteClubEvent',
  },

  // ---- fees --------------------------------------------------------------
  // The page and the Expenses ledger are two gates now, where they used to be
  // one. FeesPage admits anyone with the page; the ledger's own fetch is what
  // fees.expenses.read buys, and without it the tab renders the Add expense
  // control over no rows.
  'fees.page': {
    label: 'Open Finances', area: 'fees', group: null, mode: 'page',
    gate: 'app/fees/page.tsx FeesPage',
  },
  'fees.expenses.read': {
    label: 'Expenses', area: 'fees', group: 'expenses', mode: 'read',
    gate: 'app/fees/page.tsx expenses ledger fetch',
    also: ['app/fees/receipt/[id]/route.ts GET'],
    merged:
      'Rendering an expense row and opening the receipt behind it are one act: seeing what the club spent.',
  },
  'fees.expenses.add.write': {
    label: 'File an expense', area: 'fees', group: 'expenses', mode: 'write',
    gate: 'actions/finance.ts addExpense',
  },
  'fees.expenses.update.write': {
    label: 'Edit an expense', area: 'fees', group: 'expenses', mode: 'write',
    gate: 'actions/finance.ts updateExpense',
  },
  'fees.expenses.reimburse.write': {
    label: 'Mark an expense reimbursed', area: 'fees', group: 'expenses', mode: 'write',
    gate: 'actions/finance.ts markExpenseReimbursed',
  },
  'fees.expenses.remove.write': {
    label: 'Delete an expense', area: 'fees', group: 'expenses', mode: 'write',
    gate: 'actions/finance.ts removeExpense',
  },
  'fees.otherincome.read': {
    label: 'Other income', area: 'fees', group: 'otherincome', mode: 'read',
    gate: 'app/fees/page.tsx other-income ledger fetch',
  },
  'fees.otherincome.add.write': {
    label: 'Record other income', area: 'fees', group: 'otherincome', mode: 'write',
    gate: 'actions/finance.ts addOtherIncome',
  },
  'fees.otherincome.remove.write': {
    label: 'Delete an other-income entry', area: 'fees', group: 'otherincome', mode: 'write',
    gate: 'actions/finance.ts removeOtherIncome',
  },
  'fees.clubfees.read': {
    label: 'Club fees', area: 'fees', group: 'clubfees', mode: 'read',
    gate: 'app/fees/page.tsx club-fee roster fetches',
  },
  'fees.clubfees.markpaid.write': {
    label: 'Mark a club fee paid', area: 'fees', group: 'clubfees', mode: 'write',
    gate: 'actions/fees.ts markFeePaid',
  },
  'fees.clubfees.markunpaid.write': {
    label: 'Mark a club fee unpaid', area: 'fees', group: 'clubfees', mode: 'write',
    gate: 'actions/fees.ts markFeeUnpaid',
  },
  'fees.clubfees.waive.write': {
    label: 'Waive a club fee', area: 'fees', group: 'clubfees', mode: 'write',
    gate: 'actions/fees.ts waiveFee',
  },
  'fees.clubfees.addmanual.write': {
    label: 'Add a manual fee', area: 'fees', group: 'clubfees', mode: 'write',
    gate: 'actions/fees.ts addManualFee',
  },
  'fees.clubfees.removemanual.write': {
    label: 'Delete a manual fee', area: 'fees', group: 'clubfees', mode: 'write',
    gate: 'actions/fees.ts removeManualFee',
  },
  'fees.reinstatements.read': {
    label: 'Reinstatement fees', area: 'fees', group: 'reinstatements', mode: 'read',
    gate: 'app/fees/page.tsx reinstatements fetch',
  },
  'fees.reinstatements.write': {
    label: 'Record a reinstatement payment', area: 'fees', group: 'reinstatements', mode: 'write',
    gate: 'actions/reinstatement.ts recordReinstatementPayment',
  },
  'fees.netposition.read': {
    label: 'Net position', area: 'fees', group: 'netposition', mode: 'read',
    gate: 'app/fees/page.tsx net-position strip',
    also: ['app/dashboard/page.tsx finance snapshot'],
    merged: 'Two renderings of one figure — income, expenses and the difference.',
  },
  'fees.playerflags.write': {
    label: 'Fee exemption flags', area: 'fees', group: 'playerflags', mode: 'write',
    gate: 'actions/fees.ts updatePlayerFlags',
  },

  // ---- legal -------------------------------------------------------------
  'legal.page': {
    label: 'Open Legal', area: 'legal', group: null, mode: 'page',
    gate: 'app/legal/page.tsx LegalPage',
    also: [
      'app/legal/guests/page.tsx GuestWaiversPage',
      'app/legal/media-consent/page.tsx MediaConsentPage',
      'app/legal/signatures/page.tsx MemberSignaturesPage',
    ],
    merged: 'The external waiver signings, the photo and video consent list and the members’ signatures page are the Legal section read from other pages: what non-members signed, who allows photos, and which version each member last signed, beside what members signed.',
  },
  'legal.reacceptance.write': {
    label: 'Require a re-signature', area: 'legal', group: null, mode: 'write',
    gate: 'actions/settings.ts requireReacceptance',
  },
  'legal.documents.write': {
    label: 'Edit a legal document', area: 'legal', group: null, mode: 'write',
    gate: 'actions/settings.ts updateLegalDocument',
  },
  'legal.waivertemplate.write': {
    label: 'Edit the event waiver template', area: 'legal', group: null, mode: 'write',
    gate: 'actions/settings.ts updateEventWaiverTemplate',
  },

  // ---- walkovers ---------------------------------------------------------
  'walkovers.page': {
    label: 'Open Walkovers', area: 'walkovers', group: null, mode: 'page',
    gate: 'route /walkovers',
  },
  'walkovers.confirm.write': {
    label: 'Confirm a walkover', area: 'walkovers', group: null, mode: 'write',
    gate: 'actions/walkovers.ts confirmWalkover',
  },
  'walkovers.reject.write': {
    label: 'Reject a walkover', area: 'walkovers', group: null, mode: 'write',
    gate: 'actions/walkovers.ts rejectWalkover',
  },

  // ---- disputes ----------------------------------------------------------
  'disputes.page': {
    label: 'Open Disputes', area: 'disputes', group: null, mode: 'page',
    gate: 'route /disputes',
  },
  'disputes.resolve.write': {
    label: 'Resolve a dispute', area: 'disputes', group: null, mode: 'write',
    gate: 'actions/disputes.ts resolveDispute',
  },

  // ---- permissions -------------------------------------------------------
  'permissions.page': {
    label: 'Open Permissions', area: 'permissions', group: null, mode: 'page',
    gate: 'app/permissions/page.tsx PermissionsPage',
  },
  'permissions.write': {
    label: 'Hand out permissions', area: 'permissions', group: null, mode: 'write',
    gate: 'actions/permissions.ts setPlayerPermissions',
  },

  // ---- audit / ratings / accounts ----------------------------------------
  'audit.page': {
    label: 'Open the Audit log', area: 'audit', group: null, mode: 'page',
    gate: 'route /audit',
  },
  // THE EXPORT'S TWO KEYS. Both name a HANDLER rather than `route
  // /api/audit/export`, and the difference is not cosmetic: the `route <path>`
  // form is reserved for capabilities where the middleware's section match IS
  // the whole gate, and here the handler re-asks. An audit surface names who
  // did what to whom, so it is the last place that should rely on a route match
  // having happened upstream, which is the rule app/audit/page.tsx already
  // states for itself.
  'audit.export.read': {
    label: 'Download the audit log', area: 'audit', group: null, mode: 'read',
    gate: 'app/api/audit/export/route.ts GET',
  },
  'audit.signins.read': {
    label: 'The sign-in log', area: 'audit', group: null, mode: 'read',
    gate: 'app/api/audit/export/route.ts sign-ins source',
    also: ['app/audit/page.tsx sign-ins export option'],
    merged: 'Offering the sign-ins type and serving it are one authority over the same rows, asked once on the page so the option is not drawn and once at the download so it cannot be typed into the URL.',
  },
  'ratings.page': {
    label: 'Open Ratings', area: 'ratings', group: null, mode: 'page',
    gate: 'app/ratings/page.tsx RatingsPage',
  },
  'accounts.page': {
    label: 'Open Accounts', area: 'accounts', group: null, mode: 'page',
    gate: 'app/accounts/page.tsx AccountsPage',
  },
  // THE DATA API'S KEYS. No group on any of the three: `group` is for an area
  // too large to render flat, and `accounts` is four entries against
  // tournaments' forty-four.
  //
  // THE READ IS A FETCH GATE, not a second page. The key list sits inside
  // /accounts, which `accounts.page` already opens, and what it withholds is
  // the rows, so it skips the query the way the officer and settings halves of
  // that page already do, rather than drawing a card over nothing.
  'accounts.apikey.read': {
    label: 'Data API keys', area: 'accounts', group: null, mode: 'read',
    gate: 'app/accounts/page.tsx data API key fetch',
  },
  'accounts.apikey.mint.write': {
    label: 'Mint a data API key', area: 'accounts', group: null, mode: 'write',
    gate: 'actions/data-api-keys.ts mintDataApiKey',
    also: ['actions/data-api-keys.ts updateDataApiKeyScopes'],
    merged: 'Rewriting a live key\'s scopes grants exactly what minting a key with those scopes would, so they are one authority.',
  },
  // REVOKE, NOT DELETE, in the gate as in the key: the action sets `revoked_at`
  // and leaves the row, so who minted what survives the key being turned off.
  'accounts.apikey.revoke.write': {
    label: 'Revoke a data API key', area: 'accounts', group: null, mode: 'write',
    gate: 'actions/data-api-keys.ts revokeDataApiKey',
  },

  // ---- platform ----------------------------------------------------------
  // THE ONE PAGE CAPABILITY WITH NO ROUTE. Platform settings have no section of
  // their own — the form is drawn inside /ratings and /accounts, each of which
  // is its own area — so this gates the FORM rather than a path, and both pages
  // render it only for a holder. Every area needs a page for the resolver's
  // invariant to be uniform, and an honest gate is the price of that.
  'platform.page': {
    label: 'Open Platform settings', area: 'platform', group: null, mode: 'page',
    gate: 'app/ratings/page.tsx platform settings form',
    also: ['app/accounts/page.tsx platform settings form'],
    merged: 'One form, rendered on the two pages that carry the settings it holds.',
  },
  'platform.settings.write': {
    label: 'Platform settings', area: 'platform', group: null, mode: 'write',
    gate: 'actions/settings.ts updatePlatformSettings',
  },

  // ---- changelog ---------------------------------------------------------
  // CLUB CHANGES (00286). The page lists the draft lines the settings and
  // officer role triggers wrote; the post key covers everything that decides
  // what members will be told.
  'changelog.page': {
    label: 'Open Club changes', area: 'changelog', group: null, mode: 'page',
    gate: 'app/club-changes/page.tsx ClubChangesPage',
  },
  'changelog.post.write': {
    label: 'Post club changes', area: 'changelog', group: null, mode: 'write',
    gate: 'actions/club-changes.ts postClubChanges',
    also: [
      'actions/club-changes.ts addClubChangeLine',
      'actions/club-changes.ts rewordClubChangeLine',
      'actions/club-changes.ts deleteClubChangeLine',
      'actions/club-changes.ts announceClubChangeEntry',
    ],
    merged:
      'Adding, rewording and deleting a pending line, and sending a posted entry out as an announcement, are all deciding what the club tells its members, which is what posting is.',
  },

  // ---- page --------------------------------------------------------------
  // THE KEYS TO SWITCHED-OFF FEATURES, and the first gates in this map that
  // stand in the MEMBERS' app rather than the console, hence the `player `
  // prefix. Each one's gate is the FeatureGate on its pages, and its `also` is
  // every member action that calls assertFeatureOn for the same feature.
  //
  // MODE `read`, NOT `page`, even though pageOf() treats each as its own page.
  // The editor keeps ONE page slot per area and draws every other entry as a
  // row; seven page-mode entries in one area would overwrite each other there
  // and only the last would be offered.
  //
  // The nav filters and the feed's cards ask the same question but are not
  // listed: each is one function asking it for every feature at once, so it
  // would be a site claimed seven times over.
  //
  // WRITTEN BY HAND, NOT DERIVED FROM THE REGISTRY, because the `also` lists
  // differ per feature and a derived entry could only guess them. The Record
  // type is what keeps it complete: a new feature is a compile error here
  // until its entry exists.
  'page.access.sessions': {
    label: 'Sessions while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player app/sessions/layout.tsx FeatureGate',
    also: [
      'player app/checkin/layout.tsx FeatureGate',
      'player actions/sessions.ts checkInToSession',
      'player actions/sessions.ts checkInWithToken',
      'player actions/sessions.ts setSessionIntent',
    ],
    merged: SWITCHED_OFF,
  },
  'page.access.challenges': {
    label: 'Challenges while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player app/challenges/layout.tsx FeatureGate',
    also: [
      'player actions/challenges.ts createChallenge',
      'player actions/challenges.ts acceptChallenge',
      'player actions/challenges.ts rejectChallenge',
      'player actions/challenges.ts cancelChallenge',
      'player actions/matches.ts submitMatchResult',
      'player actions/matches.ts reportWalkover',
    ],
    merged: SWITCHED_OFF,
  },
  'page.access.tournaments': {
    label: 'Tournaments while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player app/tournaments/layout.tsx FeatureGate',
    also: [
      'player lib/tournament-actions.ts registerForEvent',
      'player lib/tournament-actions.ts acceptEventWaiver',
      'player lib/tournament-actions.ts withdrawFromEvent',
      'player lib/tournament-actions.ts selfCheckIn',
      'player lib/tournament-actions.ts setMyMatchReady',
      'player lib/tournament-checkin.ts checkInToTournament',
    ],
    merged: SWITCHED_OFF,
  },
  'page.access.events': {
    label: 'Club events while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player app/events/layout.tsx FeatureGate',
    also: [
      'player lib/club-event-actions.ts signUpForClubEvent',
      'player lib/club-event-actions.ts withdrawFromClubEvent',
    ],
    merged: SWITCHED_OFF,
  },
  // The index page only, so member profiles under /leaderboard stay open.
  'page.access.leaderboard': {
    label: 'Leaderboard while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player app/leaderboard/page.tsx FeatureGate',
  },
  'page.access.my_stats': {
    label: 'My stats while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player app/my-stats/layout.tsx FeatureGate',
  },
  'page.access.announcements': {
    label: 'Announcements while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player app/announcements/layout.tsx FeatureGate',
  },
  'page.access.fees': {
    label: 'Fees while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player app/fees/layout.tsx FeatureGate',
  },
  'page.access.membership': {
    label: 'Membership page while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player app/membership/layout.tsx FeatureGate',
  },
  // The page only. The footer row, the nav's Discord links and the bot's reply
  // ask the same question for everybody at once, so, like the nav filters, they
  // are not listed as sites.
  'page.access.socials': {
    label: 'Social links while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player app/socials/layout.tsx FeatureGate',
  },
  // The index page only, so a proof link under /guest-waiver/<token> keeps
  // working after the switch goes off. The action is the same act as the page:
  // a guest signing while it is off.
  'page.access.guest_waivers': {
    label: 'External waivers while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player app/guest-waiver/page.tsx FeatureGate',
    also: ['player actions/guest-waiver.ts signGuestWaiver'],
    merged: SWITCHED_OFF,
  },
  // No page to gate: the challenge screens and the profile each ask this one
  // helper before reading a prediction.
  'page.access.predictions': {
    label: 'Match predictions while switched off', area: 'page', group: null, mode: 'read',
    gate: 'player lib/predictions.ts predictionsVisible',
  },
};

/**
 * Every distinct place in the app that asks a capability question. Pinned so
 * that deleting a gate without deleting its capability — which would leave the
 * editor offering a tick box nothing reads — fails the suite.
 */
export const ENFORCEMENT_POINTS: number = CAPABILITIES.reduce(
  (total, capability) => {
    const entry = CAPABILITY_GATES[capability];
    return total + (entry.gate === null ? 0 : 1) + (entry.also?.length ?? 0);
  },
  0,
);
