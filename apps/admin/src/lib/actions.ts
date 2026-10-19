// Barrel re-export so existing call sites (`import { foo } from '@/lib/actions'`)
// keep working without churn. Real implementations live in ./actions/*.
//
// Each subfile is a 'use server' module owning one domain:
//   - players.ts       — approve/create/update/remove player,
//                        cancelAccountDeletion
//   - matches.ts       — voidMatch, convertMatchToCasual, adminCreateMatch,
//                        boostMatchRating, updateRepeatChallengeSettings,
//                        adminCreateChallenge, forceExpireChallenge
//   - disputes.ts      — resolveDispute
//   - walkovers.ts     — confirmWalkover / rejectWalkover
//   - tournaments.ts   — tournament CRUD + legacy participant management
//   - seasons.ts       — createSeason / setActiveSeason / endSeason
//   - sessions.ts      — session CRUD + QR check-in tokens
//   - announcements.ts — announcement CRUD
//   - fees.ts          — exec/exempt player flags + club-fee tracking
//   - finance.ts       — other income (donations/grants) + club expenses
//   - tournament-fees.ts — tournament fee tiers + per-player entry-fee tracking
//   - reinstatement.ts — player ban / reinstatement (with reinstatement fee)
//   - varsity.ts       — varsity notes
//   - reliability.ts   — adjustReliability (manual reliability-counter edits)
//   - permissions.ts   — setPlayerPermissions + setConsoleAccess (/permissions)
//   - permission-baselines.ts — the club's own named capability sets, created,
//                        edited (with propagation to every holder) and deleted
//   - settings.ts      — updateLegalDocument (waiver / code of conduct),
//                        updateEventWaiverTemplate (per-season event waiver),
//                        updatePlatformSettings (/ratings + /accounts)
//   - bulk.ts          — one decision applied to several records: a loop over
//                        the single-record actions above, never a batched write
//   - fee-paste.ts     - previewFeePaste (the /fees "Paste a list" read)
//   - tour.ts          - markConsoleTourSeen (the console tour, 00246)
//   - _shared.ts       — requireCapability (NOT 'use server' — internal helper)
export {
  approvePlayer,
  createPlayer,
  updatePlayer,
  removePlayer,
  cancelAccountDeletion,
  requireWaiverResignature,
  previewPlayerMerge,
  mergePlayers,
  resolvePrivilegeClaimReview,
  resolveEloReview,
  previewDiscordForceLink,
  forceLinkDiscordAccount,
} from './actions/players';
export type { MergePreviewRow, DiscordForceLinkPreview } from './actions/players';

export {
  voidMatch,
  convertMatchToCasual,
  boostMatchRating,
  updateRepeatChallengeSettings,
  adminCreateMatch,
  adminCreateChallenge,
  forceExpireChallenge,
} from './actions/matches';

export {
  resolveDispute,
} from './actions/disputes';

export { setPlayerPermissions, setConsoleAccess } from './actions/permissions';
export type { PermissionsPayload } from './actions/permissions';
export {
  createPermissionBaseline,
  updatePermissionBaseline,
  deletePermissionBaseline,
  resetPermissionBaseline,
} from './actions/permission-baselines';

export {
  confirmWalkover,
  rejectWalkover,
} from './actions/walkovers';

export {
  createTournament,
  updateTournamentStatus,
  completeTournamentWithEvents,
  updateTournament,
  eventWaiverEditImpact,
  suspendTournament,
  resumeTournament,
  archiveTournament,
  deleteTournament,
} from './actions/tournaments';

export {
  createSeason,
  updateSeasonFees,
  setActiveSeason,
  endSeason,
  setSeasonHidden,
} from './actions/seasons';
export type { SeasonEloPolicy } from './actions/seasons';

export {
  createSession,
  updateSession,
  patchSession,
  archiveSession,
  deleteSession,
  sendSessionReminders,
  markAttendance,
  clearAttendanceMark,
  getOrCreateSessionCheckinToken,
  rotateSessionCheckinToken,
} from './actions/sessions';

export {
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from './actions/announcements';

export {
  updatePlayerFlags,
  markFeePaid,
  waiveFee,
  markFeeUnpaid,
  addManualFee,
  removeManualFee,
  markNamedFeePaid,
  attachNamedPayment,
} from './actions/fees';

// Non-fee money ledgers (00073): donations/grants in, shuttles/courts out,
// plus reimbursement of whoever fronted an expense (00077).
export {
  addOtherIncome,
  removeOtherIncome,
  addExpense,
  updateExpense,
  removeExpense,
  markExpenseReimbursed,
} from './actions/finance';

export {
  createFeeTier,
  updateFeeTier,
  deleteFeeTier,
  markTournamentFeePaid,
  markTournamentFeeUnpaid,
} from './actions/tournament-fees';

export {
  banPlayer,
  reinstatePlayer,
  recordReinstatementPayment,
} from './actions/reinstatement';

export {
  createVarsityNote,
  deleteVarsityNote,
} from './actions/varsity';

export {
  adjustReliability,
} from './actions/reliability';

export {
  updateLegalDocument,
  requireReacceptance,
  updateEventWaiverTemplate,
  updatePlatformSettings,
} from './actions/settings';

export {
  bulkApprovePlayers,
  bulkUpdatePlayers,
  bulkUpdateSessions,
  bulkArchiveSessions,
  bulkDeleteSessions,
  bulkMarkFeesPaid,
  bulkWaiveFees,
  bulkMarkFeesUnpaid,
  bulkMarkTournamentFeesPaid,
  bulkMarkTournamentFeesUnpaid,
  bulkAddManualFees,
} from './actions/bulk';

export { previewFeePaste } from './actions/fee-paste';

export { markConsoleTourSeen } from './actions/tour';
