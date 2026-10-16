// WHO MAY OPEN THE ADMIN CONSOLE — the one implementation.
//
// This used to live only in apps/admin/src/lib/permissions.ts, which meant the
// members' app could not import it and grew its own hand-rolled copies instead:
// one in the top bar (`is_exec || is_trainer || role === 'admin'`) and a second,
// narrower one on the settings page (`is_exec || role === 'admin'`) that had
// never been told varsity trainers exist. The two disagreed, so a trainer saw
// the console link in the top bar and not in settings.
//
// It lives in @badminton/shared so both apps ask the same function. The
// admin-only pieces — which path needs which capability — stay in the admin app.
//
// THREE ORDERED LEVELS — admin > exec > trainer. The ordering still exists, but
// it now decides only two things: whether someone reaches the console at all,
// and which BASELINE an unrestricted person holds. What a person may DO is a set
// of capabilities, not a rung — see permits() below.
//
// The string literals must stay byte-identical to what admin_access_level()
// returns in the database (migrations 00054, 00057); the admin middleware feeds
// that value straight into canAccess(). A mismatch resolves to null, fails
// closed, and locks the level out with no error surfaced anywhere.
//
// The club feature switches are imported for one thing: the `page` area's keys
// are derived from that registry (see the end of CAPABILITIES). It has no
// imports of its own, so the edge middleware pulls in nothing further.
import { FEATURES, type FeatureId } from './features';

export type AccessLevel = 'admin' | 'exec' | 'trainer';

// Higher number = more access. Used for every comparison so a new level is one
// entry here rather than a new branch in each caller.
const LEVEL_RANK: Record<AccessLevel, number> = {
  admin: 3,
  exec: 2,
  trainer: 1,
};

/** Does `level` reach at least `required`? The one place the ordering lives. */
export function atLeast(level: AccessLevel | null | undefined, required: AccessLevel): boolean {
  if (!level) return false;
  return LEVEL_RANK[level] >= LEVEL_RANK[required];
}

/** The role markers a player row carries. */
export type AccessLevelInput = {
  role?: string | null;
  is_exec?: boolean | null;
  is_trainer?: boolean | null;
};

// ---------------------------------------------------------------------------
// THE CAPABILITY VOCABULARY
// ---------------------------------------------------------------------------
// One capability per distinct enforced action. `area ('.' resource)* '.' mode`,
// segments lower-case alphanumeric, mode ∈ {page, read, write}, depth 2–5.
//
// THREE MODES, because "may open this section" and "may see the data in it" are
// different questions and the club needs them answered separately. The owner's
// case is somebody who comes in to ADD without browsing: "access the page to add
// stuff, but not see the details in them".
//
//  - `<area>.page`                   may open the section. Depth 2, exactly one
//                                    per area, and the only thing the route gate
//                                    and the nav ever ask for.
//  - `<area>.<resource>.read`        may see that particular data. Gates an
//                                    individual FETCH, never a page shell.
//  - `<area>.<resource>.<verb>.write` may perform that action.
//
// A `.read` exists only where something is actually gated on it. Several areas
// have a page and no read at all, and that is correct rather than an omission —
// inventing a read nothing checks would be a tick box the app does not honour.
//
// This replaces exec portfolios, which were a closed set of four VP jobs. Four
// jobs could only ever cut the console four ways, and the club's real question
// turned out to be per-action ("this treasurer may see club fees but not hand
// out permissions"), which no fixed set of jobs answers.
//
// FIVE THINGS KEEP THIS LIST CLOSED, and none of them is optional:
//
//  1. One `as const` array, and `Capability` is a union of its members — never
//     `string`. Every gate takes a Capability, so a typo is a compile error at
//     the call site rather than a gate that silently admits nobody.
//  2. Nothing hand-types a capability anywhere else. The baselines, the gates
//     and (later) the editor all reference this array or its type.
//  3. CAPABILITY_GATES in ./capability-gates.ts names the enforcement point for
//     every entry. A capability with no gate is a promise the app does not keep.
//  4. Drift tests: the literal list is pinned, no capability's resource path is
//     a strict prefix of another's at the same mode, every first segment is an
//     area, every area has exactly one `.page`, and both baselines are subsets
//     of this list.
//  5. REMOVAL IS A MIGRATION. Once permissions are stored (00087), deleting a
//     capability while a stored `permission_revokes` array still names it turns
//     a live revoke into a silent no-op — the one way this model can widen
//     somebody by accident. Any removal ships with SQL stripping the string.
//
// LEAVES ONLY, NO PREFIX IMPLICATION. Holding `tournaments.manage.read` does not
// imply `tournaments.fees.read`; the interior nodes are grouping labels for the
// editor and are never grantable. Resolve-time implication is how permission
// systems grant things nobody reviewed — adding
// `players.editor.medicalhistory.write` under a coarse `players.write` would
// reach every holder of it with no diff and no audit row. permits() is plain set
// membership, and the no-prefix test is the belt to that pair of braces.

export const AREAS = [
  'players',
  'seasons',
  'sessions',
  'matches',
  'challenges',
  'announcements',
  'tournaments',
  'events',
  'fees',
  'legal',
  'walkovers',
  'disputes',
  'permissions',
  'audit',
  'ratings',
  'accounts',
  'platform',
  'changelog',
  'page',
] as const;

export type Area = (typeof AREAS)[number];

// The `page` area's keys, one per club feature switch, derived from the
// registry so a feature cannot be added without one. See the entry at the end
// of CAPABILITIES for what they are and why their names break the grammar.
export const FEATURE_ACCESS_CAPABILITIES = FEATURES.map(
  (feature) => `page.access.${feature.id}` as const,
);

export const CAPABILITIES = [
  // ---- players -----------------------------------------------------------
  // THE OWNER'S CASE, on the page they asked for it on: "access the page to add
  // stuff, but not see the details in them". `players.page` opens the section
  // and `players.read` buys the ROSTER — the list, one member's record, and the
  // count of them on the dashboard. Somebody handed the page and
  // players.create.write comes in to add a member and browses nobody.
  //
  // The roster used to ride on the page key, which made that impossible here
  // and only here: /fees had five separate fetch gates and /players had none,
  // so the one section the club most wanted split was the one that could not be.
  //
  // NOT the player PICKERS. The lists behind the create-match, create-challenge,
  // session-attendance and tournament-entrant forms are fetched by their own
  // sections and stay there: somebody who may enter a match result must be able
  // to name the players in it, and moving those behind this capability would
  // also put `players.read` in two roles at once, which the partition test
  // refuses.
  'players.page',
  'players.read',
  'players.approve.write',
  'players.create.write',
  'players.update.write',
  'players.waiver.resign.write',
  'players.ban.write',
  'players.reinstate.write',
  'players.editor.varsitynotes.write',
  'players.deletion.cancel.write',
  'players.remove.write',
  'players.merge.write',
  'players.reliability.write',
  // The GRANTABLE half of the old ADMIN_ONLY_PLAYER_FIELDS. The other half —
  // role, is_exec, is_trainer and the three permission_* columns — is a hard
  // floor that no capability reaches; see player-field-access.ts.
  'players.privilegedfields.write',
  // GIVING SOMEBODY THE CONSOLE, OR TAKING IT AWAY — the club owner's "also
  // make role change a permission".
  //
  // THE ONE DOOR IN THE HARD FLOOR, AND IT IS DELIBERATELY NARROW. `role`,
  // `is_exec` and `is_trainer` stay on PLAYER_FIELD_FLOOR and are unreachable
  // through updatePlayer() — which now refuses them from every caller, admins
  // included, because the club owner took the console-access control off the
  // member Edit dialog. This capability is read in ONE place — setConsoleAccess
  // — which is therefore the only way anybody changes a level at all, and the
  // act is bounded by grant closure on both sides: what the target holds now
  // must be inside the actor's own set, and what they would hold afterwards
  // must be too.
  //
  // IT CAN NEVER MINT AN ADMIN. `access === 'admin'`, and any change to a
  // person who is ALREADY an admin, still require isAdminActor(). If a
  // capability could hand out the admin level, holding it would be equivalent
  // to being an admin and the floor above would be decorative. The docblock on
  // setConsoleAccess makes that argument and this change narrows it rather than
  // overturning it: handing out the top LEVEL is still the act the capability
  // system cannot express.
  //
  // CLOSURE DOES THE GRADUATING, so this is one capability rather than two. An
  // unrestricted exec resolves to EXEC_BASELINE and an unrestricted trainer to
  // TRAINER_BASELINE's 3 — so a holder whose own set is trainer-sized may
  // promote somebody to varsity trainer and is refused when they try to promote
  // to executive, with no second capability needed to say so. A separate
  // `…consoleaccess.trainer.write` would gate the same function at the same line
  // and would be a tick box the enforcement does not honour.
  //
  // THE NARROWED BASELINE MADE THAT GRADUATION EASIER RATHER THAN HARDER, and
  // it is worth saying so where somebody will read it. Promoting to executive
  // used to require an actor holding all 73; it now requires one holding the
  // twelve READS the baseline is, because that is all the promotion confers.
  // The writes arrive afterwards, from a role or a grant, and each of those is
  // closure-checked on its own — so the check moved from one big test to the
  // several small ones that match what is actually being handed over.
  //
  // IN THE `players` AREA RATHER THAN `permissions`, for two reasons. The first
  // is that `permissions.write` is the vocabulary's only bare `<area>.write`,
  // so every `permissions.<x>.write` would have it as a strict prefix at the
  // same mode — the shape the no-prefix rule refuses, and refuses for exactly
  // this hazard: a coarse `permissions.write` reading as though it implied the
  // finer console act. The second is that it belongs here anyway. What this
  // writes is three columns on a PLAYER row, beside players.privilegedfields.write
  // which is the other slice off the same floor. An area is not a file — see
  // `legal.reacceptance.write` in actions/settings.ts and the whole of
  // `challenges` in actions/matches.ts.
  //
  // THE COST OF THAT PLACEMENT, stated rather than discovered: the resolver
  // prunes any capability whose area page is absent, so a holder needs
  // `players.page` as well or this evaporates. That is surfaced rather than
  // silent — baselineCapabilityRefusal() names the missing page, and the editor
  // refuses the save in the same words.
  'players.consoleaccess.write',

  // ATTACHING A DISCORD ACCOUNT TO A MEMBER from the console, without the
  // member. The member-run `/link` flow still exists and is still the ordinary
  // path; this is the one for the member who will not or cannot walk it.
  //
  // A NEW CAPABILITY RATHER THAN `players.merge.write`, which is the nearest
  // neighbour and the wrong one. Merging folds two roster rows into a single
  // member. This attaches an EXTERNAL identity to a roster row that is already
  // whole: no column on `players` is touched, and the row it writes lives in a
  // table of its own. Reusing the merge string would hand everyone who holds it
  // a second act sharing none of the bounds that made the first one safe.
  //
  // ADMIN-ONLY, and deliberately absent from OFFERABLE_BEYOND_EXEC for the same
  // reason `players.merge.write` and `players.remove.write` are withheld below:
  // it is identity-altering, and it is so in a direction that reaches somebody
  // who is not the target. Re-linking a member displaces whatever Discord
  // account they were linked to, and that account loses its club roles on the
  // next sweep without anybody asking it.
  //
  // NEEDS `players.page` ALONGSIDE IT, exactly as its neighbour above does: the
  // resolver prunes any capability whose area page is absent, so granted alone
  // it evaporates.
  'players.discordlink.write',

  // ---- seasons -----------------------------------------------------------
  'seasons.page',
  'seasons.create.write',
  'seasons.activate.write',
  'seasons.end.write',
  'seasons.fees.write',

  // ---- sessions ----------------------------------------------------------
  'sessions.page',
  'sessions.reminders.write',
  'sessions.create.write',
  'sessions.update.write',
  'sessions.archive.write',
  'sessions.checkin.token.write',
  'sessions.attendance.write',
  'sessions.delete.write',

  // ---- matches -----------------------------------------------------------
  'matches.page',
  'matches.void.write',
  'matches.convert.write',
  'matches.create.write',

  // ---- challenges --------------------------------------------------------
  // Their own area rather than part of `matches`: the two admin-only challenge
  // actions live in actions/matches.ts, but /challenges is its own section and
  // its own boundary. Filing them under matches would have handed both to every
  // exec, because everything else in that file is exec work.
  'challenges.page',
  'challenges.create.write',
  'challenges.expire.write',

  // ---- announcements -----------------------------------------------------
  //
  // `announcements.discord.write` is NOT a fourth way to write an
  // announcement. It queues a message into the club's Discord channel — the
  // console's half of the bot's /say — and it is separate from the three above
  // because it reaches a different audience by a different route: a member who
  // never opens the website is in that channel, and nothing on this page can
  // take a Discord message back the way unpublishing takes an announcement
  // down. The three writes above all lead somewhere the console still owns.
  //
  // It is NOT a new AREA. `discord` as an area would need its own `.page`, and
  // there is no Discord page to open — the panel lives on this one, behind
  // this one's key.
  //
  // IT BELONGS TO VP EXTERNAL, who already holds every other announcement
  // write. The club owner asked for that directly, and it is the coherent
  // answer: the person who decides what the club says to its members should
  // not have to ask somebody else to say it in the one place most members
  // actually read.
  //
  // IT IS STILL NOT IN EXEC_BASELINE. This is the one comms act in the console
  // with no undo and no reach afterwards — unpublishing takes an announcement
  // down, nothing here takes a Discord message back — so it is held by a named
  // job, not by everyone who happens to be an exec.
  //
  // AND IT COST A MIGRATION, which is the part worth remembering. The four VP
  // portfolios are SEEDED ROWS (00104) and editable-roles.test.ts reads that
  // file as text, so widening one is a re-seed (00224) and not an edit to this
  // constant. The re-seed also has to reach the people already holding the
  // role: assigning a built-in COPIES its capabilities onto the player row
  // (00104), so a baseline the migration widens and holders it does not is a
  // portfolio that grants something nobody in it can do.
  'announcements.page',
  'announcements.create.write',
  'announcements.update.write',
  'announcements.delete.write',
  'announcements.discord.write',

  // ---- tournaments -------------------------------------------------------
  // The largest area by a distance — more capabilities than the next three
  // areas together. (No headcount here on purpose: the one that used to be
  // written down said 117 against a list that had grown to 119, which is what
  // a number in a comment does. capabilities.test.ts pins the real one.) Four
  // groups, and the split
  // matters — running a draw, entering results and handling entry money are
  // three different jobs that happen to share a section.
  //
  // `tournaments.fees.read` is the one read that survives here, and it is a read
  // rather than a second page because a page is one per AREA: entry money sits
  // at /tournaments/<id>/fees, inside a section execs already reach, and its own
  // roster is the data being withheld.
  'tournaments.page',
  'tournaments.manage.create.write',
  'tournaments.manage.update.write',
  'tournaments.manage.status.write',
  'tournaments.manage.suspend.write',
  'tournaments.manage.resume.write',
  'tournaments.manage.archive.write',
  'tournaments.manage.delete.write',
  'tournaments.manage.event.create.write',
  'tournaments.manage.event.update.write',
  'tournaments.manage.event.delete.write',
  'tournaments.manage.event.status.write',
  'tournaments.draw.participants.add.write',
  'tournaments.draw.participants.remove.write',
  'tournaments.draw.checkin.token.write',
  'tournaments.draw.checkin.mark.write',
  'tournaments.draw.noshow.write',
  'tournaments.draw.exit.write',
  'tournaments.draw.pairs.add.write',
  'tournaments.draw.pairs.remove.write',
  'tournaments.draw.seed.set.write',
  'tournaments.draw.seed.auto.write',
  'tournaments.draw.seed.clear.write',
  'tournaments.draw.generate.write',
  'tournaments.draw.lock.write',
  'tournaments.draw.unlock.write',
  // Who in this draw has accepted the event waiver. A READ of
  // event_waiver_acceptances, in the `draw` group because it is read where the
  // field is managed — the roster and the check-in board — and because the
  // thing it gates is a fetch, not a page.
  'tournaments.draw.waivers.read',
  // How many of this tournament's events each entrant has taken, and who is at
  // the cap. A READ of tournament_participants and tournament_pairs folded into
  // a per-player count, in the `draw` group for the same reason as the line
  // above: it is read where the field is managed, and it gates a fetch.
  'tournaments.draw.entrycounts.read',
  'tournaments.results.enter.write',
  'tournaments.results.walkover.write',
  'tournaments.results.void.write',
  'tournaments.results.unvoid.write',
  'tournaments.results.undo.write',
  'tournaments.results.edit.write',
  'tournaments.results.entry.write',
  'tournaments.results.doublenoshow.write',
  'tournaments.results.bonuses.write',
  'tournaments.results.standings.write',
  'tournaments.results.finalize.write',
  'tournaments.fees.read',
  'tournaments.fees.tier.create.write',
  'tournaments.fees.tier.update.write',
  'tournaments.fees.tier.delete.write',
  'tournaments.fees.markpaid.write',
  'tournaments.fees.markunpaid.write',

  // ---- events ------------------------------------------------------------
  // Club events that are not tournaments: socials, workshops, clinics, outings
  // and the AGM. Admin-only by level: in no baseline, and in neither
  // EXEC_ASSIGNABLE nor OFFERABLE_BEYOND_EXEC. Making them exec work later is a
  // ROLE_DEFAULTS re-seed like 00224, and that is the owner's decision.
  'events.page',
  'events.signups.read',
  'events.signups.remove.write',
  'events.manage.create.write',
  'events.manage.update.write',
  'events.manage.cancel.write',
  'events.manage.delete.write',

  // ---- fees --------------------------------------------------------------
  // Four ledgers plus the net position, each with its own read, under one page
  // key. /fees is a single section that has always been two boundaries: an exec
  // may file the expense they paid out of pocket, and nothing else on the page
  // is theirs.
  //
  // THE AREA THE THREE-MODE SPLIT WAS FOR. `fees.page` plus
  // `fees.expenses.add.write` and no read at all opens the section, shows no
  // ledger and no net position, and offers the Add expense form — the club
  // owner's "access the page to add stuff, but not see the details in them",
  // which the old model could not express at all.
  'fees.page',
  'fees.expenses.read',
  'fees.expenses.add.write',
  'fees.expenses.update.write',
  'fees.expenses.reimburse.write',
  'fees.expenses.remove.write',
  'fees.otherincome.read',
  'fees.otherincome.add.write',
  'fees.otherincome.remove.write',
  'fees.clubfees.read',
  'fees.clubfees.markpaid.write',
  'fees.clubfees.markunpaid.write',
  'fees.clubfees.waive.write',
  'fees.clubfees.addmanual.write',
  'fees.clubfees.removemanual.write',
  'fees.reinstatements.read',
  'fees.reinstatements.write',
  'fees.netposition.read',
  'fees.playerflags.write',

  // ---- legal -------------------------------------------------------------
  'legal.page',
  'legal.reacceptance.write',
  'legal.documents.write',
  'legal.waivertemplate.write',

  // ---- walkovers ---------------------------------------------------------
  'walkovers.page',
  'walkovers.confirm.write',
  'walkovers.reject.write',

  // ---- disputes ----------------------------------------------------------
  'disputes.page',
  'disputes.resolve.write',

  // ---- permissions -------------------------------------------------------
  // The dangerous pair. A holder of permissions.write can hand out any
  // capability they themselves hold — grant closure bounds that, but within the
  // bound it is unlimited and the audit log is the only trace.
  'permissions.page',
  'permissions.write',

  // ---- audit / ratings / accounts ----------------------------------------
  // Sections whose whole content is their page, which was true of all three
  // until /accounts grew the data API's key panel below and /audit grew the
  // export just under this line. `ratings` is the last one the sentence still
  // describes. Each is its own area so that opening one to somebody does not
  // open the others.
  'audit.page',

  // THE LOG EXPORT ON /audit: a log-type selector over console edits, sign-ins,
  // tournament actions and in-app notifications, and a CSV download of the type
  // selected.
  //
  // TWO CAPABILITIES AND NOT ONE, because running a download and seeing the
  // sign-in trail are different questions. The console trail says what an
  // officer DID. The sign-in trail is the identity log: account email addresses
  // and login times, for members as well as officers, including accounts with
  // no console access at all. The club's case is somebody who may export the
  // console's edits without being handed the record of who signed in and when,
  // so the source has its own key and the page hides the option without it.
  //
  // NO THIRD STRING FOR THE PANEL. `audit.page` already decides who opens
  // /audit, and the selector is drawn inside it. A capability whose only job is
  // to gate a control on a page somebody is already looking at would be a
  // second name for a door that is already shut.
  //
  // BOTH ARE READS because nothing here writes: a download is a SELECT and a
  // file. What `audit.export.read` bounds is not the sight of the rows, which
  // `audit.page` already grants, but the production of a FILE, which leaves the
  // console, outlives the session and gets forwarded.
  'audit.export.read',
  'audit.signins.read',

  'ratings.page',
  'accounts.page',

  // THE READ-ONLY EXTERNAL DATA API'S KEYS, minted and revoked from a panel on
  // /accounts. Three capabilities and not one: seeing which keys exist, minting
  // a new one and taking an existing one back are three different questions,
  // and the club's case is somebody who may see the list and hand nothing out.
  //
  // THE NAMES ARE NOT THE ONES THAT WERE ASKED FOR, and the reason is the
  // grammar rather than a preference. The request was `accounts.apikey.mint`
  // and `accounts.apikey.delete`; every capability in this list ends in `page`,
  // `read` or `write`, pinned by a test, so a bare `.mint` is not a string this
  // vocabulary can hold at all. The verb moves one segment left and the mode
  // goes on the end. Depth 4 is allowed, and `fees.expenses.add.write` /
  // `fees.expenses.remove.write` is the precedent for splitting creating a
  // thing from taking it away.
  //
  // REVOKE RATHER THAN DELETE, and that is the act rather than a softer word
  // for it. Revoking a key sets `revoked_at` and KEEPS THE ROW, so the audit
  // trail of who minted what, and when it stopped working, outlives the key.
  // A capability called `delete` would name something this panel does not do.
  'accounts.apikey.read',
  'accounts.apikey.mint.write',
  'accounts.apikey.revoke.write',

  // ---- platform ----------------------------------------------------------
  // THE ONE AREA WITH NO ROUTE OF ITS OWN. Platform settings are a form drawn
  // inside /ratings and /accounts, so `platform.page` gates that form rather
  // than a path in the section map. It exists because every capability in an
  // area requires that area's page — without it, platform.settings.write would
  // be pruned from anybody the resolver ever runs for.
  'platform.page',
  'platform.settings.write',

  // ---- changelog ---------------------------------------------------------
  // CLUB CHANGES (00286). Saving a rating setting, an account rule, a member
  // page switch, a club link or an officer role writes a plain-language draft
  // line; /club-changes is where an admin rewords, deletes and adds lines, and
  // posts one or the whole bundle to members.
  //
  // TWO STRINGS: opening the page, and everything that changes what members
  // will be told. Rewording, deleting and adding a line are part of deciding
  // what gets published, so they sit under the post key rather than three
  // more. Both admin-only by level and in no baseline: posting is the club
  // speaking to every member.
  'changelog.page',
  'changelog.post.write',

  // ---- page --------------------------------------------------------------
  // INTO A FEATURE THE CLUB HAS SWITCHED OFF. One key per switch in
  // ./features.ts, named `page.access.<feature id>` by the club owner:
  // "build a permission node for access to a restricted page". It replaced
  // "anybody with console access sees a switched-off feature" (47fc75e7), so
  // letting somebody test tournaments before they go live is now a grant that
  // somebody chose, and it does not also let them into challenges.
  //
  // DERIVED FROM THE REGISTRY, NOT TYPED HERE, so a new feature cannot forget
  // its key. What it cannot do by itself is reach the database: the vocabulary
  // CHECK has to learn the string in a migration, and capability-storage.test.ts
  // fails until it has.
  //
  // THE ONE AREA THAT BREAKS THE GRAMMAR ABOVE, and it does so in two places,
  // both stated for this area alone in capabilities.test.ts rather than by
  // loosening the rule for everybody. The names end in the feature id rather
  // than a mode, because those are the names the owner asked for; and the id is
  // used verbatim, so `page.access.my_stats` carries an underscore.
  //
  // EACH ONE IS ITS OWN PAGE. There is no `page.page`: pageOf() maps these to
  // themselves, so a grant needs nothing beside it and a revoke closes exactly
  // the one feature. The editor draws them as reads, which is what they are:
  // the holder may open the feature and use it while members are kept out.
  //
  // IN NO BASELINE. Switched off means off, and the only person who reaches a
  // switched-off page without being handed its key is an admin, by level.
  ...FEATURE_ACCESS_CAPABILITIES,
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The key that lets somebody into this feature while it is switched off. */
export function featureAccessCapability(id: FeatureId): Capability {
  return `page.access.${id}`;
}

const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set(CAPABILITIES);

/** Narrow an arbitrary stored string to a capability the vocabulary still has. */
export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && ALL_CAPABILITIES.has(value as Capability);
}

/**
 * The page capability of the area a capability belongs to — `fees.expenses.read`
 * → `fees.page`, and `fees.page` → itself.
 *
 * A plain first-segment lookup, which is the whole reason the new invariant
 * fires for every capability where the old `write ⊆ read` prune fired for two of
 * ninety-three: it never has to find a sibling that might not exist. Every area
 * has a page, pinned by a test, so the cast cannot be wrong.
 */
export function pageOf(capability: Capability): Capability {
  const area = capability.split('.')[0];
  // THE `page` AREA IS THE EXCEPTION: every `page.access.<id>` is a page in its
  // own right, and there is no `page.page` for it to hang off. Mapping one to
  // itself is what keeps the resolver's prune, the baseline refusal and the
  // baseline editor's toggle all agreeing that it stands alone.
  if (area === 'page') return capability;
  return `${area}.page` as Capability;
}

// ---------------------------------------------------------------------------
// BASELINES — what a level holds when nobody has narrowed or composed it
// ---------------------------------------------------------------------------
// Every row ships unrestricted, so every exec resolves to EXEC_BASELINE and
// every trainer to TRAINER_BASELINE.
//
// TRAINER_BASELINE IS STILL A TRANSCRIPTION of what that level could do the day
// capabilities shipped, checked entry by entry against the gate that used to
// stand there (getExecOrAdmin = exec, getAdminPlayer = admin only). EXEC_BASELINE
// WAS ONE AND IS NOT ANY MORE: the transcription moved to EXEC_ASSIGNABLE, kept
// verbatim, and this list narrowed to twelve reads. The capability-equivalence
// test still writes the historic fact out a second time by hand from the call
// sites — it now compares that write-down against EXEC_ASSIGNABLE, and asserts
// separately that no LEVEL's baseline reaches past it. If those disagree,
// somebody has widened a level.
//
// "Unrestricted" is the LEVEL's baseline, not everything.
//
// EVERY AREA A BASELINE REACHES CARRIES THAT AREA'S `.page`. Not a style rule:
// the resolver prunes any capability whose area page is missing, so a baseline
// without one would be a level that can do nothing anywhere.

export const TRAINER_BASELINE: readonly Capability[] = [
  // The entire trainer level, and it always was: open the roster, READ it so you
  // can find the person you are writing about, and write the note. Matches
  // TRAINER_WRITABLE_PLAYER_FIELDS being empty — a trainer changes nothing on a
  // player record itself.
  //
  // The read is here because a trainer browses the roster today. It is the whole
  // reason they have a console at all, and leaving it out would have made
  // gating the roster fetch a change that took the section away from a level.
  //
  // THIS IS NO LONGER INSIDE EXEC_BASELINE, and that is a real consequence of
  // the narrowing rather than an oversight. `players.page` and `players.read`
  // are in both; `players.editor.varsitynotes.write` is a WRITE, so it left the
  // exec floor with every other write and the trainer level is now the smaller
  // set that is NOT contained in the larger one.
  //
  // WHY THAT MATTERS AND WHERE IT BITES: accessLevelFor() resolves is_exec
  // BEFORE is_trainer and returns ONE level, so a row carrying both flags
  // resolves to 'exec' and holds EXEC_BASELINE only — losing the note that is
  // the trainer's entire job. It is latent rather than live because every writer
  // of these columns is mutually exclusive (see fromRoleValue in the admin app's
  // console-access.ts: 'executive' writes is_trainer FALSE), so only a legacy or
  // hand-rolled row can be both. The containment is pinned in capabilities.test.ts
  // as the exact one-capability hole it now is, so it cannot silently grow, and
  // the containment that DOES survive — the trainer level inside EXEC_ASSIGNABLE
  // — is pinned beside it.
  'players.page',
  'players.read',
  'players.editor.varsitynotes.write',
];

export const EXEC_BASELINE: readonly Capability[] = [
  // READ EVERYTHING, WRITE ONE THING — the club owner's instruction, and a
  // deliberate reversal of what this list used to be.
  //
  // It read WRITE NOTHING until 2026-09-19, when the owner asked for the
  // expense write to reach every officer. One write, named and argued for at
  // the line itself. The rule this list still encodes is that authority is
  // GIVEN rather than inherited; filing a receipt is the single exception.
  //
  // It was a TRANSCRIPTION: 73 capabilities copied from what `is_exec` could do
  // the day before the permission system shipped, so that deploying it took
  // nothing away from anybody. That was right for a migration and wrong as a
  // steady state — it meant every officer held every write in eight areas, all
  // 39 tournament capabilities among them, whether or not they had ever run a
  // tournament.
  //
  // The baseline is now the floor: an officer can SEE the club's business and
  // change none of it. Writes arrive by assignment — a permission_role (the
  // four VP jobs, editable since 00104) or an explicit grant on one person — so
  // authority is something somebody was given rather than something everybody
  // inherited.
  //
  // Areas absent here (ratings, audit, permissions, accounts) were already
  // admin-only and stay that way. Nothing below widens anything.
  //
  // THE COST, STATED PLAINLY: on the deploy that ships this, every exec who has
  // not been assigned a role loses every write they had. That is the point
  // rather than a side-effect, and it wants somebody on /permissions the same
  // day.
  'announcements.page',
  'fees.page',
  'fees.expenses.read',
  // THE ONE WRITE, AND THE READ-EVERYTHING-WRITE-NOTHING PROPERTY IS NOW GONE.
  // Owner's instruction, 2026-09-19: "also give everyone permission to write
  // expense into the fee table". It is a deliberate reversal of the line above
  // this list, so it is written down rather than absorbed: the floor is no
  // longer a pure read set, and the test that asserted NOT ONE WRITE now
  // asserts EXACTLY THIS ONE.
  //
  // Why the floor and not the eight club baselines. A baseline only reaches
  // somebody an admin remembered to assign one to; "everyone" means every
  // officer, assigned or not, the day they are handed console access. The floor
  // is the only list with that reach.
  //
  // Why this write and no other. Filing an expense is the one money act that
  // costs the club nothing to get wrong: an officer buys shuttles and records
  // what they spent. Editing, settling and deleting an expense stay assigned
  // (fees.expenses.update/reimburse/remove.write are in EXEC_ASSIGNABLE, not
  // here), so the floor can add to the ledger and still cannot rewrite it.
  // The read above it is what makes this reachable at all: page, ledger, form.
  'fees.expenses.add.write',
  'legal.page',
  'matches.page',
  'players.page',
  'players.read',
  'seasons.page',
  'sessions.page',
  'tournaments.page',
  'tournaments.draw.entrycounts.read',
  'tournaments.draw.waivers.read',
];

const BASELINES: Record<AccessLevel, ReadonlySet<Capability>> = {
  // Admin is a superuser BY LEVEL, so a capability added next year is
  // automatically theirs and there is no list to keep in sync.
  admin: ALL_CAPABILITIES,
  exec: new Set(EXEC_BASELINE),
  trainer: new Set(TRAINER_BASELINE),
};

// ---------------------------------------------------------------------------
// ROLES
// ---------------------------------------------------------------------------
// The club's four VP jobs, kept as a closed list so that assigning one is a
// named act rather than a hand-assembled set of ticks.
//
// A role REPLACES the base rather than adding to it: the VP of Tournaments must
// not reach the books, and a purely additive role would need a dozen
// hand-written revokes to achieve that.
//
// EVERY ROLE IS A SUBSET OF EXEC_ASSIGNABLE, pinned by a test, and that is the
// whole property this table is built to have: a role is bounded by what execs
// could already do, so nothing beyond today's scope for an area (the club's
// books, reinstatements, the net position) can arrive from choosing a word. It
// is handed over per person by an explicit grant, which is a reviewed act with
// an audit row.
//
// IT USED TO BE STATED AGAINST EXEC_BASELINE, and the constant it names moved
// rather than the property. While the baseline WAS the historic 73, "inside the
// exec baseline" and "inside what an exec could already do" were the same
// sentence. Narrowing the baseline to twelve reads split them, and it is the
// second one this bound has always meant — so it now names EXEC_ASSIGNABLE,
// which is that same historic 73 preserved verbatim. Restating it against the
// twelve would have made every VP role exceed its own bound and refused the
// mechanism the narrowing depends on.
//
// THAT IS A BOUND, NOT A DIRECTION, and the difference started mattering when
// trainers became composable. While roles were exec-only the two were the same
// thing — the role was a subset of the target's OWN base, so picking one could
// only subtract, and this comment used to say assigning a role was never itself
// a widening. On a trainer it plainly is: ROLE_DEFAULTS.tournaments is fifty
// capabilities against a baseline of three, and giving a varsity trainer the
// club's competitive calendar without making them an exec is the reason
// composition was opened to them. What survives, unchanged and load-bearing, is
// the ceiling: whoever is composed, a role can only ever leave them inside the
// exec baseline.
//
// The four lists are NOT a new design. They are the old SECTION_PORTFOLIO map —
// the four VP jobs, each owning a set of sections — intersected with the
// historic exec set, and they still partition EXEC_ASSIGNABLE exactly, 3 + 51 +
// 13 + 6 + 0 = 73: finance had /fees, tournaments had /tournaments /matches
// /sessions, internal had /players /seasons, external had /legal /announcements.
// Deriving them that way rather than writing four fresh lists is what makes
// "assigning a role does the same thing the portfolio did" a fact instead of a
// hope.
//
// THE PARTITION IS NOW LOAD-BEARING TWICE OVER. It was the proof that a role
// hands out nothing an exec did not already have; since the baseline narrowed it
// is ALSO the proof that the four roles between them can restore every write an
// officer just lost — an exact partition means no capability fell into the gap
// between the floor and the jobs that are supposed to hand it back.
//
// WHAT A ROLE DOES NOT DO IS ADD TO THE FLOOR. A role REPLACES the base, so an
// officer assigned Tournaments holds the 51 tournament capabilities and NOT the
// roster read the bare baseline gave them. "Every officer can read everything"
// is therefore a statement about UNASSIGNED officers only; the moment somebody
// is given a job, their reads narrow to that job unless the reads are granted
// back. That is the pre-existing shape of a role and not something this change
// introduced, but the narrowing is what makes it visible.
//
// EVERY ROLE CARRIES THE PAGE FOR EVERY AREA IT TOUCHES. That is now an
// invariant of the resolver rather than a courtesy: a capability whose area page
// is absent is pruned, so a role missing one would grant nothing at all in that
// area. Pinned by a test.
//
// `custom` IS NOT A FIFTH VP JOB. It is the empty base — a role whose defaults
// are nothing, so the whole of a hand-picked set lives in `permission_grants`
// and reads back exactly as it was chosen.
//
// It exists because the storage cannot express a hand-picked set any other way.
// resolvePermissions() reads a NULL role as "not composed" and does not consult
// the deltas at all, so anything stored has to name a role — and before this
// existed, the editor's only way to hand somebody a set of its own was to borrow
// the closest VP name and paper over the difference with grants and revokes. A
// varsity trainer who ticked one session capability would have been stored as
// `finance` with three revokes of the club's expense capabilities: a row that
// says the trainer is the treasurer, an audit entry that says the same, and —
// the part that actually bites — membership of the blast radius of any future
// edit to ROLE_DEFAULTS.finance. An empty base has no blast radius, because
// there is nothing in it to change.
export type PermissionRole = 'finance' | 'tournaments' | 'internal' | 'external' | 'custom';

// The four jobs first and `custom` last, because this order is the order the
// editor offers them in and a named job is the choice to reach for first.
export const PERMISSION_ROLES: readonly PermissionRole[] = [
  'finance',
  'tournaments',
  'internal',
  'external',
  'custom',
] as const;

/**
 * Shown wherever a role is chosen or reported.
 *
 * `custom` is 'Hand-picked' rather than 'Custom' because the editor already uses
 * the word Custom for the STATE of a row that has been adjusted — "Custom —
 * Finance with 3 granted" — so a role called Custom reads back as "Custom —
 * Custom" in four places.
 */
export const PERMISSION_ROLE_LABELS: Record<PermissionRole, string> = {
  finance: 'Finance',
  tournaments: 'Tournaments',
  internal: 'Internal',
  external: 'External',
  custom: 'Hand-picked',
};

export const ROLE_DEFAULTS: Record<PermissionRole, readonly Capability[]> = {
  // The Expenses tab and nothing further — 00086's behaviour exactly. Club
  // money, other income, the net position and reinstatements are NOT here even
  // though a treasurer is the obvious person to hold them: the club owner's
  // rule was "execs can add expenses", and a role that reached the books would
  // be the first role to put somebody outside the exec baseline.
  finance: [
    'fees.page',
    'fees.expenses.read',
    'fees.expenses.add.write',
  ],

  // Running the club's competitive calendar: the draw, the ladder and the
  // weekly sessions. Entry money (`tournaments.fees.*`) is deliberately absent
  // — it was admin-only before and it stays admin-only, which is also why the
  // old portfolio could not reach /tournaments/<id>/fees.
  tournaments: [
    'sessions.page',
    'sessions.reminders.write',
    'sessions.create.write',
    'sessions.update.write',
    'sessions.archive.write',
    'sessions.checkin.token.write',
    'sessions.attendance.write',
    'sessions.delete.write',
    'matches.page',
    'matches.void.write',
    'matches.convert.write',
    'matches.create.write',
    'tournaments.page',
    'tournaments.manage.create.write',
    'tournaments.manage.update.write',
    'tournaments.manage.status.write',
    'tournaments.manage.suspend.write',
    'tournaments.manage.resume.write',
    'tournaments.manage.archive.write',
    'tournaments.manage.delete.write',
    'tournaments.manage.event.create.write',
    'tournaments.manage.event.update.write',
    'tournaments.manage.event.delete.write',
    'tournaments.manage.event.status.write',
    'tournaments.draw.participants.add.write',
    'tournaments.draw.participants.remove.write',
    'tournaments.draw.checkin.token.write',
    'tournaments.draw.checkin.mark.write',
    'tournaments.draw.noshow.write',
    'tournaments.draw.exit.write',
    'tournaments.draw.pairs.add.write',
    'tournaments.draw.pairs.remove.write',
    'tournaments.draw.seed.set.write',
    'tournaments.draw.seed.auto.write',
    'tournaments.draw.seed.clear.write',
    'tournaments.draw.generate.write',
    'tournaments.draw.lock.write',
    'tournaments.draw.unlock.write',
    // The partition puts this here and nowhere else: /tournaments belongs to
    // the tournaments job, and the officer who runs check-in is the one person
    // who has to see why an entrant was refused.
    'tournaments.draw.waivers.read',
    // The entry cap is a tournament rule, so it lands in the tournaments job
    // alongside every other thing that decides who is in a draw.
    'tournaments.draw.entrycounts.read',
    'tournaments.results.enter.write',
    'tournaments.results.walkover.write',
    'tournaments.results.void.write',
    'tournaments.results.unvoid.write',
    'tournaments.results.undo.write',
    'tournaments.results.edit.write',
    'tournaments.results.entry.write',
    'tournaments.results.doublenoshow.write',
    'tournaments.results.bonuses.write',
    'tournaments.results.standings.write',
    'tournaments.results.finalize.write',
  ],

  // The membership: who is on the roster and which term they are playing in.
  // `seasons.fees.write` is absent for the same reason `finance` stops at
  // expenses — setting what a term costs is admin work and always was.
  internal: [
    'players.page',
    'players.read',
    'players.approve.write',
    'players.create.write',
    'players.update.write',
    'players.waiver.resign.write',
    'players.ban.write',
    'players.reinstate.write',
    'players.editor.varsitynotes.write',
    'seasons.page',
    'seasons.create.write',
    'seasons.activate.write',
    'seasons.end.write',
  ],

  // What the club says to its members and what they sign. Opening the legal
  // documents and forcing a re-signature, but not editing the text — that split
  // predates capabilities and is unchanged.
  external: [
    'announcements.page',
    'announcements.create.write',
    'announcements.update.write',
    'announcements.delete.write',
    // Saying it in Discord as well as on the website. The one capability here
    // with no undo, which is why it is a named job's and not every exec's.
    'announcements.discord.write',
    'legal.page',
    'legal.reacceptance.write',
  ],

  // EMPTY, AND THAT IS THE WHOLE DEFINITION. Everything a hand-picked person
  // holds is in their grants, so the row says what they hold rather than a name
  // plus two corrections. It satisfies the invariants above for free: the empty
  // set is inside the exec baseline, has no duplicates, and touches no area
  // whose page it could be missing.
  custom: [],
};

// WHAT THE EDITOR MAY HAND OUT — the historic exec set PLUS one named widening.
//
// THIS USED TO BE `= EXEC_BASELINE`, AND THE SPLIT IS THE POINT. The constant
// was doing two jobs that finally pulled apart:
//
//   * EXEC_ASSIGNABLE is a TRANSCRIPTION — what an unrestricted exec could do
//     the day composition shipped. It is pinned twice (here and, independently,
//     by capability-equivalence.test.ts deriving it from the call sites), and the
//     club owner has said it must not grow: "exec baseline shouldn't really be
//     too much". Growing it would hand every exec in the club something no exec
//     ever had, with nobody choosing it. Nothing below touches it.
//
//     IT HAS MOVED TWICE SINCE THAT WAS WRITTEN, both times by a named request
//     and never by this list: `announcements.discord.write` for VP External
//     (00224), and `accounts.page` plus the data API's three key capabilities
//     for the execs who are to run them. Each carries its own note at the entry
//     itself, which is the form "it does not move" has taken: a growth is a
//     diff with a reason beside it rather than a line nobody may add.
//
//     (It was called EXEC_BASELINE when this was written, and the rename is the
//     whole of the second split: the baseline became a read-only FLOOR of twelve
//     and the transcription kept the 73 under the new name. EDITOR_OFFERABLE is
//     unchanged as a set and in order — the same 73 + the same five below.)
//
//   * EDITOR_OFFERABLE is a CEILING — the most anybody may be composed UP to by
//     an admin. Grant closure already stops a non-admin handing out what they do
//     not hold; this is the only thing bounding an ADMIN, who holds everything
//     by level and whom closure therefore cannot bound at all.
//
// While the two were the same list, "an exec may not see the books" and "nobody
// may ever be GIVEN the books" were the same sentence. The club owner wants the
// second one false and the first one true: the treasurer should see money in as
// well as out. That is only expressible once the ceiling is its own list.
//
// EDITABLE ROLES ARE WHY THIS BECAME BLOCKING RATHER THAN THEORETICAL. The four
// VP jobs are rows now (00104) and the owner edits them himself, through
// baselineCapabilityRefusal — which caps contents at this constant. Left as an
// alias of EXEC_BASELINE, the seeded Finance row could be shipped but never
// edited into the thing the feature exists to allow.
//
// THE WIDENING IS ENUMERATED, ONE LINE AT A TIME, so opening anything further is
// a diff somebody reads. It is NOT `CAPABILITIES minus a deny-list`: a deny-list
// admits every capability added next year by default, which is the one direction
// a ceiling must never move on its own.
const OFFERABLE_BEYOND_EXEC: readonly Capability[] = [
  // THE OWNER'S CASE, and the whole reason this list exists. "Allow me to edit
  // the permissions of each preassigned role" came out of wanting Finance to see
  // money IN as well as out — today it stops at the expense ledger, because that
  // is where execs stopped. These are the four remaining READS on /fees plus the
  // net position: seeing the club's books.
  //
  // Money is READ-ONLY here, deliberately. Handing out
  // `fees.clubfees.markpaid.write` or the reinstatement write is MOVING money,
  // which is a bigger decision than showing a number, and it is not the one that
  // was asked for. When it is asked for it is four more lines here and a diff
  // somebody reads.
  'fees.clubfees.read',
  'fees.otherincome.read',
  'fees.reinstatements.read',
  'fees.netposition.read',

  // THE FIRST WRITE ON THIS LIST, and the second thing the club owner asked
  // for: "also make role change a permission." Giving somebody the console —
  // making them an executive or a varsity trainer — was admin-only by an
  // explicit isAdminActor() check inside setConsoleAccess, and it is now a
  // capability like any other.
  //
  // IT HAS TO BE HERE OR THE FEATURE IS A DECORATION. Check 5 of
  // setPlayerPermissions refuses any stored grant outside this list, and both
  // editors BUILD their tick boxes by iterating it — so a capability that is not
  // here cannot be granted, cannot be put in a baseline, and cannot even be
  // rendered. `players.privilegedfields.write` is the proof case: its own
  // comment says it is "handed out per person once the editor exists", and check
  // 5 has quietly made that false since the day it was written.
  //
  // WHAT BOUNDS IT IS NOT THIS LIST. A ceiling only says an admin MAY offer it.
  // What stops the person who receives it from manufacturing access is grant
  // closure inside setConsoleAccess, which is checked in both directions — the
  // target's set before the change and their set after it must BOTH be inside
  // the actor's own — plus two admin-only branches that no capability opens:
  // making somebody an ADMIN, and changing anybody who already is one.
  //
  // So the widening is real and it is the one that was asked for: an exec may be
  // given the ability to make somebody a varsity trainer without also being made
  // an admin. It cannot be given the ability to make an admin.
  'players.consoleaccess.write',

  // THE SECOND WRITE ON THIS LIST, and it is here for the same structural
  // reason: a capability outside this ceiling cannot be granted, cannot be put
  // in a baseline and is not even RENDERED by either editor, so leaving it out
  // would make "admin-only" mean "admin-only forever" rather than "not handed
  // out by default".
  //

  // THE KEYS TO SWITCHED-OFF FEATURES, one per club feature switch. Here rather
  // than in EXEC_ASSIGNABLE because that list is the historic transcription,
  // pinned literally and partitioned exactly by the four VP roles, and none of
  // these was ever exec work: they are handed to one person at a time, which is
  // what a ceiling entry is for. Reads, not writes: they let the holder in, and
  // every act inside is still gated by its own capability or by the member's
  // own permissions.
  //
  // SPREAD FROM THE REGISTRY, which is the one place this ceiling moves without
  // a line being typed here. It still does not move unreviewed: the literal list
  // of what this ceiling adds, in editable-roles.test.ts, fails until the new
  // key is written into it.
  ...FEATURE_ACCESS_CAPABILITIES,
];

// DELIBERATELY STILL OUT OF REACH, and each for its own reason:
//
//   * `permissions.write` / `permissions.page` — a role that could be edited to
//     contain these would make "pick Finance from a dropdown" hand over the
//     ability to hand out permissions. Closure bounds the holder to their own
//     set, so it is not unbounded escalation; it is still the single most
//     consequential capability there is, and it must be a per-person act.
//   * `players.privilegedfields.write` — the grantable EDGE of the hard floor
//     (player-field-access.ts). Every field on the floor is still unreachable
//     THROUGH updatePlayer(), which is where that guard stands and which has not
//     moved; this is the nearest thing to it and stays a per-person grant.
//
//     `players.consoleaccess.write` is the one capability that reaches three of
//     those columns, and it is offerable above. It does NOT weaken this line: it
//     opens role/is_exec/is_trainer in ONE action, setConsoleAccess, which
//     closure-checks the target's set on both sides and still refuses the admin
//     level outright. Nor does it widen the Edit dialog — that dialog no longer
//     offers console access to anybody, and updatePlayer refuses the three
//     columns outright, so setConsoleAccess is the only editing path there is.
//   * `players.remove.write` / `players.merge.write` / `players.deletion.cancel.write`
//     / `players.reliability.write` — destructive or identity-altering roster
//     work that stood behind getAdminPlayer().
//   * `seasons.fees.write`, `tournaments.fees.*`, every remaining `fees.*.write`
//     — setting or moving money.
//   * `challenges.*`, `walkovers.*`, `disputes.*`, `legal.documents.write`,
//     `legal.waivertemplate.write`, `audit.page`, `ratings.page`,
//     `accounts.*`, `platform.*` — admin work today, unasked for, and each its
//     own small reviewable diff when it is wanted.
//
//     `accounts.*` IS ON THAT LINE DELIBERATELY, INCLUDING THE DATA API'S KEYS,
//     and the reason is not the page. Opening the page alone really would hand
//     over nothing else: /accounts asks three capabilities INDEPENDENTLY, where
//     `accounts.page` opens the route, `permissions.page` buys the officer data
//     (names, emails, last sign-ins, the access audit trail) and
//     `platform.page` buys the settings form, and the two withheld halves SKIP
//     THEIR FETCHES rather than hiding rendered output. The page is safe.
//
//     THE KEY IS NOT. A minted data API key is a bearer credential that reads
//     the club's player and rating data from outside every gate in this file:
//     no session, no `permission_grants`, no audit row per read, and it keeps
//     working until somebody revokes it. Every other capability an exec may be
//     assigned acts INSIDE the console, where the actor is known and the act is
//     logged. Minting is the one that manufactures access which outlives the
//     grant: revoke the exec's console tomorrow and the key they minted still
//     answers. That asymmetry, not the sensitivity of the data, is why the
//     three key capabilities stay admin-only. The strings live in CAPABILITIES
//     so the panel can gate on them and an admin still holds them by level;
//     they are simply not assignable to anybody else.
//
//     IF THE CLUB WANTS AN EXEC RUNNING THE KEYS, that is a one-line change
//     here plus the ceiling below, and it should be made as its own reviewable
//     diff with the owner saying so, exactly the way this line promises.

// WHAT AN EXEC MAY BE COMPOSED UP TO — the 73 capabilities EXEC_BASELINE used
// to hold before it became read-only.
//
// This list is not a grant. Nobody holds it by default; it is the set an admin
// may ASSIGN, whether through one of the four VP roles or an explicit grant on
// one person. It is the old transcription, preserved verbatim: what `is_exec`
// could do the day composition shipped, checked entry by entry against the gate
// that used to stand at each call site.
//
// IT HAD TO BECOME ITS OWN CONSTANT the moment the baseline narrowed. While
// EDITOR_OFFERABLE spread EXEC_BASELINE, the floor and the ceiling were the same
// list, so making officers read-only by default ALSO made those writes
// unassignable — every VP role would have exceeded the ceiling and been refused,
// and the very mechanism the narrowing depends on would have stopped working.
// Floor and ceiling are different questions and now have different answers.
export const EXEC_ASSIGNABLE: readonly Capability[] = [
  'players.page',
  'players.read',
  'players.approve.write',
  'players.create.write',
  'players.update.write',
  'players.waiver.resign.write',
  'players.ban.write',
  'players.reinstate.write',
  'players.editor.varsitynotes.write',
  'seasons.page',
  'seasons.create.write',
  'seasons.activate.write',
  'seasons.end.write',
  'sessions.page',
  'sessions.reminders.write',
  'sessions.create.write',
  'sessions.update.write',
  'sessions.archive.write',
  'sessions.checkin.token.write',
  'sessions.attendance.write',
  'sessions.delete.write',
  'matches.page',
  'matches.void.write',
  'matches.convert.write',
  'matches.create.write',
  'announcements.page',
  'announcements.create.write',
  'announcements.update.write',
  'announcements.delete.write',
  // VP External's, by the owner's decision — see the capability's own comment
  // above and the re-seed in 00224. Listed here rather than in
  // OFFERABLE_BEYOND_EXEC because EDITOR_OFFERABLE is the union of the two and
  // a string in both would be a duplicate the invariants reject.
  'announcements.discord.write',
  'tournaments.page',
  'tournaments.manage.create.write',
  'tournaments.manage.update.write',
  'tournaments.manage.status.write',
  'tournaments.manage.suspend.write',
  'tournaments.manage.resume.write',
  'tournaments.manage.archive.write',
  'tournaments.manage.delete.write',
  'tournaments.manage.event.create.write',
  'tournaments.manage.event.update.write',
  'tournaments.manage.event.delete.write',
  'tournaments.manage.event.status.write',
  'tournaments.draw.participants.add.write',
  'tournaments.draw.participants.remove.write',
  'tournaments.draw.checkin.token.write',
  'tournaments.draw.checkin.mark.write',
  'tournaments.draw.noshow.write',
  'tournaments.draw.exit.write',
  'tournaments.draw.pairs.add.write',
  'tournaments.draw.pairs.remove.write',
  'tournaments.draw.seed.set.write',
  'tournaments.draw.seed.auto.write',
  'tournaments.draw.seed.clear.write',
  'tournaments.draw.generate.write',
  'tournaments.draw.lock.write',
  'tournaments.draw.unlock.write',
  'tournaments.draw.waivers.read',
  'tournaments.draw.entrycounts.read',
  'tournaments.results.enter.write',
  'tournaments.results.walkover.write',
  'tournaments.results.void.write',
  'tournaments.results.unvoid.write',
  'tournaments.results.undo.write',
  'tournaments.results.edit.write',
  'tournaments.results.entry.write',
  'tournaments.results.doublenoshow.write',
  'tournaments.results.bonuses.write',
  'tournaments.results.standings.write',
  'tournaments.results.finalize.write',
  'fees.page',
  'fees.expenses.read',
  'fees.expenses.add.write',
  'legal.page',
  'legal.reacceptance.write',
  // NO `accounts.*` HERE, AND THE OMISSION IS THE DECISION. The data API's
  // three key capabilities exist in CAPABILITIES and an admin holds them by
  // level, but they are not assignable, so no VP role, no custom baseline and
  // no per-person grant can reach them. A key outlives the grant that minted
  // it; the long version of that argument is with the withheld list above.
  //
  // Leaving them out is also what keeps the four VP roles partitioning this
  // list exactly, which is the arithmetic the partition test asserts.
];

export const EDITOR_OFFERABLE: readonly Capability[] = [
  ...EXEC_ASSIGNABLE,
  ...OFFERABLE_BEYOND_EXEC,
];

// ---------------------------------------------------------------------------
// CUSTOM BASELINES — the ones the club writes for itself
// ---------------------------------------------------------------------------
// ROLE_DEFAULTS is four VP jobs in a compile-time constant, so a fifth is a
// deploy, and the club owner asked for more: "I should be able to create new
// baselines, since we will have others."
//
// A CUSTOM BASELINE IS A NAMED CAPABILITY SET IN THE DATABASE
// (permission_baselines, 00093) THAT IS COPIED ONTO A ROW, NOT RESOLVED
// THROUGH. Assigning one writes permission_role = 'custom' — the empty base —
// and its capabilities into permission_grants. resolvePermissions() is
// untouched by this feature and does not know the table exists.
//
// THAT IS THE ANSWER TO THE CRUX, and the crux is real: the resolver is pure
// and synchronous and is reached from 22 places in the admin app. Passing the
// baseline in as a fourth argument would mean finding all 22, and a call site
// that forgot would resolve a person's entire base to nothing — safe, but
// silently so, in twenty-two places, including the edge middleware where the
// lookup would also become a per-request round trip.
//
// WHAT IS GIVEN UP: a baseline is a TEMPLATE PLUS EXPLICIT PROPAGATION rather
// than a live reference. Editing one re-copies to every holder inside the same
// action, each write closure-checked and audited — which is more traceable than
// ROLE_DEFAULTS, where changing what 'finance' means leaves no row anywhere.
//
// NOTHING BELOW IS A SECOND RESOLVER. These are the rules a stored set must
// satisfy to be worth storing, and every one of them is a rule the assignment
// path already enforces per person; they are here so a baseline is refused when
// it is WRITTEN rather than silently doing nothing when it is USED.

/**
 * A named capability set as the console reads it back.
 *
 * `builtinRole` NAMES ONE OF THE FOUR VP JOBS THIS ROW SHIPPED AS, or null for
 * one the club wrote itself. See BUILTIN_BASELINE_IDS below for why the four are
 * rows at all.
 */
export type CustomBaseline = {
  id: string;
  name: string;
  capabilities: readonly Capability[];
  builtinRole: PermissionRole | null;
};

// ---------------------------------------------------------------------------
// THE FOUR VP JOBS, AS EDITABLE ROWS
// ---------------------------------------------------------------------------
// THE OWNER ASKED TO "edit the permissions of each preassigned role beforehand",
// and the immediate case was Finance seeing money IN as well as out. Today that
// is a developer editing ROLE_DEFAULTS, a deploy, and two structural tests to
// unpick. It should be a screen.
//
// SO A BUILT-IN ROLE IS A SEEDED ROW IN permission_baselines (00104), AND
// ROLE_DEFAULTS IS ITS SEED RATHER THAN THE RUNTIME ANSWER.
//
// THAT CHOICE IS THE WHOLE DESIGN, and it is 00093's choice applied a second
// time. resolvePermissions() is pure, synchronous and reached from 22 places; a
// role whose contents live in a table cannot be looked up from inside it, and
// passing them in as a fourth argument means 22 call sites where forgetting
// resolves somebody's entire base to nothing. So the row carries the answer:
// assigning an edited Finance writes permission_role = 'custom' (the empty base)
// and copies the capabilities into permission_grants, exactly as a club-written
// baseline does. THE RESOLVER IS NOT TOUCHED BY THIS FEATURE — not one line.
//
// WHAT THAT BUYS, AND IT IS THE REASON TO PREFER IT: ROLE_DEFAULTS STOPS BEING
// EDITED, SO ITS TWO STRUCTURAL INVARIANTS SURVIVE LITERALLY. Every role is
// still inside EXEC_ASSIGNABLE, and the four still partition it exactly, because
// the constant is now a frozen transcription of what shipped and the club's
// edits land in the table instead. The partition test was expected to die; it
// does not, and that is the strongest evidence this is the right shape. (Both
// invariants named EXEC_BASELINE until that constant narrowed to a read-only
// floor; the historic set they have always meant is EXEC_ASSIGNABLE.)
//
// The security property those tests carried moves to WRITE TIME, where it now
// has to be: baselineCapabilityRefusal() closure-checks an edit against the
// editor's own set and caps it at EDITOR_OFFERABLE, on every path that writes
// the table. A test could only ever pin a constant; this bounds an edit the club
// makes at runtime, which is the thing that actually needs bounding.
//
// FIXED UUIDS, NOT LOOKUP BY NAME. The rows are renameable — 'Finance' may
// become 'Treasurer' — so a name is not an identity. These constants are what
// the seed writes, what "reset to shipped default" finds, and what refuses a
// delete; they must stay byte-identical to 00104's INSERT, pinned by a test.
export const BUILTIN_BASELINE_IDS: Record<
  Exclude<PermissionRole, 'custom'>,
  string
> = {
  finance: '5eed0060-0000-4000-8000-000000000101',
  tournaments: '5eed0060-0000-4000-8000-000000000102',
  internal: '5eed0060-0000-4000-8000-000000000103',
  external: '5eed0060-0000-4000-8000-000000000104',
};

/** The four VP jobs — every PermissionRole except the empty base. */
export const BUILTIN_PERMISSION_ROLES: readonly Exclude<PermissionRole, 'custom'>[] = [
  'finance',
  'tournaments',
  'internal',
  'external',
] as const;

/** Is this stored string one of the four jobs that ships with a value? */
export function isBuiltinPermissionRole(
  value: unknown,
): value is Exclude<PermissionRole, 'custom'> {
  return (BUILTIN_PERMISSION_ROLES as readonly string[]).includes(value as string);
}

/**
 * What a built-in role SHIPPED as — the target of "reset to shipped default".
 *
 * Reads ROLE_DEFAULTS, which is exactly what that constant is for now: it is no
 * longer consulted to decide what an edited role means, only to say what it
 * meant on the day it shipped.
 */
export function shippedDefaultFor(
  role: Exclude<PermissionRole, 'custom'>,
): readonly Capability[] {
  return ROLE_DEFAULTS[role];
}

/** Matches the length CHECK on permission_baselines.name. */
export const BASELINE_NAME_MAX = 40;

/**
 * Why this cannot be a baseline name, or null.
 *
 * Uniqueness is NOT here: it is a question about the other rows, answered by
 * permission_baselines_name_key and reported by the action that met it.
 */
export function baselineNameRefusal(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'A baseline needs a name.';
  if (trimmed.length > BASELINE_NAME_MAX) {
    return `A baseline name is at most ${BASELINE_NAME_MAX} characters.`;
  }
  return null;
}

/**
 * Why these capabilities cannot be a baseline, or null. Four rules, in the same
 * order setPlayerPermissions applies its equivalents.
 *
 * `held` IS THE AUTHOR'S OWN RESOLVED SET, and passing it in is what makes this
 * usable on both sides of the boundary without being the boundary. The server
 * action derives it from the actor's row through effectiveCapabilities(), which
 * is the single source of truth for grant closure; the editor passes the copy
 * the server already sent it, to refuse early. A caller who passed something
 * else would be checking a number it chose — which is exactly why the server
 * never takes this from the client.
 */
export function baselineCapabilityRefusal(
  capabilities: readonly string[],
  held: ReadonlySet<Capability>,
): string | null {
  const unknown = capabilities.filter((capability) => !isCapability(capability));
  if (unknown.length > 0) {
    return `Not something this console knows about: ${unknown.join(', ')}`;
  }
  const wanted = [...new Set(capabilities as readonly Capability[])];
  if (wanted.length === 0) {
    return 'A baseline needs at least one capability, or it is a name that does nothing.';
  }

  // GRANT CLOSURE, at authoring time. Without this an officer with a narrow
  // permissions.write could WRITE DOWN a baseline naming capabilities they do
  // not hold. Assigning it would be refused — setPlayerPermissions checks the
  // actor's set again, per person — so it is not an escalation; it is a saved,
  // named, unassignable thing, and the person who saved it has no way to tell
  // why. Refuse it where it is authored, in the same words.
  const cannotHold = wanted.filter((capability) => !held.has(capability));
  if (cannotHold.length > 0) {
    return `You cannot put ${cannotHold.join(', ')} in a baseline because you do not hold ${cannotHold.length === 1 ? 'it' : 'them'}.`;
  }

  // THE SAME CEILING THE EDITOR HAS. Closure cannot bound an admin, who holds
  // everything by level, so without this an admin could author a baseline
  // containing permissions.write — and then meet check 5 of
  // setPlayerPermissions every time they tried to assign it.
  const offerable = new Set<Capability>(EDITOR_OFFERABLE);
  const notOfferable = wanted.filter((capability) => !offerable.has(capability));
  if (notOfferable.length > 0) {
    return `${notOfferable.join(', ')} cannot be handed out yet — ${notOfferable.length === 1 ? 'it is' : 'they are'} admin-only.`;
  }

  // THE RESOLVER'S ONE STRUCTURAL INVARIANT, applied to the stored array.
  //
  // Expressible here, unlike on a player row, because a baseline has no revokes
  // and no base underneath it: the array IS the resolved set. Without this a
  // baseline of ['fees.expenses.add.write'] saves, assigns, audits — and
  // resolves to nothing at all, because the resolver prunes every capability
  // whose area page is absent.
  //
  // REFUSED RATHER THAN REPAIRED. Adding the missing page for the author would
  // be resolve-time implication by another name: a capability arriving in a set
  // somebody reviewed, without them reviewing it.
  const present = new Set(wanted);
  const missingPages = [
    ...new Set(wanted.map(pageOf).filter((page) => !present.has(page))),
  ];
  if (missingPages.length > 0) {
    return `Add ${missingPages.join(', ')} — nothing in an area applies without that area's page.`;
  }

  return null;
}

/** The array as it would be STORED: de-duplicated and sorted. */
export function normaliseBaselineCapabilities(
  capabilities: readonly Capability[],
): Capability[] {
  return [...new Set(capabilities)].sort();
}

// ---------------------------------------------------------------------------
// PERMISSIONS
// ---------------------------------------------------------------------------
// A TAGGED UNION so "unrestricted" can never be mistaken for "empty". The two
// mean opposite things — one is everything the level has always had, the other
// is nothing at all — and a bare Set<Capability> would spell them the same way
// the moment someone forgot to distinguish them.
export type Permissions =
  | { kind: 'unrestricted' }
  | { kind: 'restricted'; capabilities: ReadonlySet<Capability> };

/** The state every row is in until an admin composes one. Shared, frozen. */
export const UNRESTRICTED: Permissions = Object.freeze({ kind: 'unrestricted' as const });

/** Where the resolved permission triple is stored on a player row. */
export type PermissionsInput = {
  permission_role?: string | null;
  permission_grants?: string[] | null;
  permission_revokes?: string[] | null;
};

/**
 * Turn the stored triple into a set.
 *
 * THE LEVEL IS AN ARGUMENT NOW, AND IT USED TO SAY IN THIS DOCBLOCK THAT IT
 * NEVER WOULD BE. The club owner's ruling is "baseline is the baseline, unless i
 * manually remove it all roles should have the baseline" — the level's baseline
 * is a FLOOR under every composition rather than an alternative to one. A floor
 * is by definition level-dependent (a trainer must not inherit an exec's reads),
 * so the level has to reach the one function that builds the set.
 *
 * REQUIRED, AND FIRST, rather than optional. Optional would mean a call site
 * that forgot it resolved somebody NARROWER than every other call site did —
 * fail-closed, but a middleware that refuses a page the server action would
 * serve is still a console that appears broken, and it would be invisible in
 * review. Required makes the compiler enumerate every caller. First, because
 * permits() and effectiveCapabilities() already take the level first and three
 * functions with the same argument in three positions is its own hazard.
 *
 * ORDER IS THE WHOLE DESIGN, and there are now four steps rather than three:
 *
 *   floor  →  role defaults  →  grants  →  REVOKES  →  page invariant
 *
 * THE FLOOR GOES IN BEFORE THE REVOKES, and that is the sharp edge of the
 * owner's sentence: "unless i manually remove it". Unioning the baseline in
 * afterwards — inside effectiveCapabilities, say, which is where the level
 * already enters and where it would have cost no call-site churn at all — would
 * silently RESURRECT every deliberately revoked read. That is the one mechanism
 * an admin has for narrowing somebody below the floor, it would fail with the
 * revoke still displayed as saved in the editor, and it is a security regression
 * rather than a bug. Merged here, a revoke removes the floor's copy like any
 * other, and `takes every capability in an area with that area's page` in
 * capabilities.test.ts is the assertion that proves this ordering rather than
 * the other one.
 *
 * Pruning still runs last. Pruning before subtraction would let a revoked page
 * keep the section it was supposed to close.
 */
export function resolvePermissions(
  level: AccessLevel | null | undefined,
  role: string | null | undefined,
  grants: readonly string[],
  revokes: readonly string[],
): Permissions {
  // Not narrowed, and not COMPOSED either. The deltas are deliberately NOT
  // consulted: if an absent role meant an empty base, adding the first grant to
  // an unrestricted exec would flip their base from the whole exec baseline to
  // zero — a grant that removes fifty-odd capabilities, one click, silent, in
  // exactly the direction this feature exists to control.
  if (role == null || role === '') return UNRESTRICTED;

  // An unrecognised role gets NO defaults rather than the exec baseline. The
  // safe reading of a role nobody can interpret is "grants nothing".
  const base = (ROLE_DEFAULTS as Record<string, readonly Capability[]>)[role] ?? [];

  const effective = new Set<Capability>();

  // THE FLOOR. `BASELINES[level]`, never EXEC_BASELINE unconditionally: a
  // varsity trainer composed onto the tournaments job must not inherit an exec's
  // eight section pages, and hard-coding the exec floor is how that would
  // happen without anybody noticing, since the exec case is the one everybody
  // tests.
  //
  // ADMIN IS EXCLUDED, and not as a special case for tidiness. BASELINES.admin
  // is ALL_CAPABILITIES — a LEVEL SHORT-CIRCUIT written as a set, not a floor
  // anybody was granted. Merging it would make this function answer 119 for a
  // composition that cannot exist: both write paths refuse an admin target
  // outright (isAdminActor in setPlayerPermissions and setConsoleAccess), and
  // effectiveCapabilities short-circuits on the level before consulting any set,
  // so the only thing such a value could do is mislead an editor preview.
  if (level === 'exec' || level === 'trainer') {
    for (const cap of BASELINES[level]) effective.add(cap);
  }

  for (const cap of base) effective.add(cap);
  // Intersecting with the vocabulary as we go: an element naming a capability
  // this build no longer has is dropped, inert rather than a member nothing
  // reads.
  for (const cap of grants) if (isCapability(cap)) effective.add(cap);
  // REVOKE BEATS GRANT, AND REVOKE BEATS THE FLOOR. Disjointness is a database
  // CHECK, but the resolver has to be total — a row that somehow holds both must
  // have one clear answer.
  for (const cap of revokes) if (isCapability(cap)) effective.delete(cap);

  // THE ONE STRUCTURAL INVARIANT: every capability in an area requires that
  // area's page. Applied AFTER subtraction, and that order is the whole reason
  // it is here rather than in a CHECK — revoking `fees.page` has to take the
  // ledgers and the ledger controls with it even when they came from the FLOOR
  // or the ROLE and are named nowhere in either array. Closing a section has to
  // close it.
  //
  // WHAT IT IS FOR CHANGED WHEN THE FLOOR ARRIVED, and pretending otherwise
  // would leave a comment that reads true and is not. The exec floor carries all
  // eight section pages, so for an exec NO GRANT IS PRUNED ANY MORE: there is no
  // area they hold a capability in and cannot open. That is the owner's ruling
  // working as intended rather than the invariant being defeated — "everyone can
  // read things" is precisely the statement that every section page is held.
  //
  // TWO JOBS SURVIVE, and both are real:
  //
  //   * THE REVOKE CASCADE, which is now the main one. Revoking an area's page
  //     is how an admin closes a section for somebody who holds it by floor, and
  //     everything they had in that area goes with it in the same act. Without
  //     this loop a revoked `fees.page` would leave the ledger standing behind a
  //     door that had just been shut.
  //   * THE TRAINER CASE, where it still prunes in the original direction. A
  //     trainer's floor is the roster and nothing else, so a grant in any other
  //     area without its page is pruned exactly as it always was.
  //
  // THIS REPLACES `write ⊆ read`, which is GONE and must not come back. Write
  // without read is now a supported state — the club owner asked for people who
  // can "access the page to add stuff, but not see the details in them", and the
  // old rule made exactly that impossible. It was also broken: it looked for an
  // exact sibling by swapping `.write` for `.read` at the same path, which only
  // two of the ninety-three writes had, so it fired for two and silently did
  // nothing for ninety-one. This one is a first-segment lookup, so it fires for
  // every capability there is.
  for (const cap of Array.from(effective)) {
    const page = pageOf(cap);
    if (cap === page) continue;
    if (!effective.has(page)) effective.delete(cap);
  }

  return { kind: 'restricted', capabilities: effective };
}

/**
 * Read the triple off a player row.
 *
 * ALL THREE COLUMNS ABSENT means unrestricted, and it is the first line on
 * purpose: this is the heir of `portfolioOf({}) === null`, and it is what makes
 * the code safe to deploy before the storage migration is applied. Treating a
 * missing column as "unknown, deny" would lock every exec out of the console the
 * moment this shipped.
 *
 * A ROLE WITH A MISSING ARRAY THROWS. The columns are NOT NULL, so this can only
 * come from a narrowed SELECT — a programming error, not a state. The obvious
 * `?? []` would silently discard revokes, and a discarded revoke can leave
 * somebody holding permissions.write.
 *
 * THE LEVEL IS AN ARGUMENT, PASSED THROUGH TO THE FLOOR. It is required, and it
 * is deliberately NOT derived from the row even though nearly every caller hands
 * this function a row that carries `role`/`is_exec`/`is_trainer` and would let
 * accessLevelFor() answer for free. The exception is what decides it: the SIDEBAR
 * resolves a bare TRIPLE that crossed the server/client boundary through
 * permissionTripleOf(), and that object has no level markers on it at all. Row
 * derivation would have silently floored the client on nothing while every
 * server action floored on twelve — a nav that hides sections the page will
 * happily serve, which is the exact server/client disagreement this pair of
 * functions exists to prevent. An explicit parameter makes the sidebar pass the
 * level it already holds, and makes the compiler say so everywhere else.
 */
export function permissionsOf(
  level: AccessLevel | null | undefined,
  player: PermissionsInput | null | undefined,
): Permissions {
  if (!player) return UNRESTRICTED;
  const hasRole = 'permission_role' in player;
  const hasGrants = 'permission_grants' in player;
  const hasRevokes = 'permission_revokes' in player;
  if (!hasRole && !hasGrants && !hasRevokes) return UNRESTRICTED;

  const role = player.permission_role ?? null;
  if (role === null || role === '') return UNRESTRICTED;

  if (!hasGrants || !hasRevokes) {
    throw new Error(
      'permissionsOf: player row has permission_role but not both delta columns — narrow the SELECT less',
    );
  }
  return resolvePermissions(
    level,
    role,
    player.permission_grants ?? [],
    player.permission_revokes ?? [],
  );
}

/**
 * The stored triple as a plain object, or null for a row that predates the
 * storage migration.
 *
 * Exists because a resolved `Permissions` cannot cross the server/client
 * boundary: its payload is a Set, and the thing a server component hands a
 * client component has to be plain data. So the SERVER sends the same three
 * columns the database holds and the CLIENT calls permissionsOf() on them —
 * one resolver, run twice, rather than a second wire format that could
 * disagree with it.
 *
 * Returning null rather than an empty triple keeps the "columns absent means
 * unrestricted" reading intact across that boundary: an empty triple would
 * resolve identically today, but it says "this row is not narrowed" where null
 * says "this build has not been told", and only the second one stays true if
 * the meaning of an empty triple ever changes.
 */
export function permissionTripleOf(
  player: PermissionsInput | null | undefined,
): PermissionsInput | null {
  if (!player) return null;
  if (
    !('permission_role' in player)
    && !('permission_grants' in player)
    && !('permission_revokes' in player)
  ) {
    return null;
  }
  // Validated by the resolver rather than by a `?? []` here. A role with a
  // missing delta column throws, and it has to throw on this path too:
  // serialising it as an empty array would discard a revoke on the way to the
  // client, which is the one direction this model must never fail in.
  //
  // THE LEVEL IS `null` BECAUSE THE RESULT IS DISCARDED. This call is run for
  // its throw and nothing else — what crosses the wire is the three columns
  // below, unresolved, and the CLIENT applies the floor when it resolves them
  // with the level the layout sent alongside. Passing a level here would compute
  // a set nobody reads, and passing the WRONG one would be a bug that never
  // showed up because the value is thrown away.
  permissionsOf(null, player);
  return {
    permission_role: player.permission_role ?? null,
    permission_grants: player.permission_grants ?? [],
    permission_revokes: player.permission_revokes ?? [],
  };
}

const EMPTY_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>();

/**
 * Everything this person may do. permits() is defined in terms of this so the
 * gates and the "effective access" the editor shows can never be two
 * implementations that disagree.
 */
export function effectiveCapabilities(
  level: AccessLevel | null | undefined,
  permissions: Permissions,
): ReadonlySet<Capability> {
  if (!level) return EMPTY_CAPABILITIES;
  if (level === 'admin') return ALL_CAPABILITIES;
  if (permissions.kind === 'unrestricted') return BASELINES[level];
  return permissions.capabilities;
}

/**
 * The one authorisation question. Plain set membership — no prefix implication,
 * no ladder logic, and no minimum level: a trainer calling
 * tournaments.manage.create.write fails because it is not in TRAINER_BASELINE,
 * not because a rung was compared.
 */
export function permits(
  level: AccessLevel | null | undefined,
  permissions: Permissions,
  capability: Capability,
): boolean {
  return effectiveCapabilities(level, permissions).has(capability);
}

/** Standing is a separate question from level — see isInGoodStanding. */
export type StandingInput = {
  is_banned?: boolean | null;
  status?: string | null;
  active_flag?: boolean | null;
};

// The HIGHEST level the markers grant, so they compose: someone who is both a
// trainer and an exec is simply an exec, and a trainer who is also an admin is
// an admin. A restriction always applies to the level a person resolves TO,
// never to a flag in isolation.
//
// This answers "what level do these markers grant" and nothing else. It does
// NOT check standing — see hasConsoleAccess for the gate a UI should use.
export function accessLevelFor(player: AccessLevelInput | null | undefined): AccessLevel | null {
  if (!player) return null;
  if (player.role === 'admin') return 'admin';
  if (player.is_exec === true) return 'exec';
  if (player.is_trainer === true) return 'trainer';
  return null;
}

// Standing gate, mirroring admin_access_level() in migration 00057 and the
// checks in the admin app's getAuthenticatedAtLeast(). A banned, suspended,
// pending or deactivated account holds no console level at all.
//
// COALESCE semantics matter: a row that is missing is_banned/active_flag (a
// narrowed select) must read as "not banned, still active" exactly as the SQL
// does, or a partial select silently locks someone out.
export function isInGoodStanding(player: StandingInput | null | undefined): boolean {
  if (!player) return false;
  if (player.is_banned === true) return false;
  if (player.status === 'suspended' || player.status === 'pending_approval') return false;
  if (player.active_flag === false) return false;
  return true;
}

// Standing FIRST, then level — the composition the console actually enforces.
// Use this to decide whether to SHOW a route into the console; the server-side
// gates (admin_access_level() in the middleware, requireCapability() in server
// actions) remain the security boundary.
export function consoleAccessLevelFor(
  player: (AccessLevelInput & StandingInput) | null | undefined,
): AccessLevel | null {
  if (!isInGoodStanding(player)) return null;
  return accessLevelFor(player);
}

/** Any console access at all, standing included. */
export function hasConsoleAccess(
  player: (AccessLevelInput & StandingInput) | null | undefined,
): boolean {
  return consoleAccessLevelFor(player) !== null;
}

/**
 * The switched-off club features this person may still open and use: the ones
 * whose `page.access.<id>` key they hold. The members' app asks this for its
 * page gate, its nav and its actions, with the same resolver the console uses.
 *
 * STANDING FIRST, exactly as the console: a banned exec holds nothing here.
 *
 * FAILS CLOSED, the opposite of a failed switch read, and on purpose. The
 * feature is off; not letting somebody in is the state the club chose. So a row
 * the resolver throws on (a role with a missing delta column) is logged and
 * treated as holding no key at all.
 */
export function featureAccessFor(
  player: (AccessLevelInput & StandingInput & PermissionsInput) | null | undefined,
): FeatureId[] {
  const level = consoleAccessLevelFor(player);
  if (level === null) return [];
  let held: ReadonlySet<Capability>;
  try {
    held = effectiveCapabilities(level, permissionsOf(level, player));
  } catch (err) {
    console.error('[features] could not resolve switched-off feature access, treating as none:', err);
    return [];
  }
  return FEATURES.filter((feature) => held.has(featureAccessCapability(feature.id))).map(
    (feature) => feature.id,
  );
}
