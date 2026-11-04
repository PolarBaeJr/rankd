'use client';

import { useState } from 'react';
import { Button, Dialog, PlayerPicker } from '@badminton/ui';
import { previewPlayerMerge, mergePlayers, type MergePreviewRow } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Merge, ArrowRight, AlertTriangle } from 'lucide-react';

interface MergeCandidate {
  id: string;
  full_name: string;
  handle: string | null;
  email: string;
  avatar_url?: string | null;
  has_login: boolean;
  status: string;
}

interface Props {
  players: MergeCandidate[];
  /** Prefilled from a Possible duplicates pair (00320); the pickers stay editable. */
  initialKeepId?: string;
  initialRemoveId?: string;
  /** The trigger's text, for a button that is not the page's own. */
  label?: string;
}

/**
 * Merges a duplicate account into a surviving one. Two rows can never share a
 * UUID, so the survivor keeps its id and everything is repointed onto it.
 *
 * The survivor's own fields always win — whatever the admin entered on the
 * roster record (name, email, status) is preserved; only the login is adopted
 * from the account being removed. Deliberately preview-then-confirm: the
 * removal is irreversible, so the admin sees what blocks it first.
 */
export function MergePlayersButton({ players, initialKeepId = '', initialRemoveId = '', label = 'Merge duplicates' }: Props) {
  const [open, setOpen] = useState(false);
  const [keepId, setKeepId] = useState(initialKeepId);
  const [removeId, setRemoveId] = useState(initialRemoveId);
  const [blockers, setBlockers] = useState<MergePreviewRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [merging, setMerging] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  const keep = players.find((p) => p.id === keepId);
  const remove = players.find((p) => p.id === removeId);
  const bothChosen = Boolean(keepId && removeId && keepId !== removeId);
  const bothHaveLogin = Boolean(keep?.has_login && remove?.has_login);

  function reset() {
    setKeepId(initialKeepId); setRemoveId(initialRemoveId); setBlockers(null);
  }

  async function handleCheck() {
    setChecking(true);
    setBlockers(null);
    const res = await previewPlayerMerge(keepId, removeId);
    if (!res.ok) { toast(res.error, 'error'); setChecking(false); return; }
    setBlockers(res.data);
    setChecking(false);
  }

  async function handleMerge() {
    setMerging(true);
    const res = await mergePlayers(keepId, removeId);
    if (!res.ok) { toast(res.error, 'error'); setMerging(false); return; }
    toast(res.data.login_moved ? 'Accounts merged — login moved to the kept account' : 'Accounts merged', 'success');
    setMerging(false);
    setOpen(false);
    reset();
    router.refresh();
  }

  // The email/login line is the whole point here — two duplicates share a name,
  // so it is the only thing that tells the admin which record is which.
  const options = players.map((p) => ({
    id: p.id,
    name: p.full_name,
    handle: p.handle,
    avatarUrl: p.avatar_url,
    meta: `${p.email} · ${p.has_login ? 'has login' : 'no login'}`,
  }));

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Merge className="w-4 h-4 mr-1.5" /> {label}
      </Button>

      <Dialog open={open} onClose={() => { if (!merging) { setOpen(false); reset(); } }} title="Merge duplicate accounts">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Use this when the same person has two records — typically one added to the roster by an
            admin and one they created by signing up. The kept account keeps its own name, email and
            status; only the login is carried over.
          </p>

          <PlayerPicker
            label="Keep this account (admin-entered record)"
            players={options}
            value={keepId}
            onChange={(id) => { setKeepId(id); setBlockers(null); }}
          />
          <PlayerPicker
            label="Remove this account (will be deleted)"
            players={options}
            value={removeId}
            onChange={(id) => { setRemoveId(id); setBlockers(null); }}
          />

          {keep && remove && keepId === removeId && (
            <p className="text-sm text-[var(--color-danger)]">Pick two different accounts.</p>
          )}

          {bothChosen && (
            <div className="flex items-center gap-2 text-sm p-3 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)]">
              <span className="text-[var(--text-primary)]">{remove?.full_name}</span>
              <ArrowRight className="w-4 h-4 text-[var(--text-muted)]" />
              <span className="font-medium text-[var(--text-primary)]">{keep?.full_name}</span>
            </div>
          )}

          {bothHaveLogin && (
            <div className="flex gap-2 p-3 rounded-lg border border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)] text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--color-danger)] mt-0.5" />
              <span className="text-[var(--text-secondary)]">
                Both accounts have a login. Move the duplicate&apos;s sign-in method onto this
                account first, then delete the emptied auth user — otherwise the leftover login
                would create a third account at next sign-in.
              </span>
            </div>
          )}

          {blockers !== null && blockers.length > 0 && (
            <div className="p-3 rounded-lg border border-[color-mix(in_oklab,var(--color-warning)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-warning)_10%,transparent)] text-sm space-y-1">
              <div className="flex items-center gap-2 text-[var(--color-warning)] font-medium">
                <AlertTriangle className="w-4 h-4" /> History to carry across
              </div>
              <ul className="text-[var(--text-secondary)] list-disc pl-5">
                {blockers.map((b) => (
                  <li key={b.table_name}>{b.table_name}: {b.row_count}</li>
                ))}
              </ul>
              {/* Not a blocker since 00163. Rows move where they fit; where the
                  surviving account is already in that match, session or event,
                  its own row wins and the duplicate's is dropped. Anything worth
                  a second look — above all a match both accounts played in — is
                  flagged on the surviving player afterwards. */}
              <p className="text-[var(--text-muted)]">
                These move across where they fit. Where this player is already in the same
                match, session or event, their existing row is kept and the duplicate&apos;s is
                dropped — you&apos;ll get a review flag listing exactly what happened.
              </p>
            </div>
          )}

          {blockers !== null && blockers.length === 0 && (
            <p className="text-sm text-[var(--color-success)]">
              Nothing to carry across — the account being removed has no history.
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => { setOpen(false); reset(); }} disabled={merging}>
              Cancel
            </Button>
            {blockers === null ? (
              <Button onClick={handleCheck} disabled={!bothChosen || checking || bothHaveLogin}>
                {checking ? 'Checking…' : 'Check'}
              </Button>
            ) : (
              <Button variant="danger" onClick={handleMerge} disabled={merging}>
                {merging ? 'Merging…' : blockers.length > 0 ? 'Merge anyway' : 'Merge accounts'}
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
