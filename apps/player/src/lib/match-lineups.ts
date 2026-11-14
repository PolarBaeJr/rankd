import * as Sentry from '@sentry/nextjs';
import { parseLineup, type MatchLineup } from '@badminton/shared';
import type { createServerSupabaseClient } from './supabase-server';

// WHO PLAYED A DECIDED MATCH, after a substitution (00327
// tournament_matches.lineup), for the member's own matches and record on the
// event page. On its own read rather than in the page's match select, which
// goes through `unwrap`: a database without the column would 500 the page.
// Never throws: a failed read is "no lineups", so the page reads by entry as
// it did before 00327, and the failure goes to Sentry.

type Client = Awaited<ReturnType<typeof createServerSupabaseClient>>;

/** The event's lineups, by match id. Only decided matches of a subbed entry have one. */
export async function loadEventLineups(supabase: Client, eventId: string): Promise<Map<string, MatchLineup>> {
  const lineups = new Map<string, MatchLineup>();
  try {
    const { data, error } = await supabase
      .from('tournament_matches')
      .select('id, lineup')
      .eq('event_id', eventId)
      .not('lineup', 'is', null);
    if (error) {
      if (error.code !== '42703') Sentry.captureException(new Error(`Could not read the match lineups: ${error.message}`));
      return lineups;
    }
    for (const row of (data ?? []) as Array<{ id: string; lineup: unknown }>) {
      const lineup = parseLineup(row.lineup);
      if (lineup) lineups.set(row.id, lineup);
    }
  } catch (err) {
    Sentry.captureException(err);
  }
  return lineups;
}

/** Names for the people a lineup names, who may no longer be on any entry. */
export async function loadLineupNames(supabase: Client, playerIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (playerIds.length === 0) return names;
  try {
    const { data, error } = await supabase.from('players').select('id, full_name').in('id', playerIds);
    if (error) {
      Sentry.captureException(new Error(`Could not read the lineup names: ${error.message}`));
      return names;
    }
    for (const row of (data ?? []) as Array<{ id: string; full_name: string | null }>) {
      if (row.full_name) names.set(row.id, row.full_name);
    }
  } catch (err) {
    Sentry.captureException(err);
  }
  return names;
}
