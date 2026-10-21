import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import {
  clubEventWallClock,
  clubToday,
  featureAccessFor,
  featureGate,
  formatTime,
  getAccountStanding,
  readFeatureFlags,
  wallClockToUtc,
  type FeatureId,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { onVisibleTracks } from '@/lib/session-track-filter';
import { addDaysISO, dayHeading } from '@/lib/schedule';
import { getOrCreateCalendarFeedToken } from '@/lib/calendar-feed-token';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /schedule on Discord: the CALLER's next two weeks, the same rows the website
// would show them, formatted here so the bot only prints lines.
//
// The caller arrives as `x-discord-user-id` on a request already gated by the
// service secret, a header rather than a query param so the id stays out of
// access logs (see ../sessions/route.ts).
//
// Sessions go through onVisibleTracks with the member's own status, exactly as
// /feed does. Club events are published ones only: a cancelled one is news the
// feed carries, not a plan. Tournaments are the published, unsuspended ones
// that overlap the window. Each read is skipped while its feature is switched
// off for this member, and a refused read is a 503 rather than a short
// schedule, because "nothing on" over a broken read is a confident lie.
//
// The feed link is minted only for a member in good standing: the ICS route
// refuses everyone else's token anyway, and handing out a link that answers 403
// is worse than leaving it out.

const WINDOW_DAYS = 14;

interface ScheduleLine {
  date: string;
  sortKey: string;
  text: string;
}

function playerBaseUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_PLAYER_URL || process.env.NEXT_PUBLIC_APP_URL;
  return base ? base.replace(/\/+$/, '') : null;
}

function clubMidnightIso(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number) as [number, number, number];
  return wallClockToUtc(y, m, d, 0, 0).toISOString();
}

function joinParts(parts: (string | null | undefined)[]): string {
  return parts.filter((part) => part && part.trim()).join(' · ');
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const discordUserId = request.headers.get('x-discord-user-id');
  if (!discordUserId || !/^\d{5,25}$/.test(discordUserId)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // A read error is never "not linked": that answer tells a linked member to
  // run /link, which then refuses them as already linked.
  const { data: link, error: linkError } = await supabase
    .from('player_discord_links')
    .select('players!inner(*)')
    .eq('discord_user_id', discordUserId)
    .maybeSingle();
  if (linkError) {
    Sentry.captureException(linkError, { extra: { route: 'discord/schedule', step: 'link-lookup' } });
    return NextResponse.json({ error: 'schedule_unavailable' }, { status: 503 });
  }
  if (!link) return NextResponse.json({ linked: false });
  // Not generic over Database, so the embedded row is any.
  const player = (link as unknown as { players: Record<string, unknown> & { id: string; status: string | null } })
    .players;

  const features = await readFeatureFlags(supabase);
  const access = featureAccessFor(player as never);
  const on = (id: FeatureId) => featureGate(features[id], access.includes(id)) !== 'redirect';

  const today = clubToday();
  const lastDay = addDaysISO(today, WINDOW_DAYS - 1);
  const skipped = Promise.resolve({ data: [] as never[], error: null });

  const [sessionsRes, clubEventsRes, tournamentsRes] = await Promise.all([
    on('sessions')
      ? onVisibleTracks(
          supabase
            .from('sessions')
            .select('id, name, date, start_time, location')
            .eq('status', 'open')
            .gte('date', today)
            .lte('date', lastDay),
          player.status,
        )
          .order('date', { ascending: true })
          .order('start_time', { ascending: true, nullsFirst: false })
          .limit(100)
      : skipped,
    on('events')
      ? supabase
          .from('club_events')
          .select('id, title, location, starts_at')
          .eq('status', 'published')
          .gte('starts_at', clubMidnightIso(today))
          .lt('starts_at', clubMidnightIso(addDaysISO(lastDay, 1)))
          .order('starts_at', { ascending: true })
          .limit(100)
      : skipped,
    on('tournaments')
      ? supabase
          .from('tournaments')
          .select('id, name, start_date, end_date')
          .in('status', ['active', 'completed'])
          .is('suspended_at', null)
          .lte('start_date', lastDay)
          .or(`start_date.gte.${today},end_date.gte.${today}`)
          .order('start_date', { ascending: true })
          .limit(50)
      : skipped,
  ]);

  for (const [step, res] of [
    ['sessions', sessionsRes],
    ['club_events', clubEventsRes],
    ['tournaments', tournamentsRes],
  ] as const) {
    if (res.error) {
      Sentry.captureException(new Error(res.error.message), { extra: { route: 'discord/schedule', step } });
      return NextResponse.json({ error: 'schedule_unavailable' }, { status: 503 });
    }
  }

  const lines: ScheduleLine[] = [];
  for (const s of (sessionsRes.data ?? []) as {
    id: string;
    name: string | null;
    date: string;
    start_time: string | null;
    location: string | null;
  }[]) {
    const time = s.start_time ? s.start_time.slice(0, 5) : null;
    lines.push({
      date: s.date,
      sortKey: `1${time ?? '99:99'}`,
      text: joinParts([time ? formatTime(time) : null, s.name ?? 'Practice Session', s.location]),
    });
  }
  for (const e of (clubEventsRes.data ?? []) as {
    title: string;
    location: string | null;
    starts_at: string;
  }[]) {
    const { date, time } = clubEventWallClock(e.starts_at);
    lines.push({ date, sortKey: `1${time}`, text: joinParts([formatTime(time), e.title, e.location]) });
  }
  for (const t of (tournamentsRes.data ?? []) as {
    name: string;
    start_date: string;
    end_date: string | null;
  }[]) {
    // One line per day it runs inside the window, as on the month grid.
    const end = t.end_date && t.end_date > t.start_date ? t.end_date : t.start_date;
    const first = t.start_date > today ? t.start_date : today;
    for (let date = first; date <= end && date <= lastDay; date = addDaysISO(date, 1)) {
      lines.push({ date, sortKey: '0', text: joinParts(['All day', `${t.name} (tournament)`]) });
    }
  }

  lines.sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
  );
  const days: { label: string; items: string[] }[] = [];
  let currentDate: string | null = null;
  for (const line of lines) {
    if (line.date !== currentDate) {
      const heading = dayHeading(line.date, today);
      days.push({ label: `${heading.label}, ${heading.dateLabel}`, items: [] });
      currentDate = line.date;
    }
    days[days.length - 1]!.items.push(line.text);
  }

  const base = playerBaseUrl();
  let feed: { https: string; webcal: string } | null = null;
  if (base && getAccountStanding(player as never).ok) {
    try {
      const token = await getOrCreateCalendarFeedToken(supabase, player.id);
      const https = `${base}/api/calendar/${token}`;
      feed = { https, webcal: https.replace(/^https?:\/\//, 'webcal://') };
    } catch {
      // Already reported by the helper. The schedule is still worth sending.
      feed = null;
    }
  }

  return NextResponse.json(
    { linked: true, days, feed, calendarUrl: base ? `${base}/calendar` : null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
