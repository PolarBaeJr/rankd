import type { createAdminClient } from '../supabase-server';

type AdminClient = ReturnType<typeof createAdminClient>;

// THE CAPTION a Marketing holder copies under a set of slides. Plain text, no
// em dash, the club's hashtags last. The date and the place come from the
// tournament (00304), so a caption written days before still reads right.

export const SOCIAL_HASHTAGS_SETTING_KEY = 'social_hashtags';

export type SocialSetKind = 'teams_full' | 'teams_new' | 'draw';

export interface CaptionInput {
  kind: SocialSetKind;
  eventName: string;
  /** `tournaments.start_date`, YYYY-MM-DD. */
  date?: string | null;
  /** `tournaments.starts_time`, HH:MM or HH:MM:SS. */
  time?: string | null;
  venue?: string | null;
  hashtags?: string | null;
  /** For a draw: groups ("The pools are drawn") or a bracket. */
  drawShape?: 'groups' | 'bracket';
}

export function formatEventDate(date: string | null | undefined, time?: string | null): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // Noon UTC, so no time zone can move the calendar day.
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const match = time ? /^(\d{2}):(\d{2})/.exec(time) : null;
  if (!match) return day;
  const hours = Number(match[1]);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const clock = `${hours % 12 === 0 ? 12 : hours % 12}:${match[2]} ${suffix}`;
  return `${day} at ${clock}`;
}

export function normaliseHashtags(raw: string | null | undefined): string {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((tag) => tag.trim().replace(/^#*/, ''))
    .filter((tag) => /^[\p{L}\p{N}_]+$/u.test(tag))
    .map((tag) => `#${tag}`)
    .join(' ');
}

export function buildCaption(input: CaptionInput): string {
  const when = formatEventDate(input.date, input.time);
  const where = input.venue?.trim() || null;
  const detail = [when, where].filter(Boolean).join(', ');
  const lines: string[] = [];
  switch (input.kind) {
    case 'teams_full':
      lines.push(`Meet the teams for ${input.eventName}!`);
      break;
    case 'teams_new':
      lines.push(`More teams joining ${input.eventName}.`);
      break;
    case 'draw':
      lines.push(input.drawShape === 'bracket' ? `The draw is out for ${input.eventName}.` : `The pools are drawn for ${input.eventName}.`);
      break;
  }
  if (detail) lines.push(detail);
  const tags = normaliseHashtags(input.hashtags);
  if (tags) lines.push('', tags);
  return lines.join('\n').replace(/\u2014/g, '-');
}

export async function readSocialHashtags(adminClient: AdminClient): Promise<string> {
  const { data } = await adminClient
    .from('platform_settings')
    .select('value')
    .eq('key', SOCIAL_HASHTAGS_SETTING_KEY)
    .maybeSingle();
  const value = (data?.value ?? null) as { hashtags?: unknown } | null;
  return typeof value?.hashtags === 'string' ? value.hashtags : '';
}
