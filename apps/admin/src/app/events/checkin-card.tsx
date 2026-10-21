'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpCircle, ListOrdered, UserPlus, X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Input,
  PlayerPicker,
  Tabs,
  normalizeSearchQuery,
  type PlayerOption,
} from '@badminton/ui';
import { CheckInList, type CheckInRow } from '@/components/checkin-list';
import { useToast } from '@/components/toast-provider';
import { setClubEventCheckIn } from '@/lib/actions/club-events';
import {
  addClubEventWalkIn,
  promoteClubEventWaiting,
  removeClubEventWaiting,
  setClubEventNoShow,
} from '@/lib/actions/club-event-door';

export interface WaitingRow {
  id: string;
  name: string;
  joinedAt: string;
  /** Told in the app that a place opened. */
  offered: boolean;
}

export interface PastGuest {
  name: string;
  email: string | null;
}

// The club event's door list (00293): members and the Google Form's
// non-members in one list. A row's key is `member:<player id>` or
// `guest:<external sign-up id>`, which is what the actions need back.
//
// With 00294 (`doorReady`) the door also takes walk-ins, no-shows and the
// waitlist. Without it the list is check-in only, as before.
export function ClubEventCheckIn({
  eventId,
  rows,
  canWrite,
  doorReady = false,
  waiting = [],
  members = [],
  pastGuests = [],
}: {
  eventId: string;
  rows: CheckInRow[];
  canWrite: boolean;
  doorReady?: boolean;
  waiting?: WaitingRow[];
  members?: PlayerOption[];
  pastGuests?: PastGuest[];
}) {
  const router = useRouter();
  const [walkInOpen, setWalkInOpen] = useState(false);
  const door = canWrite && doorReady;

  // More than one exec can be at the door, so the list re-reads every 20
  // seconds while it is open.
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 20_000);
    return () => clearInterval(timer);
  }, [router]);

  const whoOf = (row: CheckInRow) => {
    const [kind, id] = row.key.split(':') as ['member' | 'guest', string];
    return { kind, id };
  };
  async function onToggle(row: CheckInRow, here: boolean) {
    const result = await setClubEventCheckIn(eventId, whoOf(row), here);
    return result.ok ? null : result.error;
  }
  async function onNoShow(row: CheckInRow, noShow: boolean) {
    const result = await setClubEventNoShow(eventId, whoOf(row), noShow);
    if (result.ok) router.refresh();
    return result.ok ? null : result.error;
  }

  return (
    <div className="space-y-6">
      <Card className="p-0 pt-5">
        <CheckInList
          rows={rows}
          canWrite={canWrite}
          onToggle={onToggle}
          onNoShow={door ? onNoShow : undefined}
          actions={
            door && (
              <Button size="sm" onClick={() => setWalkInOpen(true)} className="shrink-0">
                <UserPlus className="h-3.5 w-3.5" /> Add walk-in
              </Button>
            )
          }
        />
      </Card>
      {door && <Waitlist eventId={eventId} waiting={waiting} />}
      {door && (
        <WalkInDialog
          eventId={eventId}
          open={walkInOpen}
          onClose={() => setWalkInOpen(false)}
          members={members}
          pastGuests={pastGuests}
        />
      )}
    </div>
  );
}

function Waitlist({ eventId, waiting }: { eventId: string; waiting: WaitingRow[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(row: WaitingRow, promote: boolean) {
    setBusy(row.id);
    try {
      const result = promote
        ? await promoteClubEventWaiting(eventId, row.id)
        : await removeClubEventWaiting(eventId, row.id);
      if (!result.ok) toast(result.error, 'error');
      else {
        toast(promote ? `${row.name} has the place and was told in the app.` : `${row.name} was taken off the waitlist.`);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-0">
      <div className="flex items-center gap-2 px-5 pt-5 pb-3">
        <ListOrdered className="h-4 w-4 text-[var(--text-muted)]" />
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Waitlist</h2>
        <Badge variant="default">{waiting.length}</Badge>
      </div>
      {waiting.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-[var(--text-muted)]">
          Nobody is waiting. Members can join the waitlist in the app once the event is full.
        </p>
      ) : (
        <>
          <p className="px-5 pb-3 text-xs text-[var(--text-muted)]">
            A no-show frees a place, and the first in line is told in the app. Give somebody the place here when they are at
            the door; they owe the fee like any sign-up.
          </p>
          <ol className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
            {waiting.map((row, index) => (
              <li key={row.id} className="flex items-center gap-3 px-5 py-3">
                <span className="w-6 shrink-0 font-mono text-sm text-[var(--text-muted)]">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-[var(--text-primary)]">{row.name}</div>
                  <div className="truncate text-xs text-[var(--text-muted)]">
                    Joined {new Date(row.joinedAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}
                  </div>
                </div>
                {row.offered && (
                  <Badge variant="info" className="hidden sm:inline-flex">
                    Offered
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => act(row, false)}
                  disabled={busy !== null}
                  aria-label={`Take ${row.name} off the waitlist`}
                >
                  <X className="h-3.5 w-3.5" /> Remove
                </Button>
                <Button size="sm" onClick={() => act(row, true)} loading={busy === row.id} disabled={busy !== null}>
                  <ArrowUpCircle className="h-3.5 w-3.5" /> Give place
                </Button>
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  );
}

// A member is picked (no fee, checked in at once). A guest is a name and, if
// they give one, an email; a guest who came before is picked from the list
// under the name so the same person is not typed in twice.
function WalkInDialog({
  eventId,
  open,
  onClose,
  members,
  pastGuests,
}: {
  eventId: string;
  open: boolean;
  onClose: () => void;
  members: PlayerOption[];
  pastGuests: PastGuest[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [kind, setKind] = useState<'member' | 'guest'>('member');
  const [playerId, setPlayerId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestions = useMemo(() => {
    const needle = normalizeSearchQuery(name);
    if (!needle) return [];
    return pastGuests
      .filter(
        (guest) =>
          normalizeSearchQuery(guest.name).includes(needle) &&
          !(guest.name === name.trim() && (guest.email ?? '') === email.trim()),
      )
      .slice(0, 5);
  }, [pastGuests, name, email]);

  function reset() {
    setPlayerId('');
    setName('');
    setEmail('');
    setError(null);
  }

  async function save() {
    setError(null);
    if (kind === 'member' && !playerId) return setError('Pick a member.');
    if (kind === 'guest' && !name.trim()) return setError('Type their name.');
    setSaving(true);
    try {
      const result = await addClubEventWalkIn(
        eventId,
        kind === 'member'
          ? { kind: 'member', playerId }
          : { kind: 'guest', name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}) },
      );
      if (!result.ok) return setError(result.error);
      const who = kind === 'member' ? members.find((m) => m.id === playerId)?.name ?? 'The member' : name.trim();
      toast(`${who} is in and checked in.`);
      reset();
      onClose();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a walk-in"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            <UserPlus className="h-3.5 w-3.5" /> Add and check in
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Tabs
          variant="subtle"
          activeTab={kind}
          onChange={(id) => {
            setKind(id as 'member' | 'guest');
            setError(null);
          }}
          tabs={[
            { id: 'member', label: 'Member' },
            { id: 'guest', label: 'Guest' },
          ]}
        />
        {kind === 'member' ? (
          <>
            <PlayerPicker
              label="Member"
              value={playerId}
              onChange={setPlayerId}
              players={members}
              placeholder="Search a name"
            />
            <p className="text-xs text-[var(--text-muted)]">
              Walk-ins pay no fee. The event can go over its capacity for them.
            </p>
          </>
        ) : (
          <>
            <div>
              <Input
                label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                autoComplete="off"
                placeholder="Their full name"
              />
              {suggestions.length > 0 && (
                <div className="mt-2">
                  <p className="mb-1.5 text-xs text-[var(--text-muted)]">Came before? Pick them:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((guest) => (
                      <button
                        key={`${guest.name}|${guest.email ?? ''}`}
                        type="button"
                        onClick={() => {
                          setName(guest.name);
                          setEmail(guest.email ?? '');
                        }}
                        className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs text-[var(--text-primary)] hover:border-[var(--text-muted)]"
                      >
                        {guest.name}
                        {guest.email && <span className="text-[var(--text-muted)]"> · {guest.email}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <Input
              label="Email (optional)"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              autoComplete="off"
              placeholder="Only if they want to give one"
            />
            <p className="text-xs text-[var(--text-muted)]">
              No fee. They have not signed the waiver, so the list flags them; have them sign it at the door.
            </p>
          </>
        )}
        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      </div>
    </Dialog>
  );
}
