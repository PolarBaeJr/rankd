// Barrel re-export so existing call sites (`import { foo } from '@/lib/tournament-actions'`)
// keep working without churn. Real implementations live in ./tournament-actions/*.
//
// Each subfile is a 'use server' module owning one domain:
//   - events.ts       — event CRUD + status transitions
//   - participants.ts — singles participants, doubles pairs, check-in / no-show
//   - seeding.ts      — manual seeds, auto-seed by Elo, clear seeds
//   - brackets.ts     — bracket / round robin generation, draw lock
//   - stages.ts       : drawing one stage of a staged event (00272)
//   - team-category.ts: a team's category in a staged event, which its head
//                       starts read, and the request to change it after
//                       play (00279)
//   - results.ts      — score entry, walkovers, void / restore / edit / undo
//                       results, manual draw-slot repair
//   - finalize.ts     — placement bonuses + event finalization
//   - scheduling.ts   — running the Court Management tab at a live event: which
//                       court a match is on, who is present for it, and putting
//                       it on court ('live' had no writer at all before 00136)
//   - courts.ts       : a tournament's own courts (00273): add, rename, order,
//                       switch off, and import the courts already typed
//   - court-helpers.ts: naming console members to keep score on a court (00310)
//   - attendance.ts   : the event standard at the desk (00324 to 00326): a place
//                       confirmed for a member, releasing no-shows, the reserves
//   - substitutions.ts: somebody in for one member of a team or the whole entry (00327)
//   - _internal.ts    — private helpers (NOT 'use server' — revalidation,
//                       notifications, Elo apply/reverse, standings)
export {
  createTournamentEvent,
  updateTournamentEvent,
  deleteTournamentEvent,
  setEventStatus,
  setEventWindows,
  setEventWaitlist,
  setEventWaitlistLimit,
  setEventAttendanceSettings,
} from './tournament-actions/events';

export {
  addParticipantToEvent,
  addParticipantsToEvent,
  removeParticipantFromEvent,
  checkInParticipant,
  markParticipantNoShow,
  withdrawParticipant,
  disqualifyParticipant,
  withdrawPair,
  disqualifyPair,
  addPairToEvent,
  addExternalPairToEvent,
  removePairFromEvent,
  unpairEntry,
  withdrawPairMember,
  swapPairMember,
  checkInPair,
  checkInPairMember,
  undoPairMemberCheckIn,
  markPairNoShow,
  undoCheckIn,
  undoNoShow,
  bulkCheckIn,
  autoPairWaitingEntrants,
  promoteFromWaitlist,
  removeFromWaitlist,
} from './tournament-actions/participants';

export {
  updateParticipantSeed,
  updatePairSeed,
  autoSeedEventByElo,
  clearSeeds,
  assignEventGroups,
  updateParticipantGroup,
  updatePairGroup,
} from './tournament-actions/seeding';

export {
  generateSingleEliminationBracket,
  generateRoundRobinMatches,
  setRoundMatchShape,
  lockDraw,
  unlockDraw,
} from './tournament-actions/brackets';

export { drawStage, redrawStage, addStageRound, placeLateEntrant } from './tournament-actions/stages';
export type { LateEntrantChoice } from './tournament-actions/stages';

export {
  setPairCategory,
  requestPairCategoryChange,
  approvePairCategoryRequest,
  declinePairCategoryRequest,
  cancelPairCategoryRequest,
} from './tournament-actions/team-category';

export {
  enterMatchResult,
  enterWalkover,
  voidMatch,
  unvoidMatch,
  recordDoubleNoShow,
  setMatchEntry,
  editMatchResult,
  undoMatchResult,
  getMatchOutcomeSummary,
  getCurrentHeadStarts,
  enterCourtHelperResult,
  voidCourtHelperMatch,
  voidOpenMatchesForEntry,
  voidUnplayedMatches,
  recordPlayerLeft,
} from './tournament-actions/results';
export type { MatchOutcomeSummary, EntryEventSummary, CurrentHeadStarts, BulkVoidResult, PlayerLeftResult } from './tournament-actions/results';

export {
  applyPlacementBonuses,
  finalizeEvent,
  finalizeEventAction,
} from './tournament-actions/finalize';

export {
  setMatchCourt,
  setMatchReadyForPlayer,
  setMatchLive,
} from './tournament-actions/scheduling';

export {
  addTournamentCourts,
  renameTournamentCourt,
  moveTournamentCourt,
  setTournamentCourtActive,
  importCourtsFromMatches,
} from './tournament-actions/courts';

export { addCourtHelper, removeCourtHelper, skipMatchForNow } from './tournament-actions/court-helpers';

export {
  confirmEntryForMember,
  releaseCheckinNoShows,
  enterReserveAndCheckIn,
} from './tournament-actions/attendance';
export type { ReleaseNoShowsResult, ReserveEntryResult } from './tournament-actions/attendance';

export { substituteEntry } from './tournament-actions/substitutions';
export type { SubstitutionInput, SubstitutionKind, SubstitutionResult } from './tournament-actions/substitutions';
