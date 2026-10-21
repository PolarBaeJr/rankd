import Link from 'next/link';
import { redirect } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { createServerSupabaseClient, createServiceRoleClient, getViewer } from '@/lib/supabase-server';
import {
  CLUB_TIMEZONE,
  isDoublesEvent,
  quoteEntryFee,
  TOURNAMENT_EVENT_TYPE_LABELS,
  type PricingTier,
  type TournamentEventType,
  windowState,
} from '@badminton/shared';
import { AvatarChip, Badge } from '@badminton/ui';
import { clubDayKey, dayLabel } from '@/lib/feed-activity';
import { SeasonPick } from '@/components/my-stats/season-pick';
import { loadMyMembershipScreen } from '@/lib/membership-screen';
import { loadEntryWindows, windowsFor } from '@/lib/tournament-windows';
import { finishedSeasonIds, seasonPickerOptions, type HistorySeason } from '@/lib/season-history';
import {
  countEnteredPlayers,
  describeDisciplines,
  isUpcoming,
  pickHeroTournament,
  resultMonth,
  soleEnterableEvent,
  spotsLeft,
  occupiesAPlace,
  tournamentCalendarQuery,
  type IndexEvent,
  type IndexTournament,
} from '@/lib/tournament-index';

// The rows this screen actually reads, spelled out so a schema change breaks the
// build here rather than rendering an undefined into the page.
type EntryRow = {
  event_id: string;
  player_id: string;
  status: string;
};
type PairRow = {
  event_id: string;
  player1_id: string;
  player2_id: string;
  status: string;
};
type NestedEvent = {
  id: string;
  event_type: TournamentEventType;
  status: string;
  tournament: { id: string; name: string; start_date: string; status: string } | null;
};
type MyEntry = {
  id: string;
  seed_number: number | null;
  status: string;
  final_position: number | null;
  event: NestedEvent | null;
  partner: { id: string; full_name: string; avatar_url: string | null } | null;
  isDoubles: boolean;
};

// A member's entries are read newest-first and capped rather than fetched
// whole: nothing on this screen reads the far end of a four-year history. Live
// entries are the newest rows a member has, so ordering by creation date cannot
// push one of them past the cap.
const ENTRY_FETCH_CAP = 80;

// A season id arriving from the URL is checked against this before it is used in
// a filter. Postgres rejects a malformed uuid with an ERROR rather than an empty
// result, and there is no reason to send it one. Same constant, same reason, as
// the UUID in leaderboard/page.tsx and in my-stats/past-season.tsx.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Supabase returns a to-one embed as object-or-array depending on how it infers
// the relationship. Every read below goes through this rather than trusting one
// shape — the same defensive unwrap tournament-actions.ts uses.
function one<T>(embed: unknown): T | null {
  return ((Array.isArray(embed) ? embed[0] : embed) ?? null) as T | null;
}

export default async function TournamentsPage({
  searchParams,
}: {
  // Next 15 hands search params over as a promise.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const rawSeason = params.season;
  const seasonParam = (typeof rawSeason === 'string' ? rawSeason : '').trim();
  if (seasonParam && !UUID.test(seasonParam)) redirect('/tournaments');

  const { player } = await getViewer();
  // A signed-out visitor sees the club's tournaments too, and has no grant on
  // any of these tables, so they read through the service role. Every read
  // below is already the member's view (drafts left out by
  // tournamentCalendarQuery, entries only for a player), so nothing widens.
  const supabase = player ? await createServerSupabaseClient() : createServiceRoleClient();
  const todayKey = clubDayKey(new Date().toISOString(), CLUB_TIMEZONE);

  // Members see the season they are playing in. Same rule as the sessions list.
  //
  // The whole list rather than the active row alone, because the picker needs
  // the club's terms and the active season is simply the one in it with the
  // flag set: one round trip, not two. Read as the member where there is one;
  // 00128 left the anon key no grant on `seasons`, so a visitor's read is the
  // service role's, as on the leaderboard.
  const { data: seasonRows } = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date, active_flag, hidden_flag')
    .order('start_date', { ascending: false })
    .limit(40);
  const seasons = (seasonRows ?? []) as HistorySeason[];
  const activeSeason = seasons.find((s) => s.active_flag) ?? null;

  const picked = seasonParam ? seasons.find((s) => s.id === seasonParam) ?? null : null;
  // Three ways an id can be well-formed and still not be an address this page
  // serves, all of them the bare path instead of an empty screen.
  //
  // Not a season at all, so there is nothing to show. HIDDEN (00234), because
  // taking a term out of the picker only removes the link to it while the
  // address stays guessable and sits in the history of anyone who opened it
  // before it was hidden; `=== true` for the same reason finishedSeasonIds uses
  // it. And the ACTIVE season, which has one canonical address: the two
  // branches below filter differently, so serving `?season=<active>` as well
  // would give one term two URLs that list different tournaments.
  if (seasonParam && (!picked || picked.active_flag || picked.hidden_flag === true)) {
    redirect('/tournaments');
  }
  const selectedSeason = picked ?? activeSeason;

  // WHAT IS ON THE CALENDAR NOW, AND WHAT A MEMBER ASKED FOR, ARE DIFFERENT
  // QUESTIONS AND THEY GET DIFFERENT FILTERS. Do not collapse these two.
  //
  // The bare path keeps scopeToActiveSeason exactly as it was, and it is loose
  // on purpose: it also admits rows whose season_id IS NULL, and with no active
  // season it drops the filter entirely (active-season.ts). Both are right for
  // "what is happening now", where an unassigned tournament still belongs on
  // the calendar rather than on no page at all.
  //
  // An explicit ?season= is a question with one answer. A member who asks for a
  // finished term must get that term's tournaments and nothing else: no
  // unassigned rows, and never the whole table if something goes sideways. So
  // it is a strict .eq, on the id of a season already found in the list above
  // rather than on the string from the URL.
  //
  // Built in lib/tournament-index.ts, which also leaves out every draft.
  const scopedCalendar = tournamentCalendarQuery(supabase, {
    pickedId: picked?.id,
    activeId: activeSeason?.id,
  });

  // The club's tournaments, and separately everything the member is in. The
  // member's own entries are deliberately NOT season-scoped, so "Current
  // tournaments" lists every live entry whichever season the picker is on.
  const [tournamentsRes, myEntriesRes, myPairsRes] = await Promise.all([
    scopedCalendar,
    player
      ? supabase
          .from('tournament_participants')
          .select(
            'id, seed_number, status, final_position, ' +
            'event:tournament_events(id, event_type, status, tournament:tournaments(id, name, start_date, status))',
          )
          .eq('player_id', player.id)
          .order('created_at', { ascending: false })
          .limit(ENTRY_FETCH_CAP)
      : Promise.resolve({ data: [] as unknown[] }),
    player
      ? supabase
          .from('tournament_pairs')
          .select(
            'id, seed_number, status, final_position, player1_id, player2_id, ' +
            'player1:players!tournament_pairs_player1_id_fkey(id, full_name, avatar_url), ' +
            'player2:players!tournament_pairs_player2_id_fkey(id, full_name, avatar_url), ' +
            'event:tournament_events(id, event_type, status, tournament:tournaments(id, name, start_date, status))',
          )
          // player.id is players.id — a UUID read from the verified session in
          // getViewer, never a caller-supplied string, so interpolating
          // it into the filter cannot carry anything but a uuid.
          .or(`player1_id.eq.${player.id},player2_id.eq.${player.id}`)
          .order('created_at', { ascending: false })
          .limit(ENTRY_FETCH_CAP)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const calendar = (tournamentsRes.data ?? []) as unknown as IndexTournament[];

  // The registration windows (00276), for the events taking entries. A failed
  // read leaves them unknown, which this page shows as open: registerForEvent
  // reads them again and refuses, so nobody enters through a shut window.
  const registrationIds = calendar.flatMap((t) =>
    (t.tournament_events ?? []).filter((e) => e.status === 'registration').map((e) => e.id),
  );
  const entryWindows = registrationIds.length === 0
    ? null
    : await loadEntryWindows(supabase, {
        eventIds: registrationIds,
        tournamentIds: calendar.map((t) => t.id),
      }).catch((err) => {
        Sentry.captureException(err, { extra: { action: 'tournaments:entryWindows' } });
        return null;
      });
  const now = new Date();

  const tournaments = calendar.map((t) => ({
    ...t,
    tournament_events: (t.tournament_events ?? []).map((e) => {
      if (!entryWindows || e.status !== 'registration') return e;
      const { registration } = windowsFor(entryWindows, e.id, t.id);
      return { ...e, registration_window: windowState(registration.opens_at, registration.closes_at, now) };
    }),
  }));

  // Fold singles rows and pair rows into one shape, because from the member's
  // point of view "an entry" is an entry — the table it lives in is an
  // implementation detail of the format.
  const myEntries: MyEntry[] = [
    ...((myEntriesRes.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      seed_number: (r.seed_number ?? null) as number | null,
      status: r.status as string,
      final_position: (r.final_position ?? null) as number | null,
      event: one<NestedEvent>(r.event),
      partner: null,
      isDoubles: false,
    })),
    ...((myPairsRes.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
      const p1 = one<{ id: string; full_name: string; avatar_url: string | null }>(r.player1);
      const p2 = one<{ id: string; full_name: string; avatar_url: string | null }>(r.player2);
      // Whichever half of the pair is not the viewer. Compared on the id column
      // rather than the embed so a partner whose row failed to embed still
      // resolves to "the other one" instead of silently becoming the viewer.
      const partner = r.player1_id === player?.id ? p2 : p1;
      return {
        id: r.id as string,
        seed_number: (r.seed_number ?? null) as number | null,
        status: r.status as string,
        final_position: (r.final_position ?? null) as number | null,
        event: one<NestedEvent>(r.event),
        partner,
        isDoubles: true,
      };
    }),
  // A member can hold an entry on a draft (00196 allows it), and a draft is
  // unpublished, so its name stays off this page like it does the calendar.
  ].filter((e) => e.event !== null && e.event?.tournament?.status !== 'draft');

  const hero = pickHeroTournament(tournaments);

  // A finished entry is one the bracket has placed. Everything else that is not
  // withdrawn is still live for the member, which is what "Current tournaments"
  // lists.
  const liveEntries = myEntries
    .filter((e) => e.final_position === null && occupiesAPlace(e.status))
    .sort((a, b) => (a.event?.tournament?.start_date ?? '').localeCompare(b.event?.tournament?.start_date ?? ''));

  // One round trip for the hero's headcount. Counting rows here rather than
  // with an embedded aggregate is what lets withdrawn entries be excluded: the
  // same filter the server's own capacity check applies.
  const countedEventIds = (hero?.tournament_events ?? []).map((e) => e.id);

  let entryRows: EntryRow[] = [];
  let pairRows: PairRow[] = [];
  if (countedEventIds.length > 0) {
    const [pRes, prRes] = await Promise.all([
      supabase.from('tournament_participants').select('event_id, player_id, status').in('event_id', countedEventIds),
      supabase.from('tournament_pairs').select('event_id, player1_id, player2_id, status').in('event_id', countedEventIds),
    ]);
    entryRows = (pRes.data ?? []) as unknown as EntryRow[];
    pairRows = (prRes.data ?? []) as unknown as PairRow[];
  }

  // ── The hero card's figures ──────────────────────────────────────────────
  const heroEvents: IndexEvent[] = hero?.tournament_events ?? [];
  const heroEventIds = heroEvents.map((e) => e.id);
  const heroEntered = countEnteredPlayers(
    entryRows.filter((r) => heroEventIds.includes(r.event_id)),
    pairRows.filter((r) => heroEventIds.includes(r.event_id)),
  );
  // Pairs as well as participants: a doubles event's spots are TEAMS, and
  // leaving the formed ones out would advertise a field that is already taken.
  const heroSpots = spotsLeft(
    heroEvents,
    entryRows.filter((r) => heroEventIds.includes(r.event_id)),
    pairRows.filter((r) => heroEventIds.includes(r.event_id)),
  );
  const heroEnterable = soleEnterableEvent(heroEvents);

  // WHAT THIS MEMBER WOULD PAY, not what the tournament's default tier says.
  //
  // This used to read `is_default` and fall back to the cheapest tier. On the
  // live tournament the default is External at $25 while internal members are
  // priced at $15, so the hero quoted an internal member $10 more than the fee
  // their own registration would write — and the /fees screen then disagreed
  // with the page that sent them there.
  //
  // quoteEntryFee is the one derivation every fee surface shares; here it is
  // asked without a ledger row, so it answers from the group the member would
  // enter as: membership_type corrected by this season's club fee (00260), the
  // same group ensureEntryFees prices by. A member who has already entered sees
  // their snapshotted price on /fees, which is the row that actually binds.
  //
  // No price at all when the dues read fails, rather than a guess at a group.
  const heroTiers = (
    (hero as unknown as { tournament_fee_tiers?: PricingTier[] } | null)
      ?.tournament_fee_tiers ?? []
  );
  const heroMembership = hero && player
    ? await loadMyMembershipScreen(supabase, { season_id: hero.season_id ?? null, allowed_memberships: null }, player)
    : null;
  const heroFeeCents = player && !heroMembership
    ? null
    : quoteEntryFee(heroMembership?.screen.effective ?? player?.membership_type, heroTiers).amountCents;
  const heroFee = heroFeeCents === null ? null : `$${(heroFeeCents / 100).toFixed(2).replace(/\.00$/, '')}`;
  const heroIAmIn = hero ? liveEntries.some((e) => e.event?.tournament?.id === hero.id) : false;

  // Everything in the season that is not the hero, so publishing a second
  // tournament cannot make it invisible.
  const otherTournaments = tournaments.filter((t) => t.id !== hero?.id);
  const otherUpcoming = otherTournaments.filter((t) => isUpcoming(t.start_date, todayKey));
  const otherDone = otherTournaments
    .filter((t) => !isUpcoming(t.start_date, todayKey))
    .sort((a, b) => b.start_date.localeCompare(a.start_date));

  return (
    <div data-screen-label="Tournaments" className="wide-page">
      <header className="wide-head ptourn-head">
        <Link href="/feed" className="ptourn-back">← Feed</Link>
        {/* Not PageHeader, which every other season-scoped screen uses: this
            title is 46px display type with the house full stop after it, and
            that component offers neither. .ptourn-head-row restates its
            title-and-actions composition for this markup. */}
        <div className="ptourn-head-row">
          <div>
            <h1 className="ptourn-title">
              Tournaments<span className="ptourn-stop">.</span>
            </h1>
            <p className="ptourn-sub">Draws and the entries you are in.</p>
          </div>
          {/* THE PICKER MOVES THE CALENDAR AND NOTHING ELSE. "Current
              tournaments" below reads the member's own entries unscoped, on
              purpose (see the note above the fan-out), so a season change does
              not touch that panel. The asymmetry is known and is the owner's to
              settle: do not close it by scoping the entry and pair reads here. */}
          <SeasonPick
            options={seasonPickerOptions(seasons, finishedSeasonIds(seasons), picked?.id ?? null)}
            selectedId={selectedSeason?.id ?? null}
            basePath="/tournaments"
          />
        </div>
      </header>

      {/* The river carries what is happening and what the member is in; the rail
          carries the rest of the calendar. Below 1101px .wide-grid is a single
          column and the rail unstacks underneath, which is the phone order the
          screen was designed in: what is open, what you are in, what else is on. */}
      <div className="wide-grid">
        <div className="ptourn-river">
          {/* ── THE OPEN EVENT ─────────────────────────────────────────── */}
          {hero ? (
            <section className="ptourn-open">
              <div className="ptourn-open-top">
                {/* The mockup's "ENTRIES CLOSE FRIDAY" is not built: there is no
                    entry-deadline column anywhere in the schema. What is real is
                    the event status, which is the thing that actually decides
                    whether the server will accept an entry. */}
                <span className="ptourn-eyebrow">Entries open</span>
                {heroSpots !== null && (
                  <Badge variant={heroSpots <= 6 ? 'warning' : 'neutral'}>
                    {heroSpots === 0 ? 'Full' : `${heroSpots} ${heroSpots === 1 ? 'spot' : 'spots'}`}
                  </Badge>
                )}
              </div>

              <h2 className="ptourn-open-name">{hero.name}</h2>

              {/* "EAST GYM" in the mockup is dropped — `tournaments` has no
                  location column; only `sessions` carries one. */}
              <p className="ptourn-open-meta">
                {dayLabel(hero.start_date, todayKey)} · {describeDisciplines(heroEvents)}
              </p>

              <div className="ptourn-cells">
                <div className="ptourn-cell">
                  <div className="ptourn-cell-label">Entry</div>
                  <div className="ptourn-cell-value mono">{heroFee ?? '—'}</div>
                </div>
                <div className="ptourn-cell">
                  <div className="ptourn-cell-label">Entered</div>
                  <div className="ptourn-cell-value mono">{heroEntered}</div>
                </div>
                <div className="ptourn-cell">
                  <div className="ptourn-cell-label">Events</div>
                  <div className="ptourn-cell-value mono">{heroEvents.length}</div>
                </div>
              </div>

              {/* The mockup's third cell is "YOUR SEED", which cannot be shown
                  here: seed_number is written when the draw is generated, and an
                  event taking entries has no draw — the cell would read "—" for
                  every member on every open event forever. The seed is shown in
                  CURRENT TOURNAMENTS instead, which is where it exists.

                  The button navigates rather than entering inline. registerForEvent
                  refuses on five separate grounds (suspension, membership, waiver,
                  status, capacity) and EventRegistrationButton already states each
                  one on the detail page; a second copy of that gate here is how the
                  two drift apart. It is also the only honest label when the
                  tournament runs several events — you pick one there. */}
              <Link href={`/tournaments/${hero.id}`} className="btn btn-primary ptourn-cta press">
                {heroIAmIn
                  ? 'View your entry'
                  : heroEnterable
                    ? `Enter ${TOURNAMENT_EVENT_TYPE_LABELS[heroEnterable.event_type]}${heroFee ? ` · ${heroFee}` : ''}`
                    : 'See events and enter'}
              </Link>
            </section>
          ) : (
            <section className="ptourn-open ptourn-open-empty">
              <span className="ptourn-eyebrow">Nothing open</span>
              <h2 className="ptourn-open-name">No entries being taken</h2>
              <p className="ptourn-open-meta">
                {tournaments.length > 0
                  ? 'Every event on the calendar has closed its entries.'
                  : 'No tournaments have been scheduled yet.'}
              </p>
              <p className="wide-note">
                When the exec opens a draw it appears here, and you can enter from
                the tournament&apos;s own page.
              </p>
            </section>
          )}

          {/* ── CURRENT TOURNAMENTS ─────────────────────────────────────── */}
          <section className="ptourn-sec">
            <div className="ptourn-sec-label">Current tournaments</div>
            {liveEntries.length === 0 ? (
              <p className="wide-note ptourn-empty">
                You are not entered in a tournament right now. Entering a draw
                puts it here with your seed.
              </p>
            ) : (
              liveEntries.map((entry) => (
                <EntryBlock key={`${entry.isDoubles ? 'pair' : 'solo'}-${entry.id}`} entry={entry} todayKey={todayKey} />
              ))
            )}
          </section>
        </div>

        <aside className="wide-rail">
          {/* ── THE REST OF THE CALENDAR ───────────────────────────────── */}
          <section className="card-base">
            {/* "Also on the calendar", NOT "Also this season". The list under
                this heading comes from scopeToActiveSeason, which also admits
                rows whose season_id IS NULL and drops the season filter
                ENTIRELY when no season is active (active-season.ts:39). The
                season claim was therefore false in two real states, and naming
                the active season here would only have made a false claim more
                specific. The claim is dropped rather than sharpened.

                On an explicit ?season= the list IS exactly that season, since
                that branch filters strictly. The heading still says calendar,
                because it has to be true on both paths and the season is named
                in the picker above rather than twice. */}
            <div className="wide-cap">Also on the calendar</div>
            {otherUpcoming.length === 0 && otherDone.length === 0 ? (
              <p className="wide-note">
                {hero
                  ? 'Nothing else on the calendar.'
                  : 'Tournaments will be listed here once they are scheduled.'}
              </p>
            ) : (
              <div className="ptourn-also">
                {[...otherUpcoming, ...otherDone].map((t) => {
                  const upcoming = isUpcoming(t.start_date, todayKey);
                  return (
                    <Link key={t.id} href={`/tournaments/${t.id}`} className="wide-item press">
                      <div className="wide-item-title">{t.name}</div>
                      <div className="wide-item-sub">
                        {/* dayLabel is a weekday and a day with no year — right
                            for something coming up, ambiguous for something that
                            has been and gone in a season that crosses January.
                            A finished tournament is dated by month and year. */}
                        {upcoming ? dayLabel(t.start_date, todayKey) : resultMonth(t.start_date)}
                        {' · '}
                        {describeDisciplines(t.tournament_events)}
                        {upcoming ? '' : ' · DONE'}
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        </aside>
      </div>

      {/* True, and worth saying: apply_tournament_match_rating (00082/00083)
          moves the same singles and doubles ladders every other rated match
          moves, and finalize.ts adds a placement bonus on top. */}
      <p className="ptourn-note">Tournament results count toward your rating</p>
    </div>
  );
}

/** One live entry: what it is, where the member is seeded, and who they are
 *  playing it with. */
function EntryBlock({ entry, todayKey }: { entry: MyEntry; todayKey: string }) {
  const event = entry.event!;
  const tournament = event.tournament;
  const doubles = isDoublesEvent(event.event_type);

  return (
    <Link href={`/tournaments/${tournament?.id ?? ''}/events/${event.id}`} className="ptourn-entry press">
      <div className="ptourn-entry-top">
        <div className="ptourn-entry-head">
          <div className="ptourn-entry-name">{tournament?.name ?? 'Tournament'}</div>
          <div className="ptourn-entry-sub mono">
            {tournament?.start_date ? `${dayLabel(tournament.start_date, todayKey)} · ` : ''}
            {TOURNAMENT_EVENT_TYPE_LABELS[event.event_type].toUpperCase()}
          </div>
        </div>
        {/* A seed exists only once the draw is generated, so before that the
            badge is the member's registration state instead of an empty chip. */}
        {entry.seed_number !== null ? (
          <Badge variant="success">Seed {entry.seed_number}</Badge>
        ) : (
          <Badge variant="neutral">
            {entry.status === 'checked_in' ? 'Checked in' : 'Entered'}
          </Badge>
        )}
      </div>

      {doubles && entry.partner && (
        <div className="ptourn-partner">
          <AvatarChip name={entry.partner.full_name} id={entry.partner.id} src={entry.partner.avatar_url ?? undefined} size="sm" />
          <div className="ptourn-partner-body">
            <div className="ptourn-partner-name">Partner · {entry.partner.full_name}</div>
            {/* The mockup reads "CONFIRMED". There is no partner-confirmation
                state in the schema: tournament_pairs.status is the PAIR's
                progress through the event (registered / checked_in / withdrawn /
                disqualified / no_show), and a pair is created whole by an exec —
                nobody ever accepts an invitation. The real status is shown. */}
            <div className="ptourn-partner-state mono">
              {entry.status === 'checked_in' ? 'CHECKED IN' : entry.status.replace('_', ' ').toUpperCase()}
            </div>
          </div>
        </div>
      )}

      {/* The mockup's "YOUR ROUND 1" strip — a time, an opponent and "CT 3" — is
          not built. tournament_matches has `court` and `scheduled_time` columns,
          and nothing in either app ever writes to them: no admin screen sets a
          court or a start time, so both would render empty on every row in
          production. The opponent alone was not worth a strip that promised a
          schedule the club does not keep; the event's own page draws the
          bracket, which is where the next match genuinely lives. */}
    </Link>
  );
}
