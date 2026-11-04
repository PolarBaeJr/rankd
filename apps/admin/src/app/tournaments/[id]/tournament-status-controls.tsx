'use client';

import { useState } from 'react';
import { Button, Dialog, Textarea } from '@badminton/ui';
import {
  updateTournamentStatus,
  completeTournamentWithEvents,
  suspendTournament,
  resumeTournament,
} from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import type { TournamentStatus } from '@badminton/shared';
import { Play, CheckCircle, Pause, ListChecks } from 'lucide-react';

interface Props {
  tournamentId: string;
  status: string;
  suspendedAt: string | null;
  suspensionReason: string | null;
  /** Events not yet completed. Finalising the last one closes the tournament by itself. */
  openEvents: number;
  /**
   * Kill switch auto_close_tournament. Off, the two closes are back as they
   * were: Mark Completed, and Finalise Events and Complete.
   */
  autoClose?: boolean;
}

export function TournamentStatusControls({ tournamentId, status, suspendedAt, openEvents, autoClose = true }: Props) {
  const [loading, setLoading] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [cascadeOpen, setCascadeOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { toast } = useToast();
  const router = useRouter();

  // updateTournamentStatus RETURNS its refusals rather than throwing them —
  // Next.js replaces anything thrown out of a Server Action in production with
  // a generic message, so "three events have not finished" would never reach
  // the exec. A returned refusal resolves normally, which means the old
  // `await ...; toast(success)` shape would paint a green toast over every one
  // of them and the exec would conclude the console was broken. Read `ok`.
  async function handleStatusChange(newStatus: TournamentStatus, label: string) {
    setLoading(true);
    const res = await updateTournamentStatus(tournamentId, newStatus);
    if (res.ok) {
      toast(`Tournament ${label}`, 'success');
      router.refresh();
    } else {
      // Long by design: the refusal names every unfinished event, because the
      // next thing the exec does is go and finish one.
      toast(res.error, 'error');
    }
    setLoading(false);
  }

  // The opt-in the refusal points at. Kept as its own button rather than an
  // escape hatch offered inside the error, so it is discoverable before the
  // exec has hit the wall — and so the console never has to recognise its own
  // refusal by matching on the text of it.
  async function handleCascade() {
    setLoading(true);
    const res = await completeTournamentWithEvents(tournamentId, 'completed');
    if (res.ok) {
      const { finalized, closed } = res.data;
      const parts = [
        finalized.length > 0 ? `${finalized.length} finalised` : null,
        closed.length > 0 ? `${closed.length} closed without results` : null,
      ].filter(Boolean);
      toast(
        parts.length > 0 ? `Tournament completed: ${parts.join(', ')}` : 'Tournament completed',
        'success',
      );
      setCascadeOpen(false);
      router.refresh();
    } else {
      toast(res.error, 'error');
    }
    setLoading(false);
  }

  async function handleSuspend(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await suspendTournament(tournamentId, reason);
      toast('Tournament suspended', 'success');
      setSuspendOpen(false);
      setReason('');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleResume() {
    setLoading(true);
    try {
      await resumeTournament(tournamentId);
      toast('Tournament resumed', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  if (suspendedAt) {
    return (
      <Button onClick={handleResume} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
        <Play className="w-4 h-4 mr-1.5" />
        Resume Tournament
      </Button>
    );
  }

  if (status === 'draft') {
    return (
      <Button onClick={() => handleStatusChange('active', 'activated')} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
        <Play className="w-4 h-4 mr-1.5" />
        Activate Tournament
      </Button>
    );
  }

  if (status === 'active') {
    return (
      <>
        {/* One tournament-level close. With an event still open it is "Close
            without results"; once every event is finished (and the tournament
            did not close by itself) it is the plain Mark Completed. */}
        {!autoClose ? (
          <>
            <Button variant="ghost" onClick={() => handleStatusChange('completed', 'completed')} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
              <CheckCircle className="w-4 h-4 mr-1.5" />
              Mark Completed
            </Button>
            <Button variant="ghost" onClick={() => setCascadeOpen(true)} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
              <ListChecks className="w-4 h-4 mr-1.5" />
              Finalise Events &amp; Complete
            </Button>
          </>
        ) : openEvents > 0 ? (
          <Button variant="ghost" onClick={() => setCascadeOpen(true)} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
            <ListChecks className="w-4 h-4 mr-1.5" />
            Close without results
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => handleStatusChange('completed', 'completed')} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
            <CheckCircle className="w-4 h-4 mr-1.5" />
            Mark Completed
          </Button>
        )}
        <Button variant="ghost" onClick={() => setSuspendOpen(true)} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
          <Pause className="w-4 h-4 mr-1.5" />
          Suspend
        </Button>
        {!autoClose ? (
          <Dialog open={cascadeOpen} onClose={() => setCascadeOpen(false)} title="Finalise events & complete">
            <div className="space-y-4">
              <p className="text-sm text-[var(--text-secondary)]">
                Every event that is ready will be finalised: positions, points and placement
                bonuses awarded exactly as a normal finish.
              </p>
              <p className="text-sm text-[var(--text-secondary)]">
                Any event that was never finished will be <strong>closed without results</strong>:
                its entrants get no position and no points. There is no undo.
              </p>
              <div className="flex items-center justify-between pt-2">
                <Button variant="ghost" onClick={() => setCascadeOpen(false)} type="button">Cancel</Button>
                <Button onClick={handleCascade} loading={loading}>Finalise &amp; Complete</Button>
              </div>
            </div>
          </Dialog>
        ) : (
        <Dialog open={cascadeOpen} onClose={() => setCascadeOpen(false)} title="Close without results?">
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              {openEvents === 1 ? '1 event is' : `${openEvents} events are`} not finished. An unfinished event
              is <strong>closed without results</strong>: its entrants get no places and no points. There is no undo.
            </p>
            <p className="text-sm text-[var(--text-secondary)]">
              An event whose matches are all decided is still finalised first, with places, points and
              placement bonuses as a normal finish. To finish the tournament with results, finalise each
              event instead: the tournament closes by itself after the last one.
            </p>
            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" onClick={() => setCascadeOpen(false)} type="button">Cancel</Button>
              <Button variant="danger" onClick={handleCascade} loading={loading}>Close without results</Button>
            </div>
          </div>
        </Dialog>
        )}
        <Dialog open={suspendOpen} onClose={() => setSuspendOpen(false)} title="Suspend Tournament">
          <form onSubmit={handleSuspend} className="space-y-4">
            <Textarea
              label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this tournament being paused?"
              required
              minLength={2}
              maxLength={500}
            />
            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" onClick={() => setSuspendOpen(false)} type="button">Cancel</Button>
              <Button type="submit" loading={loading}>Suspend Tournament</Button>
            </div>
          </form>
        </Dialog>
      </>
    );
  }

  return null;
}
