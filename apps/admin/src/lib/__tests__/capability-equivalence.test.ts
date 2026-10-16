import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES,
  EXEC_ASSIGNABLE,
  EXEC_BASELINE,
  TRAINER_BASELINE,
  UNRESTRICTED,
  permits,
  type Capability,
} from '../permissions';

// THE CAPABILITY-EQUIVALENCE PROOF.
//
// Portfolios could only narrow, so "this can never widen anyone" used to be a
// property of the mechanism. Capabilities are a set, and a set can gain a
// member — so that property is GONE, and this table is the thing that replaces
// it. The route matrix in ./permissions.test.ts is not enough on its own: it
// proves which SECTIONS open, and access is now decided per action.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE ASSERTS AFTER THE EXEC BASELINE NARROWED, AND WHY IT IS STILL
// THE SECOND DERIVATION RATHER THAN A FIXTURE
// ---------------------------------------------------------------------------
// The table below was written by hand from the call sites and has never been
// derived from the constants — that is the entire reason it is worth having, and
// nothing about the narrowing changes it. What DID change is which claim the
// table supports.
//
// IT USED TO SAY: an unrestricted holder of each level gets EXACTLY what the old
// gate gave. That was a MIGRATION-DAY claim — "deploying capabilities took
// nothing away from anybody" — and it was true for as long as the exec baseline
// was a transcription of `getExecOrAdmin`. The club owner has now deliberately
// taken things away: an officer with no permission_role writes nothing. So the
// equality is false BY DESIGN for the exec column, and asserting it would be
// asserting the change did not happen.
//
// IT NOW SAYS TWO THINGS INSTEAD, and between them they are strictly stronger
// than the one they replace:
//
//   1. NOBODY GAINED ANYTHING — the durable half, kept as an IMPLICATION rather
//      than an equality. If an unrestricted exec holds a capability, the row for
//      it must say an exec held it before. Widening still fails this; narrowing
//      does not. admin and trainer keep the EQUALITY, because neither of those
//      baselines moved and there is no reason to weaken them.
//
//   2. THE HISTORIC SET IS EXEC_ASSIGNABLE — the exec column of this table,
//      compared set-for-set against that constant. This is the two-independent-
//      write-downs check, unchanged in kind and merely repointed at the constant
//      that now claims to be the transcription. EXEC_ASSIGNABLE's own comment
//      says it is "the old transcription, preserved verbatim"; this is where
//      that sentence is checked against something other than itself.
//
// SO THE TEST DID NOT LOSE ITS MEANING, IT SPLIT INTO ITS TWO HALVES. The
// equality was doing both jobs at once because the two sets happened to
// coincide. They no longer coincide, and each half is now stated where it is
// actually true.
//
// WRITTEN OUT BY HAND, one row per capability, and the third column is not
// reasoning about names — it is a transcription of WHICH GATE FUNCTION STOOD AT
// THAT CALL SITE before capabilities existed:
//
//   getExecOrAdmin(…)               admin ✓ exec ✓ trainer ✗
//   getAdminPlayer() /
//     getAuthenticatedAdmin()       admin ✓ exec ✗ trainer ✗
//   getAuthenticatedExecOrAdmin(…)  admin ✓ exec ✓ trainer ✗   (page reads)
//   SECTION_ACCESS 'exec'           admin ✓ exec ✓ trainer ✗   (route-only reads)
//   SECTION_ACCESS 'admin'          admin ✓ exec ✗ trainer ✗
//   SECTION_ACCESS 'trainer'        admin ✓ exec ✓ trainer ✓
//   isAdmin-gated fetch             admin ✓ exec ✗ trainer ✗
//
// Deriving this table from EXEC_BASELINE would make it pass by construction and
// prove nothing at all. It is deliberately a second, independent write-down of
// the same fact, and the last assertion in this file is the two of them being
// compared.
//
// WHEN `<area>.page` SPLIT OFF FROM `<area>.read`, fourteen rows were RENAMED
// and two were added — and not one existing row's admin/exec/trainer answer
// moved. That is the whole claim of that change and this is where it is checked:
// a page key that used to be a read gates the same door it always gated, and the
// two new keys (fees.page, platform.page) name doors that already existed and
// take the answers those doors already gave.
//
// WHEN THE ROSTER FETCH GOT ITS OWN READ, one row was added and again nothing
// moved. `players.read` is the third row in this table with no gate to
// transcribe, and for the opposite reason to the other two: there was no gate at
// all. The query simply ran for whoever the section admitted, so the row takes
// that door's answers — all three levels — and the capability takes nothing from
// anybody who has it today.

type Row = {
  capability: Capability;
  admin: boolean;
  exec: boolean;
  trainer: boolean;
  /** The gate that stood here before. */
  was: string;
};

const T = true;
const F = false;

const TODAY: Row[] = [
  // ---- players ---------------------------------------------------------
  { capability: 'players.page',                        admin: T, exec: T, trainer: T, was: "SECTION_ACCESS['/players'] = 'trainer'" },
  // THE ROSTER FETCH WAS NEVER GATED. It ran for everybody the section let in,
  // which is every level — so all three answers are transcribed from the door
  // rather than from a gate, and adding a capability in front of it takes
  // nothing away from anyone. It is also why this row is T/T/T while every other
  // fetch gate on this page is narrower: there was no narrower gate to copy.
  { capability: 'players.read',                        admin: T, exec: T, trainer: T, was: 'ungated fetch — players/page.tsx, behind the trainer-level section only' },
  { capability: 'players.approve.write',               admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — players.ts:27" },
  { capability: 'players.create.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — players.ts:95" },
  { capability: 'players.update.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — players.ts:152" },
  { capability: 'players.waiver.resign.write',         admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — players.ts:299" },
  { capability: 'players.ban.write',                   admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — reinstatement.ts:26" },
  { capability: 'players.reinstate.write',             admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — reinstatement.ts:54" },
  // The one gate that admitted a trainer: getConsoleUser() composed by hand
  // with portfolioPermits(…, 'internal').
  { capability: 'players.editor.varsitynotes.write',   admin: T, exec: T, trainer: T, was: 'getVarsityAuthor() — varsity.ts:35' },
  { capability: 'players.deletion.cancel.write',       admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — players.ts:261' },
  { capability: 'players.remove.write',                admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — players.ts:340' },
  { capability: 'players.merge.write',                 admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — players.ts:387, 404' },
  { capability: 'players.reliability.write',           admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — reliability.ts:11' },
  { capability: 'players.privilegedfields.write',      admin: T, exec: F, trainer: F, was: 'ADMIN_ONLY_PLAYER_FIELDS — player-field-access.ts' },
  // THE ROW WHOSE PREDECESSOR IS AN EXPLICIT LEVEL CHECK RATHER THAN A GATE
  // FUNCTION. Giving somebody the console was `permissions.write` PLUS
  // isAdminActor(actor) inside setConsoleAccess, so the door it stands at
  // admitted admins and nobody else — which is what these three answers are
  // transcribed from, and why nothing moves for anybody when it is added.
  //
  // THE EXEC ANSWER IS FALSE AND HAS TO STAY FALSE. It is not in EXEC_BASELINE
  // and must not arrive there: an exec who held it by LEVEL could make more
  // execs, which nobody chose. It is reachable only by an explicit grant or by a
  // baseline somebody deliberately puts it in — see the EDITOR_OFFERABLE block
  // in capabilities.test.ts, which is where that decision is pinned.
  { capability: 'players.consoleaccess.write',         admin: T, exec: F, trainer: F, was: "permissions.write + isAdminActor() — actions/permissions.ts setConsoleAccess" },
  // THE ROW WITH NO PREDECESSOR TO TRANSCRIBE. Every other `was:` in this table
  // records a door that already existed. This one records that there was none:
  // the only way a Discord account ever reached a member was the member running
  // /link and spending a token, and the console had no surface for it at all.
  // So these three answers are a CHOICE rather than a transcription, and the
  // choice is admin only, matching the row above. It is identity-altering, and
  // it is so in a direction that reaches somebody who is not the target, since
  // re-linking displaces whatever account was there and that account loses its
  // club roles on the next sweep.
  { capability: 'players.discordlink.write',           admin: T, exec: F, trainer: F, was: 'no prior gate: there was no admin surface, only the member-run /link token flow' },

  // ---- seasons ---------------------------------------------------------
  { capability: 'seasons.page',                        admin: T, exec: T, trainer: F, was: "getAuthenticatedExecOrAdmin('internal') — seasons/page.tsx:16" },
  { capability: 'seasons.create.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — seasons.ts:18" },
  { capability: 'seasons.activate.write',              admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — seasons.ts:88" },
  { capability: 'seasons.end.write',                   admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — seasons.ts:112" },
  { capability: 'seasons.fees.write',                  admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — seasons.ts:54' },

  // ---- sessions --------------------------------------------------------
  { capability: 'sessions.page',                       admin: T, exec: T, trainer: F, was: "SECTION_ACCESS['/sessions'] = 'exec'" },
  { capability: 'sessions.reminders.write',            admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:44" },
  { capability: 'sessions.create.write',               admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:61" },
  { capability: 'sessions.update.write',               admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:147" },
  { capability: 'sessions.archive.write',              admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:181" },
  { capability: 'sessions.checkin.token.write',        admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:216, 254" },
  { capability: 'sessions.attendance.write',           admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:284, 329" },
  { capability: 'sessions.delete.write',               admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:365" },

  // ---- matches ---------------------------------------------------------
  { capability: 'matches.page',                        admin: T, exec: T, trainer: F, was: "SECTION_ACCESS['/matches'] = 'exec'" },
  { capability: 'matches.void.write',                  admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — matches.ts:28" },
  { capability: 'matches.convert.write',               admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — matches.ts:68" },
  { capability: 'matches.create.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — matches.ts:212" },

  // ---- challenges ------------------------------------------------------
  // Both live in actions/matches.ts, and both stood behind getAdminPlayer().
  // Filing them under `matches` would have handed them to every exec.
  { capability: 'challenges.page',                     admin: T, exec: F, trainer: F, was: "SECTION_ACCESS['/challenges'] = 'admin'" },
  { capability: 'challenges.create.write',             admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — matches.ts:386' },
  { capability: 'challenges.expire.write',             admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — matches.ts:464' },

  // ---- announcements ---------------------------------------------------
  { capability: 'announcements.page',                  admin: T, exec: T, trainer: F, was: "SECTION_ACCESS['/announcements'] = 'exec'" },
  { capability: 'announcements.create.write',          admin: T, exec: T, trainer: F, was: "getExecOrAdmin('external') — announcements.ts:69" },
  { capability: 'announcements.update.write',          admin: T, exec: T, trainer: F, was: "getExecOrAdmin('external') — announcements.ts:137" },
  { capability: 'announcements.delete.write',          admin: T, exec: T, trainer: F, was: "getExecOrAdmin('external') — announcements.ts:189" },
  // NEW, NOT A TRANSCRIPTION, AND THE ONLY ROW IN THIS TABLE THAT IS NOT ONE.
  // There was no console way to speak in Discord before 00222, so `was` names
  // the act it is equivalent to rather than a call site that existed: /say,
  // which Discord itself gates on MANAGE_GUILD.
  //
  // `exec: T` DOES NOT MEAN EVERY EXEC HAS IT. This column is what an
  // unrestricted exec may be ASSIGNED — it derives EXEC_ASSIGNABLE, the set an
  // admin may hand out — and it is T because 00224 put the capability in VP
  // External at the owner's request, and a VP portfolio is by construction a
  // subset of that set. What an exec HOLDS by default is EXEC_BASELINE, twelve
  // reads, and this is not among them.
  { capability: 'announcements.discord.write',         admin: T, exec: T, trainer: F, was: 'no console equivalent — /say, gated by Discord MANAGE_GUILD; VP External since 00224' },

  // ---- tournaments · manage --------------------------------------------
  { capability: 'tournaments.page',                    admin: T, exec: T, trainer: F, was: "getAuthenticatedExecOrAdmin('tournaments') — tournaments/[id]/page.tsx:18" },
  { capability: 'tournaments.manage.create.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:24" },
  { capability: 'tournaments.manage.update.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:129" },
  { capability: 'tournaments.manage.status.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:68" },
  { capability: 'tournaments.manage.suspend.write',    admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:167" },
  { capability: 'tournaments.manage.resume.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:198" },
  { capability: 'tournaments.manage.archive.write',    admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:225" },
  { capability: 'tournaments.manage.delete.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:249" },
  { capability: 'tournaments.manage.event.create.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — events.ts:84" },
  { capability: 'tournaments.manage.event.update.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — events.ts:139" },
  { capability: 'tournaments.manage.event.delete.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — events.ts:219" },
  { capability: 'tournaments.manage.event.status.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — events.ts:243" },

  // ---- tournaments · draw ----------------------------------------------
  { capability: 'tournaments.draw.participants.add.write',    admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:25, 117; tournaments.ts:273" },
  { capability: 'tournaments.draw.participants.remove.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:302; tournaments.ts:310" },
  { capability: 'tournaments.draw.checkin.token.write',       admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournament-checkin.ts:24, 59" },
  { capability: 'tournaments.draw.checkin.mark.write',        admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:335, 629, 700" },
  { capability: 'tournaments.draw.noshow.write',              admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:369, 669" },
  { capability: 'tournaments.draw.exit.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:427" },
  { capability: 'tournaments.draw.pairs.add.write',           admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:534" },
  { capability: 'tournaments.draw.pairs.remove.write',        admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:604" },
  { capability: 'tournaments.draw.seed.set.write',            admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — seeding.ts:10, 35" },
  { capability: 'tournaments.draw.seed.auto.write',           admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — seeding.ts:60" },
  { capability: 'tournaments.draw.seed.clear.write',          admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — seeding.ts:115" },
  { capability: 'tournaments.draw.generate.write',            admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — brackets.ts:363, 664" },
  { capability: 'tournaments.draw.lock.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — brackets.ts:796" },
  { capability: 'tournaments.draw.unlock.write',              admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — brackets.ts:822" },
  // THE FOURTH ROW IN THIS TABLE WITH NO GATE TO TRANSCRIBE, and for the same
  // reason as `players.read`: there was no gate, because there was no fetch.
  // event_waiver_acceptances was write-only across the whole codebase — one
  // insert in the player app and not a single read anywhere. So the answers are
  // transcribed from the DOOR this fetch stands behind, the event page's
  // `tournaments.page`, and adding the capability takes nothing from anybody who
  // can open that page today.
  { capability: 'tournaments.draw.waivers.read',              admin: T, exec: T, trainer: F, was: 'new fetch — no predecessor gate; behind tournaments.page on the event page' },
  // THE FIFTH ROW WITH NO GATE TO TRANSCRIBE, and the same reason again: there
  // was no gate because there was no fetch. Nobody had ever asked how many of a
  // tournament's events one member had entered, because until 00098 there was
  // no cap for the answer to mean anything against. So the answers come from
  // the DOOR — the tournament page's `tournaments.page`, which is the screen
  // this is rendered on — and the capability takes nothing from anybody who can
  // open that page today.
  { capability: 'tournaments.draw.entrycounts.read',          admin: T, exec: T, trainer: F, was: 'new fetch — no predecessor gate; behind tournaments.page on the tournament page' },

  // ---- tournaments · results -------------------------------------------
  { capability: 'tournaments.results.enter.write',        admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:241" },
  { capability: 'tournaments.results.walkover.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:446" },
  { capability: 'tournaments.results.void.write',         admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:515" },
  { capability: 'tournaments.results.unvoid.write',       admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:709" },
  { capability: 'tournaments.results.undo.write',         admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:1169" },
  { capability: 'tournaments.results.edit.write',         admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:933" },
  { capability: 'tournaments.results.entry.write',        admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:796" },
  { capability: 'tournaments.results.doublenoshow.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:606" },
  { capability: 'tournaments.results.bonuses.write',      admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — finalize.ts:85" },
  { capability: 'tournaments.results.standings.write',    admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — finalize.ts:506" },
  { capability: 'tournaments.results.finalize.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — finalize.ts:516" },

  // ---- tournaments · fees ----------------------------------------------
  // The one admin-only sub-route under an exec-allowed section. Entry money was
  // never exec work and it still is not.
  { capability: 'tournaments.fees.read',              admin: T, exec: F, trainer: F, was: 'getAuthenticatedAdmin() + ADMIN_ONLY_PATTERNS — tournaments/[id]/fees/page.tsx' },
  { capability: 'tournaments.fees.tier.create.write', admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — tournament-fees.ts:86' },
  { capability: 'tournaments.fees.tier.update.write', admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — tournament-fees.ts:143' },
  { capability: 'tournaments.fees.tier.delete.write', admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — tournament-fees.ts:192' },
  { capability: 'tournaments.fees.markpaid.write',    admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — tournament-fees.ts:218' },
  { capability: 'tournaments.fees.markunpaid.write',  admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — tournament-fees.ts:294' },

  // ---- events ----------------------------------------------------------
  { capability: 'events.page',                         admin: T, exec: F, trainer: F, was: 'no prior gate: club events are new in 00244' },
  { capability: 'events.signups.read',                 admin: T, exec: F, trainer: F, was: 'no prior gate: club events are new in 00244' },
  { capability: 'events.signups.remove.write',         admin: T, exec: F, trainer: F, was: 'no prior gate: club events are new in 00244' },
  { capability: 'events.manage.create.write',          admin: T, exec: F, trainer: F, was: 'no prior gate: club events are new in 00244' },
  { capability: 'events.manage.update.write',          admin: T, exec: F, trainer: F, was: 'no prior gate: club events are new in 00244' },
  { capability: 'events.manage.cancel.write',          admin: T, exec: F, trainer: F, was: 'no prior gate: club events are new in 00244' },
  { capability: 'events.manage.delete.write',          admin: T, exec: F, trainer: F, was: 'no prior gate: club events are new in 00244' },

  // ---- fees ------------------------------------------------------------
  // The exec rows in this whole area are the club owner's "allow execs to add
  // expenses too", and nothing else on the page ever was.
  //
  // fees.page is one of the two capabilities in this table with no predecessor
  // to transcribe, because /fees was the one section whose page key did not
  // already exist under a `.read` name. Its exec answer is not a judgement: an
  // exec reaches /fees today, so an exec holds the key that admits them, or this
  // change would have taken the Expenses tab away from every exec in the club.
  { capability: 'fees.page',                          admin: T, exec: T, trainer: F, was: "SECTION_ACCESS['/fees'] = 'exec' — the route an exec already reaches" },
  { capability: 'fees.expenses.read',                 admin: T, exec: T, trainer: F, was: "getAuthenticatedExecOrAdmin('finance') — fees/page.tsx:59" },
  { capability: 'fees.expenses.add.write',            admin: T, exec: T, trainer: F, was: "getExecOrAdmin('finance') — finance.ts:171" },
  { capability: 'fees.expenses.update.write',         admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — finance.ts:247' },
  { capability: 'fees.expenses.reimburse.write',      admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — finance.ts:365' },
  { capability: 'fees.expenses.remove.write',         admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — finance.ts:420' },
  { capability: 'fees.otherincome.read',              admin: T, exec: F, trainer: F, was: 'isAdmin fetch — fees/page.tsx:251' },
  { capability: 'fees.otherincome.add.write',         admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — finance.ts:89' },
  { capability: 'fees.otherincome.remove.write',      admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — finance.ts:122' },
  { capability: 'fees.clubfees.read',                 admin: T, exec: F, trainer: F, was: 'isAdmin fetch — fees/page.tsx:141, 145, 157' },
  { capability: 'fees.clubfees.markpaid.write',       admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:57' },
  { capability: 'fees.clubfees.markunpaid.write',     admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:219' },
  { capability: 'fees.clubfees.waive.write',          admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:116' },
  { capability: 'fees.clubfees.addmanual.write',      admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:253' },
  { capability: 'fees.clubfees.removemanual.write',   admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:300' },
  { capability: 'fees.reinstatements.read',           admin: T, exec: F, trainer: F, was: 'isAdmin fetch — fees/page.tsx:125, 421' },
  { capability: 'fees.reinstatements.write',          admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — reinstatement.ts:218' },
  { capability: 'fees.netposition.read',              admin: T, exec: F, trainer: F, was: 'isAdmin fetch — fees/page.tsx:194, dashboard/page.tsx:67' },
  { capability: 'fees.playerflags.write',             admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:26' },

  // ---- legal -----------------------------------------------------------
  // requireReacceptance lives in actions/settings.ts but belongs to /legal —
  // the one exec gate in that file, and the reason this area is not uniform
  // with its file.
  { capability: 'legal.page',                         admin: T, exec: T, trainer: F, was: "getAuthenticatedExecOrAdmin('external') — legal/page.tsx:18" },
  { capability: 'legal.reacceptance.write',           admin: T, exec: T, trainer: F, was: "getExecOrAdmin('external') — settings.ts:185" },
  { capability: 'legal.documents.write',              admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — settings.ts:71' },
  { capability: 'legal.waivertemplate.write',         admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — settings.ts:124' },

  // ---- walkovers -------------------------------------------------------
  { capability: 'walkovers.page',                     admin: T, exec: F, trainer: F, was: "SECTION_ACCESS['/walkovers'] = 'admin'" },
  { capability: 'walkovers.confirm.write',            admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — walkovers.ts:15' },
  { capability: 'walkovers.reject.write',             admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — walkovers.ts:48' },

  // ---- disputes --------------------------------------------------------
  { capability: 'disputes.page',                      admin: T, exec: F, trainer: F, was: "SECTION_ACCESS['/disputes'] = 'admin'" },
  { capability: 'disputes.resolve.write',             admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — disputes.ts:18' },

  // ---- permissions -----------------------------------------------------
  { capability: 'permissions.page',                   admin: T, exec: F, trainer: F, was: 'getAuthenticatedAdmin() — permissions/page.tsx:18' },
  { capability: 'permissions.write',                  admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — portfolios.ts:32 (setPlayerPortfolio)' },

  // ---- audit / ratings / accounts --------------------------------------
  { capability: 'audit.page',                         admin: T, exec: F, trainer: F, was: "SECTION_ACCESS['/audit'] = 'admin'" },
  // THE AUDIT LOG'S CSV EXPORT. No prior gate to transcribe, so these two rows
  // are a reason rather than a transcription, the way the three
  // `accounts.apikey.*` rows below are. `exec: F` on both follows `audit.page`
  // above: a download from a section somebody cannot open is not a coherent
  // grant, and until that row moves neither of these can. The split into two is
  // the sign-in trail, which carries account email addresses and login times
  // for members as well as officers, and which the club may want to withhold
  // from somebody who may still export what the console did.
  { capability: 'audit.export.read',                  admin: T, exec: F, trainer: F, was: 'no prior gate: the log-type export on /audit is new, and it follows audit.page' },
  { capability: 'audit.signins.read',                 admin: T, exec: F, trainer: F, was: 'no prior gate: the sign-in log was unreachable from the console before 00257' },
  { capability: 'ratings.page',                       admin: T, exec: F, trainer: F, was: 'getAuthenticatedAdmin() — ratings/page.tsx:17' },
  { capability: 'accounts.page',                      admin: T, exec: F, trainer: F, was: 'getAuthenticatedAdmin() — accounts/page.tsx:12' },
  // THE DATA API'S KEYS, minted from a panel on that page. No prior gate, and
  // `exec: F` on all three is a decision rather than an inherited answer: a
  // minted key reads the club's data from outside every gate in access-level.ts
  // and keeps answering after the minter's console is taken away, so handing one
  // out is admin work in a way no capability below it is. 00238 admits the
  // strings to the stored vocabulary without making them assignable.
  { capability: 'accounts.apikey.read',               admin: T, exec: F, trainer: F, was: 'no prior gate: the read-only data API and its key panel are new' },
  { capability: 'accounts.apikey.mint.write',         admin: T, exec: F, trainer: F, was: 'no prior gate: the read-only data API and its key panel are new' },
  { capability: 'accounts.apikey.revoke.write',       admin: T, exec: F, trainer: F, was: 'no prior gate: the read-only data API and its key panel are new' },

  // ---- platform --------------------------------------------------------
  // The other capability with no predecessor. `platform` has no route, so its
  // page gates the settings FORM on /ratings and /accounts — both of which were
  // admin-only in every half, which is where this row's answers come from.
  { capability: 'platform.page',                      admin: T, exec: F, trainer: F, was: 'getAuthenticatedAdmin() — the form on ratings/page.tsx and accounts/page.tsx' },
  { capability: 'platform.settings.write',            admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — settings.ts:14' },

  // ---- changelog -------------------------------------------------------
  // Club changes. No predecessor: the page and the posting are new in 00286.
  { capability: 'changelog.page',                     admin: T, exec: F, trainer: F, was: 'no prior gate: the Club changes page is new in 00286' },
  { capability: 'changelog.post.write',               admin: T, exec: F, trainer: F, was: 'no prior gate: posting club changes is new in 00286' },

  // ---- page --------------------------------------------------------------
  // THE KEYS TO SWITCHED-OFF FEATURES, and the rows where this table's columns
  // and the gate they replaced deliberately part. For the one commit these
  // features were switchable without keys (47fc75e7), hasConsoleAccess() let
  // every console level in, trainers included. The club owner replaced that
  // with a key per feature, handed to one person at a time, so an unrestricted
  // exec or trainer now holds none of them. That is a narrowing, which the
  // implication in the per-row cases is silent about on purpose, and `exec: F`
  // is what keeps the exec column equal to EXEC_ASSIGNABLE, which these are
  // not in: they are offerable through OFFERABLE_BEYOND_EXEC instead.
  { capability: 'page.access.sessions',               admin: T, exec: F, trainer: F, was: 'any console level, hasConsoleAccess() in the player FeatureGate, 47fc75e7' },
  { capability: 'page.access.challenges',             admin: T, exec: F, trainer: F, was: 'any console level, hasConsoleAccess() in the player FeatureGate, 47fc75e7' },
  { capability: 'page.access.tournaments',            admin: T, exec: F, trainer: F, was: 'any console level, hasConsoleAccess() in the player FeatureGate, 47fc75e7' },
  { capability: 'page.access.leaderboard',            admin: T, exec: F, trainer: F, was: 'any console level, hasConsoleAccess() in the player FeatureGate, 47fc75e7' },
  { capability: 'page.access.my_stats',               admin: T, exec: F, trainer: F, was: 'any console level, hasConsoleAccess() in the player FeatureGate, 47fc75e7' },
  { capability: 'page.access.announcements',          admin: T, exec: F, trainer: F, was: 'any console level, hasConsoleAccess() in the player FeatureGate, 47fc75e7' },
  { capability: 'page.access.fees',                   admin: T, exec: F, trainer: F, was: 'any console level, hasConsoleAccess() in the player FeatureGate, 47fc75e7' },
  { capability: 'page.access.events',                 admin: T, exec: F, trainer: F, was: 'no prior gate: the events switch is new in 00244' },
  { capability: 'page.access.membership',             admin: T, exec: F, trainer: F, was: 'no prior gate: the membership switch is new in 00247' },
  { capability: 'page.access.socials',                admin: T, exec: F, trainer: F, was: 'no prior gate: the socials switch is new in 00247' },
  { capability: 'page.access.guest_waivers',          admin: T, exec: F, trainer: F, was: 'no prior gate: the guest waivers switch is new in 00254' },
  { capability: 'page.access.predictions',            admin: T, exec: F, trainer: F, was: 'no prior gate: the predictions switch is new in 00282' },
];

describe('capability equivalence — nobody gained anything', () => {
  it('covers every capability exactly once', () => {
    expect(TODAY.length).toBe(CAPABILITIES.length);
    expect(new Set(TODAY.map((r) => r.capability)).size).toBe(TODAY.length);
    expect(TODAY.map((r) => r.capability).sort()).toEqual([...CAPABILITIES].sort());
  });

  for (const row of TODAY) {
    it(`${row.capability} — admin=${row.admin} exec≤${row.exec} trainer=${row.trainer} (was ${row.was})`, () => {
      expect(permits('admin', UNRESTRICTED, row.capability)).toBe(row.admin);
      // THE EXEC COLUMN IS AN UPPER BOUND NOW, NOT AN EQUALITY, and this one
      // line is the whole of the change to this file. The expectation moved
      // because the club owner narrowed the exec baseline on purpose: 61 of
      // these rows say `exec: T` and describe a gate that admitted an exec
      // before capabilities existed, and an unrestricted exec no longer passes
      // any of them. Asserting equality would assert the narrowing did not
      // happen.
      //
      // WHAT SURVIVES IS THE DIRECTION THAT MATTERS. "Nobody gained anything"
      // is an implication, and it is the half a widening breaks: if permits()
      // ever says yes where this table says no, somebody has handed a level
      // something no gate ever gave it, and this fails. A narrowing is silent
      // here on purpose — it is caught, exactly, by the set comparison against
      // EXEC_BASELINE further down, which is where the twelve are pinned.
      if (permits('exec', UNRESTRICTED, row.capability)) {
        expect(row.exec, `${row.capability} reaches an exec who never had it`).toBe(true);
      }
      // Trainer keeps the EQUALITY: TRAINER_BASELINE did not move, so there is
      // nothing to weaken and every reason not to.
      expect(permits('trainer', UNRESTRICTED, row.capability)).toBe(row.trainer);
      // Nobody without a console level holds anything, ever.
      expect(permits(null, UNRESTRICTED, row.capability)).toBe(false);
    });
  }

  // The levels were a ladder and the sets have to keep that shape: a capability
  // a trainer holds must be one an exec holds, and one an exec holds must be
  // one an admin holds.
  //
  // THIS IS A CLAIM ABOUT THE TABLE — the HISTORIC answers — and it still holds
  // of them exactly. It is NOT a claim about today's baselines, and the two came
  // apart when the exec baseline narrowed: a trainer now holds
  // `players.editor.varsitynotes.write` and an unrestricted exec does not. That
  // is pinned, with the reasoning and the two possible repairs, in
  // packages/shared/src/utils/__tests__/capabilities.test.ts. It is left out of
  // this file deliberately: this table's job is to say what the gates used to
  // do, and the gates did give it to both.
  it('never gives a lower level something a higher one lacked', () => {
    for (const row of TODAY) {
      if (row.trainer) expect(row.exec, row.capability).toBe(true);
      if (row.exec) expect(row.admin, row.capability).toBe(true);
    }
  });

  // Every capability is held by SOMEBODY, and admins hold all of them. A row
  // with three falses would be a tick box nobody can ever satisfy.
  it('leaves nothing unreachable', () => {
    for (const row of TODAY) expect(row.admin, row.capability).toBe(true);
  });

  // The two independent write-downs, compared. This table was assembled from
  // the call sites; EXEC_ASSIGNABLE and TRAINER_BASELINE were assembled from the
  // areas. If they ever disagree, somebody has moved a boundary.
  //
  // THE EXEC HALF NOW NAMES EXEC_ASSIGNABLE, and that is a repointing at the
  // constant which inherited the claim rather than a weakening. What this table
  // records is WHAT AN EXEC COULD DO BEFORE CAPABILITIES EXISTED; that fact did
  // not change when the baseline narrowed, it moved constants. EXEC_ASSIGNABLE's
  // docblock asserts in prose that it is "the old transcription, preserved
  // verbatim" — this line is the only place in the codebase where that sentence
  // is checked against a derivation somebody made from the call sites instead of
  // from the constant itself.
  it('agrees with the assignable set and the trainer baseline, written down separately', () => {
    const execFromTable = TODAY.filter((r) => r.exec).map((r) => r.capability).sort();
    const trainerFromTable = TODAY.filter((r) => r.trainer).map((r) => r.capability).sort();
    expect(execFromTable).toEqual([...EXEC_ASSIGNABLE].sort());
    expect(trainerFromTable).toEqual([...TRAINER_BASELINE].sort());
  });

  // AND THE NARROWING, DERIVED FROM THE SAME TABLE. The implication in the
  // per-row cases is deliberately silent about a baseline that SHRINKS, so the
  // shrink is pinned here instead — from the call-site table rather than from
  // the constant, which is what keeps this file a second derivation rather than
  // a restatement of access-level.ts.
  //
  // TWO PROPERTIES, AND THE CLUB OWNER ASKED FOR BOTH. Every capability an
  // unrestricted officer still holds is one an exec held before ("nothing
  // widened"), and the writes among them are named one by one rather than
  // counted, so the floor cannot grow a write without somebody writing it here.
  //
  // IT WAS "NOT ONE OF THEM IS A WRITE" UNTIL 2026-09-19, when the owner asked
  // that every officer be able to file an expense: "also give everyone
  // permission to write expense into the fee table". `fees.expenses.add.write`
  // is that request, and it went into the FLOOR rather than into the eight
  // baselines because "everyone" is what the floor means. The narrowing claim
  // this file exists to make is unaffected: the write was exec work before
  // composition shipped, so it is still a subset of what execs had.
  it('leaves an unrestricted exec a strict subset of what execs had, with one named write', () => {
    const historic = new Set(TODAY.filter((r) => r.exec).map((r) => r.capability));
    const today = CAPABILITIES.filter((c) => permits('exec', UNRESTRICTED, c));

    for (const capability of today) {
      expect(historic.has(capability), `${capability} was never exec work`).toBe(true);
    }
    expect(today.filter((c) => c.endsWith('.write'))).toEqual(['fees.expenses.add.write']);
    expect(today.length).toBeLessThan(historic.size);
    // Belt: the same answer the constant gives, so a divergence between the
    // resolver and the list it is built from fails here too.
    expect([...today].sort()).toEqual([...EXEC_BASELINE].sort());
  });

  // Type-level belt: every capability named above is a member of the union, so
  // a string that drifts out of the vocabulary is a compile error here as well
  // as a failing assertion.
  it('names only real capabilities', () => {
    const all = new Set<Capability>(CAPABILITIES);
    for (const row of TODAY) expect(all.has(row.capability), row.capability).toBe(true);
  });
});
