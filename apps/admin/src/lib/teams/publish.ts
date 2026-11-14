import * as Sentry from '@sentry/nextjs';
import type { createAdminClient } from '../supabase-server';
import { notifyPlayers } from '../notify';
import { eventUrl } from '../event-confirmations';
import { queueTeamSocialPosts } from '../social-posts/queue';

export { relinkConfirmations } from './relink';

type AdminClient = ReturnType<typeof createAdminClient>;

// WHAT FOLLOWS A TEAM CHANGE (generate_teams, 00334), after the pairing itself
// has committed through the existing entry path: the confirmation rows follow
// the entry, both members are told, and the Marketing sets are refreshed. None
// of these may undo the change, so each failure is reported and swallowed.
//
// NOT 'use server': every export of such a module is a public action.

export const EDIT_AFTER_DRAW_REFUSAL =
  'The draw exists, so a team cannot be edited here. Use Substitute on the event to swap a player in.';

export type TeamNoticeKind = 'paired' | 'partner_changed' | 'unpaired';

export interface TeamNotice {
  playerId: string;
  kind: TeamNoticeKind;
  /** The partner's name, for paired and partner_changed. */
  partnerName?: string;
}

export function teamNoticeText(kind: TeamNoticeKind, eventName: string, partnerName = 'a partner'): { title: string; body: string } {
  if (kind === 'paired') return { title: 'Your team', body: `You are paired with ${partnerName} for ${eventName}.` };
  if (kind === 'partner_changed') return { title: 'Your team changed', body: `Your partner for ${eventName} is now ${partnerName}.` };
  return { title: 'Your team changed', body: `You are no longer in a team for ${eventName}. The organizers will pair you again.` };
}

/** One in-app notice and push per member; guests are skipped by the notifications trigger. */
export async function sendTeamNotices(
  adminClient: AdminClient,
  event: { id: string; tournamentId: string; name: string },
  notices: readonly TeamNotice[],
): Promise<number> {
  let sent = 0;
  for (const notice of notices) {
    const text = teamNoticeText(notice.kind, event.name, notice.partnerName);
    try {
      const { delivered } = await notifyPlayers(
        adminClient,
        [notice.playerId],
        {
          type: 'general',
          title: text.title,
          body: text.body,
          metadata: { kind: 'teams_published', event_id: event.id, tournament_id: event.tournamentId },
        },
        { title: text.title, body: text.body, url: eventUrl(event.tournamentId, event.id) },
        'tournaments',
      );
      sent += delivered.length;
    } catch (err) {
      Sentry.captureException(err, { tags: { action: 'sendTeamNotices' } });
    }
  }
  return sent;
}

export async function refreshTeamSocialPosts(adminClient: AdminClient, eventId: string, newPairIds: readonly string[]): Promise<void> {
  try {
    await queueTeamSocialPosts(adminClient, eventId, newPairIds);
  } catch (err) {
    Sentry.captureException(err, { tags: { action: 'queueTeamSocialPosts' } });
  }
}
