import { Resend } from 'resend';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  challengeReceivedEmail,
  challengeAcceptedEmail,
  challengeRejectedEmail,
  resultPendingEmail,
  matchConfirmedEmail,
  disputeOpenedEmail,
  walkoverReportedEmail,
  playerApprovedEmail,
  accountInactiveEmail,
  weeklyDigestEmail,
} from './templates';
import { buildUnsubscribeUrl } from './unsubscribe';
import { isEmailCategoryEnabled, type NotificationCategory } from '../utils/notifications';
import { getServerSupabaseUrl } from '../utils/supabase-url';

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

// Must be a domain verified in Resend, or every send fails. This previously
// pointed at badminton.club — never owned or verified — so all app notification
// mail (challenge received, result pending, disputes, walkovers) failed
// silently while auth codes kept working, because those go through GoTrue from
// login@mail.sfubadminton.com instead. Overridable so a staging clone can point
// somewhere harmless without a code change.
const FROM = process.env.EMAIL_FROM || 'SFU Badminton <noreply@mail.sfubadminton.com>';

// Its own service-role client rather than one passed in by the caller. The
// sibling push module takes an adminClient as a parameter, but that only works
// because its single caller already holds one; the mail senders are invoked
// from six different server actions that have nothing but a bare address in
// hand. Threading a client through all of them would make the suppression check
// something a future call site can forget to do — and a check that can be
// forgotten is the one failure mode this must not have.
let admin: SupabaseClient | null = null;

function getAdmin(): SupabaseClient | null {
  if (admin) return admin;
  const url = getServerSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  admin = createClient(url, key);
  return admin;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  headers?: Record<string, string>,
): Promise<{ providerMessageId: string | null }> {
  // Throws on failure so callers can decide whether to swallow + log.
  // We deliberately don't catch internally — earlier behaviour double-swallowed
  // errors (here and at every call site), making delivery failures invisible.
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not set');
  }
  const r = getResend();
  const { data, error } = await r.emails.send({ from: FROM, to, subject, html, headers });
  if (error) {
    throw new Error(`Resend send failed: ${error.message}`);
  }
  // Returned, not discarded. It is the only durable link between a member who
  // says the mail never arrived and the provider's own log of what happened to
  // it, and the weekly digest now writes it down per recipient. Callers that do
  // not care simply ignore it; nothing about the throw-on-failure contract
  // changes. `null` rather than undefined so a caller storing it has one shape
  // to handle whether or not the provider named the message.
  return { providerMessageId: data?.id ?? null };
}

export type SendOutcome =
  | { sent: true; providerMessageId: string | null }
  | { sent: false; reason: 'suppressed' | 'opted_out' };

/**
 * Every notification email goes through here.
 *
 * Two gates before anything is handed to the provider:
 *   1. the address is on email_suppressions (hard bounce, complaint, or a
 *      one-click unsubscribe-from-all), or belongs to a guest record;
 *   2. the member turned this category's email off.
 *
 * A blocked send is NOT an error. `sendEmail` throws by design so that genuine
 * delivery failures stay visible, and every call site logs what it catches — so
 * throwing here would file "this person unsubscribed" as a delivery incident in
 * Sentry. It returns an outcome instead.
 *
 * Sign-in codes do NOT come through here: those are issued by GoTrue, and a
 * member must always be able to get into their account.
 *
 * `transactional` skips gate 2 only. It is for the one-off mail that IS the
 * event rather than a subscription to it — currently just "your account has
 * been approved", which a brand-new member has to receive to know the app is
 * open to them. Since 00058 made preferences opt-in, a new member's blob is
 * empty, so without this that email would never arrive and the account would
 * look stuck at "pending" forever. Gate 1 (suppressions, bounces, complaints,
 * unsubscribe-from-all) still applies — nothing bypasses that.
 */
async function sendCategoryEmail(
  to: string,
  category: NotificationCategory,
  subject: string,
  html: string,
  options: { transactional?: boolean } = {},
): Promise<SendOutcome> {
  const address = to.trim().toLowerCase();
  const db = getAdmin();

  if (db) {
    const { data: blocked, error: blockedError } = await db
      .from('email_suppressions')
      .select('email')
      .eq('email', address)
      .maybeSingle();
    // THE ERROR IS CHECKED, and this is the line that makes the docstring true.
    //
    // A failed PostgREST read does not throw — an RLS change, an expired key or
    // a transient fault arrives as `data: null` with an error set. Destructuring
    // the error away left `blocked` falsy, so the mail went to an address that
    // had hard-bounced, filed a spam complaint, or clicked
    // unsubscribe-from-all. Silently, in the one gate this file calls "the gate
    // that must never fail open".
    //
    // It THROWS rather than returning a SendOutcome, deliberately. `suppressed`
    // and `opted_out` mean "the system worked and the answer was no"; this means
    // the system did not work, which is exactly the kind of thing sendEmail
    // already throws for. All ten call sites catch and capture to Sentry, so a
    // broken gate becomes a visible incident instead of an invisible send.
    if (blockedError) {
      throw new Error(`Suppression check failed, refusing to send: ${blockedError.message}`);
    }
    if (blocked) return { sent: false, reason: 'suppressed' };

    // A guest record (00292: a Google Form non-member entered in a tournament)
    // is sent nothing until they sign in, and transactional mail is no
    // exception. Like the suppression list, a failed read refuses to send.
    const { data: guests, error: guestError } = await db
      .from('players')
      .select('id')
      .eq('email', address)
      .eq('is_guest', true)
      .limit(1);
    if (guestError) {
      throw new Error(`Guest check failed, refusing to send: ${guestError.message}`);
    }
    if ((guests ?? []).length > 0) return { sent: false, reason: 'suppressed' };

    // Preferences are looked up by address because that is all the call sites
    // have. Since 00058 the model is opt-IN: a stored preference now has to say
    // `true` for the mail to go out.
    //
    // A MISSING row still sends, exactly as before. Every call site takes the
    // address straight off a players row, so "no row" in practice means the
    // lookup missed — an address stored with different casing, say — and
    // treating a failed lookup as a refusal would silently stop that member's
    // mail with nothing to show for it. Failing open here is deliberate; the
    // suppression list above is the gate that must never fail open.
    if (!options.transactional) {
      // `preferenceError` is read and then deliberately NOT acted on — named
      // rather than destructured away so the asymmetry with the suppression
      // read above is visible instead of looking like the same oversight. The
      // reasoning is the paragraph above this one: a preference lookup that
      // fails is not evidence the member said no, and silencing their mail on
      // that basis is the worse error. The suppression list is the opposite
      // case and now throws.
      const { data: player, error: preferenceError } = await db
        .from('players')
        .select('notification_preferences')
        .eq('email', address)
        .maybeSingle();
      // The POLICY does not change — a failed preference read still sends, for
      // the reason above. What changes is that it stops being silent. One
      // member's lookup failing is noise; the read failing for EVERY recipient
      // of a digest run means the club just mailed everyone who opted out, and
      // the old `void preferenceError` left exactly nothing to notice that by.
      // Same lesson as the suppression gate above, one severity down: fail open
      // if you must, but never fail open quietly.
      if (preferenceError) warnPreferenceCheckFailed(preferenceError.message);
      if (player && !isEmailCategoryEnabled(player.notification_preferences, category)) {
        return { sent: false, reason: 'opted_out' };
      }
    }
  }
  // A missing service-role key means we cannot check, and silently dropping
  // every notification would be worse than sending one the member muted. Fall
  // through and send.

  const base = process.env.NEXT_PUBLIC_PLAYER_URL;
  const allUrl = safeUnsubscribeUrl(base, address);
  const oneUrl = safeUnsubscribeUrl(base, address, category);
  // The degradation below is deliberate and stays. What was missing was any way
  // to KNOW it had happened — see warnUnsubscribeUnavailable.
  if (!allUrl && !oneUrl) warnUnsubscribeUnavailable(base);

  const headers: Record<string, string> = {};
  if (allUrl) {
    // RFC 8058. List-Unsubscribe-Post is what makes Gmail/Outlook render their
    // own one-click control and POST it directly, which is far better for
    // reputation than the recipient reaching for "mark as spam" instead.
    headers['List-Unsubscribe'] = `<${allUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const { providerMessageId } = await sendEmail(
    to, subject, withUnsubscribeFooter(html, oneUrl, allUrl), headers);
  return { sent: true, providerMessageId };
}

// ONCE PER PROCESS, TO THE CONTAINER LOG, AND NOT TO THE RECIPIENT.
//
// EMAIL_UNSUBSCRIBE_SECRET was never set on production, and the reason it went
// unnoticed for the club's entire history of sending mail is this file: the
// catch below turns "not set" into `null`, `null` skips the RFC 8058 headers,
// and a `null` for BOTH urls also short-circuits withUnsubscribeFooter — so all
// ten senders quietly dropped every unsubscribe affordance they have and left
// "Report spam" as the recipient's only lever. Nothing was logged, nothing
// failed, and no email looked wrong.
//
// Failing open is still right: the footer and the header are additive, and
// losing a notification is worse than losing its footer. So this does not
// change what happens to the mail — it changes whether anyone can find out.
//
// ONCE, because the alternative is a line per notification: the weekly digest
// alone would bury the log in a few hundred identical warnings, and a warning
// nobody can read is the state this is trying to leave. Follows the readiness
// probe's convention — console to the container log, where an operator can see
// it and a recipient cannot.
//
// The variable is NAMED, and which one it is gets worked out here rather than
// guessed by whoever reads the log: an absent base URL and an absent secret
// produce exactly the same `null`, and they are fixed in different places.
let unsubscribeWarningIssued = false;

function warnUnsubscribeUnavailable(base: string | undefined): void {
  if (unsubscribeWarningIssued) return;
  unsubscribeWarningIssued = true;

  const cause = !base
    ? 'NEXT_PUBLIC_PLAYER_URL is not set'
    : !process.env.EMAIL_UNSUBSCRIBE_SECRET
    ? 'EMAIL_UNSUBSCRIBE_SECRET is not set'
    : `NEXT_PUBLIC_PLAYER_URL (${base}) did not produce a usable unsubscribe URL`;

  console.warn(
    `email: sending with NO unsubscribe link and NO List-Unsubscribe header — ${cause}. ` +
    'Every notification email from this container leaves "Report spam" as the recipient\'s only ' +
    'option, which costs sender reputation for the whole club. Set it in .env and restart. ' +
    'Reported once per process.',
  );
}

// ONCE PER PROCESS, like the unsubscribe warning above and for the same reason:
// this sits inside the per-recipient loop of every bulk send, so reporting each
// occurrence would turn one broken read into thousands of identical lines.
let preferenceWarningIssued = false;

function warnPreferenceCheckFailed(message: string): void {
  if (preferenceWarningIssued) return;
  preferenceWarningIssued = true;

  console.warn(
    `email: the notification-preference lookup failed (${message}). Mail is still being sent — ` +
    'a failed lookup is not evidence the member said no — but while this persists, category ' +
    'opt-outs are NOT being honoured. Reported once per process.',
  );
}

// Never let a missing secret or base URL turn into a failed notification: the
// footer and header are additive, so losing them is better than losing the mail.
function safeUnsubscribeUrl(
  base: string | undefined,
  address: string,
  category?: NotificationCategory,
): string | null {
  try {
    return buildUnsubscribeUrl(base, address, category);
  } catch {
    return null;
  }
}

function withUnsubscribeFooter(
  html: string,
  oneUrl: string | null,
  allUrl: string | null,
): string {
  if (!oneUrl && !allUrl) return html;
  const parts: string[] = [];
  if (oneUrl) parts.push(`<a href="${oneUrl}" style="color:#666">Turn off these emails</a>`);
  if (allUrl) parts.push(`<a href="${allUrl}" style="color:#666">Unsubscribe from all</a>`);
  return `${html}
<div style="margin-top:24px;padding-top:12px;border-top:1px solid #eee;font-size:12px;color:#666;font-family:sans-serif">
  ${parts.join(' &middot; ')}
  <br />You are receiving this because you are a member of the SFU Badminton Club.
</div>`;
}

export async function sendChallengeReceivedEmail(
  to: string,
  challengerName: string,
  format: string,
  type: string,
  challengeId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges/${challengeId}`;
  const { subject, html } = challengeReceivedEmail(challengerName, format, type, url);
  return sendCategoryEmail(to, 'challenges', subject, html);
}

export async function sendChallengeAcceptedEmail(
  to: string,
  opponentName: string,
  challengeId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges/${challengeId}`;
  const { subject, html } = challengeAcceptedEmail(opponentName, url);
  return sendCategoryEmail(to, 'challenges', subject, html);
}

export async function sendChallengeRejectedEmail(
  to: string,
  opponentName: string,
  challengeId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges/${challengeId}`;
  const { subject, html } = challengeRejectedEmail(opponentName, url);
  return sendCategoryEmail(to, 'challenges', subject, html);
}

export async function sendResultPendingEmail(
  to: string,
  submitterName: string,
  score: string,
  matchId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges`;
  const { subject, html } = resultPendingEmail(submitterName, score, url);
  return sendCategoryEmail(to, 'matches', subject, html);
}

export async function sendMatchConfirmedEmail(
  to: string,
  opponentName: string,
  score: string,
  eloDelta: number,
  newRating: number,
  matchType: string
): Promise<SendOutcome> {
  const { subject, html } = matchConfirmedEmail(opponentName, score, eloDelta, newRating, matchType);
  return sendCategoryEmail(to, 'matches', subject, html);
}

// Dispute and walkover mail goes to ADMINS, not to the member involved. They are
// still categorised and still honour opt-out: an admin is a member too, and an
// operational alert nobody wants is exactly what teaches people to mark mail as
// spam.
export async function sendDisputeOpenedEmail(
  to: string,
  matchScore: string,
  reason: string,
  matchId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:3001'}/disputes`;
  const { subject, html } = disputeOpenedEmail(matchScore, reason, url);
  return sendCategoryEmail(to, 'matches', subject, html);
}

export async function sendWalkoverReportedEmail(
  to: string,
  forfeitPlayerName: string,
  walkoverType: string,
  challengeId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:3001'}/walkovers`;
  const { subject, html } = walkoverReportedEmail(forfeitPlayerName, walkoverType, url);
  return sendCategoryEmail(to, 'matches', subject, html);
}

export async function sendPlayerApprovedEmail(
  to: string,
  name: string
): Promise<SendOutcome> {
  const loginUrl = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/login`;
  const { subject, html } = playerApprovedEmail(name, loginUrl);
  // Transactional: this is the message that tells someone the club has let them
  // in, and it is sent to an account whose preferences are still empty because
  // they have never seen the settings page. Gating it on an opt-in they have had
  // no opportunity to give would leave every new member staring at "pending".
  return sendCategoryEmail(to, 'announcements', subject, html, { transactional: true });
}

export async function sendAccountInactiveEmail(
  to: string,
  name: string,
  thresholdDays: number,
  purgeAfterDays: number,
): Promise<SendOutcome> {
  const loginUrl = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/login`;
  const { subject, html } = accountInactiveEmail(name, thresholdDays, loginUrl, purgeAfterDays);
  // Transactional, on the same reasoning as the approved email: this IS the
  // event, not a subscription to a stream of them. Two things make it so.
  //
  // It is about the state of the recipient's own membership and the action
  // needed to undo it — a member who muted "announcements" muted club news, and
  // has not thereby consented to never being told their membership was
  // deactivated. And since 00058 made preferences opt-IN, the population this
  // reaches is exactly the population least likely to have opted into anything:
  // people who stopped coming, many of whom never opened the settings page.
  // Category-gating it would mean the notice arrives for almost nobody, which
  // is indistinguishable from not building it.
  //
  // Gate 1 is untouched and must stay so: hard bounces, complaints and
  // unsubscribe-from-all still block the send. The RFC 8058 headers and the
  // unsubscribe footer are added unconditionally by sendCategoryEmail, so this
  // notice carries them too — correct, and the same as the approved email.
  return sendCategoryEmail(to, 'announcements', subject, html, { transactional: true });
}

export async function sendWeeklyDigestEmail(
  to: string,
  name: string,
  data: {
    matchesPlayed: number;
    wins: number;
    losses: number;
    /** NULL across a season rollover, where no Elo figure is safe to state. */
    eloChange: number | null;
    /** NULL where the member did not play that discipline this week. */
    singlesRating: number | null;
    doublesRating: number | null;
    rank?: number;
  }
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/my-stats`;
  const { subject, html } = weeklyDigestEmail(name, data, url);
  return sendCategoryEmail(to, 'announcements', subject, html);
}
