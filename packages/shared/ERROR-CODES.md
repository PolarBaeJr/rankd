# Error codes

Generated from `packages/shared/src/utils/error-codes.ts`. Do not edit by hand: change the
registry and regenerate with `npm test -w @badminton/shared -- -u`.

An error screen or toast shows a code like `DB-101.k3x9q2ab`. The part before the dot is the
code below and never changes meaning. The part after it is a random reference for that one
occurrence, and it is what to search the server log for.

Ranges inside an area: 000 unknown, 1xx a load failed or a guard refused, 2xx a save or sign-in
step failed, 3xx a data conflict, 4xx an expected row is missing, 5xx infrastructure, 6xx a
database rule. A reference made only of digits (`GEN-000.2299239490`) came from an error that
had no code of its own, and the digits are the digest Next printed in the log.

## AUTH: Sign-in and access

| Code | Title | What the user sees | Likely cause |
| --- | --- | --- | --- |
| `AUTH-000` | Sign-in problem | Something went wrong while checking who you are. Sign in again and retry. | An auth failure that matched no more specific code. |
| `AUTH-101` | Not signed in | You need to be signed in to do this. | The server found no valid session for the request: no auth cookie, or it expired. |
| `AUTH-102` | Passkey check needed | Confirm with your passkey, then try again. | The console passkey step-up gate refused: this session has not verified a passkey. |
| `AUTH-103` | Passkey status unknown | We could not confirm your passkey setup. Try again in a moment. | The passkey enrolment lookup failed, so the step-up gate failed closed. |
| `AUTH-104` | Not allowed | Your role does not allow this. | The console capability check refused this role for the page or action. |
| `AUTH-105` | Console passkey needed | Add a console passkey to keep using the console. You can add one on the page the console sends you to. | The 14-day window for using the console without a console passkey has ended (00262). |
| `AUTH-201` | Code already sent | A code was sent to this email moments ago. Check your inbox. | The auth server per-address email cooldown (over_email_send_rate_limit). |
| `AUTH-202` | Too many attempts | Too many attempts. Wait a minute and try again. | A request rate limit at the auth server or the edge (over_request_rate_limit). |
| `AUTH-203` | Code expired or wrong | That code has expired or is not right. Ask for a new one. | The auth server rejected the one-time code (otp_expired). |
| `AUTH-204` | Sign-up closed | This address cannot sign in with a code right now. Contact an exec. | The auth server refused the request: otp_disabled or signup_disabled. |
| `AUTH-205` | Sign-in service unavailable | The sign-in service did not answer. Try again in a moment. | The auth server returned a 5xx, or the gateway returned an empty body. |
| `AUTH-206` | Sign-in could not finish | The sign-in could not be completed. Start again from the sign-in page. | The OAuth or code exchange failed: bad_oauth_state, bad_oauth_callback, flow_state_expired, flow_state_not_found, bad_code_verifier, or the callback redirected with error=auth_failed. |
| `AUTH-207` | Sign-in blocked | This account cannot sign in. Contact an exec. | The auth server refused a banned user (user_banned). |
| `AUTH-208` | Passkey sign-in failed | Signing in with your passkey did not work. Try again, or use an email code. | The passkey ceremony was cancelled or its server-side verification failed. |
| `AUTH-209` | Google sign-in could not start | Google sign-in could not start. Try again, or use an email code. | signInWithOAuth returned an error before redirecting to Google. |
| `AUTH-210` | Wrong email or password | That email and password do not match. Try again, or sign in with an email code. | The password grant was refused (invalid_credentials). GoTrue gives the same answer for an unknown email. |
| `AUTH-211` | Email not confirmed | This email is not confirmed yet. Sign in with an email code to confirm it. | The password grant was refused because the email was never confirmed (email_not_confirmed). |
| `AUTH-212` | Password not accepted | That password was not accepted. Choose a longer or less common one. | The password is too short or too long, or the auth server refused it (weak_password), for example from a breach list. |
| `AUTH-213` | Confirmation needed | Changing your password needs the confirmation code we email you. | updateUser refused the password change without a valid nonce (reauthentication_needed or reauthentication_not_valid). |
| `AUTH-214` | Password could not be saved | Your password could not be saved. Try again in a moment. | updateUser failed setting a password with no more specific error. |

## ACC: Account standing

| Code | Title | What the user sees | Likely cause |
| --- | --- | --- | --- |
| `ACC-000` | Account problem | Something about your account stopped this. Contact an exec if it keeps happening. | An account standing failure that matched no more specific code. |
| `ACC-101` | Pending approval | Your account is waiting for an exec to approve it. | players.status is pending_approval. |
| `ACC-102` | Account suspended | Your account is suspended. Contact an exec. | players.status is suspended. |
| `ACC-103` | Account suspended pending reinstatement | Your account is suspended until an exec reinstates it. | players.is_banned is true. |
| `ACC-104` | Account inactive | Your account is inactive or scheduled for deletion. | players.active_flag is false: a deletion request, or a lapse the app could not undo. |
| `ACC-105` | No player record | Your sign-in is not linked to a member profile yet. Contact an exec. | The auth user has no players row with a matching user_id. |

## MEM: Membership

| Code | Title | What the user sees | Likely cause |
| --- | --- | --- | --- |
| `MEM-000` | Membership problem | Something went wrong with your membership details. | A membership failure that matched no more specific code. |
| `MEM-101` | Your fees could not load | We could not read your fees. Try again in a moment. | The member-side club_fees read (with embedded fee_submissions) failed. |
| `MEM-102` | Waiver status unknown | We could not check your waiver. Try again in a moment. | The legal-documents gate could not read the current documents, so it failed closed. |

## FEE: Fees and finance

| Code | Title | What the user sees | Likely cause |
| --- | --- | --- | --- |
| `FEE-000` | Fees problem | Something went wrong on the fees page. | A fees failure that matched no more specific code. |
| `FEE-101` | Fees page could not load | The fees page could not read its data. Try again in a moment. | A read behind /fees (the page, the ledger card or the reinstatements card) failed. |
| `FEE-102` | Payment submissions could not load | The payment submissions could not be read. Try again in a moment. | A read in the fee submissions loader failed. |
| `FEE-103` | Season finances could not load | The season income or expense totals could not be read. | The season finance or season income ledger read failed. |
| `FEE-104` | Outstanding fees could not load | The list of unpaid fees could not be read. | The roster or club_fees read behind the outstanding fees count failed. |
| `FEE-105` | Pasted list could not be checked | The pasted list could not be checked against the roster. Nothing was recorded. Try again in a moment. | A season, players or club_fees read behind the paste-a-list preview failed. |

## SES: Sessions

| Code | Title | What the user sees | Likely cause |
| --- | --- | --- | --- |
| `SES-000` | Sessions problem | Something went wrong with sessions. | A sessions failure that matched no more specific code. |

## TRN: Tournaments

| Code | Title | What the user sees | Likely cause |
| --- | --- | --- | --- |
| `TRN-000` | Tournament problem | Something went wrong with this tournament. | A tournament failure that matched no more specific code. |
| `TRN-101` | Event could not load | This event could not be read. Try again in a moment. | A read behind the member event page (tournament, event, draw, matches or registration) failed. |
| `TRN-102` | Event waiver status unknown | We could not check the event waiver. Try again in a moment. | The tournament waiver text or the event_waiver_acceptances read failed. |
| `TRN-104` | Tournament fees could not load | The fees for this tournament could not be read. | A read behind the console tournament fees page failed. |
| `TRN-105` | Entry groups could not load | Who has paid this season's club fee could not be read, so entry prices cannot be shown. | The season or club-fee read that decides each entrant's entry group failed on the console tournament fees page. |

## CHL: Challenges

| Code | Title | What the user sees | Likely cause |
| --- | --- | --- | --- |
| `CHL-000` | Challenge problem | Something went wrong with challenges. | A challenges failure that matched no more specific code. |

## RAT: Ratings and leaderboard

| Code | Title | What the user sees | Likely cause |
| --- | --- | --- | --- |
| `RAT-000` | Ratings problem | Something went wrong with ratings. | A ratings failure that matched no more specific code. |
| `RAT-101` | Ladder could not load | The ladder could not be read. Try again in a moment. | The ratings read behind the dashboard ladder failed. |

## DB: Database

| Code | Title | What the user sees | Likely cause |
| --- | --- | --- | --- |
| `DB-000` | Database error | The database refused or failed a request. | A database error with no more specific code. The server log has the original message. |
| `DB-101` | Column missing | This part of the app is newer than its database. An exec needs to know. | Postgres 42703 or PostgREST PGRST204: schema drift, usually code deployed ahead of its migration. |
| `DB-102` | Table or function missing | This part of the app is newer than its database. An exec needs to know. | Postgres 42P01 or 42883, or PostgREST PGRST202 or PGRST205: a migration not applied, or the schema cache not reloaded. |
| `DB-103` | Relationship missing | This part of the app is newer than its database. An exec needs to know. | PostgREST PGRST200: an embedded select names a foreign key the schema cache does not have. |
| `DB-201` | Permission denied | The database did not allow this. | Postgres 42501: a missing grant. Read relacl, not information_schema. |
| `DB-301` | Already exists | That already exists. | Postgres 23505: a unique constraint refused a duplicate. |
| `DB-302` | Linked record missing | Something this depends on is missing, or something else still depends on it. | Postgres 23503: a foreign key refused the write. |
| `DB-303` | Value not allowed | A value was missing or not allowed. | Postgres 23514 or 23502: a check or not-null constraint refused the write. |
| `DB-304` | Malformed input | A value was not in the expected format. | Postgres 22P02: invalid text representation, usually a bad UUID or number. |
| `DB-401` | Not found | What you were looking for was not found. It may have been removed. | PostgREST PGRST116, or a required read returned nothing. A row hidden by RLS looks identical to a deleted one. |
| `DB-501` | Database timed out | The database took too long. Try again in a moment. | Postgres 57014: statement timeout or cancelled query. |
| `DB-502` | Busy, try again | Someone else was changing the same thing. Try again. | Postgres 40001, 40P01 or 55P03: a serialization failure, deadlock or lock not available. |
| `DB-503` | Database unavailable | The database is not reachable right now. Try again in a moment. | Postgres 53300, 57P01 or class 08: too many connections, admin shutdown or a connection failure. |
| `DB-601` | Refused by a database rule | The database refused this change. | Postgres P0001: a RAISE EXCEPTION in a function or trigger. The server log has its text. |

## NET: Network

| Code | Title | What the user sees | Likely cause |
| --- | --- | --- | --- |
| `NET-000` | Network problem | A network request failed. Try again in a moment. | A network failure that matched no more specific code. |
| `NET-001` | Could not reach the server | A service the app depends on could not be reached. Try again in a moment. | fetch failed, ECONNREFUSED, ETIMEDOUT, ENOTFOUND or EAI_AGAIN from a server-side request. |
| `NET-002` | Upstream unavailable | A service the app depends on is not answering. Try again in a moment. | An upstream answered 502, 503 or 504, or with an empty {} body through the gateway. |
| `NET-003` | App needs a newer website | This needs a newer version of the club website. Try again after the next update. | The native app called an /api/app route and got a redirect, a 404 or a reply that was not JSON: the website it reached does not serve that route yet. |

## GEN: General

| Code | Title | What the user sees | Likely cause |
| --- | --- | --- | --- |
| `GEN-000` | Unexpected error | Something went wrong. | An error with no code of its own: a plain throw, or a Next digest from before codes existed. |

## Finding it in the logs

Search for the reference, not the code: the code groups many occurrences, the reference
names one. The app may run as several instances, so search the server logs of every running
admin or player instance, not just one.

A page or thrown action logs its digest through Next. A server action that returns its error
as a value (runAction) is not logged by Next, so runAction logs coded failures itself as
`[action] <CODE.ref>`. Sentry events carry the same values as the `error_code` and `error_ref`
tags.
