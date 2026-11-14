import type { createAdminClient } from '../supabase-server';

type AdminClient = ReturnType<typeof createAdminClient>;

// NAMES THAT LEAVE THE CLUB: the results announcement (00170 posts it to
// Discord) and the Instagram slides. The owner's rule, 2026-11-14: full names,
// except a member hidden from the leaderboard, one asking to be deleted, or a
// guest, who is drawn as "A member". 00265's data_api_published_player draws
// the same line for the data API. An external team's names are shown as
// entered.

export const HIDDEN_MEMBER = 'A member';

export interface PublicPerson {
  full_name?: string | null;
  handle?: string | null;
  hide_from_leaderboard?: boolean | null;
  deletion_requested_at?: string | null;
  is_guest?: boolean | null;
}

export const PUBLIC_PERSON_COLUMNS = 'full_name, handle, hide_from_leaderboard, deletion_requested_at, is_guest';

export function publicPersonName(person: PublicPerson | null | undefined): string {
  if (!person) return HIDDEN_MEMBER;
  if (person.hide_from_leaderboard || person.deletion_requested_at || person.is_guest) return HIDDEN_MEMBER;
  return person.full_name?.trim() || person.handle?.trim() || HIDDEN_MEMBER;
}

export function publicExternalName(name: string | null | undefined): string {
  return name?.trim() || HIDDEN_MEMBER;
}

const one = <T>(value: T | T[] | null | undefined): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

export interface PublicPairRow {
  player1?: PublicPerson | PublicPerson[] | null;
  player2?: PublicPerson | PublicPerson[] | null;
  player1_id?: string | null;
  player2_id?: string | null;
  external1_name?: string | null;
  external2_name?: string | null;
}

export function publicPairName(pair: PublicPairRow): string {
  const first = pair.player1_id ? publicPersonName(one(pair.player1)) : publicExternalName(pair.external1_name);
  const second = pair.player2_id ? publicPersonName(one(pair.player2)) : publicExternalName(pair.external2_name);
  return `${first} & ${second}`;
}

/**
 * The public name of every entry in one event, keyed by pair or participant
 * id. Throws on a failed read: a slide or a post full of "A member" would look
 * finished and be wrong.
 */
export async function loadPublicEntryNames(
  adminClient: AdminClient,
  eventId: string,
  doubles: boolean,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (doubles) {
    const { data, error } = await adminClient
      .from('tournament_pairs')
      .select(
        `id, player1_id, player2_id, external1_name, external2_name, player1:players!tournament_pairs_player1_id_fkey(${PUBLIC_PERSON_COLUMNS}), player2:players!tournament_pairs_player2_id_fkey(${PUBLIC_PERSON_COLUMNS})`,
      )
      .eq('event_id', eventId);
    if (error) throw new Error(`The team names could not be read: ${error.message}`);
    for (const row of (data ?? []) as unknown as Array<PublicPairRow & { id: string }>) {
      names.set(row.id, publicPairName(row));
    }
    return names;
  }
  const { data, error } = await adminClient
    .from('tournament_participants')
    .select(`id, player:players!player_id(${PUBLIC_PERSON_COLUMNS})`)
    .eq('event_id', eventId);
  if (error) throw new Error(`The entrant names could not be read: ${error.message}`);
  for (const row of (data ?? []) as unknown as Array<{ id: string; player: PublicPerson | PublicPerson[] | null }>) {
    names.set(row.id, publicPersonName(one(row.player)));
  }
  return names;
}
