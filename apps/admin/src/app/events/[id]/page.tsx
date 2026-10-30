export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  CLUB_EVENT_KIND_LABELS,
  formatClubEventCost,
  formatClubEventTime,
  isUuid,
  readFeatureFlags,
  utcToClubWallClock,
  type ClubEventKind,
} from '@badminton/shared';
import { Badge, Card, DetailList, DetailRow, EditableSection, PageHeader, type PlayerOption } from '@badminton/ui';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { ClubEventControls, ClubEventForm, type ClubEventFormValues } from '../event-form';
import { ClubEventSignupsTable, type ClubEventSignupRow } from '../signups-table';
import { AddPersonButton } from '../add-person';
import { loadManagedForm, loadRegistrationImports } from '@/lib/registration-imports';
import { readerStatus } from '@/lib/google-forms';
import { FormImportCard } from '@/components/registration-import/FormImportCard';
import { ManagedFormPanel } from '@/components/registration-import/ManagedFormPanel';
import { ClubEventTournamentCard } from '../tournament-link';
import { LiveEvent } from '../live-event';
import type { CheckInRow } from '@/components/checkin-list';

type EventRow = {
  id: string;
  title: string;
  kind: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  capacity: number | null;
  cost_cents: number | null;
  signup_opens_at: string | null;
  signup_closes_at: string | null;
  status: string;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  tournament_event_id: string | null;
};

type SignupRow = {
  player_id: string;
  created_at: string;
  checked_in_at?: string | null;
  players:
    | { full_name: string | null; is_guest?: boolean | null }
    | { full_name: string | null; is_guest?: boolean | null }[]
    | null;
};

export default async function ClubEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireCapability('events.page');
  if (!isUuid(id)) notFound();
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);
  const canEdit = may('events.manage.update.write');
  const canCancel = may('events.manage.cancel.write');
  const canDelete = may('events.manage.delete.write');
  // A FETCH gate, not a render one: without the read the names never leave the
  // database, rather than being hidden in markup that still carries them.
  const canSeeSignups = may('events.signups.read');
  const canRemoveSignup = may('events.signups.remove.write');
  const canCheckIn = may('events.signups.checkin.write');

  const adminClient = createAdminClient();
  const { data: eventData } = await adminClient
    .from('club_events')
    .select(
      'id, title, kind, description, location, starts_at, ends_at, capacity, cost_cents, signup_opens_at, signup_closes_at, status, cancelled_at, cancelled_reason, tournament_event_id',
    )
    .eq('id', id)
    .maybeSingle();
  const event = eventData as EventRow | null;
  if (!event) notFound();

  // Non-members a Google Form signed up (00284) take places too, and their rows
  // RESTRICT the event's delete, so Delete must not be offered while any exist.
  // Before 00284 the table is missing and the count is simply members.
  const [{ count: takenCount }, { count: externalCount, error: externalError }] = await Promise.all([
    adminClient.from('club_event_signups').select('player_id', { count: 'exact', head: true }).eq('event_id', id),
    adminClient.from('club_event_external_signups').select('id', { count: 'exact', head: true }).eq('event_id', id),
  ]);
  const externals = externalError ? 0 : (externalCount ?? 0);
  const taken = (takenCount ?? 0) + externals;

  // The form card names non-members by their typed email, so it is read behind
  // the same gate as the signups list, and not read at all without it.
  const formImports = canSeeSignups
    ? await loadRegistrationImports(adminClient, 'club_event', id, {
        guestWaiversOn: (await readFeatureFlags(adminClient)).guest_waivers === true,
      })
    : null;
  // The Form the console made for this event (00296), behind the same gate.
  const managedForm = formImports ? await loadManagedForm(adminClient, 'club_event', id) : null;
  const boundByHand = (formImports?.bindings ?? []).some((b) => b.id !== managedForm?.row?.bindingId);

  // The service-role client, so the players embed is not narrowed by the
  // column grants members are held to.
  //
  // checked_in_at is 00293's. Before it is applied the read with it fails, and
  // a failed PostgREST read arrives as an empty list, which at the door would
  // say nobody signed up. So a failure retries without it and the check-in
  // card says the migration is missing instead.
  const readSignups = (columns: string) =>
    adminClient
      .from('club_event_signups')
      .select(columns)
      .eq('event_id', id)
      .order('created_at', { ascending: true });
  let checkInReady = true;
  let { data: signupData, error: signupError } = canSeeSignups
    ? await readSignups('player_id, created_at, checked_in_at, players(full_name, is_guest)')
    : { data: null, error: null };
  if (signupError) {
    checkInReady = false;
    ({ data: signupData } = await readSignups('player_id, created_at, players(full_name, is_guest)'));
  }
  const signupRows = (signupData ?? []) as unknown as SignupRow[];
  const signups = signupRows.map((row) => {
    const player = Array.isArray(row.players) ? row.players[0] : row.players;
    return {
      player_id: row.player_id,
      created_at: row.created_at,
      name: player?.full_name ?? 'A member',
      guest: player?.is_guest === true,
    };
  });

  // The Form's non-members (00284) and the door's walk-ins (00294) join the
  // members in one list. A guest's waiver and fee come from the Form entry
  // that put them here, which the Form card has already read.
  const { data: guestData } =
    canSeeSignups && externals > 0
      ? await adminClient
          .from('club_event_external_signups')
          .select('id, full_name, email, import_entry_id, created_at, walk_in')
          .eq('event_id', id)
          .order('created_at', { ascending: true })
      : { data: [] };
  // The preferred partner each Form answer named (00299), read on its own so
  // a database without the column shows no notes rather than no list.
  const [{ data: memberNotes }, { data: guestNotes }] = canSeeSignups
    ? await Promise.all([
        adminClient
          .from('club_event_signups')
          .select('player_id, preferred_partner')
          .eq('event_id', id)
          .not('preferred_partner', 'is', null),
        externals > 0
          ? adminClient
              .from('club_event_external_signups')
              .select('id, preferred_partner')
              .eq('event_id', id)
              .not('preferred_partner', 'is', null)
          : Promise.resolve({ data: [] }),
      ])
    : [{ data: [] }, { data: [] }];
  // A member's fee for the event, so their row says paid or unpaid as a
  // guest's does. Members sign the club waiver when they join, so there is no
  // per-event waiver to show.
  const { data: memberFeeData } =
    canSeeSignups && signups.length > 0
      ? await adminClient
          .from('club_fees')
          .select('player_id, amount_cents, paid_at')
          .eq('club_event_id', id)
          .in(
            'player_id',
            signups.map((row) => row.player_id),
          )
      : { data: [] };
  const memberFee = new Map(
    ((memberFeeData ?? []) as { player_id: string; amount_cents: number | null; paid_at: string | null }[]).map(
      (row) => [row.player_id, { amountCents: row.amount_cents, paid: row.paid_at !== null }],
    ),
  );
  // Answers an officer typed for somebody added by hand (00306), read on their
  // own so a database without the column shows no answers rather than no list.
  const { data: answerData } =
    canSeeSignups && signups.length > 0
      ? await adminClient
          .from('club_event_signups')
          .select('player_id, answers')
          .eq('event_id', id)
          .not('answers', 'is', null)
      : { data: [] };
  const memberAnswers = new Map(
    ((answerData ?? []) as unknown as { player_id: string; answers: Record<string, string> }[]).map((row) => [
      row.player_id,
      row.answers,
    ]),
  );
  // Who can be added by hand: anybody who could sign up and has not.
  let addable: PlayerOption[] = [];
  if (canCheckIn && event.status !== 'cancelled') {
    const { data: playerData } = await adminClient
      .from('players')
      .select('id, full_name, is_guest')
      .eq('is_banned', false)
      .is('deletion_requested_at', null)
      .not('status', 'in', '(pending_approval,suspended)')
      .order('full_name');
    const signedUpIds = new Set(signups.map((row) => row.player_id));
    addable = ((playerData ?? []) as { id: string; full_name: string | null; is_guest: boolean | null }[])
      .filter((player) => !signedUpIds.has(player.id) && player.full_name)
      .map((player) => ({ id: player.id, name: player.full_name as string, meta: player.is_guest ? 'Guest' : null }));
  }
  const memberPartner = new Map(
    ((memberNotes ?? []) as { player_id: string; preferred_partner: string }[]).map((row) => [
      row.player_id,
      row.preferred_partner,
    ]),
  );
  const guestPartner = new Map(
    ((guestNotes ?? []) as { id: string; preferred_partner: string }[]).map((row) => [row.id, row.preferred_partner]),
  );

  const entryById = new Map((formImports?.entries ?? []).map((entry) => [entry.id, entry]));
  const guests = (
    (guestData ?? []) as {
      id: string;
      full_name: string;
      email: string | null;
      import_entry_id: string | null;
      created_at: string;
      walk_in: boolean;
    }[]
  ).map((row): ClubEventSignupRow => {
    const entry = row.import_entry_id ? entryById.get(row.import_entry_id) : undefined;
    return {
      kind: 'guest',
      key: `guest:${row.id}`,
      name: row.full_name,
      created_at: row.created_at,
      email: row.email,
      walkIn: row.walk_in,
      entryId: entry && entry.status === 'entered' ? entry.id : null,
      waiverSigned: row.walk_in ? false : entry ? !!entry.waiver?.signed : null,
      fee: entry?.fee ?? null,
      partner: guestPartner.get(row.id) ?? null,
    };
  });
  const signedUp: ClubEventSignupRow[] = [
    ...signups.map(
      (row): ClubEventSignupRow => ({
        kind: 'member',
        key: `member:${row.player_id}`,
        ...row,
        partner: memberPartner.get(row.player_id) ?? null,
        fee: memberFee.get(row.player_id) ?? null,
        answers: memberAnswers.get(row.player_id) ?? null,
      }),
    ),
    ...guests,
    // Newest first, so the latest sign-ups are at the top (owner, 2026-10-24).
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  // The door list: members, then the Form's non-members (00284), who carry no
  // player id and are keyed by their own row.
  const { data: externalData, error: externalReadError } =
    canSeeSignups && checkInReady && externals > 0
      ? await adminClient
          .from('club_event_external_signups')
          .select('id, full_name, checked_in_at')
          .eq('event_id', id)
      : { data: [], error: null };
  if (externalReadError) checkInReady = false;
  const checkInRows: CheckInRow[] = [
    ...signupRows.map((row) => ({
      key: `member:${row.player_id}`,
      name: signups.find((signup) => signup.player_id === row.player_id)?.name ?? 'A member',
      here: !!row.checked_in_at,
    })),
    ...((externalData ?? []) as { id: string; full_name: string; checked_in_at: string | null }[]).map((row) => ({
      key: `guest:${row.id}`,
      name: row.full_name,
      detail: 'Non-member (Google Form)',
      here: !!row.checked_in_at,
    })),
  ];

  // The linked tournament event (00292), for the Tournament card.
  const { data: linkedData } = event.tournament_event_id
    ? await adminClient
        .from('tournament_events')
        .select('id, tournament_id, tournament:tournaments(status)')
        .eq('id', event.tournament_event_id)
        .maybeSingle()
    : { data: null };
  const linkedTournament = linkedData as
    | { id: string; tournament_id: string; tournament: { status: string } | { status: string }[] | null }
    | null;
  const linked = linkedTournament
    ? {
        tournamentId: linkedTournament.tournament_id,
        eventId: linkedTournament.id,
        status:
          (Array.isArray(linkedTournament.tournament)
            ? linkedTournament.tournament[0]?.status
            : linkedTournament.tournament?.status) ?? 'draft',
      }
    : null;

  const cancelled = event.status === 'cancelled';
  const cost = formatClubEventCost(event.cost_cents);
  const initial: ClubEventFormValues = {
    title: event.title,
    kind: event.kind,
    description: event.description ?? '',
    location: event.location ?? '',
    starts_at: utcToClubWallClock(event.starts_at),
    ends_at: event.ends_at ? utcToClubWallClock(event.ends_at) : '',
    signup_opens_at: event.signup_opens_at ? utcToClubWallClock(event.signup_opens_at) : '',
    signup_closes_at: event.signup_closes_at ? utcToClubWallClock(event.signup_closes_at) : '',
    capacity: event.capacity === null ? '' : String(event.capacity),
    cost_dollars: event.cost_cents === null ? '' : (event.cost_cents / 100).toFixed(2),
    publish: event.status === 'published',
  };

  return (
    <div>
      <LiveEvent eventId={id} channel="event-page" />
      <PageHeader
        eyebrow="EVENTS"
        title={event.title}
        sub={<Link href="/events" className="hover:underline">Back to club events</Link>}
        actions={
          <ClubEventControls
            eventId={event.id}
            canCancel={canCancel && !cancelled}
            canDelete={canDelete && taken === 0}
          />
        }
      />
      <div className="flex flex-col gap-5">
        <EditableSection
          title="Details"
          sub={
            <div className="flex flex-wrap items-center gap-2">
              {cancelled ? (
                <Badge variant="danger">Cancelled</Badge>
              ) : event.status === 'published' ? (
                <Badge variant="success">Published</Badge>
              ) : (
                <Badge variant="neutral">Draft</Badge>
              )}
              {event.capacity !== null && taken > event.capacity && (
                <Badge variant="warning">Over capacity</Badge>
              )}
            </div>
          }
          canEdit={canEdit && !cancelled}
          read={
            <DetailList>
              <DetailRow label="Title" value={event.title} mono={false} />
              <DetailRow
                label="Kind"
                value={CLUB_EVENT_KIND_LABELS[event.kind as ClubEventKind] ?? event.kind}
                mono={false}
              />
              <DetailRow
                label="Description"
                value={
                  event.description ? <span className="whitespace-pre-wrap">{event.description}</span> : null
                }
                mono={false}
                wide
              />
              <DetailRow label="Location" value={event.location} mono={false} />
              <DetailRow label="Starts" value={formatClubEventTime(event.starts_at)} />
              <DetailRow label="Ends" value={event.ends_at ? formatClubEventTime(event.ends_at) : null} />
              <DetailRow
                label="Sign-ups open"
                value={event.signup_opens_at ? formatClubEventTime(event.signup_opens_at) : null}
              />
              <DetailRow
                label="Sign-ups close"
                value={event.signup_closes_at ? formatClubEventTime(event.signup_closes_at) : null}
              />
              <DetailRow
                label="Capacity"
                value={event.capacity === null ? `No limit, ${taken} signed up` : `${taken} of ${event.capacity} places taken`}
              />
              <DetailRow label="Cost" value={cost} />
              {cancelled && <DetailRow label="Cancel reason" value={event.cancelled_reason} mono={false} wide />}
            </DetailList>
          }
          form={<ClubEventForm key={event.id} eventId={event.id} initial={initial} />}
        />

        {(linked || !cancelled) && (
          <ClubEventTournamentCard
            eventId={event.id}
            linked={linked}
            canLink={canEdit && may('tournaments.manage.create.write') && !cancelled}
            nonMembers={externals}
          />
        )}

        {canSeeSignups && !cancelled && (
          <Card className="p-0">
            <h2
              className="px-5 pb-4 pt-5 text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]"
              style={{ fontFamily: 'var(--display)' }}
            >
              Check-in
            </h2>
            {linked ? (
              <p className="px-5 pb-5 text-sm text-[var(--ink-2)]">
                This event runs as a tournament, so check people in there.{' '}
                <Link
                  href={`/tournaments/${linked.tournamentId}/checkin`}
                  className="underline"
                >
                  Open the tournament&apos;s check-in list
                </Link>
              </p>
            ) : !checkInReady ? (
              <p className="px-5 pb-5 text-sm text-[var(--mute)]">Check-in needs migration 00293.</p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-5">
                <p className="text-sm text-[var(--ink-2)]">
                  <span className="font-mono text-lg font-bold text-[var(--ink)]">
                    {checkInRows.filter((row) => row.here).length}
                  </span>{' '}
                  of {checkInRows.length} here
                </p>
                <Link
                  href={`/events/${event.id}/checkin`}
                  className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink)] hover:bg-[var(--bg-elevated)]"
                >
                  Open check-in
                </Link>
              </div>
            )}
          </Card>
        )}

        {canSeeSignups && (
          <Card className="p-0">
            <div className="flex items-center justify-between gap-3 px-5 pb-4 pt-5">
              <h2
                className="text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]"
                style={{ fontFamily: 'var(--display)' }}
              >
                Signed up
              </h2>
              {canCheckIn && event.status !== 'cancelled' && (
                <AddPersonButton
                  eventId={event.id}
                  members={addable}
                  costCents={event.cost_cents}
                  canMarkPaid={may('fees.clubfees.markpaid.write')}
                />
              )}
            </div>
            <ClubEventSignupsTable eventId={event.id} rows={signedUp} canRemove={canRemoveSignup} />
          </Card>
        )}

        {formImports && (
          <Card className="p-5">
            <h2
              className="pb-4 text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]"
              style={{ fontFamily: 'var(--display)' }}
            >
              Google Form
            </h2>
            <ManagedFormPanel
              view={managedForm}
              targetKind="club_event"
              targetId={event.id}
              canCreate={canEdit && !cancelled && !boundByHand}
              canEdit={canEdit}
              className="mb-4"
            />
            <FormImportCard
              targetKind="club_event"
              targetId={event.id}
              bindings={formImports.bindings}
              consumers={canEdit ? formImports.consumers : []}
              entries={formImports.entries}
              canBind={canEdit}
              canUndo={canRemoveSignup}
              migrationMissing="Form registrations need migration 00283."
              reader={readerStatus()}
              enteredListedElsewhere
            />
          </Card>
        )}
      </div>
    </div>
  );
}
