import { describe, it, expect } from 'vitest';
import {
  AREAS,
  CAPABILITIES,
  EDITOR_OFFERABLE,
  EXEC_ASSIGNABLE,
  EXEC_BASELINE,
  FEATURE_ACCESS_CAPABILITIES,
  TRAINER_BASELINE,
  PERMISSION_ROLES,
  ROLE_DEFAULTS,
  UNRESTRICTED,
  effectiveCapabilities,
  featureAccessFor,
  isCapability,
  pageOf,
  permits,
  permissionsOf,
  permissionTripleOf,
  resolvePermissions,
  type Capability,
} from '../access-level';
import { CAPABILITY_GATES, ENFORCEMENT_POINTS } from '../capability-gates';
import { FEATURES } from '../features';

// 139 capabilities is 139 promises that something is enforced. This suite is
// what keeps the vocabulary closed: it pins the list literally, refuses the
// shapes that would let one capability quietly imply another, and asserts that
// every one of them names a place in the app that reads it.

const resourceOf = (capability: string) => capability.split('.').slice(0, -1);
const modeOf = (capability: string) => capability.split('.').at(-1)!;
// The one area whose names do not end in a mode. See the `page` entry at the
// end of CAPABILITIES; every grammar test below states its exception for this
// area by name rather than loosening the rule for all of them.
const inPageArea = (capability: string) => capability.split('.')[0] === 'page';

describe('the capability vocabulary', () => {
  // 119 BECAME 120 with `announcements.discord.write` — the console's half of
  // the bot's /say. It is a new capability rather than a reuse of
  // `announcements.create.write` because it reaches a different audience by a
  // different route: a member who never opens the website is in that channel,
  // and nothing the console offers can take a posted Discord message back the
  // way unpublishing takes an announcement down.
  //
  // It is NOT a new AREA, and the test below is why that matters — a `discord`
  // area would need a `discord.page`, and there is no Discord page to open.
  //
  // 120 BECAME 121 with `players.discordlink.write`, the console attaching a
  // Discord account to a member without the member. A new capability rather
  // than a reuse of `players.merge.write`, which is the nearest neighbour:
  // merging folds two roster rows into a single member, while this attaches an
  // EXTERNAL identity to a roster row that is already whole. No column on
  // `players` moves and the row it writes lives in a table of its own.
  //
  // Not a new area either, for the reason the entry above is not: a `discord`
  // area would need a `discord.page`, and this panel lives on the member page
  // behind that page's key.
  //
  // 121 BECAME 124 with the read-only external data API's keys, which are
  // minted and revoked from a panel on /accounts: `accounts.apikey.read`,
  // `accounts.apikey.mint.write` and `accounts.apikey.revoke.write`. Three
  // rather than one because seeing which keys exist, handing one out and taking
  // one back are three different questions, and the club wants somebody who may
  // do the first and not the second.
  //
  // THE NAMES ARE LONGER THAN THE ONES ASKED FOR because of the test two blocks
  // below: every capability ends in `page`, `read` or `write`, so the requested
  // `accounts.apikey.mint` and `accounts.apikey.delete` are not strings this
  // vocabulary can hold. The verb moved one segment left, which is what
  // `fees.expenses.add.write` and `fees.expenses.remove.write` already do, and
  // `revoke` is the act rather than a synonym for delete: the row is kept with
  // `revoked_at` set so the audit trail survives the key.
  //
  // Not a new area, for the reason the two entries above are not: the panel
  // lives on /accounts and sits behind that page's key.
  //
  // 124 BECAME 131 with the seven `page.access.<feature id>` keys, one per club
  // feature switch: the club owner's "build a permission node for access to a
  // restricted page". They replaced 47fc75e7's rule that anybody with console
  // access could open a switched-off feature, so being let into tournaments
  // before they go live is now a key somebody was handed, and it does not open
  // challenges too.
  //
  // THIS ONE IS A NEW AREA, `page`, and the first whose names the grammar test
  // below does not hold: the owner chose `page.access.<id>`, which ends in the
  // feature id rather than a mode. The area has no `page.page` either; each key
  // is its own page. Both exceptions are stated below for this area alone.
  //
  // DERIVED FROM THE FEATURE REGISTRY, so the count moves when a feature is
  // added. That is on purpose: this literal and the vocabulary migration are
  // the two things a new feature then has to touch.
  //
  // 131 BECAME 139 with club events (00244): the seven admin-only `events.*`
  // strings in the new `events` area, and `page.access.events`, which the
  // registry mints for the new feature switch.
  //
  // 139 BECAME 141 with two more feature switches (00247), `membership` and
  // `socials`, each of which mints its `page.access.<id>` key.
  //
  // 141 BECAME 142 with the guest waivers switch (00254), whose key is
  // `page.access.guest_waivers`.
  //
  // 142 BECAME 144 with the audit log's CSV export (00256): `audit.export.read`
  // and `audit.signins.read`. Two rather than one because running a download
  // and reading the sign-in trail are different questions. The console trail
  // says what an officer DID; the sign-in trail is the identity log, carrying
  // account email addresses and login times for members as well as officers,
  // including accounts with no console access at all. The club's case is
  // somebody who may export the console's edits without being handed that.
  //
  // THERE IS NO THIRD STRING FOR THE PANEL. `audit.page` already decides who
  // opens /audit, and the selector is drawn inside it, so a capability whose
  // only job was to gate a control on a page somebody is already looking at
  // would be a second name for a door that is already shut. Not a new area
  // either: both live under `audit` and sit behind that area's page key.
  //
  // 144 BECAME 145 with the predictions switch (00282), whose key is
  // `page.access.predictions`.
  //
  // 145 BECAME 147 with Club changes (00286): `changelog.page` and
  // `changelog.post.write`, a new area, both admin-only and in no baseline.
  it('is exactly 147 entries, with no duplicates', () => {
    expect(CAPABILITIES.length).toBe(147);
    expect(new Set(CAPABILITIES).size).toBe(147);
  });

  // 16 BECAME 17 with `page`, the keys to switched-off features, and 17
  // BECAME 18 with `events`, club events that are not tournaments, and 18
  // BECAME 19 with `changelog`, the Club changes page (00286).
  it('has 19 areas, every one of them used', () => {
    expect(AREAS.length).toBe(19);
    expect(new Set(AREAS).size).toBe(19);
    for (const area of AREAS) {
      expect(
        CAPABILITIES.some((c) => c.split('.')[0] === area),
        `area ${area} has no capabilities`,
      ).toBe(true);
    }
  });

  it('starts every capability with a declared area', () => {
    const areas = new Set<string>(AREAS);
    for (const capability of CAPABILITIES) {
      expect(areas.has(capability.split('.')[0]!), `${capability} names no area`).toBe(true);
    }
  });

  it('ends every capability in page, read or write, at depth 2 to 5', () => {
    for (const capability of CAPABILITIES) {
      if (inPageArea(capability)) continue;
      const segments = capability.split('.');
      expect(['page', 'read', 'write']).toContain(segments.at(-1));
      expect(segments.length, `${capability} depth`).toBeGreaterThanOrEqual(2);
      expect(segments.length, `${capability} depth`).toBeLessThanOrEqual(5);
      for (const segment of segments) {
        expect(segment, `${capability} segment`).toMatch(/^[a-z0-9]+$/);
      }
    }
  });

  // EXACTLY ONE PAGE PER AREA, AT DEPTH 2. The resolver deletes every capability
  // whose area page is absent from the resolved set, and pageOf() builds that
  // name by taking the first segment and appending '.page' — so an area with no
  // page is an area where nothing can ever be held, and an area with two is a
  // second name for the same door that only one of the two closes.
  //
  // EXCEPT `page`, which has no `page.page`: every key in it is its own page,
  // and pageOf() maps each to itself. Pinned as its own test below.
  it('gives every area exactly one page, and puts it at depth 2', () => {
    for (const area of AREAS) {
      if (area === 'page') continue;
      const pages = CAPABILITIES.filter((c) => c.split('.')[0] === area && modeOf(c) === 'page');
      expect(pages, `area ${area}`).toEqual([`${area}.page`]);
    }
    expect(CAPABILITIES.filter((c) => modeOf(c) === 'page').length).toBe(AREAS.length - 1);
  });

  // THE `page` AREA, IN FULL. Exactly one `page.access.<id>` per club feature,
  // the registry id used verbatim, and nothing else in the area: a feature
  // added to the registry gets its key with no line typed here, and a key with
  // no feature behind it cannot exist.
  it('gives the page area exactly one key per club feature, named by its id', () => {
    const inArea = CAPABILITIES.filter(inPageArea);
    expect([...inArea].sort()).toEqual(FEATURES.map((f) => `page.access.${f.id}`).sort());
    expect([...FEATURE_ACCESS_CAPABILITIES]).toEqual(inArea);
    for (const capability of inArea) {
      const [, access, id] = capability.split('.');
      expect(access, capability).toBe('access');
      // The ids are lower-case with underscores, which is the one character the
      // rest of the vocabulary does not allow.
      expect(id, capability).toMatch(/^[a-z0-9_]+$/);
      expect(capability.split('.').length, capability).toBe(3);
      expect(pageOf(capability), capability).toBe(capability);
    }
  });

  // pageOf() is a first-segment lookup and the resolver's whole invariant rests
  // on it landing on a real capability for every input — including for a page,
  // which must map to itself or the rule would delete every page there is.
  it('maps every capability to its area’s page, and a page to itself', () => {
    for (const capability of CAPABILITIES) {
      const page = pageOf(capability);
      expect(isCapability(page), `${capability} → ${page}`).toBe(true);
      expect(page.split('.')[0]).toBe(capability.split('.')[0]);
      if (modeOf(capability) === 'page' || inPageArea(capability)) expect(page).toBe(capability);
    }
  });

  // NO PREFIX IMPLICATION. Resolve-time implication is how permission systems
  // grant things nobody reviewed: a coarse `players.write` sitting above
  // `players.editor.medicalhistory.write` would reach every holder of it with
  // no diff and no audit row. permits() is plain set membership, so no such
  // implication exists — and this refuses the SHAPE as well, so nobody can
  // reintroduce it by naming a capability that reads like a parent of another.
  //
  // Compared within a mode: `fees.expenses.read` and `fees.expenses.add.write`
  // are a read and a write, which is the ordinary read/write pairing, not a
  // coarse capability over a fine one.
  it('never lets one capability be a prefix of another at the same mode', () => {
    for (const mode of ['page', 'read', 'write']) {
      const paths = CAPABILITIES.filter((c) => modeOf(c) === mode).map(resourceOf);
      for (const a of paths) {
        for (const b of paths) {
          if (a === b) continue;
          const isPrefix = a.length < b.length && a.every((seg, i) => seg === b[i]);
          expect(isPrefix, `${a.join('.')}.${mode} prefixes ${b.join('.')}.${mode}`).toBe(false);
        }
      }
    }
  });

  it('narrows only strings the vocabulary actually has', () => {
    expect(isCapability('players.page')).toBe(true);
    // BACK, AND MEANING SOMETHING ELSE. 00087 pinned `players.read` meaning "may
    // open the roster"; 00088 renamed every stored occurrence of it to
    // `players.page` and dropped it; 00089 reintroduces it meaning "may see the
    // roster data". Safe only because that rename ran first — a survivor from
    // 00087 would have changed meaning underneath its holder.
    expect(isCapability('players.read')).toBe(true);
    expect(isCapability('players.write')).toBe(false);
    expect(isCapability('')).toBe(false);
    expect(isCapability(null)).toBe(false);
    expect(isCapability(42)).toBe(false);
  });
});

describe('CAPABILITY_GATES', () => {
  it('covers every capability and nothing else', () => {
    expect(Object.keys(CAPABILITY_GATES).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('agrees with each capability about its area and mode', () => {
    for (const capability of CAPABILITIES) {
      const entry = CAPABILITY_GATES[capability];
      expect(entry.area, capability).toBe(capability.split('.')[0]);
      // The `page` area's keys are drawn as reads: the editor keeps one page
      // slot per area, and seven page-mode entries would overwrite each other.
      expect(entry.mode, capability).toBe(inPageArea(capability) ? 'read' : modeOf(capability));
      expect(entry.label.length, `${capability} has no label`).toBeGreaterThan(0);
      // A group, where there is one, is the capability's own second segment —
      // it is a real interior node of the path, never a category invented for
      // the editor.
      if (entry.group !== null) expect(entry.group, capability).toBe(capability.split('.')[1]);
    }
  });

  // The count assertion. At one capability per gate this is near one-to-one, so
  // it is a real check rather than documentation: deleting a gate without
  // deleting its capability leaves the editor offering a tick box nothing
  // reads, and that is what this fails on.
  //
  // 134 BECAME 133 when the dead legacy removal was deleted. That is the count
  // moving in the direction this assertion WANTS: a call site went away and its
  // `also` entry went with it, so the map still names only places that exist.
  // The failure it guards against is the opposite one — a site disappearing
  // while the entry claiming it stays. `tournaments.draw.participants.remove.write`
  // itself survives, still gated on removeParticipantFromEvent, and no
  // capability was added or removed there: CAPABILITIES is 121 above, and the
  // one added by `players.consoleaccess.write` is the 134th site — setConsoleAccess,
  // which no other capability claims.
  // 133 BECAME 137 over two changes to the Court Management tab.
  // `tournaments.draw.checkin.mark.write` picked up setMatchReadyForPlayer and
  // setMatchCourt (136), then setMatchLive (137) once it turned out that
  // `tournament_matches.status = 'live'` had no writer anywhere in either app —
  // see 00136. Three new sites, NO new capability and none removed: CAPABILITIES
  // is still 121 above. All three are the desk answering or acting on "are you
  // here", which is why they merged rather than minting keys; the reason is
  // argued in that entry's `merged` prose, which this file's next test requires.
  //
  // Score entry deliberately did NOT join them, even though it now sits on the
  // same tab: tournaments.results.* is a different act by a different person and
  // keeps its own gate.
  // 137 BECAME 138 with `announcements.discord.write`, one capability and one
  // site: queueDiscordMessage. Nothing merged and nothing moved.
  // 138 BECAME 139 with the expense receipt route (00231):
  // app/fees/receipt/[id]/route.ts GET, which signs a short-lived URL for the
  // photo attached to an expense. One new site, NO new capability: CAPABILITIES
  // is still 121 above. It merged into `fees.expenses.read` rather than minting
  // a key because rendering a ledger row and opening its receipt are the same
  // act by the same person, and a separate capability would have meant an admin
  // ticking two boxes to grant one thing. The reason is argued in that entry's
  // `merged` prose, which this file's next test requires.
  // 139 BECAME 142 with `players.discordlink.write`: one capability and THREE
  // sites, the largest single jump in this list, and each one is the same act
  // reached differently. forceLinkDiscordAccount performs it,
  // previewDiscordForceLink is the dry run of it over the same row, and the
  // member page's discord link fetch is the reading of what it has already
  // done. That third one is gated here rather than on `players.read` because
  // the link row is not roster data: whoever may read the roster has no claim
  // by that alone on which Discord account a member holds. The reason they
  // merged is argued in that entry's `merged` prose, which this file's next
  // test requires.
  //
  // 142 BECAME 145 with the data API's three key capabilities, and this is the
  // dullest movement in the list: three new capabilities, one site each, no
  // `also` and nothing merged. The read is the key-list fetch on /accounts and
  // the two writes are the mint and the revoke, each a function of its own.
  // Handing a key out and taking one back are opposite acts and the club may
  // well want one person doing each, so there was never a merge to argue.
  //
  // 145 BECAME 168 with the seven `page.access.*` keys, the first gates in this
  // map that stand in the MEMBERS' app. Each key's gate is the FeatureGate on
  // its pages (7), and sessions, challenges and tournaments also claim every
  // member action that calls assertFeatureOn for them: 4 more for sessions
  // (the /checkin layout and three actions), 6 for challenges and 6 for
  // tournaments, 23 in all. They merged because opening a switched-off feature
  // and using it are one act, argued in the shared `merged` prose. The nav
  // filters and the feed's cards ask the same question for every feature at
  // once, so they are not listed as anybody's site.
  //
  // 168 BECAME 178 with club events: seven `events.*` capabilities with one
  // site each, and `page.access.events`, whose FeatureGate on /events is joined
  // by the sign-up and the withdrawal, merged as SWITCHED_OFF like the rest.
  //
  // 178 BECAME 180 with `page.access.membership` and `page.access.socials`:
  // one FeatureGate each, on /membership and /socials. The footer row, the
  // nav's Discord links and the bot's /socials reply ask the socials question
  // for everybody at once, like the nav filters, so they are not sites.
  //
  // 180 BECAME 183 with guest waivers: `page.access.guest_waivers` has the
  // FeatureGate on /guest-waiver and the signing action, merged as
  // SWITCHED_OFF, and `legal.page` gains the console's list of guest signings,
  // its first `also`.
  //
  // 183 BECAME 185 with photo and video consent (00255): `legal.page` gains the
  // console's consent list, and `players.read` its fetch of the members on it.
  //
  // 185 BECAME 188 with the audit export, and the arithmetic is 1 + 2 rather
  // than 1 + 1. `audit.export.read` is one gate, the route handler's GET.
  // `audit.signins.read` is two: the handler serving that source, and the page
  // deciding whether to offer the type at all. They merge because offering the
  // sign-ins option and serving it are one authority over the same rows, asked
  // once where the control is drawn so it is not drawn, and once at the
  // download so it cannot simply be typed into the URL.
  //
  // 188 BECAME 190 with the members' signatures page: legal.page gains the
  // page and players.read its roster fetch. 190 BECAME 191 with
  // updateDataApiKeyScopes, a second site for accounts.apikey.mint.write.
  //
  // 191 BECAME 193 with repeat challenges (00268): boostMatchRating and
  // updateRepeatChallengeSettings, two new sites and NO new capability. Both
  // merged into `matches.void.write`, because voiding, boosting and the repeat
  // rules all decide how much one confirmed challenge moves two ratings, and
  // because a new capability would have collided with the 1.1.0 vocabulary
  // migrations that redefine the CHECK wholesale. The repeat rules also live in
  // rating_defaults, which /ratings edits under the admin-only
  // `platform.settings.write`; this is the exec's narrower door to three keys.
  //
  // 193 BECAME 195 with category change requests (00279): the approve and the
  // decline, two new sites and NO new capability. Both merged into
  // `tournaments.results.edit.write`, because changing a played team's
  // category decides what head start its recorded scores are judged by, which
  // is what correcting a recorded result decides. Asking and cancelling stay
  // with the category cell's own `tournaments.draw.seed.set.write`.
  //
  // 195 BECAME 196 with the predictions switch (00282). It has no page, so its
  // key is enforced by predictionsVisible in the members' lib/predictions.ts,
  // which every prediction card asks, rather than by a FeatureGate.
  //
  // 196 BECAME 202 with Club changes (00286): the page, postClubChanges, and
  // the four actions merged into `changelog.post.write` (add, reword and
  // delete a pending line, and announce a posted entry).
  it('names 202 distinct enforcement points, none of them claimed twice', () => {
    const sites: string[] = [];
    for (const capability of CAPABILITIES) {
      const entry = CAPABILITY_GATES[capability];
      if (entry.gate !== null) sites.push(entry.gate);
      sites.push(...(entry.also ?? []));
    }
    expect(sites.length).toBe(202);
    expect(new Set(sites).size).toBe(202);
    expect(ENFORCEMENT_POINTS).toBe(202);
  });

  // Merging two call sites into one capability is a decision, so it has to be
  // argued at the point it is made. Merge only where two sites are literally
  // the same act reached twice.
  it('makes every merge declare its reason', () => {
    for (const capability of CAPABILITIES) {
      const entry = CAPABILITY_GATES[capability];
      const merged = (entry.also?.length ?? 0) > 0;
      expect(merged, capability).toBe(typeof entry.merged === 'string');
      if (merged) expect(entry.merged!.length).toBeGreaterThan(20);
    }
  });

  // EVERY capability now names a place in the app that reads it.
  // permissions.write was the last one without a gate, and it kept the `unwired`
  // escape hatch honest by being the only user of it; setPlayerPermissions is
  // now behind it, so the honest assertion is that the escape hatch is unused.
  // A capability with nothing behind it is a tick box the app does not read —
  // which is how a permission editor becomes a UI that lies.
  it('leaves nothing unwired', () => {
    expect(CAPABILITIES.filter((c) => CAPABILITY_GATES[c].gate === null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The baselines
// ---------------------------------------------------------------------------
// Pinned LITERALLY, because the only way to notice one drifting is to have
// written it down twice.
//
// THERE ARE THREE LISTS HERE NOW, NOT TWO, AND THE SPLIT IS THE WHOLE CHANGE.
// TRAINER_BASELINE and EXEC_ASSIGNABLE are the transcription — what a trainer
// and an exec could do the day before capabilities existed. EXEC_BASELINE used
// to be the second of those and is now something else entirely: the read-only
// FLOOR an officer holds before anybody assigns them anything. The literal pin
// that follows the 73 moved WITH the transcription, to EXEC_ASSIGNABLE, and a
// new literal pin was written for the twelve.

describe('baselines', () => {
  it('gives a trainer exactly the roster, its page, and varsity notes', () => {
    expect([...TRAINER_BASELINE]).toEqual([
      'players.page',
      'players.read',
      'players.editor.varsitynotes.write',
    ]);
  });

  // THE FLOOR, PINNED ONE BY ONE — the club owner's "everyone can read things,
  // but cant write it", written down so that a single write appearing here is a
  // diff somebody has to read. Eight pages and four reads; the only two reads
  // that are not an area's page are the expense ledger and the two tournament
  // reads that were never anything but reads.
  it('gives an exec exactly 13 capabilities, one of them a write, pinned one by one', () => {
    expect([...EXEC_BASELINE]).toEqual([
      'announcements.page',
      'fees.page',
      'fees.expenses.read',
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
    ]);
    expect(EXEC_BASELINE.length).toBe(13);
    // The property the list exists to have, asserted as a property rather than
    // read off the list above. It said NOT ONE WRITE until 2026-09-19, when the
    // owner asked for the expense write to reach every officer. Naming the
    // single exception keeps the assertion as strong as the old one: a second
    // write appearing in the floor is still a failing test, not a silent
    // widening that reaches the whole club by level.
    expect(EXEC_BASELINE.filter((c) => c.endsWith('.write'))).toEqual([
      'fees.expenses.add.write',
    ]);
  });

  // THE TRANSCRIPTION, UNMOVED. This literal list is the one that used to be
  // asserted against EXEC_BASELINE, character for character and in the same
  // order — it is repointed rather than rewritten, because the SET did not
  // change, only which constant holds it. That is the anti-widening claim: what
  // an admin may hand out is exactly what an exec used to hold by default.
  // 74 SINCE 00224, AND EXACTLY ONE ENTRY IS NOT PART OF THE TRANSCRIPTION.
  // `announcements.discord.write` is capability 120 and the owner asked for it
  // to belong to VP External. A VP portfolio is by construction a subset of
  // this list, so the request and "this list never grows" could not both be
  // kept. It sits with the other announcement capabilities below and carries
  // its own note, so the one entry that is NOT a transcription says so where
  // somebody reading the list will see it.
  //
  // WHAT THE ANTI-WIDENING CLAIM STILL SAYS: nobody gained anything by being an
  // exec. EXEC_BASELINE — the read-only floor, which is what the owner's "exec
  // baseline shouldn't really be too much" was about — is untouched at twelve.
  //
  // 74 STAYED 74 WHEN THE DATA API LANDED. The four `accounts.*` strings exist
  // in CAPABILITIES so the key panel can gate on them, and an admin holds them
  // by level, but they are not in this list: a minted key is a bearer
  // credential that outlives the grant, so minting stays admin-only. The
  // reasoning is in access-level.ts beside the omission.
  it('leaves exactly 74 capabilities assignable, pinned one by one', () => {
    expect([...EXEC_ASSIGNABLE]).toEqual([
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
      // NOT PART OF THE TRANSCRIPTION — see the note above. 00224 put it in
      // VP External at the owner's request; every other entry here is
      // something an unrestricted exec could already do.
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
    ]);
    expect(EXEC_ASSIGNABLE.length).toBe(74);
    // NOBODY HOLDS IT BY DEFAULT, which is the difference between this list and
    // the one above. It is a ceiling on what may be assigned, never a grant.
    expect(effectiveCapabilities('exec', UNRESTRICTED).size).toBe(EXEC_BASELINE.length);
  });

  // THE FLOOR IS INSIDE THE TRANSCRIPTION, which is the narrowing stated as an
  // inclusion. If this ever fails, the "baseline" has grown something no exec
  // held before capabilities existed — the one direction it must never move.
  it('keeps the exec baseline strictly inside what an exec may be assigned', () => {
    const assignable = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const capability of EXEC_BASELINE) {
      expect(assignable.has(capability), `${capability} is not historic exec work`).toBe(true);
    }
    expect(EXEC_BASELINE.length).toBeLessThan(EXEC_ASSIGNABLE.length);
  });

  // THE INVARIANT, CHECKED AGAINST THE BASELINES THEMSELVES. A baseline is fed
  // to permits() directly and never goes through the resolver, so a missing page
  // here would not be pruned — it would be a level quietly holding writes in a
  // section it cannot open, which is the shape of bug this suite exists to make
  // impossible to ship.
  it('carries the page for every area any of the three lists reaches', () => {
    for (const list of [EXEC_BASELINE, EXEC_ASSIGNABLE, TRAINER_BASELINE]) {
      const held = new Set<Capability>(list);
      for (const capability of list) {
        expect(held.has(pageOf(capability)), `${capability} without its area page`).toBe(true);
      }
    }
  });

  it('keeps all three lists inside the vocabulary, with no duplicates', () => {
    for (const list of [EXEC_BASELINE, EXEC_ASSIGNABLE, TRAINER_BASELINE]) {
      expect(new Set(list).size).toBe(list.length);
      for (const capability of list) expect(isCapability(capability)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // THE LADDER, AND THE ONE RUNG THE NARROWING BROKE
  // -------------------------------------------------------------------------
  // THIS USED TO BE ONE ASSERTION: "keeps the trainer baseline inside the exec
  // baseline", whose comment said a trainer's level is a strict subset of an
  // exec's, "or 'exec' would stop meaning 'everything a trainer has, and more'".
  //
  // WHAT IT WAS ACTUALLY PROTECTING is accessLevelFor(), which resolves is_exec
  // BEFORE is_trainer and returns ONE level. A row carrying both flags is
  // therefore an 'exec' and holds the exec baseline and nothing else — which was
  // free while that baseline contained the trainer's, and is not free now. The
  // containment was the thing making the collapse lossless.
  //
  // IT NO LONGER HOLDS, AT EXACTLY ONE CAPABILITY. `players.page` and
  // `players.read` are in the new twelve; `players.editor.varsitynotes.write` is
  // a write, so it left with every other write. The hole is pinned LITERALLY
  // below rather than the assertion being deleted or quietly repointed, because
  // a one-capability hole that nobody notices growing to five is precisely the
  // failure this suite exists to make impossible.
  //
  // IT IS LATENT RATHER THAN LIVE, and that is why the recommendation is to
  // record it rather than widen the baseline back. Every writer of these columns
  // is mutually exclusive — fromRoleValue() in the admin app writes
  // `is_trainer: false` for 'executive' and `is_exec: false` for 'trainer', and
  // both the member Edit dialog and /permissions go through it — so only a
  // legacy row or a hand-rolled admin payload can be both. The two repairs, if a
  // row is ever found: put the varsity note back in EXEC_BASELINE (one line, but
  // it hands every officer a write the club owner did not ask for), or stop
  // accessLevelFor() collapsing the two flags (correct, and a change to the
  // resolver rather than to a list).
  it('leaves exactly the varsity note outside the exec baseline — a REGRESSION, pinned so it cannot grow', () => {
    const exec = new Set<Capability>(EXEC_BASELINE);
    const outside = TRAINER_BASELINE.filter((capability) => !exec.has(capability));
    expect(outside).toEqual(['players.editor.varsitynotes.write']);
  });

  // AND THE CONTAINMENT THAT DOES SURVIVE, which is the one worth having: a
  // trainer's whole level is inside what an exec may be ASSIGNED. So promoting a
  // varsity trainer to executive-with-the-internal-role takes nothing from them,
  // and the ladder still holds everywhere authority is handed over deliberately.
  // It fails only where a single row silently claims two jobs at once.
  it('keeps the trainer baseline inside what an exec may be assigned', () => {
    const assignable = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const capability of TRAINER_BASELINE) {
      expect(assignable.has(capability), capability).toBe(true);
    }
    // ...and the role that owns the roster is where it actually lands, so the
    // repair is a real assignment rather than a theoretical one.
    expect(ROLE_DEFAULTS.internal).toContain('players.editor.varsitynotes.write');
  });

  // The four VP jobs, and `custom` — which is not a fifth job but the empty
  // base, the only way the storage can express a hand-picked set. Pinned in
  // order, because that order is the order the editor offers them in.
  it('lists exactly the four VP jobs, and the hand-picked base', () => {
    expect([...PERMISSION_ROLES]).toEqual([
      'finance',
      'tournaments',
      'internal',
      'external',
      'custom',
    ]);
  });
});

// ---------------------------------------------------------------------------
// ROLE_DEFAULTS
// ---------------------------------------------------------------------------
// THE PROPERTY THESE TESTS EXIST FOR: a role can never put somebody outside
// what an exec could already do. Everything below is a way of writing that down
// so it cannot be lost by accident — the subset assertion is the security one,
// and the literal pinning is what makes a change to a role a reviewed diff
// rather than a discovery six months later.
//
// THE CONSTANT THESE TWO NAME MOVED FROM EXEC_BASELINE TO EXEC_ASSIGNABLE, and
// the property did not. While the baseline WAS the historic 73, "inside the exec
// baseline" and "inside what an exec could already do" were the same sentence
// written two ways; narrowing the baseline to twelve reads split them, and it is
// the second one these have always meant. Stating them against the twelve would
// have been a different and false claim — every VP role would exceed its own
// bound, and the assignment mechanism the narrowing depends on would be the
// thing these tests refused.
//
// It used to be stated as "assigning a role is never itself a widening", which
// was the same claim only while roles were exec-only: the role was a subset of
// the TARGET's own base, so picking one could only subtract. Trainers are
// composable now, and ROLE_DEFAULTS.tournaments against TRAINER_BASELINE is a
// widening by fifty capabilities — deliberately, because that is what lets a
// varsity trainer run sessions without being made an exec. The subset assertion
// below is unchanged and still the security one; only the sentence describing
// what it buys had to move from a direction to a ceiling.

describe('ROLE_DEFAULTS', () => {
  // The one that matters. A role that reached beyond the historic exec set would
  // let "pick Finance from a dropdown" hand out something no exec ever had,
  // with no grant to review and no audit row saying what it was.
  it('keeps every role inside what an exec may be assigned, so a role can never exceed it', () => {
    const assignable = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const role of PERMISSION_ROLES) {
      for (const capability of ROLE_DEFAULTS[role]) {
        expect(
          assignable.has(capability),
          `${role} grants ${capability}, which no exec ever held`,
        ).toBe(true);
      }
    }
  });

  it('keeps every role inside the vocabulary, with no duplicates', () => {
    for (const role of PERMISSION_ROLES) {
      const list = ROLE_DEFAULTS[role];
      expect(new Set(list).size, role).toBe(list.length);
      for (const capability of list) expect(isCapability(capability), capability).toBe(true);
    }
  });

  // A role missing an area's page does not merely leave its holder outside the
  // section — the resolver DELETES everything the role gave them there. So this
  // is not a courtesy check any more: a role that failed it would be a named job
  // that silently confers nothing.
  it('gives every role the page for every area it touches', () => {
    for (const role of PERMISSION_ROLES) {
      const list = ROLE_DEFAULTS[role];
      const held = new Set<Capability>(list);
      for (const capability of list) {
        expect(
          held.has(pageOf(capability)),
          `${role} gives ${capability} but not ${pageOf(capability)}`,
        ).toBe(true);
      }
      // ...and the resolver agrees, which is the assertion that matters: an
      // unadjusted role must survive its own invariant intact.
      //
      // RESOLVED AT NO LEVEL, ON PURPOSE. This is a claim about the ROLE — that
      // its own capabilities are self-supporting and none of them is pruned —
      // and a floor underneath would supply the eight section pages and make it
      // pass for a role that carried none of its own. `null` is the only reading
      // that still tests the list rather than the baseline.
      const resolved = resolvePermissions(null, role, [], []);
      expect(RESTRICTED(resolved), role).toEqual([...list].sort());

      // ...and at a real level it is the floor UNDER the role, never instead of
      // it: the club owner's "all roles should have the baseline".
      const asExec = resolvePermissions('exec', role, [], []);
      expect(RESTRICTED(asExec), role).toEqual(
        [...new Set<Capability>([...EXEC_BASELINE, ...list])].sort(),
      );
    }
  });

  // THE INVARIANT AS A PROPERTY OF THE RESOLVER, not of the three lists.
  //
  // The two tests above check the baselines and the roles, which are sets
  // somebody wrote down. This checks the thing that is ASSEMBLED: for every
  // level, every role and every single capability granted on top, the resolver's
  // output satisfies the page rule. It holds by construction, because pruning is
  // the last step of resolvePermissions and it runs over the merged set.
  //
  // WHY IT IS WORTH A TEST WHEN IT CANNOT CURRENTLY FAIL. Because it is the
  // assertion that a save-time reachability REFUSAL would be dead code. The
  // resolver's output is the only thing setPlayerPermissions checks the actor
  // against, so "reject a composition whose sub-capability has no page" can
  // never fire there: by the time that set exists, the violating member has
  // already been pruned out of it. Anyone who later adds such a check should
  // find this test explaining why it will never throw. Anyone who moves the
  // pruning step, or drops it, breaks this instead of shipping a silent hole.
  //
  // ONE CAPABILITY AT A TIME RATHER THAN EVERY SUBSET. A grant cannot mask
  // another grant's missing page: pruning tests each member against the final
  // set independently, so the single-grant case is the whole of the behaviour
  // and 2^131 subsets would prove nothing further.
  it('prunes to a page-complete set for every level, role and grant', () => {
    for (const level of ['exec', 'trainer'] as const) {
      for (const role of PERMISSION_ROLES) {
        for (const grant of CAPABILITIES) {
          const resolved = effectiveCapabilities(
            level,
            resolvePermissions(level, role, [grant], []),
          );
          for (const capability of resolved) {
            const page = pageOf(capability);
            if (capability === page) continue;
            expect(
              resolved.has(page),
              `${level}/${role} +${grant} resolved to ${capability} without ${page}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  // THE FLOOR IS WHAT MAKES A WRITE-ONLY GRANT LEGAL, and this is the case that
  // a naive reachability check gets wrong. Two live members hold matches writes
  // with no `matches.page` anywhere in their grants array: the page comes from
  // the exec floor. Checking the ARRAY would refuse to save them; checking the
  // RESOLVED SET is the only reading under which they are the ordinary case
  // they are.
  it('keeps a write granted without its page when the floor supplies the page', () => {
    const grants: Capability[] = [
      'matches.convert.write',
      'matches.create.write',
      'matches.void.write',
    ];
    const resolved = effectiveCapabilities(
      'exec',
      resolvePermissions('exec', 'custom', grants, []),
    );
    for (const grant of grants) expect(resolved.has(grant), grant).toBe(true);
    // The premise: the page is the FLOOR's, named in no grant.
    expect(new Set<Capability>(EXEC_BASELINE).has('matches.page')).toBe(true);
    expect(grants).not.toContain('matches.page');

    // And the cascade still bites: revoking the floor's page takes the writes.
    const closed = effectiveCapabilities(
      'exec',
      resolvePermissions('exec', 'custom', grants, ['matches.page']),
    );
    for (const grant of grants) expect(closed.has(grant), grant).toBe(false);
  });

  // THE DERIVATION, WRITTEN DOWN. The four roles are the old SECTION_PORTFOLIO
  // map — finance owned /fees, tournaments owned /tournaments /matches
  // /sessions, internal owned /players /seasons, external owned /legal
  // /announcements — intersected with the historic exec set. So they partition
  // it exactly, and that is not a coincidence to be preserved for its own sake:
  // it is the assertion that assigning a role does what assigning a portfolio
  // did.
  //
  // IT STILL HOLDS EXACTLY, AND AGAINST EXEC_ASSIGNABLE — the same 73 the
  // baseline used to be, so nothing about the partition itself moved: 3 + 51 +
  // 13 + 6 + 0 = 73, checked below rather than asserted in prose.
  //
  // IT ALSO GAINED A SECOND JOB THE DAY THE BASELINE NARROWED. It was the proof
  // that a role hands out nothing an exec did not already have. It is now ALSO
  // the proof that the four roles between them hand BACK every write the
  // narrowing took away: an exact partition means no capability fell into the
  // gap between the read-only floor and the jobs that are meant to restore it.
  // A merely-inside-the-ceiling check would have let one go missing silently,
  // and the person who noticed would be an officer who could not do their job.
  //
  // The arithmetic moved by exactly one when page keys arrived: finance went
  // from two entries to three, because /fees was the one section whose page key
  // did not already exist under another name. The other three roles renamed
  // their reads and kept their counts, and the total tracked the exec baseline
  // from 69 to 70. It moved by one again when the roster fetch got its own read:
  // `internal` owns /players, so `players.read` went there and nowhere else —
  // which is also why the pickers on /matches and /tournaments are NOT behind
  // it. Gating those would put the same capability in two roles and this
  // assertion is what would refuse it.
  //
  // If a future capability genuinely belongs to two jobs, THIS half is the one
  // to relax. The subset assertion above is not.
  //
  // `custom` contributes nothing to either side, which is the arithmetic reason
  // an empty base was the right shape for it: a hand-picked set had to be
  // storable without claiming a slice of the partition that some VP job already
  // owns.
  it('partitions what an exec may be assigned, exactly, as the four portfolios did', () => {
    const fromRoles = PERMISSION_ROLES.flatMap((role) => [...ROLE_DEFAULTS[role]]);
    expect(new Set(fromRoles).size, 'two roles claim the same capability').toBe(fromRoles.length);
    expect([...fromRoles].sort()).toEqual([...EXEC_ASSIGNABLE].sort());
    // The arithmetic, so "exactly" is a sum somebody can check rather than a
    // word: finance 3, tournaments 51, internal 13, external 7, custom 0.
    // External went 6 -> 7 in 00224, the only movement any of these four has
    // had since they were derived from the old SECTION_PORTFOLIO map.
    expect(PERMISSION_ROLES.map((role) => ROLE_DEFAULTS[role].length)).toEqual([3, 51, 13, 7, 0]);
    expect(fromRoles.length).toBe(74);
  });

  // THE OTHER HALF OF THE PARTITION, AND IT IS NEW. The four roles cover the
  // ceiling; this says they also cover everything an officer LOST. Every write
  // that left EXEC_BASELINE is in exactly one VP job, so "assign them a role" is
  // a complete answer to "they cannot do their job any more" — there is no write
  // that requires a hand-picked grant merely because the roles forgot it.
  it('hands back, through the four roles, every write the baseline gave up', () => {
    const floor = new Set<Capability>(EXEC_BASELINE);
    const lost = EXEC_ASSIGNABLE.filter((capability) => !floor.has(capability));
    // 61 writes an exec actually lost, plus `announcements.discord.write`,
    // which no exec ever had — it is outside the floor for the same arithmetic
    // reason without ever having been taken away from anyone.
    // 62 BECAME 61 on 2026-09-19: `fees.expenses.add.write` went back INTO the
    // floor at the owner's request, so it is no longer a write anybody lost.
    // It is still in ROLE_DEFAULTS.finance, so the loop below is unaffected;
    // the count is the only thing that moves. The data API's four `accounts.*`
    // strings never entered this arithmetic at all: they are not assignable,
    // so they are not in EXEC_ASSIGNABLE and cannot be something an exec lost.
    expect(lost.length).toBe(61);
    const fromRoles = new Set(PERMISSION_ROLES.flatMap((role) => [...ROLE_DEFAULTS[role]]));
    for (const capability of lost) {
      expect(fromRoles.has(capability), `${capability} is in no VP job`).toBe(true);
    }
  });

  // Pinned literally, because the club's answer to "what does the treasurer
  // get" is a decision and not a derivation. Finance stops at the Expenses tab
  // — 00086's behaviour exactly — and club money, other income, the net
  // position and reinstatements are handed over per person by explicit grant.
  it('gives finance today’s scope and nothing more', () => {
    expect([...ROLE_DEFAULTS.finance]).toEqual([
      'fees.page',
      'fees.expenses.read',
      'fees.expenses.add.write',
    ]);
  });

  it('gives external the announcements, Discord, and the legal documents', () => {
    expect([...ROLE_DEFAULTS.external]).toEqual([
      'announcements.page',
      'announcements.create.write',
      'announcements.update.write',
      'announcements.delete.write',
      // 00224, at the owner's request. The one capability in any portfolio with
      // no undo — nothing takes a posted Discord message back.
      'announcements.discord.write',
      'legal.page',
      'legal.reacceptance.write',
    ]);
  });

  it('gives internal the roster and the seasons, but not the season fees', () => {
    expect([...ROLE_DEFAULTS.internal]).toEqual([
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
    ]);
    expect(ROLE_DEFAULTS.internal).not.toContain('seasons.fees.write');
  });

  it('gives tournaments the draw, the ladder and the sessions, but not entry money', () => {
    expect(ROLE_DEFAULTS.tournaments.length).toBe(51);
    expect([...ROLE_DEFAULTS.tournaments].slice(0, 12)).toEqual([
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
    ]);
    for (const capability of ROLE_DEFAULTS.tournaments) {
      expect(capability.startsWith('tournaments.fees.'), capability).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// EDITOR_OFFERABLE
// ---------------------------------------------------------------------------
// The ceiling. Grant closure bounds what one person may hand another and cannot
// bound an ADMIN, who holds everything by level — so the set an admin may
// COMPOSE is capped here, which is the only thing bounding them.
//
// IT USED TO BE `= EXEC_BASELINE`, AND IT IS NOT ANY MORE. The constant was
// doing two jobs: transcribing what execs held, and capping what anybody may be
// composed up to. Editable roles (00104) pulled them apart — the club owner
// wants the exec baseline NOT to grow and Finance to exceed it, and both are
// true only once the ceiling is its own list.
//
// THE TRANSCRIPTION ITSELF DID NOT MOVE, and that is asserted below rather than
// assumed. The widening is four READS on /fees, enumerated in access-level.ts
// and pinned entry-by-entry in editable-roles.test.ts.
//
// THE CONSTANT IT SPREADS IS NOW EXEC_ASSIGNABLE, and this whole block is
// repointed for that reason and no other. `EDITOR_OFFERABLE = EXEC_BASELINE +
// widening` became `EXEC_ASSIGNABLE + widening` when the baseline narrowed —
// which changed the NAME of the first summand and nothing else, because
// EXEC_ASSIGNABLE holds the old EXEC_BASELINE verbatim and in order. The set
// this constant denotes is byte-for-byte what it denoted before, which is the
// whole anti-widening claim, and stating these against the twelve would have
// asserted the opposite of what they exist to assert.

describe('EDITOR_OFFERABLE', () => {
  it('contains everything assignable, in order, and then the widening', () => {
    expect([...EDITOR_OFFERABLE].slice(0, EXEC_ASSIGNABLE.length)).toEqual([...EXEC_ASSIGNABLE]);
  });

  // THE EXEC TRANSCRIPTION IS UNCHANGED. The whole risk of splitting the
  // constants is that a widening lands in the wrong one and reaches every exec
  // in the club without anybody choosing it.
  //
  it('leaves the assignable set exactly as it was', () => {
    expect(EXEC_ASSIGNABLE.length).toBe(74);
    const offerableOnly = [...EDITOR_OFFERABLE].filter(
      (capability) => !new Set<Capability>(EXEC_ASSIGNABLE).has(capability),
    );
    for (const capability of offerableOnly) {
      expect(
        (EXEC_ASSIGNABLE as readonly Capability[]).includes(capability),
        `${capability} leaked into the assignable set`,
      ).toBe(false);
    }
  });

  // AND THE SECOND CONSTANT, GUARDED FROM THE OTHER DIRECTION. Now that there is
  // a floor as well as a ceiling, the mistake to catch is a widening landing in
  // the FLOOR — where it would reach every officer in the club by level, with
  // nobody choosing it. The floor holds exactly one write, chosen deliberately
  // on 2026-09-19 and named below, so the cheapest way to say that is to say it
  // again here, at the constant that bounds handing out. A widening that lands
  // in the floor still fails this: the loop refuses anything NOT already
  // assignable, and the pin refuses a second write however it got there.
  it('never lets the widening reach the exec baseline', () => {
    const floor = new Set<Capability>(EXEC_BASELINE);
    const assignable = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const capability of EDITOR_OFFERABLE) {
      if (assignable.has(capability)) continue;
      expect(floor.has(capability), `${capability} reached the exec baseline`).toBe(false);
    }
    expect(EXEC_BASELINE.filter((c) => c.endsWith('.write'))).toEqual([
      'fees.expenses.add.write',
    ]);
  });

  // Named one by one so that opening any of them is a diff somebody has to
  // read. These are the club's rating and account rules, its audit trail, the
  // ability to MOVE money, and the ability to hand out permissions at all.
  //
  // THE FOUR FINANCE READS CAME OFF THIS LIST, on purpose and as the whole
  // point of 00104: the club owner asked for a treasurer who can SEE money in as
  // well as out. Seeing is not moving, and every `fees.*.write` below stayed.
  //
  // `players.consoleaccess.write` IS OFFERABLE AND IS DELIBERATELY NOT BELOW —
  // 00105, the club owner's "also make role change a permission". It is the
  // first WRITE on the offerable list, and what bounds it is not this list: the
  // action reading it closure-checks the target's whole set on both sides and
  // still refuses the admin level outright, both pinned in
  // apps/admin/src/lib/__tests__/console-access-capability.test.ts. Handing out
  // the admin LEVEL remains the act no capability expresses, which is why
  // `permissions.write` is still below and this is not.
  it('withholds the admin-only half, permissions.write included', () => {
    const offerable = new Set<Capability>(EDITOR_OFFERABLE);
    for (const capability of [
      'permissions.write',
      'permissions.page',
      'audit.page',
      // THE EXPORT FOLLOWS THE PAGE IT BELONGS TO. `audit.page` is withheld, so
      // offering either of these would hand somebody a download from a section
      // they cannot open. Whichever way that page moves one day, these move
      // with it, and neither goes first.
      'audit.export.read',
      'audit.signins.read',
      'ratings.page',
      'accounts.page',
      // THE DATA API'S KEYS ARE WITHHELD HERE TOO, and they are the reason the
      // page above stayed withheld. Minting is not console work: the key it
      // produces reads the club's data from outside every gate in this file,
      // with no session, no audit row per read, and no expiry short of a
      // revoke. Handing that out is an admin act.
      'accounts.apikey.read',
      'accounts.apikey.mint.write',
      'accounts.apikey.revoke.write',
      'platform.page',
      'platform.settings.write',
      'fees.clubfees.markpaid.write',
      'fees.clubfees.waive.write',
      'fees.otherincome.add.write',
      'fees.reinstatements.write',
      'fees.playerflags.write',
      'seasons.fees.write',
      'tournaments.fees.read',
      'players.privilegedfields.write',
      'players.merge.write',
      'players.remove.write',
      'challenges.page',
      'disputes.page',
      'walkovers.page',
    ] as const) {
      expect(offerable.has(capability), `${capability} is offerable`).toBe(false);
    }
  });

  it('holds nothing outside the vocabulary', () => {
    for (const capability of EDITOR_OFFERABLE) expect(isCapability(capability)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// permits / effectiveCapabilities
// ---------------------------------------------------------------------------

describe('permits', () => {
  // 121 BECAME 124 with the data API's three key capabilities, and 124 BECAME
  // 131 with the seven keys to switched-off features, and 131 BECAME 139 with
  // club events, and 139 BECAME 141 with the membership and socials switches,
  // and 141 BECAME 142 with the guest waivers switch, and 142 BECAME 144 with
  // the audit export's two, and 144 BECAME 145 with the predictions switch,
  // and 145 BECAME 147 with Club changes.
  // This number
  // tracks CAPABILITIES.length by construction (admin is a superuser BY LEVEL,
  // so every capability added is automatically theirs), and it is written as a
  // literal anyway, because a count derived from the list it is checking would
  // pass for an empty list.
  it('makes an admin a superuser BY LEVEL, holding all 147', () => {
    for (const capability of CAPABILITIES) {
      expect(permits('admin', UNRESTRICTED, capability), capability).toBe(true);
    }
    expect(effectiveCapabilities('admin', UNRESTRICTED).size).toBe(147);
  });

  it('gives an unrestricted person their level baseline and nothing more', () => {
    expect(effectiveCapabilities('exec', UNRESTRICTED).size).toBe(EXEC_BASELINE.length);
    expect(effectiveCapabilities('trainer', UNRESTRICTED).size).toBe(TRAINER_BASELINE.length);
    expect(permits('exec', UNRESTRICTED, 'fees.clubfees.read')).toBe(false);
    expect(permits('trainer', UNRESTRICTED, 'players.update.write')).toBe(false);
  });

  it('gives somebody with no level nothing at all', () => {
    expect(effectiveCapabilities(null, UNRESTRICTED).size).toBe(0);
    expect(permits(null, UNRESTRICTED, 'players.page')).toBe(false);
    expect(permits(undefined, UNRESTRICTED, 'players.page')).toBe(false);
  });

  it('reads a restricted set literally, with no implication', () => {
    const permissions = {
      kind: 'restricted' as const,
      capabilities: new Set<Capability>(['players.page', 'players.update.write']),
    };
    expect(permits('exec', permissions, 'players.update.write')).toBe(true);
    // Holding the coarse-looking roster write does NOT reach a leaf beneath it.
    expect(permits('exec', permissions, 'players.editor.varsitynotes.write')).toBe(false);
    expect(permits('exec', permissions, 'players.approve.write')).toBe(false);
    // ...and an admin is still unaffected by anything stored.
    expect(permits('admin', permissions, 'players.approve.write')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePermissions
// ---------------------------------------------------------------------------

const RESTRICTED = (permissions: ReturnType<typeof resolvePermissions>) => {
  if (permissions.kind !== 'restricted') throw new Error('expected a restricted set');
  return [...permissions.capabilities].sort();
};

// EVERY CASE BELOW RUNS AT THE `exec` LEVEL, and that is new. resolvePermissions
// took no level until the club owner ruled that "baseline is the baseline,
// unless i manually remove it all roles should have the baseline" — the level's
// baseline is a FLOOR under every composition. So the resolver's answers now
// carry that floor, and these expectations carry it too rather than being run at
// a level with no floor in order to keep the old numbers. Run at `null` they
// would all still pass, unchanged, and would be testing a state no console user
// is ever in.
describe('resolvePermissions', () => {
  it('treats an absent role as unrestricted, DELTAS AND ALL', () => {
    // The decisive case: if an absent role meant an empty base, adding the
    // first grant to an unrestricted exec would flip their base from the whole
    // exec baseline to zero — a grant that removes fifty-odd capabilities, one
    // click, silent.
    expect(resolvePermissions('exec', null, [], [])).toEqual(UNRESTRICTED);
    expect(resolvePermissions('exec', null, ['audit.page'], [])).toEqual(UNRESTRICTED);
    // And a revoke stored while the role is NULL stays dormant rather than
    // biting — it must not remove anything now, nor wake up later without
    // somebody choosing a role.
    expect(resolvePermissions('exec', null, [], ['players.page'])).toEqual(UNRESTRICTED);
    expect(resolvePermissions('exec', '', [], [])).toEqual(UNRESTRICTED);
  });

  /** The exec floor, sorted — under everything in this block. */
  const FLOOR = [...EXEC_BASELINE].sort();
  const withFloor = (...extra: string[]) => [...new Set([...FLOOR, ...extra])].sort();
  const less = (drop: string[], ...extra: string[]) =>
    withFloor(...extra).filter((capability) => !drop.includes(capability));

  // audit.page survives a lone grant with no role behind it because a page
  // requires only ITSELF — that is what makes it the thing you hand somebody
  // first, and the reason every stock grant in this suite is one.
  //
  // "NO DEFAULTS" STILL MEANS NO DEFAULTS. The floor is not a default of the
  // role; it is what the LEVEL carries. So an unrecognised role contributing
  // nothing is visible as the answer being the floor plus the delta and not one
  // capability more.
  it('gives an unrecognised role no defaults, but still applies the deltas', () => {
    const resolved = resolvePermissions('exec', 'treasurer', ['audit.page'], []);
    expect(RESTRICTED(resolved)).toEqual(withFloor('audit.page'));
  });

  // Every case below uses `finance`, whose defaults are the Finances page and
  // the two Expenses capabilities, so the expectations carry that base as well
  // as the delta under test. Deliberately not an empty-base role: a resolver
  // test against a role that gives nothing would pass identically if the base
  // were dropped on the floor.
  //
  // TWO OF ITS THREE ARE IN THE FLOOR TOO now (`fees.page`, `fees.expenses.read`),
  // so what the ROLE still contributes by itself is the one write. Derived
  // rather than written out, so this stays true if either list is edited.
  const FINANCE_BASE = withFloor('fees.expenses.add.write');

  it('puts the level baseline under the role, which is the floor', () => {
    const resolved = resolvePermissions('exec', 'finance', [], []);
    expect(RESTRICTED(resolved)).toEqual(FINANCE_BASE);
    // The role REPLACED the base before this change, so a treasurer held three
    // capabilities and could open nothing else at all. They hold thirteen now.
    expect(RESTRICTED(resolved)).toHaveLength(13);
    for (const capability of EXEC_BASELINE) {
      expect(RESTRICTED(resolved), capability).toContain(capability);
    }
  });

  it('lets a revoke beat a grant of the same capability', () => {
    const resolved = resolvePermissions('exec', 'finance', ['audit.page'], ['audit.page']);
    expect(RESTRICTED(resolved)).toEqual(FINANCE_BASE);
  });

  it('lets a revoke reach into the role’s own defaults', () => {
    const resolved = resolvePermissions('exec', 'finance', [], ['fees.expenses.add.write']);
    expect(RESTRICTED(resolved)).toEqual(less(['fees.expenses.add.write']));
  });

  // THE SENTENCE THE WHOLE ORDERING RESTS ON: "unless i manually remove it". A
  // floor that could not be revoked would not be a floor, it would be a grant
  // nobody could take back — and every narrowing an admin had already made would
  // be silently undone by this change, with the revoke still shown as saved.
  it('lets a revoke reach into the FLOOR itself', () => {
    const resolved = resolvePermissions('exec', 'finance', [], ['players.read']);
    expect(RESTRICTED(resolved)).not.toContain('players.read');
    // The page it hangs off survives — a revoke takes what it names.
    expect(RESTRICTED(resolved)).toContain('players.page');
  });

  // AND THE WHOLE FLOOR AT ONCE, which is the only way below it. A person whose
  // every baseline read has been revoked holds nothing at all, exactly as the
  // admin who did that would expect.
  it('lets an admin revoke somebody below the floor entirely', () => {
    const resolved = resolvePermissions('exec', 'custom', [], [...EXEC_BASELINE]);
    expect(RESTRICTED(resolved)).toEqual([]);
  });

  it('drops an element the vocabulary no longer has, without throwing', () => {
    const resolved = resolvePermissions(
      'exec', 'finance', ['players.write', 'audit.page'], ['nonsense'],
    );
    expect(RESTRICTED(resolved)).toEqual(withFloor('fees.expenses.add.write', 'audit.page'));
  });

  // WRITE WITHOUT READ IS THE POINT, and this is the test that says so. The old
  // model pruned a write whose `.read` sibling was missing; the club owner's
  // rule is ".page would be required to have .write, but .read isnt required",
  // so somebody handed the Finances page and the ability to file an expense
  // keeps it while holding no view of the ledger at all.
  //
  // THE READ BEING REVOKED IS A FLOOR READ NOW, which makes this a second
  // witness for the ordering above: it can only disappear because the merge
  // happens before the subtraction.
  it('keeps a write with no read of its own', () => {
    const resolved = resolvePermissions(
      'exec',
      'finance',
      ['fees.reinstatements.write'],
      ['fees.expenses.read'],
    );
    expect(RESTRICTED(resolved)).toEqual(
      less(['fees.expenses.read'], 'fees.expenses.add.write', 'fees.reinstatements.write'),
    );
    expect(RESTRICTED(resolved)).not.toContain('fees.expenses.read');
  });

  // Revoking a read takes that read and NOTHING ELSE. This is the exact case
  // the old `write ⊆ read` prune existed for, inverted deliberately.
  it('leaves the write behind when the matching read is revoked', () => {
    const resolved = resolvePermissions(
      'exec',
      'finance',
      ['fees.otherincome.read', 'fees.otherincome.add.write'],
      ['fees.otherincome.read'],
    );
    expect(RESTRICTED(resolved)).toEqual(
      withFloor('fees.expenses.add.write', 'fees.otherincome.add.write'),
    );
  });

  // -------------------------------------------------------------------------
  // THE PAGE INVARIANT, AND WHAT THE FLOOR DID TO IT
  // -------------------------------------------------------------------------
  // THIS USED TO BE ONE TEST — `prunes a granted capability whose area page is
  // not held` — and its expectation has genuinely inverted for an exec. The
  // floor carries all eight section pages, so THERE IS NO AREA AN EXEC HOLDS A
  // CAPABILITY IN AND CANNOT OPEN, and nothing granted to one is pruned any
  // more. That is not the invariant being defeated: "everyone can read things"
  // is exactly the statement that every section page is held, so the condition
  // this rule existed to catch can no longer arise at that level.
  //
  // Written as two tests rather than one relaxed one, because the rule still
  // fires in both of the places it can: at the TRAINER level, whose floor is the
  // roster and nothing else, and through a REVOKE at any level.
  it('no longer prunes an exec’s grant, because the floor opens every section', () => {
    const resolved = resolvePermissions('exec', 'finance', ['players.approve.write'], []);
    expect(RESTRICTED(resolved)).toEqual(withFloor(
      'fees.expenses.add.write',
      'players.approve.write',
    ));
    // The page that saves it is the FLOOR's, not one the grant or the role
    // carried — which is the whole reason the answer moved.
    expect(ROLE_DEFAULTS.finance).not.toContain('players.page');
    expect(EXEC_BASELINE).toContain('players.page');
  });

  it('still prunes a TRAINER’s grant in an area their floor does not open', () => {
    const resolved = resolvePermissions('trainer', 'custom', ['sessions.attendance.write'], []);
    expect(RESTRICTED(resolved)).toEqual([...TRAINER_BASELINE].sort());
    // ...and it is the PAGE that was missing, not the capability: hand that over
    // and the write comes with it.
    const withPage = resolvePermissions(
      'trainer', 'custom', ['sessions.page', 'sessions.attendance.write'], [],
    );
    expect(RESTRICTED(withPage)).toEqual(
      [...TRAINER_BASELINE, 'sessions.page', 'sessions.attendance.write'].sort(),
    );
  });

  // REVOKING THE PAGE CLOSES THE WHOLE AREA, reads and writes alike, including
  // the ones the FLOOR and the ROLE gave and neither array names. This is why
  // the invariant runs after subtraction rather than before: pruning first would
  // leave the ledger and its controls standing behind a door that had just been
  // shut.
  //
  // IT IS ALSO THE PROOF THAT THE FLOOR IS MERGED BEFORE THE REVOKES, and that
  // is now the most load-bearing thing this test does. `fees.page` is in the
  // floor. Had the baseline been unioned in AFTERWARDS — inside
  // effectiveCapabilities, which is where the level already enters and where it
  // would have cost no call-site churn at all — the revoke would have run first,
  // the union would have put `fees.page` straight back, and a deliberate closure
  // of the section would have done nothing whatever.
  it('takes every capability in an area with that area’s page, floor included', () => {
    const resolved = resolvePermissions(
      'exec',
      'finance',
      ['fees.clubfees.read', 'fees.clubfees.waive.write'],
      ['fees.page'],
    );
    // NOT empty any more: closing /fees closes /fees, and leaves the seven other
    // sections the floor opens exactly as they were.
    expect(RESTRICTED(resolved).filter((c) => c.startsWith('fees.'))).toEqual([]);
    // Three now, not two: the floor's own `fees.expenses.add.write` goes with
    // the page as well, which is the whole claim of this test. Closing /fees
    // has to close the write the FLOOR gave, not only the reads, or a revoked
    // section would still accept a filing.
    expect(RESTRICTED(resolved)).toEqual(
      less(['fees.page', 'fees.expenses.read', 'fees.expenses.add.write']),
    );
  });

  it('is pure — the same inputs give the same answer and nothing is mutated', () => {
    const grants = ['audit.page'];
    const revokes: string[] = [];
    const first = RESTRICTED(resolvePermissions('exec', 'finance', grants, revokes));
    const second = RESTRICTED(resolvePermissions('exec', 'finance', grants, revokes));
    expect(first).toEqual(second);
    expect(grants).toEqual(['audit.page']);
    expect(revokes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // THE FLOOR IS THE LEVEL'S, NOT THE EXEC'S
  // -------------------------------------------------------------------------
  // The mistake this guards against is `EXEC_BASELINE` hard-coded where
  // `BASELINES[level]` belongs. It would pass every exec case above, and it
  // would hand a varsity trainer the club's books, its ladder and its whole
  // tournament calendar the moment anybody composed them.
  it('floors a trainer on the TRAINER baseline, never the exec one', () => {
    const resolved = resolvePermissions('trainer', 'custom', [], []);
    expect(RESTRICTED(resolved)).toEqual([...TRAINER_BASELINE].sort());
    for (const capability of EXEC_BASELINE) {
      if ((TRAINER_BASELINE as readonly Capability[]).includes(capability)) continue;
      expect(RESTRICTED(resolved), capability).not.toContain(capability);
    }
  });

  // THE 00090 REPAIR, AND IT IS A REAL GAIN RATHER THAN A SIDE-EFFECT.
  // Composable trainers arrived so a varsity trainer could run the club's
  // calendar without being made an exec — but a role REPLACED the base, so doing
  // it took away the varsity note, which is the one thing their level exists
  // for. A floor under the role hands it back, and the trainer who runs
  // tournaments is still a trainer.
  it('leaves a composed trainer holding the varsity note their role does not carry', () => {
    const resolved = resolvePermissions('trainer', 'tournaments', [], []);
    expect(RESTRICTED(resolved)).toContain('players.editor.varsitynotes.write');
    expect(ROLE_DEFAULTS.tournaments).not.toContain('players.editor.varsitynotes.write');
  });

  // NOBODY WITHOUT A LEVEL GETS A FLOOR, which matters because a row can still
  // carry a composition after the console has been taken away from them.
  it('gives a person with no level no floor at all', () => {
    const resolved = resolvePermissions(null, 'finance', [], []);
    expect(RESTRICTED(resolved)).toEqual([...ROLE_DEFAULTS.finance].sort());
    expect(effectiveCapabilities(null, resolved).size).toBe(0);
  });

  // AN ADMIN GETS NO FLOOR EITHER, and the reason is not symmetry. BASELINES
  // .admin is ALL_CAPABILITIES — a level short-circuit written as a set, not
  // anything anybody was granted — so merging it would make the resolver answer
  // 120 for a composition that cannot exist, since both write paths refuse an
  // admin target outright. permits() never reads it, so the only thing such a
  // value could do is mislead an editor preview.
  it('gives an ADMIN no floor, because their baseline is a short-circuit', () => {
    const resolved = resolvePermissions('admin', 'finance', [], []);
    expect(RESTRICTED(resolved)).toEqual([...ROLE_DEFAULTS.finance].sort());
    // ...and they hold everything regardless, by level.
    expect(permits('admin', resolved, 'permissions.write')).toBe(true);
  });
});

describe('permissionsOf', () => {
  // The heir of the old portfolioOf({}) === null. This is what makes the code
  // safe to deploy before the storage migration is applied: a missing column
  // must read as "not narrowed", because the alternative locks every exec out
  // of the console the moment the app ships.
  it('reads a row with none of the columns as unrestricted', () => {
    expect(permissionsOf('exec', {})).toEqual(UNRESTRICTED);
    expect(permissionsOf('exec', null)).toEqual(UNRESTRICTED);
    expect(permissionsOf('exec', undefined)).toEqual(UNRESTRICTED);
  });

  it('reads a null role as unrestricted', () => {
    expect(permissionsOf(
      'exec',
      { permission_role: null, permission_grants: [], permission_revokes: [] },
    )).toEqual(UNRESTRICTED);
  });

  // The columns are NOT NULL, so a role with a missing array can only come from
  // a narrowed SELECT — a programming error, not a state. The obvious `?? []`
  // would silently discard revokes, and a discarded revoke can leave somebody
  // holding permissions.write.
  it('THROWS on a role with a missing delta column', () => {
    expect(() => permissionsOf('exec', { permission_role: 'finance' }))
      .toThrow(/narrow the SELECT less/);
    expect(() => permissionsOf('exec', { permission_role: 'finance', permission_grants: [] }))
      .toThrow(/narrow the SELECT less/);
  });

  // THE LEVEL IS AN ARGUMENT, AND THE FLOOR COMES WITH IT. The same row read at
  // two levels is two different answers, which is exactly what a level-dependent
  // floor means and exactly why the parameter is required rather than derived
  // from the row: the sidebar resolves a bare TRIPLE that carries no level
  // markers at all, and silently flooring it on nothing would have made the nav
  // hide sections the server would happily serve.
  it('resolves a complete row, with the floor of the level it was asked about', () => {
    const row = {
      permission_role: 'finance',
      permission_grants: ['audit.page'],
      permission_revokes: [],
    };
    expect(RESTRICTED(permissionsOf('exec', row))).toEqual(
      [...new Set([...EXEC_BASELINE, 'audit.page', 'fees.expenses.add.write'])].sort(),
    );
    // The SAME row, read as a trainer: the trainer floor, and no exec reads.
    expect(RESTRICTED(permissionsOf('trainer', row))).toEqual(
      [...new Set([...TRAINER_BASELINE, 'audit.page', 'fees.page', 'fees.expenses.read',
        'fees.expenses.add.write'])].sort(),
    );
    // ...and with no level, no floor: the role and the grant, and nothing else.
    expect(RESTRICTED(permissionsOf(null, row))).toEqual(
      ['audit.page', 'fees.expenses.add.write', 'fees.expenses.read', 'fees.page'],
    );
  });
});

describe('permissionTripleOf', () => {
  // A resolved Permissions carries a Set, and a Set is not plain data — so what
  // a server component hands the sidebar is the stored TRIPLE, resolved again
  // on the other side by the same function. Null for a row from before the
  // storage migration, which the client then reads as unrestricted.
  it('returns null for a row that predates the storage migration', () => {
    expect(permissionTripleOf({})).toBeNull();
    expect(permissionTripleOf(null)).toBeNull();
    expect(permissionTripleOf(undefined)).toBeNull();
  });

  it('carries the triple through unchanged', () => {
    expect(
      permissionTripleOf({
        permission_role: 'finance',
        permission_grants: ['audit.page'],
        permission_revokes: ['players.page'],
      }),
    ).toEqual({
      permission_role: 'finance',
      permission_grants: ['audit.page'],
      permission_revokes: ['players.page'],
    });
  });

  // The same throw permissionsOf makes, and for the same reason: serialising a
  // missing delta column as an empty array would DISCARD A REVOKE on the way to
  // the client, and a discarded revoke can leave somebody holding
  // permissions.write. A `?? []` here would have been the quiet way to
  // reintroduce exactly the bug the resolver throws to prevent.
  // STILL ONE ARGUMENT, AND DELIBERATELY SO. This function serialises rather
  // than resolves: what crosses the wire is the three columns, unresolved, and
  // the CLIENT applies the floor with the level the layout sent alongside. Its
  // internal permissionsOf() call is run for the throw and the result discarded,
  // so it passes `null` — a level there would compute a set nobody reads, and
  // the WRONG level there would be a bug that never surfaced.
  it('THROWS rather than serialise a role with a missing delta column', () => {
    expect(() => permissionTripleOf({ permission_role: 'finance' }))
      .toThrow(/narrow the SELECT less/);
  });
});

// ---------------------------------------------------------------------------
// Varsity notes, end to end
// ---------------------------------------------------------------------------
// The one capability that used to need a hand-composed gate — getVarsityAuthor
// called the console-level check and the portfolio check and joined them by
// hand, and its own comment said so. It needs no special case now, and these
// four cases are why: the resolver is LEVEL-AGNOSTIC, and the level enters only
// at permits(), where it picks which baseline an unrestricted person holds. One
// rule, three baseline entries.

describe('varsity notes', () => {
  const VARSITY = 'players.editor.varsitynotes.write';

  it('is held by a trainer — it is most of their level', () => {
    expect(permits('trainer', UNRESTRICTED, VARSITY)).toBe(true);
  });

  // THE EXPECTATION FLIPPED, AND IT IS THE NARROWING ITSELF. This test used to
  // read "is held by an unrestricted exec, exactly as it was before" and assert
  // TRUE. The varsity note is a WRITE, so it left the exec floor with all sixty
  // others: an officer with no permission_role can find the player and read the
  // roster, and cannot write about them.
  //
  // IT IS NOT A LOSS FOR TRAINERS — the case above still passes and is the level
  // that owns this capability. What it IS, is the one place the trainer level is
  // no longer inside the exec level; see the pinned hole in `baselines` above.
  it('is NOT held by an unrestricted exec any more — the write left the floor', () => {
    expect(permits('exec', UNRESTRICTED, VARSITY)).toBe(false);
    // The two roster READS did not: an officer can still find the person, which
    // is what makes assigning the note afterwards a coherent act rather than a
    // second thing they also have to be given.
    expect(permits('exec', UNRESTRICTED, 'players.page')).toBe(true);
    expect(permits('exec', UNRESTRICTED, 'players.read')).toBe(true);
  });

  // ...and it comes back with the job that owns it. This is the whole mechanism
  // in three lines: the write is not gone, it is assigned.
  it('is held again by an exec given the role that owns the roster', () => {
    const internal = resolvePermissions('exec', 'internal', [], []);
    expect(permits('exec', internal, VARSITY)).toBe(true);
  });

  // THE ROSTER PAGE NO LONGER GOES WITH IT, AND THAT IS THE FLOOR. Assigning
  // Finance used to REPLACE the base, so a treasurer lost the roster entirely
  // and could not find the person they were not allowed to write about. The
  // owner's ruling — "baseline is the baseline, unless i manually remove it all
  // roles should have the baseline" — means the reads stay and only the WRITE is
  // absent, which is a far more sensible thing for a treasurer to be.
  it('is NOT held by an exec narrowed to finance, though the roster READS remain', () => {
    const finance = resolvePermissions('exec', 'finance', [], []);
    expect(permits('exec', finance, VARSITY)).toBe(false);
    expect(permits('exec', finance, 'players.page')).toBe(true);
    expect(permits('exec', finance, 'players.read')).toBe(true);
    // ...and it goes for good if somebody revokes the page, which is the only
    // way below the floor.
    const closed = resolvePermissions('exec', 'finance', [], ['players.page']);
    expect(permits('exec', closed, 'players.page')).toBe(false);
    expect(permits('exec', closed, 'players.read')).toBe(false);
  });

  // The page has to come with it. Granting the note alone would be pruned —
  // there is no roster area for that person to hold a capability in — which is
  // the invariant behaving exactly as intended and worth showing here, because
  // this is the capability people will reach for first.
  // THE PRUNE MOVED TO THE TRAINER LEVEL, and this case is where it shows. An
  // exec's floor carries `players.page`, so granting the note alone is enough
  // for them now — there is no area an exec holds a capability in and cannot
  // open. A TRAINER whose floor is the roster and nothing else still meets the
  // original rule everywhere except there, so the pruning half is asserted at
  // the level where it is still reachable.
  it('needs no separate page grant for an exec, because the floor carries it', () => {
    const granted = resolvePermissions('exec', 'finance', [VARSITY], []);
    expect(permits('exec', granted, VARSITY)).toBe(true);
  });

  it('is still pruned for a TRAINER granted it in an area they cannot open', () => {
    // A trainer's floor is the roster, so the note itself is never the pruned
    // case — a capability in some OTHER area is.
    const orphan = resolvePermissions('trainer', 'custom', ['fees.expenses.read'], []);
    expect(permits('trainer', orphan, 'fees.expenses.read')).toBe(false);
    const withPage = resolvePermissions('trainer', 'custom', ['fees.page', 'fees.expenses.read'], []);
    expect(permits('trainer', withPage, 'fees.expenses.read')).toBe(true);
  });

  it('is held by an admin by LEVEL, with nothing stored', () => {
    expect(permits('admin', resolvePermissions('admin', 'finance', [], []), VARSITY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE KEYS TO SWITCHED-OFF FEATURES
// ---------------------------------------------------------------------------
// `page.access.<feature id>`. Switched off means off, so nobody holds one by
// level except an admin; everybody else is handed one on /permissions.

describe('the page.access keys', () => {
  const KEYS = [...FEATURE_ACCESS_CAPABILITIES];

  it('are in no baseline and no role, and every one is offerable', () => {
    const offerable = new Set<Capability>(EDITOR_OFFERABLE);
    for (const key of KEYS) {
      expect(EXEC_BASELINE, key).not.toContain(key);
      expect(TRAINER_BASELINE, key).not.toContain(key);
      expect(EXEC_ASSIGNABLE, key).not.toContain(key);
      for (const role of PERMISSION_ROLES) expect(ROLE_DEFAULTS[role], `${role} ${key}`).not.toContain(key);
      expect(offerable.has(key), key).toBe(true);
    }
  });

  // A grant stands alone: the key is its own page, so the prune keeps it for a
  // trainer whose floor opens nothing else, and a revoke closes just that one.
  it('survive a lone grant at every level, and a revoke takes exactly the one', () => {
    for (const level of ['exec', 'trainer'] as const) {
      const granted = resolvePermissions(level, 'custom', ['page.access.tournaments'], []);
      expect(permits(level, granted, 'page.access.tournaments'), level).toBe(true);
      expect(permits(level, granted, 'page.access.challenges'), level).toBe(false);
    }
    const revoked = resolvePermissions(
      'exec', 'custom', ['page.access.tournaments', 'page.access.challenges'], ['page.access.challenges'],
    );
    expect(permits('exec', revoked, 'page.access.tournaments')).toBe(true);
    expect(permits('exec', revoked, 'page.access.challenges')).toBe(false);
  });

  // featureAccessFor() is what the members' app asks, and it is the same
  // resolver the console uses.
  describe('featureAccessFor', () => {
    const exec = { is_exec: true, role: 'member', status: 'active', is_banned: false, active_flag: true };

    it('gives an admin every feature, by level', () => {
      expect(featureAccessFor({ ...exec, role: 'admin', is_exec: false })).toEqual(FEATURES.map((f) => f.id));
    });

    // THE BEHAVIOUR THIS CHANGED. 47fc75e7 let any console holder in; an exec
    // with nothing granted now holds no key at all.
    it('gives an unassigned exec nothing', () => {
      expect(featureAccessFor(exec)).toEqual([]);
      expect(featureAccessFor({
        ...exec, permission_role: null, permission_grants: [], permission_revokes: [],
      })).toEqual([]);
    });

    it('gives a composed exec exactly the keys they were granted', () => {
      expect(featureAccessFor({
        ...exec,
        permission_role: 'custom',
        permission_grants: ['page.access.tournaments'],
        permission_revokes: [],
      })).toEqual(['tournaments']);
    });

    it('gives a member, a banned exec and a signed-out visitor nothing', () => {
      const grants = { permission_role: 'custom', permission_grants: [...KEYS], permission_revokes: [] };
      expect(featureAccessFor({ ...exec, is_exec: false, ...grants })).toEqual([]);
      expect(featureAccessFor({ ...exec, is_banned: true, ...grants })).toEqual([]);
      expect(featureAccessFor(null)).toEqual([]);
    });

    // FAILS CLOSED. A role with a missing delta column makes the resolver
    // throw; the feature is off, so the answer is no key rather than an error.
    it('fails closed on a row the resolver refuses', () => {
      const partial = { ...exec, permission_role: 'custom', permission_grants: [...KEYS] };
      expect(() => permissionsOf('exec', partial)).toThrow();
      expect(featureAccessFor(partial)).toEqual([]);
    });
  });
});
