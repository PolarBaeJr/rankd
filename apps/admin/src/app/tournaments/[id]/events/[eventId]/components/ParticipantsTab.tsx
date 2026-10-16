'use client';

import { useState, useRef } from 'react';
import { Button, Dialog, Input, PlayerPicker, AvatarChip, Select, useConfirm } from '@badminton/ui';
import {
  addParticipantsToEvent,
  removeParticipantFromEvent,
  addPairToEvent,
  addExternalPairToEvent,
  removePairFromEvent,
  unpairEntry,
  withdrawPairMember,
  swapPairMember,
  autoSeedEventByElo,
  updateParticipantSeed,
  updatePairSeed,
  clearSeeds,
  assignEventGroups,
  updateParticipantGroup,
  updatePairGroup,
  withdrawParticipant,
  withdrawPair,
  autoPairWaitingEntrants,
  setPairCategory,
  requestPairCategoryChange,
  promoteFromWaitlist,
  removeFromWaitlist,
} from '@/lib/tournament-actions';
import { summarizeBulk } from '@/lib/bulk-add';
import { participantControls, type DrawCapabilities } from '@/lib/participant-controls';
import {
  nextPowerOf2, pickOne, isOutOfEvent, eventIsPlaying, categoryRequiredBy, groupLabel,
  parseFormatConfig, pickCategory, categoryForEventType, suggestCategory, toCompetitionCategory,
  doublesDrawSlots, wouldExceedCapacity, formatDateTime,
  type FormatCategory, type TournamentEventType,
} from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, ArrowUpDown, AlertTriangle, XCircle, Pencil, UserMinus, Unlink, Users, Replace, Shuffle, LayoutGrid, Clock } from 'lucide-react';
import type { TournamentEventRow, ParticipantWithPlayer, PairWithPlayers, WaitlistEntry, CategoryRequest } from '@/lib/tournament-types';
import type { EventWaiverStatus } from '@badminton/shared';
import { WaiverState } from './WaiverState';

interface Props {
  event: TournamentEventRow;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  allPlayers: Array<{ id: string; full_name: string; avatar_url?: string | null }>;
  isDoubles: boolean;
  // What the viewer may DO, resolved on the server against the same
  // capabilities the actions below re-check. Every control on this tab is gated
  // on one of these AND on the event's status — see participantControls().
  capabilities: DrawCapabilities;
  // null = draw no waiver column. See WaiverState.
  waiverStates: Record<string, EventWaiverStatus> | null;
  // Members queueing for a place (00278), first in line first. null before
  // that migration, and for an external event: no section at all.
  waitlist?: WaitlistEntry[] | null;
  // Category changes waiting for approval (00279), so a team's cell can say
  // one is pending. null before that migration.
  categoryRequests?: CategoryRequest[] | null;
  // Entries a Google Form made (00283), by participant or pair id, with the
  // import's status. Empty or absent: no badges.
  imported?: Record<string, 'entered' | 'awaiting_partner'> | null;
}

// A small tag beside an entry a Google Form made. "Awaiting partner" is a
// member who confirmed and is waiting for the partner they named to confirm.
function ImportedTag({ status }: { status: 'entered' | 'awaiting_partner' | undefined }) {
  if (!status) return null;
  return (
    <span className="ml-2 inline-block rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
      {status === 'awaiting_partner' ? 'Form: awaiting partner' : 'Form'}
    </span>
  );
}

// Raw enum values ("checked_in") leaked straight into the table. Underscores
// and lowercase read as database internals rather than a status an exec is
// meant to act on.
const STATUS_LABELS: Record<string, string> = {
  registered: 'Registered',
  checked_in: 'Checked In',
  withdrawn: 'WITHDRAWN',
  disqualified: 'DISQUALIFIED',
  no_show: 'NO SHOW',
};

// The two that take someone OUT of the event are shouted, so they are
// unmissable when scanning a long list; the ordinary states are not.
function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

const STATUS_COLORS: Record<string, string> = {
  registered: 'var(--text-muted)',
  checked_in: 'var(--color-success)',
  withdrawn: 'var(--color-danger)',
  disqualified: 'var(--color-danger)',
  no_show: 'var(--color-warning)',
};

function SeedCell({
  entryId,
  seedNumber,
  canEdit,
  maxSeed,
  usedSeeds,
  onSave,
}: {
  entryId: string;
  seedNumber: number | null;
  canEdit: boolean;
  maxSeed: number;
  usedSeeds: Set<number>;
  onSave: (id: string, seed: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(seedNumber != null ? String(seedNumber) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    if (!canEdit) return;
    setValue(seedNumber != null ? String(seedNumber) : '');
    setError('');
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  async function commit() {
    const parsed = value.trim() === '' ? null : parseInt(value, 10);
    if (parsed !== null && (isNaN(parsed) || parsed < 1)) {
      setError('Min 1');
      return;
    }
    if (parsed !== null && parsed > maxSeed) {
      setError(`Max ${maxSeed}`);
      return;
    }
    if (parsed !== null && parsed !== seedNumber && usedSeeds.has(parsed)) {
      setError('Taken');
      return;
    }
    if (parsed === seedNumber) { setEditing(false); return; }
    setSaving(true);
    await onSave(entryId, parsed);
    setSaving(false);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="number"
          min={1}
          max={maxSeed}
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(''); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label="Seed number"
          className={`w-12 text-center text-sm font-mono bg-[var(--bg-elevated)] border rounded px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 ${error ? 'border-[var(--color-danger)]' : 'border-[var(--color-accent)]'}`}
          autoFocus
        />
        {error && <span className="text-[10px] text-[var(--color-danger)]">{error}</span>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      disabled={!canEdit || saving}
      aria-label={`Edit seed${seedNumber != null ? ` ${seedNumber}` : ''}`}
      className={`group flex items-center gap-1 text-sm font-mono text-[var(--text-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none rounded ${canEdit ? 'hover:text-[var(--text-primary)] cursor-pointer' : ''}`}
    >
      {saving ? (
        <span className="opacity-50">…</span>
      ) : (
        <>
          <span>{seedNumber != null ? `#${seedNumber}` : '—'}</span>
          {canEdit && (
            <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity" />
          )}
        </>
      )}
    </button>
  );
}

/**
 * Which group one entry is in, as a picker (00106).
 *
 * A SELECT AND NOT A NUMBER BOX, unlike SeedCell next to it, because the range
 * is tiny and closed — there are group_count groups and no other legal value —
 * so a free-text field could only ever produce a refusal the picker prevents.
 * It is also how the override is discovered: a dropdown showing "A" says there
 * are other letters, where "#3" says nothing at all.
 */
function GroupCell({
  entryId,
  groupNumber,
  groupCount,
  canEdit,
  onSave,
}: {
  entryId: string;
  groupNumber: number | null;
  groupCount: number;
  canEdit: boolean;
  onSave: (id: string, group: number) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  if (!canEdit) {
    return (
      <span className="text-sm font-mono text-[var(--text-muted)]">
        {groupNumber != null ? groupLabel(groupNumber) : '—'}
      </span>
    );
  }

  return (
    <Select
      variant="bare"
      value={groupNumber == null ? '' : String(groupNumber)}
      disabled={saving}
      aria-label="Group"
      placeholder="Unset"
      onChange={async (e) => {
        const next = Number(e.target.value);
        if (!next || next === groupNumber) return;
        setSaving(true);
        await onSave(entryId, next);
        setSaving(false);
      }}
      options={Array.from({ length: groupCount }, (_, i) => ({
        value: String(i + 1),
        label: groupLabel(i + 1),
      }))}
      className="text-sm font-mono bg-[var(--bg-elevated)] border border-[var(--border)] rounded-[6px] px-1.5 py-0.5 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50"
    />
  );
}

/**
 * A team's category in a staged event (00272): what the stage's head starts
 * read for it. A key the event no longer lists is shown as removed and stays
 * selectable, so the cell never claims a team is something it is not.
 */
function CategoryCell({
  pairId,
  category,
  categories,
  suggestion,
  canEdit,
  onSave,
  pending,
}: {
  pairId: string;
  category: string | null;
  categories: FormatCategory[];
  suggestion: string | null;
  canEdit: boolean;
  onSave: (id: string, category: string | null) => Promise<void>;
  /** A change waiting for approval (00279). The cell names it and stays put until it is decided. */
  pending?: { to: string | null };
}) {
  const [saving, setSaving] = useState(false);
  const known = category == null || categories.some((c) => c.key === category);
  const labelOf = (key: string) => categories.find((c) => c.key === key)?.label ?? `${key} (removed)`;
  const hint = pending
    ? <span className="block text-xs text-[var(--text-muted)]">Change requested: {pending.to == null ? 'Unset' : labelOf(pending.to)}</span>
    : category == null && suggestion
      ? <span className="block text-xs text-[var(--text-muted)]">Suggested: {labelOf(suggestion)}</span>
      : null;

  if (!canEdit) {
    return (
      <>
        <span className="text-sm text-[var(--text-muted)]">{category != null ? labelOf(category) : 'Unset'}</span>
        {hint}
      </>
    );
  }

  return (
    <>
      <Select
        variant="bare"
        value={category ?? ''}
        disabled={saving || pending != null}
        aria-label="Category"
        onChange={async (e) => {
          const next = e.target.value === '' ? null : e.target.value;
          if (next === category) return;
          setSaving(true);
          await onSave(pairId, next);
          setSaving(false);
        }}
        options={[
          { value: '', label: 'Unset' },
          ...categories.map((c) => ({ value: c.key, label: c.label })),
          ...(known || category == null ? [] : [{ value: category, label: labelOf(category) }]),
        ]}
        className="text-sm bg-[var(--bg-elevated)] border border-[var(--border)] rounded-[6px] px-1.5 py-0.5 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50"
      />
      {hint}
    </>
  );
}

export function ParticipantsTab({ event, participants, pairs, allPlayers, isDoubles, capabilities, waiverStates, waitlist = null, categoryRequests = null, imported = null }: Props) {
  const [addOpen, setAddOpen] = useState(false);
  // Doubles adds a PAIR — two named people, one entry — so it keeps two
  // single-select fields. Singles adds any number of individuals at once.
  const [playerId, setPlayerId] = useState('');
  const [player2Id, setPlayer2Id] = useState('');
  const [playerIds, setPlayerIds] = useState<string[]>([]);
  // Which of the two doubles entry routes the Add dialog is on. A doubles event
  // takes both — a formed team, or a person who will be given a partner — and
  // they are different actions asking different capabilities.
  const [addMode, setAddMode] = useState<'pair' | 'solo'>('pair');
  // 00111 — the exec's way past a competition-category refusal, for the social
  // event where the club has agreed to it.
  //
  // AN EXPLICIT, UNCHECKED CHOICE MADE BEFORE THE ADD, not a retry offered
  // after one. A refusal the app immediately offers to undo teaches the exec to
  // press through it without reading; a box they have to reach for is a
  // decision. Reset every time the dialog opens, so an override can never
  // outlive the one add it was meant for, and shown only on an event that has a
  // rule to override.
  const [ignoreCategories, setIgnoreCategories] = useState(false);
  // The unpaired entrants ticked for pairing. Exactly two makes a team.
  const [selectedUnpaired, setSelectedUnpaired] = useState<string[]>([]);
  // Its own flag rather than sharing `loading` with "Pair selected": both
  // buttons sit in the same header, and one spinner on both would say the wrong
  // one is working.
  const [autoPairing, setAutoPairing] = useState(false);
  // The pair whose halves are being offered a withdrawal, or null.
  const [splitting, setSplitting] = useState<PairWithPlayers | null>(null);
  // The pair being edited, and which half is on the way out. Two steps in one
  // dialog: pick who is leaving, then pick who takes their place.
  const [swapping, setSwapping] = useState<PairWithPlayers | null>(null);
  const [outgoingId, setOutgoingId] = useState<string>('');
  const [incomingId, setIncomingId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // An external event (00269): teams are typed in by name, never picked from members.
  const externalEvent = event.external_event === true;
  const [externalOpen, setExternalOpen] = useState(false);
  const [externalName1, setExternalName1] = useState('');
  const [externalName2, setExternalName2] = useState('');
  const [externalTeamName, setExternalTeamName] = useState('');
  // A staged event (00272): each team's category drives its head starts.
  const stagedCfg = event.format === 'staged' ? parseFormatConfig(event.format_config) : null;
  const defaultExternalCategory = pickCategory(stagedCfg, categoryForEventType(event.event_type)) ?? '';
  const [externalCategory, setExternalCategory] = useState(defaultExternalCategory);
  // A change to a team that has played with head starts is a request with a
  // reason (00279). Set when setPairCategory answers that one is required.
  const [categoryAsk, setCategoryAsk] = useState<{ pairId: string; name: string; to: string | null } | null>(null);
  const [categoryReason, setCategoryReason] = useState('');
  const [categoryAsking, setCategoryAsking] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  // THE DRAW IS PAIRS AND ONLY PAIRS, in a doubles event. `entries` feeds the
  // bracket-size preview and the seed cells, and an unpaired entrant is not an
  // entry in the draw — they are a person waiting to become half of one. The
  // pool is rendered as its own block below, deliberately outside this.
  const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
  const activeEntries = entries.filter((e) => !isOutOfEvent(e.status));
  // Since 00102 a doubles event's tournament_participants rows are the people
  // who entered without a partner. In a singles event they ARE the field, and
  // this list is empty.
  const unpaired = isDoubles ? participants : [];
  const activeUnpaired = unpaired.filter((p) => !isOutOfEvent(p.status));

  // WITHDRAWN ENTRIES LEAVE THE LIVE LISTS AND GO TO THEIR OWN BLOCK.
  //
  // `activeUnpaired` was computed here and then used ONLY for the counts, while
  // both tables iterated the raw lists — so the "Waiting for a partner" heading
  // said six people over a table of seven rows, and the block rendered at all
  // whenever a withdrawn row existed even if nobody was actually waiting. The
  // heading and the rows now read the same list, which is the fix.
  //
  // 'no_show' DELIBERATELY STAYS IN THE LIVE LIST. isOutOfEvent is withdrawn and
  // disqualified only — packages/shared/src/utils/tournament-withdrawal.ts says
  // why in its own words: a no-show is somebody who took a place and did not use
  // it, so they still hold their slot, still spend an entry-cap allowance and
  // still appear in a draw that was already generated around them. Moving them
  // into a block headed "Withdrawn" would say the opposite of all three.
  // `activeEntries` above is already this list — the table simply was not using
  // it, which is how the withdrawn rows got in.
  const withdrawnPairs = isDoubles ? pairs.filter((p) => isOutOfEvent(p.status)) : [];
  const withdrawnSolo = (isDoubles ? unpaired : participants).filter((p) => isOutOfEvent(p.status));
  const withdrawnCount = withdrawnPairs.length + withdrawnSolo.length;

  // A pool_to_bracket event's entry list feeds a ROUND ROBIN first, not a
  // bracket (00107), so it shows no draw size here at all — the knockout's
  // field is decided by the pool, and quoting a 32-slot bracket for 24 entrants
  // would describe an event that never happens. The header shows the real
  // figure once the qualifiers are known.
  // 00111 — does this event have a competition-category rule at all? Open
  // Singles and Open Doubles do not, and their dialogs must not raise the
  // subject: an override control on an event with nothing to override is an
  // invitation to a question nobody asked.
  const gendered = categoryRequiredBy(event.event_type as TournamentEventType) !== null;
  const showsBracketSize = event.format === 'single_elimination';
  const bracketSize = nextPowerOf2(activeEntries.length);
  const byes = bracketSize - activeEntries.length;
  const drawLocked = event.draw_locked as boolean;
  const eventLive = eventIsPlaying(event.status);
  // WHAT IS ON SCREEN, decided by status AND capability together.
  //
  // This was a single `event.status === 'registration'`, so every control here
  // rendered for anybody the event page admitted and the server action refused
  // on click. Deleting an entry is still only safe before a draw exists — after
  // that the only coherent exit is a withdrawal, which forfeits the matches they
  // are already seeded into, and it has to be reachable here because this is the
  // moment the player themselves is no longer allowed to do it. That rule has
  // not moved; it now has to be held by somebody who may actually perform it.
  const controls = participantControls(
    { status: event.status as string, drawLocked, staged: event.format === 'staged' },
    capabilities,
  );
  const pendingCategory = (pairId: string) => {
    const request = categoryRequests?.find((r) => r.pair_id === pairId);
    return request ? { to: request.to_category } : undefined;
  };

  // Whether a promotion has room, by the rule enter_tournament_event uses:
  // rows for singles, pairs plus one slot per two unpaired for doubles. The
  // function decides under its lock; this only disables a button that would
  // be refused.
  const eventFull = isDoubles
    ? wouldExceedCapacity(
      doublesDrawSlots(activeEntries.length, activeUnpaired.length),
      doublesDrawSlots(activeEntries.length, activeUnpaired.length + 1),
      event.max_participants,
    )
    : event.max_participants != null && event.max_participants > 0
      && activeEntries.length >= event.max_participants;
  const waitlistOpen = (event.status === 'registration' || event.status === 'checkin') && !drawLocked;

  // GROUPS (00106). Structural reads, following max_events_per_player: the
  // columns are not in the generated Database type until the migration has been
  // run and the types regenerated against the database it changed.
  const groupCount = (event as { group_count?: number | null }).group_count ?? 1;
  const isGroupStage = groupCount >= 2;
  // OFFERED ONLY WHERE IT WOULD WORK. Both group writes refuse once the
  // fixtures exist, so the status is the honest proxy for it here — this tab is
  // not handed the match list, and a control that always refuses is the dead
  // invitation the rest of this file's gating exists to remove. The capabilities
  // are the ones the actions themselves re-check: dealing the whole field is
  // draw generation, moving one entry is setting one seed.
  const groupsEditable = isGroupStage && !drawLocked
    && (event.status === 'registration' || event.status === 'checkin');
  const showAssignGroups = groupsEditable && capabilities.generate;
  const canEditGroup = groupsEditable && controls.editSeed;

  async function handleAddPair(e: React.FormEvent) {
    e.preventDefault();
    if (!playerId) return;
    setLoading(true);
    if (!player2Id) { toast('Select both players', 'error'); setLoading(false); return; }
    // Result, not try/catch: addPairToEvent returns its refusals so they survive
    // production's redaction of thrown Server Action errors. The entry-cap
    // refusal names which half of the pair is at their limit, and that sentence
    // is the whole reason the exec can fix it on the spot.
    const res = await addPairToEvent(event.id, playerId, player2Id, {
      allowCategoryMismatch: ignoreCategories,
    });
    if (!res.ok) {
      toast(res.error, 'error');
      setLoading(false);
      return;
    }
    toast('Added successfully', 'success');
    setAddOpen(false);
    setPlayerId('');
    setPlayer2Id('');
    router.refresh();
    setLoading(false);
  }

  async function handleAddMany(e: React.FormEvent) {
    e.preventDefault();
    if (playerIds.length === 0) return;
    setLoading(true);
    // ONE request for the whole selection. This used to be a runBulk loop, which
    // meant one server action per player and a page re-render on each — adding
    // a 60-player field took long enough that it read as a hang.
    let outcome: { succeeded: string[]; failures: { id: string; message: string }[] };
    try {
      const result = await addParticipantsToEvent(event.id, playerIds, {
        allowCategoryMismatch: ignoreCategories,
      });
      outcome = { succeeded: result.added, failures: result.failures };
    } catch (err) {
      // A throw here is a whole-batch refusal (locked draw, wrong status, a race
      // on the unique index) — nobody went in, so every id is a failure and the
      // dialog keeps the full selection.
      const message = err instanceof Error ? err.message : 'Failed';
      outcome = { succeeded: [], failures: playerIds.map((id) => ({ id, message })) };
    }
    const { message, tone } = summarizeBulk(outcome, {
      done: 'Added', failed: 'Could not add', noun: 'player',
    });
    toast(message, tone);
    // Anyone the event refused (already registered, event full) stays in the
    // picker so the exec can see exactly who did not make it in.
    setPlayerIds(outcome.failures.map((f) => f.id));
    if (outcome.failures.length === 0) setAddOpen(false);
    // Refresh even on a partial run — the ones that DID go in belong in the table.
    router.refresh();
    setLoading(false);
  }

  async function handleRemove(id: string) {
    setActionLoading(id);
    try {
      if (isDoubles) {
        await removePairFromEvent(id);
      } else {
        await removeParticipantFromEvent(id);
      }
      toast('Removed', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setActionLoading(null);
  }

  // An unpaired entrant is a tournament_participants row whatever the event's
  // discipline, so this is the singles remove — not removePairFromEvent.
  async function handleRemoveUnpaired(id: string) {
    setActionLoading(id);
    try {
      await removeParticipantFromEvent(id);
      toast('Removed', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setActionLoading(null);
  }

  // THE WAITLIST (00278). Promote enters the member under the field lock,
  // with the same checks as their own entry; the function decides, this only
  // says what it decided.
  async function handlePromoteWaiting(entry: WaitlistEntry) {
    setActionLoading(entry.id);
    const res = await promoteFromWaitlist(entry.id);
    setActionLoading(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(`${entry.player?.full_name ?? 'Member'} entered from the waitlist`, 'success');
    router.refresh();
  }

  async function handleRemoveWaiting(entry: WaitlistEntry) {
    const name = entry.player?.full_name ?? 'this member';
    const ok = await confirm({
      title: 'Remove from the waitlist?',
      message: `${name} loses their place in the queue. They can join again while the event is full.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setActionLoading(entry.id);
    const res = await removeFromWaitlist(entry.id);
    setActionLoading(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(`${name} removed from the waitlist`, 'success');
    router.refresh();
  }

  /**
   * PUT TWO WAITING PEOPLE TOGETHER.
   *
   * The same action as Add Pair, because it is the same thing: addPairToEvent
   * takes player ids and removes either of them from the pool in the same
   * transaction (migration 00102). There is no separate "promote" endpoint to
   * get out of step with it, and no path that can write a pair while leaving a
   * pool row behind.
   */
  async function handlePairSelected() {
    if (selectedUnpaired.length !== 2) return;
    setLoading(true);
    const [a, b] = selectedUnpaired;
    const res = await addPairToEvent(event.id, a!, b!);
    if (!res.ok) {
      toast(res.error, 'error');
      setLoading(false);
      return;
    }
    toast('Paired', 'success');
    setSelectedUnpaired([]);
    router.refresh();
    setLoading(false);
  }

  /**
   * PAIR THE WHOLE WAITING LIST.
   *
   * CONFIRMED, unlike "Pair selected" beside it, and the difference is real:
   * that button acts on two people the exec has just ticked and can see, this
   * one decides who plays with whom for the entire event in a single press. The
   * confirm names the count so what is about to happen is on screen before it
   * happens. NO TYPED REASON, though — the neighbouring pairing actions were
   * checked rather than assumed: addPairToEvent's audit row ('pair_added')
   * records player ids and whether they were promoted from the pool, and has no
   * reason field to fill in. Demanding one here would be a heavier ceremony
   * than the act it audits.
   *
   * THE RESULT IS NEVER REPORTED AS A BARE SUCCESS. Each pair is its own
   * transaction, so a later one can fail after earlier ones committed — the
   * toast says how many were made and how many people are still waiting.
   */
  async function handleAutoPair() {
    const count = activeUnpaired.length;
    const willPair = Math.floor(count / 2);
    const ok = await confirm({
      title: `Pair ${willPair === 1 ? 'the 2 people' : `${willPair * 2} people`} waiting?`,
      message: count % 2 === 0
        ? `${willPair} ${willPair === 1 ? 'team' : 'teams'} will be formed, strongest player with weakest so the teams are evenly matched. You can unpair any of them afterwards.`
        : `${willPair} ${willPair === 1 ? 'team' : 'teams'} will be formed, strongest player with weakest so the teams are evenly matched. ${count} is an odd number, so one person will still be waiting. You can unpair any of them afterwards.`,
      confirmLabel: 'Auto pair',
    });
    if (!ok) return;

    setAutoPairing(true);
    const res = await autoPairWaitingEntrants(event.id);
    if (!res.ok) {
      toast(res.error, 'error');
      setAutoPairing(false);
      return;
    }

    const { pairsMade, stillWaiting, refused, stillWaitingReason, unsignedNotice } = res.data;
    const made = `${pairsMade} ${pairsMade === 1 ? 'pair' : 'pairs'} made`;
    const left = stillWaiting > 0
      ? `, ${stillWaiting} ${stillWaiting === 1 ? 'person' : 'people'} still waiting. ${stillWaitingReason}`
      : '';

    // THE TONE FOLLOWS `refused`, NOT "was anybody left over".
    //
    // An odd list leaves somebody waiting by arithmetic, and the confirm dialog
    // above said so before the exec agreed to it. Reporting that in red would
    // tell them the thing they were promised had gone wrong — auto-pairing five
    // people would have shown a red toast for working exactly as designed.
    // 'error' is kept for a pair that was actually REFUSED; a clean sweep is
    // 'success'; the leftover and the unsigned notice are 'info', because both
    // are things to know rather than things that failed.
    const tone = refused > 0
      ? 'error'
      : stillWaiting === 0 && !unsignedNotice
        ? 'success'
        : 'info';
    toast(`${made}${left}${unsignedNotice ? ` ${unsignedNotice}` : ''}`, tone);

    setSelectedUnpaired([]);
    router.refresh();
    setAutoPairing(false);
  }

  async function handleUnpair(pair: PairWithPlayers) {
    const ok = await confirm({
      title: 'Split up this pair?',
      message: 'Both players go back to waiting for a partner. They keep their entry fee, their event waiver and their place in the tournament.',
      confirmLabel: 'Unpair',
    });
    if (!ok) return;

    setActionLoading(pair.id);
    const res = await unpairEntry(pair.id);
    if (!res.ok) {
      toast(res.error, 'error');
      setActionLoading(null);
      return;
    }
    toast('Unpaired — both are waiting for a partner', 'success');
    router.refresh();
    setActionLoading(null);
  }

  /**
   * ONE HALF PULLS OUT, and the other is not punished for it.
   *
   * Withdrawing does not refund, so the partner has already paid, has already
   * signed the event waiver and is already spending one of their allowed
   * entries. They go back into the pool keeping all three and can be given
   * somebody else.
   */
  async function handleWithdrawMember(pair: PairWithPlayers, memberId: string, memberName: string) {
    const partner = memberId === pair.player1_id ? pair.player2 : pair.player1;
    const ok = await confirm({
      title: `${memberName} has pulled out?`,
      message: `The pair is broken up. ${partner?.full_name ?? 'Their partner'} goes back to waiting for a partner and keeps their entry fee, their event waiver and their place. ${memberName} is recorded as withdrawn — withdrawing does not refund.`,
      confirmLabel: 'Withdraw them',
      danger: true,
    });
    if (!ok) return;

    setActionLoading(pair.id);
    const res = await withdrawPairMember(pair.id, memberId);
    if (!res.ok) {
      toast(res.error, 'error');
      setActionLoading(null);
      return;
    }
    toast(`${memberName} withdrawn — ${partner?.full_name ?? 'their partner'} is waiting for a partner`, 'success');
    setSplitting(null);
    router.refresh();
    setActionLoading(null);
  }

  async function handleWithdraw(id: string, name: string) {
    const ok = await confirm({
      title: `Withdraw ${name}?`,
      message: eventLive
        ? 'Their unplayed matches are forfeited to their opponents, and the winners advance. Matches already played are left alone.'
        : 'The event has not started, so nothing is forfeited yet. Regenerate the bracket to drop them from the draw, or go live and their matches will be forfeited then.',
      confirmLabel: 'Withdraw',
      danger: true,
    });
    if (!ok) return;

    setActionLoading(id);
    const res = isDoubles ? await withdrawPair(id) : await withdrawParticipant(id);
    if (!res.ok) {
      toast(res.error, 'error');
      setActionLoading(null);
      return;
    }
    const { forfeited, unresolved, deferredToGoLive } = res.data;
    toast(
      forfeited > 0
        ? `Withdrawn — ${forfeited} match${forfeited === 1 ? '' : 'es'} forfeited`
        : 'Withdrawn',
      'success',
    );
    if (deferredToGoLive) {
      toast('They are still in the draw. Regenerate the bracket, or their matches will be forfeited when the event goes live.', 'info');
    }
    // Their opponent is not decided yet, so there is nothing to forfeit to
    // until the feeder match finishes. Say it rather than let it look like the
    // forfeit silently missed one.
    if (unresolved > 0) {
      toast(`${unresolved} match${unresolved === 1 ? '' : 'es'} will be forfeited once the opponent is known`, 'info');
    }
    router.refresh();
    setActionLoading(null);
  }

  /**
   * REPLACE ONE HALF OF A TEAM — "Priya is injured, Sam is taking her place".
   *
   * One server action and one transaction, not unpair-then-pair: done in three
   * steps there is a durable middle state where two people who ARE entered look
   * like they are not on a team.
   *
   * The incoming member is picked from the WAITING LIST and nowhere else. That
   * is what keeps the swap neutral — they already entered, so they are already
   * invoiced, have already been asked for the event waiver and already hold one
   * of their allowed entries. Somebody who has not entered is added to the
   * waiting list first, which is the step that does all three.
   */
  async function handleSwap() {
    if (!swapping || !outgoingId || !incomingId) return;
    setLoading(true);
    const res = await swapPairMember(swapping.id, outgoingId, incomingId, {
      allowCategoryMismatch: ignoreCategories,
    });
    if (!res.ok) {
      toast(res.error, 'error');
      setLoading(false);
      return;
    }
    toast(`Team is now ${res.data.pairName}`, 'success');
    setSwapping(null);
    setOutgoingId('');
    setIncomingId('');
    router.refresh();
    setLoading(false);
  }

  function openSwap(pair: PairWithPlayers) {
    setSwapping(pair);
    setOutgoingId('');
    setIncomingId('');
    // Same reset the Add dialog does: an override never survives the dialog it
    // was ticked in.
    setIgnoreCategories(false);
  }

  async function handleAutoSeed() {
    setLoading(true);
    try {
      await autoSeedEventByElo(event.id);
      toast('Auto-seeded by Elo', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleSeedSave(id: string, seed: number | null) {
    try {
      if (isDoubles) {
        await updatePairSeed(id, seed);
      } else {
        await updateParticipantSeed(id, seed);
      }
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to update seed', 'error');
    }
  }

  // The group actions return ActionResult rather than throwing: every refusal
  // they carry is a sentence the exec has to act on ("the fixtures have already
  // been generated"), and Next redacts thrown server-action errors in
  // production.
  async function handleAssignGroups() {
    setLoading(true);
    const res = await assignEventGroups(event.id);
    if (res.ok) {
      toast(`Dealt into ${groupCount} groups by seed`, 'success');
      router.refresh();
    } else {
      toast(res.error, 'error');
    }
    setLoading(false);
  }

  async function handleCategorySave(id: string, category: string | null) {
    const res = await setPairCategory(id, category);
    if (!res.ok) { toast(res.error, 'error'); return; }
    if (res.data.requestRequired) {
      const pair = pairs.find((p) => p.id === id);
      setCategoryReason('');
      setCategoryAsk({ pairId: id, name: pair?.pair_name ?? 'This team', to: category });
      return;
    }
    const n = res.data.rehandicapped;
    if (n > 0) toast(`Category saved; head starts updated on ${n} match${n === 1 ? '' : 'es'}`, 'success');
    router.refresh();
  }

  async function handleCategoryRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!categoryAsk) return;
    if (!categoryReason.trim()) { toast('Give a reason for the change.', 'error'); return; }
    setCategoryAsking(true);
    const res = await requestPairCategoryChange(categoryAsk.pairId, categoryAsk.to, categoryReason);
    setCategoryAsking(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    setCategoryAsk(null);
    toast('Change requested. An approver will review it.', 'success');
    router.refresh();
  }

  async function handleGroupSave(id: string, group: number) {
    const res = isDoubles ? await updatePairGroup(id, group) : await updateParticipantGroup(id, group);
    if (res.ok) router.refresh();
    else toast(res.error, 'error');
  }

  /**
   * The two ways a formed pair comes apart, offered next to Remove.
   *
   * Three different things an exec can mean, so three controls rather than one:
   * Remove says the team should never have been entered, Unpair says these two
   * people belong here but this team does not, and Withdraw says one of them
   * has pulled out. Only the last leaves anybody out of the event.
   */
  function renderPairSplitActions(pair: PairWithPlayers) {
    if (isOutOfEvent(pair.status)) return null;
    // An external team has nobody to swap in or return to a waiting list.
    if (pair.player1_id == null) return null;
    return (
      <>
        {/* Offered even when the waiting list is empty, and that is deliberate:
            the refusal names the step that fixes it ("add them to the waiting
            list first"), which is a better answer than a button that is not
            there for a reason nobody can see. */}
        {controls.swapMember && (
          <Button size="sm" variant="ghost" onClick={() => openSwap(pair)} aria-label={`Swap a player in ${pair.pair_name ?? 'this pair'}`} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
            <Replace className="w-3.5 h-3.5 mr-1" />
            <span className="text-xs">Swap</span>
          </Button>
        )}
        {controls.unpair && (
          <Button size="sm" variant="ghost" onClick={() => handleUnpair(pair)} loading={actionLoading === pair.id} aria-label={`Unpair ${pair.pair_name ?? 'this pair'}`} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
            <Unlink className="w-3.5 h-3.5 mr-1" />
            <span className="text-xs">Unpair</span>
          </Button>
        )}
        {controls.withdrawMember && (
          <Button size="sm" variant="ghost" onClick={() => setSplitting(pair)} aria-label={`Withdraw one player from ${pair.pair_name ?? 'this pair'}`} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
            <UserMinus className="w-3.5 h-3.5 mr-1 text-[var(--color-danger)]" />
            <span className="text-xs">One pulled out</span>
          </Button>
        )}
      </>
    );
  }

  function renderActions(id: string, name: string, status: string) {
    // An entry that is already out of the event has no next step — offering
    // "withdraw" on someone who has withdrawn is how a bracket gets a second
    // forfeit applied to it.
    if (isOutOfEvent(status)) return <span className="text-xs text-[var(--text-muted)]">—</span>;

    if (controls.remove) {
      return (
        <Button size="sm" variant="ghost" onClick={() => handleRemove(id)} loading={actionLoading === id} aria-label={`Remove ${name}`} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
          <Trash2 className="w-3.5 h-3.5 text-[var(--color-danger)]" />
        </Button>
      );
    }

    if (controls.withdraw) {
      return (
        <Button size="sm" variant="ghost" onClick={() => handleWithdraw(id, name)} loading={actionLoading === id} aria-label={`Withdraw ${name}`} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
          <UserMinus className="w-3.5 h-3.5 mr-1 text-[var(--color-danger)]" />
          <span className="text-xs">Withdraw</span>
        </Button>
      );
    }

    return null;
  }

  const usedSeeds = new Set(
    entries.map((e) => e.seed_number).filter((s): s is number => s != null)
  );

  // BOTH WAYS OF ALREADY BEING IN A DOUBLES EVENT. The picker used to exclude
  // pair halves only; leave the pool out and it offers somebody who is already
  // waiting for a partner, and the insert comes back a duplicate.
  const registeredPlayerIds = new Set(
    isDoubles
      ? [...pairs.flatMap((p) => [p.player1_id, p.player2_id]), ...participants.map((p) => p.player_id)]
        .filter((id): id is string => id != null)
      : participants.map((p) => p.player_id)
  );

  const availablePlayers = allPlayers.filter(p => !registeredPlayerIds.has(p.id));
  const playerOptions = availablePlayers.map(p => ({ id: p.id, name: p.full_name, avatarUrl: p.avatar_url }));

  // A doubles pair row can offer up to three things now, and the Actions column
  // has to be drawn if ANY of them is on offer — actionsColumn alone follows
  // remove and withdraw, which is what it was written for.
  const showPairActions = controls.actionsColumn
    || (isDoubles && (controls.unpair || controls.withdrawMember || controls.swapMember));
  // The Add button opens a dialog that may offer either route, so it appears
  // for a holder of either key. Which panels are inside it is decided again.
  const showAddButton = !externalEvent && (controls.add || (isDoubles && controls.addSolo));

  async function handleAddExternalPair(e: React.FormEvent) {
    e.preventDefault();
    if (!externalName1.trim() || !externalName2.trim()) {
      toast('Type a name for both players.', 'error');
      return;
    }
    setLoading(true);
    const res = await addExternalPairToEvent(
      event.id, externalName1, externalName2, externalTeamName, externalCategory === '' ? null : externalCategory,
    );
    setLoading(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast('External team added', 'success');
    setExternalName1('');
    setExternalName2('');
    setExternalTeamName('');
    setExternalCategory(defaultExternalCategory);
    setExternalOpen(false);
    router.refresh();
  }

  // A member pair with no category yet: what its members' declared categories
  // say it is. Shown, never written; the organiser sets it.
  function pairSuggestion(pair: PairWithPlayers): string | null {
    if (pair.team_category != null || pair.player1_id == null || pair.player2_id == null) return null;
    type WithCategory = { competition_category?: unknown } | null;
    const members = [pair.player1 as WithCategory, pair.player2 as WithCategory]
      .map((p) => ({ competition_category: toCompetitionCategory(p?.competition_category) }));
    return pickCategory(stagedCfg, suggestCategory(members));
  }

  function unpairedName(p: ParticipantWithPlayer): string {
    return p.player?.full_name ?? 'Unknown';
  }

  function toggleUnpaired(id: string) {
    setSelectedUnpaired((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        // A team is two people. Ticking a third replaces the oldest rather than
        // silently doing nothing, which reads as a broken checkbox.
        : [...current, id].slice(-2),
    );
  }

  return (
    <div className="space-y-4">
      {/* Actions bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-[var(--text-muted)]">
            {activeEntries.length} {isDoubles ? 'pairs' : 'players'}
            {/* Counted separately and never folded into the bracket figure —
                somebody waiting for a partner is not an entry in the draw. */}
            {activeUnpaired.length > 0 && (
              <span className="text-[var(--color-warning)]">
                {' '}+ {activeUnpaired.length} unpaired
              </span>
            )}
            {showsBracketSize && ` → ${bracketSize}-slot bracket`}
            {byes > 0 && showsBracketSize && (
              <span className="text-[var(--color-warning)]"> ({byes} skip{byes > 1 ? 's' : ''})</span>
            )}
          </span>
          {drawLocked && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_15%,transparent)] text-[var(--color-warning)]" role="status">
              Draw Locked
            </span>
          )}
        </div>
        {/* Three buttons, three separate capabilities — a seeding desk without
            the roster is a real shape the club can hand out, so these are not
            one flag. */}
        <div className="flex gap-2">
          {controls.clearSeeds && (
            <Button size="sm" variant="ghost" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none" onClick={async () => {
              setLoading(true);
              try {
                await clearSeeds(event.id);
                toast('Seeds cleared', 'success');
                router.refresh();
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Failed', 'error');
              }
              setLoading(false);
            }} loading={loading}>
              <XCircle className="w-3.5 h-3.5 mr-1" /> Clear Seeds
            </Button>
          )}
          {controls.autoSeed && (
            <Button size="sm" variant="ghost" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none" onClick={handleAutoSeed} loading={loading}>
              <ArrowUpDown className="w-3.5 h-3.5 mr-1" /> Auto-Seed
            </Button>
          )}
          {/* Deals the WHOLE field serpentine by seed, discarding any hand
              placement — which is why it is a separate press and not something
              Generate does silently. Generate only fills in entries that have
              no group at all. */}
          {showAssignGroups && (
            <Button size="sm" variant="ghost" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none" onClick={handleAssignGroups} loading={loading}>
              <LayoutGrid className="w-3.5 h-3.5 mr-1" /> Assign Groups
            </Button>
          )}
          {externalEvent && controls.add && (
            <Button size="sm" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none" onClick={() => { setExternalCategory(defaultExternalCategory); setExternalOpen(true); }}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add external team
            </Button>
          )}
          {showAddButton && (
            <Button size="sm" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none" onClick={() => { setAddMode(controls.add ? 'pair' : 'solo'); setIgnoreCategories(false); setAddOpen(true); }}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add {isDoubles ? 'Entry' : 'Player'}
            </Button>
          )}
        </div>
      </div>

      {/* Skip preview */}
      {byes > 0 && showsBracketSize && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[color-mix(in_oklab,var(--color-warning)_10%,transparent)] border border-[color-mix(in_oklab,var(--color-warning)_20%,transparent)]">
          <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] flex-shrink-0" />
          <span className="text-sm text-[var(--color-warning)]">
            {activeEntries.length} {isDoubles ? 'pairs' : 'players'} → {bracketSize}-slot bracket with {byes} skip{byes > 1 ? 's' : ''}. Seeds #1–{byes} skip the first round.
          </span>
        </div>
      )}

      {/* Participants table */}
      {/* THE INNER overflow-x-auto IS WHAT MAKES THE ACTIONS CELL SAFE TO
          nowrap, and it is not decoration. The roster (players/page.tsx) stops
          its row actions folding onto a second line with flex-nowrap, and its
          comment justifies that by the table sitting inside ResponsiveTable's
          overflow-x-auto — a narrow desktop gets a horizontal scroll instead of
          a ragged multi-line row. This table has no ResponsiveTable: it is a
          bare <table> inside a rounded card whose overflow is HIDDEN, so
          nowrap alone would have CLIPPED the fourth control rather than
          scrolling to it, which is a worse fault than the one being fixed.
          The card keeps overflow-hidden because that is what clips the table's
          corners to the border radius; the scroll container goes inside it. */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-20">
                Seed
                {/* The hint follows the seed cell it describes — seed.set.write,
                    not the add flag. Telling somebody to click something that
                    does nothing is the same dead invitation as the buttons. */}
                {controls.editSeed && (
                  <span className="ml-1 text-[10px] text-[var(--text-muted)] normal-case font-normal">(click to edit)</span>
                )}
              </th>
              {/* Only on a group stage. A "Group" column full of dashes on an
                  ordinary round robin reads as an unfinished setup step. */}
              {isGroupStage && (
                <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-20">Group</th>
              )}
              {stagedCfg && isDoubles && (
                <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-32">Category</th>
              )}
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3">
                {isDoubles ? 'Pair' : 'Player'}
              </th>
              {/* Only when there is something to say. A blank column headed
                  "Event waiver" on a tournament that has none reads as a
                  requirement nobody has met. */}
              {waiverStates && (
                <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-56">Event waiver</th>
              )}
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-24">Elo</th>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-28">Status</th>
              {(isDoubles ? showPairActions : controls.actionsColumn) && (
                <th className="text-right text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-32">Actions</th>
              )}
            </tr>
          </thead>
          <tbody>
            {isDoubles ? (
              (activeEntries as PairWithPlayers[]).map((pair) => (
                <tr key={pair.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-elevated)] transition-colors">
                  <td className="px-4 py-3">
                    <SeedCell
                      entryId={pair.id}
                      seedNumber={pair.seed_number}
                      canEdit={controls.editSeed}
                      maxSeed={activeEntries.length}
                      usedSeeds={usedSeeds}
                      onSave={handleSeedSave}
                    />
                  </td>
                  {isGroupStage && (
                    <td className="px-4 py-3">
                      <GroupCell
                        entryId={pair.id}
                        groupNumber={(pair as { group_number?: number | null }).group_number ?? null}
                        groupCount={groupCount}
                        canEdit={canEditGroup}
                        onSave={handleGroupSave}
                      />
                    </td>
                  )}
                  {stagedCfg && (
                    <td className="px-4 py-3">
                      <CategoryCell
                        pairId={pair.id}
                        category={pair.team_category ?? null}
                        categories={stagedCfg.categories}
                        suggestion={pairSuggestion(pair)}
                        canEdit={controls.editCategory}
                        onSave={handleCategorySave}
                        pending={pendingCategory(pair.id)}
                      />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {pair.pair_name ?? `${pair.player1?.full_name} / ${pair.player2?.full_name}`}
                    </span>
                    <ImportedTag status={imported?.[pair.id]} />
                    {pair.external1_name != null && pair.pair_name !== `${pair.external1_name} / ${pair.external2_name}` && (
                      <span className="block text-xs text-[var(--text-muted)]">
                        {pair.external1_name} / {pair.external2_name}
                      </span>
                    )}
                  </td>
                  {waiverStates && (
                    <td className="px-4 py-3">
                      {pair.player1_id == null || pair.player2_id == null
                        ? <span className="text-xs text-[var(--text-muted)]">External</span>
                        : <WaiverState states={waiverStates} playerIds={[pair.player1_id, pair.player2_id]} />}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <span className="text-sm font-mono text-[var(--text-muted)]">{pair.combined_elo ?? '-'}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full" role="status" style={{ color: STATUS_COLORS[pair.status], backgroundColor: `${STATUS_COLORS[pair.status]}15` }}>
                      <span className="sr-only">Status: </span>{statusLabel(pair.status)}
                    </span>
                  </td>
                  {showPairActions && (
                    // A formed pair now offers four controls — Swap, Unpair,
                    // "One pulled out" and delete — and flex-wrap folded each
                    // onto its own line, growing this row to about four times
                    // the height of every other one. nowrap instead, with the
                    // 44px touch floor .design-sync/guidelines/admin-console.md
                    // requires of any row-action slot: this console is used on a
                    // phone at the gym door and a thumb does not get a second
                    // try at a 32px button. The width this claims is paid for by
                    // the scroll container around the table, not by the row.
                    <td className="whitespace-nowrap px-4 py-3 text-right align-middle">
                      <div className="inline-flex flex-nowrap items-center justify-end gap-2 [&_button]:min-h-[44px]">
                        {renderPairSplitActions(pair)}
                        {renderActions(pair.id, pair.pair_name ?? `${pair.player1?.full_name} / ${pair.player2?.full_name}`, pair.status)}
                      </div>
                    </td>
                  )}
                </tr>
              ))
            ) : (
              (activeEntries as ParticipantWithPlayer[]).map((p) => {
                const player = p.player;
                const ratings = pickOne(player?.ratings);
                const elo = ratings?.singles_elo ?? p.elo_before ?? '-';
                return (
                  <tr key={p.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-elevated)] transition-colors">
                    <td className="px-4 py-3">
                      <SeedCell
                        entryId={p.id}
                        seedNumber={p.seed_number}
                        canEdit={controls.editSeed}
                        maxSeed={activeEntries.length}
                        usedSeeds={usedSeeds}
                        onSave={handleSeedSave}
                      />
                    </td>
                    {isGroupStage && (
                      <td className="px-4 py-3">
                        <GroupCell
                          entryId={p.id}
                          groupNumber={(p as { group_number?: number | null }).group_number ?? null}
                          groupCount={groupCount}
                          canEdit={canEditGroup}
                          onSave={handleGroupSave}
                        />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <AvatarChip name={player?.full_name ?? ''} src={player?.avatar_url} size="sm" id={player?.id} />
                        <span className="text-sm font-medium text-[var(--text-primary)]">{player?.full_name ?? 'Unknown'}</span>
                        <ImportedTag status={imported?.[p.id]} />
                      </div>
                    </td>
                    {waiverStates && (
                      <td className="px-4 py-3">
                        <WaiverState states={waiverStates} playerIds={[p.player_id]} />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className="text-sm font-mono text-[var(--text-muted)]">{elo}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full" role="status" style={{ color: STATUS_COLORS[p.status], backgroundColor: `${STATUS_COLORS[p.status]}15` }}>
                        <span className="sr-only">Status: </span>{statusLabel(p.status)}
                      </span>
                    </td>
                    {controls.actionsColumn && (
                      <td className="px-4 py-3 text-right">
                        {renderActions(p.id, player?.full_name ?? 'participant', p.status)}
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        </div>

        {activeEntries.length === 0 && (
          <div className="p-8 text-center text-sm text-[var(--text-muted)]">
            {/* A POOL-SEEDED EVENT IS NOT WAITING FOR YOU. Its field is built by
                buildFieldFromPool when the draw is generated, not when the event
                is created — so it sits at zero entrants all through registration,
                which is correct and looked exactly like a feature that had
                silently failed. "Add some to get started" was actively wrong
                advice here: entering people by hand is the one thing that does
                NOT need doing. */}
            {event.seeded_from_event_id ? (
              <>
                This event&rsquo;s field comes from its pool. The qualifiers are promoted
                automatically when you generate the draw — there is nothing to add here.
              </>
            ) : (
              <>No {isDoubles ? 'pairs' : 'participants'} yet. Add some to get started.</>
            )}
          </div>
        )}
      </div>

      {/*
        WAITING FOR A PARTNER — the doubles pool.

        Its own block, below the pairs, and deliberately not merged into the
        table above: these people are not entries in the draw, they are people
        who will become half of one. Folding them in would put them in the
        bracket-size figure and give them seed cells for a slot they do not hold.

        Rendered whenever anybody is in it, whatever the viewer may do — the
        rows are information the page already has, and hiding "three people are
        still waiting" from somebody who cannot fix it is how a draw gets
        refused for a reason nobody on screen can see.

        ACTIVE ROWS ONLY. This block and its heading now read the same list.
        Before, the block rendered on `unpaired.length` and the rows iterated
        `unpaired` — both of which INCLUDE withdrawn and disqualified entries —
        while the heading counted `activeUnpaired`. A withdrawn person was
        therefore drawn as a row under a heading that did not count them, and an
        event where the only pool row was a withdrawal showed "0 people" above a
        table with somebody in it. Those rows moved to the Withdrawn block below;
        this list is the people actually waiting.
      */}
      {isDoubles && activeUnpaired.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border)]">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-[var(--color-warning)]" />
              <span className="text-sm font-medium text-[var(--text-primary)]">Unpaired players</span>
              <span className="text-xs text-[var(--text-muted)]">
                {activeUnpaired.length} {activeUnpaired.length === 1 ? 'person' : 'people'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {/* AUTO PAIR sits beside the manual control rather than replacing
                  it: hand-picking is still the right tool for "these two asked
                  to play together", and this is the right tool for "sort the
                  rest out". Same capability, same statuses — see
                  participantControls, where autoPair is the pair flag. */}
              {controls.autoPair && activeUnpaired.length >= 2 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleAutoPair}
                  loading={autoPairing}
                  aria-label="Automatically pair everyone waiting for a partner"
                  className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                >
                  <Shuffle className="w-3.5 h-3.5 mr-1" />
                  Auto pair
                </Button>
              )}
              {controls.pair && (
                <Button
                  size="sm"
                  onClick={handlePairSelected}
                  disabled={selectedUnpaired.length !== 2}
                  loading={loading}
                  className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                >
                  Pair selected ({selectedUnpaired.length}/2)
                </Button>
              )}
            </div>
          </div>

          {/* The draw refuses outright while anybody is here, so say so where
              the exec is standing rather than at the moment they press
              Generate. Both remedies, the same two the refusal names. */}
          {activeUnpaired.length > 0 && (
            <div className="flex items-start gap-2 px-4 py-3 bg-[color-mix(in_oklab,var(--color-warning)_10%,transparent)] border-b border-[color-mix(in_oklab,var(--color-warning)_20%,transparent)]">
              <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] flex-shrink-0 mt-0.5" />
              <span className="text-sm text-[var(--color-warning)]">
                The draw cannot be generated while anyone is unpaired. Pair them up, or take them out of the event.
              </span>
            </div>
          )}

          {/* Same scroll container as the pairs table, for the same reason: the
              row-action cell below is nowrap, and this card clips. */}
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                {controls.pair && <th className="w-10 px-4 py-3"><span className="sr-only">Select for pairing</span></th>}
                <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3">Player</th>
                {waiverStates && (
                  <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-56">Event waiver</th>
                )}
                <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-24">Elo</th>
                <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-28">Status</th>
                {controls.removeSolo && (
                  <th className="text-right text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-24">Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {activeUnpaired.map((p) => {
                const ratings = pickOne(p.player?.ratings);
                // doubles_elo, because this is a doubles event — the same number
                // elo_before was stamped with when they entered.
                const elo = ratings?.doubles_elo ?? p.elo_before ?? '-';
                return (
                  <tr key={p.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-elevated)] transition-colors">
                    {controls.pair && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedUnpaired.includes(p.player_id)}
                          onChange={() => toggleUnpaired(p.player_id)}
                          // No `disabled` guard is needed any more: somebody who
                          // has left the event is not in this list at all. The
                          // server refuses them regardless — pair_tournament_
                          // entrants (00102) raises on a withdrawn pool row, and
                          // that is the guard that actually holds.
                          aria-label={`Pair ${unpairedName(p)}`}
                          className="w-4 h-4 accent-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                        />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <AvatarChip name={p.player?.full_name ?? ''} src={p.player?.avatar_url} size="sm" id={p.player?.id} />
                        <span className="text-sm font-medium text-[var(--text-primary)]">{unpairedName(p)}</span>
                        <ImportedTag status={imported?.[p.id]} />
                      </div>
                    </td>
                    {waiverStates && (
                      <td className="px-4 py-3">
                        <WaiverState states={waiverStates} playerIds={[p.player_id]} />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className="text-sm font-mono text-[var(--text-muted)]">{elo}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full" role="status" style={{ color: STATUS_COLORS[p.status], backgroundColor: `${STATUS_COLORS[p.status]}15` }}>
                        <span className="sr-only">Status: </span>{statusLabel(p.status)}
                      </span>
                    </td>
                    {controls.removeSolo && (
                      // The withdrawn rows this cell used to also serve now live
                      // in the Withdrawn block, and the Remove button went with
                      // them — that is where "remove the withdrawn entry first"
                      // has to be actionable. Here it is the ordinary "this
                      // person should not be in the event" delete.
                      <td className="whitespace-nowrap px-4 py-3 text-right align-middle">
                        <div className="inline-flex flex-nowrap items-center justify-end gap-2 [&_button]:min-h-[44px]">
                          <Button size="sm" variant="ghost" onClick={() => handleRemoveUnpaired(p.id)} loading={actionLoading === p.id} aria-label={`Remove ${unpairedName(p)}`} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
                            <Trash2 className="w-3.5 h-3.5 text-[var(--color-danger)]" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/*
        WITHDRAWN — the record, kept out of the live field.

        A withdrawn entry sat inline among the people who are actually playing,
        which is hardest to read at exactly the moment it matters: an exec
        scanning the list before a draw wants to see who IS in it.

        RELOCATED, NEVER HIDDEN, and the distinction is load-bearing. Withdrawing
        does not refund — the fee stays on the books, the entry-cap slot is
        released and the event-waiver acceptance stands — so the member can still
        see the charge on their own /fees page. An admin screen that derived its
        roster from live entries only would show that member's paid fee on
        NEITHER admin surface while they are still looking at it, which is a bug
        a sibling has already had to fix once. These rows stay on the page.

        QUIET, because it is a record and not an alert: muted text, no warning
        tones, one line per entry rather than a second full-weight table. Not
        rendered at all when nobody has withdrawn.

        WHY 'no_show' IS NOT HERE. isOutOfEvent covers withdrawn and disqualified
        only; a no-show still holds their slot and still spends an entry-cap
        allowance, so they belong in the live list. Disqualified IS here, because
        it takes somebody out of the event exactly as a withdrawal does — the
        heading says "Withdrawn" but each row carries its own status label, so a
        disqualification is never mislabelled as a withdrawal.
      */}
      {withdrawnCount > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)]">
            <XCircle className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">Withdrawn</span>
            <span className="text-xs text-[var(--text-muted)]">
              {withdrawnCount} {withdrawnCount === 1 ? 'entry' : 'entries'}
            </span>
          </div>

          <ul className="divide-y divide-[var(--border)]">
            {withdrawnPairs.map((pair) => (
              <li key={pair.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span className="text-sm text-[var(--text-muted)]">
                  {pair.pair_name ?? `${pair.player1?.full_name} / ${pair.player2?.full_name}`}
                </span>
                <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  <span className="sr-only">Status: </span>{statusLabel(pair.status)}
                </span>
              </li>
            ))}
            {withdrawnSolo.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span className="text-sm text-[var(--text-muted)]">{unpairedName(p)}</span>
                <div className="inline-flex flex-nowrap items-center gap-2 [&_button]:min-h-[44px]">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    <span className="sr-only">Status: </span>{statusLabel(p.status)}
                  </span>
                  {/* THE ONE ACTION THAT STILL APPLIES, and only in a doubles
                      event. Pairing somebody who has withdrawn is refused by
                      00102 with "remove their withdrawn entry from the waiting
                      list first, then add them again" — an instruction with
                      nothing behind it unless this button exists. Re-adding them
                      without deleting the row hits UNIQUE(event_id, player_id).

                      `isDoubles` GUARDS AGAINST A WIDENING NOBODY ASKED FOR.
                      Relocating the rows is a readability change and applies to
                      every shape, but a withdrawn SINGLES entrant was previously
                      shown with an empty Actions cell — renderActions returns
                      '—' for anybody out of the event — and there is no pairing
                      refusal in a singles event for this button to unblock. So
                      each row keeps exactly the actions it had before the move.

                      Unpair, Swap and "One pulled out" are deliberately NOT here
                      either: none is a thing you can do to an entry that has
                      already left. */}
                  {isDoubles && controls.removeSolo && (
                    <Button size="sm" variant="ghost" onClick={() => handleRemoveUnpaired(p.id)} loading={actionLoading === p.id} aria-label={`Remove ${unpairedName(p)}'s withdrawn entry`} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
                      <Trash2 className="w-3.5 h-3.5 text-[var(--color-danger)]" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {waitlist && waitlist.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
            <Clock className="w-4 h-4 text-[var(--text-muted)]" />
            <span className="text-sm font-medium text-[var(--text-primary)]">Waitlist</span>
            <span className="text-xs text-[var(--text-muted)]">
              {waitlist.length} {waitlist.length === 1 ? 'person' : 'people'}
            </span>
            {eventFull && waitlistOpen && (
              <span className="text-xs text-[var(--text-muted)]">Full: raise the limit or free a place to promote.</span>
            )}
          </div>
          <ul className="divide-y divide-[var(--border)]">
            {waitlist.map((entry, index) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-6 text-sm font-mono text-[var(--text-muted)]">{index + 1}</span>
                  <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {entry.player?.full_name ?? 'Unknown member'}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">Joined {formatDateTime(entry.joined_at)}</span>
                </div>
                <div className="inline-flex flex-nowrap items-center gap-2 [&_button]:min-h-[44px]">
                  {capabilities.soloAdd && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handlePromoteWaiting(entry)}
                      disabled={eventFull || !waitlistOpen}
                      loading={actionLoading === entry.id}
                      aria-label={`Promote ${entry.player?.full_name ?? 'member'} from the waitlist`}
                      className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                    >
                      Promote
                    </Button>
                  )}
                  {capabilities.soloRemove && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRemoveWaiting(entry)}
                      loading={actionLoading === entry.id}
                      aria-label={`Remove ${entry.player?.full_name ?? 'member'} from the waitlist`}
                      className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-[var(--color-danger)]" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        EDIT A TEAM — swap one half for somebody on the waiting list.

        Two choices in one dialog, in the order the exec thinks about them:
        who is leaving, then who takes their place. The whole thing is one
        server action and one transaction, so there is no moment where the team
        is dissolved.
      */}
      <Dialog open={swapping !== null} onClose={() => setSwapping(null)} title="Swap a player">
        {swapping && (
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">Who is leaving the team?</p>
              <div className="space-y-1.5">
                {[
                  { id: swapping.player1_id ?? '', name: swapping.player1?.full_name ?? 'Player 1' },
                  { id: swapping.player2_id ?? '', name: swapping.player2?.full_name ?? 'Player 2' },
                ].map((half) => (
                  <button
                    key={half.id}
                    type="button"
                    onClick={() => setOutgoingId(half.id)}
                    aria-pressed={outgoingId === half.id}
                    className={`w-full text-left text-sm px-3 py-2 rounded-lg border transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none ${outgoingId === half.id ? 'border-[var(--color-accent)] bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'border-[var(--border)] text-[var(--text-muted)]'}`}
                  >
                    {half.name}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">Who takes their place?</p>
              {activeUnpaired.length === 0 ? (
                // Not a dead end — it names the step that makes the swap
                // possible, which is the same sentence the server refuses with.
                <p className="text-sm text-[var(--text-muted)]">
                  Nobody is waiting for a partner. Add the incoming player with
                  “Add Entry → Without a partner” first — that is what charges them
                  and asks for the event waiver — then swap them in.
                </p>
              ) : (
                <PlayerPicker
                  label="From the waiting list"
                  value={incomingId}
                  onChange={setIncomingId}
                  players={activeUnpaired.map((p) => ({
                    id: p.player_id,
                    name: unpairedName(p),
                    avatarUrl: p.player?.avatar_url,
                  }))}
                />
              )}
            </div>

            <p className="text-sm text-[var(--text-muted)]">
              The player leaving goes back to waiting for a partner — they keep their entry fee,
              their event waiver and their place in the tournament. The team&apos;s seed does not move,
              but its combined rating is recalculated.
            </p>
            {/* Said out loud, because the exec is standing at the desk and will
                otherwise assume the team is still through. The old team was the
                one that was screened; the new one has to be. */}
            {swapping.status === 'checked_in' && (
              <p className="text-sm text-[var(--color-warning)]">
                This team is checked in. Swapping a player puts it back to Registered — check the new
                team in again so the event waiver is checked for whoever is now in it.
              </p>
            )}

            {/* 00111 — the same override the Add dialog offers, on the only
                other path that FORMS a team. Mixed Doubles is the only event
                whose rule a swap can break, so it is the only one that shows
                this: replacing one half can make a team the event's own name
                says is impossible, out of two additions that were each fine. */}
            {gendered && (
              <label className="flex items-start gap-2 text-sm text-[var(--text-muted)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={ignoreCategories}
                  onChange={(e) => setIgnoreCategories(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <span>Ignore competition categories for this swap.</span>
              </label>
            )}

            {/* Extra clearance: the picker's list is fixed-positioned below the
                field and a short one can sit over these buttons. */}
            <div className="flex gap-2 pt-6">
              <Button
                className="flex-1"
                loading={loading}
                disabled={!outgoingId || !incomingId}
                onClick={handleSwap}
              >
                Swap
              </Button>
              <Button variant="ghost" type="button" onClick={() => setSwapping(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </Dialog>

      {/*
        ONE HALF OF A PAIR HAS PULLED OUT — which one?

        A dialog rather than two buttons in the row, because the row already
        carries three controls and the choice here decides who keeps their entry
        and who does not.
      */}
      <Dialog open={splitting !== null} onClose={() => setSplitting(null)} title="Which player has pulled out?">
        {splitting && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-muted)]">
              The pair is broken up. The other player goes back to waiting for a partner and keeps their entry fee,
              their event waiver and their place in the tournament. Withdrawing does not refund.
            </p>
            {[
              { id: splitting.player1_id ?? '', name: splitting.player1?.full_name ?? 'Player 1' },
              { id: splitting.player2_id ?? '', name: splitting.player2?.full_name ?? 'Player 2' },
            ].map((half) => (
              <Button
                key={half.id}
                variant="ghost"
                className="w-full justify-start focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                loading={actionLoading === splitting.id}
                onClick={() => handleWithdrawMember(splitting, half.id, half.name)}
              >
                <UserMinus className="w-3.5 h-3.5 mr-2 text-[var(--color-danger)]" />
                {half.name} has pulled out
              </Button>
            ))}
            <Button variant="ghost" type="button" onClick={() => setSplitting(null)}>Cancel</Button>
          </div>
        )}
      </Dialog>

      {/*
        Add Dialog.

        A doubles event has TWO ways in and they are different server actions
        asking different capabilities — "as a pair" is pairs.add.write, "without
        a partner" is participants.add.write — so the switch only offers a route
        the viewer may actually take, and a viewer holding one key sees one
        panel with no toggle at all.
      */}
      <Dialog open={externalOpen} onClose={() => setExternalOpen(false)} title="Add external team">
        <form onSubmit={handleAddExternalPair} className="space-y-4">
          <Input
            label="Player 1 name"
            value={externalName1}
            maxLength={60}
            onChange={(e) => setExternalName1(e.target.value)}
            autoFocus
          />
          <Input
            label="Player 2 name"
            value={externalName2}
            maxLength={60}
            onChange={(e) => setExternalName2(e.target.value)}
          />
          <Input
            label="Team name (optional)"
            value={externalTeamName}
            maxLength={60}
            onChange={(e) => setExternalTeamName(e.target.value)}
          />
          {stagedCfg && (
            <Select
              label="Category"
              value={externalCategory}
              onChange={(e) => setExternalCategory(e.target.value)}
              options={[
                { value: '', label: 'None' },
                ...stagedCfg.categories.map((c) => ({ value: c.key, label: c.label })),
              ]}
            />
          )}
          <p className="text-xs text-[var(--text-muted)]">
            External teams play unrated. Nobody here needs a member account.
          </p>
          <div className="flex gap-2">
            <Button type="submit" loading={loading} className="flex-1">Add</Button>
            <Button variant="ghost" onClick={() => setExternalOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title={isDoubles ? 'Add Entry' : 'Add Participant'}>
        <form onSubmit={isDoubles && addMode === 'pair' ? handleAddPair : handleAddMany} className="space-y-4">
          {isDoubles && controls.add && controls.addSolo && (
            <div className="flex gap-1 p-1 rounded-lg bg-[var(--bg-elevated)]" role="tablist">
              {([['pair', 'As a pair'], ['solo', 'Without a partner']] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={addMode === mode}
                  onClick={() => setAddMode(mode)}
                  className={`flex-1 text-sm px-3 py-1.5 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none ${addMode === mode ? 'bg-[var(--bg-card)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)]'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {isDoubles && addMode === 'solo' && (
            <p className="text-sm text-[var(--text-muted)]">
              They enter on their own and wait for a partner. They are invoiced and asked for the event waiver now,
              exactly as a paired entrant is — being paired later is not when they agreed to anything.
            </p>
          )}

          {isDoubles && addMode === 'pair' ? (
            <>
              <PlayerPicker
                label="Player 1"
                value={playerId}
                onChange={setPlayerId}
                players={playerOptions}
              />
              <PlayerPicker
                label="Player 2"
                value={player2Id}
                onChange={setPlayer2Id}
                players={playerOptions.filter(p => p.id !== playerId)}
              />
            </>
          ) : (
            <PlayerPicker
              multiple
              label="Players"
              value={playerIds}
              onChange={setPlayerIds}
              players={playerOptions}
            />
          )}
          {/* 00111 — offered only on an event that HAS a category rule, so an
              Open event's dialog never mentions categories at all. It says what
              it does and not who it is about: the box never names anybody's
              declared category, and neither does the refusal it gets past. */}
          {gendered && (
            <label className="flex items-start gap-2 text-sm text-[var(--text-muted)] cursor-pointer">
              <input
                type="checkbox"
                checked={ignoreCategories}
                onChange={(e) => setIgnoreCategories(e.target.checked)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span>
                Ignore competition categories for this entry.
                <span className="block text-[var(--text-muted)]">
                  Only for an event the club has agreed to run that way. Members who have
                  declared nothing are admitted either way.
                </span>
              </span>
            </label>
          )}
          {/* Extra clearance: the picker's list is fixed-positioned below the
              field, so a short one can still sit over these buttons. */}
          <div className="flex gap-2 pt-6">
            <Button type="submit" loading={loading} className="flex-1">
              {!(isDoubles && addMode === 'pair') && playerIds.length > 1 ? `Add ${playerIds.length}` : 'Add'}
            </Button>
            <Button variant="ghost" onClick={() => setAddOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={categoryAsk !== null} onClose={() => setCategoryAsk(null)} title="Request a category change">
        {categoryAsk && (
          <form onSubmit={handleCategoryRequest} className="space-y-4">
            <p className="text-sm text-[var(--text-muted)]">
              {categoryAsk.name} has already played with head starts, so changing its category to{' '}
              <span className="font-medium text-[var(--text-primary)]">
                {categoryAsk.to == null
                  ? 'Unset'
                  : stagedCfg?.categories.find((c) => c.key === categoryAsk.to)?.label ?? categoryAsk.to}
              </span>{' '}
              needs approval from somebody who can edit a recorded result. Played matches keep their recorded scores.
            </p>
            <Input
              label="Reason"
              value={categoryReason}
              maxLength={500}
              required
              onChange={(e) => setCategoryReason(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <Button type="submit" loading={categoryAsking} disabled={!categoryReason.trim()} className="flex-1">Send request</Button>
              <Button variant="ghost" onClick={() => setCategoryAsk(null)} type="button">Cancel</Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
