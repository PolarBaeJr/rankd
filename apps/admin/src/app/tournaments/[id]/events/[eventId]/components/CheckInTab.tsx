'use client';

import { useState } from 'react';
import { Button, AvatarChip } from '@badminton/ui';
import {
  checkInParticipant,
  markParticipantNoShow,
  checkInPair,
  checkInPairMember,
  undoPairMemberCheckIn,
  markPairNoShow,
  bulkCheckIn,
  undoCheckIn,
  undoNoShow,
} from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { CheckCircle, XCircle, Clock, Users, UserCheck, Undo2 } from 'lucide-react';
import { getName } from './entry-name';
import type { TournamentEventRow, ParticipantWithPlayer, PairWithPlayers } from '@/lib/tournament-types';
import {
  CLUB_TIMEZONE,
  pairCheckInCounts,
  pairCheckInPeople,
  type EventWaiverStatus,
  type PairCheckInPerson,
} from '@badminton/shared';
import { WaiverState, blocksCheckIn } from './WaiverState';

interface Props {
  event: TournamentEventRow;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
  // null = draw no waiver state at all. See WaiverState.
  waiverStates: Record<string, EventWaiverStatus> | null;
}

/** Whose signature this entry needs — one person, or both halves of a pair. */
function entryPlayerIds(entry: ParticipantWithPlayer | PairWithPlayers, isDoubles: boolean): string[] {
  return isDoubles
    // An external team (00269) has no member ids and nobody to ask for a waiver.
    ? [(entry as PairWithPlayers).player1_id, (entry as PairWithPlayers).player2_id]
      .filter((id): id is string => id != null)
    : [(entry as ParticipantWithPlayer).player_id];
}

export function CheckInTab({ event, participants, pairs, isDoubles, waiverStates }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const { toast } = useToast();

  const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
  // Keyed on checked_in_at, not status. status is a single enum, so
  // withdrawing OVERWRITES 'checked_in' and the person vanishes from this list
  // — but they did turn up, and the attendance record should say so. The
  // timestamp is never cleared, so it is the honest source for "was here".
  const checkedIn = entries.filter(e => e.checked_in_at != null);
  const notCheckedIn = entries.filter(e => e.status === 'registered');
  const noShows = entries.filter(e => e.status === 'no_show');
  // DOUBLES CHECKS IN PERSON BY PERSON (00309): the team is in when both are.
  const people = isDoubles
    ? pairCheckInPeople(pairs, (pair, slot) => (slot === 1 ? pair.player1 : pair.player2)?.full_name)
    : [];
  const peopleCounts = pairCheckInCounts(people);
  const peopleWaiting = people.filter(p => !p.here);
  const peopleHere = people.filter(p => p.here);
  const progress = isDoubles
    ? (peopleCounts.people > 0 ? (peopleCounts.peopleHere / peopleCounts.people) * 100 : 0)
    : (entries.length > 0 ? (checkedIn.length / entries.length) * 100 : 0);
  // THE NUMBER THE DESK NEEDS BEFORE THE QUEUE FORMS. Check-in refuses an
  // entrant with no current event-waiver acceptance, so this is the count of
  // presses that are going to fail — surfaced up front rather than discovered
  // one refusal at a time. In doubles it counts people.
  const waiverBlocked = isDoubles
    ? peopleWaiting.filter(p => p.playerId != null && blocksCheckIn(waiverStates, [p.playerId]))
    : notCheckedIn.filter(e => blocksCheckIn(waiverStates, entryPlayerIds(e, isDoubles)));
  // The team's no-show sits on the first of its people still waiting.
  const noShowRow = new Set<string>();
  const noShowPairs = new Set<string>();
  for (const p of peopleWaiting) {
    if (p.pairStatus !== 'registered' || noShowPairs.has(p.pairId)) continue;
    noShowPairs.add(p.pairId);
    noShowRow.add(`${p.pairId}:${p.slot}`);
  }

  async function handleCheckIn(id: string) {
    setLoading(id);
    try {
      // ActionResult, not a throw. These two now refuse an entrant with no
      // current event-waiver acceptance, and Next.js REDACTS an error thrown
      // out of a server action in production — so the one message that tells
      // the officer at the door what to do about it would arrive as "an error
      // occurred". Returned as a value, it arrives intact.
      const result = isDoubles ? await checkInPair(id) : await checkInParticipant(id);
      if (!result.ok) {
        toast(result.error, 'error');
        setLoading(null);
        return;
      }
      toast('Checked in', 'success');
      // No router.refresh() here. Every one of these actions ends in
      // revalidateEventPaths, and the App Router already ships the re-rendered
      // tree back in the action's own response — a refresh on top rendered this
      // page a SECOND time, and on a 100-player event that page is not cheap.
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(null);
  }

  async function handlePersonCheckIn(person: PairCheckInPerson) {
    setLoading(`${person.pairId}:${person.slot}`);
    try {
      const result = await checkInPairMember(person.pairId, person.slot);
      if (!result.ok) {
        toast(result.error, 'error');
      } else {
        toast(result.data.pairCheckedIn ? 'Checked in. Team complete' : 'Checked in', 'success');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(null);
  }

  async function handlePersonUndo(person: PairCheckInPerson) {
    setLoading(`undo-${person.pairId}:${person.slot}`);
    try {
      const result = await undoPairMemberCheckIn(person.pairId, person.slot);
      if (!result.ok) {
        toast(result.error, 'error');
      } else {
        toast('Check-in undone', 'success');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(null);
  }

  async function handleNoShow(id: string) {
    setLoading(`noshow-${id}`);
    try {
      if (isDoubles) {
        await markPairNoShow(id);
      } else {
        await markParticipantNoShow(id);
      }
      toast('Marked as no-show', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(null);
  }

  // Back to waiting, for a check-in or a no-show pressed on the wrong row.
  async function handleUndo(id: string, kind: 'checkin' | 'noshow') {
    setLoading(`undo-${id}`);
    try {
      const result = kind === 'checkin' ? await undoCheckIn(id, isDoubles) : await undoNoShow(id, isDoubles);
      if (!result.ok) {
        toast(result.error, 'error');
      } else {
        toast(kind === 'checkin' ? 'Check-in undone' : 'No-show undone', 'success');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(null);
  }

  async function handleBulkCheckIn() {
    setBulkLoading(true);
    try {
      const result = await bulkCheckIn(event.id, isDoubles ? 'pairs' : 'participants');
      if (!result.ok) {
        toast(result.error, 'error');
        setBulkLoading(false);
        return;
      }
      // PARTIAL SUCCESS IS THE NORMAL CASE NOW, and it has to read as one. The
      // action checks in everybody who may play and names the ones it could
      // not, so a plain "all present participants checked in" would be a lie
      // that leaves an unsigned entrant looking checked in to the exec who
      // pressed the button.
      const { checkedIn, skippedForWaiver } = result.data;
      if (skippedForWaiver) {
        toast(`${checkedIn} checked in. ${skippedForWaiver}`, 'error');
      } else {
        toast(`${checkedIn} checked in`, 'success');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setBulkLoading(false);
  }

  const canCheckIn = event.status === 'checkin' || event.status === 'registration';
  // Undo only while check-in is open. The draw fixes the field once published.
  const canUndo = event.status === 'checkin';

  return (
    <div className="space-y-6">
      {/* Header with progress */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-[var(--text-primary)] flex items-center gap-2">
              <UserCheck className="w-5 h-5 text-[var(--color-success)]" />
              {event.status === 'checkin' ? 'CHECK-IN OPEN' : 'Check-In Status'}
            </h2>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              {isDoubles
                ? `${peopleCounts.peopleHere} / ${peopleCounts.people} players here · ${peopleCounts.teamsIn} / ${peopleCounts.teams} teams checked in`
                : `${checkedIn.length} / ${entries.length} checked in`}
            </p>
          </div>
          {canCheckIn && notCheckedIn.length > 0 && (
            <Button onClick={handleBulkCheckIn} loading={bulkLoading} variant="ghost" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
              Check In All Present
            </Button>
          )}
        </div>

        {/* Progress bar */}
        <div className="h-3 rounded-full bg-[var(--bg-elevated)] overflow-hidden" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} aria-label={isDoubles ? `Check-in progress: ${peopleCounts.peopleHere} of ${peopleCounts.people} players here` : `Check-in progress: ${checkedIn.length} of ${entries.length}`}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${progress}%`,
              backgroundColor: progress === 100 ? 'var(--color-success)' : 'var(--color-accent)',
            }}
          />
        </div>
        <div className="flex justify-between mt-2 text-xs text-[var(--text-muted)]">
          <span>{isDoubles ? `${peopleHere.length} here` : `${checkedIn.length} checked in`}</span>
          <span>{isDoubles ? peopleWaiting.length : notCheckedIn.length} waiting</span>
          {noShows.length > 0 && <span className="text-[var(--color-warning)]"><span className="sr-only">Warning: </span>{noShows.length} no-shows</span>}
        </div>
        {waiverBlocked.length > 0 && (
          <p className="mt-3 text-xs text-[var(--color-warning)]" role="status">
            <span className="sr-only">Warning: </span>
            {waiverBlocked.length} {isDoubles
              ? (waiverBlocked.length === 1 ? 'player has' : 'players have')
              : (waiverBlocked.length === 1 ? 'entry has' : 'entries have')} not accepted the
            event waiver and cannot be checked in. They must accept it themselves, signed in as themselves,
            from this tournament in the club app — nobody can do it for them.
            {' '}&ldquo;Check In All Present&rdquo; will take everyone else and tell you who it skipped.
          </p>
        )}
      </div>

      {isDoubles && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Not Yet Here ({peopleWaiting.length})
            </h3>
            <div className="space-y-2">
              {peopleWaiting.map((person) => (
                <PersonCard
                  key={`${person.pairId}:${person.slot}`}
                  person={person}
                  partnerHere={people.some(p => p.pairId === person.pairId && p.slot !== person.slot && p.here)}
                  waiverStates={waiverStates}
                  actions={canCheckIn ? (
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        onClick={() => handlePersonCheckIn(person)}
                        loading={loading === `${person.pairId}:${person.slot}`}
                        className="bg-[var(--color-success)] hover:bg-[color-mix(in_oklab,var(--color-success)_80%,transparent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                      >
                        <CheckCircle className="w-3.5 h-3.5 mr-1" /> Check In
                      </Button>
                      {noShowRow.has(`${person.pairId}:${person.slot}`) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleNoShow(person.pairId)}
                          loading={loading === `noshow-${person.pairId}`}
                          aria-label="Mark team no-show"
                          title="Mark team no-show"
                          className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                        >
                          <XCircle className="w-3.5 h-3.5 text-[var(--color-danger)]" />
                        </Button>
                      )}
                    </div>
                  ) : null}
                />
              ))}
              {peopleWaiting.length === 0 && (
                <p className="text-sm text-[var(--text-muted)] text-center py-4">Everyone is here!</p>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-[var(--color-success)] uppercase tracking-wider mb-3 flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              Here ({peopleHere.length})
            </h3>
            <div className="space-y-2">
              {peopleHere.map((person) => (
                <PersonCard
                  key={`${person.pairId}:${person.slot}`}
                  person={person}
                  partnerHere
                  waiverStates={waiverStates}
                  checked
                  actions={
                    <div className="flex items-center gap-1.5">
                      {person.checkedInAt && (
                        <span className="text-[10px] text-[var(--text-muted)] font-mono">
                          {new Date(person.checkedInAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: CLUB_TIMEZONE })}
                        </span>
                      )}
                      {canUndo && (
                        <UndoButton
                          label="Undo check-in"
                          loading={loading === `undo-${person.pairId}:${person.slot}`}
                          onClick={() => handlePersonUndo(person)}
                        />
                      )}
                    </div>
                  }
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Two columns: Not checked in | Checked in */}
      {!isDoubles && (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Not Yet Checked In */}
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Not Yet Checked In ({notCheckedIn.length})
          </h3>
          <div className="space-y-2">
            {notCheckedIn.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                isDoubles={isDoubles}
                waiverStates={waiverStates}
                actions={canCheckIn ? (
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => handleCheckIn(entry.id)}
                      loading={loading === entry.id}
                      className="bg-[var(--color-success)] hover:bg-[color-mix(in_oklab,var(--color-success)_80%,transparent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                    >
                      <CheckCircle className="w-3.5 h-3.5 mr-1" /> Check In
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleNoShow(entry.id)}
                      loading={loading === `noshow-${entry.id}`}
                      aria-label="Mark as no-show"
                      className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                    >
                      <XCircle className="w-3.5 h-3.5 text-[var(--color-danger)]" />
                    </Button>
                  </div>
                ) : null}
              />
            ))}
            {notCheckedIn.length === 0 && (
              <p className="text-sm text-[var(--text-muted)] text-center py-4">All participants checked in!</p>
            )}
          </div>
        </div>

        {/* Checked In */}
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-success)] uppercase tracking-wider mb-3 flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />
            Checked In ({checkedIn.length})
          </h3>
          <div className="space-y-2">
            {checkedIn.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                isDoubles={isDoubles}
                waiverStates={waiverStates}
                checked
                actions={
                  <div className="flex items-center gap-1.5">
                    {entry.checked_in_at && (
                      <span className="text-[10px] text-[var(--text-muted)] font-mono">
                        {/* Pinned locale and zone: the server renders in UTC, so the default
                            showed the wrong hour and failed hydration. */}
                        {new Date(entry.checked_in_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: CLUB_TIMEZONE })}
                      </span>
                    )}
                    {canUndo && entry.status === 'checked_in' && (
                      <UndoButton label="Undo check-in" loading={loading === `undo-${entry.id}`} onClick={() => handleUndo(entry.id, 'checkin')} />
                    )}
                  </div>
                }
              />
            ))}
          </div>
        </div>
      </div>
      )}

      {/* No Shows */}
      {noShows.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-warning)] uppercase tracking-wider mb-3 flex items-center gap-2">
            <XCircle className="w-4 h-4" />
            No Shows ({noShows.length})
          </h3>
          <div className="space-y-2">
            {noShows.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                isDoubles={isDoubles}
                dimmed
                actions={canUndo ? (
                  <UndoButton label="Undo no-show" loading={loading === `undo-${entry.id}`} onClick={() => handleUndo(entry.id, 'noshow')} />
                ) : null}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UndoButton({ label, loading, onClick }: { label: string; loading: boolean; onClick: () => void }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={onClick}
      loading={loading}
      aria-label={label}
      title={label}
      className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
    >
      <Undo2 className="w-3.5 h-3.5 mr-1" /> Undo
    </Button>
  );
}

/**
 * One person of a doubles team. `partnerHere` says how the team stands: on a
 * Here row, whether it is waiting on the partner; on a waiting row, whether
 * the partner has already arrived.
 */
function PersonCard({
  person,
  partnerHere,
  checked,
  actions,
  waiverStates,
}: {
  person: PairCheckInPerson;
  partnerHere: boolean;
  checked?: boolean;
  actions?: React.ReactNode;
  waiverStates: Record<string, EventWaiverStatus> | null;
}) {
  const teamState = person.pairStatus === 'checked_in'
    ? 'Team checked in'
    : checked
      ? `Waiting on ${person.partnerName}`
      : partnerHere ? `${person.partnerName} is here` : null;
  return (
    <div
      className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
        checked
          ? 'bg-[color-mix(in_oklab,var(--color-success)_5%,transparent)] border-[color-mix(in_oklab,var(--color-success)_20%,transparent)]'
          : 'bg-[var(--bg-elevated)] border-[var(--border)] hover:border-[var(--border-hover)]'
      }`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[var(--text-primary)]">{person.name}</span>
        <span className="block text-xs text-[var(--text-muted)]">
          with {person.partnerName}
          {teamState && <> · {teamState}</>}
        </span>
        <WaiverState states={waiverStates} playerIds={person.playerId ? [person.playerId] : []} />
      </span>
      {actions}
    </div>
  );
}

function EntryCard({
  entry,
  isDoubles,
  checked,
  dimmed,
  actions,
  waiverStates,
}: {
  entry: ParticipantWithPlayer | PairWithPlayers;
  isDoubles: boolean;
  checked?: boolean;
  dimmed?: boolean;
  actions?: React.ReactNode;
  waiverStates?: Record<string, EventWaiverStatus> | null;
}) {
  const name = getName(entry, isDoubles);

  return (
    <div
      className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
        checked
          ? 'bg-[color-mix(in_oklab,var(--color-success)_5%,transparent)] border-[color-mix(in_oklab,var(--color-success)_20%,transparent)]'
          : dimmed
          ? 'bg-[var(--bg-elevated)] border-[var(--border)]'
          : 'bg-[var(--bg-elevated)] border-[var(--border)] hover:border-[var(--border-hover)]'
      }`}
    >
      {/* Only the name fades on a no-show, so its Undo still reads as live. */}
      <div className={`flex items-center gap-2.5 ${dimmed ? 'opacity-50' : ''}`}>
        {entry.seed_number && (
          <span className="text-xs font-mono text-[var(--text-muted)] w-6 text-center">#{entry.seed_number}</span>
        )}
        {!isDoubles && <AvatarChip name={name} src={(entry as ParticipantWithPlayer).player?.avatar_url} size="sm" id={(entry as ParticipantWithPlayer).player?.id} />}
        <span className="min-w-0">
          <span className="block text-sm font-medium text-[var(--text-primary)]">{name}</span>
          {/* Under the name, the way /legal puts the signature line under a
              member's. On a pair this names the half that is holding it up. */}
          <WaiverState states={waiverStates ?? null} playerIds={entryPlayerIds(entry, isDoubles)} />
        </span>
      </div>
      {actions}
    </div>
  );
}
