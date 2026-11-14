'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input } from '@badminton/ui';
import { leaveAndSubstitute, substituteEntry, type IncomingChoice, type SubstitutionKind } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { substitutionSummary } from '@/lib/substitution-summary';
import { DEPARTURE_REASON_LABELS, type Departure } from '@/lib/departure-reasons';
import { matchSides } from '@badminton/shared';
import { getName } from './entry-name';
import type {
  PairWithPlayers,
  ParticipantWithPlayer,
  PlayerSummary,
  TournamentMatchRow,
  WaitlistEntry,
} from '@/lib/tournament-types';

export interface SubstituteMember {
  id: string;
  name: string;
}

/**
 * SUB (00327, 00328): somebody in for one member of a pair, or for the whole
 * entry. The person coming in is picked from who is already here (entered and
 * not playing), the reserves, then the execs, or is a guest typed by name.
 * None of them is entered first: the sub reuses the entry, so a full event
 * still takes them mid-play, and the one server call makes the sub, resolves
 * the reserve off the waitlist, or makes the guest's record.
 *
 * FROM "LEFT" (departure given): the confirm is the only write, and it records
 * the departure and voids the match on court in the same call. Back returns to
 * the Left dialog with nothing written.
 *
 * NOT A <form>, for the court card: Dialog renders in place, inside the score
 * form there.
 */

/** A radio value as the server is sent it. */
export function choiceFor(value: string, guestName: string): IncomingChoice | null {
  const at = value.indexOf(':');
  const source = value.slice(0, at);
  const id = value.slice(at + 1);
  if (source === 'spare' || source === 'exec') return id ? { source, playerId: id } : null;
  if (source === 'reserve') return id ? { source, waitlistId: id } : null;
  if (value === 'guest') return guestName.trim() ? { source: 'guest', name: guestName.trim() } : null;
  return null;
}

export function SubstituteDialog({
  eventId,
  entryId,
  isDoubles,
  label,
  members,
  initialOut = null,
  spares,
  waitlist,
  execs,
  canEnterSpares,
  canAddGuest = false,
  canOverride,
  summary,
  departure = null,
  onBack,
  onClose,
}: {
  eventId: string;
  entryId: string;
  isDoubles: boolean;
  label: string;
  /** Who is on the entry now. */
  members: SubstituteMember[];
  /** The Sub was pressed next to this person: they go out, one partner. */
  initialOut?: string | null;
  /** Entered in this event and in no match: free to take the place. */
  spares: PlayerSummary[];
  waitlist: WaitlistEntry[];
  /** Execs not in the event. */
  execs: PlayerSummary[];
  /** Kill switch fill_empty_places and the add key: a reserve or an exec can come in. */
  canEnterSpares: boolean;
  /** Kill switch add_on_the_spot and the add key: a guest can come in by name. */
  canAddGuest?: boolean;
  /** An exec: may let in a member restricted from entering events. */
  canOverride: boolean;
  /** What the person coming in takes over, from substitutionSummary. */
  summary: string;
  /** From "Left": why they left. Recorded only when the sub is confirmed. */
  departure?: Departure | null;
  /** From "Left": back to that dialog, nothing written. */
  onBack?: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [kind, setKind] = useState<SubstitutionKind>(isDoubles ? 'partner' : 'team');
  const [partnerOut, setPartnerOut] = useState<string | null>(initialOut);
  const [incoming, setIncoming] = useState<Record<string, string>>({});
  const [guestNames, setGuestNames] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(false);
  const [pending, setPending] = useState(false);

  const outgoing = kind === 'team' ? members.map((m) => m.id) : partnerOut ? [partnerOut] : [];
  const chosen = outgoing.map((id) => choiceFor(incoming[id] ?? '', guestNames[id] ?? ''));
  const picked = outgoing.map((id) => incoming[id] ?? '').filter((v) => v !== 'guest');
  const ready = outgoing.length > 0 && chosen.every((c) => c !== null) && new Set(picked).size === picked.length;
  // The event standard's order holds here as in Fill the empty places: an
  // exec only once no reserve is waiting, which the server refuses as well.
  // Reserves are offered during play too: a sub takes no free place.
  const sources: Array<{ group: string; hint: string | null; options: Array<{ value: string; name: string }> }> = [
    { group: 'Here and not playing', hint: null, options: spares.map((p) => ({ value: `spare:${p.id}`, name: p.full_name ?? 'Unknown' })) },
    ...(canEnterSpares ? [
      {
        group: 'Reserves, in order',
        hint: null,
        options: waitlist.map((w) => ({ value: `reserve:${w.id}`, name: w.player?.full_name ?? 'Unknown' })),
      },
      {
        group: 'Execs',
        hint: waitlist.length > 0 ? 'Call or remove the reserves first.' : null,
        options: waitlist.length > 0 ? [] : execs.map((p) => ({ value: `exec:${p.id}`, name: p.full_name ?? 'Unknown' })),
      },
    ] : []),
  ];

  async function submit() {
    if (!ready || pending) return;
    setPending(true);
    const input = {
      kind,
      entryId,
      outgoing,
      incoming: chosen as IncomingChoice[],
      note: note.trim() || null,
      overrideRestriction: override,
    };
    const res = departure
      ? await leaveAndSubstitute(eventId, { ...input, departure })
      : await substituteEntry(eventId, input);
    setPending(false);
    if (!res.ok) {
      // Nothing was written: the dialog stays open to pick somebody else.
      toast(res.error, 'error');
      router.refresh();
      return;
    }
    const parts = [departure ? `${label}: left, and subbed.` : 'Subbed in.'];
    parts.push(`${res.data.moved} unplayed match${res.data.moved === 1 ? '' : 'es'} moved over.`);
    if (res.data.warned > 0) parts.push('A warning was added to their record.');
    toast(parts.join(' '), 'success');
    onClose();
    router.refresh();
  }

  const cancel = departure && onBack ? onBack : onClose;

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? 'Them';

  return (
    <Dialog open onClose={() => { if (!pending) cancel(); }} title={`Sub for ${label}`}>
      <div className="space-y-4">
        {departure && (
          <p className="text-sm text-[var(--text-muted)]" role="status">
            {`Left: ${DEPARTURE_REASON_LABELS[departure.reason].toLowerCase()}. Nothing is recorded until you sub someone in: then the match on court is voided, the departure recorded and the place taken, together.`}
          </p>
        )}
        {isDoubles && (
          <div className="flex gap-2" role="radiogroup" aria-label="Who is replaced">
            <Button type="button" size="sm" variant={kind === 'partner' ? 'primary' : 'ghost'} aria-pressed={kind === 'partner'} onClick={() => setKind('partner')}>
              One partner
            </Button>
            <Button type="button" size="sm" variant={kind === 'team' ? 'primary' : 'ghost'} aria-pressed={kind === 'team'} onClick={() => setKind('team')}>
              The whole team
            </Button>
          </div>
        )}

        {kind === 'partner' && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-[var(--text-primary)]">Who goes out</legend>
            {members.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <input type="radio" name={`sub-out-${entryId}`} value={m.id} checked={partnerOut === m.id} onChange={() => setPartnerOut(m.id)} />
                {m.name}
              </label>
            ))}
          </fieldset>
        )}

        {outgoing.map((outId) => (
          <fieldset key={outId} className="space-y-2">
            <legend className="text-sm font-medium text-[var(--text-primary)]">In for {nameOf(outId)}</legend>
            {sources.map((source) => (
              <div key={source.group} className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{source.group}</p>
                {source.hint && <p className="text-xs text-[var(--text-muted)]">{source.hint}</p>}
                {source.hint ? null : source.options.length === 0 ? (
                  <p className="text-sm text-[var(--text-muted)]">Nobody.</p>
                ) : source.options.map((option) => (
                  <label key={option.value} className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                    <input
                      type="radio"
                      name={`sub-in-${entryId}-${outId}`}
                      value={option.value}
                      checked={incoming[outId] === option.value}
                      onChange={() => setIncoming((current) => ({ ...current, [outId]: option.value }))}
                    />
                    {option.name}
                  </label>
                ))}
              </div>
            ))}
            {canAddGuest && (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">A guest</p>
                <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                  <input
                    type="radio"
                    name={`sub-in-${entryId}-${outId}`}
                    value="guest"
                    checked={incoming[outId] === 'guest'}
                    onChange={() => setIncoming((current) => ({ ...current, [outId]: 'guest' }))}
                  />
                  Somebody not in the club
                </label>
                {incoming[outId] === 'guest' && (
                  <Input
                    label="Guest's name"
                    value={guestNames[outId] ?? ''}
                    maxLength={120}
                    onChange={(e) => { const value = e.target.value; setGuestNames((current) => ({ ...current, [outId]: value })); }}
                  />
                )}
              </div>
            )}
          </fieldset>
        ))}

        <Input label="Note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />

        {canOverride && (
          <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="mt-1" />
            <span>Let them in even if they are restricted from entering events. Only an exec can say so.</span>
          </label>
        )}

        <p className="text-sm text-[var(--text-muted)]" role="status">{summary} A sub on its own adds no warning.</p>

        <div className="flex justify-between gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={cancel}>{departure && onBack ? 'Back' : 'Cancel'}</Button>
          <Button type="button" loading={pending} disabled={!ready || pending} onClick={() => void submit()}>
            {departure ? 'Mark as left and sub in' : 'Sub in'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Who the desk can bring in: a reserve, an exec, a guest by name. */
export interface SubstituteSources {
  waitlist: WaitlistEntry[];
  execs: PlayerSummary[];
  canEnterSpares: boolean;
  canAddGuest: boolean;
  canOverride: boolean;
}

/**
 * The dialog for one entry, worked out from the event's lists, so the Check-in
 * tab and the court card open the same thing.
 */
export function SubstituteForEntry({
  eventId,
  entryId,
  initialOut = null,
  isDoubles,
  participants,
  pairs,
  matches,
  sources,
  departure = null,
  onBack,
  onClose,
}: {
  eventId: string;
  entryId: string;
  initialOut?: string | null;
  isDoubles: boolean;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  matches: TournamentMatchRow[];
  sources: SubstituteSources;
  departure?: Departure | null;
  onBack?: () => void;
  onClose: () => void;
}) {
  const entry = (isDoubles ? pairs : participants).find((e) => e.id === entryId);
  if (!entry) return null;
  const members: SubstituteMember[] = isDoubles
    ? [
        { id: (entry as PairWithPlayers).player1_id, name: (entry as PairWithPlayers).player1?.full_name ?? 'Player 1' },
        { id: (entry as PairWithPlayers).player2_id, name: (entry as PairWithPlayers).player2?.full_name ?? 'Player 2' },
      ].filter((m): m is SubstituteMember => m.id != null)
    : [{ id: (entry as ParticipantWithPlayer).player_id, name: (entry as ParticipantWithPlayer).player?.full_name ?? 'Player' }];
  // An external team has nobody to replace.
  if (members.length === 0) return null;
  // WHO CAN COME IN: entered in the event and in no match. In doubles that is
  // a single waiting to be paired; in singles, somebody added after the draw.
  // The SQL holds the same rule.
  const spares: PlayerSummary[] = participants
    .filter((p) => !['withdrawn', 'disqualified', 'no_show'].includes(p.status)
      && !members.some((m) => m.id === p.player_id)
      && !matches.some((m) => [m.participant_a_id, m.participant_b_id, m.winner_participant_id, m.loser_participant_id].includes(p.id)))
    .map((p) => ({ id: p.player_id, full_name: p.player?.full_name ?? 'Unknown', avatar_url: p.player?.avatar_url ?? null }));
  const taken = new Set([
    ...participants.map((p) => p.player_id),
    ...pairs.flatMap((p) => [p.player1_id, p.player2_id]).filter((id): id is string => id != null),
  ]);
  const sided = matches.map((m) => ({ ...m, ...matchSides(m, isDoubles) }));
  return (
    <SubstituteDialog
      eventId={eventId}
      entryId={entryId}
      isDoubles={isDoubles}
      label={getName(entry, isDoubles)}
      members={members}
      initialOut={initialOut}
      spares={spares}
      waitlist={sources.waitlist}
      execs={sources.execs.filter((exec) => !taken.has(exec.id))}
      canEnterSpares={sources.canEnterSpares}
      canAddGuest={sources.canAddGuest}
      canOverride={sources.canOverride}
      summary={substitutionSummary(sided, entryId)}
      departure={departure}
      onBack={onBack}
      onClose={onClose}
    />
  );
}
