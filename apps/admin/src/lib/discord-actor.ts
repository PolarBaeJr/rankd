import * as Sentry from '@sentry/nextjs';
import { ExpectedError } from '@badminton/shared';
import type { createAdminClient } from './supabase-server';
import { consolePasskeyGrace } from './passkey/grace';

// CONSOLE COMMANDS ON DISCORD: who the command runs as.
//
// /api/discord/actions/[name] runs the console's own server actions, unchanged,
// as the exec whose Discord account is linked. While discordActorStore is set,
// getAuthenticatedConsolePlayer loads that exec's row instead of reading a
// cookie, so every capability gate, standing check, denial message and audit
// actor is the one the console already uses.
//
// The Supabase client is passed in rather than imported: supabase-server.ts
// imports this module for the passkey policy, and a value import back would be
// a cycle.
//
// Node runtime only (node:async_hooks). The middleware must never import this.

export { discordActorStore, type DiscordActor } from './discord-actor-store';

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * The club account linked to this Discord user, 'not_linked' when there is
 * none, or 'unavailable' when the link could not be read.
 *
 * A READ ERROR IS NEVER 'not_linked'. A failed PostgREST read resolves as
 * data:null with an error, and reading that as "no link" would tell an exec who
 * has linked to run /link, which then refuses them as already linked.
 */
export async function resolveDiscordActor(
  discordUserId: string,
  adminClient: AdminClient,
): Promise<{ playerId: string } | 'not_linked' | 'unavailable'> {
  const { data, error } = await adminClient
    .from('player_discord_links')
    .select('player_id, players!inner(id)')
    .eq('discord_user_id', discordUserId)
    .maybeSingle();
  if (error) {
    Sentry.captureException(new Error(`Discord actor link read failed: ${error.message}`));
    return 'unavailable';
  }
  const playerId = (data as { players?: { id?: string } | null } | null)?.players?.id;
  return playerId ? { playerId } : 'not_linked';
}

export const DISCORD_PASSKEY_REQUIRED =
  "Add a console passkey in the console's Settings first. Discord console commands need one on your account.";

/**
 * THE DISCORD PASSKEY POLICY, in one place so the owner can change it.
 *
 * A Discord command has no browser, so the cookie step-up the console asks for
 * cannot happen here. Instead: the actor must have at least one console passkey
 * enrolled, or still be inside the console passkey grace window
 * (consolePasskeyGrace). Anybody else is refused with 'passkey_required'.
 *
 * Differences from the cookie path's assertPasskeyVerified, on purpose:
 *   - an enrolled passkey is enough on its own (there is no cookie to verify);
 *   - a missing grace row means "never opened the console", which is a refusal
 *     here rather than the AUTH-103 anomaly it is for a browser that has.
 * A failed read is still never a pass: it throws AUTH-103.
 */
export async function discordPasskeyPolicy(
  player: { id: string; user_id: string | null },
  adminClient: AdminClient,
): Promise<'allowed' | 'passkey_required'> {
  const { count, error } = await adminClient
    .from('passkey_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('player_id', player.id)
    .eq('enrolled_via', 'admin');
  if (error || count === null || count === undefined) {
    Sentry.captureException(error ?? new Error('passkey count missing'), {
      tags: { gate: 'discordPasskeyPolicy' },
    });
    throw new ExpectedError(
      'Cannot verify your passkey enrolment right now. Please try again shortly.',
      'AUTH-103',
    );
  }
  if (count >= 1) return 'allowed';

  if (!player.user_id) return 'passkey_required';
  const { data: grace, error: graceError } = await adminClient
    .from('console_passkey_grace')
    .select('started_at')
    .eq('user_id', player.user_id)
    .maybeSingle();
  if (graceError) {
    Sentry.captureException(graceError, { tags: { gate: 'discordPasskeyPolicy' } });
    throw new ExpectedError(
      'Cannot verify your passkey enrolment right now. Please try again shortly.',
      'AUTH-103',
    );
  }
  if (!grace) return 'passkey_required';
  const standing = consolePasskeyGrace((grace as { started_at: string }).started_at, Date.now());
  return standing && !standing.expired ? 'allowed' : 'passkey_required';
}
