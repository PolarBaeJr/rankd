# Member data export (FIPPA access request)

A member can download everything the system holds about them from
**Settings, Privacy, "Download my data"**. This document exists so a real
access request can be answered inside the 30 business days FIPPA allows without
anybody having to rediscover any of the reasoning below.

> **Which Act governs is not finally settled, and it changes the deadline.**
> This document and the registry's `why:` strings cite **FIPPA**, on the
> conservative reading that the club sits under SFU Recreation. The question is
> being put to Recreation for review. If they confirm the membership data is not
> SFU's record, the club is a private organisation under **PIPA** instead, and
> two things change: the response clock becomes **30 calendar days, not 30
> business days** (materially shorter, so treat the calendar figure as the safe
> one until this is answered), and the withholding basis below has to be
> re-grounded, because **PIPA has no advice-and-recommendations exception.**
> Under PIPA the narrower bases are s.23(4)(a) and (4)(b) plus the safety
> grounds, and s.23(5) requires severing and disclosing the remainder rather
> than withholding a whole record. That pushes the owner decision in the next
> section toward disclosing officer notes with the author's identity removed.
> Nothing in the code needs to change to switch: the citations are text.

## The governing idea

**The defence against creating a false record of compliance is not including
everything. It is enumerating the withholdings.**

An export that says what it is not giving you is defensible. One that silently
omits is not, because the member cannot tell the difference between "the club
holds nothing about me here" and "the club holds something and this file did not
look". Every design decision below follows from that sentence, and so does the
one test that keeps it true.

So the file carries four top-level sections:

- `manifest` lists **every table that was considered**, with a row count
  including zero, the disposition, and a plain-sentence reason. A zero means the
  table was read and held nothing. A table absent from the manifest does not
  exist, which is what the test below enforces.
- `data` holds the rows, one key per exported table.
- `withheld` holds one entry per withheld table or column: what, how many rows,
  and why.
- `declared_gaps` holds personal information the club does hold that the export
  **cannot reach**, stated rather than omitted. Those are the owner-run steps at
  the bottom of this document.

## Where it lives

| what | where |
| --- | --- |
| The registry (the single source of truth) | `apps/player/src/lib/data-export/registry.ts` |
| Projection helpers (pseudonyms, jsonb allowlist) | `apps/player/src/lib/data-export/project.ts` |
| The assembler | `apps/player/src/lib/data-export/assemble.ts` |
| The route | `apps/player/src/app/api/account/export/route.ts` |
| The Settings control | `apps/player/src/app/settings/data-export.tsx` |
| The guard | `apps/player/src/lib/__tests__/data-export-coverage.test.ts` |

**There is no migration and none is needed.** Everything is reachable with the
existing service-role client, and the receipt goes through the existing
`logMemberAudit()` (`apps/player/src/lib/member-audit.ts`), whose `action_type`
is free-form with no CHECK constraint. The action type is
`data_export_downloaded`.

**There is no queue and no bucket.** The file is generated on demand and
retained nowhere. A generated export sitting in storage is one member's personal
information with its own retention, access-control and deletion problem, which
is a new problem rather than a solved one.

## Who can use it

A verified session and a `players` row. That is the whole gate.

**The route deliberately does not call `requirePlayer()`**, and this is the thing
most likely to be "fixed" by a later hand who sees an unguarded route.
`requirePlayer()` refuses `pending_approval`, `suspended`, `is_banned`, and a
deactivated account with a deletion pending, which is to say it refuses exactly
the population that files access requests. A banned member who wants to read the
`ban_reason` the club wrote about them is the archetypal applicant. Standing
withholds the **controls**, not the information, the same distinction the
calendar feed route's header draws. The Settings row therefore sits outside the
`isApproved` block, and a test asserts the route contains no `requirePlayer`.

## Why it is assembled in TypeScript over the service-role client

Not RLS. **Several tables holding the member's own personal information have
zero grants for `authenticated`**, so an RLS-scoped export is incomplete by
construction, and it fails **silently** because a denied PostgREST read arrives
as an empty list rather than an error: `email_suppressions` (00037:48),
`digest_deliveries` (00194:80), `feedback_reports` (00172:113),
`passkey_challenges` (RLS on, zero policies, 00181:63-65),
`tournament_bonus_grants` (RLS on, zero policies, 00188:60-62), and `players`
itself, where 00032 revokes blanket SELECT so `select('*')` is refused even on
your own row.

Not forty `SECURITY DEFINER` RPCs: forty new pieces of authenticated surface,
and a table added later gets no RPC and nobody notices.

Not one big `SECURITY DEFINER` jsonb function: the guard that keeps this correct
compares a registry against the migration SQL, which is tractable in TypeScript
and miserable in PL/pgSQL.

## Why JSON and not a zip of CSVs

No workspace has `jszip`, `archiver`, `fflate` or `adm-zip`, so CSV means a new
production dependency. More decisively, the jsonb columns
(`players.notification_preferences`, `audit_logs.old_value` / `new_value`,
`notifications.metadata`, `email_suppressions.detail`,
`tournament_audit_log.details`) do not flatten into CSV without loss, and lossy
is disqualifying for a statutory access response.

## Why it is not streamed

Assembled fully in memory, then one response. Cloudflare's origin timeout
surfaces as a 524, and a half-written JSON body is the partial-export failure
mode wearing a different hat. One member's data is kilobytes to low megabytes.

A failed read fails the **whole** request: 503 and no body. A file missing a
table is worse than no file, because it looks like a complete answer.

## Caching

`force-dynamic` on the route, plus `Cache-Control: no-store, private, max-age=0,
must-revalidate` and `X-Robots-Tag: noindex` on the response. A cached export is
a cross-member data leak, not a performance bug; one declaration answers Next's
route cache and the other answers Cloudflare, and neither can answer for the
other.

## The projection rule

The requester's own fields come through verbatim. **Every other member is
reduced to an opaque per-export pseudonym (`member_1`, `member_2`, ...) or a
role descriptor ("a club officer"). Never a uuid and never a name.**

A uuid is the thing to guard rather than a name: it is joinable across the whole
app, appearing in `/leaderboard/[playerId]` URLs and in every table in the
schema, so one leaked uuid turns the file into a lookup key for somebody else's
record. The pseudonyms mean nothing outside the one file.

Two traps are worth naming because both look healthy when got wrong:

- `head_to_head_stats` and `partnership_stats` both carry
  `CHECK (player_a_id < player_b_id)` (00001:509 and 00001:527), so which slot
  the member occupies is decided by uuid ordering, per opponent. A naive
  `.eq('player_a_id', me)` returns roughly **half** the rows. Both columns are
  queried with `.or()` and every row is rewritten requester-relative.
- `tournament_matches.ready_player_ids` is a bare `uuid[]` of everybody the door
  has marked ready. It is filtered down to the requester alone.

## What is withheld, and why

Every item here appears in the file's `withheld` stanza with the reason in plain
sentences.

### Credential material, withheld outright

- `passkey_credentials.public_key`, `.counter`, `.credential_id`. Key material,
  clone-detection state, and a stable cross-site identifier for the device.
- `push_subscriptions.p256dh_key`, `.auth_key`, and a truncated `.endpoint`.
  Those three together **are** the sending credential for that browser.
- `calendar_feed_tokens.token`. A plaintext bearer credential (00013:11-15).
  Exporting it would make the downloaded file a live unauthenticated feed link,
  which then follows the file into every backup and every email it is attached
  to.
- `discord_link_tokens.token_hash` and the whole of `passkey_challenges`.
- `session_checkin_tokens.token` and `tournament_checkin_tokens.token`. These are
  per session and per tournament, not per member, so they are not the
  requester's personal information at all, and holding the token **is** the
  proof of being at the door.

`cron_config` is never read from the export, filtered or not: it holds
`reminder_secret` and holds nothing about any member.

### Awaiting a decision by the owner

**These are the items a human has to settle. They are implemented as
`disposition: 'withheld_pending_owner_decision'` and each is surfaced in the
file with a live row count, so the stakes are visible before the decision.**

| table | what it holds | citation |
| --- | --- | --- |
| `varsity_notes` | trainer notes about the member | 00001:531 |
| `match_admin_notes` | an officer's note on a match, including a void or demotion reason | 00117:206 |
| `tournament_participant_notes` | withdrawal and disqualification reasons | 00118:209-249 |
| `tournament_pair_notes` | notes on a doubles pair | 00118:209-249 |
| `tournament_match_notes` | notes on a draw match | 00118:209-249 |
| `walkover_admin_notes` | an officer's verdict on a forfeit | 00118:209-249 |
| `disputes.resolution_note` | an officer's written verdict on a dispute | column, still live |

Migrations 00117 and 00118 exist **specifically** to keep this text away from
members, moving it into tables with no grant for `authenticated` and RLS on with
no policy. An export including it reverses that intent in one commit, and the
FIPPA s.13 (advice and recommendations), s.19 (health or safety) and s.22
(unreasonable invasion of a third party's privacy) exceptions are not something
to adjudicate in code.

Note what is **not** on this list. Five officer free-text COLUMNS that earlier
notes describe as still present have all been dropped: `matches.admin_note`,
`tournament_pairs.notes` and `tournament_matches.notes` by 00122:373-375, and
`tournament_participants.notes` and `walkovers.admin_notes` by 00125:657-658.
00117 and 00118 wrote those drops out for a later hand and that hand came.
`disputes.resolution_note` is the last survivor of the family.

### Included after checking the product: `players.ban_reason`

This is the tie-break case and the single most likely subject of an access
request, so it is settled by the product rather than by argument: **it is already
shown to the banned member today.** `getAccountStanding()`
(`packages/shared/src/utils/account-standing.ts`) folds it verbatim into the
suspension detail, and `standing-banner.tsx` renders that detail under the top
bar on every page. Exporting it changes nothing about what the member can see. A
test pins both halves of that finding, so if either stops being true the
question reopens there.

### The permission columns are included

`players.permission_role`, `.permission_baseline_id`, `.permission_grants`,
`.permission_revokes` and `.role` are facts about the member's own account.
Nothing in the export can become privilege escalation: the route is read-only,
performs no writes, and no value in the file is accepted back as input anywhere.
(`builtin_role` does not exist on this table, whatever an older note may say.)

### Audit payloads go through an allowlist

`audit_logs.old_value` / `.new_value` and `tournament_audit_log.details` are
filtered to an allowlist of standing columns, never shipped raw.
`apps/admin/src/lib/auditable-player.ts` exists because four console actions
wrote whole `select('*')` player rows into `old_value`, and there are production
rows holding a real email address. Nothing in a payload says which member it is
about, so a payload cannot be trusted to be the requester's own row.

The consequence is a real withholding and the file declares it: the member's own
name, email and phone are dropped from an audit **payload**. They are exported
in full from `players`, which is where they belong.

Rows where the member acted on somebody **else** keep the action and the date
and lose both the payload and the member's own written reason. A reason typed
about another member names and describes that member.

## The declared gaps, and the owner-run steps that answer them

These are in the file so a member can ask. Answering them is manual.

### 1. The `auth` schema

PostgREST exposes only the exposed schemas, so no application code can read
these. All three hold personal information.

- `auth.users`: the real email address and sign-in timestamps.
- `auth.identities`: the `(provider, provider_id)` pairs that resolve a
  multi-login member.
- `auth.audit_log_entries`: roughly 730 production rows carrying the real email
  in `payload.actor_username`.

Take the member's `user_id` from the `players` section of their export, then:

```sh
ssh pi "docker exec -i supabase-db psql -U postgres -d postgres -x -c \"
  SELECT id, email, phone, created_at, updated_at, last_sign_in_at,
         email_confirmed_at, confirmed_at, banned_until, deleted_at
    FROM auth.users WHERE id = '<user_id>';\""

ssh pi "docker exec -i supabase-db psql -U postgres -d postgres -x -c \"
  SELECT provider, provider_id, created_at, updated_at, last_sign_in_at
    FROM auth.identities WHERE user_id = '<user_id>';\""

ssh pi "docker exec -i supabase-db psql -U postgres -d postgres -x -c \"
  SELECT id, created_at, ip_address, payload
    FROM auth.audit_log_entries
   WHERE payload->>'actor_id' = '<user_id>'
      OR lower(payload->>'actor_username') = lower('<their email>')
   ORDER BY created_at;\""
```

Read the third one before sending it: `payload` is free-form and an entry can
name a second address (an email-change event carries both), which is then
somebody else's personal information if the change was a correction.

### 2. Stored files

The export carries the **paths** and not the binaries, because embedding them
would turn kilobytes of JSON into megabytes of base64. A photograph of the
member is personal information, so they are available on request.

- `players.avatar_url` and `players.exec_photo_url`
- `feedback_reports.image_path` (00174)
- `club_ledger.receipt_path` (00231), the first file of a receipt
- `club_expense_receipts.path` (00313), every file of a receipt with several
  pages, keyed by `ledger_id` to the member's own expense rows (`paid_by`)

Fetch each path out of the storage bucket by hand and attach the files to the
response.

### 3. History under a merged-away account id

`merge_players` rewrites `player_id` across many tables, and its guard sees only
CASCADE references, so rows in tables that SET NULL instead can be left under an
id nobody queries. The export reads the member's **current** `player_id` only.

If the member has ever been merged, find the old id in `audit_logs` (the merge
files a row) and re-run the reads against it.

### 4. Suppressions against a previous email address

`email_suppressions` is keyed on the address itself and holds no player column
(00037:25-36), so the export matches the address currently on the record. If the
member has changed address, check the old one by hand.

### 5. Tournament administration recorded ABOUT the member

`tournament_audit_log` has **no target column**. When an officer withdraws or
disqualifies somebody, the row is keyed by the officer in `performed_by` and the
member appears inside the free-form `details` payload. The export therefore
carries only what the member performed themselves. Searching the jsonb for them
is possible by hand and is not attempted in code, because a jsonb search that
guesses at key names is exactly the kind of quiet incompleteness this feature
exists to avoid.

### 6. It is not a point-in-time snapshot

About fifty sequential reads, not one transaction. The manifest records
`assembly_started_at` and `assembly_completed_at` and the file says outright that
rows may have changed between them.

## The organisations the data is disclosed to

`DISCLOSURE_RECIPIENTS` in the registry names every outside organisation that
receives member personal information, and it is emitted into the file as
`disclosure_recipients`. It is in the export rather than only in the privacy
policy for the same reason the withholdings are: a file that enumerates fifty
tables down to the column reads as complete, and it would not be, because none
of those rows live only on the Pi.

Six entries: **Resend** (email address and delivery results), **Sentry**
(whatever was in scope at the moment of an error), **Discord** (linked account
id and anything typed into a command or feedback form), **Google** (email and
account id, only for members who sign in with Google), **Cloudflare** (IP and
requests in transit, and it terminates TLS), and **Google Drive** (the nightly
database backup, encrypted before it leaves the club's hardware).

**PostHog is deliberately not on the list.** The SDK ships and
`components/posthog-identify.tsx` would send the player uuid through
`identify()`, but `NEXT_PUBLIC_POSTHOG_KEY` is not set in production, so
`lib/posthog.ts` and `lib/actions/_shared.ts` both short-circuit and nothing is
ever sent. Verified against prod's environment on 2026-09-21 by reading key
names only. Naming a recipient that receives nothing is its own inaccuracy, and
a member has no way to check the claim. **If that key is ever set, the list
gains an entry in the same commit**, which is what the guard below enforces.

A test reads the workspace `package.json` manifests, and any processor SDK that
ships must be either named in `DISCLOSURE_RECIPIENTS` or recorded in
`INERT_IN_PRODUCTION` with the reason it sends nothing. So installing a new
analytics or email SDK fails the suite until somebody decides what members are
told. Mutation-tested by removing the Resend entry: the suite fails naming
`Resend`.

## The test that keeps it correct

`apps/player/src/lib/__tests__/data-export-coverage.test.ts`. No database. Truth
comes from `supabase/migrations/*.sql` parsed as text, the claim comes from the
registry.

The assertion that matters is a **total partition**: every table any migration
creates and no migration drops must land in exactly one of four buckets, and the
failure message names the offenders. **A new table fails a test instead of being
quietly absent from a statutory access response.**

An FK-only scan would not be enough, which is why the partition has to be total.
Four tables name a member with no foreign key at all: `email_suppressions`
(keyed on the address, 00037:25-36), `passkey_challenges` (a bare `user_id uuid`,
explicitly no FK, 00181:42-56), `discord_role_revocations` (keyed on
`discord_user_id` and deliberately carrying no `player_id`, 00165:111-121) and
`tournament_bonus_grants` (`subject_id uuid NOT NULL`, "Deliberately not a
foreign key", 00188:43-58).

The rest of the suite pins: every export and project table really appears in the
output; every column on `players` is classified as exported or withheld; no
withheld column name appears in an allowlist; the export modules contain no
`?? []` or `|| []` and destructure `error` at every read; the route does not call
`requirePlayer` and does use the service-role client; and a **sentinel uuid**
placed in every third-party player column appears nowhere in the serialised
document, which checks the projection rule mechanically rather than by review.

Truth is derived from the migrations and not from
`packages/shared/src/types/database.gen.ts`, which is stale: the console's
`deleted-identity.test.ts` carries a hardcoded `exec_bio` workaround for exactly
that reason. This suite does not inherit it.

## Do not edit the privacy policy for this

`docs/legal/privacy-policy.md` already promises Access at around line 56, so
nothing there needs to change. More importantly, `legal_documents` holds policy
versions **in the database**, and a version bump triggers 00015's re-acceptance
machinery for the whole club. An innocuous wording edit is a club-wide
re-consent prompt.

## Rate limit

`/api/account/export` is limited to 20 rpm per client IP at the edge. See
`docs/ops/rate-limits.md`, including the note that the entry has to exist on
**both** hosts and that a bad rpm fails open silently.
