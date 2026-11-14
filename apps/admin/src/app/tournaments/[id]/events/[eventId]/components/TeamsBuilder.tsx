'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Select } from '@badminton/ui';
import {
  canPairForEvent,
  categoryRequiredBy,
  planTeams,
  previewFromPlan,
  rerollUnlocked,
  swapMembers,
  toggleLock,
  type TeamCandidate,
  type TeamMode,
  type TeamPreview,
  type TournamentEventType,
} from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { candidatesOf, type TeamsBoard } from '@/lib/teams/load-teams-board';
import { addTeamByHand, confirmTeams, editTeam, getTeamsBoard, splitTeam } from '@/lib/tournament-actions/teams';

// GENERATE TEAMS (generate_teams, 00334), one panel on the doubles Participants
// tab. The plan is made here in the browser and nothing is written until
// Confirm; the server re-checks every pair. Hidden while the switch is off.

const MODE_OPTIONS = [
  { value: 'balanced', label: 'Balanced teams' },
  { value: 'similar', label: 'Similar partners' },
  { value: 'random', label: 'Random' },
];

const SECTION = 'text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]';

function randomRng(): () => number {
  return Math.random;
}

export function TeamsBuilder({ eventId, players }: { eventId: string; players: Array<{ id: string; full_name: string }> }) {
  const router = useRouter();
  const { toast } = useToast();
  const [board, setBoard] = useState<TeamsBoard | null>(null);
  const [mode, setMode] = useState<TeamMode>('balanced');
  const [preview, setPreview] = useState<TeamPreview | null>(null);
  const [previewPool, setPreviewPool] = useState<TeamCandidate[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [handFirst, setHandFirst] = useState('');
  const [handSecond, setHandSecond] = useState('');
  const [fullReserves, setFullReserves] = useState<TeamsBoard['reserves'] | null>(null);
  const [editing, setEditing] = useState<{ pairId: string; outgoing: string; incoming: string } | null>(null);

  const reload = useCallback(async () => {
    const result = await getTeamsBoard(eventId);
    if (result.ok) setBoard(result.data);
  }, [eventId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const player of players) map.set(player.id, player.full_name);
    for (const person of board?.pool ?? []) map.set(person.playerId, person.name);
    return map;
  }, [players, board]);
  const provisional = useMemo(() => new Set((board?.pool ?? []).filter((person) => person.provisional).map((person) => person.playerId)), [board]);

  if (!board) return null;
  const nameOf = (id: string) => names.get(id) ?? 'Player';
  const label = (id: string) => `${nameOf(id)}${provisional.has(id) ? ' (P)' : ''}`;
  const eventType = board.event.eventType as TournamentEventType;
  const eligible =
    categoryRequiredBy(eventType) === 'mixed'
      ? (a: TeamCandidate, b: TeamCandidate) => canPairForEvent(eventType, a.category ?? null, b.category ?? null)
      : undefined;
  const open = board.event.status === 'registration' || board.event.status === 'checkin';

  function generate(onlyOrphans: boolean) {
    const orphanSet = new Set(board!.orphanIds);
    const pool = candidatesOf(board!.pool).filter((candidate) => !onlyOrphans || orphanSet.has(candidate.playerId));
    setPreviewPool(pool);
    setPicked(null);
    setPreview(previewFromPlan(planTeams({ candidates: pool, mode, eligible, rng: randomRng() })));
  }

  function pick(id: string) {
    if (!preview) return;
    if (picked === null) return setPicked(id);
    setPreview(swapMembers(preview, picked, id));
    setPicked(null);
  }

  async function run<T>(work: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done: (data: T) => void) {
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (!result.ok) {
      toast(result.error, 'error');
      return;
    }
    done(result.data);
    await reload();
    router.refresh();
  }

  async function handleConfirm() {
    if (!preview || preview.teams.length === 0) return;
    await run(
      () => confirmTeams(eventId, { pairs: preview.teams.map((team) => [team.a, team.b] as [string, string]), mode }),
      (data) => {
        setPreview(null);
        toast(`${data.pairsMade} ${data.pairsMade === 1 ? 'team' : 'teams'} published${data.refused ? `, ${data.refused} refused` : ''}.`, data.refused ? 'error' : 'success');
        for (const reason of data.reasons) toast(reason, 'error');
      },
    );
  }

  async function handleAdd() {
    if (!handFirst) return;
    await run(
      () => addTeamByHand(eventId, handFirst, handSecond || null),
      (data) => {
        if (!data.added) {
          setFullReserves(data.reserves);
          return;
        }
        setFullReserves(null);
        setHandFirst('');
        setHandSecond('');
        toast(`Team added with ${data.partnerName}.`, 'success');
      },
    );
  }

  const enteredIds = new Set(board.pairs.flatMap((pair) => [pair.player1Id, pair.player2Id]).filter(Boolean) as string[]);
  const pickable = players.filter((player) => !enteredIds.has(player.id)).map((player) => ({ value: player.id, label: player.full_name }));
  const poolOptions = board.pool.map((person) => ({ value: person.playerId, label: label(person.playerId) }));

  return (
    <section className="mb-6 rounded-xl border border-[var(--border)] p-4 space-y-5" aria-label="Generate teams">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Generate teams</h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Plan teams from the {board.pool.length} {board.pool.length === 1 ? 'person' : 'people'} waiting, then Confirm to publish them.
          Published teams are kept on a re-run, and only new teams are told. Entry restrictions and the avoid list apply here, desk adds included.
          (P) marks a provisional rating, planned at the pool&apos;s median.
        </p>
      </div>

      {open && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-48">
            <Select aria-label="How to pair" options={MODE_OPTIONS} value={mode} onValueChange={(value) => setMode(value as TeamMode)} />
          </div>
          <Button size="sm" onClick={() => generate(false)} disabled={board.pool.length < 2 || busy}>
            Generate
          </Button>
          {board.orphanIds.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => generate(true)} disabled={busy}>
              Re-pair orphans ({board.orphanIds.length})
            </Button>
          )}
        </div>
      )}

      {preview && (
        <div className="space-y-2">
          <div className={SECTION}>Preview: click two names to swap them</div>
          <ul className="space-y-1">
            {preview.teams.map((team, index) => (
              <li key={`${team.a}-${team.b}`} className="flex flex-wrap items-center gap-2 text-sm">
                {[team.a, team.b].map((id) => (
                  <button
                    key={id}
                    type="button"
                    disabled={team.locked}
                    onClick={() => pick(id)}
                    className={`rounded px-2 py-0.5 ${picked === id ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--bg-elevated)]'}`}
                  >
                    {label(id)}
                  </button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setPreview(toggleLock(preview, index))}>
                  {team.locked ? 'Unlock' : 'Lock'}
                </Button>
              </li>
            ))}
          </ul>
          {preview.leftOver.length > 0 && (
            <p className="text-xs text-[var(--text-muted)]">
              Still waiting:{' '}
              {preview.leftOver.map((id) => (
                <button key={id} type="button" onClick={() => pick(id)} className="mr-1 underline">
                  {label(id)}
                </button>
              ))}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setPreview(rerollUnlocked(preview, previewPool, { mode, eligible, rng: randomRng() }))}>
              Re-roll unlocked
            </Button>
            <Button size="sm" onClick={handleConfirm} loading={busy} disabled={preview.teams.length === 0}>
              Confirm {preview.teams.length} {preview.teams.length === 1 ? 'team' : 'teams'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              Discard
            </Button>
          </div>
        </div>
      )}

      {open && (
        <div className="space-y-2">
          <div className={SECTION}>Add a team</div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-56">
              <Select aria-label="First player" placeholder="First player" options={pickable} value={handFirst} onValueChange={setHandFirst} />
            </div>
            <div className="w-56">
              <Select aria-label="Partner" placeholder="Suggest a partner" options={[{ value: '', label: 'Suggest a partner' }, ...pickable]} value={handSecond} onValueChange={setHandSecond} />
            </div>
            <Button size="sm" onClick={handleAdd} disabled={!handFirst || busy}>
              Add team
            </Button>
          </div>
          {fullReserves && (
            <p className="text-xs text-[var(--color-warning)]">
              The event is full, so a new entrant cannot be added.{' '}
              {fullReserves.length > 0
                ? `Promote a reserve from the waitlist below first: ${fullReserves.map((reserve) => reserve.name).join(', ')}.`
                : 'Nobody is on the waitlist.'}
            </p>
          )}
        </div>
      )}

      {board.pairs.length > 0 && (
        <div className="space-y-2">
          <div className={SECTION}>Teams</div>
          <ul className="space-y-1">
            {board.pairs.map((pair) => (
              <li key={pair.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-[var(--text-primary)]">{pair.name}</span>
                {pair.published && <Badge variant="success">Published</Badge>}
                {open && pair.player1Id && pair.player2Id && (
                  <>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing({ pairId: pair.id, outgoing: pair.player1Id!, incoming: '' })}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => splitTeam(pair.id), () => toast('Team split. Both are back in the pool.', 'success'))}>
                      Split
                    </Button>
                  </>
                )}
                {!open && <span className="text-xs text-[var(--text-muted)]">Use Substitute to change a team after the draw.</span>}
                {editing?.pairId === pair.id && (
                  <div className="flex w-full flex-wrap items-end gap-2">
                    <div className="w-48">
                      <Select
                        aria-label="Replace"
                        options={[pair.player1Id!, pair.player2Id!].map((id) => ({ value: id, label: `Replace ${nameOf(id)}` }))}
                        value={editing.outgoing}
                        onValueChange={(value) => setEditing({ ...editing, outgoing: value })}
                      />
                    </div>
                    <div className="w-56">
                      <Select aria-label="With" placeholder="With somebody waiting" options={poolOptions} value={editing.incoming} onValueChange={(value) => setEditing({ ...editing, incoming: value })} />
                    </div>
                    <Button
                      size="sm"
                      disabled={!editing.incoming || busy}
                      onClick={() => run(() => editTeam(pair.id, editing.outgoing, editing.incoming), () => { setEditing(null); toast('Team changed.', 'success'); })}
                    >
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {board.orphanIds.length > 0 && (
        <div className="space-y-1">
          <div className={SECTION}>Orphans</div>
          <p className="text-sm text-[var(--text-primary)]">{board.orphanIds.map(nameOf).join(', ')}</p>
        </div>
      )}

      {board.runLog.length > 0 && (
        <div className="space-y-1">
          <div className={SECTION}>Run log</div>
          <ul className="text-xs text-[var(--text-muted)]">
            {board.runLog.map((line, index) => (
              <li key={index}>{line.text}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
