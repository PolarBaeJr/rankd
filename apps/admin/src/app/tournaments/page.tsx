export const dynamic = 'force-dynamic';
import Link from 'next/link';
import {
  scopeToActiveSeason,
  selectInChunks,
  quoteEntryFee,
  loadEntryMemberships,
  type MembershipType,
  type PricingTier,
  clubToday,
} from '@badminton/shared';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import {
  Card,
  Badge,
  AvatarChip,
  EmptyState,
  PageHeader,
  ResponsiveTable,
  TableCard,
  Atomic,
} from '@badminton/ui';
import {
  CreateTournamentForm,
  TournamentRowActions,
  type TournamentData,
  type WaiverTemplateContext,
} from './actions';
import { RowLink } from '@/components/row-link';
import { readTournamentBonusSettingsForDisplay } from '@/lib/platform-settings';
import { EntriesByEvent } from './entries-by-event';
import { PastSeasonNotice, resolveSeasonScope } from '@/components/season-scope';
import { SeasonSelect } from '@/components/season-select';
import {
  capacityOf,
  disciplineLine,
  feeLabel,
  formatDollars,
  formatEventDate,
  STAGE_ACTION,
  STAGE_BADGE,
  STAGE_LABEL,
  tournamentStage,
  type IndexEvent,
  type TournamentStage,
} from '@/lib/tournament-index';

type TournamentRow = {
  id: string;
  name: string;
  status: string;
  start_date: string;
  suspended_at: string | null;
  season_id: string | null;
  [key: string]: unknown;
};

type ParticipantRow = {
  id: string;
  event_id: string;
  player_id: string;
  seed_number: number | null;
  elo_before: number | null;
};

type PairRow = {
  id: string;
  event_id: string;
  // NULL on an external team (00269), which has no member to charge or name.
  player1_id: string | null;
  player2_id: string | null;
  pair_name: string | null;
  seed_number: number | null;
  combined_elo: number | null;
};

/** One line of a card or a row, in the console's micro-label type. */
function Micro({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)] ${className}`}
    >
      {children}
    </span>
  );
}

export default async function TournamentsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season: seasonParam } = await searchParams;

  // WHO IS LOOKING, before a single row is read. The old version of this page
  // opened a service-role client and queried straight away, trusting the
  // middleware to have run — every other console page that renders data now
  // re-asks here, because a fetch that runs for the wrong viewer has already
  // put its rows in the RSC payload by the time any JSX decides not to show
  // them.
  const viewer = await requireCapability('tournaments.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);

  // ONE CAPABILITY PER CONTROL, and one per fetch below. None of these is a
  // level or a blanket "is an officer" flag: the club can hand somebody the
  // draw without the money, or the money without the draw, and this page has to
  // be able to render either of those people.
  const canCreate = may('tournaments.manage.create.write');
  const canEdit = may('tournaments.manage.update.write');
  const canArchive = may('tournaments.manage.archive.write');
  const canDelete = may('tournaments.manage.delete.write');
  // ENTRY MONEY IS ITS OWN QUESTION and it is not a tournament question. Entry
  // fees live at /tournaments/<id>/fees behind `tournaments.fees.read`, which
  // is deliberately absent from the exec baseline — an exec runs tournaments
  // and does not see what anyone owes for them. Everything money-shaped on this
  // index (the fees-due stat, the per-row fee, the paid/unpaid split) is that
  // same data summarised, so it answers to that same capability and, crucially,
  // its QUERIES are skipped rather than its markup hidden.
  const canSeeFees = may('tournaments.fees.read');

  const supabase = createAdminClient();

  // This season's tournaments only — see scopeToActiveSeason for why an
  // unassigned tournament is kept and why no active season means no filter.
  const { data: allSeasons } = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date, active_flag')
    .order('start_date', { ascending: false });
  const { seasons: seasonList, selected: scopedSeason, isPast } = resolveSeasonScope(
    allSeasons,
    seasonParam,
  );

  const { data: tournamentRows } = await scopeToActiveSeason(
    supabase.from('tournaments').select('*'),
    scopedSeason?.id,
  ).order('start_date', { ascending: false });
  const tournaments = (tournamentRows ?? []) as TournamentRow[];
  const tournamentIds = tournaments.map((t) => t.id);

  // The events carry everything the parent row cannot say: which disciplines
  // run, how far along the draw is, and the only capacity figure in the schema.
  const { data: eventRows } = tournamentIds.length
    ? await supabase
        .from('tournament_events')
        .select('id, tournament_id, event_type, status, draw_locked, max_participants')
        .in('tournament_id', tournamentIds)
    : { data: [] };
  const events = (eventRows ?? []) as IndexEvent[];
  const eventsByTournament = new Map<string, IndexEvent[]>();
  for (const e of events) {
    const list = eventsByTournament.get(e.tournament_id) ?? [];
    list.push(e);
    eventsByTournament.set(e.tournament_id, list);
  }
  const eventIds = events.map((e) => e.id);
  const tournamentOfEvent = new Map(events.map((e) => [e.id, e.tournament_id]));

  // THE FIELD. A doubles entry is a pair row and a singles entry is a
  // participant row, and one pair is ONE entry — that is the unit
  // max_participants is compared against when a registration is refused, so it
  // has to be the unit counted here too or the count and the cap disagree.
  // Withdrawn entries are out of both, exactly as the fee roster has them.
  const [{ data: participantData }, { data: pairData }] = eventIds.length
    ? await Promise.all([
        supabase
          .from('tournament_participants')
          .select('id, event_id, player_id, seed_number, elo_before')
          .in('event_id', eventIds)
          .neq('status', 'withdrawn'),
        supabase
          .from('tournament_pairs')
          .select('id, event_id, player1_id, player2_id, pair_name, seed_number, combined_elo')
          .in('event_id', eventIds)
          .neq('status', 'withdrawn'),
      ])
    : [{ data: [] }, { data: [] }];
  const participants = (participantData ?? []) as ParticipantRow[];
  const pairs = (pairData ?? []) as PairRow[];

  const entriesByTournament = new Map<string, number>();
  for (const row of [...participants, ...pairs]) {
    const tid = tournamentOfEvent.get(row.event_id);
    if (!tid) continue;
    entriesByTournament.set(tid, (entriesByTournament.get(tid) ?? 0) + 1);
  }

  const stageOf = new Map<string, TournamentStage>(
    tournaments.map((t) => [t.id, tournamentStage(t, eventsByTournament.get(t.id) ?? [])]),
  );

  // THE OPEN TOURNAMENT — the one the right-hand column is about. "Open for
  // entry" is a derived stage, not a column, so this is the same fold the badge
  // uses. The soonest one wins when more than one is open; the rest are counted
  // rather than hidden, because a strip that says 2 beside a card that shows 1
  // reads as a bug.
  //
  // THE NEXT ONE, not the oldest one. Nothing in the schema forces an event out
  // of `registration`, so a tournament played six weeks ago whose events were
  // never moved on stays "open for entry" forever — and a plain ascending sort
  // would hand that stale row the card ahead of the one actually coming up. So:
  // upcoming first, soonest at the top; anything already past falls behind them,
  // most recent first.
  // clubToday, not toISOString(): this runs on the server, the container has
  // TZ unset, and from 17:00 Pacific onwards the UTC date is already tomorrow
  // — which flips a tournament starting today from 'upcoming' to 'past' on the
  // evening before it starts, and demotes it off the featured card.
  const today = clubToday();
  const openTournaments = tournaments
    .filter((t) => stageOf.get(t.id) === 'entries-open')
    .sort((a, b) => {
      const aUpcoming = a.start_date >= today;
      const bUpcoming = b.start_date >= today;
      if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
      return aUpcoming
        ? a.start_date.localeCompare(b.start_date)
        : b.start_date.localeCompare(a.start_date);
    });
  const featured = openTournaments[0] ?? null;
  const featuredEvents = featured ? eventsByTournament.get(featured.id) ?? [] : [];
  const featuredEventIds = new Set(featuredEvents.map((e) => e.id));

  // ---- ENTRY MONEY. Both reads are inside the capability, not beside it. ----
  const feeTiersByTournament = new Map<string, PricingTier[]>();
  // Null when the dues read behind the pricing failed: no figure beats a wrong one.
  let feesDueCents: number | null = 0;
  let featuredPaid = 0;
  let featuredUnpaid = 0;
  if (canSeeFees && tournamentIds.length) {
    const [{ data: tierData }, { data: feeData }] = await Promise.all([
      supabase
        .from('tournament_fee_tiers')
        // EVERY COLUMN selectFeeTier reads, not just the amount. applies_to is
        // what makes a tier membership-aware and sort_order is how ties are
        // broken; selecting only amount_cents forced this page to fall back to
        // the default tier for everybody, which on the live tournament is
        // External at $25 while internal members are priced at $15.
        .select('tournament_id, id, name, amount_cents, is_default, sort_order, applies_to')
        .in('tournament_id', tournamentIds),
      // Entry fees off the one ledger (00094). fee_type is required, not
      // tidiness: club_fees also holds dues and reinstatements, and neither
      // has a tournament_id — so an unfiltered read would pull every fee in
      // the club and only the .in() would hold it back.
      supabase
        .from('club_fees')
        .select('tournament_id, player_id, amount_cents, paid_at')
        .eq('fee_type', 'tournament')
        .in('tournament_id', tournamentIds),
    ]);
    const tiers = (tierData ?? []) as (PricingTier & { tournament_id: string })[];
    for (const tier of tiers) {
      const list = feeTiersByTournament.get(tier.tournament_id) ?? [];
      list.push(tier);
      feeTiersByTournament.set(tier.tournament_id, list);
    }
    type FeeRow = {
      tournament_id: string;
      player_id: string | null;
      amount_cents: number | null;
      paid_at: string | null;
    };
    // A non-member a Google Form entered (00283) owes a NAMED row with no
    // player_id. Everything below is per member, so those rows are counted on
    // their own after the loop rather than looked up as a null player.
    const ledger = (feeData ?? []) as FeeRow[];
    const fees = ledger.filter((f): f is FeeRow & { player_id: string } => f.player_id != null);
    const nonMemberFees = ledger.filter((f) => f.player_id == null);
    const feeByKey = new Map(fees.map((f) => [`${f.tournament_id}:${f.player_id}`, f]));

    // Who actually owes. THE SAME TWO EXEMPTIONS the fee roster applies
    // (`is_exec`, `fee_exempt`) — a headline that counted the exec who ran the
    // draw as an unpaid entrant would contradict the page it links to.
    const entrantIds = new Set<string>();
    for (const p of participants) entrantIds.add(p.player_id);
    for (const p of pairs) {
      if (p.player1_id) entrantIds.add(p.player1_id);
      if (p.player2_id) entrantIds.add(p.player2_id);
    }
    // Fee-row holders are asked about too, not only live entrants — otherwise
    // a withdrawn member would never appear in `liable` and the loop below
    // would drop their outstanding fee on the "not liable" branch.
    for (const fee of fees) entrantIds.add(fee.player_id);
    // Chunked: this is every entrant across EVERY tournament in the season, so
    // it grows without bound and `.in()` is a query-string filter.
    const { data: payerData } = await selectInChunks<{
      id: string;
      is_exec: boolean;
      fee_exempt: boolean;
      membership_type: string | null;
    }>(Array.from(entrantIds), (ids) =>
      supabase.from('players').select('id, is_exec, fee_exempt, membership_type').in('id', ids) as never,
    );
    const payers = (payerData ?? []) as {
      id: string; is_exec: boolean; fee_exempt: boolean; membership_type: string | null;
    }[];
    const liable = new Set(
      payers.filter((p) => !p.is_exec && !p.fee_exempt).map((p) => p.id),
    );
    // membership_type is what prices a member who has no fee row yet. Read for
    // every entrant, not only the liable ones, because the quote below is keyed
    // by player id and a missing entry would silently quote the default tier —
    // the exact fallback this change exists to remove.
    //
    // AND CORRECTED BY THIS SEASON'S CLUB FEE (00260): an entry is priced by the
    // group the member enters as, so the quote is too. Per tournament season,
    // because that is the season ensureEntryFees looks the dues up in.
    const tournamentSeason = new Map(tournaments.map((t) => [t.id, t.season_id ?? null]));
    const groupsBySeason = new Map<string | null, Map<string, MembershipType>>();
    let groupsFailed = false;
    for (const key of new Set(tournamentSeason.values())) {
      const groups = await loadEntryMemberships(supabase, key, payers);
      if (!groups) {
        groupsFailed = true;
        break;
      }
      groupsBySeason.set(key, groups);
    }

    // Per tournament, the distinct liable players entered in any of its events.
    const payersByTournament = new Map<string, Set<string>>();
    const addPayer = (eventId: string, playerId: string) => {
      const tid = tournamentOfEvent.get(eventId);
      if (!tid || !liable.has(playerId)) return;
      const set = payersByTournament.get(tid) ?? new Set<string>();
      set.add(playerId);
      payersByTournament.set(tid, set);
    };
    for (const p of participants) addPayer(p.event_id, p.player_id);
    for (const p of pairs) {
      if (p.player1_id) addPayer(p.event_id, p.player1_id);
      if (p.player2_id) addPayer(p.event_id, p.player2_id);
    }

    // AND EVERYONE WITH A FEE ROW, entered or not. participants/pairs above
    // exclude withdrawn entries, and a withdrawal does not cancel the fee — the
    // member's own /fees screen reads the ledger and still shows it. Counting
    // only live entrants would make this headline quietly smaller than the money
    // the club is actually owed, and smaller than the tournament's own fee page.
    // Not routed through addPayer: that keys off an event id, and a fee row
    // names the tournament directly.
    for (const fee of fees) {
      if (!liable.has(fee.player_id)) continue;
      const set = payersByTournament.get(fee.tournament_id) ?? new Set<string>();
      set.add(fee.player_id);
      payersByTournament.set(fee.tournament_id, set);
    }

    if (groupsFailed) feesDueCents = null;
    for (const [tid, tournamentPayers] of payersByTournament) {
      const tournamentTiers = feeTiersByTournament.get(tid) ?? [];
      for (const playerId of tournamentPayers) {
        const fee = feeByKey.get(`${tid}:${playerId}`);
        // ONE DERIVATION, the same one the tournament's own fee page and the
        // Mark Paid dialog use. The ledger row outranks the tier list (an entry
        // price is snapshotted at registration and must not be re-derived on
        // read); failing a row, selectFeeTier prices the member by their
        // membership_type. This used to read the tournament's is_default tier
        // for everybody, so this headline over-stated what internal members owe
        // by the internal/external spread — $10 a head on the live tournament.
        //
        // A null amount means nobody has said this tournament costs anything.
        // That is not a debt of $0, it is an absence, and it contributes
        // nothing either way.
        const group = groupsBySeason.get(tournamentSeason.get(tid) ?? null)?.get(playerId);
        const owed = quoteEntryFee(group, tournamentTiers, fee).amountCents;
        const paid = Boolean(fee?.paid_at);
        if (featured && tid === featured.id) {
          if (paid) featuredPaid += 1;
          else featuredUnpaid += 1;
        }
        if (!paid && owed != null && feesDueCents !== null) feesDueCents += owed;
      }
    }
    // Non-members: the ledger row is the whole story, there is no tier to quote.
    for (const fee of nonMemberFees) {
      const paid = Boolean(fee.paid_at);
      if (featured && fee.tournament_id === featured.id) {
        if (paid) featuredPaid += 1;
        else featuredUnpaid += 1;
      }
      if (!paid && fee.amount_cents != null && feesDueCents !== null) feesDueCents += fee.amount_cents;
    }
  }

  // ---- TOP SEEDS for the open tournament ----------------------------------
  // Names only for the field that is actually rendered.
  type Entrant = { key: string; name: string; avatarId: string; seed: number | null; rating: number | null };
  let topEntrants: Entrant[] = [];
  let anySeeded = false;
  if (featured && featuredEventIds.size) {
    const featuredParticipants = participants.filter((p) => featuredEventIds.has(p.event_id));
    const featuredPairs = pairs.filter((p) => featuredEventIds.has(p.event_id));
    const nameIds = new Set<string>();
    for (const p of featuredParticipants) nameIds.add(p.player_id);
    for (const p of featuredPairs) {
      if (p.player1_id) nameIds.add(p.player1_id);
      if (p.player2_id) nameIds.add(p.player2_id);
    }
    // Chunked — a full 128-entrant draw plus doubles pairs is already past a
    // third of the request-line budget on its own.
    const { data: playerData } = await selectInChunks<{
      id: string;
      full_name: string;
      avatar_url: string | null;
    }>(Array.from(nameIds), (ids) =>
      supabase.from('players').select('id, full_name, avatar_url').in('id', ids) as never,
    );
    const players = new Map(
      ((playerData ?? []) as { id: string; full_name: string; avatar_url: string | null }[]).map(
        (p) => [p.id, p],
      ),
    );

    const all: Entrant[] = [
      ...featuredParticipants.map((p) => ({
        key: p.id,
        name: players.get(p.player_id)?.full_name ?? 'Unknown player',
        avatarId: p.player_id,
        seed: p.seed_number,
        rating: p.elo_before,
      })),
      ...featuredPairs.map((p) => ({
        key: p.id,
        name:
          p.pair_name ??
          `${players.get(p.player1_id ?? '')?.full_name ?? '?'} / ${players.get(p.player2_id ?? '')?.full_name ?? '?'}`,
        avatarId: p.player1_id ?? p.id,
        seed: p.seed_number,
        rating: p.combined_elo,
      })),
    ];
    anySeeded = all.some((e) => e.seed != null);
    // SEEDS ONLY EXIST ONCE SOMEBODY MAKES THEM. `seed_number` is written by the
    // seeding actions and by bracket generation's auto-seed, so before the draw
    // every entrant's seed is null. Rather than show four blanks, the list falls
    // back to the rating each entrant was entered with — which is precisely the
    // order the auto-seed would produce — and the card says which of the two it
    // is showing.
    all.sort((a, b) => {
      if (a.seed != null && b.seed != null) return a.seed - b.seed;
      if (a.seed != null) return -1;
      if (b.seed != null) return 1;
      return (b.rating ?? 0) - (a.rating ?? 0);
    });
    topEntrants = all.slice(0, 4);
  }

  // The waiver-template read exists only to pre-fill the create/edit dialog, so
  // it runs only for somebody who can open one. The ACTIVE season's template
  // deliberately, not the browsed one: createTournament files a new tournament
  // under the season the club is currently playing, so browsing a past term
  // must not change what a new tournament would get.
  let waiverTemplateContext: WaiverTemplateContext = { templates: [], activeSeasonId: null };
  if (canCreate || canEdit) {
    const { data: waiverTemplates } = await supabase
      .from('event_waiver_templates')
      .select('season_id, content');
    waiverTemplateContext = {
      templates: (waiverTemplates ?? []) as { season_id: string; content: string }[],
      activeSeasonId: seasonList.find((s) => s.active_flag)?.id ?? null,
    };
  }

  // The club's bonus amounts, shown behind each blank box of the edit dialog's
  // per-tournament amounts (00275). Only for somebody who can open it; null on
  // a failed read, and the boxes then show no placeholder.
  const clubBonusSettings = canEdit ? await readTournamentBonusSettingsForDisplay(supabase) : null;

  // ---- The four stat cells -------------------------------------------------
  const openCount = openTournaments.length;
  const entriesIn = [...entriesByTournament.values()].reduce((a, b) => a + b, 0);
  // SEASON, not calendar year. The mockup said "run this year", but this page
  // is scoped by the season selector directly above the strip — a year count
  // beside a season filter would disagree with every other number on the page.
  const runThisSeason = tournaments.filter((t) => {
    const stage = stageOf.get(t.id);
    return stage === 'finished' || stage === 'archived';
  }).length;

  const featuredEntries = featured ? entriesByTournament.get(featured.id) ?? 0 : 0;
  const featuredCapacity = capacityOf(featuredEvents);

  const eyebrow = `EVENTS · ${(scopedSeason?.name ?? 'ALL SEASONS').toUpperCase()}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={eyebrow}
        title="Tournaments"
        sub="Entries, seeding and the draw on the day."
        watermark="T"
        actions={canCreate ? <CreateTournamentForm waiverTemplates={waiverTemplateContext} /> : undefined}
      />

      <div className="space-y-2">
        <SeasonSelect seasons={seasonList} selected={scopedSeason} basePath="/tournaments" />
        {isPast && scopedSeason && <PastSeasonNotice season={scopedSeason} />}
      </div>

      {/* Stat strip — bare pairs, hairline above, below and between. Each cell
          is a link to the thing it counts. */}
      <div className="stat-strip">
        <Link href="#entries" className="block no-underline">
          <StatCell label="Open for entry" value={String(openCount)} />
        </Link>
        <Link href="#all-events" className="block no-underline">
          <StatCell label="Entries in" value={String(entriesIn)} />
        </Link>
        {canSeeFees ? (
          <Link
            href={featured ? `/tournaments/${featured.id}/fees` : '#all-events'}
            className="block no-underline"
          >
            <StatCell
              label="Entry fees due"
              value={feesDueCents === null ? '-' : <Atomic>{formatDollars(feesDueCents)}</Atomic>}
              money
              tone="var(--color-warning)"
            />
          </Link>
        ) : (
          // Withheld, not empty: a fourth cell that simply vanished would leave
          // a viewer counting three and wondering what broke.
          <div>
            <StatCell label="Entry fees due" value="—" />
            <Micro className="mt-1 block">Not shown to you</Micro>
          </div>
        )}
        <Link href="#all-events" className="block no-underline">
          <StatCell label="Run this season" value={String(runThisSeason)} />
        </Link>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[2fr_1fr]">
        {/* ---------------- LEFT: every tournament in the season ------------ */}
        <Card padding={false} className="overflow-hidden">
          <div
            id="all-events"
            className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4"
          >
            <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-primary)]">
              All events
            </h2>
            <Micro>Newest first</Micro>
          </div>

          {tournaments.length === 0 ? (
            <EmptyState
              title="No tournaments this season"
              description={
                canCreate
                  ? 'Create one and it will be filed under the active season.'
                  : 'Nothing has been scheduled for the season you are browsing.'
              }
            />
          ) : (
            <ResponsiveTable
              cards={tournaments.map((t) => {
                const evts = eventsByTournament.get(t.id) ?? [];
                const stage = stageOf.get(t.id)!;
                const entries = entriesByTournament.get(t.id) ?? 0;
                const capacity = capacityOf(evts);
                const fee = canSeeFees ? feeLabel(feeTiersByTournament.get(t.id) ?? []) : null;
                return (
                  <TableCard
                    key={t.id}
                    title={
                      <Link href={`/tournaments/${t.id}`} className="no-underline text-[var(--text-primary)]">
                        {t.name}
                      </Link>
                    }
                    value={
                      <Atomic>{capacity != null ? `${entries}/${capacity}` : String(entries)}</Atomic>
                    }
                    badges={
                      <Badge variant={STAGE_BADGE[stage]}>
                        <span className="sr-only">Status: </span>
                        {STAGE_LABEL[stage]}
                      </Badge>
                    }
                    fields={[
                      { label: 'Date', value: <Atomic>{formatEventDate(t.start_date)}</Atomic> },
                      { label: 'Events', value: disciplineLine(evts) || 'None yet' },
                      ...(fee ? [{ label: 'Entry fee', value: <Atomic>{fee}</Atomic> }] : []),
                    ]}
                    actions={
                      <>
                        <ActionLink href={`/tournaments/${t.id}`}>{STAGE_ACTION[stage]}</ActionLink>
                        <TournamentRowActions
                          tournament={t as unknown as TournamentData}
                          waiverTemplates={waiverTemplateContext}
                          clubBonusSettings={clubBonusSettings}
                          canEdit={canEdit}
                          canArchive={canArchive}
                          canDelete={canDelete}
                        />
                      </>
                    }
                  />
                );
              })}
            >
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <Th>Event</Th>
                    <Th>Status</Th>
                    <Th>Date</Th>
                    <Th align="right">Entries</Th>
                    <Th align="right">Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {tournaments.map((t) => {
                    const evts = eventsByTournament.get(t.id) ?? [];
                    const stage = stageOf.get(t.id)!;
                    const entries = entriesByTournament.get(t.id) ?? 0;
                    const capacity = capacityOf(evts);
                    const fee = canSeeFees ? feeLabel(feeTiersByTournament.get(t.id) ?? []) : null;
                    const disciplines = disciplineLine(evts);
                    return (
                      <RowLink
                        key={t.id}
                        href={`/tournaments/${t.id}`}
                        className="cursor-pointer border-t border-[var(--border)] transition-colors first:border-t-0 hover:bg-[var(--bg-elevated)]"
                      >
                        <td className="px-5 py-3.5 align-middle">
                          <Link
                            href={`/tournaments/${t.id}`}
                            className="block text-sm text-[var(--text-primary)] no-underline hover:text-[var(--color-accent)]"
                          >
                            {t.name}
                          </Link>
                          <Micro className="mt-0.5 block">
                            {[disciplines || 'NO EVENTS YET', fee].filter(Boolean).join(' · ')}
                          </Micro>
                        </td>
                        <td className="px-5 py-3.5 align-middle">
                          <Badge variant={STAGE_BADGE[stage]}>
                            <span className="sr-only">Status: </span>
                            {STAGE_LABEL[stage]}
                          </Badge>
                        </td>
                        <td className="px-5 py-3.5 align-middle font-mono text-xs text-[var(--text-secondary)]">
                          <Atomic>{formatEventDate(t.start_date)}</Atomic>
                        </td>
                        <td className="px-5 py-3.5 text-right align-middle font-mono text-sm text-[var(--text-primary)]">
                          <Atomic>
                            {capacity != null ? `${entries}/${capacity}` : String(entries)}
                          </Atomic>
                        </td>
                        <td className="px-5 py-3.5 align-middle">
                          <div className="flex items-center justify-end gap-2">
                            <TournamentRowActions
                              tournament={t as unknown as TournamentData}
                              waiverTemplates={waiverTemplateContext}
                              clubBonusSettings={clubBonusSettings}
                              canEdit={canEdit}
                              canArchive={canArchive}
                              canDelete={canDelete}
                            />
                            <ActionLink href={`/tournaments/${t.id}`}>{STAGE_ACTION[stage]}</ActionLink>
                          </div>
                        </td>
                      </RowLink>
                    );
                  })}
                </tbody>
              </table>
            </ResponsiveTable>
          )}

          {/* Seeding note. The mockup's version claimed the rating is taken when
              the draw is set; it is not. `elo_before` is stamped on the
              participant row at registration (tournament-actions/participants.ts)
              and `combined_elo` on the pair when it is formed, and both the
              auto-seed and the manual "seed by rating" action sort by those
              stored values — so a rating that moves between entry and draw day
              does not move the seeding. The other half is the pool case, where
              the field and its order come from the pool standings instead. */}
          <div className="border-t border-[var(--border)] px-5 py-3">
            <Micro>
              Seeding uses each entrant&rsquo;s rating as recorded when they entered · a pool-fed
              event seeds from the pool standings instead
            </Micro>
          </div>
        </Card>

        {/* ---------------- RIGHT: the open tournament ---------------------- */}
        <div className="flex flex-col gap-5">
          <Card>
            <span id="entries" className="block scroll-mt-24" />
            <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-primary)]">
              {featured ? `${featured.name} · Entries` : 'Entries'}
            </h2>

            {!featured ? (
              <EmptyState
                title="Nothing is open for entry"
                description="A tournament appears here once one of its events is taking registrations."
              />
            ) : (
              <>
                <div className="mt-4 flex items-baseline gap-3">
                  <span className="font-mono text-[40px] font-bold leading-none tracking-[-0.03em] text-[var(--text-primary)]">
                    {featuredEntries}
                  </span>
                  <Micro>
                    {[
                      featuredCapacity != null ? `of ${featuredCapacity}` : null,
                      `starts ${formatEventDate(featured.start_date)}`,
                      openTournaments.length > 1 ? `+${openTournaments.length - 1} more open` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Micro>
                </div>

                {/* The bar needs a denominator to mean anything, and a
                    denominator only exists when every event of this tournament
                    carries a max_participants. Uncapped events get the count
                    and nothing else — an invented 100% bar would be a claim the
                    schema cannot make. */}
                {featuredCapacity != null && featuredCapacity > 0 && (
                  <>
                    <div className="mt-4 flex h-2.5 w-full overflow-hidden bg-[var(--bg-elevated)]">
                      <div
                        className="h-full bg-[var(--color-accent)]"
                        style={{
                          width: `${Math.min(100, (featuredEntries / featuredCapacity) * 100)}%`,
                        }}
                      />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between">
                      <Micro>Entered</Micro>
                      <Micro>Open</Micro>
                    </div>
                  </>
                )}

                {/* THE SAME NUMBER, BROKEN UP. The headline is the tournament's
                    whole field; this is which of its events that field is
                    actually in, which is the difference between "9 of 24" and
                    "the doubles has nobody in it". Same rows, same capability,
                    no extra query — see ./entries-by-event.tsx. */}
                <div className="mt-4 border-t border-[var(--border)] pt-4">
                  <Micro className="mb-3 block">Entries by event</Micro>
                  <EntriesByEvent
                    events={featuredEvents}
                    participants={participants}
                    pairs={pairs}
                  />
                </div>

                <div className="mt-4 border-t border-[var(--border)] pt-4">
                  {canSeeFees ? (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Micro className="block">Paid</Micro>
                        <p className="mt-1 font-mono text-base text-[var(--text-primary)]">
                          <Atomic>{String(featuredPaid)}</Atomic>
                        </p>
                      </div>
                      <div>
                        <Micro className="block">Unpaid</Micro>
                        <p className="mt-1 font-mono text-base text-[var(--color-warning)]">
                          <Atomic>{String(featuredUnpaid)}</Atomic>
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--text-muted)]">
                      Entry fees are not shown to you.
                    </p>
                  )}
                  {/* THESE TWO DO NOT ADD UP TO THE COUNT ABOVE, and the label
                      has to say so. The headline is entries — a person in both
                      the singles and the doubles is two of them — while paid and
                      unpaid are PEOPLE, minus the two exemptions the fee roster
                      applies (is_exec, fee_exempt). Both figures are right; read
                      as a breakdown of one another they would look broken. */}
                  {canSeeFees && (
                    <Micro className="mt-3 block">
                      Members who owe an entry fee · officers and exempt members excluded
                    </Micro>
                  )}
                </div>
              </>
            )}
          </Card>

          {featured && (
            <Card>
              <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-primary)]">
                {anySeeded ? 'Top seeds' : 'Leading entrants'}
              </h2>
              {topEntrants.length === 0 ? (
                <EmptyState title="No entrants yet" description="Nobody has been added to this tournament." />
              ) : (
                <>
                  <ul className="mt-3 flex flex-col gap-3">
                    {topEntrants.map((e, i) => (
                      <li key={e.key} className="flex items-center gap-3">
                        {/* No medal tones: --gold/--silver/--bronze do not exist
                            in this app's tokens and the guidelines forbid new
                            colour values, so every rank is muted. */}
                        <span className="w-[22px] shrink-0 text-center font-mono text-xs text-[var(--text-muted)]">
                          {e.seed ?? i + 1}
                        </span>
                        <AvatarChip name={e.name} id={e.avatarId} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                          {e.name}
                        </span>
                        <span className="shrink-0 font-mono text-[13px] text-[var(--text-secondary)]">
                          <Atomic>{e.rating != null ? String(e.rating) : '—'}</Atomic>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4 border-t border-[var(--border)] pt-3">
                    <Micro>
                      {anySeeded
                        ? 'Rating as recorded when the entrant was added'
                        : 'Seeds are set when the draw is generated · ordered by rating at entry'}
                    </Micro>
                  </div>
                </>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/** A stat-strip cell. Mono throughout: every one of these is a compared number. */
function StatCell({
  label,
  value,
  money,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  money?: boolean;
  tone?: string;
}) {
  return (
    <>
      <span
        className="stat-label block"
        style={{ fontSize: 9, letterSpacing: '0.16em' }}
      >
        {label}
      </span>
      <span
        className={`stat-value block${money ? ' is-money' : ''}`}
        style={{ fontFamily: 'var(--mono)', fontSize: 32, color: tone }}
      >
        {value}
      </span>
    </>
  );
}

/**
 * The row's navigation control, styled as a secondary button.
 *
 * A <Button> inside a <Link> is an interactive element inside an anchor, which
 * is invalid and gives screen readers two overlapping controls. This is one
 * anchor wearing the button's classes, at the 44px the row-action slot requires.
 */
function ActionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-[44px] items-center justify-center gap-2 whitespace-nowrap rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--ink)] no-underline transition-all duration-150 hover:bg-[var(--line)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--red)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
    >
      {children}
    </Link>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`px-5 py-2.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)] ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}
