'use client';

import { useState } from 'react';
import { Button, Dialog, Input, Switch } from '@badminton/ui';
import { setEventWaitlist, updateTournamentEvent } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import {
  playsRoundRobin,
  isPoolToBracket,
  ELO_MULTIPLIER_BOUNDS,
  eventEloMultiplier,
  parseFormatConfig,
  parsePointsTable,
  poolsThenPlacement,
  withEveryStageUnrated,
} from '@badminton/shared';
import type { FormatConfig, FormatPoints, SeedBy, TournamentMatchFormat } from '@badminton/shared';
import { stagedEditorErrors } from '@/lib/staged-editor';
import { StagedFormatEditor } from '../../../staged-format-editor';
import { PointsTableEditor } from '../../../points-table-editor';
import {
  EventFormatFields,
  toFormatPayload,
  type EventFormatValues,
  type SiblingEvent,
} from '../../../event-format-fields';
import type { TournamentEventRow } from '@/lib/tournament-types';

// Editing the format after the event is created. The server refuses a format
// change once a draw exists, so from then on this dialog offers only what can
// still change: a staged event's undrawn stages, a legacy event's points table
// (pointsOnly). The exec never sees a form that cannot be saved.
export function EventSettingsDialog({
  event,
  siblings,
  totalEntries,
  stagesDrawn = [],
  pointsOnly: pointsOnlyAsked = false,
  onClose,
}: {
  event: TournamentEventRow;
  siblings: SiblingEvent[];
  /**
   * The field as it stands, so the seed-skip control can say how many byes it
   * would actually produce (00124). Optional so an un-updated caller still
   * type-checks and simply gets no live line.
   */
  totalEntries?: number;
  /** A staged event: the stage numbers that have matches. */
  stagesDrawn?: number[];
  /** A legacy event past its draw: only the points table can change (00275). */
  pointsOnly?: boolean;
  onClose: () => void;
}) {
  // A STAGED EVENT (00272). Its stages are edited here until it is finalised;
  // once one is drawn, only the stages are sent, and the server refuses any
  // change to a drawn one.
  const staged = event.format === 'staged';
  const external = event.external_event === true;
  // A club event's linked tournament is made unrated (00292), and switching
  // it to stages keeps it that way.
  const unrated = external || (event as { rated?: boolean | null }).rated === false;
  const [storedConfig] = useState<FormatConfig | null>(() => (staged ? parseFormatConfig(event.format_config) : null));
  const [stagedConfig, setStagedConfig] = useState<FormatConfig>(() => {
    const cfg = storedConfig ?? poolsThenPlacement();
    return unrated ? withEveryStageUnrated(cfg) : cfg;
  });
  const drawn = new Set(stagesDrawn);
  const stagesOnly = staged && drawn.size > 0;
  const pointsOnly = !staged && pointsOnlyAsked;
  // AN UNDRAWN EVENT ON A SIMPLE FORMAT CAN BE SWITCHED TO STAGES, which is
  // where every other shape lives: top N across groups, a playoff, placement
  // matches. One way only: the simple formats are presets of it.
  const [switchingToStages, setSwitchingToStages] = useState(false);
  const editingStages = staged || switchingToStages;
  const stagedErrors = editingStages ? stagedEditorErrors(stagedConfig, storedConfig, drawn) : [];
  const [pointsConfig, setPointsConfig] = useState<FormatPoints | null>(() => parsePointsTable(event.points_config));
  const [values, setValues] = useState<EventFormatValues>({
    matchFormat: event.match_format as TournamentMatchFormat,
    gamesPerMatch: event.games_per_match?.toString() ?? '',
    pointsPerGame: event.points_per_game?.toString() ?? '',
    seededFrom: event.seeded_from_event_id ?? '',
    seedBy: (event.seed_by as SeedBy | null) ?? 'wins',
    // Structural reads, following max_events_per_player's precedent: 00106's
    // columns are not in the generated Database type until the migration has
    // been run and the types regenerated from the database it changed.
    groupCount: (event as { group_count?: number | null }).group_count?.toString() ?? '',
    // A flat pool_to_bracket pool defaults to 4 qualifiers rather than 2, since
    // "top 2 of one pool" is a final and nothing else. Same default the server
    // applies (normalizeGroupShape).
    // Parenthesised deliberately: `x ?? 0 > 1` parses as `x ?? (0 > 1)`, which
    // reads a group count of exactly 1 — a flat pool spelt out rather than left
    // blank — as a group STAGE and defaults it to 2. Only reachable when the
    // column is NULL, which the server never leaves it on this format, but a
    // fallback that is wrong in one case is worse than no fallback.
    qualifiersPerGroup: (event as { qualifiers_per_group?: number | null }).qualifiers_per_group?.toString()
      ?? (isPoolToBracket(event.format)
        && (((event as { group_count?: number | null }).group_count ?? 1) <= 1) ? '4' : '2'),
    // Same structural read as the two above (00124 is not in the generated
    // Database type until the migration has been run and the types regenerated).
    // 0 opens the control blank rather than showing a literal "0": blank and 0
    // mean the same thing here, and a placeholder that says so reads better than
    // a number the exec has to clear before typing.
    seedSkip: (() => {
      const stored = (event as { seed_skip_count?: number | null }).seed_skip_count ?? 0;
      return stored > 0 ? String(stored) : '';
    })(),
  });
  const [maxParticipants, setMaxParticipants] = useState(event.max_participants?.toString() ?? '');
  // HOW HARD THIS EVENT MOVES RATINGS, which until now was set once at creation
  // and then unreachable: updateTournamentEvent has always accepted the field,
  // but no form sent it, so an event created at the wrong weight stayed there.
  //
  // Seeded through eventEloMultiplier() rather than String(event.elo_multiplier)
  // because the column is DECIMAL(4,2) and PostgREST hands it back as a STRING —
  // "1.25" prints the same either way, but a null row would render the literal
  // "null" in the box, and eventEloMultiplier is the one coercion the rating
  // path uses. toFixed(2) matches the column's scale, so the value shown is the
  // value stored.
  const [eloMultiplier, setEloMultiplier] = useState(
    eventEloMultiplier(event.elo_multiplier).toFixed(2),
  );
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  // THE WAITLIST (00278), saved on its own the moment a switch moves rather
  // than with the form: it takes the field lock, and switching it off is
  // refused while anybody is still waiting. The columns are missing until the
  // migration runs, so their absence from `select('*')` is the probe.
  const waitlistReady = 'waitlist_enabled' in event;
  const waitlistRow = event as { waitlist_enabled?: boolean; waitlist_auto_promote?: boolean };
  const [waitlistEnabled, setWaitlistEnabled] = useState(waitlistRow.waitlist_enabled === true);
  const [waitlistAuto, setWaitlistAuto] = useState(waitlistRow.waitlist_auto_promote !== false);
  const [waitlistSaving, setWaitlistSaving] = useState(false);
  const waitlistEditable = event.status === 'registration' || event.status === 'checkin';

  async function saveWaitlist(enabled: boolean, autoPromote: boolean) {
    setWaitlistSaving(true);
    const res = await setEventWaitlist(event.id, { enabled, autoPromote });
    setWaitlistSaving(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    setWaitlistEnabled(enabled);
    setWaitlistAuto(autoPromote);
    toast(
      res.data.promoted > 0
        ? `Waitlist updated, ${res.data.promoted} entered from it`
        : 'Waitlist updated',
      'success',
    );
    router.refresh();
  }

  // A round robin produces standings rather than consuming them, and a
  // pool_to_bracket event produces its own and consumes them itself.
  const seedableSiblings = playsRoundRobin(event.format) ? [] : siblings;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    // A BLANK BOX IS REFUSED RATHER THAN TREATED AS "NO CHANGE".
    //
    // The field opens on the event's current value, so it is never legitimately
    // empty — an exec who has cleared it is mid-edit. Omitting the key would
    // leave the stored weight untouched AND toast success, so the exec would
    // walk away believing they had cleared a number that is still set. That is
    // the same silent-no-op the seed_by null-rewrite was fixed for; say so
    // instead.
    if (stagesOnly) {
      setLoading(true);
      const res = await updateTournamentEvent(event.id, { format_config: stagedConfig });
      setLoading(false);
      if (!res.ok) { toast(res.error, 'error'); return; }
      toast('Stages updated', 'success');
      onClose();
      router.refresh();
      return;
    }
    if (pointsOnly) {
      setLoading(true);
      const res = await updateTournamentEvent(event.id, { points_config: pointsConfig });
      setLoading(false);
      if (!res.ok) { toast(res.error, 'error'); return; }
      toast('Points updated', 'success');
      onClose();
      router.refresh();
      return;
    }
    if (eloMultiplier.trim() === '') {
      toast('Enter an Elo multiplier, or set it back to 1.25 for the usual weighting.', 'error');
      return;
    }
    setLoading(true);
    try {
      const res = await updateTournamentEvent(event.id, switchingToStages ? {
        format: 'staged',
        format_config: stagedConfig,
        max_participants: maxParticipants === '' ? null : Number(maxParticipants),
        elo_multiplier: Number(eloMultiplier),
      } : {
        ...toFormatPayload(
          playsRoundRobin(event.format) || staged ? { ...values, seededFrom: '' } : values,
          event.format,
        ),
        ...(staged ? { format_config: stagedConfig } : { points_config: pointsConfig }),
        max_participants: maxParticipants === '' ? null : Number(maxParticipants),
        // Always sent — handleSave refuses a blank box above, so there is no
        // path here that could quietly omit it and report success.
        elo_multiplier: Number(eloMultiplier),
      });
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast('Event updated', 'success');
      onClose();
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to update event', 'error');
    }
    setLoading(false);
  }

  return (
    <Dialog open onClose={onClose} title="Event Settings">
      <form onSubmit={handleSave} className="space-y-4">
        {!staged && !pointsOnly && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <Switch
              label="Set it out in stages"
              description={switchingToStages
                ? 'Build the event stage by stage: groups, knockouts and one-off matches, and who goes through from each. Saving switches the format for good.'
                : 'For any shape the format below cannot make, such as the best 8 from 3 groups, a playoff, or placement matches.'}
              checked={switchingToStages}
              onChange={setSwitchingToStages}
            />
          </div>
        )}
        {editingStages && (
          <StagedFormatEditor
            value={stagedConfig}
            onChange={setStagedConfig}
            drawn={drawn}
            stored={storedConfig}
            external={unrated}
          />
        )}
        {!stagesOnly && !pointsOnly && (<>
        {!editingStages && <EventFormatFields
          value={values}
          onChange={setValues}
          siblings={seedableSiblings}
          format={event.format}
          fieldSize={totalEntries}
          // The dialog's own live state, not the stored row — the ladder above
          // recomputes as the exec types in the Elo Multiplier box below, which
          // is the only way to see what the change does before saving it.
          // create-event does the same for the same reason; passing
          // event.elo_multiplier here would make the two dialogs disagree about
          // what a round is worth while one of them is being edited.
          eloMultiplier={eloMultiplier}
        />}
        <Input
          label={values.seededFrom === '' ? 'Max Participants (optional)' : 'Bracket Size (how many qualify)'}
          type="number"
          min={2}
          value={maxParticipants}
          onChange={(e) => setMaxParticipants(e.target.value)}
          placeholder={values.seededFrom === '' ? 'Leave empty for unlimited' : 'Leave empty to take the whole pool'}
        />
        {/* AT THE TOP LEVEL OF THE FORM, beside Max Participants — NOT inside
            EventFormatFields. Every control in that component sits behind one of
            `poolToBracket`, `isRoundRobin`, `offerSeedSkip`, `ranksAPool` or
            `siblings.length > 0`, and all five are false on a plain
            single-elimination event with no sibling pool. Nesting it there is
            how "Rank The Pool By" and the seed-skip control each ended up
            unreachable on the format they existed for. create-event keeps its
            copy outside the component for the same reason. */}
        <Input
          label="Elo Multiplier"
          type="number"
          min={ELO_MULTIPLIER_BOUNDS.min}
          max={ELO_MULTIPLIER_BOUNDS.max}
          step={ELO_MULTIPLIER_BOUNDS.step}
          value={eloMultiplier}
          onChange={(e) => setEloMultiplier(e.target.value)}
        />
        <p className="text-xs text-[var(--text-muted)] -mt-2">
          How hard this event moves ratings, on top of each round&rsquo;s own weight. A rated challenge is{' '}
          <span className="font-mono text-[var(--text-secondary)]">1.00</span>; the usual tournament is{' '}
          <span className="font-mono text-[var(--text-secondary)]">1.25</span>.{' '}
          {/* SAID PLAINLY, because the alternative is an exec discovering it by
              trying. It is read once per RESULT, not stamped on the draw, so
              changing it after some rounds had been rated would leave the event
              with two different weights in its history and nothing recording
              which match got which — the ladder above would then print a figure
              that was never applied to the earlier rounds. The settings gate
              refuses at the draw rather than at the first result, which is
              stricter and needs no bookkeeping. */}
          <span className="font-medium text-[var(--text-primary)]">
            Fixed once this event&rsquo;s draw is generated
          </span>{' '}
          — matches already rated keep the weight they were rated at, and nothing records which was which, so it
          cannot be changed underneath a draw that has started.
        </p>
        </>)}
        {!editingStages && <PointsTableEditor format={event.format} value={pointsConfig} onChange={setPointsConfig} />}
        {!external && (
          <div className="space-y-1 border-t border-[var(--border)] pt-3">
            {waitlistReady ? (
              <>
                <Switch
                  label="Waitlist"
                  description={waitlistEditable
                    ? 'When the event is full, members can queue for a place.'
                    : 'Can only be changed while the event is taking entries or checking in.'}
                  checked={waitlistEnabled}
                  disabled={!waitlistEditable || waitlistSaving}
                  onChange={(next) => saveWaitlist(next, waitlistAuto)}
                />
                {waitlistEnabled && (
                  <Switch
                    label="Promote automatically when a place frees up"
                    description="Off: you promote members from the Participants tab yourself."
                    checked={waitlistAuto}
                    disabled={!waitlistEditable || waitlistSaving}
                    onChange={(next) => saveWaitlist(waitlistEnabled, next)}
                  />
                )}
              </>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">Waitlist: run migration 00278 first.</p>
            )}
          </div>
        )}
        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading} disabled={stagedErrors.length > 0}>Save Changes</Button>
        </div>
      </form>
    </Dialog>
  );
}
