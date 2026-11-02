import { NextResponse } from 'next/server';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  clockHHMM,
  readFeatureFlags,
  wallClockToUtc,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Which tournaments owe Discord a scheduled event, and what to do about each.
//
// THE APP DECIDES, THE BOT CALLS DISCORD. Same split as the session pings: the
// bot holds the token and nothing else, so "what counts as public" is settled
// in one place and cannot drift between the website and the server.
//
// A TOURNAMENT GOES PUBLIC WHEN IT GOES ACTIVE. `tournaments` has no "posted"
// flag — status is draft | active | completed | archived — and draft is where
// an exec assembles one before anybody is meant to see it. RLS on the table is
// USING (TRUE), so a member technically CAN read a draft on the website today,
// but announcing one in Discord is a different act from it being fetchable:
// this is the thing that pings the Events tab. Draft stays private here.
//
// THE THREE FIELDS DISCORD NEEDS BEYOND THE DATES. An EXTERNAL scheduled
// event requires a start instant, an end instant and a location. `tournaments`
// stores start_date and end_date as DATEs, and since 00304 each tournament
// carries its own starts_time, ends_time and location, set in the console or
// with /tourney details. A tournament that leaves one blank takes the old
// club-wide discord_settings key, which is still read so nothing posted before
// 00304 moves, but is no longer settable; then 09:00, 18:00 and no location.

interface TournamentRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  status: string;
  suspended_at: string | null;
  /** HH:MM:SS as PostgREST returns a time, or null (00304). */
  starts_time: string | null;
  ends_time: string | null;
  location: string | null;
  tournament_events: { event_type: string }[] | null;
}

interface MappingRow {
  tournament_id: string;
  discord_event_id: string;
  synced_name: string;
  synced_starts_at: string;
  synced_ends_at: string;
  /** The app's location last pushed, null when there was none (00304). */
  synced_location: string | null;
}

const DEFAULT_START_TIME = '09:00';
const DEFAULT_END_TIME = '18:00';

// Discord truncates a scheduled-event description at 1000 characters and
// rejects anything longer outright, so the description is built to fit rather
// than sent hopefully.
const MAX_DESCRIPTION = 1000;

// Discord's cap on an EXTERNAL event's location. The column allows 200 (the
// same as a session's), so the value is cut to fit here rather than refused
// by Discord on every tick, and the cut value is what gets recorded.
const MAX_LOCATION = 100;

// A start time Discord will accept has to be in the future, and "in the future"
// is evaluated at Discord's clock, not ours. Two minutes of slack covers the
// round trip and any drift without pushing the event visibly late.
const CLAMP_SLACK_MS = 2 * 60_000;

// How many mapped events one tick will look at. A SAFETY BOUND, not a
// performance one: production sets PGRST_DB_MAX_ROWS=1000 (00152), and the
// orphan sweep below reads the mapped tournaments back with .in('id', ...) and
// treats anything missing as deleted. A truncated read would make every mapping
// past the ceiling look deleted and cancel the lot, so the mapping read is kept
// where the second read cannot truncate. The club has never had a fraction of
// this many tournaments; the bound exists so the sweep is safe by construction
// rather than by assuming it.
//
// It doubles as a URL-length bound, which is the hazard the merge comment below
// already names: the ids go out in the query string at ~37 bytes each, and a
// request line past nginx's buffer comes back 414. That direction is safe (an
// error, so a 503, so no cancellations) but it is permanent, and a relay that
// 503s every tick is a relay that does not work. 150 ids is ~5.5KB.
const MAX_MAPPED = 150;

function parseClubTime(value: string | undefined, fallback: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  const source = match ? value!.trim() : fallback;
  const [h, m] = source.split(':').map(Number) as [number, number];
  // A malformed setting falls back rather than throwing: one bad row must not
  // stop every tournament being announced, and the fallback is visible in the
  // migration's owner notes.
  if (!Number.isFinite(h) || !Number.isFinite(m) || h > 23 || m > 59) {
    const [fh, fm] = fallback.split(':').map(Number) as [number, number];
    return [fh, fm];
  }
  return [h, m];
}

/**
 * Cut to at most `max` UTF-16 units without splitting a character, as the
 * club-events route does. Deterministic, because the result is compared
 * against what was recorded last time.
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

function clubDateAt(date: string, [h, m]: [number, number]): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  // wallClockToUtc rather than Intl, for the reason the session-reminder job
  // documents: BC stops changing its clocks on 2026-11-01 (tzdata 2026b) and a
  // Node predating that release answers an hour out for every date past it.
  // Tournaments are scheduled a season ahead, so that is not hypothetical.
  return wallClockToUtc(y, mo, d, h, m);
}

function describe(t: TournamentRow, appUrl: string | null): string {
  const events = (t.tournament_events ?? [])
    .map(
      (e) =>
        TOURNAMENT_EVENT_TYPE_LABELS[e.event_type as keyof typeof TOURNAMENT_EVENT_TYPE_LABELS] ??
        e.event_type
    )
    .filter((label, i, all) => all.indexOf(label) === i);

  const lines: string[] = [];
  if (events.length > 0) lines.push(`Events: ${events.join(', ')}`);
  // The link is what makes the Discord event useful rather than decorative —
  // entry, fees and the draw all live on the website, and none of them can be
  // done from the Events tab.
  if (appUrl) lines.push(`Enter and see the draw: ${appUrl}/tournaments/${t.id}`);

  return lines.join('\n\n').slice(0, MAX_DESCRIPTION);
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const guildId = new URL(request.url).searchParams.get('guildId');
  if (!guildId) return NextResponse.json({ error: 'guild_id_required' }, { status: 400 });

  const supabase = createServiceRoleClient();
  const now = Date.now();

  // TOURNAMENTS SWITCHED OFF: nothing to do, so no Discord event is created or
  // changed. Ones already posted are left standing rather than cancelled, so a
  // switch flipped by mistake does not tear down the club's Events tab. A
  // failed read is "on", which is the behaviour before the switch existed.
  const features = await readFeatureFlags(supabase);
  if (!features.tournaments) {
    return NextResponse.json({
      actions: [],
      skipped: [{ tournamentId: '*', reason: 'tournaments_disabled' }],
    });
  }

  const [settingsResult, mappedResult] = await Promise.all([
    supabase.from('discord_settings').select('key, value'),
    supabase
      .from('discord_tournament_events')
      .select(
        'tournament_id, discord_event_id, synced_name, synced_starts_at, synced_ends_at, synced_location'
      )
      .eq('guild_id', guildId)
      .order('updated_at', { ascending: false })
      .limit(MAX_MAPPED),
  ]);

  // BOTH NAMED, never degraded to an empty list. A failed PostgREST read
  // arrives as data:null with an error rather than a throw, and an empty
  // mapping list means "nothing has been announced yet" — which would make the
  // bot create a second Discord event for every tournament that already has
  // one, every tick, until the read recovered.
  if (settingsResult.error || mappedResult.error) {
    const detail = settingsResult.error?.message ?? mappedResult.error?.message ?? 'unknown';
    console.error('[discord] tournament-events config read failed:', detail);
    return NextResponse.json({ error: 'config_unavailable', detail }, { status: 503 });
  }

  const settings = new Map(
    ((settingsResult.data ?? []) as { key: string; value: string }[]).map((s) => [s.key, s.value])
  );
  // The club-wide values from before 00304: each tournament's own come first.
  const clubStartTime = settings.get('tournament_event_start_time');
  const clubEndTime = settings.get('tournament_event_end_time');
  const clubLocation = settings.get('tournament_event_location')?.trim() || null;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? null;

  const mapped = new Map(
    ((mappedResult.data ?? []) as MappingRow[]).map((m) => [m.tournament_id, m])
  );

  // One literal, not a concatenation: the typed client parses the select
  // string, and a joined string widens to plain `string` and loses the row type.
  const columns =
    'id, name, start_date, end_date, status, suspended_at, starts_time, ends_time, location, tournament_events(event_type)';

  // TWO READS, MERGED. The announceable set is "status = active"; the
  // cancellable set is "already has a Discord event", and a tournament that has
  // just been archived is in the second and not the first. One query cannot
  // express that without an .or() over an id list long enough to blow the URL
  // length, so it is two and a merge.
  const [activeResult, knownResult] = await Promise.all([
    supabase.from('tournaments').select(columns).eq('status', 'active'),
    mapped.size > 0
      ? supabase
          .from('tournaments')
          .select(columns)
          .in('id', [...mapped.keys()])
      : Promise.resolve({ data: [] as unknown, error: null }),
  ]);

  if (activeResult.error || knownResult.error) {
    const detail = activeResult.error?.message ?? knownResult.error?.message ?? 'unknown';
    console.error('[discord] tournament-events read failed:', detail);
    return NextResponse.json({ error: 'tournaments_unavailable', detail }, { status: 503 });
  }

  const byId = new Map<string, TournamentRow>();
  for (const row of [
    ...((activeResult.data ?? []) as TournamentRow[]),
    ...((knownResult.data ?? []) as TournamentRow[]),
  ]) {
    byId.set(row.id, row);
  }

  const actions: {
    kind: 'create' | 'update' | 'cancel';
    tournamentId: string;
    discordEventId: string | null;
    name: string;
    /** What to send Discord. May be clamped forward; see below. */
    startsAt: string;
    endsAt: string;
    /** What the tournament actually says. Recorded, so the diff stays stable. */
    syncedStartsAt: string;
    syncedEndsAt: string;
    /** False once Discord has started the event and will no longer retime it. */
    patchTimes: boolean;
    location: string | null;
    description: string;
  }[] = [];
  const skipped: { tournamentId: string; reason: string }[] = [];

  if (mapped.size === MAX_MAPPED) {
    console.warn(
      `[discord] tournament-events: ${MAX_MAPPED} mapped events in ${guildId} — ` +
        'at the per-tick cap, older ones are not being synced this run.'
    );
    skipped.push({ tournamentId: '*', reason: 'mapping_cap_reached' });
  }

  // THE SWEEP FIRES ONLY ON POSITIVE EVIDENCE THAT `tournaments` IS READABLE.
  // Zero rows is not that evidence.
  //
  // MAX_MAPPED defends against a TRUNCATED read; this defends against the one
  // that has actually bitten this codebase, three times: an EMPTY LIST with no
  // error — a missing grant, or a schema cache that has not seen the table.
  // Both reads above hit `tournaments`, so if that read is broken byId is empty,
  // mapped is full, and the loop below cancels every Discord event the club has,
  // while the error branch never fires because there is no error.
  //
  // A non-empty byId proves the table answered. When it is empty, one unfiltered
  // read decides: any tournament at all means reads work and the absences are
  // real; none means an emptied table and a broken one are indistinguishable
  // from here, and guessing costs more than waiting a tick.
  let sweepable = byId.size > 0;

  if (!sweepable && mapped.size > 0) {
    const { data: anyRow, error: livenessError } = await supabase
      .from('tournaments')
      .select('id')
      .limit(1);

    sweepable = !livenessError && ((anyRow ?? []) as { id: string }[]).length > 0;

    if (!sweepable) {
      console.error(
        `[discord] tournament-events: all ${mapped.size} mapped tournament(s) look ` +
          'deleted and public.tournaments reads as empty — refusing to cancel on ' +
          'evidence this weak. Check the SELECT grant and the PostgREST schema ' +
          `cache. ${livenessError?.message ?? ''}`
      );
      return NextResponse.json({ error: 'tournaments_unverified' }, { status: 503 });
    }
  }

  // RUN AS A CLUB EVENT (00292): posted once, by the club-events route, whose
  // description carries the bracket link. Without this a linked pair is two
  // Discord events for one day of badminton.
  //
  // "Linked" is any PUBLISHED club event whose tournament_event_id is one of
  // this tournament's events, whatever its times. Published is the club-events
  // route's test for creating and for keeping, so this covers what it would
  // announce and what it has announced. No time cut on purpose: once the club
  // event ends its Discord event goes, and bringing the tournament's back for
  // the rest of the run would flip a duplicate on at the worst moment.
  //
  // Only while club events are switched on: with them off the club-events
  // route posts nothing, and standing this one down would leave the tournament
  // with no Discord event at all.
  //
  // A failed read is a 503, as for every other read here. A read that comes
  // back silently empty can only make a tournament look UNlinked, which posts
  // a duplicate rather than deleting anything: the safe direction.
  const runsAsClubEvent = new Set<string>();
  if (byId.size > 0 && features.events) {
    const { data: linkedClubEvents, error: clubEventsError } = await supabase
      .from('club_events')
      .select('tournament_event_id')
      .eq('status', 'published')
      .not('tournament_event_id', 'is', null);
    const linkedEventIds = [
      ...new Set(
        ((linkedClubEvents ?? []) as { tournament_event_id: string | null }[])
          .map((c) => c.tournament_event_id)
          .filter((id): id is string => !!id)
      ),
    ];
    const linkedResult =
      clubEventsError || linkedEventIds.length === 0
        ? { data: [] as unknown, error: null }
        : await supabase.from('tournament_events').select('id, tournament_id').in('id', linkedEventIds);
    const linkError = clubEventsError ?? linkedResult.error;
    if (linkError) {
      console.error('[discord] tournament-events club event link read failed:', linkError.message);
      return NextResponse.json({ error: 'club_events_unavailable', detail: linkError.message }, { status: 503 });
    }
    for (const row of (linkedResult.data ?? []) as { tournament_id: string }[]) {
      runsAsClubEvent.add(row.tournament_id);
    }
  }

  // DELETED OUTRIGHT, which the loop below cannot see because there is no row
  // left to iterate.
  //
  // deleteTournament is a hard DELETE, and 00169 deliberately does not reference
  // tournaments(id) so this mapping survives it. Without the sweep, the one way
  // of removing a tournament that leaves nothing behind on the website would be
  // the one that leaves its Discord event up forever — archiving, suspending and
  // completing all take it down.
  //
  // "Absent from byId" is only allowed to mean "deleted" because of the two
  // guards above: MAX_MAPPED, so it cannot mean "truncated at
  // PGRST_DB_MAX_ROWS", and the liveness check, so it cannot mean "the read
  // returned nothing and did not say why".
  for (const [tournamentId, existing] of mapped) {
    if (byId.has(tournamentId)) continue;
    actions.push({
      kind: 'cancel',
      tournamentId,
      discordEventId: existing.discord_event_id,
      name: existing.synced_name,
      startsAt: existing.synced_starts_at,
      endsAt: existing.synced_ends_at,
      syncedStartsAt: existing.synced_starts_at,
      syncedEndsAt: existing.synced_ends_at,
      patchTimes: false,
      location: existing.synced_location ?? null,
      description: '',
    });
  }

  for (const t of byId.values()) {
    const existing = mapped.get(t.id) ?? null;

    // ACTIVE AND UNSUSPENDED, and every other state loses its Discord event.
    //
    // Suspended counts as unannounced rather than merely paused: a suspended
    // tournament is one the club has told members is off, and leaving a live
    // event with a reminder attached contradicts that in the one place people
    // will be looking.
    //
    // Completed is in here too, which looks harsher than it is — Discord has
    // already ended the event by then, so the delete removes nothing anybody
    // can still see and frees the mapping row. Reverting to draft is the same
    // story: an exec pulling a tournament back to draft has unpublished it.
    const announceable = t.status === 'active' && t.suspended_at === null;

    if (!announceable) {
      if (existing) {
        actions.push({
          kind: 'cancel',
          tournamentId: t.id,
          discordEventId: existing.discord_event_id,
          name: t.name,
          startsAt: existing.synced_starts_at,
          endsAt: existing.synced_ends_at,
          syncedStartsAt: existing.synced_starts_at,
          syncedEndsAt: existing.synced_ends_at,
          patchTimes: false,
          location: existing.synced_location ?? null,
          description: '',
        });
      }
      continue;
    }

    // Its club event carries it instead (see runsAsClubEvent). One posted
    // before the link, or before this rule, is taken down the way an
    // unpublished tournament's is, so the duplicate goes.
    if (runsAsClubEvent.has(t.id)) {
      if (existing) {
        actions.push({
          kind: 'cancel',
          tournamentId: t.id,
          discordEventId: existing.discord_event_id,
          name: t.name,
          startsAt: existing.synced_starts_at,
          endsAt: existing.synced_ends_at,
          syncedStartsAt: existing.synced_starts_at,
          syncedEndsAt: existing.synced_ends_at,
          patchTimes: false,
          location: existing.synced_location ?? null,
          description: '',
        });
      } else {
        skipped.push({ tournamentId: t.id, reason: 'runs_as_club_event' });
      }
      continue;
    }

    // Each value on its own: the tournament's, else the club's old key, else
    // the default. clockHHMM because a time column comes back as HH:MM:SS,
    // which parseClubTime would read as malformed and quietly replace.
    const startTime = parseClubTime(clockHHMM(t.starts_time) ?? clubStartTime, DEFAULT_START_TIME);
    const endTime = parseClubTime(clockHHMM(t.ends_time) ?? clubEndTime, DEFAULT_END_TIME);
    const ownLocation = t.location?.trim() || clubLocation;
    const location = ownLocation ? fit(ownLocation, MAX_LOCATION) : null;

    const starts = clubDateAt(t.start_date, startTime);
    const ends = clubDateAt(t.end_date ?? t.start_date, endTime);

    // An end before the start is a data problem, not something to send: a
    // one-day tournament with the end time set earlier than the start time
    // would be rejected by Discord anyway, and silently rescheduling it would
    // hide the misconfiguration.
    if (ends.getTime() <= starts.getTime()) {
      skipped.push({ tournamentId: t.id, reason: 'end_before_start' });
      continue;
    }

    // Already over. Activating a tournament after its last day is a records
    // exercise — backfilling results, usually — and announcing it would put a
    // finished event in the Events tab. Recorded rather than dropped silently,
    // so a run that announces nothing can say why.
    if (ends.getTime() <= now) {
      skipped.push({ tournamentId: t.id, reason: 'already_ended' });
      continue;
    }

    // CLAMPED TO SEND, UNCLAMPED TO RECORD, and the split is deliberate.
    //
    // Discord refuses a scheduled_start_time in the past, which is the routine
    // case rather than the exotic one: drafts sit around, and an exec who
    // activates on the morning of day one has a start time hours gone. Sending
    // now+slack gets the event created. Recording the tournament's OWN value is
    // what stops the next tick seeing a difference between "what we sent" and
    // "what the row says" and PATCHing forever.
    const sendStart = new Date(Math.max(starts.getTime(), now + CLAMP_SLACK_MS));

    if (!existing) {
      actions.push({
        kind: 'create',
        tournamentId: t.id,
        discordEventId: null,
        name: t.name,
        startsAt: sendStart.toISOString(),
        endsAt: ends.toISOString(),
        syncedStartsAt: starts.toISOString(),
        syncedEndsAt: ends.toISOString(),
        patchTimes: true,
        location,
        description: describe(t, appUrl),
      });
      continue;
    }

    const renamed = existing.synced_name !== t.name;
    const retimed =
      Date.parse(existing.synced_starts_at) !== starts.getTime() ||
      Date.parse(existing.synced_ends_at) !== ends.getTime();
    // Its own column since 00304, as discord_club_events has. Before it a
    // location could only change club-wide, and the change was never pushed.
    const relocated = (existing.synced_location ?? null) !== location;

    if (!renamed && !retimed && !relocated) continue;

    // ONCE DISCORD HAS STARTED THE EVENT, ITS TIMES ARE FROZEN — and pretending
    // otherwise is how this route would have burned a call every fifteen
    // minutes for the length of a tournament.
    //
    // Discord refuses to retime an event already in progress. Nothing here
    // needs to go wrong for that to bite: a tournament is mid-run, an exec
    // edits its start time, the PATCH is refused, nothing is recorded, and the
    // next tick computes the identical diff and tries again. A location change
    // is the same case, because modifyScheduledEvent only sends the location
    // together with the times.
    // The session pings carry MAX_LATENESS_MINUTES for exactly this shape.
    //
    // So: a started event gets a name-and-description PATCH or nothing at all.
    // A rename still lands — that is the change members would actually notice —
    // and recording the tournament's current times alongside it settles the
    // comparison, leaving Discord holding the times it was created with. Those
    // times describe an event that is already underway, so nobody can act on
    // them anyway.
    //
    // Started is read from the RECORDED start as well as the computed one,
    // because the recorded value is the one Discord was given.
    const started =
      starts.getTime() <= now || Date.parse(existing.synced_starts_at) <= now;

    if (started && !renamed) {
      // A time change nobody can push. Reported rather than dropped in silence,
      // because "the Discord event says the wrong day" is otherwise unanswerable
      // — but emphatically not retried, which is the whole point.
      skipped.push({ tournamentId: t.id, reason: 'started_cannot_retime' });
      continue;
    }

    actions.push({
      kind: 'update',
      tournamentId: t.id,
      discordEventId: existing.discord_event_id,
      name: t.name,
      startsAt: sendStart.toISOString(),
      endsAt: ends.toISOString(),
      syncedStartsAt: starts.toISOString(),
      syncedEndsAt: ends.toISOString(),
      patchTimes: !started,
      location,
      description: describe(t, appUrl),
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
  const tournamentId = str('tournamentId');
  const guildId = str('guildId');
  const discordEventId = str('discordEventId');
  const name = str('name');
  const startsAt = str('syncedStartsAt');
  const endsAt = str('syncedEndsAt');

  // OPTIONAL, unlike the club-events route, and only because of the order
  // things deploy in: a bot older than 00304 records without a location, and a
  // 400 here would leave a created Discord event with no mapping, which the
  // next tick duplicates. Absent leaves the recorded value alone; null is "no
  // location", which is real.
  const hasLocation = Object.hasOwn(body, 'location');
  const location = body.location;

  if (
    !tournamentId ||
    !guildId ||
    !discordEventId ||
    !name ||
    !startsAt ||
    !endsAt ||
    (hasLocation && !(typeof location === 'string' || location === null))
  ) {
    return NextResponse.json({ error: 'incomplete_mapping' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_tournament_events')
    .upsert(
      {
        tournament_id: tournamentId,
        guild_id: guildId,
        discord_event_id: discordEventId,
        synced_name: name,
        synced_starts_at: startsAt,
        synced_ends_at: endsAt,
        ...(hasLocation ? { synced_location: location as string | null } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tournament_id,guild_id' }
    );

  if (error) {
    // Loud. A create that posted but did not record leaves a Discord event with
    // no mapping, and the next tick makes a SECOND one — the duplicate is
    // visible to the whole server, so this must be visible in the log.
    console.error('[discord] tournament-event record failed:', error.message);
    return NextResponse.json({ error: 'record_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}

// Forget a mapping, after the bot has cancelled the Discord event.
export async function DELETE(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const params = new URL(request.url).searchParams;
  const tournamentId = params.get('tournamentId');
  const guildId = params.get('guildId');
  if (!tournamentId || !guildId) {
    return NextResponse.json({ error: 'tournament_and_guild_required' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_tournament_events')
    .delete()
    .eq('tournament_id', tournamentId)
    .eq('guild_id', guildId);

  if (error) {
    console.error('[discord] tournament-event delete failed:', error.message);
    return NextResponse.json({ error: 'delete_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
