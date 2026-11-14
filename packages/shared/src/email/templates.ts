const BRAND_STYLES = `
  font-family: 'DM Sans', -apple-system, sans-serif;
  max-width: 600px;
  margin: 0 auto;
  background: #16213E;
  color: #f4f4f5;
  padding: 32px;
  border-radius: 12px;
`;

const BUTTON_STYLES = `
  display: inline-block;
  background: #E94560;
  color: #ffffff;
  padding: 14px 28px;
  border-radius: 8px;
  text-decoration: none;
  font-weight: 600;
  margin-top: 16px;
`;

const MUTED = 'color: #a1a1aa; font-size: 14px;';
const DIVIDER = '<hr style="border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 24px 0;" />';

// Every dynamic value below is user-controlled (display names, scores, dispute
// reasons) and lands in an HTML email body. Without escaping, a player whose
// name is `<a href="...">` can inject links/markup into opponent and admin
// inboxes — content spoofing / phishing. Escape at every interpolation.
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Subjects are headers, not HTML: strip CR/LF so a crafted name can't inject
// extra headers, and collapse the remaining whitespace.
function subj(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function wrap(content: string): string {
  return `<div style="${BRAND_STYLES}">${content}<p style="${MUTED} margin-top: 32px;">SFU Badminton Club</p></div>`;
}

export function magicLinkEmail(loginUrl: string): { subject: string; html: string } {
  return {
    subject: 'Your SFU Badminton Login Link',
    html: wrap(`
      <h2 style="color: #E94560; margin-bottom: 16px;">Sign In</h2>
      <p>Click below to sign in to SFU Badminton Club. This link expires in 10 minutes.</p>
      <a href="${escapeHtml(loginUrl)}" style="${BUTTON_STYLES}">Sign In</a>
      <p style="${MUTED} margin-top: 16px;">If you didn't request this, you can safely ignore this email.</p>
    `),
  };
}

export function welcomeEmail(name: string, loginUrl: string): { subject: string; html: string } {
  return {
    subject: 'Welcome to SFU Badminton Club!',
    html: wrap(`
      <h1 style="color: #E94560; margin-bottom: 16px;">Welcome, ${escapeHtml(name)}!</h1>
      <p>Your account has been approved. You can now log in and start challenging other players.</p>
      <p>You start with a <strong>400 Elo</strong> rating in both singles and doubles.</p>
      <a href="${escapeHtml(loginUrl)}" style="${BUTTON_STYLES}">Log In</a>
    `),
  };
}

export function challengeReceivedEmail(challengerName: string, format: string, type: string, url: string): { subject: string; html: string } {
  return {
    subject: `New Challenge from ${subj(challengerName)}`,
    html: wrap(`
      <h2 style="color: #E94560;">New Challenge!</h2>
      <p><strong>${escapeHtml(challengerName)}</strong> has challenged you to a <strong>${escapeHtml(format)}</strong> ${escapeHtml(type)} match.</p>
      <p style="${MUTED}">Challenges expire after 72 hours.</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Challenge</a>
    `),
  };
}

export function challengeAcceptedEmail(opponentName: string, url: string): { subject: string; html: string } {
  return {
    subject: `${subj(opponentName)} accepted your challenge!`,
    html: wrap(`
      <h2 style="color: #10B981;">Challenge Accepted</h2>
      <p><strong>${escapeHtml(opponentName)}</strong> has accepted your challenge. Time to play!</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Challenge</a>
    `),
  };
}

export function challengeRejectedEmail(opponentName: string, url: string): { subject: string; html: string } {
  return {
    subject: `${subj(opponentName)} declined your challenge`,
    html: wrap(`
      <h2 style="color: #F59E0B;">Challenge Declined</h2>
      <p><strong>${escapeHtml(opponentName)}</strong> has declined your challenge.</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Challenges</a>
    `),
  };
}

export function resultPendingEmail(submitterName: string, score: string, url: string): { subject: string; html: string } {
  return {
    subject: 'Match Result Needs Confirmation',
    html: wrap(`
      <h2 style="color: #E94560;">Confirm Match Result</h2>
      <p><strong>${escapeHtml(submitterName)}</strong> submitted a match result: <strong>${escapeHtml(score)}</strong></p>
      <p style="${MUTED}">Please confirm or dispute this result.</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">Confirm Result</a>
    `),
  };
}

export function matchConfirmedEmail(opponentName: string, score: string, eloDelta: number, newRating: number, matchType: string): { subject: string; html: string } {
  const deltaStr = eloDelta >= 0 ? `+${eloDelta}` : `${eloDelta}`;
  const deltaColor = eloDelta >= 0 ? '#10B981' : '#EF4444';
  return {
    subject: `Match confirmed — ${deltaStr} Elo`,
    html: wrap(`
      <h2 style="color: #E94560;">Match Confirmed</h2>
      <p>Your ${escapeHtml(matchType)} match vs <strong>${escapeHtml(opponentName)}</strong> is confirmed.</p>
      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin: 16px 0;">
        <p style="margin: 4px 0;">Score: <strong>${escapeHtml(score)}</strong></p>
        <p style="margin: 4px 0;">Elo Change: <strong style="color: ${deltaColor};">${deltaStr}</strong></p>
        <p style="margin: 4px 0;">New Rating: <strong>${newRating}</strong></p>
      </div>
    `),
  };
}

export function disputeOpenedEmail(matchScore: string, reason: string, url: string): { subject: string; html: string } {
  return {
    subject: 'Match Result Disputed',
    html: wrap(`
      <h2 style="color: #EF4444;">Dispute Opened</h2>
      <p>A dispute has been opened for match with score: <strong>${escapeHtml(matchScore)}</strong></p>
      <p style="${MUTED}">Reason: ${escapeHtml(reason)}</p>
      <p>An admin will review this dispute.</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Details</a>
    `),
  };
}

export function walkoverReportedEmail(forfeitPlayerName: string, walkoverType: string, url: string): { subject: string; html: string } {
  return {
    subject: 'Walkover Reported',
    html: wrap(`
      <h2 style="color: #F59E0B;">Walkover Reported</h2>
      <p>A <strong>${escapeHtml(walkoverType)}</strong> walkover has been reported for <strong>${escapeHtml(forfeitPlayerName)}</strong>.</p>
      <p style="${MUTED}">An admin will review within 48 hours.</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Details</a>
    `),
  };
}

export function playerApprovedEmail(name: string, loginUrl: string): { subject: string; html: string } {
  return welcomeEmail(name, loginUrl);
}

// "Your membership went inactive" — sent once per lapse, by the console's
// /api/cron/inactivity-notices sweep.
//
// THE WORDING IS THE CAREFUL PART, and the reason it changed.
//
// This copy used to say "nothing has been deleted" full stop, because at the
// time that was simply true: no job removed anything from an inactive account
// on any timetable. The club owner has since approved a one-year retention
// limit, and purge-inactive-accounts implements it — so the old wording is now
// the one thing a retention notice must never be, which is false in the
// direction that costs the reader something. A member who reads "nothing is
// deleted" and does nothing would lose their details a year later having been
// told the opposite.
//
// So the notice now states the real outcome, the real deadline, and the one
// action that prevents it. purgeAfterDays is a PARAMETER rather than a
// constant for the same reason the job reads it from platform_settings: an
// exec who changes inactivity_rules.purge_after_days in the console changes
// the promise and the behaviour together, and the two cannot drift apart.
//
// It also stays honest about what is NOT deleted. Anonymising keeps the match
// history and ratings — pretending otherwise would overstate the erasure and
// mislead somebody who wants their results gone.
export function accountInactiveEmail(
  name: string,
  thresholdDays: number,
  loginUrl: string,
  purgeAfterDays: number,
): { subject: string; html: string } {
  // Months read as a deadline in a way "365 days" does not. Kept alongside the
  // exact figure rather than replacing it, so nothing is rounded away.
  const months = Math.round(purgeAfterDays / 30);
  return {
    subject: subj('Your SFU Badminton membership is now inactive'),
    html: wrap(`
      <h2 style="color: #E94560; margin-bottom: 16px;">Your membership is inactive</h2>
      <p>Hi ${escapeHtml(name)} — we haven't seen you at a club session in about
         ${escapeHtml(thresholdDays)} days, so we've moved your membership off the active roster.</p>
      ${DIVIDER}
      <p><strong>Nothing has been deleted yet.</strong> Your match history, your rating and
         your record are all exactly where you left them.</p>
      <p>Being inactive just means club activity is paused: no challenges, RSVPs,
         check-ins or tournament entries until you're back.</p>
      ${DIVIDER}
      <p><strong>What happens if you stay away.</strong> If your membership is still
         inactive ${escapeHtml(purgeAfterDays)} days from now (about ${escapeHtml(months)} months),
         we remove the personal details from it — your name, email address, phone number,
         profile photo and bio are erased for good, and the account can no longer be
         signed in to. This cannot be undone.</p>
      <p>Your past match results and ratings are kept even then, under an anonymous
         name. They are part of other members' records too, so removing them would
         rewrite matches that were not only yours.</p>
      ${DIVIDER}
      <p><strong>Signing in stops this completely.</strong> One log-in reactivates your
         membership and resets the clock to zero — there is nothing to ask anyone for,
         and nothing further to do afterwards.</p>
      <a href="${escapeHtml(loginUrl)}" style="${BUTTON_STYLES}">Sign in and keep my account</a>
      ${DIVIDER}
      <p style="${MUTED}">Would rather not wait? You can ask us to delete your account and
         its personal details right away — sign in, open Settings, and choose to delete
         your account. We hold it for 30 days after that request in case you change your
         mind, then erase it the same way described above. If you can't sign in, reply to
         this email and an exec will handle the request for you.</p>
    `),
  };
}

export function weeklyDigestEmail(
  name: string,
  data: {
    matchesPlayed: number;
    wins: number;
    losses: number;
    // NULL where a season was activated inside this week, which makes both Elo
    // figures unsafe to state: a rollover on a soft or full policy rewrites
    // every rating without emitting a rating_delta, so the caller's sum would
    // be a week's movement measured across a rebase, and the stored post_rating
    // would be a number the member no longer holds. Counts of matches, wins
    // and losses are untouched by a rebase, so they are still reported.
    eloChange: number | null;
    // NULL where the member did not play that discipline this week. The caller
    // used to report ONE figure as both, so somebody who played only doubles
    // was told their singles rating had moved to a number they never held; and
    // it defaulted to 0, which reads as a wiped rating rather than as no data.
    singlesRating: number | null;
    doublesRating: number | null;
    rank?: number;
  },
  url: string
): { subject: string; html: string } {
  const eloStr =
    data.eloChange === null ? null : data.eloChange >= 0 ? `+${data.eloChange}` : `${data.eloChange}`;
  // Only the disciplines actually played. If neither was rated the line is
  // dropped entirely rather than printed empty — the rest of the recap (matches,
  // record, and net Elo where it is stated) still stands on its own.
  const ratingParts = [
    data.singlesRating !== null ? `Singles: <strong>${data.singlesRating}</strong>` : null,
    data.doublesRating !== null ? `Doubles: <strong>${data.doublesRating}</strong>` : null,
  ].filter(Boolean);
  // WHY THE RATINGS ARE MISSING, BEFORE THE READER NOTICES THEY ARE MISSING.
  // The subject line loses its number on these weeks too, and a recap that
  // quietly drops three figures reads as a broken send unless something in it
  // says otherwise. First line of the block, not appended after the record.
  const rolloverNote =
    eloStr === null
      ? `<p style="margin: 6px 0 12px; color: #9CA3AF;">A new season started this week, so every rating was re-set. Your rating movement across that change would not mean anything, so it is left out of this recap. The matches below are still yours.</p>`
      : '';
  return {
    subject: eloStr === null ? 'Your weekly recap' : `Your weekly recap — ${eloStr} Elo`,
    html: wrap(`
      <h2 style="color: #E94560;">Weekly Recap</h2>
      <p>Hey ${escapeHtml(name)}, here's your week in review:</p>
      ${DIVIDER}
      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px;">
        ${rolloverNote}
        <p style="margin: 6px 0;">Matches Played: <strong>${data.matchesPlayed}</strong></p>
        <p style="margin: 6px 0;">Record: <strong>${data.wins}W - ${data.losses}L</strong></p>
        ${eloStr === null ? '' : `<p style="margin: 6px 0;">Net Elo: <strong style="color: ${(data.eloChange ?? 0) >= 0 ? '#10B981' : '#EF4444'};">${eloStr}</strong></p>`}
        ${ratingParts.length > 0 ? `<p style="margin: 6px 0;">${ratingParts.join(' | ')}</p>` : ''}
        ${data.rank ? `<p style="margin: 6px 0;">Current Rank: <strong>#${data.rank}</strong></p>` : ''}
      </div>
      ${DIVIDER}
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Dashboard</a>
    `),
  };
}

// "Confirm your place" (00325): the event standard asks every entrant, a day or
// two ahead, whether they are still coming. One button, and the way out spelled
// out, because a member who cannot come and says so gives a reserve the place.
export function eventConfirmationEmail(args: {
  firstName: string | null;
  tournamentName: string;
  eventLabel: string;
  deadlineText: string;
  url: string;
}): { subject: string; html: string } {
  return {
    subject: subj(`Confirm your place: ${args.tournamentName}`),
    html: wrap(`
      <h2 style="color: #E94560; margin-bottom: 16px;">Confirm your place</h2>
      <p>Hi ${escapeHtml(args.firstName ?? 'there')},</p>
      <p>You are entered in <strong>${escapeHtml(args.eventLabel)}</strong> at <strong>${escapeHtml(args.tournamentName)}</strong>. Confirm by <strong>${escapeHtml(args.deadlineText)}</strong> that you are coming, or your place goes to the next player on the waitlist.</p>
      <a href="${escapeHtml(args.url)}" style="${BUTTON_STYLES}">Confirm</a>
      <p style="${MUTED} margin-top: 16px;">If you cannot come, withdraw so a reserve gets your place.</p>
    `),
  };
}
