import { PAGE_STYLE } from './docs-page.js';

// The public changelog served at /changelog. It shares the documentation
// page's single stylesheet, so the same CSP hash covers both: no other <style>
// block, no style="" attribute and no script.
//
// Newest first. The text is inserted as HTML, so escape any < or >.

const VERSIONS: { version: string; date: string; title: string; items: string[] }[] = [
  {
    version: '0.3.1',
    date: '2026-10-09',
    title: 'Freshness',
    items: [
      'Responses may now be up to 60 seconds old, up from 15: the roster, matches, ratings and seasons up to 60 seconds, tournaments, sessions and club events up to 30. A member\'s opt-out or deletion request reaches the feed within the same 60 seconds.',
      'A recent answer is reused only for the same consumer, and the same request written differently (an upper-case id, a timestamp with or without seconds) counts as the same request.',
      'A registration import refreshes your tournament entrant lists and event signups at once. A prediction write changes nothing you read.',
      'Under heavy load a request may wait briefly for the database; one that cannot be answered within 5 seconds is a <code>503</code> as before.',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-10-09',
    title: 'Registrations',
    items: [
      'A second write: <code>POST /v1/registrations</code> delivers one response from a Google Form an exec has bound to a tournament or a club event. It needs the new <code>registrations:write</code> scope, meant for the club\'s own form script; no existing key carries it.',
      'Each entry is answered <code>entered</code>, <code>pending</code> or <code>refused</code>, and a refusal names only something about the event. A member is never entered by a form: they confirm the entry in the club app.',
      'The same response sent again answers from the record with <code>replayed: true</code>; an edited response replaces the earlier one. A form with no active binding for the key is a <code>404</code>.',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-09',
    title: 'Predictions',
    items: [
      'The first write: <code>POST /v1/predictions</code> stores head-to-head win predictions from your model, and <code>DELETE /v1/predictions</code> removes your own. Both need the new <code>predictions:write</code> scope, which no existing key carries unless an exec adds it.',
      'A prediction names a <code>singles</code> or <code>doubles</code> matchup by <code>player_ref</code>, side A\'s chance of winning, a <code>model</code> name and <code>made_at</code>. A matchup is two unordered sides, so predicting it again replaces the earlier row.',
      'Up to 100 items a call. Each one is answered <code>created</code>, <code>replaced</code> or <code>refused</code>; the call is <code>422</code> with the same body when anything was refused.',
      'New errors on the write: <code>413</code> for a body over 64 KiB and <code>415</code> for a body not sent as <code>application/json</code>.',
      'Writes are never served from the read cache, and predictions never change a rating or a statistic.',
      'A member may see a prediction in the club app only for a challenge they play in, labelled as one with its model and time, never with the consumer that made it.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-09',
    title: 'First public version',
    items: [
      'Read-only, keyed access to club data. Each key is limited to the scopes it was granted: <code>players:read</code>, <code>matches:read</code>, <code>ratings:history:read</code>, <code>seasons:read</code>, <code>tournaments:read</code> and <code>schedule:read</code>.',
      'Players appear under a pseudonymous <code>player_ref</code> that is different for every consumer.',
      'Roster: <code>/v1/players</code> and <code>/v1/players/:ref</code>.',
      'Matches: <code>/v1/matches</code>, <code>/v1/matches/:match_ref</code>, a player\'s matches, head-to-head (<code>/v1/players/:ref/vs/:other_ref</code>), per-season records and rating history.',
      'Seasons: <code>/v1/seasons</code>, <code>/v1/seasons/:id</code> and standings.',
      'Tournaments: <code>/v1/tournaments</code>, a tournament, and an event with its entrants and draw, including staged events and external teams.',
      'Schedule: <code>/v1/sessions</code> and <code>/v1/events</code> (club events), filtered by <code>from</code> and <code>to</code>.',
      '<code>/health</code> and this API\'s documentation at <code>/documentations</code> need no key.',
      'This changelog at <code>/changelog</code>, also keyless.',
    ],
  },
];

export const CHANGELOG_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Club Ladder Data API changelog</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>Club Ladder Data API changelog</h1>
<p class="lede">What changed in each version of the API. The full reference is the <a href="/documentations">documentation</a>.</p>
${VERSIONS.map(
  (v) => `
<section>
<h2 id="v${v.version}">${v.version}: ${v.title}</h2>
<p class="lede">${v.date}</p>
<ul>
${v.items.map((item) => `<li>${item}</li>`).join('\n')}
</ul>
</section>`,
).join('\n')}
<footer><a href="/documentations">Documentation</a> · <a href="https://example.com/">Club Ladder</a></footer>
</main>
</body>
</html>
`;
