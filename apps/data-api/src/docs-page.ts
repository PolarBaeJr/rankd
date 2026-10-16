import { createHash } from 'node:crypto';

// The public documentation page served at /documentations. A module rather
// than a file on disk so the image needs nothing beyond dist/.
//
// It describes what server.ts, params.ts, auth.ts and rate-limit.ts DO. Drift
// tests in __tests__/server.test.ts and __tests__/routes.test.ts fail when a
// route, scope, query parameter or error code is missing from this page.
//
// The CSP allows exactly this one stylesheet by hash, so the page must carry
// no other <style> block and no style="" attribute. The changelog page
// (changelog-page.ts) shares the stylesheet and the CSP.

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1b1f24; --mute: #57606a; --line: #d0d7de; --code-bg: #f3f5f7; --accent: #b5121b; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0e1116; --fg: #e6edf3; --mute: #9aa4af; --line: #30363d; --code-bg: #161b22; --accent: #ff6b6b; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.9rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.35rem; margin: 2.5rem 0 0.75rem; padding-top: 0.5rem; border-top: 1px solid var(--line); }
h3 { font-size: 1.05rem; margin: 1.75rem 0 0.5rem; }
p, li { color: var(--fg); }
.lede { color: var(--mute); margin-top: 0; }
a { color: var(--accent); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
code { background: var(--code-bg); padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: 0.9rem 1rem; overflow-x: auto; line-height: 1.45; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; font-size: 0.95em; }
th, td { text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); padding: 0.4rem 0.5rem; }
th { color: var(--mute); font-weight: 600; }
nav { border: 1px solid var(--line); border-radius: 8px; padding: 0.75rem 1rem; margin: 1.5rem 0; }
nav ol { margin: 0.25rem 0 0; padding-left: 1.25rem; }
td code { white-space: nowrap; }
.note { border-left: 3px solid var(--accent); padding: 0.25rem 0 0.25rem 0.9rem; color: var(--mute); }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--mute); font-size: 0.9em; }
`;

export const PAGE_STYLE = STYLE;

export const DOCS_STYLE_HASH = `sha256-${createHash('sha256').update(STYLE).digest('base64')}`;

export const DOCS_CSP = [
  "default-src 'none'",
  `style-src '${DOCS_STYLE_HASH}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const EXAMPLE_REF = '9ec62d3216c769dacbc45fe6a696ef143669011e13e16e7215f7239bfc576544';
const EXAMPLE_REF_2 = 'deb9f2c86c09c08fc5bc0ecaab85117d6264378ff6c6e71f3d7bb833a8cd748e';
const EXAMPLE_MATCH = '4b1c0f7e2a9d8c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b';
const EXAMPLE_SEASON = '7d3f2a10-5b8e-4c21-9f6a-2e4d8b1c0a93';
const API = 'https://api.example.com';

export const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Club Ladder Data API</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Club Ladder Data API</h1>
<p class="lede">A key-authenticated JSON feed of pseudonymous ratings, match history, seasons, tournaments and the schedule of the club, and two writes: head-to-head win predictions, and registrations from the club's own sign-up forms.</p>

<nav aria-label="Contents">
<strong>Contents</strong>
<ol>
<li><a href="#purpose">What it is for</a></li>
<li><a href="#base-urls">Base URLs</a></li>
<li><a href="#authentication">Authentication</a></li>
<li><a href="#scopes">Scopes</a></li>
<li><a href="#who">Who and what is published</a></li>
<li><a href="#parameters">Query parameters and paging</a></li>
<li><a href="#endpoints">Endpoints</a></li>
<li><a href="#fields">Player fields</a></li>
<li><a href="#match-fields">Match fields</a></li>
<li><a href="#predictions">Predictions</a></li>
<li><a href="#registrations">Registrations</a></li>
<li><a href="#errors">Errors and status codes</a></li>
<li><a href="#rate-limits">Rate limits</a></li>
<li><a href="#versioning">Versioning and stability</a></li>
<li><a href="#changelog">Changelog</a></li>
<li><a href="#data-handling">Data handling</a></li>
<li><a href="#contact">Contact</a></li>
</ol>
</nav>

<h2 id="purpose">What it is for</h2>
<p>The API was built to support predicting the outcome of a challenge between two club members, and it now also serves the history, seasons, tournaments and schedule a club data pipeline needs.</p>
<p>It deliberately carries <strong>no names, emails, Discord handles, phone numbers, avatars, student numbers or member codes, and no free text written by or about a member</strong> (no notes, reasons, pair names or court labels). Every player is an object carrying a <code>player_ref</code>: a salted hash of their internal id. It is stable across requests, different for every consumer, and cannot be turned back into a person outside the club. Treat it as an opaque string. A match is identified the same way, by a <code>match_ref</code>.</p>
<p>Refs are salted per consumer, so data pulled with keys belonging to <strong>different consumers</strong> cannot be joined on <code>player_ref</code> or <code>match_ref</code>. Every key of one consumer sees the same refs.</p>

<h2 id="base-urls">Base URLs</h2>
<table>
<tr><th>Environment</th><th>Base URL</th></tr>
<tr><td>Production</td><td><code>${API}</code></td></tr>
</table>
<p>All responses except this page and <code>/changelog</code> are JSON (<code>application/json; charset=utf-8</code>) and are sent with <code>Cache-Control: no-store</code>. Every timestamp is ISO 8601 UTC to the second, for example <code>2026-10-02T18:30:12Z</code>. Dates without a time (<code>start_date</code>, a session's <code>date</code>) are <code>YYYY-MM-DD</code> in the club's local calendar.</p>

<h2 id="authentication">Authentication</h2>
<p>Every endpoint except <code>/health</code>, this page and <code>/changelog</code> needs a key, sent in the <code>Authorization</code> header:</p>
<pre><code>Authorization: Bearer clubld_&lt;43 characters&gt;</code></pre>
<ul>
<li>A key is <code>clubld_</code> followed by exactly 43 characters from <code>A-Z a-z 0-9 _ -</code>.</li>
<li>The scheme is the word <code>Bearer</code>, exactly one space, then the key. Anything else is treated as a missing key.</li>
<li>Keys are never accepted in the URL. Do not put one in a query string.</li>
</ul>
<p><strong>Getting a key.</strong> A club exec mints one in the Accounts page of the club's admin console, choosing its scopes and an optional expiry. The key is shown exactly once, at creation. The club stores only a hash, so nobody can recover a lost key; it is revoked and a new one issued. An exec can change the scopes of a live key without reissuing it.</p>
<p><strong>Revocation.</strong> Verification results are cached briefly. A revoked or expired key, or a scope change, takes effect within 30 seconds. A key that was rejected (for example, used a moment before it was minted) keeps being rejected for up to 5 seconds.</p>

<h2 id="scopes">Scopes</h2>
<p>A key is allowed nothing by default, only the scopes it was granted. One key may carry all eight. The six <code>:read</code> scopes only read; <code>predictions:write</code> and <code>registrations:write</code> are the two scopes that write, and no existing key carries either unless an exec adds it.</p>
<table>
<tr><th>Scope</th><th>Needed for</th></tr>
<tr><td><code>players:read</code></td><td><code>/v1/players</code>, <code>/v1/players/:ref</code></td></tr>
<tr><td><code>matches:read</code></td><td><code>/v1/matches</code>, <code>/v1/matches/:match_ref</code>, <code>/v1/players/:ref/matches</code>, <code>/v1/players/:ref/vs/:other_ref</code>, <code>/v1/players/:ref/seasons</code></td></tr>
<tr><td><code>ratings:history:read</code></td><td><code>/v1/players/:ref/ratings</code></td></tr>
<tr><td><code>seasons:read</code></td><td><code>/v1/seasons</code>, <code>/v1/seasons/:id</code>, <code>/v1/seasons/:id/standings</code></td></tr>
<tr><td><code>tournaments:read</code></td><td><code>/v1/tournaments</code>, <code>/v1/tournaments/:id</code>, <code>/v1/tournaments/:id/events/:event_id</code></td></tr>
<tr><td><code>schedule:read</code></td><td><code>/v1/sessions</code>, <code>/v1/events</code></td></tr>
<tr><td><code>predictions:write</code></td><td><code>POST /v1/predictions</code>, <code>DELETE /v1/predictions</code></td></tr>
<tr><td><code>registrations:write</code></td><td><code>POST /v1/registrations</code>. For the club's own form script, not for outside consumers.</td></tr>
</table>
<p>A valid key without the needed scope gets <code>403</code>.</p>

<h2 id="who">Who and what is published</h2>
<p>Two tests decide which members appear, and they differ on purpose.</p>
<ul>
<li><strong>The roster</strong> (<code>/v1/players</code>, <code>/v1/players/:ref</code>, season standings): active, approved members who are not suspended, have not opted out of published rankings and have not requested deletion of their account.</li>
<li><strong>The history</strong> (every match, rating-history, head-to-head and per-season route): members who have not opted out, have not requested deletion and are not awaiting approval. A former or suspended member's past matches stay in the history under their ref, so a ref can appear in a match while <code>/v1/players/:ref</code> answers <code>404</code>.</li>
</ul>
<p><strong>One gate for matches.</strong> A club or tournament match is published only when it is final (confirmed, completed, a walkover, or voided), it is in a season the club has not hidden, and <strong>every</strong> player in it passes the history test. A match with even one unpublished player is left out entirely, not served with a gap. The same gate feeds every route that counts matches, so figures derived from different routes agree with each other.</p>
<p><strong>Reconciliation.</strong> Because whole matches are left out, figures you derive from the match routes are not expected to equal the lifetime counters in <code>/v1/players</code>. Those counters are kept by the club's own rating system and include matches this API does not publish. Treat derived figures (head-to-head, per-season records, standings records and season totals) as counts of what you can see, not as the official record.</p>
<p><code>count</code> in any list is the size of that response. A member who leaves a set simply stops appearing, with no tombstone and no notice.</p>

<h2 id="parameters">Query parameters and paging</h2>
<p>Routes that take parameters refuse any parameter they do not know, and a repeated parameter, with <code>400 {"error":"bad_request","parameter":"&lt;name&gt;"}</code>. <code>/v1/players</code> and <code>/v1/players/:ref</code> take no parameters and ignore the query string.</p>
<table>
<tr><th>Parameter</th><th>Value</th><th>Used by</th></tr>
<tr><td><code>season</code></td><td>season id (uuid)</td><td>matches, player matches, vs, ratings, tournaments</td></tr>
<tr><td><code>since</code>, <code>until</code></td><td>UTC timestamp ending in <code>Z</code>; <code>until</code> must be after <code>since</code></td><td>matches (on <code>played_at</code>), ratings (on <code>at</code>)</td></tr>
<tr><td><code>player</code></td><td><code>player_ref</code></td><td><code>/v1/matches</code>: matches this player played in</td></tr>
<tr><td><code>opponent</code></td><td><code>player_ref</code></td><td>matches where this player was on the other side; on <code>/v1/matches</code> it needs <code>player</code></td></tr>
<tr><td><code>type</code></td><td><code>singles</code> or <code>doubles</code></td><td>matches, vs, ratings</td></tr>
<tr><td><code>source</code></td><td><code>club</code> or <code>tournament</code></td><td>matches</td></tr>
<tr><td><code>rated</code></td><td><code>true</code> or <code>false</code></td><td>matches</td></tr>
<tr><td><code>status</code></td><td><code>final</code> (default: everything except voided), <code>voided</code>, or <code>all</code></td><td>matches</td></tr>
<tr><td><code>updated_since</code></td><td>UTC timestamp</td><td>matches: only rows changed after it, oldest change first</td></tr>
<tr><td><code>limit</code></td><td>1 to 500, default 100</td><td>matches, ratings</td></tr>
<tr><td><code>offset</code></td><td>0 to 100000, default 0</td><td>matches, ratings</td></tr>
<tr><td><code>from</code>, <code>to</code></td><td>UTC timestamp</td><td>sessions and events; see <a href="#schedule">the schedule</a></td></tr>
</table>
<p>Timestamps must be UTC and end in <code>Z</code>, for example <code>2026-09-01T00:00:00Z</code>. A bare date or an offset such as <code>-07:00</code> is a <code>400</code>.</p>
<p><strong>Paging.</strong> Paged responses carry <code>count</code>, <code>limit</code>, <code>offset</code> and <code>next_offset</code>. <code>next_offset</code> is the <code>offset</code> for the next page, or <code>null</code> on the last page. Offset paging over a set that changes between requests can skip or repeat a row, so it suits browsing, not syncing.</p>
<p><strong>Syncing.</strong> To keep a copy up to date, page <code>/v1/matches?status=all&amp;updated_since=&lt;last seen&gt;</code>, which is ordered by <code>updated_at</code> oldest first, and store the largest <code>updated_at</code> you received. A match that was voided, corrected or re-entered comes back with a newer <code>updated_at</code>. A match that stops being published (a player opted out, a season was hidden) does <strong>not</strong> come back; rebuild from scratch periodically to drop those.</p>

<h2 id="endpoints">Endpoints</h2>
<p>Every endpoint answers <code>GET</code> only, except <code>/v1/predictions</code>, which answers <code>POST</code> and <code>DELETE</code> only, and <code>/v1/registrations</code>, which answers <code>POST</code> only. Any other method, including <code>HEAD</code>, gets <code>405</code>. (This page and <code>/changelog</code> also answer <code>HEAD</code>.) In the examples, <code>$K</code> holds your key.</p>

<h3 id="health">GET /health</h3>
<p>No key. For uptime checks. <code>version</code> is the service's release version.</p>
<pre><code>curl -s ${API}/health</code></pre>
<pre><code>{ "ok": true, "version": "0.3.1" }</code></pre>

<h3 id="players">GET /v1/players</h3>
<p>Requires <code>players:read</code>. Every player on the roster, one object each, with their <strong>lifetime</strong> ratings and counters.</p>
<pre><code>curl -s -H "Authorization: Bearer $K" ${API}/v1/players</code></pre>
<pre><code>{
  "season": {
    "id": "${EXAMPLE_SEASON}",
    "name": "Fall 2026",
    "term": "fall",
    "year": 2026,
    "start_date": "2026-09-01",
    "end_date": "2026-12-15"
  },
  "generated_at": "2026-10-02T18:30:12Z",
  "count": 1,
  "players": [
    {
      "player_ref": "${EXAMPLE_REF}",
      "singles_elo": 1150,
      "doubles_elo": 1020,
      "singles_provisional": false,
      "doubles_provisional": true,
      "singles_matches_played": 4,
      "doubles_matches_played": 0,
      "singles_wins": 3,
      "singles_losses": 1,
      "doubles_wins": 0,
      "doubles_losses": 0,
      "updated_at": "2026-09-20T03:15:40Z"
    }
  ]
}</code></pre>
<p><code>season</code> is the club's active season, for context only: the player figures are lifetime totals and cannot be sliced by it. It is <code>null</code> when there is no active season, when the active season is hidden, or when it could not be read.</p>

<h3 id="player">GET /v1/players/:ref</h3>
<p>Requires <code>players:read</code>. One player on the roster, the same object as an item of <code>players</code> above, with no wrapper. A ref not on the roster, or not a <code>player_ref</code> at all, gets <code>404</code>.</p>
<pre><code>curl -s -H "Authorization: Bearer $K" ${API}/v1/players/${EXAMPLE_REF}</code></pre>

<h3 id="matches">GET /v1/matches</h3>
<p>Requires <code>matches:read</code>. Published club and tournament matches, newest first by <code>played_at</code> (oldest change first with <code>updated_since</code>). Parameters: <code>season</code>, <code>since</code>, <code>until</code>, <code>player</code>, <code>opponent</code>, <code>type</code>, <code>source</code>, <code>rated</code>, <code>status</code>, <code>updated_since</code>, <code>limit</code>, <code>offset</code>.</p>
<pre><code>curl -s -H "Authorization: Bearer $K" \\
  "${API}/v1/matches?season=${EXAMPLE_SEASON}&amp;type=singles&amp;limit=50"</code></pre>
<pre><code>{
  "generated_at": "2026-10-02T18:30:12Z",
  "count": 1,
  "limit": 50,
  "offset": 0,
  "next_offset": null,
  "matches": [
    {
      "match_ref": "${EXAMPLE_MATCH}",
      "source": "club",
      "status": "confirmed",
      "counts_toward_stats": true,
      "played_at": "2026-09-29T02:41:07Z",
      "updated_at": "2026-09-29T02:44:51Z",
      "season": { "id": "${EXAMPLE_SEASON}", "name": "Fall 2026" },
      "type": "singles",
      "kind": "ranked",
      "rated": true,
      "format": "best_of_3",
      "games_per_match": 3,
      "points_per_game": 21,
      "walkover": null,
      "winner_side": "a",
      "score_summary": "21-17, 19-21, 21-15",
      "games": [
        { "game": 1, "a": 21, "b": 17 },
        { "game": 2, "a": 19, "b": 21 },
        { "game": 3, "a": 21, "b": 15 }
      ],
      "sides": {
        "a": [ { "player_ref": "${EXAMPLE_REF}", "won": true,
                 "rating": { "before": 1134, "after": 1150, "delta": 16 },
                 "points_scored": 61, "points_allowed": 53, "games_won": 2, "games_lost": 1 } ],
        "b": [ { "player_ref": "${EXAMPLE_REF_2}", "won": false,
                 "rating": { "before": 836, "after": 820, "delta": -16 },
                 "points_scored": 53, "points_allowed": 61, "games_won": 1, "games_lost": 2 } ]
      },
      "tournament": null
    }
  ]
}</code></pre>

<h3 id="match">GET /v1/matches/:match_ref</h3>
<p>Requires <code>matches:read</code>. One published match, of any status, as <code>{ "generated_at": ..., "match": { ... } }</code>. <code>404</code> for a ref that is not published to you.</p>

<h3 id="player-matches">GET /v1/players/:ref/matches</h3>
<p>Requires <code>matches:read</code>. The same as <code>/v1/matches?player=:ref</code>, with <code>player_ref</code> added to the envelope. Takes every <code>/v1/matches</code> parameter except <code>player</code>; <code>opponent</code> works on its own here. <code>404</code> when the ref does not pass the history test.</p>

<h3 id="vs">GET /v1/players/:ref/vs/:other_ref</h3>
<p>Requires <code>matches:read</code>. Head to head, derived from published matches that count toward stats. Parameters: <code>type</code>, <code>season</code>. <code>404</code> when either ref does not pass the history test, or when both refs are the same.</p>
<pre><code>{
  "generated_at": "2026-10-02T18:30:12Z",
  "player_ref": "${EXAMPLE_REF}",
  "other_ref": "${EXAMPLE_REF_2}",
  "as_opponents": {
    "singles": { "matches": 3, "wins": 2, "losses": 1 },
    "doubles": { "matches": 0, "wins": 0, "losses": 0 }
  },
  "as_partners": { "doubles": { "matches": 1, "wins": 1, "losses": 0 } },
  "recent": [ ... up to 10 match objects, newest first, where they met as opponents ... ]
}</code></pre>
<p>Wins and losses are from <code>:ref</code>'s point of view. <code>as_partners</code> counts doubles matches they played on the same side.</p>

<h3 id="player-seasons">GET /v1/players/:ref/seasons</h3>
<p>Requires <code>matches:read</code>. One entry per visible season the player has a published match or a final rating in, newest first. The records are derived from published matches that count toward stats; <code>final_rating</code> is the rating the club archived when the season closed, or <code>null</code>.</p>
<pre><code>{
  "generated_at": "2026-10-02T18:30:12Z",
  "player_ref": "${EXAMPLE_REF}",
  "count": 1,
  "seasons": [
    {
      "season": { "id": "${EXAMPLE_SEASON}", "name": "Fall 2026", "active": true, "start_date": "2026-09-01" },
      "singles": { "matches": 4, "wins": 3, "losses": 1, "games_won": 7, "games_lost": 3,
                   "points_scored": 201, "points_allowed": 166 },
      "doubles": { "matches": 0, "wins": 0, "losses": 0, "games_won": 0, "games_lost": 0,
                   "points_scored": 0, "points_allowed": 0 },
      "final_rating": null
    }
  ]
}</code></pre>

<h3 id="player-ratings">GET /v1/players/:ref/ratings</h3>
<p>Requires <code>ratings:history:read</code>. Every rating change the club recorded for this player, oldest first. Parameters: <code>type</code>, <code>season</code>, <code>since</code>, <code>until</code>, <code>limit</code>, <code>offset</code>. Paged like <code>/v1/matches</code>, with the rows under <code>history</code>.</p>
<pre><code>{ "at": "2026-09-29T02:44:51Z", "type": "singles", "kind": "match", "source": "club",
  "match_ref": "${EXAMPLE_MATCH}", "before": 1134, "after": 1150, "delta": 16 }</code></pre>
<p><code>kind</code> is <code>match</code> for a rated club or tournament match (only published, non-voided ones), or <code>placement_bonus</code> for a tournament placement bonus, which has <code>source</code> <code>tournament</code> and <code>match_ref</code> <code>null</code>. Rating changes the club made by hand are not in the history, so consecutive rows need not chain.</p>

<h3 id="seasons">GET /v1/seasons</h3>
<p>Requires <code>seasons:read</code>. Every season the club has not hidden, newest first, with totals. The match and player totals are derived from published matches; <code>sessions</code>, <code>tournaments</code> and <code>events</code> count what falls in the season.</p>
<pre><code>{
  "generated_at": "2026-10-02T18:30:12Z",
  "count": 1,
  "seasons": [
    {
      "id": "${EXAMPLE_SEASON}", "name": "Fall 2026", "term": "fall", "year": 2026,
      "start_date": "2026-09-01", "end_date": "2026-12-15", "active": true,
      "totals": { "club_matches": 41, "tournament_matches": 12, "players_with_matches": 23,
                  "sessions": 9, "tournaments": 1, "events": 2 }
    }
  ]
}</code></pre>

<h3 id="season">GET /v1/seasons/:id</h3>
<p>Requires <code>seasons:read</code>. One season, as <code>{ "generated_at": ..., "season": { ... } }</code>. <code>404</code> for a hidden or unknown season.</p>

<h3 id="standings">GET /v1/seasons/:id/standings</h3>
<p>Requires <code>seasons:read</code>. The roster ranked for one season. For the active season the <code>source</code> is <code>live</code> and the ratings are current; for a closed season it is <code>archived</code> and the ratings are the ones the club archived when it closed. Ranks are standard competition ranks (ties share a rank). <code>record</code> is derived from published matches in that season.</p>
<pre><code>{
  "generated_at": "2026-10-02T18:30:12Z",
  "season": { "id": "${EXAMPLE_SEASON}", "name": "Fall 2026", "active": true },
  "source": "live",
  "count": 1,
  "standings": [
    { "player_ref": "${EXAMPLE_REF}", "singles_elo": 1150, "doubles_elo": 1020,
      "singles_rank": 1, "doubles_rank": 1, "record": { "matches": 4, "wins": 3, "losses": 1 } }
  ]
}</code></pre>

<h3 id="tournaments">GET /v1/tournaments</h3>
<p>Requires <code>tournaments:read</code>. Every tournament past the draft stage in a visible season, newest first. Parameter: <code>season</code>. Each has <code>id</code>, <code>name</code>, <code>season</code>, <code>start_date</code>, <code>end_date</code>, <code>status</code>, <code>suspended</code>, <code>event_multiplier</code> and <code>placement_bonus_enabled</code>.</p>

<h3 id="tournament">GET /v1/tournaments/:id</h3>
<p>Requires <code>tournaments:read</code>. One tournament with its events, and each event's entrants:</p>
<pre><code>{ "players": [ { "player_ref": "${EXAMPLE_REF}" }, { "player_ref": "${EXAMPLE_REF_2}" } ],
  "external": false, "external_ref": null,
  "seed": 1, "status": "active", "final_position": 1, "group": null, "points": null,
  "elo": { "before": null, "after": null, "change": null }, "combined_elo": 2170,
  "team_category": "mixed" }</code></pre>
<p>A singles entrant has one player; a pair has two. An entrant with a player who fails the history test is left out (a pair needs both players to pass), so seeds may have gaps. Pair names are never served. <code>team_category</code> is the category key a team plays as in a staged event, or <code>null</code>.</p>
<p>Each event has <code>id</code>, <code>event_type</code>, <code>format</code>, <code>match_format</code>, <code>games_per_match</code>, <code>points_per_game</code>, <code>max_participants</code>, <code>seeding_method</code>, <code>elo_multiplier</code>, <code>placement_bonus_enabled</code>, <code>status</code>, <code>group_count</code>, <code>qualifiers_per_group</code>, <code>seeded_from_event_id</code>, <code>rated</code> (whether the event moves ratings at all), <code>current_stage</code>, <code>external</code>, <code>stages</code>, <code>categories</code>, <code>head_starts</code> and <code>points_table</code>.</p>
<p><strong>Staged events.</strong> An event with <code>"format": "staged"</code> is played as a list of stages. <code>stages</code> lists them in order, each with <code>index</code> (1-based), <code>key</code>, <code>name</code>, <code>kind</code> (<code>groups</code>, <code>knockout</code> or <code>matches</code>), <code>rated</code> and <code>scoring</code> (<code>{ best_of, target, win_by_two, cap, handicap, forfeit }</code>); a groups stage adds <code>pools</code>, <code>groups_per_pool</code>, <code>group_size</code> (a number or <code>"auto"</code>) and <code>tiebreaks</code>, a knockout <code>size</code> and <code>third_place</code>, a matches stage <code>matches</code> (<code>[{ label, name, winner_place, loser_place }]</code>), and a field a stage's kind does not use is <code>null</code>. <code>current_stage</code> is the latest stage drawn. <code>categories</code> is <code>[{ key, label }]</code> (<code>null</code> means <code>mens</code>, <code>womens</code> and <code>mixed</code>), and <code>head_starts</code> maps a row category to a column category to the points the row team starts each game on, for example <code>{ "womens": { "mens": 3 } }</code>. On any other event those three are <code>null</code>.</p>
<p><strong>Points table.</strong> <code>points_table</code> is <code>{ by_place, rest, participation, per_win }</code>, the ladder points the event pays: <code>by_place[0]</code> is first place, a place past the list takes <code>rest</code>, and every entrant also gets <code>participation</code> plus <code>per_win</code> a win. <code>null</code> means the format's default: <code>single_elimination</code> and <code>pool_to_bracket</code> pay <code>[100, 75, 50, 40, 25, 25, 25, 25]</code> with <code>rest</code> 10; <code>round_robin</code> pays <code>participation</code> 1 and <code>per_win</code> 3; a staged event pays the first unless its last stage is groups.</p>
<p><strong>External teams.</strong> An event with <code>"external": true</code> is an unrated round robin of teams who are not club members. Such a team has <code>"players": []</code>, <code>"external": true</code> and an <code>external_ref</code>: opaque, stable and per consumer like a <code>player_ref</code>, naming the team rather than a person. Its names are never served.</p>

<h3 id="draw">GET /v1/tournaments/:id/events/:event_id</h3>
<p>Requires <code>tournaments:read</code>. One event and its draw: every slot in bracket order, with <code>match_ref</code>, <code>round_number</code>, <code>round_name</code>, <code>phase</code> (<code>pool</code> or <code>bracket</code>, <code>null</code> in a staged event), <code>bracket_position</code>, <code>match_number</code>, <code>is_bye</code>, <code>is_third_place</code>, <code>scheduled_time</code>, <code>status</code>, <code>winner_to</code> and <code>loser_to</code> (the <code>match_ref</code> and <code>position</code> a player advances to), <code>sides</code>, <code>winner_side</code> and <code>games</code>, then <code>stage</code>, <code>pool_number</code>, <code>group_number</code>, <code>slot</code>, <code>match_label</code>, <code>handicap_a</code> and <code>handicap_b</code>.</p>
<p><strong>Stages and head starts.</strong> A slot in a staged event has <code>stage</code> (the 1-based index into the event's <code>stages</code>), <code>pool_number</code>, <code>group_number</code>, <code>slot</code> and <code>match_label</code> (the <code>label</code> of a named match); elsewhere they are <code>null</code>. <code>handicap_a</code> and <code>handicap_b</code> are the points each side started every game on (<code>0</code> outside a staged event). Recorded scores include the head start, so subtract it for the points won from play. A withheld slot keeps its stage fields and has both handicaps <code>null</code>.</p>
<p><strong>Withheld slots.</strong> A slot that is disputed, or has a player who fails the history test, keeps its place with <code>"withheld": true</code> and <code>sides</code>, <code>winner_side</code> and <code>games</code> all <code>null</code>, so the shape of the bracket survives without saying who played. Court labels are never served.</p>
<p><strong>Sides.</strong> Each side is a list of <code>{ player_ref, external, external_ref }</code>: one element per member with <code>"external": false</code>, or a single element <code>{ "player_ref": null, "external": true, "external_ref": "..." }</code> for an external team. A slot in an external event is withheld only when disputed. External matches move no rating and are not in <code>/v1/matches</code>. A staged event of club members with <code>"rated": false</code> is different: its matches are member matches, so they are in <code>/v1/matches</code> with <code>"rated": false</code>.</p>

<h3 id="schedule">GET /v1/sessions and GET /v1/events</h3>
<p>Require <code>schedule:read</code>. Club sessions and club events that start in a window, soonest first. Parameters: <code>from</code> and <code>to</code>. With neither, the window is the next 30 days; with one, the window is 30 days on its other side. <code>to</code> must be after <code>from</code> and the window at most 366 days, or it is a <code>400</code> naming <code>to</code>. The envelope echoes <code>from</code> and <code>to</code>.</p>
<p>A session has <code>id</code>, <code>name</code>, <code>season</code>, <code>date</code>, <code>starts_at</code>, <code>ends_at</code>, <code>location</code>, <code>status</code>, <code>track</code>, <code>require_scan_to_check_in</code> and <code>counts</code> (<code>rsvp_going</code>, <code>attended</code>). An event has <code>id</code>, <code>title</code>, <code>kind</code>, <code>location</code>, <code>starts_at</code>, <code>ends_at</code>, <code>status</code> (<code>published</code> or <code>cancelled</code>), <code>cancelled_at</code>, <code>capacity</code>, <code>cost_cents</code>, <code>signup_opens_at</code>, <code>signup_closes_at</code> and <code>counts</code> (<code>signups</code>). Only counts are served: never who is going, who attended or who signed up.</p>

<h3 id="post-predictions">POST /v1/predictions</h3>
<p>Requires <code>predictions:write</code>. Stores head-to-head win predictions; see <a href="#predictions">Predictions</a> for what they are and how members see them. The body is JSON (<code>Content-Type: application/json</code>, at most 64 KiB): <code>{ "predictions": [ ... ] }</code> with 1 to 100 items, or one item on its own.</p>
<pre><code>curl -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \\
  -d '{"predictions":[{"format":"doubles","side_a":["&lt;ref&gt;","&lt;ref&gt;"],"side_b":["&lt;ref&gt;","&lt;ref&gt;"],"probability":0.64,"model":"elo-v3","made_at":"2026-10-08T18:00:00Z"}]}' \\
  ${API}/v1/predictions</code></pre>
<p>Each item has exactly these fields: <code>format</code> (<code>singles</code> or <code>doubles</code>), <code>side_a</code> and <code>side_b</code> (one <code>player_ref</code> each for singles, two for doubles, no player twice), <code>probability</code> (side A's chance of winning, a number from 0 to 1), <code>model</code> (1 to 64 characters from <code>A-Z a-z 0-9</code>, space and <code>. _ : + -</code>) and <code>made_at</code> (UTC, ending in <code>Z</code>, not more than 5 minutes ahead of the server clock).</p>
<pre><code>{ "results": [ { "index": 0, "status": "created" }, { "index": 1, "status": "refused", "reason": "player" } ],
  "created": 1, "replaced": 0, "refused": 1 }</code></pre>
<p>Each item is <code>created</code>, <code>replaced</code> (you had already predicted that matchup) or <code>refused</code>. The response is <code>200</code> when nothing was refused and <code>422</code>, with the same body, when anything was. <code>reason</code> <code>player</code> means a ref is unknown to you or names a member who is not published; it deliberately does not say which. A malformed body is a <code>400</code> naming the <code>field</code>, for example <code>predictions[3].side_b</code>, and nothing in it is stored.</p>

<h3 id="delete-predictions">DELETE /v1/predictions</h3>
<p>Requires <code>predictions:write</code>. Removes your own predictions by matchup: <code>{ "matchups": [ { "format", "side_a", "side_b" } ] }</code>, 1 to 100 items, sides in either order. Each item is <code>deleted</code> or <code>not_found</code>, with <code>deleted</code>, <code>not_found</code> and <code>refused</code> counts. A ref that names nobody you can see is <code>not_found</code>.</p>

<h3 id="post-registrations">POST /v1/registrations</h3>
<p>Requires <code>registrations:write</code>. Delivers one response from a Google Form an exec has bound to a tournament or a club event; see <a href="#registrations">Registrations</a>. The body is JSON, at most 64 KiB: <code>{ "form_id", "response_id", "submitted_at"?, "email", "name", "entries"? }</code>, where each of up to 20 <code>entries</code> is <code>{ "event_id", "partner_email"?, "partner_name"?, "category"? }</code>. A club event form sends no entries.</p>
<pre><code>curl -s -X POST -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \\
  -d '{"form_id":"&lt;form id&gt;","response_id":"&lt;response id&gt;","email":"&lt;email&gt;","name":"&lt;name&gt;","entries":[{"event_id":"&lt;event id&gt;","partner_name":"&lt;name&gt;"}]}' \\
  ${API}/v1/registrations</code></pre>
<pre><code>{ "replayed": false, "entered": 1, "pending": 0, "refused": 0,
  "results": [ { "index": 1, "event_id": "&lt;event id&gt;", "status": "entered", "reason": null } ] }</code></pre>
<p>Each entry is <code>entered</code>, <code>pending</code> (a member must confirm it in the club app, a partner has not answered yet, or an exec must look at it) or <code>refused</code>. A refusal's <code>reason</code> is only ever about the event: <code>event_full</code>, <code>waitlist_queue</code>, <code>registration_closed</code>, <code>registration_not_open</code>, <code>registration_window_closed</code>, <code>event_not_in_target</code> or <code>duplicate_in_submission</code>. Nothing in the answer says whether an email belongs to a member. Sending the same response again answers from the record with <code>replayed: true</code>; an edited response replaces the earlier one. A form with no active binding for your key is a <code>404</code>, and a malformed body a <code>400</code> naming the <code>field</code>.</p>

<h3 id="documentations">GET /documentations</h3>
<p>This page. No key. Also served at <code>/documentations/</code>.</p>

<h3 id="changelog">GET /changelog</h3>
<p>What changed in each version of this API. No key. Also served at <code>/changelog/</code>.</p>

<h2 id="fields">Player fields</h2>
<table>
<tr><th>Field</th><th>Type</th><th>Meaning</th></tr>
<tr><td><code>player_ref</code></td><td>string</td><td>Opaque pseudonym, stable, different per consumer. Currently 64 lowercase hex characters; do not rely on that.</td></tr>
<tr><td><code>singles_elo</code>, <code>doubles_elo</code></td><td>number</td><td>Current rating on each ladder, roughly 400 to 1400. Singles and doubles are separate ladders; do not average them or use one to predict the other. A new member's starting rating is assigned by skill tier, not earned.</td></tr>
<tr><td><code>singles_provisional</code>, <code>doubles_provisional</code></td><td>boolean</td><td><code>true</code> while the rating is still settling. A provisional rating is a guess; weight it accordingly or exclude it.</td></tr>
<tr><td><code>singles_matches_played</code>, <code>doubles_matches_played</code></td><td>integer</td><td>Rated matches only.</td></tr>
<tr><td><code>singles_wins</code>, <code>singles_losses</code>, <code>doubles_wins</code>, <code>doubles_losses</code></td><td>integer</td><td>Rated matches only. Wins plus losses need not equal matches played; derive a win rate from wins and losses.</td></tr>
<tr><td><code>updated_at</code></td><td>string</td><td>When the rating row last changed.</td></tr>
</table>
<p>All figures are <strong>lifetime</strong> totals kept by the club, not per season, and not derived from the match routes (see <a href="#who">reconciliation</a>). A field the database has no value for is <code>null</code>, so parse defensively. A reasonable prediction baseline is the Elo expectation: <code>P(A beats B) = 1 / (1 + 10 ** ((elo_B - elo_A) / 400))</code>.</p>

<h2 id="match-fields">Match fields</h2>
<table>
<tr><th>Field</th><th>Meaning</th></tr>
<tr><td><code>match_ref</code></td><td>Opaque, stable, per consumer, like <code>player_ref</code>.</td></tr>
<tr><td><code>source</code></td><td><code>club</code> (a match recorded at a session or a challenge) or <code>tournament</code>.</td></tr>
<tr><td><code>status</code></td><td>Club: <code>confirmed</code>, <code>walkover</code> or <code>voided</code>. Tournament: <code>completed</code>, <code>walkover</code> or <code>voided</code>.</td></tr>
<tr><td><code>counts_toward_stats</code></td><td><code>true</code> for a played, non-voided result. Walkovers and voided matches are <code>false</code>. Every derived record in this API counts only these.</td></tr>
<tr><td><code>played_at</code></td><td>When it was played. For a tournament match, when its result was entered, else its scheduled time.</td></tr>
<tr><td><code>updated_at</code></td><td>When the row last changed. Use it with <code>updated_since</code>.</td></tr>
<tr><td><code>season</code></td><td><code>{ id, name }</code>, or <code>null</code>. A tournament match belongs to its tournament's season.</td></tr>
<tr><td><code>type</code></td><td><code>singles</code> or <code>doubles</code>.</td></tr>
<tr><td><code>kind</code>, <code>format</code>, <code>games_per_match</code>, <code>points_per_game</code></td><td>How the match was set up. <code>kind</code> is the club's match kind, or <code>tournament</code>.</td></tr>
<tr><td><code>rated</code></td><td>Whether it moved ratings.</td></tr>
<tr><td><code>walkover</code></td><td><code>null</code>, or for a club walkover <code>{ type, forfeit_side }</code>, or for a tournament walkover <code>{ winner_side }</code>. Reasons are never served.</td></tr>
<tr><td><code>winner_side</code></td><td><code>a</code>, <code>b</code> or <code>null</code>.</td></tr>
<tr><td><code>score_summary</code>, <code>games</code></td><td>The score as the club shows it, and per game <code>{ game, a, b }</code>.</td></tr>
<tr><td><code>sides</code></td><td><code>{ a: [...], b: [...] }</code>, one object per player: <code>player_ref</code>, <code>won</code>, <code>rating</code> (<code>{ before, after, delta }</code>, or <code>null</code> when the match was unrated or voided), <code>points_scored</code>, <code>points_allowed</code>, <code>games_won</code>, <code>games_lost</code>.</td></tr>
<tr><td><code>tournament</code></td><td><code>null</code> for a club match; otherwise <code>{ id, event_id, event_type, round_number, round_name, phase, is_third_place, stage, match_label, handicap_a, handicap_b }</code>. The last four describe a staged event's match (<code>null</code>, and <code>0</code> for the handicaps, elsewhere); the games include the head starts.</td></tr>
</table>

<h2 id="predictions">Predictions</h2>
<ul>
<li><strong>A matchup is two unordered sides.</strong> Sending A and B against C and D is the same matchup as D and C against B and A. A prediction for a matchup you already predicted replaces the earlier one, and <code>probability</code> is always the chance of the side you sent as <code>side_a</code>, so swap it to <code>1 - p</code> if you swap the sides.</li>
<li><strong>Only published players.</strong> Every ref must name a member who passes the history test above. A member who later opts out or asks for deletion disappears from every prediction at once, and their predictions are erased when their account is.</li>
<li><strong>Predictions never change ratings.</strong> Nothing that rates a match or builds a statistic reads them. A member may be shown a prediction in the club app only for a challenge they play in, labelled as a prediction, with the <code>model</code> name and <code>made_at</code>, but never which consumer made it. When two consumers predict the same matchup, members see the newer one.</li>
<li><strong>One request, whatever the batch.</strong> A batch of 100 spends one unit of the key's rate budget. Writes are never served from the read cache.</li>
<li>Every write and delete is recorded against the key, with counts and no players.</li>
</ul>

<h2 id="registrations">Registrations</h2>
<ul>
<li><strong>The club's own forms only.</strong> An exec binds a Google Form to one tournament or club event in the admin console, against the key the form's script uses. A response for any other form is a <code>404</code>.</li>
<li><strong>Members confirm their own entries.</strong> A response from a member's email never enters them. It leaves an entry waiting in the club app, and the member confirms it there, where the usual rules and fees apply.</li>
<li><strong>Non-members enter only events open to them.</strong> They are entered at once, owe the fee as a named entry, and are sent the guest waiver once that feature is on. Doubles teams of two non-members are entered as one team.</li>
<li><strong>Nothing is logged.</strong> The body carries a typed name and email; the service never writes it to its log, and the club's record of each import names no email.</li>
</ul>

<h2 id="errors">Errors and status codes</h2>
<p>Every error is a JSON object with an <code>error</code> string. A <code>403</code> also carries a <code>detail</code> string, and a <code>400</code> a <code>parameter</code> string, or on <code>/v1/predictions</code> and <code>/v1/registrations</code> a <code>field</code> string.</p>
<pre><code>{ "error": "forbidden", "detail": "this key does not carry players:read" }
{ "error": "bad_request", "parameter": "since" }</code></pre>
<table>
<tr><th>Status</th><th><code>error</code></th><th>When</th></tr>
<tr><td><code>200</code></td><td></td><td>Success.</td></tr>
<tr><td><code>400</code></td><td><code>bad_request</code></td><td>A query parameter the route does not take, a repeated one, or a value that does not parse. <code>parameter</code> names it. On <code>/v1/predictions</code> and <code>/v1/registrations</code>, a body that is not valid JSON or not the documented shape; <code>field</code> names it.</td></tr>
<tr><td><code>401</code></td><td><code>unauthorized</code></td><td>Key missing, malformed, unknown, expired or revoked. Deliberately identical in all five cases, with a <code>WWW-Authenticate: Bearer</code> header. A write is also refused this way when the key was revoked or lost its write scope in the last 30 seconds.</td></tr>
<tr><td><code>403</code></td><td><code>forbidden</code></td><td>Valid key without the scope this endpoint needs.</td></tr>
<tr><td><code>404</code></td><td><code>not_found</code></td><td>No such route, or a ref or id in the path that is malformed, unknown or not published to you. On <code>/v1/registrations</code>, a form with no active binding for your key.</td></tr>
<tr><td><code>405</code></td><td><code>method_not_allowed</code></td><td>A method the route does not answer: anything but <code>GET</code> on a read route, anything but <code>POST</code> or <code>DELETE</code> on <code>/v1/predictions</code>, anything but <code>POST</code> on <code>/v1/registrations</code>, and anything but <code>GET</code> or <code>HEAD</code> on this page and <code>/changelog</code>. The <code>Allow</code> header lists what is accepted.</td></tr>
<tr><td><code>413</code></td><td><code>payload_too_large</code></td><td>A write body over 64 KiB.</td></tr>
<tr><td><code>415</code></td><td><code>unsupported_media_type</code></td><td>A write body not sent as <code>Content-Type: application/json</code>.</td></tr>
<tr><td><code>422</code></td><td></td><td>A write where at least one item was refused. The body is the usual results, not an error object.</td></tr>
<tr><td><code>429</code></td><td><code>rate_limited</code></td><td>A rate limit was hit. The <code>Retry-After</code> header gives whole seconds to wait.</td></tr>
<tr><td><code>503</code></td><td><code>unavailable</code></td><td>The club's database could not be reached or answered with an error. Retry later with backoff.</td></tr>
</table>
<p>Checks run in this order: route (<code>404</code>), method (<code>405</code>), key (<code>401</code>, or <code>429</code> from the per-address limit below), per-key rate (<code>429</code>), scope (<code>403</code>), query parameters (<code>400</code>), then the refs and ids in the path (<code>404</code>), and for a write the body (<code>415</code>, <code>413</code>, <code>400</code>). So a request without a valid key never learns whether a ref exists, and a request refused for scope or parameters still spends one unit of the key's rate budget.</p>

<h2 id="rate-limits">Rate limits</h2>
<ul>
<li><strong>Per key: 60 requests per minute.</strong> A token bucket holding 60, refilling at one per second, so a burst of 60 is allowed and then one request per second.</li>
<li><strong>Per client address: 30 failed key lookups per minute.</strong> Every <code>401</code> spends one, including a missing or malformed header. When the budget is empty, a well-formed key that the server has not checked recently gets <code>429</code> instead of being looked up. A missing or malformed header still gets <code>401</code>, as does a key rejected in the last 5 seconds, and a key verified in the last 30 seconds is not affected by this limit.</li>
<li><code>/health</code>, this page and <code>/changelog</code> are not rate-limited by key.</li>
<li>The limits are enforced per server process, and the club's network edge applies its own limits in front of them. Do not rely on the exact figures; honour <code>Retry-After</code>.</li>
</ul>
<p>The data changes slowly. Pull the roster on a schedule measured in hours, and keep match history in sync with <code>updated_since</code> rather than re-reading it.</p>
<p>Responses may be up to 60 seconds old: the server reuses a recent answer to the same request from the same consumer rather than asking the database again. The roster, matches, ratings and seasons may be up to 60 seconds old; tournaments, sessions and club events up to 30 seconds. A registration import refreshes that consumer's tournament entrant lists and event signups at once. A member's opt-out or deletion request reaches the feed within the same 60 seconds. <code>generated_at</code> is when the response was sent, not when the data was read.</p>

<h2 id="versioning">Versioning and stability</h2>
<p>The <code>/v1</code> prefix is the contract. Within it, new fields and new routes may be added, and existing fields will not be removed or change meaning. Ignore fields you do not recognise. A breaking change becomes <code>/v2</code>. <code>/health</code> reports the running version. See the <a href="/changelog">changelog</a> for what changed in each version.</p>

<h2 id="data-handling">Data handling</h2>
<p>This is real data about real people, shared under a named key that identifies who received it.</p>
<ul>
<li>Do not attempt to re-identify players, including by combining match times with the club's public pages.</li>
<li>Do not redistribute the data or publish it as a dataset.</li>
<li>Keep the key out of version control, URLs and logs.</li>
<li>Tell the club if a key leaks; it will be revoked and reissued.</li>
</ul>

<h2 id="contact">Contact</h2>
<p>For a key, a scope change, a leaked key or a question about the data, contact the club exec, for example through the club Discord at <a href="https://discord.example.com">discord.example.com</a>.</p>
<footer><a href="/changelog">Changelog</a> · <a href="https://example.com/">Club Ladder</a></footer>
</main>
</body>
</html>
`;
