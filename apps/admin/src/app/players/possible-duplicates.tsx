'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card } from '@badminton/ui';
import type { DuplicateStrength } from '@badminton/shared';
import { dismissPossibleDuplicate } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { MergePlayersButton } from './merge-players-button';

// POSSIBLE DUPLICATES (00320). Pairs of records the shared scorer thinks may be
// one person, strong and likely only. Nothing here merges on its own: Merge
// opens the existing dialog with the pair filled in, and "Not the same person"
// records the answer so the pair is never offered again.

export interface DuplicateSide {
  id: string;
  full_name: string;
  handle: string | null;
  identifier: string | null;
  email: string;
  avatar_url: string | null;
  has_login: boolean;
  status: string;
}

export interface DuplicateRow {
  keep: DuplicateSide;
  remove: DuplicateSide;
  strength: DuplicateStrength;
  reasons: string[];
}

export function PossibleDuplicates({ rows }: { rows: DuplicateRow[] }) {
  return (
    <Card>
      <div className="space-y-1">
        <h2 className="m-0 text-sm font-medium text-[var(--text-primary)]">Possible duplicates</h2>
        <p className="m-0 text-xs text-[var(--text-muted)]">
          Records that may be the same person. Two people can share a name, so check before you merge.
        </p>
      </div>
      <ul className="mt-4 divide-y divide-[var(--border)]">
        {rows.map((row) => (
          <DuplicatePairRow key={`${row.keep.id}:${row.remove.id}`} row={row} />
        ))}
      </ul>
    </Card>
  );
}

function DuplicatePairRow({ row }: { row: DuplicateRow }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const dismiss = () =>
    startTransition(async () => {
      const result = await dismissPossibleDuplicate(row.keep.id, row.remove.id);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      toast('Marked as two different people.', 'success');
      router.refresh();
    });

  const side = (person: DuplicateSide) => (
    <span className="min-w-0">
      <span className="block truncate text-sm text-[var(--text-primary)]">
        {person.full_name}
        {person.identifier && (
          <span className="ml-2 font-mono text-[10px] text-[var(--text-muted)]">{person.identifier}</span>
        )}
      </span>
      <span className="block truncate text-xs text-[var(--text-muted)]">
        {person.email} · {person.has_login ? 'has login' : 'no login'}
      </span>
    </span>
  );

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2">
        {side(row.keep)}
        {side(row.remove)}
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant={row.strength === 'strong' ? 'danger' : 'warning'} className="rounded-full">
            {row.strength === 'strong' ? 'Strong' : 'Likely'}
          </Badge>
          <span className="text-xs text-[var(--text-secondary)]">{row.reasons.join(' · ')}</span>
        </span>
      </div>
      <div className="flex items-center gap-2 [&_button]:min-h-[44px]">
        <MergePlayersButton
          players={[row.keep, row.remove]}
          initialKeepId={row.keep.id}
          initialRemoveId={row.remove.id}
          label="Merge"
        />
        <Button variant="ghost" onClick={dismiss} disabled={isPending}>
          Not the same person
        </Button>
      </div>
    </li>
  );
}
