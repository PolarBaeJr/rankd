'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, Loader2, MapPin, X } from 'lucide-react';
import { Button } from '@badminton/ui';
import { courtLabel, parseCourtList, type TournamentCourt } from '@badminton/shared';
import {
  addCourtHelper,
  addTournamentCourts,
  importCourtsFromMatches,
  moveTournamentCourt,
  removeCourtHelper,
  renameTournamentCourt,
  setTournamentCourtActive,
} from '@/lib/tournament-actions';
import type { ActionResult } from '@/lib/action-result';
import type { CourtHelper, HelperCandidate } from '@/lib/court-helpers';

// ---------------------------------------------------------------------------
// A TOURNAMENT'S COURTS (00273). Once a tournament lists its courts, the desk
// picks from them, a staged stage's court names must be on the list, and the
// database refuses two live matches on one court. A tournament with no courts
// keeps the desk's free-text box.
//
// Courts are switched off, never deleted, so a finished match keeps the court
// it was played on.
// ---------------------------------------------------------------------------

interface Props {
  tournamentId: string;
  /** Null when the database is older than 00273. */
  courts: TournamentCourt[] | null;
  /** Courts already typed on unfinished matches, offered as a one-tap import. */
  usedLabels: string[];
  /** tournaments.manage.update.write. Without it the list is read-only. */
  canEdit: boolean;
  /** What to say when `courts` is null. Passed in: the reader module is server only. */
  migrationMissing: string;
  /** Who keeps score on each court (00310); null when not read or before that migration. */
  helpers?: CourtHelper[] | null;
  /** Console members who may be named as helpers. */
  helperCandidates?: HelperCandidate[];
}

const inputClass =
  'min-h-[44px] px-3 bg-[var(--bg-surface)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-60';

export function CourtsEditor({
  tournamentId, courts, usedLabels, canEdit, migrationMissing, helpers = null, helperCandidates = [],
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  // The list reads as text until Edit, and the add box opens from its own
  // button, like every other saved record in the console.
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  function run(action: () => Promise<ActionResult<void>>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      // A refusal after work was saved (an import that could not link every
      // match) still refreshes, so the list shows what did land.
      if (!res.ok) setError(res.error);
      else after?.();
      router.refresh();
    });
  }

  if (courts === null) {
    return <p className="text-sm text-[var(--text-muted)]">{migrationMissing}</p>;
  }

  const labels = parseCourtList(adding);

  return (
    <div className="space-y-3">
      {courts.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          No courts listed. The desk types a court for each match. List the courts here and the desk picks from
          them, and two matches can never be sent to the same court at once.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
          {courts.map((court, i) => (
            <CourtRow
              // Remounted on Edit, so each opening seeds the name boxes from the
              // saved names rather than from a rename the server refused.
              key={editing ? `${court.id}:edit` : court.id}
              court={court}
              first={i === 0}
              last={i === courts.length - 1}
              canEdit={canEdit && editing}
              pending={pending}
              run={run}
              helpers={helpers ? helpers.filter((h) => h.court_id === court.id) : null}
              helperCandidates={helperCandidates}
              canManageHelpers={canEdit && editing && helpers !== null}
            />
          ))}
        </ul>
      )}

      {canEdit && !addOpen && (
        <div className="flex flex-wrap items-center gap-2">
          {/* DONE, NOT CANCEL. A rename saves on blur, and pressing any button
              blurs the box first, so there is no unsaved edit here to discard. */}
          {courts.length > 0 && (
            editing ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
                Done
              </Button>
            ) : (
              <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )
          )}
          <Button type="button" size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
            Add courts
          </Button>
          {pending && <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" aria-hidden />}
        </div>
      )}

      {canEdit && addOpen && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (labels.length > 0) {
              run(() => addTournamentCourts(tournamentId, labels), () => {
                setAdding('');
                setAddOpen(false);
              });
            }
          }}
        >
          <label className="flex-1 min-w-[12rem]">
            <span className="sr-only">Courts to add</span>
            <input
              type="text"
              value={adding}
              disabled={pending}
              onChange={(e) => setAdding(e.target.value)}
              placeholder="Add courts, e.g. 1-8 or 1, 2, Centre"
              className={`w-full ${inputClass}`}
            />
          </label>
          <Button type="submit" size="sm" disabled={pending || labels.length === 0}>
            Add {labels.length > 1 ? `${labels.length} courts` : 'court'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setAdding('');
              setAddOpen(false);
            }}
          >
            Cancel
          </Button>
          {courts.length === 0 && usedLabels.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => run(() => importCourtsFromMatches(tournamentId), () => setAddOpen(false))}
            >
              Add the courts already used ({usedLabels.map((l) => courtLabel(l) ?? l).join(', ')})
            </Button>
          )}
          {pending && <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" aria-hidden />}
        </form>
      )}

      {error && <p className="text-xs text-[var(--color-accent)]" role="alert">{error}</p>}
    </div>
  );
}

function CourtRow({
  court,
  first,
  last,
  canEdit,
  pending,
  run,
  helpers,
  helperCandidates,
  canManageHelpers,
}: {
  court: TournamentCourt;
  first: boolean;
  last: boolean;
  canEdit: boolean;
  pending: boolean;
  run: (action: () => Promise<ActionResult<void>>, after?: () => void) => void;
  /** This court's helpers, or null when they were not read. */
  helpers: CourtHelper[] | null;
  helperCandidates: HelperCandidate[];
  canManageHelpers: boolean;
}) {
  const [label, setLabel] = useState(court.label);
  const name = courtLabel(court.label) ?? court.label;

  function commitRename() {
    if (label.trim() === court.label) return;
    run(() => renameTournamentCourt(court.id, label), undefined);
  }

  const iconButton =
    'inline-flex items-center justify-center min-w-[44px] min-h-[44px] border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]';

  return (
    <li className="flex flex-wrap items-center gap-2 p-3">
      <MapPin className="w-4 h-4 text-[var(--text-muted)] shrink-0" aria-hidden />
      {canEdit ? (
        <label className="flex-1 min-w-[8rem]">
          <span className="sr-only">Name of {name}</span>
          <input
            type="text"
            value={label}
            maxLength={20}
            disabled={pending}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
              if (e.key === 'Escape') { setLabel(court.label); e.currentTarget.blur(); }
            }}
            className={`w-full ${inputClass}`}
          />
        </label>
      ) : (
        <span className="flex-1 min-w-[8rem] text-sm text-[var(--text-primary)]">{name}</span>
      )}
      {!canEdit && (
        <span className={`text-xs ${court.active ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`}>
          {court.active ? 'Active' : 'Switched off'}
        </span>
      )}
      {canEdit && (
        <>
          <button
            type="button"
            className={iconButton}
            disabled={pending || first}
            aria-label={`Move ${name} up`}
            onClick={() => run(() => moveTournamentCourt(court.id, 'up'))}
          >
            <ArrowUp className="w-4 h-4" aria-hidden />
          </button>
          <button
            type="button"
            className={iconButton}
            disabled={pending || last}
            aria-label={`Move ${name} down`}
            onClick={() => run(() => moveTournamentCourt(court.id, 'down'))}
          >
            <ArrowDown className="w-4 h-4" aria-hidden />
          </button>
          <button
            type="button"
            className={`${iconButton} px-3 text-xs font-medium`}
            disabled={pending}
            aria-pressed={court.active}
            aria-label={`${name} in use at this tournament`}
            onClick={() => run(() => setTournamentCourtActive(court.id, !court.active))}
          >
            {court.active ? 'Active' : 'Switched off'}
          </button>
        </>
      )}
      {helpers && (helpers.length > 0 || canManageHelpers) && (
        <div className="basis-full flex flex-wrap items-center gap-2 pl-6">
          <span className="text-xs text-[var(--text-muted)]">Helpers</span>
          {helpers.length === 0 && <span className="text-xs text-[var(--text-muted)]">None</span>}
          {helpers.map((h) => (
            <span
              key={h.player_id}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-0.5 text-xs text-[var(--text-primary)]"
            >
              {h.full_name}
              {canManageHelpers && (
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  disabled={pending}
                  aria-label={`Remove ${h.full_name} from ${name}`}
                  onClick={() => run(() => removeCourtHelper(court.id, h.player_id))}
                >
                  <X className="w-3 h-3" aria-hidden />
                </button>
              )}
            </span>
          ))}
          {canManageHelpers && (
            <label>
              <span className="sr-only">Add a helper to {name}</span>
              <select
                value=""
                disabled={pending}
                onChange={(e) => {
                  const playerId = e.target.value;
                  if (playerId) run(() => addCourtHelper(court.id, playerId));
                }}
                className={`${inputClass} min-h-[32px] text-xs`}
              >
                <option value="">Add helper</option>
                {helperCandidates
                  .filter((c) => !helpers.some((h) => h.player_id === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>{c.full_name}</option>
                  ))}
              </select>
            </label>
          )}
        </div>
      )}
    </li>
  );
}
