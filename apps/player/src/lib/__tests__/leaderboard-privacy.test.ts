import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// FIX-LIST #14 — "`hide_from_leaderboard` is enforced but bypassable by a click".
//
// The control is real in the database: `get_leaderboard()` has filtered on this
// flag since 00003. What it never covered is every OTHER route to the same
// number, and the feed links every match row straight to one of them.
//
// These are source assertions rather than render assertions, and deliberately.
// The defect is not "a component drew the wrong thing on one path" — it is that
// a number reached a caller at all, on paths a snapshot test would have to
// enumerate to catch. What must hold is an ALLOWLIST: the set of files in the
// members' app that can put another member's rating on a screen is small,
// closed, and each entry has a reason. A new surface has to come and edit this
// list, which is the point.

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const SRC = join(__dirname, '..', '..');
const rel = (f: string) => f.slice(SRC.length + 1).replace(/\\/g, '/');

// Every file allowed to name an absolute Elo column, and why it is safe.
const ALLOWED = new Map<string, string>([
  // Two reads, and only the first of them has the database behind it.
  // get_leaderboard() filters the live ladder in the database; the past-season
  // branch reads season_final_ratings under the SERVICE ROLE, because anon has no
  // grant on that table, and restates the same three predicates itself. Asserted
  // below rather than taken on trust.
  [
    'app/leaderboard/page.tsx',
    'get_leaderboard() for the live ladder; the past-season query names the three predicates itself',
  ],
  ['app/leaderboard/leaderboard-client.tsx', 'renders only what page.tsx passed it'],
  ['app/page.tsx', 'top-N strip, also off get_leaderboard()'],
  // The Discord bot's ladder. Same source as the web leaderboard: it calls
  // get_leaderboard() and slices the result for paging, adding no filter of its
  // own precisely so the database stays the one place these rules live. A member
  // who sets hide_from_leaderboard is absent from the RPC and therefore absent
  // from Discord, with no second switch to remember.
  ['app/api/discord/leaderboard/route.ts', 'get_leaderboard() already excludes opted-out members'],
  // The Discord profile card. Same source and the same reason as the ladder
  // above -- it reads get_leaderboard() and nothing else for figures, so a
  // member who opted out has no row and their card renders "Unranked".
  //
  // AND IT DOES NOT MAKE THE OWN-ROW CARVE-OUT the profile page makes. The card
  // is a PNG posted into a shared channel and cached by Discord's CDN, so
  // "the member is looking at their own numbers" is never true of it -- the
  // channel is. See the header of lib/discord-profile.ts.
  ['lib/discord-profile.ts', 'get_leaderboard() only; no own-row carve-out because the card is public'],
  // The viewer's OWN row. The flag governs what everyone else sees.
  ['app/layout.tsx', "the signed-in member's own rating, in their own header"],
  // The profile page — gated, and asserted below.
  ['app/leaderboard/[playerId]/page.tsx', 'gated on hidesRatings'],
  // The picker source — nulls the figure, and asserted in
  // challengeable-opponents.test.ts.
  ['lib/challengeable-opponents.ts', 'returns null for an opted-out member'],
  ['app/challenges/new/new-challenge-client.tsx', 'handles the null and previews nothing'],
  // The viewer's own row again, reached other ways. Each was read to confirm
  // it is scoped to the signed-in member before it was written down here.
  ['app/feed/page.tsx', "own-record card; every other row's figures are already withheld"],
  ['app/my-stats/page.tsx', 'own ratings row; the ladder it counts against is get_leaderboard()'],
  ['app/my-stats/past-season.tsx', "season_final_ratings .eq('player_id', player.id)"],
  // The finished season's ladder. Driven FROM season_final_ratings rather than
  // from a player list, and it re-applies get_leaderboard()'s three predicates in
  // the app layer because its caller reads under the service role, which has no
  // database backstop behind it.
  ['lib/past-leaderboard.ts', 'drops any archived row whose member may not appear on a ladder today'],
  ['lib/onboarding-core.ts', 'a comment, no read (moved from lib/actions/profile.ts)'],
  ['lib/actions/_shared.ts', 'getPlayerProps, built from the acting member'],
  ['lib/posthog.ts', 'the analytics property type for that same self-identify'],
  ['components/posthog-identify.tsx', 'identifies the signed-in member to themselves'],
  ['lib/tournament-actions.ts', "elo_before for the entrant, .eq('player_id', player.id)"],
  // A Google Form's mutual doubles pair (00283): both members' doubles_elo is
  // read on the server to write the pair's combined rating, the figure every
  // pair carries. Neither member's own number is returned to the caller.
  ['lib/registration-import.ts', 'combined pair rating written server-side, never returned'],
]);

describe('another member\'s rating has a closed set of exits', () => {
  it('is named only in files that were reasoned about', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.includes('__tests__')) continue;
      const source = readFileSync(file, 'utf8');
      if (!/\b(singles_elo|doubles_elo)\b/.test(source)) continue;
      if (!ALLOWED.has(rel(file))) offenders.push(rel(file));
    }
    // The message names the rule rather than the symptom, because whoever sees
    // this failure is adding a screen, not debugging a test.
    expect(
      offenders,
      `these read another member's Elo and are not in the allowlist in ${rel(__filename)}. ` +
      'Either honour hide_from_leaderboard there, or add the file with the reason it is safe.',
    ).toEqual([]);
  });

  it('the profile page reads the flag and gates the figures on it', () => {
    const page = readFileSync(join(SRC, 'app/leaderboard/[playerId]/page.tsx'), 'utf8');

    // Read at all. Without the column there is nothing to gate on, and a
    // missing field arrives as `undefined` — which is falsy, so the gate would
    // silently pass everyone. The select moved into lib/public-profile.ts when
    // #11 took this page off the anon key; the column has to survive that move,
    // and the shape the page destructures has to carry it.
    const reader = readFileSync(join(SRC, 'lib/public-profile.ts'), 'utf8');
    expect(reader).toMatch(/select\([^)]*hide_from_leaderboard/);
    expect(reader).toMatch(/hide_from_leaderboard: data\.hide_from_leaderboard === true/);

    // Applied to OTHER people only. A member seeing their own numbers is not
    // the thing the switch turns off, and a gate without this clause would
    // hide a member's rating from themselves.
    expect(page).toMatch(/player\.hide_from_leaderboard === true && player\.id !== viewer\?\.id/);

    // And the deltas go with the cards. A run of per-match deltas beside a
    // known starting point reconstructs the withheld number, so hiding the
    // cards alone would leave the control looking closed and arithmetically
    // open.
    expect(page).toMatch(/typeof delta === 'number' && !hidesRatings/);
  });

  it('the past-season ladder names every predicate the database would have applied', () => {
    const page = readFileSync(join(SRC, 'app/leaderboard/page.tsx'), 'utf8');
    const rule =
      'the past-season ladder reads season_final_ratings under the SERVICE ROLE, which bypasses RLS ' +
      'and is not get_leaderboard(). Its query is the only thing standing between an opted-out ' +
      'member and a public standings table, so all three predicates have to be in it.';

    // The three predicates of get_leaderboard() (00092:749-751), restated.
    expect(page, rule).toMatch(/active_flag/);
    expect(page, rule).toMatch(/hide_from_leaderboard/);
    expect(page, rule).toMatch(/pending_approval/);
    expect(page, rule).toMatch(/suspended/);

    // AND THE DRIVE DIRECTION. The archive is the parent and `players` is the
    // embed: inverting it into a read of `players` with the snapshot embedded is
    // a left join from today's roster, which lists every present-day member in
    // the final standings of a season they were never in. `!inner` is what makes
    // the alias-path filters above drop a row rather than null the embed.
    const direction =
      'the past-season standings must be driven FROM season_final_ratings with players!inner. ' +
      'A left join from the current roster backfills members who were not in the season.';
    expect(page, direction).toMatch(/from\(['"]season_final_ratings['"]\)/);
    expect(page, direction).toMatch(/players!inner/);
    // Not `ratings`, in either branch: that table is cumulative and was rebased
    // at the rollover, so it is nobody's closing figure for a finished term.
    expect(page, direction).not.toMatch(/from\(['"]ratings['"]\)/);
  });
});
