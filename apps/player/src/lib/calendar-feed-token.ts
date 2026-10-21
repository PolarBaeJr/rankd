import { randomBytes } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

// The member's calendar feed token, created on first use. Shared by the
// getCalendarFeedToken action (which authenticates the member first) and the
// Discord /schedule route (which authenticates the bot and resolves the link).
//
// calendar_feed_tokens has no write policies (owner SELECT only), so the client
// handed in must be the service role.

// 24 random bytes -> 48 hex chars; the feed route validates this exact shape.
function newFeedToken(): string {
  return randomBytes(24).toString('hex');
}

export async function getOrCreateCalendarFeedToken(
  serviceClient: Pick<SupabaseClient, 'from'>,
  playerId: string,
): Promise<string> {
  const { data: existing } = await serviceClient
    .from('calendar_feed_tokens')
    .select('token')
    .eq('player_id', playerId)
    .maybeSingle();
  if (existing) return existing.token as string;

  const token = newFeedToken();
  const { error } = await serviceClient
    .from('calendar_feed_tokens')
    .insert({ player_id: playerId, token });
  if (error) {
    // Unique-violation race: a concurrent request created the row first.
    // Return its token instead of failing.
    const { data: raced } = await serviceClient
      .from('calendar_feed_tokens')
      .select('token')
      .eq('player_id', playerId)
      .maybeSingle();
    if (raced) return raced.token as string;
    Sentry.captureException(error, { extra: { action: 'getCalendarFeedToken', playerId } });
    throw new Error('Could not create calendar feed link');
  }
  return token;
}
