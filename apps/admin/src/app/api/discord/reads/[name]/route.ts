import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import {
  CLUB_EVENT_KIND_LABELS,
  clubToday,
  formatClubEventTime,
  formatDate,
  formatTime,
  utcToClubWallClock,
  TOURNAMENT_EVENT_TYPE_LABELS,
  type ClubEventInput,
  type ClubEventKind,
  type TournamentEventType,
} from '@badminton/shared';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { discordActorStore, resolveDiscordActor } from '@/lib/discord-actor';
import { isWaivedFee } from '@/lib/fee-status';
import { isAuthorizedDiscordService, discordServiceUnauthorized } from '@/lib/discord-service-auth';
import type { Capability } from '@/lib/permissions';

// CONSOLE COMMANDS ON DISCORD: the reads behind the lists, the pickers and the
// edit merges.
//
// Same door as the actions route: the service secret, then the linked exec in
// discordActorStore. Each read asks requireCapability for the capability the
// console page it mirrors asks for, so somebody who cannot open Sessions in
// the console cannot list them from Discord either; the query itself then
// runs with the service role, as the console's own pages do.
//
// The rows are turned into what the bot needs HERE, where it is type-checked:
// labels already formatted in club time, and for the edit paths the exact
// input the console action takes. updateSession reads a missing field as
// "clear it" and updateClubEvent takes wall-clock strings and dollars, so a
// merge assembled in the bot from raw rows would blank or shift columns.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHOICES_MAX = 25;

type AdminClient = ReturnType<typeof createAdminClient>;
type ReadResult = { ok: true; data: unknown } | { unavailable: true };

function reply(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: NO_STORE });
}

function failed(step: string, error: { message: string }): ReadResult {
  Sentry.captureException(new Error(`Discord console read ${step} failed: ${error.message}`));
  return { unavailable: true };
}

type SessionRow = {
  id: string;
  name: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  notes: string | null;
  track: 'competitive' | 'recreational' | 'all';
  status: string;
};

const SESSION_COLUMNS = 'id, name, date, start_time, end_time, location, notes, track, status';

function sessionLabel(s: SessionRow): string {
  const when = [formatDate(s.date), s.start_time ? formatTime(s.start_time) : null].filter(Boolean).join(' ');
  return [when, s.name ?? 'Practice Session', s.location].filter(Boolean).join(' · ');
}

function sessionView(s: SessionRow) {
  return {
    id: s.id,
    label: sessionLabel(s),
    status: s.status,
    track: s.track,
    // The input updateSession takes, field for field, so the bot only overlays
    // what the exec changed. Times are trimmed to HH:MM because that is the
    // shape the console's form posts.
    editInput: {
      name: s.name ?? 'Practice Session',
      date: s.date,
      ...(s.start_time ? { time: s.start_time.slice(0, 5) } : {}),
      ...(s.end_time ? { end_time: s.end_time.slice(0, 5) } : {}),
      location: s.location ?? '',
      ...(s.notes ? { notes: s.notes } : {}),
      track: s.track,
    },
  };
}

async function readSessions(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const id = params.get('id');
  if (id) {
    if (!UUID.test(id)) return { ok: true, data: { sessions: [] } };
    const { data, error } = await adminClient.from('sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle();
    if (error) return failed('sessions', error);
    return { ok: true, data: { sessions: data ? [sessionView(data as SessionRow)] : [] } };
  }

  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);
  const { data, error } = await adminClient
    .from('sessions')
    .select(SESSION_COLUMNS)
    .eq('status', 'open')
    .gte('date', clubToday())
    .order('date', { ascending: true })
    .order('start_time', { ascending: true, nullsFirst: false })
    .limit(60);
  if (error) return failed('sessions', error);
  const rows = ((data ?? []) as SessionRow[]).filter(
    (s) => !q || sessionLabel(s).toLowerCase().includes(q),
  );
  return { ok: true, data: { sessions: rows.slice(0, CHOICES_MAX).map(sessionView) } };
}

async function readSessionAttendance(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const id = params.get('id') ?? '';
  if (!UUID.test(id)) return { ok: true, data: { session: null } };

  const [sessionRes, rsvpRes, attendanceRes] = await Promise.all([
    adminClient.from('sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle(),
    adminClient
      .from('session_rsvp')
      .select('player_id', { count: 'exact', head: true })
      .eq('session_id', id)
      .eq('intent', 'going'),
    adminClient
      .from('session_attendance')
      .select('status, checked_in_at, players!session_attendance_player_id_fkey(full_name)')
      .eq('session_id', id)
      .in('status', ['checked_in', 'present'])
      .order('checked_in_at', { ascending: true }),
  ]);
  if (sessionRes.error) return failed('session-attendance', sessionRes.error);
  if (rsvpRes.error) return failed('session-attendance', rsvpRes.error);
  if (attendanceRes.error) return failed('session-attendance', attendanceRes.error);
  if (!sessionRes.data) return { ok: true, data: { session: null } };

  type AttendanceRow = { players: { full_name: string | null } | { full_name: string | null }[] | null };
  const names = ((attendanceRes.data ?? []) as AttendanceRow[]).map((row) => {
    const player = Array.isArray(row.players) ? row.players[0] : row.players;
    return player?.full_name ?? 'A member';
  });
  return {
    ok: true,
    data: {
      session: { id, label: sessionLabel(sessionRes.data as SessionRow) },
      going: rsvpRes.count ?? 0,
      checkedIn: names,
    },
  };
}

async function readLocations(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);
  const { data, error } = await adminClient
    .from('sessions')
    .select('location')
    .order('date', { ascending: false })
    .limit(200);
  if (error) return failed('locations', error);
  const seen = new Set<string>();
  const locations: string[] = [];
  for (const row of (data ?? []) as { location: string | null }[]) {
    const label = row.location?.trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    if (q && !label.toLowerCase().includes(q)) continue;
    locations.push(label.slice(0, 100));
    if (locations.length >= CHOICES_MAX) break;
  }
  return { ok: true, data: { locations } };
}

type EventRow = {
  id: string;
  title: string;
  kind: ClubEventKind;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  signup_opens_at: string | null;
  signup_closes_at: string | null;
  capacity: number | null;
  cost_cents: number | null;
  status: string;
};

const EVENT_COLUMNS =
  'id, title, kind, description, location, starts_at, ends_at, signup_opens_at, signup_closes_at, capacity, cost_cents, status';

function eventLabel(e: EventRow): string {
  const status = e.status === 'published' ? null : e.status === 'draft' ? 'Draft' : 'Cancelled';
  return [formatClubEventTime(e.starts_at), e.title, CLUB_EVENT_KIND_LABELS[e.kind] ?? e.kind, status]
    .filter(Boolean)
    .join(' · ');
}

function eventView(e: EventRow) {
  const editInput: ClubEventInput = {
    title: e.title,
    kind: e.kind,
    description: e.description,
    location: e.location,
    starts_at: utcToClubWallClock(e.starts_at),
    ends_at: e.ends_at ? utcToClubWallClock(e.ends_at) : null,
    signup_opens_at: e.signup_opens_at ? utcToClubWallClock(e.signup_opens_at) : null,
    signup_closes_at: e.signup_closes_at ? utcToClubWallClock(e.signup_closes_at) : null,
    capacity: e.capacity,
    cost_dollars: e.cost_cents === null ? null : e.cost_cents / 100,
    publish: e.status === 'published',
  };
  return { id: e.id, label: eventLabel(e), status: e.status, editInput };
}

async function readEvents(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const id = params.get('id');
  if (id) {
    if (!UUID.test(id)) return { ok: true, data: { events: [] } };
    const { data, error } = await adminClient.from('club_events').select(EVENT_COLUMNS).eq('id', id).maybeSingle();
    if (error) return failed('events', error);
    return { ok: true, data: { events: data ? [eventView(data as EventRow)] : [] } };
  }

  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);
  // Drafts and published events that have not started more than a day ago:
  // the ones an exec might still publish, cancel or delete.
  const { data, error } = await adminClient
    .from('club_events')
    .select(EVENT_COLUMNS)
    .in('status', ['draft', 'published'])
    .gte('starts_at', new Date(Date.now() - 86_400_000).toISOString())
    .order('starts_at', { ascending: true })
    .limit(60);
  if (error) return failed('events', error);
  const rows = ((data ?? []) as EventRow[]).filter((e) => !q || eventLabel(e).toLowerCase().includes(q));
  return { ok: true, data: { events: rows.slice(0, CHOICES_MAX).map(eventView) } };
}

async function readEventSignups(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const id = params.get('id') ?? '';
  if (!UUID.test(id)) return { ok: true, data: { event: null } };

  const [eventRes, signupsRes] = await Promise.all([
    adminClient.from('club_events').select(EVENT_COLUMNS).eq('id', id).maybeSingle(),
    adminClient
      .from('club_event_signups')
      .select('player_id, created_at, players(full_name)')
      .eq('event_id', id)
      .order('created_at', { ascending: true }),
  ]);
  if (eventRes.error) return failed('event-signups', eventRes.error);
  if (signupsRes.error) return failed('event-signups', signupsRes.error);
  if (!eventRes.data) return { ok: true, data: { event: null } };

  type SignupRow = { players: { full_name: string | null } | { full_name: string | null }[] | null };
  const names = ((signupsRes.data ?? []) as SignupRow[]).map((row) => {
    const player = Array.isArray(row.players) ? row.players[0] : row.players;
    return player?.full_name ?? 'A member';
  });
  const event = eventRes.data as EventRow;
  return {
    ok: true,
    data: { event: { id, label: eventLabel(event), capacity: event.capacity }, signups: names },
  };
}

// ---- tournaments (/tourney) -------------------------------------------------
//
// Every per-tournament read is scoped in two steps: the tournament's event ids
// first, then `.in('event_id', ids)`. An embedded filter without !inner would
// quietly return every tournament's rows.

type TournamentRow = {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  status: string;
  suspended_at: string | null;
};

const STATUS_WORDS: Record<string, string> = {
  draft: 'Draft',
  active: 'Active',
  completed: 'Completed',
  archived: 'Archived',
};

function tournamentLabel(t: TournamentRow): string {
  const dates = t.end_date && t.end_date !== t.start_date
    ? `${formatDate(t.start_date)} to ${formatDate(t.end_date)}`
    : formatDate(t.start_date);
  return [t.name, dates, STATUS_WORDS[t.status] ?? t.status, t.suspended_at ? 'Suspended' : null]
    .filter(Boolean)
    .join(' · ');
}

async function readTournaments(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);
  const { data, error } = await adminClient
    .from('tournaments')
    .select('id, name, start_date, end_date, status, suspended_at')
    .neq('status', 'archived')
    .order('start_date', { ascending: false })
    .limit(60);
  if (error) return failed('tournaments', error);
  const rows = ((data ?? []) as TournamentRow[]).filter(
    (t) => !q || tournamentLabel(t).toLowerCase().includes(q),
  );
  return {
    ok: true,
    data: {
      tournaments: rows.slice(0, CHOICES_MAX).map((t) => ({
        id: t.id,
        label: tournamentLabel(t),
        status: t.status,
        suspended: t.suspended_at !== null,
      })),
    },
  };
}

type EventRef = { id: string; event_type: string; status: string };

async function tournamentEvents(
  adminClient: AdminClient,
  tournamentId: string,
): Promise<{ ok: true; events: Map<string, EventRef> } | { ok: false; error: { message: string } }> {
  const { data, error } = await adminClient
    .from('tournament_events')
    .select('id, event_type, status')
    .eq('tournament_id', tournamentId);
  if (error) return { ok: false, error };
  return { ok: true, events: new Map(((data ?? []) as EventRef[]).map((e) => [e.id, e])) };
}

function eventName(events: Map<string, EventRef>, eventId: string): string {
  const type = events.get(eventId)?.event_type;
  return type ? TOURNAMENT_EVENT_TYPE_LABELS[type as TournamentEventType] ?? type : 'Event';
}

type NameEmbed = { full_name: string | null } | { full_name: string | null }[] | null;

function embeddedName(embed: NameEmbed): string | null {
  const one = Array.isArray(embed) ? embed[0] : embed;
  return one?.full_name ?? null;
}

type ParticipantRow = { id: string; event_id: string; status: string; player: NameEmbed };
type PairRow = {
  id: string;
  event_id: string;
  status: string;
  pair_name: string | null;
  external1_name: string | null;
  external2_name: string | null;
  player1: NameEmbed;
  player2: NameEmbed;
};

function pairName(p: PairRow): string {
  const names = [embeddedName(p.player1) ?? p.external1_name, embeddedName(p.player2) ?? p.external2_name]
    .filter(Boolean)
    .join(' & ');
  return names || p.pair_name || 'A pair';
}

/** Every entry in these events: singles entrants and pairs, with names. */
async function readEntryRows(adminClient: AdminClient, eventIds: string[]) {
  const [participantRes, pairRes] = await Promise.all([
    adminClient
      .from('tournament_participants')
      .select('id, event_id, status, player:players!player_id(full_name)')
      .in('event_id', eventIds),
    adminClient
      .from('tournament_pairs')
      .select(
        'id, event_id, status, pair_name, external1_name, external2_name, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)',
      )
      .in('event_id', eventIds),
  ]);
  return { participantRes, pairRes };
}

function statusWords(status: string): string {
  return status.replace(/_/g, ' ');
}

async function readTournamentEntries(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const tournamentId = params.get('tournamentId') ?? '';
  if (!UUID.test(tournamentId)) return { ok: true, data: { entries: [] } };
  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);

  const events = await tournamentEvents(adminClient, tournamentId);
  if (!events.ok) return failed('tournament-entries', events.error);
  const eventIds = [...events.events.keys()];
  if (eventIds.length === 0) return { ok: true, data: { entries: [] } };

  const { participantRes, pairRes } = await readEntryRows(adminClient, eventIds);
  if (participantRes.error) return failed('tournament-entries', participantRes.error);
  if (pairRes.error) return failed('tournament-entries', pairRes.error);

  const entries = [
    ...((participantRes.data ?? []) as unknown as ParticipantRow[]).map((p) => ({
      value: `p:${p.id}`,
      name: embeddedName(p.player) ?? 'A member',
      label: [embeddedName(p.player) ?? 'A member', eventName(events.events, p.event_id), statusWords(p.status)].join(' · '),
    })),
    ...((pairRes.data ?? []) as unknown as PairRow[]).map((p) => ({
      value: `pr:${p.id}`,
      name: pairName(p),
      label: [pairName(p), eventName(events.events, p.event_id), statusWords(p.status)].join(' · '),
    })),
  ]
    .filter((e) => !q || e.label.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, CHOICES_MAX)
    .map((e) => ({ value: e.value, label: e.label.slice(0, 100) }));
  return { ok: true, data: { entries } };
}

type MatchRow = {
  id: string;
  event_id: string;
  round_number: number;
  bracket_position: number;
  match_number: number | null;
  match_label: string | null;
  court: string | null;
  status: string;
  is_bye: boolean | null;
  participant_a_id: string | null;
  participant_b_id: string | null;
  pair_a_id: string | null;
  pair_b_id: string | null;
};

const MATCH_COLUMNS =
  'id, event_id, round_number, bracket_position, match_number, match_label, court, status, is_bye, participant_a_id, participant_b_id, pair_a_id, pair_b_id';

const PLAYABLE = ['pending', 'ready', 'live'];

/** "R2 #3", or the staged event's own label. The member draw uses the same rule. */
function matchRef(m: MatchRow): string {
  return m.match_label ?? `R${m.round_number} #${m.match_number ?? m.bracket_position + 1}`;
}

async function readTournamentMatches(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const tournamentId = params.get('tournamentId') ?? '';
  if (!UUID.test(tournamentId)) return { ok: true, data: { matches: [] } };
  const id = params.get('id');
  if (id !== null && !UUID.test(id)) return { ok: true, data: { matches: [] } };
  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);

  const events = await tournamentEvents(adminClient, tournamentId);
  if (!events.ok) return failed('tournament-matches', events.error);
  const eventIds = [...events.events.keys()];
  if (eventIds.length === 0) return { ok: true, data: { matches: [] } };

  // One match by id (any status, for the result echo), or the playable ones.
  let query = adminClient.from('tournament_matches').select(MATCH_COLUMNS).in('event_id', eventIds);
  query = id ? query.eq('id', id) : query.in('status', PLAYABLE);
  const [matchRes, entryRows] = await Promise.all([
    query.order('round_number', { ascending: true }).order('bracket_position', { ascending: true }).limit(200),
    readEntryRows(adminClient, eventIds),
  ]);
  if (matchRes.error) return failed('tournament-matches', matchRes.error);
  if (entryRows.participantRes.error) return failed('tournament-matches', entryRows.participantRes.error);
  if (entryRows.pairRes.error) return failed('tournament-matches', entryRows.pairRes.error);

  const names = new Map<string, string>();
  for (const p of (entryRows.participantRes.data ?? []) as unknown as ParticipantRow[]) {
    names.set(p.id, embeddedName(p.player) ?? 'A member');
  }
  for (const p of (entryRows.pairRes.data ?? []) as unknown as PairRow[]) names.set(p.id, pairName(p));
  const side = (entryId: string | null) => (entryId ? names.get(entryId) ?? 'TBD' : 'TBD');

  const matches = ((matchRes.data ?? []) as MatchRow[])
    .filter((m) => !m.is_bye)
    .map((m) => {
      // SIDE A ALWAYS FIRST. /tourney result reads the first number of every
      // game as side A's, so the label has to put side A first too.
      const sideA = side(m.pair_a_id ?? m.participant_a_id);
      const sideB = side(m.pair_b_id ?? m.participant_b_id);
      const label = [
        `${eventName(events.events, m.event_id)} ${matchRef(m)}: ${sideA} v ${sideB}`,
        m.status,
        m.court ? `Court ${m.court}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return { id: m.id, label: label.slice(0, 100), sideA, sideB, status: m.status };
    })
    .filter((m) => !q || m.label.toLowerCase().includes(q))
    .slice(0, CHOICES_MAX);
  return { ok: true, data: { matches } };
}

async function readTournamentFees(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const tournamentId = params.get('tournamentId') ?? '';
  if (!UUID.test(tournamentId)) return { ok: true, data: { fees: [] } };
  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);

  const events = await tournamentEvents(adminClient, tournamentId);
  if (!events.ok) return failed('tournament-fees', events.error);
  const eventIds = [...events.events.keys()];

  // Who is on the fees page: everyone entered (not withdrawn) and everyone with
  // an entry-fee row for this tournament, as TournamentFeesPage reads them.
  const [participantRes, pairRes, feeRes] = await Promise.all([
    eventIds.length
      ? adminClient.from('tournament_participants').select('player_id').in('event_id', eventIds).neq('status', 'withdrawn')
      : Promise.resolve({ data: [], error: null }),
    eventIds.length
      ? adminClient.from('tournament_pairs').select('player1_id, player2_id').in('event_id', eventIds).neq('status', 'withdrawn')
      : Promise.resolve({ data: [], error: null }),
    adminClient
      .from('club_fees')
      .select('player_id, amount_cents, paid_at, method')
      .eq('tournament_id', tournamentId)
      .eq('fee_type', 'tournament'),
  ]);
  if (participantRes.error) return failed('tournament-fees', participantRes.error);
  if (pairRes.error) return failed('tournament-fees', pairRes.error);
  if (feeRes.error) return failed('tournament-fees', feeRes.error);

  type FeeRow = { player_id: string | null; amount_cents: number | null; paid_at: string | null; method: string | null };
  const feeByPlayer = new Map<string, FeeRow>();
  for (const f of (feeRes.data ?? []) as FeeRow[]) if (f.player_id) feeByPlayer.set(f.player_id, f);
  const playerIds = new Set<string>(feeByPlayer.keys());
  for (const row of (participantRes.data ?? []) as { player_id: string | null }[]) {
    if (row.player_id) playerIds.add(row.player_id);
  }
  for (const row of (pairRes.data ?? []) as { player1_id: string | null; player2_id: string | null }[]) {
    if (row.player1_id) playerIds.add(row.player1_id);
    if (row.player2_id) playerIds.add(row.player2_id);
  }
  if (playerIds.size === 0) return { ok: true, data: { fees: [] } };

  const { data: players, error: playersError } = await adminClient
    .from('players')
    .select('id, full_name')
    .in('id', [...playerIds].slice(0, 500));
  if (playersError) return failed('tournament-fees', playersError);

  const money = (cents: number | null) => (cents != null ? `$${(cents / 100).toFixed(2)}` : null);
  const fees = ((players ?? []) as { id: string; full_name: string | null }[])
    .map((p) => {
      const fee = feeByPlayer.get(p.id);
      const state = !fee
        ? 'No fee recorded'
        : isWaivedFee(fee)
          ? 'Waived'
          : fee.paid_at
            ? ['Paid', money(fee.amount_cents), fee.method].filter(Boolean).join(' ')
            : ['Unpaid', money(fee.amount_cents)].filter(Boolean).join(' ');
      const name = p.full_name ?? 'A member';
      return { playerId: p.id, name, paid: Boolean(fee?.paid_at), label: `${name} · ${state}`.slice(0, 100) };
    })
    .filter((f) => !q || f.label.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, CHOICES_MAX)
    .map(({ playerId, label, paid }) => ({ playerId, label, paid }));
  return { ok: true, data: { fees } };
}

const READS: Record<
  string,
  { capability: Capability; run: (adminClient: AdminClient, params: URLSearchParams) => Promise<ReadResult> }
> = {
  sessions: { capability: 'sessions.page', run: readSessions },
  'session-attendance': { capability: 'sessions.page', run: readSessionAttendance },
  locations: { capability: 'sessions.page', run: readLocations },
  events: { capability: 'events.page', run: readEvents },
  'event-signups': { capability: 'events.signups.read', run: readEventSignups },
  tournaments: { capability: 'tournaments.page', run: readTournaments },
  'tournament-entries': { capability: 'tournaments.page', run: readTournamentEntries },
  'tournament-matches': { capability: 'tournaments.page', run: readTournamentMatches },
  'tournament-fees': { capability: 'tournaments.fees.read', run: readTournamentFees },
};

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const { name } = await params;
  const read = Object.hasOwn(READS, name) ? READS[name] : undefined;
  if (!read) return reply({ error: 'Unknown read' }, 404);

  // A header rather than a query param: ids in a URL end up in access logs.
  const discordUserId = request.headers.get('x-discord-user-id') ?? '';
  if (!/^\d{5,25}$/.test(discordUserId)) return reply({ error: 'Invalid request' }, 400);

  const adminClient = createAdminClient();
  const actor = await resolveDiscordActor(discordUserId, adminClient);
  if (actor === 'unavailable') return reply({ error: 'unavailable' }, 503);
  if (actor === 'not_linked') return reply({ ok: false, refusal: 'not_linked' }, 200);

  const searchParams = new URL(request.url).searchParams;
  return discordActorStore.run({ playerId: actor.playerId, discordUserId }, async () => {
    try {
      await requireCapability(read.capability);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'AUTH-105') return reply({ ok: false, refusal: 'passkey_required' }, 200);
      // A coded refusal (no permission, suspended, pending) is a sentence the
      // console already shows people, so it travels as one.
      if (typeof code === 'string' && err instanceof Error) {
        return reply({ ok: false, error: err.message, code }, 200);
      }
      Sentry.captureException(err);
      return reply({ error: 'unavailable' }, 503);
    }

    const result = await read.run(adminClient, searchParams);
    if ('unavailable' in result) return reply({ error: 'unavailable' }, 503);
    return reply(result, 200);
  });
}
