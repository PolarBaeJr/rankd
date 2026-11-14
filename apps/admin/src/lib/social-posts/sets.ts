import {
  isDoublesEvent,
  TOURNAMENT_EVENT_TYPE_LABELS,
  type TournamentEventType,
} from '@badminton/shared';
import type { createAdminClient } from '../supabase-server';
import { formatEventDate, type SocialSetKind } from './caption';
import { paginate, type SlideBlock } from './layout';
import { loadPublicEntryNames } from './names';

type AdminClient = ReturnType<typeof createAdminClient>;

// A SET AS SLIDES. The set holds ids; the names are read now, so a renamed,
// hidden or merged member draws as they are today, and an entry that has
// since been removed simply drops out of the slide.

export interface DrawGroup {
  title: string;
  entry_ids: string[];
  /** Bracket: the ids are in match order, two to a line. */
  versus?: boolean;
}

export interface SocialSetRow {
  id: string;
  event_id: string;
  kind: SocialSetKind;
  entry_ids: string[];
  groups: unknown;
  caption: string;
  superseded_at: string | null;
  notified_at: string | null;
  created_at: string;
}

export interface SocialEvent {
  id: string;
  tournament_id: string;
  event_type: string;
  name: string;
  detail: string | null;
  doubles: boolean;
  date: string | null;
  time: string | null;
  venue: string | null;
}

export const SET_COLUMNS = 'id, event_id, kind, entry_ids, groups, caption, superseded_at, notified_at, created_at';

export const EYEBROW: Record<SocialSetKind, string> = {
  teams_full: 'MEET THE TEAMS',
  teams_new: 'NEW TEAMS',
  draw: 'THE DRAW',
};

export function socialEventName(tournamentName: string | null | undefined, eventType: string): string {
  const label = TOURNAMENT_EVENT_TYPE_LABELS[eventType as TournamentEventType] ?? eventType;
  return tournamentName ? `${tournamentName} ${label}` : label;
}

export async function loadSocialEvent(adminClient: AdminClient, eventId: string): Promise<SocialEvent | null> {
  const { data, error } = await adminClient
    .from('tournament_events')
    .select('id, tournament_id, event_type, tournament:tournaments(name, start_date, starts_time, location)')
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw new Error(`The event could not be read: ${error.message}`);
  if (!data) return null;
  const tournament = (Array.isArray(data.tournament) ? data.tournament[0] : data.tournament) as
    | { name?: string | null; start_date?: string | null; starts_time?: string | null; location?: string | null }
    | null;
  const date = tournament?.start_date ?? null;
  const time = tournament?.starts_time ?? null;
  const venue = tournament?.location?.trim() || null;
  const when = formatEventDate(date, time);
  return {
    id: data.id,
    tournament_id: data.tournament_id,
    event_type: data.event_type,
    name: socialEventName(tournament?.name, data.event_type),
    detail: [when, venue].filter(Boolean).join(', ') || null,
    doubles: isDoublesEvent(data.event_type),
    date,
    time,
    venue,
  };
}

export function parseDrawGroups(value: unknown): DrawGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): DrawGroup[] => {
    if (!item || typeof item !== 'object') return [];
    const group = item as Record<string, unknown>;
    if (typeof group.title !== 'string' || !Array.isArray(group.entry_ids)) return [];
    return [{
      title: group.title,
      entry_ids: group.entry_ids.filter((id): id is string => typeof id === 'string'),
      versus: group.versus === true,
    }];
  });
}

export const BYE = 'Bye';

export function blocksForSet(set: Pick<SocialSetRow, 'kind' | 'entry_ids' | 'groups'>, names: ReadonlyMap<string, string>): SlideBlock[] {
  if (set.kind !== 'draw') {
    const lines = set.entry_ids.flatMap((id) => (names.has(id) ? [names.get(id)!] : []));
    return [{ title: null, lines }];
  }
  return parseDrawGroups(set.groups).map((group) => {
    if (!group.versus) {
      return { title: group.title, lines: group.entry_ids.flatMap((id) => (names.has(id) ? [names.get(id)!] : [])) };
    }
    const lines: string[] = [];
    for (let index = 0; index < group.entry_ids.length; index += 2) {
      const a = group.entry_ids[index];
      const b = group.entry_ids[index + 1];
      lines.push(`${(a && names.get(a)) || BYE} v ${(b && names.get(b)) || BYE}`);
    }
    return { title: group.title, lines };
  });
}

export interface RenderedSet {
  set: SocialSetRow;
  event: SocialEvent;
  pages: SlideBlock[][];
}

export async function loadRenderedSet(adminClient: AdminClient, setId: string): Promise<RenderedSet | null> {
  const { data: set, error } = await adminClient
    .from('event_social_post_sets')
    .select(SET_COLUMNS)
    .eq('id', setId)
    .maybeSingle();
  if (error) throw new Error(`The set could not be read: ${error.message}`);
  if (!set) return null;
  const event = await loadSocialEvent(adminClient, set.event_id);
  if (!event) return null;
  const names = await loadPublicEntryNames(adminClient, event.id, event.doubles);
  const row = set as unknown as SocialSetRow;
  return { set: row, event, pages: paginate(blocksForSet(row, names)) };
}

export async function loadRenderedSetsForEvent(adminClient: AdminClient, event: SocialEvent): Promise<RenderedSet[]> {
  const { data, error } = await adminClient
    .from('event_social_post_sets')
    .select(SET_COLUMNS)
    .eq('event_id', event.id)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`The social post sets could not be read: ${error.message}`);
  const sets = (data ?? []) as unknown as SocialSetRow[];
  if (sets.length === 0) return [];
  const names = await loadPublicEntryNames(adminClient, event.id, event.doubles);
  return sets.map((set) => ({ set, event, pages: paginate(blocksForSet(set, names)) }));
}
