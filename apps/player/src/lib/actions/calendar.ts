'use server';

import { randomBytes } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from '../supabase-server';
import { requirePlayer, runAction, type ActionResult } from './_shared';
import { getOrCreateCalendarFeedToken } from '../calendar-feed-token';

// 24 random bytes -> 48 hex chars; the feed route validates this exact shape.
function newFeedToken(): string {
  return randomBytes(24).toString('hex');
}

// Returns the player's calendar feed token, creating one on first use.
// calendar_feed_tokens has no write policies (owner SELECT only), so writes
// go through the service-role client.
export async function getCalendarFeedToken(): Promise<ActionResult<string>> {
  return runAction(() => getCalendarFeedTokenImpl());
}

async function getCalendarFeedTokenImpl(): Promise<string> {
  const player = await requirePlayer();
  return getOrCreateCalendarFeedToken(createServiceRoleClient(), player.id);
}

// Replaces the token with a fresh one (creating the row if it doesn't exist
// yet), immediately revoking every previously shared feed URL.
export async function regenerateCalendarFeedToken(): Promise<ActionResult<string>> {
  return runAction(() => regenerateCalendarFeedTokenImpl());
}

async function regenerateCalendarFeedTokenImpl(): Promise<string> {
  const player = await requirePlayer();
  const serviceClient = createServiceRoleClient();

  const token = newFeedToken();
  const { error } = await serviceClient
    .from('calendar_feed_tokens')
    .upsert({ player_id: player.id, token });
  if (error) {
    Sentry.captureException(error, { extra: { action: 'regenerateCalendarFeedToken', playerId: player.id } });
    throw new Error('Could not reset calendar feed link');
  }
  return token;
}
