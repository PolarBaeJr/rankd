# Club Ladder Data API

**Status: version 0. Implemented in `apps/data-api`: roster, match history,
head-to-head, per-season records, rating history, seasons and standings,
tournaments and draws, the schedule, and one write, head-to-head win
predictions (20 routes, listed under "Endpoints").
The reference the service serves at `/documentations` describes what the code
does, route by route and field by field; see also "Known gaps" in
[`README.md`](./README.md).**

This file is the contract. It was written before the service, deliberately, so
that the field names, the scopes and the error shapes were settled while they
were still free to change. The implementation follows this document; where they
disagree, this document is the bug report.

Base URL, once live:

| Environment | Host |
|---|---|
| Production | `https://api.example.com` |

---

## What this API is for

Predicting the outcome of a challenge between two club members was the use case
it was designed around. It now also serves the history, seasons, tournaments and
schedule an official club data pipeline needs, under the same privacy rules.

### What it deliberately does not carry

No names, emails, Discord handles, phone numbers, avatars, student numbers or
member codes, and no free text written by or about a member: no notes, no
walkover or suspension reasons, no pair names, no court labels. Every mention of
a player is an object, `{"player_ref": "..."}`, never a bare string, so a
future identity scope could add fields to it without changing any shape.

Not by omission, and the precise claim is worth stating honestly rather than
overstating. Computing a `player_ref` requires reading a member's internal id,
so "the feed cannot reach those columns at all" is not literally achievable.
What IS structurally true, and what migration 00241 asserts as a condition of
applying at all, is this: **the database role the service connects as holds no
grant that reaches any identifier column.** It cannot select from `players`, it
cannot select the columns of `players`, and it cannot select the internal view
the feed is built from. It holds EXECUTE on the `data_api_*` read functions
(00241, 00265, 00266) and nothing else, and every one of them returns a hash
where an id went in. The internal helpers those functions share, including the
one gate every match passes through, are granted to nobody.

The remaining hole, named rather than hidden: a service configured with the
Supabase **service role key** bypasses every one of those grants, because that
key is defined by bypassing them. Nothing in the database can prevent that. The
enforcement for it lives in the service's own environment, in which key it is
given, and that is a deployment decision rather than a schema one.

---

## Player identifiers are pseudonyms, not database ids

Every player is identified by a `player_ref`: a salted hash of their internal id,
stable forever, unique per consumer.

**This is not decoration.** The club's own member-facing site has a page at
`/leaderboard/<player-id>` that renders a member's real name, photo and a
challenge QR code. Handing out raw internal ids would mean handing out a lookup
key into that page. The salt stays on the club's side, so:

- The same player is the same `player_ref` across every row and every request,
  which is all a model needs.
- Two different consumers see different `player_ref` values for the same person,
  so datasets pulled by different consumers cannot be cross-joined. Keys of the
  SAME consumer share its salt and see the same refs.
- Matches are identified the same way, by a per-consumer `match_ref`.
- Nobody outside the club can turn a `player_ref` back into a person.

Treat `player_ref` as an opaque string. Do not parse it. Today it is 64
lowercase hex characters; that is not a promise.

---

## Authentication

Every endpoint except `/health`, `/documentations` and `/changelog` requires a key:

```
Authorization: Bearer <your key>
```

Keys are issued by a club admin, shown exactly once at creation, and stored
hashed. **Nobody can recover your key for you, not even the club.** If you lose
it, it gets revoked and you get a new one.

### Scopes

A key carries only the scopes it was granted. A key is not allowed everything by
default; it is allowed nothing by default. One key may carry all eight. The
console's "All read scopes" button ticks the six `:read` scopes and never a
write one. An exec can change the scopes of a live key without reissuing it.

| Scope | Grants |
|---|---|
| `players:read` | the roster: player refs, lifetime ratings and counters |
| `matches:read` | match history, head-to-head, per-season records |
| `ratings:history:read` | per-player rating history |
| `seasons:read` | seasons, season totals, season standings |
| `tournaments:read` | tournaments, events, entrants, draws |
| `schedule:read` | club sessions and club events, counts only |
| `predictions:write` | posting and deleting head-to-head win predictions (a write; no existing key carries it unless an exec adds it) |
| `registrations:write` | delivering responses from the club's own Google Forms (a write, meant for the club's form script, not for outside consumers) |

A correction to earlier versions of this file: `ratings:history:read` was
described as "accepted and empty" because nothing journals a rating change. That
was wrong. Every club match participant row stores the rating after the match
and the change, and every rated tournament match stores before, after and change
per player. 00265 serves it.

### Revocation

A revoked key, or a scope change, takes effect within 30 seconds. Verification
results are cached briefly so that a busy consumer does not cause a database
read per request.

---

## Endpoints

Every route answers `GET` only, except `/v1/predictions`, which answers `POST`
and `DELETE` only, and `/documentations` and `/changelog`, which also answer `HEAD`. Path values: `:ref` and `:other_ref` are
`player_ref`s, `:match_ref` a `match_ref`, `:id` and `:event_id` uuids. A path
value that is malformed is a `404` without a database call.

| Route | Scope | Parameters |
|---|---|---|
| `/health` | none | none |
| `/documentations` | none | none |
| `/changelog` | none | none |
| `/v1/players` | `players:read` | none (query string ignored) |
| `/v1/players/:ref` | `players:read` | none (query string ignored) |
| `/v1/players/:ref/matches` | `matches:read` | as `/v1/matches`, minus `player` |
| `/v1/players/:ref/vs/:other_ref` | `matches:read` | `type`, `season` |
| `/v1/players/:ref/seasons` | `matches:read` | none |
| `/v1/players/:ref/ratings` | `ratings:history:read` | `type`, `season`, `since`, `until`, `limit`, `offset` |
| `/v1/matches` | `matches:read` | `season`, `since`, `until`, `player`, `opponent`, `type`, `source`, `rated`, `status`, `updated_since`, `limit`, `offset` |
| `/v1/matches/:match_ref` | `matches:read` | none |
| `/v1/seasons` | `seasons:read` | none |
| `/v1/seasons/:id` | `seasons:read` | none |
| `/v1/seasons/:id/standings` | `seasons:read` | none |
| `/v1/tournaments` | `tournaments:read` | `season` |
| `/v1/tournaments/:id` | `tournaments:read` | none |
| `/v1/tournaments/:id/events/:event_id` | `tournaments:read` | none |
| `/v1/sessions` | `schedule:read` | `from`, `to` |
| `/v1/events` | `schedule:read` | `from`, `to` |
| `/v1/predictions` | `predictions:write` | none; a JSON body (see "Predictions") |
| `/v1/registrations` | `registrations:write` | none; a JSON body (see "Registrations") |

The response shape of every route, with examples, is on the served
`/documentations` page. The rules that matter for modelling are below.

### Query parameters

A route that takes parameters refuses an unknown or repeated one, and a value
that does not parse, with `400 {"error":"bad_request","parameter":"<name>"}`.
Timestamps (`since`, `until`, `updated_since`, `from`, `to`) must be UTC and end
in `Z`. `until` must be after `since`. `opponent` on `/v1/matches` needs
`player`. `status` is `final` (the default: everything except voided), `voided`
or `all`. `limit` is 1 to 500 (default 100), `offset` 0 to 100000.

The schedule window defaults to the next 30 days; one bound alone gets 30 days
on its other side; wider than 366 days, or `to` not after `from`, is a `400`
naming `to`.

### Paging, and how to sync

Paged responses carry `count`, `limit`, `offset` and `next_offset` (`null` on
the last page). Offset paging over a set that changes between requests can skip
or repeat rows: fine for browsing, wrong for syncing.

**To sync, use `updated_since`.** `/v1/matches?status=all&updated_since=<t>`
is ordered by `updated_at`, oldest first. Store the largest `updated_at` seen
and pass it next time. A voided or corrected match comes back with a newer
`updated_at`. A match that STOPS being published (a player opted out, a season
was hidden) does not come back as a tombstone; rebuild from scratch now and then
to drop those. A tournament match's `updated_at` is the later of its row change
and its result entry, because that table has no update trigger.

### Matches

A match object carries `match_ref`, `source` (`club` or `tournament`),
`status`, `counts_toward_stats`, `played_at`, `updated_at`, `season`, `type`,
`kind`, `rated`, `format`, `games_per_match`, `points_per_game`, `walkover`,
`winner_side`, `score_summary`, `games` and `sides`, plus `tournament` for a
tournament match: `{id, event_id, event_type, round_number, round_name, phase,
is_third_place, stage, match_label, handicap_a, handicap_b}`. The last four are
`null` (`0` for the handicaps) outside a staged event; see "Staged events". Each side is a list of
`{player_ref, won, rating: {before, after, delta} | null, points_scored,
points_allowed, games_won, games_lost}`. A voided match keeps its result but its
`rating` is `null`, because the change was reversed.

`counts_toward_stats` is `true` only for a played, non-voided result (club:
confirmed and not a walkover; tournament: completed). Every derived record in
the API counts only those.

### Tournament draws

A draw slot that is disputed, or that has a player who fails the history test
below, is **withheld**: it keeps its place in the bracket (`round_number`,
`bracket_position`, `winner_to`, `loser_to`) with `"withheld": true` and
`sides`, `winner_side` and `games` all `null`. The bracket's shape survives; who
played does not. Entrants with an unpublished player are left out of the
entrant list, and a pair needs both players published.

### External teams

An event with `"external": true` is an unrated round robin of teams who are
not club members, entered by the organisers. Such a team is served without a
name and without `player_ref`s: an entrant has `"players": []`,
`"external": true` and an `external_ref`, and in a draw each side of its slot
is one element, `{"player_ref": null, "external": true, "external_ref": "..."}`.
An `external_ref` is opaque, stable and per-consumer like a `player_ref`, names
the team rather than a person, and never equals a `player_ref`. Every member
entrant and draw element carries `"external": false` and `"external_ref": null`.
A slot in an external event is withheld only when disputed. External matches
move no rating, so they are not in `/v1/matches` or any match history.

### Staged events

An event with `"format": "staged"` is played as a list of stages: groups, a
knockout, or a set of named matches, each fed by the field or by places out of
the stages before it. Every event also carries `rated` (whether the event moves
ratings at all) and `current_stage` (the latest stage drawn, 1-based, or
`null`). On a staged event four more fields describe it; on any other event
`stages`, `categories` and `head_starts` are `null`:

- `stages`: one object per stage, in order, with `index` (1-based), `key`,
  `name`, `kind` (`groups`, `knockout` or `matches`), `rated` (`false` for a
  stage that moves no rating even in a rated event) and `scoring`
  (`{best_of, target, win_by_two, cap, handicap, forfeit}`, where `forfeit` is
  the score a walkover is recorded as, `{winner, loser}`, or `null` for
  target to nil). A groups stage fills `pools`, `groups_per_pool`, `group_size`
  (a number or `"auto"`) and `tiebreaks` (in order; any of `wins`,
  `point_diff`, `points_for`, `points_against_low`, `game_diff`, `h2h`,
  `seed`). A knockout fills `size` (a power of 2 or `"auto"`) and
  `third_place`. A matches stage fills `matches`, a list of
  `{label, name, winner_place, loser_place}`. A field a stage's kind does not
  use is `null`.
- `categories`: the team categories, `[{key, label}]`. `null` means the
  defaults: `mens`, `womens` and `mixed`.
- `head_starts`: row category, then column category, then the points a team of
  the row category starts each game on against one of the column category, for
  example `{"womens": {"mens": 3}}`. A pair not listed starts on 0.
- `points_table`: the ladder points the event pays, `{by_place, rest,
  participation, per_win}`: `by_place[0]` is first place, a place past the end
  of the list takes `rest`, and every entrant also gets `participation` plus
  `per_win` for each win. It is served on every event, staged or not, and is
  `null` when the event pays its format's default: `single_elimination` and
  `pool_to_bracket` pay `[100, 75, 50, 40, 25, 25, 25, 25]` by place with
  `rest` 10 and nothing for taking part or winning; `round_robin` pays
  `participation` 1 and `per_win` 3 and nothing by place. A staged event pays the knockout default unless its last
  stage is groups, which pays the round robin default.

An entrant carries `team_category`, the category key the team plays as, or
`null` (always `null` for a singles entrant).

A staged draw slot has `phase: null` and these instead: `stage` (the 1-based
index into `stages`), `pool_number`, `group_number`, `slot`, `match_label` (the
`label` of a named match), and `handicap_a` and `handicap_b`, the head start
each side started every game on. **Recorded scores include the head start**:
`games` is the score as it was played, so subtract the handicap to get the
points won from play. A withheld slot keeps `stage`, `pool_number`,
`group_number`, `slot` and `match_label`, and has both handicaps `null`. On a
slot outside a staged event the stage fields are `null` and the handicaps `0`.

Courts are still not served: neither a match's court nor the courts a stage
plays on.

A staged event of club members with `"rated": false` moves no rating, but
unlike an external event its matches are member matches: they appear in
`/v1/matches` and the match history with `"rated": false` and a `null` rating.

### `GET /v1/players`

Every member on the roster, one object each, with lifetime figures. See "who is
in the feed" below: it is not the same set as the club's public leaderboard,
and it is not the same as the club's membership.

```json
{
  "season": {
    "id": "7d3f2a10-5b8e-4c21-9f6a-2e4d8b1c0a93",
    "name": "Fall 2026",
    "term": "fall",
    "year": 2026,
    "start_date": "2026-09-01",
    "end_date": "2026-12-15"
  },
  "generated_at": "2026-09-19T22:14:03Z",
  "count": 39,
  "players": [
    {
      "player_ref": "e5367d32519f898ef2707e19890ec501031e23d027b6eb3172faa710e508707d",
      "singles_elo": 1180,
      "doubles_elo": 1042,
      "singles_provisional": false,
      "doubles_provisional": true,
      "singles_matches_played": 0,
      "doubles_matches_played": 0,
      "singles_wins": 0,
      "singles_losses": 0,
      "doubles_wins": 0,
      "doubles_losses": 0,
      "updated_at": "2026-09-14T04:11:55Z"
    }
  ]
}
```

`/v1/players/:ref` is one such object with no wrapper, `404` if the ref is not
on the roster.

---

## Field meanings, and the traps in them

| Field | Meaning |
|---|---|
| `player_ref` | opaque pseudonym, stable, per-consumer |
| `singles_elo` / `doubles_elo` | current rating, separate ladders |
| `*_provisional` | `true` while the rating is still settling. A provisional rating is a guess, not a measurement. Weight it accordingly or exclude it. |
| `*_matches_played` | rated matches only |
| `*_wins` / `*_losses` | rated matches only |
| `updated_at` | when the rating row last changed |

**The `season` block is context, and nothing else.** It reports the club's
currently active season so you know roughly when a pull was taken. The field is
`start_date`, which is what the column is called; there is no `started_on`. It
is `null` when no season is active, and also when it could not be read, because
the roster is still worth serving without it.

**The figures are LIFETIME, not season-scoped.** This is the trap in the block
above and it is worth reading twice. A rating row carries no season at all, so
every number in a player object is that member's running total across their
whole time at the club, not their total within the season named beside it. Do
not slice these figures by season; they cannot be sliced.

When the active season is one the club has chosen to keep out of its public
history, the `season` block reports `null` rather than the hidden season's name.
The figures are unaffected, because they were never season-scoped in the first
place.

**Elo here is not earned from play.** New members are assigned a starting rating
by skill tier at signup. A 1200 and a 400 have not necessarily played anybody.
Ratings span roughly 400 to 1400, and almost all of that spread is assignment
rather than results.

**Singles and doubles are separate ladders.** Do not average them, and do not
use one to predict the other.

**Wins plus losses does not always equal matches played.** Walkovers and
forfeits are counted differently. Derive win rate from `wins` and `losses`, not
by subtracting.

---

## Who is in the feed

Do not treat `count` as the club's membership, and do not compare it against
any figure on the club's public site expecting them to agree.

**There are two tests, on purpose.**

The **roster test** decides `/v1/players`, `/v1/players/:ref` and season
standings. Four conditions decide whether a member appears, and two of them
are privacy controls rather than filters:

- they are an active member, and
- their account is neither awaiting approval nor suspended, and
- **they have not asked to be kept off published rankings**, and
- **they have not requested deletion of their account.**

The **history test** decides every match, rating-history, head-to-head and
per-season route. It keeps the two privacy controls and the approval check (not
opted out, no deletion request, not awaiting approval) and drops "active" and
"not suspended", because a former member's past results are still the club's
history and their opponents' records would be wrong without them. So a ref can
appear in a match while `/v1/players/:ref` answers `404`.

The club's public leaderboard applies the first three roster conditions. It
does **not** apply the fourth, because a deletion request is not a leaderboard
setting. This feed applies the deletion request everywhere, within 60 seconds
of it being made (the read cache, see "Rate limits and etiquette") rather than
when the club's purge next runs, because the purge
anonymises the record rather than erasing it and the ratings survive it.

**One gate for every match.** A club or tournament match is published only when
it is final (confirmed, completed, a walkover, or voided), it is not a bye, its
tournament is past the draft stage, its season is not hidden, and **every**
player in it passes the history test. A match with even one unpublished player
is dropped whole, never served with a gap. Every route that counts matches reads
through the same gate, so figures derived from different routes agree.

So the feed's population is the leaderboard's population minus anyone with a
deletion request outstanding. The two legitimately differ, neither is wrong, and
this document deliberately quotes no hard number for either: the set changes
week to week, and a number written down here would be stale before it was read.

`count` in the response is the size of the set at the moment of that request.
That is the only figure worth trusting, and a member who leaves the set between
two pulls simply stops appearing, with no tombstone and no notice.

---

## Reconciliation, read this before modelling

**Derived figures will not equal the lifetime counters.** `/v1/players`
carries the club's own running counters (`*_wins`, `*_losses`,
`*_matches_played`), kept by its rating system. Everything this API derives
(head-to-head, per-season records, standings records, season totals) is counted
from published matches only. The two differ whenever a match was dropped by the
gate, whenever a season was hidden, and for walkovers, which the counters and
the derived records treat differently. Neither is wrong.

**The history may be thin.** The club started recording rated matches recently,
and matches in hidden seasons (including a retired test season) are never
served. Check how much history there is before fitting anything to it.

**Rating history does not always chain.** Rated matches and tournament
placement bonuses are in it; rating changes the club made by hand are not, so
one row's `after` need not equal the next row's `before`. It does give each
player's rating at the time of every rated match, which is the feature a model
most often wants.

The standard starting point for "who wins when A challenges B" is the rating
difference, which needs no history:

```
P(A beats B) = 1 / (1 + 10 ** ((elo_B - elo_A) / 400))
```

The match history lets you calibrate that baseline against real outcomes.
Treat anything fancier as unvalidated until there is enough history to validate
it.

---

## Predictions

`POST /v1/predictions` stores head-to-head win predictions made by your model,
and `DELETE /v1/predictions` removes them. A member may be shown a prediction in
the club app only for a challenge they play in, labelled as a prediction, with
the `model` name and `made_at`, but never which consumer made it.

```
POST /v1/predictions
Content-Type: application/json

{"predictions":[{"format":"doubles","side_a":["<ref>","<ref>"],"side_b":["<ref>","<ref>"],
                 "probability":0.64,"model":"elo-v3","made_at":"2026-10-08T18:00:00Z"}]}
```

- The body is at most 64 KiB, and either `{"predictions": [...]}` with 1 to 100
  items or one item on its own. Each item has exactly the six fields above.
  `format` is `singles` (one ref a side) or `doubles` (two); no player twice.
  `probability` is side A's chance of winning, from 0 to 1. `model` is 1 to 64
  characters from `A-Z a-z 0-9`, space and `. _ : + -`. `made_at` is UTC ending
  in `Z` and not more than 5 minutes ahead of the server clock.
- **A matchup is two unordered sides.** A and B against C and D is the same
  matchup as D and C against B and A. Predicting a matchup you already predicted
  replaces the earlier row. If you swap the sides, swap the probability to
  `1 - p`.
- **Only published players.** Every ref must name a member who passes the
  history test in "Who is in the feed". A member who later opts out or asks for
  deletion disappears from every prediction at once, and their predictions are
  erased with their account.
- **Predictions never change ratings.** Nothing that rates a match or builds a
  statistic reads them. When two consumers predict the same matchup, members
  see the newer one.
- A batch costs one request against the rate limit, and writes are never served
  from the read cache. Every call is recorded against the key, with counts and
  no players.

The answer lists every item as `created`, `replaced` or `refused`:

```json
{ "results": [ { "index": 0, "status": "created" },
               { "index": 1, "status": "refused", "reason": "player" } ],
  "created": 1, "replaced": 0, "refused": 1 }
```

It is `200` when nothing was refused and `422`, with the same body, when
anything was. `reason` `player` means a ref is unknown to you or names a member
who is not published; it deliberately does not say which. A body that is not
the documented shape is a `400` naming the `field` (for example
`predictions[3].side_b`), and nothing in it is stored.

`DELETE /v1/predictions` takes `{"matchups": [{"format", "side_a", "side_b"}]}`
(1 to 100, sides in either order) and answers each item `deleted` or
`not_found`, with `deleted`, `not_found` and `refused` counts. Only your own
predictions are ever deleted.

---

## Registrations

`POST /v1/registrations` is how the club's own Google Forms enter people into a
tournament or a club event. An exec binds a form to one target in the admin
console, against the key its Apps Script sends; the script is in
`integrations/google-forms/`. A response for a form with no active binding for
the key is a `404`.

The body is one form response:

```json
{ "form_id": "<form id>", "response_id": "<response id>",
  "submitted_at": "2026-10-08T18:00:00Z",
  "email": "<submitter email>", "name": "<submitter name>",
  "entries": [ { "event_id": "<event uuid>", "partner_email": "<email>",
                 "partner_name": "<name>", "category": "<category>" } ] }
```

`submitted_at`, `partner_email`, `partner_name` and `category` are optional; up
to 20 `entries`; a club event form sends none. The answer is per entry:

```json
{ "replayed": false, "entered": 1, "pending": 1, "refused": 0,
  "results": [ { "index": 1, "event_id": "<uuid>", "status": "entered", "reason": null } ] }
```

- `entered`: a non-member, or a team of two non-members, is in the event and
  owes its fee as a named entry. They are sent the guest waiver once the club
  turns that feature on.
- `pending`: something must happen first. A member is never entered by a form:
  they confirm the entry in the club app, where the usual rules and fees apply.
  A doubles entry waits for the partner's own response, and anything odd waits
  for an exec.
- `refused`: `reason` is about the event only (`event_full`, `waitlist_queue`,
  `registration_closed`, `registration_not_open`, `registration_window_closed`,
  `event_not_in_target`, `duplicate_in_submission`). Nothing in an answer says
  whether an email belongs to a member.

Sending the same response again answers from the record with `replayed: true`.
An edited response, or a new one from the same person, replaces the earlier
one: entries it no longer names are withdrawn if nobody has paid or been drawn,
and otherwise left for an exec. The service never logs the body, and the club's
record of an import names no email.

---

## Errors

| Status | Meaning |
|---|---|
| `400` | a query parameter the route does not take, a repeated one, or a value that does not parse; `parameter` names it. On `/v1/predictions` and `/v1/registrations`, a body that is not JSON or not the documented shape; `field` names it |
| `401` | missing, malformed, unknown, expired or revoked key. Deliberately identical in all five cases. A write is also refused this way when the key was revoked or lost its write scope in the last 30 seconds. |
| `403` | valid key, but it lacks the scope for this endpoint |
| `404` | no such route, or a ref or id in the path that is malformed, unknown or not published; on `/v1/registrations`, a form with no active binding |
| `405` | a method the route does not answer (`GET` on read routes, `POST` and `DELETE` on `/v1/predictions`, `POST` on `/v1/registrations`, `GET` and `HEAD` on `/documentations` and `/changelog`); `Allow` lists them |
| `413` | a write body over 64 KiB |
| `415` | a write body not sent as `application/json` |
| `422` | a write where at least one item was refused (the results body, not an error object) |
| `429` | rate limited |
| `503` | the club's database could not be reached |

```json
{ "error": "forbidden", "detail": "this key does not carry players:read" }
{ "error": "bad_request", "parameter": "since" }
```

---

## Rate limits and etiquette

A per-key limit applies; `429` means slow down. The dataset changes slowly, so
polling every few minutes buys nothing. Pull `/v1/players` on a schedule
measured in hours and cache it, and keep match history in sync with
`updated_since` rather than re-reading it.

Responses may be up to 60 seconds old: the service reuses a recent answer to
the same request from the same consumer rather than asking the database again.
The roster, matches, ratings and seasons may be up to 60 seconds old;
tournaments, sessions and club events up to 30 seconds. A registration import
refreshes that consumer's tournament entrant lists and event signups at once.
A member's opt-out or deletion request reaches the feed within the same 60
seconds. `generated_at` is the time the response was sent, not the time the
data was read.

---

## Versioning

The `/v1` prefix is the contract. Within it, **new fields and routes may be added** and
existing fields will not be removed or change meaning. Parse defensively and
ignore fields you do not recognise. A breaking change becomes `/v2`.
Changes are listed at `/changelog`.

---

## Data handling expectations

This is real data about real people, shared under a named key that identifies
who received it.

- Do not attempt to re-identify players.
- Do not redistribute the data or publish it as a dataset.
- Keep the key out of version control.
- Tell the club if the key leaks, and it will be revoked and reissued.
