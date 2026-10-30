'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input, Select, Switch, Dropdown, Textarea, DatePicker, useConfirm } from '@badminton/ui';
import {
  MEMBERSHIP_TYPES,
  ALL_MEMBERSHIP_TYPES,
  ELO_MULTIPLIER_BOUNDS,
  resolveEventWaiverTemplate,
  TOURNAMENT_BONUS_AMOUNT_KEYS,
  tournamentBonusAmount,
  type TournamentBonusAmountKey,
  type TournamentBonusSettings,
  type WindowColumns,
  effectiveWindows,
  validateEffectiveWindows,
  windowColumnsFromWallClock,
  clockHHMM,
  parseTournamentDetails,
  TOURNAMENT_LOCATION_MAX,
} from '@badminton/shared';
import { createTournament, updateTournament, eventWaiverEditImpact, archiveTournament, completeTournamentWithEvents, deleteTournament } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { EntryWindowFields, entryWindowText, type EntryWindowText } from '@/components/entry-window-fields';
import { MoreVertical } from 'lucide-react';

export interface TournamentData extends WindowColumns {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  event_multiplier: number;
  placement_bonus_enabled: boolean;
  waiver_text: string | null;
  // How many of this tournament's events one member may enter (00098).
  // null is uncapped. Present on the page's `select('*')`.
  max_events_per_player?: number | null;
  // Which season's waiver template this tournament's editor offers. Present on
  // the page's `select('*')`; declared here so the template lookup is typed.
  season_id?: string | null;
  // This tournament's own bonus amounts (00275). Present on the page's
  // `select('*')` once the migration has run.
  placement_bonus_amounts?: Record<string, unknown> | null;
  // Its own daily times and venue (00304). Present on the page's `select('*')`
  // once the migration has run; a time arrives as HH:MM:SS.
  starts_time?: string | null;
  ends_time?: string | null;
  location?: string | null;
  status: string;
}

const BONUS_PLACES: Array<{ place: string; label: string }> = [
  { place: 'champion', label: 'Champion' },
  { place: 'finalist', label: 'Finalist' },
  { place: 'thirdplace', label: 'Third place' },
  { place: 'semifinalist', label: 'Semifinalist' },
  { place: 'quarterfinalist', label: 'Quarterfinalist' },
];

type BonusAmountsText = Record<TournamentBonusAmountKey, string>;

function bonusAmountsText(stored: Record<string, unknown> | null | undefined): BonusAmountsText {
  const out = {} as BonusAmountsText;
  for (const key of TOURNAMENT_BONUS_AMOUNT_KEYS) {
    const v = stored?.[key];
    out[key] = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? String(v) : '';
  }
  return out;
}

/**
 * This tournament's own placement bonus amounts. A blank box pays the club's
 * amount, shown as its placeholder; when the club's amounts could not be read
 * the placeholder is left empty rather than guessed.
 */
function BonusAmountsFields({
  value,
  onChange,
  club,
}: {
  value: BonusAmountsText;
  onChange: (next: BonusAmountsText) => void;
  club: TournamentBonusSettings | null;
}) {
  const anySet = TOURNAMENT_BONUS_AMOUNT_KEYS.some((k) => value[k].trim() !== '');
  return (
    <fieldset className="space-y-2 rounded-lg border border-[var(--border)] p-3">
      <legend className="px-1 text-[13px] font-medium text-[var(--text-secondary)]">Bonus amounts for this tournament</legend>
      <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-2">
        <span />
        <span className="text-xs font-medium text-[var(--text-muted)]">Singles</span>
        <span className="text-xs font-medium text-[var(--text-muted)]">Doubles</span>
        {BONUS_PLACES.map(({ place, label }) => (
          <BonusRow key={place} place={place} label={label} value={value} onChange={onChange} club={club} />
        ))}
      </div>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-[var(--text-muted)]">
          Leave a box blank to pay the club amount. Fixed once any event here has paid a bonus.
        </p>
        <Button
          type="button"
          variant="ghost"
          className="text-xs flex-shrink-0"
          disabled={!anySet}
          onClick={() => onChange(bonusAmountsText(null))}
        >
          Reset to club amounts
        </Button>
      </div>
    </fieldset>
  );
}

function BonusRow({
  place,
  label,
  value,
  onChange,
  club,
}: {
  place: string;
  label: string;
  value: BonusAmountsText;
  onChange: (next: BonusAmountsText) => void;
  club: TournamentBonusSettings | null;
}) {
  const keys = (['singles', 'doubles'] as const).map((d) => `${d}_${place}` as TournamentBonusAmountKey);
  return (
    <>
      <span className="text-sm text-[var(--text-secondary)]">{label}</span>
      {keys.map((key) => (
        <Input
          key={key}
          aria-label={`${key.startsWith('singles') ? 'Singles' : 'Doubles'} ${label.toLowerCase()} bonus`}
          type="number"
          min={0}
          step={1}
          value={value[key]}
          placeholder={club ? String(tournamentBonusAmount(club, key)) : ''}
          onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        />
      ))}
    </>
  );
}

// The per-season event-waiver templates from Legal (00074), passed down from
// the page so the dialog can pre-fill the waiver box without a round trip.
export interface WaiverTemplateContext {
  templates: { season_id: string; content: string }[];
  activeSeasonId: string | null;
}

function TournamentFormDialog({
  open,
  onClose,
  tournament,
  waiverTemplates,
  clubBonusSettings = null,
}: {
  open: boolean;
  onClose: () => void;
  tournament?: TournamentData;
  waiverTemplates: WaiverTemplateContext;
  /** The club's bonus amounts, shown behind a blank override box. null when unread. */
  clubBonusSettings?: TournamentBonusSettings | null;
}) {
  const isEdit = !!tournament;
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(tournament?.name ?? '');
  const [startDate, setStartDate] = useState(tournament?.start_date ?? '');
  const [endDate, setEndDate] = useState(tournament?.end_date ?? '');
  // HH:MM, because that is what a time input holds and what the action
  // checks; the column hands back HH:MM:SS.
  const [startsTime, setStartsTime] = useState(clockHHMM(tournament?.starts_time) ?? '');
  const [endsTime, setEndsTime] = useState(clockHHMM(tournament?.ends_time) ?? '');
  const [location, setLocation] = useState(tournament?.location ?? '');
  // Same reasoning as the windows: a database without 00304 has no columns to
  // offer, and saving blanks there would be refused.
  const detailsAvailable = !tournament || 'starts_time' in tournament;
  const [eventMultiplier, setEventMultiplier] = useState(tournament?.event_multiplier ?? 1.15);
  const [placementBonus, setPlacementBonus] = useState(tournament?.placement_bonus_enabled ?? true);
  const [bonusAmounts, setBonusAmounts] = useState<BonusAmountsText>(() => bonusAmountsText(tournament?.placement_bonus_amounts));
  const [waiverText, setWaiverText] = useState(tournament?.waiver_text ?? '');
  const [windows, setWindows] = useState<EntryWindowText>(() => entryWindowText(tournament));
  // The page's select('*') names every column, so an edit on a database
  // without 00276 has no window fields to offer.
  const windowsAvailable = !tournament || 'registration_opens_at' in tournament;
  // Held as a STRING, not a number, because "" is a meaningful value here: it
  // is how the exec says "no limit". A numeric state would have to pick some
  // sentinel to stand for empty, and 0 is exactly the value the column refuses.
  const [maxEventsPerPlayer, setMaxEventsPerPlayer] = useState(
    tournament?.max_events_per_player != null ? String(tournament.max_events_per_player) : '',
  );
  const [allowedMemberships, setAllowedMemberships] = useState<string[]>(
    (tournament as { allowed_memberships?: string[] } | undefined)?.allowed_memberships
      ?? ALL_MEMBERSHIP_TYPES,
  );
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  // An existing tournament offers its own season's wording; a new one offers
  // the active season's, which is the season createTournament will stamp on it.
  const seasonTemplate = resolveEventWaiverTemplate(
    waiverTemplates.templates,
    tournament?.season_id,
    waiverTemplates.activeSeasonId
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      // Checked here as well as on the server so the exec hears about it before
      // the round trip.
      if (windowsAvailable) {
        const refusal = validateEffectiveWindows(
          effectiveWindows({ event: null, tournament: windowColumnsFromWallClock(windows) }),
        );
        if (refusal) { toast(refusal, 'error'); setLoading(false); return; }
      }
      const details = { starts_time: startsTime, ends_time: endsTime, location };
      if (detailsAvailable) {
        const parsed = parseTournamentDetails(details);
        if (!parsed.ok) { toast(parsed.error, 'error'); setLoading(false); return; }
      }
      const data = {
        name,
        start_date: startDate,
        end_date: endDate || undefined,
        allowed_memberships: allowedMemberships,
        event_multiplier: eventMultiplier,
        placement_bonus_enabled: placementBonus,
        waiver_text: waiverText,
        // Blank box -> null -> uncapped. Passed explicitly rather than omitted
        // so that clearing the box on an existing tournament REMOVES the cap.
        max_events_per_player: maxEventsPerPlayer.trim() ? Number(maxEventsPerPlayer) : null,
        ...(windowsAvailable ? windows : {}),
        // Blank clears, so emptying a box on an edit removes the time.
        ...(detailsAvailable ? details : {}),
      };
      if (isEdit) {
        // EDITING THE WAIVER TEXT SILENTLY UN-SIGNS EVERYONE WHO ACCEPTED THE
        // OLD WORDING. An acceptance is pinned to a hash of the exact text
        // (00015), so any real edit stops matching — which is correct for a
        // signed document and invisible at the moment somebody does it. Done
        // mid-tournament it turns a field that could check in into one that
        // cannot, and the first symptom is a refusal at the door.
        //
        // So it is said out loud, with the number, before the save. Only when
        // there is actually somebody to un-sign: a warning that fires on every
        // typo in an unused box is a warning nobody reads.
        const { invalidated } = await eventWaiverEditImpact(tournament.id, waiverText);
        if (invalidated > 0) {
          const ok = await confirm({
            title: 'This will un-sign the event waiver',
            message:
              `${invalidated} ${invalidated === 1 ? 'person has' : 'people have'} already accepted the ` +
              'current wording. Changing it means their acceptance no longer covers what they agreed to, ' +
              'so they will have to accept the new text before they can be checked in. ' +
              'Save anyway?',
            confirmLabel: 'Save and un-sign',
            danger: true,
          });
          if (!ok) { setLoading(false); return; }
        }
        const amounts: Record<string, number> = {};
        for (const key of TOURNAMENT_BONUS_AMOUNT_KEYS) {
          if (bonusAmounts[key].trim() !== '') amounts[key] = Number(bonusAmounts[key]);
        }
        const res = await updateTournament(tournament.id, {
          ...data,
          placement_bonus_amounts: Object.keys(amounts).length > 0 ? amounts : null,
        });
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        toast('Tournament updated', 'success');
      } else {
        const res = await createTournament(data);
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        toast('Tournament created', 'success');
      }
      onClose();
      if (!isEdit) {
        setName(''); setStartDate(''); setEndDate('');
        setStartsTime(''); setEndsTime(''); setLocation('');
        setEventMultiplier(1.15); setPlacementBonus(true);
        setWaiverText('');
        setWindows(entryWindowText(null));
      }
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <Dialog open={open} onClose={onClose} title={isEdit ? 'Edit Tournament' : 'Create Tournament'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        {/* Who may register. Unticking a group stops it at registration — the
            check is in the server action, since that path uses the service-role
            key and bypasses RLS entirely. At least one must stay ticked; an
            empty list bars everyone, including admins. */}
        <fieldset className="space-y-1">
          <legend className="block text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
            Open to
          </legend>
          <div className="flex flex-wrap gap-3">
            {MEMBERSHIP_TYPES.map((m) => {
              const checked = allowedMemberships.includes(m.value);
              const isLastChecked = checked && allowedMemberships.length === 1;
              return (
                <label key={m.value} className="flex items-center gap-2 text-sm" title={m.description}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isLastChecked}
                    onChange={(e) =>
                      setAllowedMemberships((prev) =>
                        e.target.checked ? [...prev, m.value] : prev.filter((v) => v !== m.value),
                      )
                    }
                  />
                  {m.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-4">
          <DatePicker label="Start Date" value={startDate} onChange={setStartDate} required />
          <DatePicker label="End Date" value={endDate} onChange={setEndDate} />
        </div>
        {detailsAvailable && (
          <div>
            <div className="grid grid-cols-2 gap-4">
              <Input label="Start time (optional)" type="time" value={startsTime} onChange={(e) => setStartsTime(e.target.value)} />
              <Input label="End time (optional)" type="time" value={endsTime} onChange={(e) => setEndsTime(e.target.value)} />
            </div>
            <div className="mt-4">
              <Input
                label="Location (optional)"
                value={location}
                maxLength={TOURNAMENT_LOCATION_MAX}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Club time, each day of the tournament. Shown on the tournament page and on its Discord
              event, which starts at 09:00 and ends at 18:00 when these are left blank.
            </p>
          </div>
        )}
        <Input
          label="Elo Multiplier"
          type="number"
          value={String(eventMultiplier)}
          min={ELO_MULTIPLIER_BOUNDS.min}
          max={ELO_MULTIPLIER_BOUNDS.max}
          step={ELO_MULTIPLIER_BOUNDS.step}
          onChange={(e) => setEventMultiplier(Number(e.target.value))}
        />
        <div>
          <Input
            label="Max events per player (optional)"
            type="number"
            min={1}
            value={maxEventsPerPlayer}
            onChange={(e) => setMaxEventsPerPlayer(e.target.value)}
          />
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Leave blank for no limit. Counts singles entries and doubles pairs
            together, so entering a doubles event with a partner uses one of
            these. Withdrawing frees it up again.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Switch checked={placementBonus} onChange={setPlacementBonus} />
          <span className="text-sm text-[var(--text-secondary)]">Enable placement bonuses</span>
        </div>
        <p className="-mt-2 text-xs text-[var(--text-muted)]">
          The starting setting for each new event. Events already created keep their own.
        </p>
        {windowsAvailable && (
          <fieldset className="space-y-2 rounded-lg border border-[var(--border)] p-3">
            <legend className="px-1 text-[13px] font-medium text-[var(--text-secondary)]">Registration and check-in windows</legend>
            <EntryWindowFields value={windows} onChange={setWindows} />
            <p className="text-xs text-[var(--text-muted)]">
              Club time. Leave blank for no limit. Each event uses these unless it sets its own. Members
              can only enter or check themselves in inside them; execs can still add entrants and check
              people in outside these times, and still open each stage by hand.
            </p>
          </fieldset>
        )}
        {isEdit && (
          <BonusAmountsFields value={bonusAmounts} onChange={setBonusAmounts} club={clubBonusSettings} />
        )}
        <div>
          <Textarea
            label="Event waiver (optional)"
            value={waiverText}
            onChange={(e) => setWaiverText(e.target.value)}
            rows={5}
          />
          <div className="flex items-start justify-between gap-3 mt-1">
            <p className="text-xs text-[var(--text-muted)]">
              Participants must accept this before registering. Leave blank for none.
            </p>
            {/* Copies the season's template text in — it is not linked. Editing
                the template in Legal afterwards must not change a waiver
                participants have already accepted (event_waiver_acceptances
                pins a hash of the accepted text).
                The label changes when the box is non-empty rather than opening
                a confirm dialog: this is already inside a Dialog, and the
                wording is enough to say the click overwrites. */}
            <Button
              type="button"
              variant="ghost"
              className="text-xs flex-shrink-0"
              disabled={!seasonTemplate || waiverText === seasonTemplate}
              title={
                seasonTemplate
                  ? "Fill the box with this season's event waiver template from Legal"
                  : 'No event waiver template for this season — add one in Legal'
              }
              onClick={() => {
                if (!seasonTemplate) return;
                setWaiverText(seasonTemplate);
              }}
            >
              {waiverText.trim() ? 'Replace with template' : 'Use season template'}
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={onClose} type="button" className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">Cancel</Button>
          <Button type="submit" loading={loading} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">{isEdit ? 'Save Changes' : 'Create'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CreateTournamentForm({ waiverTemplates }: { waiverTemplates: WaiverTemplateContext }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">New Tournament</Button>
      <TournamentFormDialog open={open} onClose={() => setOpen(false)} waiverTemplates={waiverTemplates} />
    </>
  );
}

/**
 * The row-action slot on the /tournaments index: an explicit Edit button, then
 * an overflow for the two actions that are not reversible from the row.
 *
 * EVERY CONTROL IS ASKED FOR SEPARATELY. This used to be one dropdown that
 * offered Edit, Archive and Delete to whoever the section let in — three
 * capabilities behind no check at all. The server actions each re-check their
 * own (`tournaments.manage.update.write`, `.archive.write`, `.delete.write`),
 * so an ungated menu only ever produced a control that failed on click; now the
 * three flags come down per capability and the whole component renders nothing
 * when a viewer holds none of them.
 */
export function TournamentRowActions({
  tournament,
  waiverTemplates,
  clubBonusSettings = null,
  canEdit,
  canArchive,
  canDelete,
}: {
  tournament: TournamentData;
  waiverTemplates: WaiverTemplateContext;
  clubBonusSettings?: TournamentBonusSettings | null;
  canEdit: boolean;
  canArchive: boolean;
  canDelete: boolean;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmArchiveEvents, setConfirmArchiveEvents] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  // archiveTournament RETURNS its refusals instead of throwing them, because
  // Next.js replaces anything thrown out of a Server Action in production with
  // a generic message. A returned refusal RESOLVES, so the previous
  // `await ...; toast(success)` shape painted a green "Tournament archived"
  // over every one of them — and TypeScript could not catch it, since the call
  // takes the same string argument it always did. Read `ok`.
  async function handleArchive() {
    const res = await archiveTournament(tournament.id);
    if (res.ok) {
      toast('Tournament archived', 'success');
      router.refresh();
    } else {
      toast(res.error, 'error');
    }
  }

  // An archive is a completion too, so it is gated on the same unfinished
  // events — which means it needs the same way through. Without this, a
  // tournament whose events were abandoned (there is one on production:
  // `Test Competition 1`, womens_singles live since 2026-07-24) could never be
  // archived from this menu again.
  async function handleArchiveWithEvents() {
    const res = await completeTournamentWithEvents(tournament.id, 'archived');
    if (res.ok) {
      const { finalized, closed } = res.data;
      const parts = [
        finalized.length > 0 ? `${finalized.length} finalised` : null,
        closed.length > 0 ? `${closed.length} closed without results` : null,
      ].filter(Boolean);
      toast(
        parts.length > 0 ? `Tournament archived — ${parts.join(', ')}` : 'Tournament archived',
        'success',
      );
      setConfirmArchiveEvents(false);
      router.refresh();
    } else {
      toast(res.error, 'error');
    }
  }

  async function handleDelete() {
    setLoading(true);
    try {
      await deleteTournament(tournament.id);
      toast('Tournament deleted', 'success');
      setConfirmDelete(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  // Archiving an already-archived tournament is a no-op, so the item is only
  // offered where it does something — the same rule the old menu used.
  const overflow = [
    ...(canArchive && tournament.status !== 'archived'
      ? [
          { label: 'Archive', onClick: handleArchive },
          { label: 'Finalise events & archive', onClick: () => setConfirmArchiveEvents(true) },
        ]
      : []),
    // Only on a draft, because deleteTournament refuses anything else that has
    // a draw, and a menu item that exists to produce a refusal is worse than no
    // menu item. The server rule is the wider of the two: it also allows a
    // non-draft tournament with no matches at all. This list does not load the
    // draw, so the menu takes the narrower rule it can answer here rather than
    // adding a read to every row of the page.
    ...(canDelete && tournament.status === 'draft'
      ? [{ label: 'Delete', onClick: () => setConfirmDelete(true), danger: true }]
      : []),
  ];

  if (!canEdit && overflow.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      {canEdit && (
        // 44px floor: this sits in a row-action slot an officer taps from a
        // phone at the door.
        <Button
          variant="ghost"
          size="sm"
          className="min-h-[44px]"
          onClick={() => setEditOpen(true)}
        >
          Edit
        </Button>
      )}
      {overflow.length > 0 && (
        <Dropdown
          trigger={
            <button
              aria-label={`More actions for ${tournament.name}`}
              className="inline-flex h-11 w-11 items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[var(--border-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
          }
          items={overflow}
        />
      )}

      <TournamentFormDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        tournament={tournament}
        waiverTemplates={waiverTemplates}
        clubBonusSettings={clubBonusSettings}
      />

      <Dialog open={confirmArchiveEvents} onClose={() => setConfirmArchiveEvents(false)} title={`Finalise events & archive ${tournament.name}`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Every event that is ready will be finalised — positions, points and placement
            bonuses awarded exactly as a normal finish.
          </p>
          <p className="text-sm text-[var(--text-secondary)]">
            Any event that was never finished will be <strong>closed without results</strong>:
            its entrants get no position and no points. There is no undo.
          </p>
          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={() => setConfirmArchiveEvents(false)} type="button">Cancel</Button>
            <Button onClick={handleArchiveWithEvents}>Finalise &amp; Archive</Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${tournament.name}`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Are you sure you want to permanently delete <strong>{tournament.name}</strong>? This will also remove all participants and events. This action cannot be undone.
          </p>
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">Cancel</Button>
            <Button variant="danger" onClick={handleDelete} loading={loading} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">Delete</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
