import { NextResponse } from 'next/server';
import {
  CLUB_EVENT_KIND_LABELS,
  formatClubEventCost,
  isUuid,
  readFeatureFlags,
  type ClubEventKind,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { clubEventFormLinks } from '@/lib/event-form-link';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Which club events (00244) owe Discord a scheduled event, and what to do
// about each. The mirror of ../tournament-events/route.ts, and the same split:
// the app decides, the bot calls Discord and then records here.
//
// CREATING AND KEEPING ARE DIFFERENT RULES. A club event is created in Discord
// only while it is published and still in the future, but it KEEPS its Discord
// event until it ends. Copying the tournament rule with "starts in the future"
// would delete every Discord event the moment it started.
//
// An event with no end time is treated as two hours long. Discord requires an
// end for an EXTERNAL event, and completes the event itself when it is reached.

interface ClubEventRow {
  id: string;
  title: string;
  kind: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  status: string;
  cost_cents: number | null;
}

interface MappingRow {
  club_event_id: string;
  discord_event_id: string;
  synced_name: string;
  synced_starts_at: string;
  synced_ends_at: string;
  synced_location: string | null;
  synced_description: string;
}

interface Action {
  kind: 'create' | 'update' | 'cancel';
  eventId: string;
  discordEventId: string | null;
  name: string;
  /** What to send Discord. May be clamped forward past a start already gone. */
  startsAt: string;
  endsAt: string;
  /** What the event actually says. Recorded, so the diff stays stable. */
  syncedStartsAt: string;
  syncedEndsAt: string;
  /** False once Discord has started the event and will no longer retime it. */
  patchTimes: boolean;
  location: string | null;
  description: string;
}

// See the tournament route: a safety bound for the orphan sweep and for the
// URL length of the by-id read, not a performance one.
const MAX_MAPPED = 150;
const CLAMP_SLACK_MS = 2 * 60_000;
const DEFAULT_DURATION_MS = 2 * 60 * 60_000;

// Discord's limits, all below what club_events allows (title 120, location
// 200, description 4000). An oversize value is refused on every tick and never
// recorded, so everything is cut to fit here rather than sent hopefully.
const MAX_NAME = 100;
const MAX_LOCATION = 100;
const MAX_DESCRIPTION = 1000;

const COLUMNS = 'id, title, kind, description, location, starts_at, ends_at, status, cost_cents';

/**
 * Cut to at most `max` UTF-16 units without splitting a character. Discord
 * counts length the same way, and the result has to be deterministic, because
 * it is compared against what was recorded last time.
 */
function fit(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

function describeClubEvent(e: ClubEventRow, appUrl: string | null, formUrl: string | null): string {
  const cost = formatClubEventCost(e.cost_cents);
  const kind = CLUB_EVENT_KIND_LABELS[e.kind as ClubEventKind] ?? e.kind;
  const header = cost ? `${kind}, ${cost}` : kind;
  // The links are what make the Discord event useful, so they are reserved for
  // first and the body is what gets cut. The page link only says "details":
  // most people reading Discord are not signed in, and the page cannot sign
  // them up. The event's Google Form can, member or not.
  const link = appUrl ? `Event details: ${appUrl}/events/${e.id}` : null;
  const form = formUrl ? `Sign up with the Google Form: ${formUrl}` : null;

  const fixed = [header, link, form].filter((p): p is string => p !== null);
  const reserved = fixed.reduce((n, p) => n + p.length, 0) + fixed.length * 2;
  const body = fit(e.description?.trim() ?? '', Math.max(0, MAX_DESCRIPTION - reserved)).trim();

  const parts = [header, body, link, form].filter((p): p is string => !!p);
  return fit(parts.join('\n\n'), MAX_DESCRIPTION);
}

function effectiveEnd(e: ClubEventRow): number {
  return e.ends_at ? Date.parse(e.ends_at) : Date.parse(e.starts_at) + DEFAULT_DURATION_MS;
}

function cancelFrom(eventId: string, existing: MappingRow): Action {
  return {
    kind: 'cancel',
    eventId,
    discordEventId: existing.discord_event_id,
    name: existing.synced_name,
    startsAt: existing.synced_starts_at,
    endsAt: existing.synced_ends_at,
    syncedStartsAt: existing.synced_starts_at,
    syncedEndsAt: existing.synced_ends_at,
    patchTimes: false,
    location: existing.synced_location,
    description: '',
  };
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const guildId = new URL(request.url).searchParams.get('guildId');
  if (!guildId) return NextResponse.json({ error: 'guild_id_required' }, { status: 400 });

  const supabase = createServiceRoleClient();
  const now = Date.now();

  // CLUB EVENTS SWITCHED OFF: nothing to do. Ones already posted are left
  // standing rather than cancelled, the same as tournaments, so a switch
  // flipped by mistake does not tear down the Events tab.
  if (!(await readFeatureFlags(supabase)).events) {
    return NextResponse.json({
      actions: [],
      skipped: [{ eventId: '*', reason: 'events_disabled' }],
    });
  }

  const mappedResult = await supabase
    .from('discord_club_events')
    .select(
      'club_event_id, discord_event_id, synced_name, synced_starts_at, synced_ends_at, synced_location, synced_description'
    )
    .eq('guild_id', guildId)
    .order('updated_at', { ascending: false })
    .limit(MAX_MAPPED);

  // Never degraded to an empty list: "nothing mapped" would make the bot
  // create a second Discord event for every club event that already has one.
  if (mappedResult.error) {
    const detail = mappedResult.error.message ?? 'unknown';
    console.error('[discord] club-events mapping read failed:', detail);
    return NextResponse.json({ error: 'config_unavailable', detail }, { status: 503 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? null;
  const mapped = new Map(
    ((mappedResult.data ?? []) as MappingRow[]).map((m) => [m.club_event_id, m])
  );

  // TWO READS, MERGED, for the tournament route's reason: the announceable set
  // is "published and in the future", the cancellable set is "already has a
  // Discord event", and an event just cancelled is only in the second.
  const [upcomingResult, knownResult] = await Promise.all([
    supabase
      .from('club_events')
      .select(COLUMNS)
      .eq('status', 'published')
      .gt('starts_at', new Date(now).toISOString()),
    mapped.size > 0
      ? supabase
          .from('club_events')
          .select(COLUMNS)
          .in('id', [...mapped.keys()])
      : Promise.resolve({ data: [] as unknown, error: null }),
  ]);

  if (upcomingResult.error || knownResult.error) {
    const detail = upcomingResult.error?.message ?? knownResult.error?.message ?? 'unknown';
    console.error('[discord] club-events read failed:', detail);
    return NextResponse.json({ error: 'club_events_unavailable', detail }, { status: 503 });
  }

  const byId = new Map<string, ClubEventRow>();
  for (const row of [
    ...((upcomingResult.data ?? []) as ClubEventRow[]),
    ...((knownResult.data ?? []) as ClubEventRow[]),
  ]) {
    byId.set(row.id, row);
  }

  // Each event's Google Form, for the non-member line. Never degraded to "no
  // forms": that would rewrite every Discord event's description, and again
  // when the read comes back.
  const forms = await clubEventFormLinks(supabase, [...byId.keys()]);
  if (forms.error) {
    console.error('[discord] club-events form read failed:', forms.error);
    return NextResponse.json({ error: 'forms_unavailable', detail: forms.error }, { status: 503 });
  }

  const actions: Action[] = [];
  const skipped: { eventId: string; reason: string }[] = [];

  if (mapped.size === MAX_MAPPED) {
    console.warn(
      `[discord] club-events: ${MAX_MAPPED} mapped events in ${guildId}, ` +
        'at the per-tick cap. Older ones are not being synced this run.'
    );
    skipped.push({ eventId: '*', reason: 'mapping_cap_reached' });
  }

  // DELETED OUTRIGHT. deleteClubEvent is a hard DELETE and 00245 carries no
  // foreign key, so the mapping survives and has to be swept here.
  //
  // "Absent" may only mean "deleted" on positive evidence that club_events is
  // readable, as in the tournament route. The difference is what happens when
  // the table reads as empty: for club events that is a likely state (the
  // first event published, then deleted), and a 503 every tick would leave its
  // Discord event up for good. So an empty table falls back to the audit log:
  // an orphan with a club_event_deleted row is cancelled, and the rest wait.
  const orphans = [...mapped.keys()].filter((id) => !byId.has(id));

  if (orphans.length > 0) {
    let sweepable = byId.size > 0;

    if (!sweepable) {
      const { data: anyRow, error: livenessError } = await supabase
        .from('club_events')
        .select('id')
        .limit(1);
      sweepable = !livenessError && ((anyRow ?? []) as { id: string }[]).length > 0;
    }

    let confirmed: Set<string>;
    if (sweepable) {
      confirmed = new Set(orphans);
    } else {
      const { data: audited, error: auditError } = await supabase
        .from('audit_logs')
        .select('target_id')
        .eq('action_type', 'club_event_deleted')
        .in('target_id', orphans);

      if (auditError) {
        console.error(
          '[discord] club-events: club_events reads as empty and the audit log ' +
            `could not be read either. Refusing to cancel. ${auditError.message ?? ''}`
        );
        return NextResponse.json({ error: 'club_events_unverified' }, { status: 503 });
      }

      confirmed = new Set(((audited ?? []) as { target_id: string }[]).map((a) => a.target_id));
      const unverified = orphans.filter((id) => !confirmed.has(id));
      if (unverified.length > 0) {
        console.error(
          `[discord] club-events: ${unverified.length} mapped club event(s) look deleted, ` +
            'club_events reads as empty and no club_event_deleted audit row confirms it. ' +
            'Not cancelling. Check the SELECT grant and the PostgREST schema cache.'
        );
      }
      for (const id of unverified) skipped.push({ eventId: id, reason: 'absence_unverified' });
    }

    for (const id of orphans) {
      if (confirmed.has(id)) actions.push(cancelFrom(id, mapped.get(id)!));
    }
  }

  for (const e of byId.values()) {
    const existing = mapped.get(e.id) ?? null;
    const start = Date.parse(e.starts_at);
    const end = effectiveEnd(e);

    // Draft, cancelled, or over. Past the end is cleanup rather than news:
    // Discord has already completed the event, and freeing the row keeps the
    // table away from MAX_MAPPED.
    const keepable = e.status === 'published' && end > now;

    if (!keepable) {
      if (existing) actions.push(cancelFrom(e.id, existing));
      continue;
    }

    const name = fit(e.title.trim(), MAX_NAME);
    const location = e.location?.trim() ? fit(e.location.trim(), MAX_LOCATION) : null;
    const description = describeClubEvent(e, appUrl, forms.links.get(e.id) ?? null);
    // Clamped to send, unclamped to record, for the tournament route's reason.
    const sendStart = Math.max(start, now + CLAMP_SLACK_MS);

    if (!existing) {
      // The in-memory half of "only announce the future": the by-id read has
      // no time filter, and an event that has started is not news.
      if (start <= now) {
        skipped.push({ eventId: e.id, reason: 'already_started' });
        continue;
      }
      if (end <= sendStart) {
        skipped.push({ eventId: e.id, reason: 'too_soon' });
        continue;
      }
      actions.push({
        kind: 'create',
        eventId: e.id,
        discordEventId: null,
        name,
        startsAt: new Date(sendStart).toISOString(),
        endsAt: new Date(end).toISOString(),
        syncedStartsAt: new Date(start).toISOString(),
        syncedEndsAt: new Date(end).toISOString(),
        patchTimes: true,
        location,
        description,
      });
      continue;
    }

    const renamed = existing.synced_name !== name;
    const redescribed = existing.synced_description !== description;
    const retimed =
      Date.parse(existing.synced_starts_at) !== start ||
      Date.parse(existing.synced_ends_at) !== end;
    const relocated = (existing.synced_location ?? null) !== location;

    if (!renamed && !redescribed && !retimed && !relocated) continue;

    // Discord will not retime a started event, and modifyScheduledEvent only
    // sends the location together with the times, so a started event gets a
    // name and description PATCH or nothing. See the tournament route.
    const started = start <= now || Date.parse(existing.synced_starts_at) <= now;

    if (started && !renamed && !redescribed) {
      skipped.push({ eventId: e.id, reason: 'started_cannot_retime' });
      continue;
    }
    if (!started && end <= sendStart) {
      skipped.push({ eventId: e.id, reason: 'too_soon' });
      continue;
    }

    actions.push({
      kind: 'update',
      eventId: e.id,
      discordEventId: existing.discord_event_id,
      name,
      startsAt: new Date(sendStart).toISOString(),
      endsAt: new Date(end).toISOString(),
      syncedStartsAt: new Date(start).toISOString(),
      syncedEndsAt: new Date(end).toISOString(),
      patchTimes: !started,
      location,
      description,
    });
  }

  return NextResponse.json({ actions, skipped });
}

// Record a Discord event the bot has ALREADY created or modified.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : null);
  const eventId = str('eventId');
  const guildId = str('guildId');
  const discordEventId = str('discordEventId');
  const name = str('name');
  const startsAt = str('syncedStartsAt');
  const endsAt = str('syncedEndsAt');
  // Not truthiness: a null location and an empty description are both real.
  const location = body.location;
  const description = body.description;

  if (
    !eventId ||
    !isUuid(eventId) ||
    !guildId ||
    !discordEventId ||
    !name ||
    !startsAt ||
    !endsAt ||
    !(typeof location === 'string' || location === null) ||
    typeof description !== 'string'
  ) {
    return NextResponse.json({ error: 'incomplete_mapping' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_club_events')
    .upsert(
      {
        club_event_id: eventId,
        guild_id: guildId,
        discord_event_id: discordEventId,
        synced_name: name,
        synced_starts_at: startsAt,
        synced_ends_at: endsAt,
        synced_location: location,
        synced_description: description,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'club_event_id,guild_id' }
    );

  if (error) {
    // Loud. A create that posted but did not record leaves a Discord event with
    // no mapping, and the next tick makes a SECOND one the whole server sees.
    console.error('[discord] club-event record failed:', error.message);
    return NextResponse.json({ error: 'record_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}

// Forget a mapping, after the bot has cancelled the Discord event.
export async function DELETE(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const params = new URL(request.url).searchParams;
  const eventId = params.get('eventId');
  const guildId = params.get('guildId');
  if (!eventId || !guildId) {
    return NextResponse.json({ error: 'event_and_guild_required' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_club_events')
    .delete()
    .eq('club_event_id', eventId)
    .eq('guild_id', guildId);

  if (error) {
    console.error('[discord] club-event delete failed:', error.message);
    return NextResponse.json({ error: 'delete_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
