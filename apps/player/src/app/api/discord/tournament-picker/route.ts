import { NextResponse } from 'next/server';
import { CLUB_TIMEZONE, formatDate, windowState } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { loadEntryWindows, windowsFor, type EntryWindows } from '@/lib/tournament-windows';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import { eventTypeLabel, tournamentsOn } from '@/lib/discord-tournament-text';

export const dynamic = 'force-dynamic';

// The pickers behind /tournaments enter, draw, next and results.
//
//   ?q                         active and recently completed tournaments, by
//                              name (completed so /tournaments results can
//                              reach what the list shows as finished; enter
//                              is still safe, as open=1 lists no event of one)
//   ?tournamentId&q            that tournament's events
//   ?tournamentId&q&open=1     only the events taking entries right now
//
// Runs on every keystroke inside the bot's one-second budget, so it is two
// small reads at most. A draft tournament is not found, as on the website, and
// with tournaments switched off the answer is an empty list. Anything that
// cannot be answered is an empty list too: a picker has nowhere to show an
// error.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHOICES = 25;
const LOOKBACK_DAYS = 60;

type Choice = { id: string; label: string };

function answer(choices: Choice[]) {
  return NextResponse.json({ choices: choices.slice(0, MAX_CHOICES) });
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const params = new URL(request.url).searchParams;
  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);
  const tournamentId = params.get('tournamentId');
  const supabase = createServiceRoleClient();
  if (!(await tournamentsOn(supabase))) return answer([]);

  if (tournamentId === null) {
    const floor = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toLocaleDateString('en-CA', {
      timeZone: CLUB_TIMEZONE,
    });
    const { data, error } = await supabase
      .from('tournaments')
      .select('id, name, start_date')
      .in('status', ['active', 'completed'])
      .gte('start_date', floor)
      .order('start_date', { ascending: true })
      .limit(60);
    if (error) {
      console.error('[discord] tournament picker read failed:', error.message);
      return answer([]);
    }
    return answer(
      ((data ?? []) as { id: string; name: string; start_date: string }[])
        .filter((t) => !q || t.name.toLowerCase().includes(q))
        .map((t) => ({ id: t.id, label: `${t.name} · ${formatDate(t.start_date)}`.slice(0, 100) })),
    );
  }

  if (!UUID.test(tournamentId)) return answer([]);
  const [tournamentRes, eventsRes] = await Promise.all([
    supabase.from('tournaments').select('id, status').eq('id', tournamentId).maybeSingle(),
    supabase.from('tournament_events').select('id, event_type, status').eq('tournament_id', tournamentId),
  ]);
  if (tournamentRes.error || eventsRes.error) {
    console.error('[discord] tournament event picker read failed');
    return answer([]);
  }
  if (!tournamentRes.data || tournamentRes.data.status === 'draft') return answer([]);

  let events = (eventsRes.data ?? []) as { id: string; event_type: string; status: string }[];
  if (params.get('open') === '1') {
    // Open as the list route decides it: status registration and inside the
    // registration window (00276), read on its own so a database without the
    // windows is no window.
    let windows: EntryWindows;
    try {
      windows = await loadEntryWindows(supabase, {
        eventIds: events.map((e) => e.id),
        tournamentIds: [tournamentId],
      });
    } catch (err) {
      console.error('[discord] tournament event picker window read failed', err);
      return answer([]);
    }
    const now = new Date();
    events = events.filter((e) => {
      if (e.status !== 'registration') return false;
      const { registration } = windowsFor(windows, e.id, tournamentId);
      return windowState(registration.opens_at, registration.closes_at, now) === 'open';
    });
  }

  return answer(
    events
      .map((e) => ({ id: e.id, label: eventTypeLabel(e.event_type).slice(0, 100) }))
      .filter((e) => !q || e.label.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );
}
