// STABLE, DOCUMENTED ERROR CODES.
//
// A server error reaches the browser with its message withheld and only a
// `digest`. Next makes that digest a per-crash number, which tells an exec
// nothing and tells a developer only which log line to grep for. Errors raised
// through AppError (./app-error) instead carry `digest = "<CODE>.<ref>"`: the
// code says what kind of failure it was and stays the same forever, the ref is
// random per occurrence and is what to grep the server log for.
//
// THIS FILE HAS NO IMPORTS, on purpose. It is reached from the edge bundle
// (through expected-error.ts, which instrumentation.ts and the Sentry init files
// deep-import) and from client components, so it must not pull in the shared
// barrel, node:crypto or anything else. The registry also ships to the browser:
// nothing in `cause` may be sensitive.
//
// Codes are `AREA-NNN`. Ranges inside an area: 000 unknown, 1xx a load failed
// or a guard refused, 2xx a save or sign-in step failed, 3xx a data conflict,
// 4xx an expected row is missing, 5xx infrastructure, 6xx a database rule.
// NO AREA MAY START WITH "E": Next appends `@E<n>` to digests and reads the
// first `@` segment starting with E as its own error code.
//
// ERROR-CODES.md is generated from this file (see renderErrorCatalogue and the
// catalogue test). Never reuse a retired code for a different meaning.

export const ERROR_AREAS = [
  'AUTH', 'ACC', 'MEM', 'FEE', 'SES', 'TRN', 'CHL', 'RAT', 'DB', 'NET', 'GEN',
] as const;

export type ErrorArea = (typeof ERROR_AREAS)[number];

export const ERROR_AREA_LABELS: Record<ErrorArea, string> = {
  AUTH: 'Sign-in and access',
  ACC: 'Account standing',
  MEM: 'Membership',
  FEE: 'Fees and finance',
  SES: 'Sessions',
  TRN: 'Tournaments',
  CHL: 'Challenges',
  RAT: 'Ratings and leaderboard',
  DB: 'Database',
  NET: 'Network',
  GEN: 'General',
};

export interface ErrorCodeEntry {
  area: ErrorArea;
  /** Short name, shown under the code on the error screen. */
  title: string;
  /** Shown to the user. Plain words, no jargon. */
  meaning: string;
  /** For whoever debugs it. Ships to the client, so nothing sensitive. */
  cause: string;
}

export const ERROR_CODES = {
  'AUTH-000': {
    area: 'AUTH',
    title: 'Sign-in problem',
    meaning: 'Something went wrong while checking who you are. Sign in again and retry.',
    cause: 'An auth failure that matched no more specific code.',
  },
  'AUTH-101': {
    area: 'AUTH',
    title: 'Not signed in',
    meaning: 'You need to be signed in to do this.',
    cause: 'The server found no valid session for the request: no auth cookie, or it expired.',
  },
  'AUTH-102': {
    area: 'AUTH',
    title: 'Passkey check needed',
    meaning: 'Confirm with your passkey, then try again.',
    cause: 'The console passkey step-up gate refused: this session has not verified a passkey.',
  },
  'AUTH-103': {
    area: 'AUTH',
    title: 'Passkey status unknown',
    meaning: 'We could not confirm your passkey setup. Try again in a moment.',
    cause: 'The passkey enrolment lookup failed, so the step-up gate failed closed.',
  },
  'AUTH-104': {
    area: 'AUTH',
    title: 'Not allowed',
    meaning: 'Your role does not allow this.',
    cause: 'The console capability check refused this role for the page or action.',
  },
  'AUTH-105': {
    area: 'AUTH',
    title: 'Console passkey needed',
    meaning: 'Add a console passkey to keep using the console. You can add one on the page the console sends you to.',
    cause: 'The 14-day window for using the console without a console passkey has ended (00262).',
  },
  'AUTH-201': {
    area: 'AUTH',
    title: 'Code already sent',
    meaning: 'A code was sent to this email moments ago. Check your inbox.',
    cause: 'The auth server per-address email cooldown (over_email_send_rate_limit).',
  },
  'AUTH-202': {
    area: 'AUTH',
    title: 'Too many attempts',
    meaning: 'Too many attempts. Wait a minute and try again.',
    cause: 'A request rate limit at the auth server or the edge (over_request_rate_limit).',
  },
  'AUTH-203': {
    area: 'AUTH',
    title: 'Code expired or wrong',
    meaning: 'That code has expired or is not right. Ask for a new one.',
    cause: 'The auth server rejected the one-time code (otp_expired).',
  },
  'AUTH-204': {
    area: 'AUTH',
    title: 'Sign-up closed',
    meaning: 'This address cannot sign in with a code right now. Contact an exec.',
    cause: 'The auth server refused the request: otp_disabled or signup_disabled.',
  },
  'AUTH-205': {
    area: 'AUTH',
    title: 'Sign-in service unavailable',
    meaning: 'The sign-in service did not answer. Try again in a moment.',
    cause: 'The auth server returned a 5xx, or the gateway returned an empty body.',
  },
  'AUTH-206': {
    area: 'AUTH',
    title: 'Sign-in could not finish',
    meaning: 'The sign-in could not be completed. Start again from the sign-in page.',
    cause:
      'The OAuth or code exchange failed: bad_oauth_state, bad_oauth_callback, flow_state_expired, ' +
      'flow_state_not_found, bad_code_verifier, or the callback redirected with error=auth_failed.',
  },
  'AUTH-207': {
    area: 'AUTH',
    title: 'Sign-in blocked',
    meaning: 'This account cannot sign in. Contact an exec.',
    cause: 'The auth server refused a banned user (user_banned).',
  },
  'AUTH-208': {
    area: 'AUTH',
    title: 'Passkey sign-in failed',
    meaning: 'Signing in with your passkey did not work. Try again, or use an email code.',
    cause: 'The passkey ceremony was cancelled or its server-side verification failed.',
  },
  'AUTH-209': {
    area: 'AUTH',
    title: 'Google sign-in could not start',
    meaning: 'Google sign-in could not start. Try again, or use an email code.',
    cause: 'signInWithOAuth returned an error before redirecting to Google.',
  },
  'AUTH-210': {
    area: 'AUTH',
    title: 'Wrong email or password',
    meaning: 'That email and password do not match. Try again, or sign in with an email code.',
    cause: 'The password grant was refused (invalid_credentials). GoTrue gives the same answer for an unknown email.',
  },
  'AUTH-211': {
    area: 'AUTH',
    title: 'Email not confirmed',
    meaning: 'This email is not confirmed yet. Sign in with an email code to confirm it.',
    cause: 'The password grant was refused because the email was never confirmed (email_not_confirmed).',
  },
  'AUTH-212': {
    area: 'AUTH',
    title: 'Password not accepted',
    meaning: 'That password was not accepted. Choose a longer or less common one.',
    cause: 'The password is too short or too long, or the auth server refused it (weak_password), for example from a breach list.',
  },
  'AUTH-213': {
    area: 'AUTH',
    title: 'Confirmation needed',
    meaning: 'Changing your password needs the confirmation code we email you.',
    cause: 'updateUser refused the password change without a valid nonce (reauthentication_needed or reauthentication_not_valid).',
  },
  'AUTH-214': {
    area: 'AUTH',
    title: 'Password could not be saved',
    meaning: 'Your password could not be saved. Try again in a moment.',
    cause: 'updateUser failed setting a password with no more specific error.',
  },

  'ACC-000': {
    area: 'ACC',
    title: 'Account problem',
    meaning: 'Something about your account stopped this. Contact an exec if it keeps happening.',
    cause: 'An account standing failure that matched no more specific code.',
  },
  'ACC-101': {
    area: 'ACC',
    title: 'Pending approval',
    meaning: 'Your account is waiting for an exec to approve it.',
    cause: 'players.status is pending_approval.',
  },
  'ACC-102': {
    area: 'ACC',
    title: 'Account suspended',
    meaning: 'Your account is suspended. Contact an exec.',
    cause: 'players.status is suspended.',
  },
  'ACC-103': {
    area: 'ACC',
    title: 'Account suspended pending reinstatement',
    meaning: 'Your account is suspended until an exec reinstates it.',
    cause: 'players.is_banned is true.',
  },
  'ACC-104': {
    area: 'ACC',
    title: 'Account inactive',
    meaning: 'Your account is inactive or scheduled for deletion.',
    cause: 'players.active_flag is false: a deletion request, or a lapse the app could not undo.',
  },
  'ACC-105': {
    area: 'ACC',
    title: 'No player record',
    meaning: 'Your sign-in is not linked to a member profile yet. Contact an exec.',
    cause: 'The auth user has no players row with a matching user_id.',
  },

  'MEM-000': {
    area: 'MEM',
    title: 'Membership problem',
    meaning: 'Something went wrong with your membership details.',
    cause: 'A membership failure that matched no more specific code.',
  },
  'MEM-101': {
    area: 'MEM',
    title: 'Your fees could not load',
    meaning: 'We could not read your fees. Try again in a moment.',
    cause: 'The member-side club_fees read (with embedded fee_submissions) failed.',
  },
  'MEM-102': {
    area: 'MEM',
    title: 'Waiver status unknown',
    meaning: 'We could not check your waiver. Try again in a moment.',
    cause: 'The legal-documents gate could not read the current documents, so it failed closed.',
  },

  'FEE-000': {
    area: 'FEE',
    title: 'Fees problem',
    meaning: 'Something went wrong on the fees page.',
    cause: 'A fees failure that matched no more specific code.',
  },
  'FEE-101': {
    area: 'FEE',
    title: 'Fees page could not load',
    meaning: 'The fees page could not read its data. Try again in a moment.',
    cause: 'A read behind /fees (the page, the ledger card or the reinstatements card) failed.',
  },
  'FEE-102': {
    area: 'FEE',
    title: 'Payment submissions could not load',
    meaning: 'The payment submissions could not be read. Try again in a moment.',
    cause: 'A read in the fee submissions loader failed.',
  },
  'FEE-103': {
    area: 'FEE',
    title: 'Season finances could not load',
    meaning: 'The season income or expense totals could not be read.',
    cause: 'The season finance or season income ledger read failed.',
  },
  'FEE-104': {
    area: 'FEE',
    title: 'Outstanding fees could not load',
    meaning: 'The list of unpaid fees could not be read.',
    cause: 'The roster or club_fees read behind the outstanding fees count failed.',
  },
  'FEE-105': {
    area: 'FEE',
    title: 'Pasted list could not be checked',
    meaning: 'The pasted list could not be checked against the roster. Nothing was recorded. Try again in a moment.',
    cause: 'A season, players or club_fees read behind the paste-a-list preview failed.',
  },

  'SES-000': {
    area: 'SES',
    title: 'Sessions problem',
    meaning: 'Something went wrong with sessions.',
    cause: 'A sessions failure that matched no more specific code.',
  },

  'TRN-000': {
    area: 'TRN',
    title: 'Tournament problem',
    meaning: 'Something went wrong with this tournament.',
    cause: 'A tournament failure that matched no more specific code.',
  },
  'TRN-101': {
    area: 'TRN',
    title: 'Event could not load',
    meaning: 'This event could not be read. Try again in a moment.',
    cause: 'A read behind the member event page (tournament, event, draw, matches or registration) failed.',
  },
  'TRN-102': {
    area: 'TRN',
    title: 'Event waiver status unknown',
    meaning: 'We could not check the event waiver. Try again in a moment.',
    cause: 'The tournament waiver text or the event_waiver_acceptances read failed.',
  },
  'TRN-104': {
    area: 'TRN',
    title: 'Tournament fees could not load',
    meaning: 'The fees for this tournament could not be read.',
    cause: 'A read behind the console tournament fees page failed.',
  },
  'TRN-105': {
    area: 'TRN',
    title: 'Entry groups could not load',
    meaning: "Who has paid this season's club fee could not be read, so entry prices cannot be shown.",
    cause: 'The season or club-fee read that decides each entrant\'s entry group failed on the console tournament fees page.',
  },

  'CHL-000': {
    area: 'CHL',
    title: 'Challenge problem',
    meaning: 'Something went wrong with challenges.',
    cause: 'A challenges failure that matched no more specific code.',
  },

  'RAT-000': {
    area: 'RAT',
    title: 'Ratings problem',
    meaning: 'Something went wrong with ratings.',
    cause: 'A ratings failure that matched no more specific code.',
  },
  'RAT-101': {
    area: 'RAT',
    title: 'Ladder could not load',
    meaning: 'The ladder could not be read. Try again in a moment.',
    cause: 'The ratings read behind the dashboard ladder failed.',
  },

  'DB-000': {
    area: 'DB',
    title: 'Database error',
    meaning: 'The database refused or failed a request.',
    cause: 'A database error with no more specific code. The server log has the original message.',
  },
  'DB-101': {
    area: 'DB',
    title: 'Column missing',
    meaning: 'This part of the app is newer than its database. An exec needs to know.',
    cause: 'Postgres 42703 or PostgREST PGRST204: schema drift, usually code deployed ahead of its migration.',
  },
  'DB-102': {
    area: 'DB',
    title: 'Table or function missing',
    meaning: 'This part of the app is newer than its database. An exec needs to know.',
    cause:
      'Postgres 42P01 or 42883, or PostgREST PGRST202 or PGRST205: a migration not applied, or the ' +
      'schema cache not reloaded.',
  },
  'DB-103': {
    area: 'DB',
    title: 'Relationship missing',
    meaning: 'This part of the app is newer than its database. An exec needs to know.',
    cause: 'PostgREST PGRST200: an embedded select names a foreign key the schema cache does not have.',
  },
  'DB-201': {
    area: 'DB',
    title: 'Permission denied',
    meaning: 'The database did not allow this.',
    cause: 'Postgres 42501: a missing grant. Read relacl, not information_schema.',
  },
  'DB-301': {
    area: 'DB',
    title: 'Already exists',
    meaning: 'That already exists.',
    cause: 'Postgres 23505: a unique constraint refused a duplicate.',
  },
  'DB-302': {
    area: 'DB',
    title: 'Linked record missing',
    meaning: 'Something this depends on is missing, or something else still depends on it.',
    cause: 'Postgres 23503: a foreign key refused the write.',
  },
  'DB-303': {
    area: 'DB',
    title: 'Value not allowed',
    meaning: 'A value was missing or not allowed.',
    cause: 'Postgres 23514 or 23502: a check or not-null constraint refused the write.',
  },
  'DB-304': {
    area: 'DB',
    title: 'Malformed input',
    meaning: 'A value was not in the expected format.',
    cause: 'Postgres 22P02: invalid text representation, usually a bad UUID or number.',
  },
  'DB-401': {
    area: 'DB',
    title: 'Not found',
    meaning: 'What you were looking for was not found. It may have been removed.',
    cause:
      'PostgREST PGRST116, or a required read returned nothing. A row hidden by RLS looks identical ' +
      'to a deleted one.',
  },
  'DB-501': {
    area: 'DB',
    title: 'Database timed out',
    meaning: 'The database took too long. Try again in a moment.',
    cause: 'Postgres 57014: statement timeout or cancelled query.',
  },
  'DB-502': {
    area: 'DB',
    title: 'Busy, try again',
    meaning: 'Someone else was changing the same thing. Try again.',
    cause: 'Postgres 40001, 40P01 or 55P03: a serialization failure, deadlock or lock not available.',
  },
  'DB-503': {
    area: 'DB',
    title: 'Database unavailable',
    meaning: 'The database is not reachable right now. Try again in a moment.',
    cause: 'Postgres 53300, 57P01 or class 08: too many connections, admin shutdown or a connection failure.',
  },
  'DB-601': {
    area: 'DB',
    title: 'Refused by a database rule',
    meaning: 'The database refused this change.',
    cause: 'Postgres P0001: a RAISE EXCEPTION in a function or trigger. The server log has its text.',
  },

  'NET-000': {
    area: 'NET',
    title: 'Network problem',
    meaning: 'A network request failed. Try again in a moment.',
    cause: 'A network failure that matched no more specific code.',
  },
  'NET-001': {
    area: 'NET',
    title: 'Could not reach the server',
    meaning: 'A service the app depends on could not be reached. Try again in a moment.',
    cause: 'fetch failed, ECONNREFUSED, ETIMEDOUT, ENOTFOUND or EAI_AGAIN from a server-side request.',
  },
  'NET-002': {
    area: 'NET',
    title: 'Upstream unavailable',
    meaning: 'A service the app depends on is not answering. Try again in a moment.',
    cause: 'An upstream answered 502, 503 or 504, or with an empty {} body through the gateway.',
  },
  'NET-003': {
    area: 'NET',
    title: 'App needs a newer website',
    meaning: 'This needs a newer version of the club website. Try again after the next update.',
    cause: 'The native app called an /api/app route and got a redirect, a 404 or a reply that was not JSON: the website it reached does not serve that route yet.',
  },

  'GEN-000': {
    area: 'GEN',
    title: 'Unexpected error',
    meaning: 'Something went wrong.',
    cause: 'An error with no code of its own: a plain throw, or a Next digest from before codes existed.',
  },
} as const satisfies Record<string, ErrorCodeEntry>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_CODE_PATTERN = /^[A-Z]{2,4}-\d{3}$/;

const DIGEST_PATTERN = /^([A-Z]{2,4}-\d{3})\.([a-z0-9]+)$/;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}

export function errorCodeEntry(code: string): ErrorCodeEntry | null {
  return isErrorCode(code) ? ERROR_CODES[code] : null;
}

const REF_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 8 lowercase base36 characters, random per occurrence. What to grep the log for. */
export function makeErrorRef(): string {
  const bytes = new Uint8Array(8);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}

export function formatDigest(code: ErrorCode, ref: string): string {
  return `${code}.${ref}`;
}

export interface ParsedDigest {
  code: string;
  ref: string;
  /** False for a well-formed code this build does not know (version skew). */
  known: boolean;
}

/**
 * Reads a digest back. A coded digest comes back as its code and ref; an
 * unknown but well-formed code is kept verbatim, because a newer server can
 * send a code an older client has never heard of. Anything else (Next's
 * numeric digest) becomes `<area>-000` with the whole digest as the ref.
 */
export function parseErrorDigest(digest: string, area: ErrorArea = 'GEN'): ParsedDigest {
  const bare = digest.split('@')[0] ?? '';
  const match = DIGEST_PATTERN.exec(bare);
  if (match) {
    const [, code = '', ref = ''] = match;
    return { code, ref, known: isErrorCode(code) };
  }
  return { code: `${area}-000`, ref: bare, known: true };
}

const GENERIC_SERVER_PREFIX = 'An error occurred in the Server Components render';

/** Next replaces a server error's message with this text in production builds. */
export function isGenericServerMessage(message: string | undefined | null): boolean {
  return typeof message === 'string' && message.startsWith(GENERIC_SERVER_PREFIX);
}

export const ERROR_FALLBACK_MESSAGE =
  'Something went wrong loading this page. Try again, and if it keeps happening, send the error code below to an exec.';

export interface ErrorDescription {
  /** The main line. The fallback for a server error, the error's own text for a client one. */
  message: string;
  /** null for a client-side error, which has no digest. */
  code: string | null;
  ref: string | null;
  /** The registry entry, when this build knows the code. */
  entry: ErrorCodeEntry | null;
  /** `CODE.ref`, what Copy puts on the clipboard. */
  copyText: string | null;
}

export function describeError(
  error: { message?: string; digest?: string } | undefined | null,
  area: ErrorArea = 'GEN',
  fallback: string = ERROR_FALLBACK_MESSAGE,
): ErrorDescription {
  const digest = error?.digest;
  if (!digest) {
    const own = error?.message;
    const message = !own || isGenericServerMessage(own) ? fallback : own;
    return { message, code: null, ref: null, entry: null, copyText: null };
  }
  const parsed = parseErrorDigest(digest, area);
  return {
    message: fallback,
    code: parsed.code,
    ref: parsed.ref,
    entry: errorCodeEntry(parsed.code),
    copyText: `${parsed.code}.${parsed.ref}`,
  };
}

/**
 * Toast text for a thrown server action. In production Next swaps the message
 * for its generic text, so show the caller's fallback with the code to report.
 * An ordinary message (dev, or a client-side throw) is shown as it always was.
 */
export function errorToastText(err: unknown, area: ErrorArea, fallback: string): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { message?: unknown; digest?: unknown };
  const message = typeof e.message === 'string' ? e.message : '';
  const digest = typeof e.digest === 'string' && e.digest ? e.digest : undefined;
  const coded = digest !== undefined && DIGEST_PATTERN.test(digest.split('@')[0] ?? '');
  if (coded || isGenericServerMessage(message)) {
    const { copyText } = describeError({ message, digest }, area, fallback);
    return copyText ? `${fallback} (${copyText})` : fallback;
  }
  return err instanceof Error ? message : fallback;
}

/** The markdown written to packages/shared/ERROR-CODES.md by the catalogue test. */
export function renderErrorCatalogue(): string {
  const lines: string[] = [
    '# Error codes',
    '',
    'Generated from `packages/shared/src/utils/error-codes.ts`. Do not edit by hand: change the',
    'registry and regenerate with `npm test -w @badminton/shared -- -u`.',
    '',
    'An error screen or toast shows a code like `DB-101.k3x9q2ab`. The part before the dot is the',
    'code below and never changes meaning. The part after it is a random reference for that one',
    'occurrence, and it is what to search the server log for.',
    '',
    'Ranges inside an area: 000 unknown, 1xx a load failed or a guard refused, 2xx a save or sign-in',
    'step failed, 3xx a data conflict, 4xx an expected row is missing, 5xx infrastructure, 6xx a',
    'database rule. A reference made only of digits (`GEN-000.2299239490`) came from an error that',
    'had no code of its own, and the digits are the digest Next printed in the log.',
    '',
  ];
  for (const area of ERROR_AREAS) {
    lines.push(`## ${area}: ${ERROR_AREA_LABELS[area]}`, '');
    lines.push('| Code | Title | What the user sees | Likely cause |', '| --- | --- | --- | --- |');
    for (const [code, entry] of Object.entries(ERROR_CODES) as [ErrorCode, ErrorCodeEntry][]) {
      if (entry.area !== area) continue;
      lines.push(`| \`${code}\` | ${entry.title} | ${entry.meaning} | ${entry.cause} |`);
    }
    lines.push('');
  }
  lines.push(
    '## Finding it in the logs',
    '',
    'Search for the reference, not the code: the code groups many occurrences, the reference',
    'names one. The app may run as several instances, so search the server logs of every running',
    'admin or player instance, not just one.',
    '',
    'A page or thrown action logs its digest through Next. A server action that returns its error',
    'as a value (runAction) is not logged by Next, so runAction logs coded failures itself as',
    '`[action] <CODE.ref>`. Sentry events carry the same values as the `error_code` and `error_ref`',
    'tags.',
    '',
  );
  return lines.join('\n');
}
