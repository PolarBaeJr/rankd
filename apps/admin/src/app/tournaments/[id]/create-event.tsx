'use client';

import { useState } from 'react';
import { Button, Dialog, Select, Input } from '@badminton/ui';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_FORMAT_LABELS,
  TOURNAMENT_EVENT_FORMAT_HINTS,
  isDoublesEvent,
  isPoolToBracket,
  playsRoundRobin,
  ELO_MULTIPLIER_BOUNDS,
  poolsThenPlacement,
  withEveryStageUnrated,
} from '@badminton/shared';
import { createTournamentEvent } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { TournamentEventType, TournamentEventFormat, TournamentSeedingMethod, FormatConfig, FormatPoints } from '@badminton/shared';
import { stagedEditorErrors } from '@/lib/staged-editor';
import { StagedFormatEditor } from './staged-format-editor';
import { PointsTableEditor } from './points-table-editor';
import {
  EventFormatFields,
  EMPTY_FORMAT_VALUES,
  inheritableFrom,
  toFormatPayload,
  type EventFormatValues,
  type SiblingEvent,
} from './event-format-fields';

export function CreateEventButton({
  tournamentId,
  siblings = [],
  // The TOURNAMENT's multiplier, used as this event's starting value. Before
  // 00109 that number was shown to players as "1.15x MULTIPLIER" while every
  // event was created at 1.25 and the rating maths only ever read the EVENT —
  // so the figure on the page was not the one applied to anyone's rating.
  // Seeding from it here is what makes the display honest; the event's own
  // value still decides, so an exec can still differ one event deliberately.
  defaultEloMultiplier,
  // The tournament's placement bonus switch, as each new event's starting
  // value. It was read by nothing that pays: the finaliser reads only the
  // event's own column, which every event took as true. The event's column
  // still decides; events created before this keep what they have.
  defaultPlacementBonus = true,
  // The event standard (event_standard_defaults): a new event opens as pools
  // then placement, the club's usual shape. Off, the old single elimination.
  standardDefaults = false,
}: {
  tournamentId: string;
  siblings?: SiblingEvent[];
  defaultEloMultiplier?: number | null;
  defaultPlacementBonus?: boolean;
  standardDefaults?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [eventType, setEventType] = useState<TournamentEventType>('mens_singles');
  const [format, setFormat] = useState<TournamentEventFormat>(standardDefaults ? 'staged' : 'single_elimination');
  const [formatValues, setFormatValues] = useState<EventFormatValues>(EMPTY_FORMAT_VALUES);
  const [maxParticipants, setMaxParticipants] = useState('');
  const [seedingMethod, setSeedingMethod] = useState<TournamentSeedingMethod>('elo');
  const [eloMultiplier, setEloMultiplier] = useState(String(defaultEloMultiplier ?? 1.25));
  // External teams (00269): entered by name, unrated, always a doubles round robin.
  const [externalEvent, setExternalEvent] = useState(false);
  // A staged event's stages (00272), opened on the organiser's own preset.
  const [stagedConfig, setStagedConfig] = useState<FormatConfig>(() => poolsThenPlacement());
  // A legacy event's points table (00275); null is the format's default.
  const [pointsConfig, setPointsConfig] = useState<FormatPoints | null>(null);
  const staged = format === 'staged';
  const stagedErrors = staged ? stagedEditorErrors(stagedConfig, null, new Set()) : [];
  const { toast } = useToast();
  const router = useRouter();

  // Seeded when the dialog OPENS, not once on mount: creating an event
  // refreshes the page and changes what there is to inherit from, and a
  // mount-time initialiser would keep offering the FIRST event's shape all
  // session. Opening is also the only moment the exec can be surprised by it.
  function openDialog() {
    const inherited = inheritableFrom(siblings);
    setFormatValues(inherited ? { ...EMPTY_FORMAT_VALUES, ...inherited } : EMPTY_FORMAT_VALUES);
    setStagedConfig(externalEvent ? withEveryStageUnrated(poolsThenPlacement()) : poolsThenPlacement());
    setPointsConfig(null);
    setOpen(true);
  }

  // A round robin has no draw to seed, so the pool picker is meaningless there.
  //
  // AND ONLY POOLS THAT COULD ACTUALLY SEED THIS EVENT. The picker used to
  // offer every sibling, so a men's SINGLES knockout could be pointed at a
  // men's DOUBLES pool — buildFieldFromPool refuses that ("A doubles event
  // cannot be seeded from a singles pool, or the other way round"), but not
  // until the draw is generated. The exec sets the event up, sees "Seeded from
  // pool by points" on the header, waits for the pool to finish, presses
  // Generate on the day, and only then finds out it was never going to work.
  // Two filters, both matching what the server will insist on:
  //   * round_robin only — standings come from pool play; a bracket has none.
  //   * same doubles-ness — singles standings are participant rows and doubles
  //     standings are pair rows, and there is no sensible way to carry one into
  //     the other.
  //
  // AND NONE AT ALL FOR pool_to_bracket (00107). That format plays its own pool
  // inside this one event, so an external link would be a second, contradictory
  // field for the same bracket — the server refuses it outright, and offering
  // the picker would be an invitation to be refused.
  // A staged event draws its first stage from its own field, never a pool.
  const seedableSiblings =
    playsRoundRobin(format) || staged
      ? []
      : siblings.filter(
          (s) =>
            s.format === 'round_robin' &&
            isDoublesEvent(s.event_type as TournamentEventType) === isDoublesEvent(eventType),
        );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await createTournamentEvent(tournamentId, {
        event_type: eventType,
        format,
        ...toFormatPayload(
          playsRoundRobin(format) || staged ? { ...formatValues, seededFrom: '' } : formatValues,
          format,
        ),
        ...(staged ? { format_config: stagedConfig } : { points_config: pointsConfig }),
        max_participants: maxParticipants ? Number(maxParticipants) : undefined,
        seeding_method: seedingMethod,
        elo_multiplier: Number(eloMultiplier) || 1.25,
        placement_bonus_enabled: defaultPlacementBonus,
        external_event: externalEvent,
      });
      // Format and pool-link validation come back as a refusal message, not an
      // exception — show the exec which field they need to fix.
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast('Event created', 'success');
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create event', 'error');
    }
    setLoading(false);
  }

  const eventTypeOptions = Object.entries(TOURNAMENT_EVENT_TYPE_LABELS).map(([value, label]) => ({ value, label }));

  return (
    <>
      <Button size="sm" onClick={openDialog}>
        <Plus className="w-4 h-4 mr-1" /> Add Event
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Create Tournament Event">
        <form onSubmit={handleCreate} className="space-y-4">
          <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5">
            <input
              type="checkbox"
              checked={externalEvent}
              onChange={(e) => {
                const on = e.target.checked;
                setExternalEvent(on);
                if (on) {
                  // An external event is a doubles round robin, or a staged
                  // event with every stage unrated.
                  if (format !== 'staged') { setFormat('round_robin'); setPointsConfig(null); }
                  setStagedConfig(withEveryStageUnrated(stagedConfig));
                  if (!isDoublesEvent(eventType)) setEventType('open_doubles');
                  setFormatValues({ ...formatValues, seededFrom: '' });
                }
              }}
              className="mt-0.5 accent-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
            />
            <span>
              <span className="text-sm font-medium text-[var(--text-primary)] block">
                External event (teams entered by name, unrated)
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                For teams without member accounts. You add each team by typing two names; members cannot sign up.
                Always doubles, played as a Round Robin or in Stages, and no result moves anybody&rsquo;s rating.
                Cannot be changed later.
              </span>
            </span>
          </label>
          <Select
            label="Event Type"
            value={eventType}
            onChange={(e) => setEventType(e.target.value as TournamentEventType)}
            options={externalEvent
              ? eventTypeOptions.filter((o) => isDoublesEvent(o.value as TournamentEventType))
              : eventTypeOptions}
          />
          <Select
            label="Format"
            value={format}
            onChange={(e) => {
              const next = e.target.value as TournamentEventFormat;
              setFormat(next);
              // Each format has its own default table; one set for another
              // format would pay by the wrong rule.
              setPointsConfig(null);
              // The qualifier count means different things on the two pool
              // shapes, so the default follows the format rather than being
              // left at whatever the last one wanted: 2 out of each of several
              // groups is the usual group stage, 2 out of one flat pool is a
              // final and nothing else. Matches normalizeGroupShape server-side.
              if (isPoolToBracket(next) && formatValues.groupCount === '') {
                setFormatValues({ ...formatValues, qualifiersPerGroup: '4' });
              }
            }}
            options={Object.entries(TOURNAMENT_EVENT_FORMAT_LABELS)
              .filter(([value]) => !externalEvent || value === 'round_robin' || value === 'staged')
              .map(([value, label]) => ({ value, label }))}
          />
          <p className="text-xs text-[var(--text-muted)] -mt-2">
            {TOURNAMENT_EVENT_FORMAT_HINTS[format]}
          </p>
          {/* eloMultiplier is the dialog's own live state, not the tournament
              default, so the ladder's weights move as the exec types in the Elo
              Multiplier box further down — which is the only way to see what
              changing it does before the event exists. */}
          {staged ? (
            <StagedFormatEditor
              value={stagedConfig}
              onChange={setStagedConfig}
              drawn={new Set()}
              stored={null}
              external={externalEvent}
            />
          ) : (
            <EventFormatFields
              value={formatValues}
              onChange={setFormatValues}
              siblings={seedableSiblings}
              format={format}
              eloMultiplier={eloMultiplier}
            />
          )}
          {!staged && <PointsTableEditor format={format} value={pointsConfig} onChange={setPointsConfig} />}
          <Input
            label="Max Participants (optional)"
            type="number"
            value={maxParticipants}
            onChange={(e) => setMaxParticipants(e.target.value)}
            placeholder="Leave empty for unlimited"
          />
          {!staged && <Select
            label="Seeding Method"
            value={seedingMethod}
            onChange={(e) => setSeedingMethod(e.target.value as TournamentSeedingMethod)}
            // "Manual" is the one option that changes how the DRAW is made and
            // not just how the seeds are worked out: every other method has the
            // bracket drawn at random within its seeding tiers, so a redraw
            // gives a different draw, while manual places the field exactly
            // where its seed numbers say and redraws identically. The label has
            // to say so — it is the only opt-out, and it is invisible otherwise.
            options={[
              { value: 'elo', label: 'Auto-seed by Elo' },
              { value: 'manual', label: 'Manual — draw follows the seeds exactly' },
              { value: 'random', label: 'Random' },
            ]}
          />}
          {/* The same bounds the edit form and the server use. This box was
              unbounded, which mattered more than it looks: the column has no
              CHECK, eventEloMultiplier() is `Number(raw) || 1.25`, and so a
              negative inverted the event, a 0 silently became 1.25, and 125 for
              1.25 multiplied every rating change in the draw by a hundred. */}
          {!externalEvent && (<>
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
            <span className="font-mono text-[var(--text-secondary)]">1.25</span>. It can still be changed from Event
            Settings, up until the draw is generated.
          </p>
          </>)}
          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
            <Button type="submit" loading={loading} disabled={stagedErrors.length > 0}>Create Event</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
