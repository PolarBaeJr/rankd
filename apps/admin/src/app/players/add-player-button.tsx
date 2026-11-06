'use client';

import { useState, useTransition } from 'react';
import { Button, Dialog, Input, Select, Switch } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { createPlayer } from '@/lib/actions';
import type { ExistingMatch } from '@/lib/possible-matches';
import { Plus } from 'lucide-react';

// Guest first and the default (00292): somebody added by hand has no login
// until they sign in, and a guest is sent nothing and kept off the member lists
// until then. Pick a division to add them as a full member straight away.
const STATUS_OPTIONS = [
  { value: 'guest', label: 'Guest' },
  { value: 'competitive', label: 'Competitive' },
  { value: 'recreational', label: 'Recreational' },
];

// Admin accounts are never created from this dialog — promote an existing,
// signed-up member via Edit instead (an added "player" has no login yet, and
// a passwordless admin account would bypass the passkey enrollment flow).
const ROLE_OPTIONS = [
  { value: 'player', label: 'Player' },
  { value: 'exec', label: 'Executive' },
];

// isAdmin: execs may add members, but not add one who is already an exec —
// that would be a second privileged identity. The Role select is admin-only and
// createPlayer rejects is_exec from a non-admin caller regardless.
export function AddPlayerButton({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('guest');
  const [role, setRole] = useState('player');
  const [isTrainer, setIsTrainer] = useState(false);
  // 00320. Members already on the roster by the name typed, offered before a
  // second record is made.
  const [matches, setMatches] = useState<ExistingMatch[] | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  function handleSubmit(createAnyway = false) {
    if (!firstName.trim() || !email.trim()) {
      toast('Name and email are required', 'error');
      return;
    }
    startTransition(async () => {
      try {
        const res = await createPlayer({
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim().toLowerCase(),
          status,
          role: 'player',
          is_exec: isAdmin && status !== 'guest' && role === 'exec',
          is_trainer: isAdmin && status !== 'guest' && isTrainer,
          ...(createAnyway ? { create_anyway: true } : {}),
        });
        if (!res.ok) { toast(res.error, 'error'); return; }
        if (res.data.matches) { setMatches(res.data.matches); return; }
        setMatches(null);
        toast('Player created', 'success');
        setOpen(false);
        setFirstName('');
        setLastName('');
        setEmail('');
        setStatus('guest');
        setRole('player');
        setIsTrainer(false);
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to create player', 'error');
      }
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="w-4 h-4 mr-1.5" /> Add Player
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add New Player">
        <div className="space-y-4">
          <Input
            label="First Name"
            value={firstName}
            onChange={(e) => { setFirstName(e.target.value); setMatches(null); }}
            placeholder="John"
          />
          <Input
            label="Last Name"
            value={lastName}
            onChange={(e) => { setLastName(e.target.value); setMatches(null); }}
            placeholder="Doe"
          />
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="john@sfu.ca"
          />
          <Select
            label="Status"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          />
          {status === 'guest' && (
            <p className="m-0 text-xs text-[var(--text-muted)]">
              No login, sent nothing, off the leaderboard and challenges, no dues. They become a
              member by signing in with this email.
            </p>
          )}
          {isAdmin && status !== 'guest' && (
            <>
              <Select
                label="Role"
                options={ROLE_OPTIONS}
                value={role}
                onChange={(e) => setRole(e.target.value)}
              />
              {/* Beside Role, not inside it: a trainer may also be an exec. */}
              <Switch
                label="Varsity trainer"
                description="Console access limited to the roster and varsity notes."
                checked={isTrainer}
                onChange={setIsTrainer}
              />
            </>
          )}
          {matches && matches.length > 0 && (
            <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
              {matches.map((match) => (
                <div key={match.id} className="flex flex-wrap items-center justify-between gap-2">
                  <p className="m-0 text-sm text-[var(--text-primary)]">
                    Did you mean {match.name}
                    {match.identifier ? ` (${match.identifier})` : ''}?
                    <span className="block text-xs text-[var(--text-muted)]">{match.reasons.join(' · ')}</span>
                  </p>
                  {/* Nothing to create: they are already on the roster, so this
                      opens them instead. */}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { setOpen(false); setMatches(null); router.push(`/players/${match.id}`); }}
                  >
                    Use this member
                  </Button>
                </div>
              ))}
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => handleSubmit(true)} loading={isPending}>
                  Create anyway
                </Button>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              onClick={() => handleSubmit()}
              loading={isPending}
              disabled={!firstName.trim() || !email.trim()}
            >
              Create Player
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
