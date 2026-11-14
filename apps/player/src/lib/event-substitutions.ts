import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from './supabase-server';

// SUBSTITUTIONS (00327), the member's side: "subbed in for" a named member on the
// incoming member's matches, and "you were subbed out" for the one who left,
// whose entry no longer has them in it. The table is service-role only, so the
// read is filtered by the caller's own player id. Never throws: a missing
// migration is "no substitutions", anything else goes to Sentry and is the same.

export interface MySubstitutions {
  /** The names of who this member came in for. */
  inFor: string[];
  /** The names of who came in for this member. */
  outFor: string[];
}

type Name = { full_name: string | null } | Array<{ full_name: string | null }> | null;
const nameOf = (embed: Name) => (Array.isArray(embed) ? embed[0]?.full_name : embed?.full_name) ?? 'a former member';

export async function loadMySubstitutions(playerId: string, eventId: string): Promise<MySubstitutions> {
  const none: MySubstitutions = { inFor: [], outFor: [] };
  try {
    const { data, error } = await createServiceRoleClient()
      .from('event_substitutions')
      .select(
        'outgoing_player_id, incoming_player_id, outgoing:players!event_substitutions_outgoing_player_id_fkey(full_name), incoming:players!event_substitutions_incoming_player_id_fkey(full_name)',
      )
      .eq('event_id', eventId)
      .or(`outgoing_player_id.eq.${playerId},incoming_player_id.eq.${playerId}`)
      .order('made_at');
    if (error) {
      if (['42P01', '42703', 'PGRST205'].includes(error.code ?? '')) return none;
      Sentry.captureException(new Error(`Could not read substitutions: ${error.message}`));
      return none;
    }
    const rows = (data ?? []) as unknown as Array<{ outgoing_player_id: string | null; incoming_player_id: string | null; outgoing: Name; incoming: Name }>;
    return {
      inFor: rows.filter((r) => r.incoming_player_id === playerId).map((r) => nameOf(r.outgoing)),
      outFor: rows.filter((r) => r.outgoing_player_id === playerId).map((r) => nameOf(r.incoming)),
    };
  } catch (err) {
    Sentry.captureException(err);
    return none;
  }
}
