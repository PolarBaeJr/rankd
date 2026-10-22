'use client';

import { useState } from 'react';
import {
  Button,
  Dialog,
  Input,
  Select,
  DatePicker,
  Textarea,
  EditableSectionProvider,
  EditableSectionContent,
  EditableSectionToggle,
  useEditableSection,
} from '@badminton/ui';
import { createSeason, setActiveSeason, endSeason, setSeasonHidden, updateSeasonFees, type SeasonEloPolicy } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { PanelLabel } from './panel';
import type { SeasonStatusKey } from './season-shape';

/**
 * The floor a typed reason has to clear, mirrored from `requireReason` in
 * lib/actions/seasons.ts. The server is the boundary — this only decides when
 * the confirm button stops being disabled, so that "a reason nobody wrote" is
 * never even submittable.
 */
const REASON_MIN = 5;

const enoughReason = (reason: string) => reason.trim().length >= REASON_MIN;

/** Dollars in the box, cents in the column. */
const toCents = (dollars: string) => Math.round(parseFloat(dollars || '0') * 100);
const toDollars = (cents: number) => (cents / 100).toFixed(2);

/** Every row-action control clears the console's 44px touch floor. */
const TOUCH = 'min-h-[44px]';

export function CreateSeasonForm() {
  const [open, setOpen] = useState(false);
  // term + year, not a name: seasons.name is derived from this pair by a trigger
  // (00043) so the two can never drift. Sending a name instead left term/year
  // null, and both are NOT NULL — every attempt to create a season failed.
  const [term, setTerm] = useState('fall');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await createSeason({
        term: term as 'fall' | 'spring' | 'summer',
        year: Number(year),
        start_date: startDate,
        end_date: endDate || undefined,
      });
      toast('Season created', 'success');
      setOpen(false);
      setTerm('fall'); setYear(String(new Date().getFullYear()));
      setStartDate(''); setEndDate('');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New season</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Create season">
        <form onSubmit={handleCreate} className="space-y-4">
          {/* The name shown everywhere else is built from these two. */}
          <Select
            label="Term"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            options={[
              { value: 'fall', label: 'Fall' },
              { value: 'spring', label: 'Spring' },
              { value: 'summer', label: 'Summer' },
            ]}
          />
          {/* The calendar year the term BEGINS in: Fall 2026 and Spring 2027
              are consecutive seasons of one academic year. */}
          <Input
            label="Year"
            type="number"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            required
          />
          <DatePicker label="Start date" value={startDate} onChange={setStartDate} required />
          <DatePicker label="End date (optional)" value={endDate} onChange={setEndDate} />
          <div className="flex gap-2">
            <Button type="submit" loading={loading}>Create</Button>
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/**
 * The two fee amounts and the sentence that has to accompany changing them.
 *
 * Shared by the row dialog and the right-hand panel so the two cannot disagree
 * about what a fee edit requires. Both write through `updateSeasonFees`, which
 * asks for `seasons.fees.write` and now records the reason on the audit row.
 */
function useFeeForm(seasonId: string, competitiveFeeCents: number, recreationalFeeCents: number) {
  const [comp, setComp] = useState(toDollars(competitiveFeeCents));
  const [rec, setRec] = useState(toDollars(recreationalFeeCents));
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  const reset = () => {
    setComp(toDollars(competitiveFeeCents));
    setRec(toDollars(recreationalFeeCents));
    setReason('');
  };

  async function save(onDone?: () => void) {
    setLoading(true);
    try {
      await updateSeasonFees(
        seasonId,
        { competitive_fee_cents: toCents(comp), recreational_fee_cents: toCents(rec) },
        reason,
      );
      toast('Fees updated', 'success');
      setReason('');
      onDone?.();
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return { comp, setComp, rec, setRec, reason, setReason, loading, save, reset };
}

function FeeFields({
  comp,
  setComp,
  rec,
  setRec,
  reason,
  setReason,
}: {
  comp: string;
  setComp: (v: string) => void;
  rec: string;
  setRec: (v: string) => void;
  reason: string;
  setReason: (v: string) => void;
}) {
  return (
    <>
      <Input
        label="Competitive fee $"
        type="number"
        step="0.01"
        min="0"
        value={comp}
        onChange={(e) => setComp(e.target.value)}
      />
      <Input
        label="Recreational fee $"
        type="number"
        step="0.01"
        min="0"
        value={rec}
        onChange={(e) => setRec(e.target.value)}
      />
      {/* Hairline, then the reason: it belongs to the save, not to the amounts. */}
      <div className="pt-4 border-t border-[var(--border)]">
        <Textarea
          label="Reason (required)"
          placeholder="Fee changes are logged against this season. Say why."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      </div>
    </>
  );
}

/**
 * The live season's fees, editable in place.
 *
 * The mockup put a SEASON RULES form here — carry-over %, K-factor, starting
 * rating and a challenges-open switch. Three of those four are club-wide
 * `platform_settings` values edited on /ratings behind `platform.settings.write`
 * (admin only), and the fourth has no storage anywhere. Rendering them here
 * would have presented club-wide configuration as season-scoped and offered an
 * exec a form that rejects them at Save. The two settings that ARE per-season
 * columns are the fees, so that is what the panel edits.
 */
export function SeasonFeesPanel({
  season,
  canEdit,
}: {
  season: { id: string; name: string; competitive_fee_cents: number; recreational_fee_cents: number } | null;
  canEdit: boolean;
}) {
  if (!season) {
    return (
      <div className="px-5 pt-5 pb-5">
        <PanelLabel label="Season fees" />
        <p className="mt-3 text-sm text-[var(--text-secondary)]">No season is live.</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Fees belong to a season, so there is nothing to set until one is active.
        </p>
      </div>
    );
  }

  // WITHHELD, NOT EMPTY. The amounts are on the season row every holder of
  // this page can already read; what an exec does not have is the write. Say
  // that rather than rendering the panel blank or, worse, rendering the form
  // and rejecting them at Save. An editor sees the same amounts, with Edit.
  const read = (
    <div className="px-5 pt-5 pb-5">
      <div className="flex items-center justify-between gap-3">
        <PanelLabel label={`${season.name} · Fees`} />
        {canEdit && <EditableSectionToggle />}
      </div>
      <dl className="mt-3 space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-sm text-[var(--text-secondary)]">Competitive</dt>
          <dd className="font-mono text-sm text-[var(--text-primary)]">
            ${toDollars(season.competitive_fee_cents)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-sm text-[var(--text-secondary)]">Recreational</dt>
          <dd className="font-mono text-sm text-[var(--text-primary)]">
            ${toDollars(season.recreational_fee_cents)}
          </dd>
        </div>
      </dl>
      {!canEdit && (
        <p className="mt-3 pt-4 border-t border-[var(--border)] text-xs text-[var(--text-muted)]">
          Changing what the club charges is not shown to you. An admin sets the
          fee for each season.
        </p>
      )}
    </div>
  );

  // Keyed on the amounts, so a fee changed elsewhere (the row dialog, another
  // officer's tab) re-mounts the form rather than leaving the boxes holding the
  // values they had when this component first rendered.
  return (
    <EditableSectionProvider>
      <EditableSectionContent
        read={read}
        form={
          <SeasonFeesForm
            key={`${season.id}:${season.competitive_fee_cents}:${season.recreational_fee_cents}`}
            season={season}
          />
        }
      />
    </EditableSectionProvider>
  );
}

function SeasonFeesForm({
  season,
}: {
  season: { id: string; name: string; competitive_fee_cents: number; recreational_fee_cents: number };
}) {
  const form = useFeeForm(season.id, season.competitive_fee_cents, season.recreational_fee_cents);
  const { close } = useEditableSection();

  return (
    <form
      className="px-5 pt-5 pb-5 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void form.save(close);
      }}
    >
      <PanelLabel label={`${season.name} · Fees`} />
      <FeeFields
        comp={form.comp}
        setComp={form.setComp}
        rec={form.rec}
        setRec={form.setRec}
        reason={form.reason}
        setReason={form.setReason}
      />
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={close} disabled={form.loading}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="secondary"
          loading={form.loading}
          // The primary red on this screen belongs to New season. A save that
          // cannot run until a sentence is typed is the console's secondary.
          disabled={!enoughReason(form.reason)}
          className="flex-1"
        >
          Save fees
        </Button>
      </div>
    </form>
  );
}

const ELO_POLICY_OPTIONS: { value: SeasonEloPolicy; label: string }[] = [
  { value: 'carry', label: 'Carry over ELO (no reset)' },
  { value: 'soft', label: 'Soft reset (compress toward the ladder floor, keep tiers)' },
  { value: 'full', label: 'Full reset (everyone back to 400)' },
];

const POLICY_WARNING: Record<SeasonEloPolicy, string | null> = {
  carry: null,
  soft: 'Every player’s ELO is compressed toward the ladder floor, and nobody drops below the tier they earned. The floor, the compression factor and the tier size are all set in Settings → Rating Defaults and Season Settings. Match history and win–loss records are preserved.',
  full: 'Every player’s ELO will be reset to 400 and made provisional again, and every season counter on their profile goes back to zero: wins, losses, points, games and streaks. Match history is untouched, so last season still reads correctly on past-season pages, but the current ladder standings and the current season’s record both start over.',
};

// THE `full` WARNING CHANGED WITH 00236, AND THE OLD ONE WAS HALF TRUE.
//
// It used to promise that "win–loss records are preserved". They were, in the
// sense that no `matches` row was deleted. They were not, in the sense the
// person clicking the button cares about: `activate_season` zeroed
// matches_played and left the other sixteen counters on `ratings` standing, so
// a member came out of the rollover reading a career record beside "0 matches
// played". 00236 zeros all twenty, which is coherent, and makes this sentence
// a promise the function keeps.
//
// `soft` is deliberately unchanged, both here and in the function: it really
// does leave the counters running.

export interface SeasonRowCapabilities {
  /** seasons.fees.write */
  fees: boolean;
  /**
   * seasons.end.write. Gates BOTH "Close season" and the history toggle: the
   * hide action re-checks this same string, deliberately rather than adding a
   * fourth one. See setSeasonHidden in lib/actions/seasons.ts.
   */
  end: boolean;
  /** seasons.activate.write */
  activate: boolean;
}

/**
 * The controls on one season's row.
 *
 * EACH CONTROL NAMES ITS OWN CAPABILITY. These used to be decided by
 * `isActive` alone, with the fee editor rendered unconditionally on desktop —
 * so an exec, who holds neither `seasons.fees.write`, got an editable fee
 * control that rejected them at Save. The booleans arrive already resolved from
 * the server component, and each one matches the capability the action it opens
 * re-checks.
 *
 * The mockup's Cancel, View ladder and Export are absent: there is no
 * `deleteSeason` action, no season-scoped ladder route in this console, and no
 * season export anywhere in the app. A button with nothing behind it is worse
 * than no button.
 */
export function SeasonRowActions({
  seasonId,
  seasonName,
  status,
  competitiveFeeCents,
  recreationalFeeCents,
  hidden,
  can,
}: {
  seasonId: string;
  seasonName: string;
  status: SeasonStatusKey;
  competitiveFeeCents: number;
  recreationalFeeCents: number;
  /** seasons.hidden_flag. The console shows hidden seasons: see the toggle below. */
  hidden: boolean;
  can: SeasonRowCapabilities;
}) {
  const [loading, setLoading] = useState(false);
  const [activateOpen, setActivateOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [feesOpen, setFeesOpen] = useState(false);
  const [policy, setPolicy] = useState<SeasonEloPolicy>('carry');
  const [activateReason, setActivateReason] = useState('');
  const [endReason, setEndReason] = useState('');
  const [hideOpen, setHideOpen] = useState(false);
  const [hideReason, setHideReason] = useState('');
  const { toast } = useToast();
  const router = useRouter();
  const feeForm = useFeeForm(seasonId, competitiveFeeCents, recreationalFeeCents);

  // A live season is not activated again; a finished one still can be, which is
  // how a club that ended a term early puts it back.
  const isLive = status === 'live' || status === 'overdue';

  async function handleActivate() {
    setLoading(true);
    try {
      await setActiveSeason(seasonId, policy, activateReason);
      toast('Season activated', 'success');
      setActivateOpen(false);
      setActivateReason('');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleEnd() {
    setLoading(true);
    try {
      await endSeason(seasonId, endReason);
      toast('Season closed', 'success');
      setEndOpen(false);
      setEndReason('');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleHide() {
    setLoading(true);
    try {
      await setSeasonHidden(seasonId, !hidden, hideReason);
      toast(hidden ? 'Season shown to members' : 'Season hidden from members', 'success');
      setHideOpen(false);
      setHideReason('');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  const warning = POLICY_WARNING[policy];

  // OFFERED ON FINISHED SEASONS ONLY. The flag hides a season from the member
  // history surfaces, and the ACTIVE season is not history: it is reached
  // through active_flag, not through a picker, so hiding it would change
  // nothing a member sees while reading as though it had. Close the season
  // first, then decide whether to publish it.
  const canToggleHidden = !isLive && can.end;

  const nothingOffered =
    !can.fees && !(isLive ? can.end : can.activate) && !canToggleHidden;

  if (nothingOffered) {
    // Not a blank cell: this row has controls, they are just not this viewer's.
    return <span className="font-mono text-xs text-[var(--text-muted)]">—</span>;
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {can.fees && (
        <>
          <Button size="sm" variant="ghost" className={TOUCH} onClick={() => { feeForm.reset(); setFeesOpen(true); }}>
            Edit fees
          </Button>
          <Dialog open={feesOpen} onClose={() => setFeesOpen(false)} title={`Fees for ${seasonName}`}>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void feeForm.save(() => setFeesOpen(false));
              }}
            >
              <FeeFields
                comp={feeForm.comp}
                setComp={feeForm.setComp}
                rec={feeForm.rec}
                setRec={feeForm.setRec}
                reason={feeForm.reason}
                setReason={feeForm.setReason}
              />
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="secondary"
                  loading={feeForm.loading}
                  disabled={!enoughReason(feeForm.reason)}
                  className="flex-1"
                >
                  Save fees
                </Button>
                <Button variant="ghost" type="button" onClick={() => setFeesOpen(false)}>Cancel</Button>
              </div>
            </form>
          </Dialog>
        </>
      )}

      {isLive && can.end && (
        <>
          <Button size="sm" variant="secondary" className={TOUCH} onClick={() => { setEndReason(''); setEndOpen(true); }}>
            Close season
          </Button>
          {/* Named, not "Are you sure?". */}
          <Dialog open={endOpen} onClose={() => setEndOpen(false)} title={`Close ${seasonName}?`}>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void handleEnd();
              }}
            >
              <p className="text-sm text-[var(--text-secondary)]">
                {seasonName} stops being the active season and today becomes its
                end date. Its ladder is frozen as it stands — ratings are not
                changed, and nothing already recorded moves.
              </p>
              <Textarea
                label="Reason (required)"
                placeholder="Closing a season is logged. Say why."
                value={endReason}
                onChange={(e) => setEndReason(e.target.value)}
                required
              />
              <div className="flex gap-2">
                <Button variant="ghost" type="button" onClick={() => setEndOpen(false)}>Cancel</Button>
                <Button
                  type="submit"
                  variant="danger"
                  loading={loading}
                  disabled={!enoughReason(endReason)}
                  className="flex-1"
                >
                  Close {seasonName}
                </Button>
              </div>
            </form>
          </Dialog>
        </>
      )}

      {canToggleHidden && (
        <>
          <Button
            size="sm"
            variant="ghost"
            className={TOUCH}
            onClick={() => { setHideReason(''); setHideOpen(true); }}
          >
            {hidden ? 'Show to members' : 'Hide from members'}
          </Button>
          <Dialog
            open={hideOpen}
            onClose={() => setHideOpen(false)}
            title={hidden ? `Show ${seasonName} to members?` : `Hide ${seasonName} from members?`}
          >
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void handleHide();
              }}
            >
              {/* Says what moves and what does not. The flag is only ever a
                  publication decision, and an exec reading this dialog is the
                  person most likely to assume it is more than that. */}
              <p className="text-sm text-[var(--text-secondary)]">
                {hidden ? (
                  <>
                    {seasonName} goes back into the member-facing history: its final
                    standings become readable on the leaderboard and it reappears in
                    the season picker on My Stats.
                  </>
                ) : (
                  <>
                    {seasonName} is removed from the member-facing history. Its final
                    standings stop being readable on the leaderboard and it disappears
                    from the season picker on My Stats.
                  </>
                )}
              </p>
              <p className="text-sm text-[var(--text-secondary)]">
                Nothing is deleted, and nothing else changes: the season keeps its
                dates, its fees, its sessions and its archived ratings, and every
                financial report still counts it. This console keeps listing it
                either way, which is the only way back.
              </p>
              <Textarea
                label="Reason (required)"
                placeholder={hidden ? 'Republishing a season is logged. Say why.' : 'Hiding a season is logged. Say why.'}
                value={hideReason}
                onChange={(e) => setHideReason(e.target.value)}
                required
              />
              <div className="flex gap-2">
                <Button variant="ghost" type="button" onClick={() => setHideOpen(false)}>Cancel</Button>
                <Button
                  type="submit"
                  variant="secondary"
                  loading={loading}
                  disabled={!enoughReason(hideReason)}
                  className="flex-1"
                >
                  {hidden ? `Show ${seasonName}` : `Hide ${seasonName}`}
                </Button>
              </div>
            </form>
          </Dialog>
        </>
      )}

      {!isLive && can.activate && (
        <>
          <Button size="sm" variant="ghost" className={TOUCH} onClick={() => { setPolicy('carry'); setActivateReason(''); setActivateOpen(true); }}>
            Set active
          </Button>
          <Dialog open={activateOpen} onClose={() => setActivateOpen(false)} title={`Activate ${seasonName}?`}>
            <div className="space-y-4">
              <Select
                label="ELO on activation"
                options={ELO_POLICY_OPTIONS}
                value={policy}
                onChange={(e) => setPolicy(e.target.value as SeasonEloPolicy)}
              />
              {warning && (
                <div className="p-3 text-sm border border-[var(--border)] text-[var(--text-secondary)] bg-[color-mix(in_oklab,var(--color-warning)_10%,transparent)]">
                  {warning}
                </div>
              )}
              {/* Activation is the heaviest write on this screen — under `full`
                  it puts every rating in the club back to the floor — so it
                  takes a sentence like the other two. */}
              <Textarea
                label="Reason (required)"
                placeholder="Rolling the club onto a new season is logged. Say why."
                value={activateReason}
                onChange={(e) => setActivateReason(e.target.value)}
                required
              />
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setActivateOpen(false)}>Cancel</Button>
                <Button
                  variant={policy === 'carry' ? 'primary' : 'danger'}
                  onClick={handleActivate}
                  loading={loading}
                  disabled={!enoughReason(activateReason)}
                  className="flex-1"
                >
                  {policy === 'carry' ? 'Activate' : 'Activate & reset ELO'}
                </Button>
              </div>
            </div>
          </Dialog>
        </>
      )}
    </div>
  );
}
