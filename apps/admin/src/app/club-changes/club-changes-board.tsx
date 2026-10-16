'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, Checkbox, EmptyState, Input, Textarea, useConfirm } from '@badminton/ui';
import type { ActionResult } from '@/lib/action-result';
import {
  addClubChangeLine,
  announceClubChangeEntry,
  deleteClubChangeLine,
  postClubChanges,
  rewordClubChangeLine,
} from '@/lib/actions/club-changes';
import { CLUB_CHANGE_LINE_MAX, type ClubChangeGroup, type ClubChangeSource } from '@/lib/club-change-format';

// The console side of club changes (00286). Lines arrive from officer edits,
// get reworded or deleted here, and leave as one posted entry. The server
// formats and re-checks every line at posting, so nothing this component sends
// is the text members read: it sends ids and the revision it was shown.

export type BoardLine = {
  id: string;
  revision: number;
  source: ClubChangeSource;
  group: ClubChangeGroup;
  text: string;
  autoText: string | null;
  known: boolean;
  reworded: boolean;
  staleRewording: boolean;
  changedOn: string;
  by: string | null;
};

export type BoardEntry = {
  id: string;
  title: string | null;
  intro: string | null;
  lines: string[];
  postedOn: string;
  by: string | null;
  announced: boolean;
};

const inputClass =
  'w-full min-h-[44px] rounded-md px-3 bg-[var(--bg-surface)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-60';

function blocker(line: BoardLine): string | null {
  if (line.staleRewording) return 'The setting changed again after this was reworded. Check the wording.';
  if (!line.known && !line.reworded) return 'Needs wording before it can be posted.';
  return null;
}

export function ClubChangesBoard({
  lines,
  entries,
  canPost,
  announceBlocked,
}: {
  lines: BoardLine[];
  entries: BoardEntry[];
  canPost: boolean;
  /** Why posting as an announcement is not possible, or null when it is. */
  announceBlocked: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unchosen, setUnchosen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [wording, setWording] = useState('');
  const [newLine, setNewLine] = useState('');
  const [title, setTitle] = useState('');
  const [intro, setIntro] = useState('');
  const [announce, setAnnounce] = useState(false);

  const chosen = useMemo(() => lines.filter((line) => !unchosen.has(line.id)), [lines, unchosen]);
  const chosenBlocked = chosen.some((line) => blocker(line) !== null);

  function run<T>(action: () => Promise<ActionResult<T>>, after?: (data: T) => void) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error);
      else after?.(res.data);
      router.refresh();
    });
  }

  function post(selection: BoardLine[], asAnnouncement: boolean, withHeading: boolean) {
    run(
      () =>
        postClubChanges({
          items: selection.map((line) => ({ id: line.id, revision: line.revision })),
          title: withHeading ? title : undefined,
          intro: withHeading ? intro : undefined,
          announce: asAnnouncement,
        }),
      (result) => {
        if (withHeading) {
          setTitle('');
          setIntro('');
          setAnnounce(false);
        }
        setUnchosen(new Set());
        setNotice(
          result.announceFailed
            ? 'Posted to the What’s new page, but the announcement could not be sent. Use Announce below to try again.'
            : result.announced
              ? 'Posted to the What’s new page and sent as an announcement.'
              : 'Posted to the What’s new page.',
        );
      },
    );
  }

  const groups = useMemo(() => {
    const byGroup = new Map<ClubChangeGroup, BoardLine[]>();
    for (const line of lines) byGroup.set(line.group, [...(byGroup.get(line.group) ?? []), line]);
    return [...byGroup.entries()];
  }, [lines]);

  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="rounded-md border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-primary)]"
          style={{ background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' }}
        >
          {notice}
        </p>
      )}

      <Card>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Waiting to be posted</h2>
          <span className="text-xs text-[var(--text-muted)]">
            {lines.length === 1 ? '1 line' : `${lines.length} lines`}
          </span>
        </div>

        {lines.length === 0 ? (
          <EmptyState
            title="Nothing waiting"
            description="Changes to ratings, account rules, member pages, club links and officer roles show up here when they are saved. You can also add a line yourself."
          />
        ) : (
          <div className="space-y-5">
            {groups.map(([group, groupLines]) => (
              <section key={group} className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{group}</h3>
                <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
                  {groupLines.map((line) => {
                    const why = blocker(line);
                    const isEditing = editing === line.id;
                    return (
                      <li key={line.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
                        {canPost && (
                          <div className="pt-0.5">
                            <Checkbox
                              checked={!unchosen.has(line.id)}
                              onChange={(on) =>
                                setUnchosen((prev) => {
                                  const next = new Set(prev);
                                  if (on) next.delete(line.id);
                                  else next.add(line.id);
                                  return next;
                                })
                              }
                              disabled={pending}
                              label={`Include "${line.text}" in the next post`}
                            />
                          </div>
                        )}
                        <div className="min-w-0 flex-1 space-y-1">
                          {isEditing ? (
                            <div className="space-y-2">
                              <Textarea
                                aria-label="Wording members will read"
                                rows={2}
                                maxLength={CLUB_CHANGE_LINE_MAX}
                                value={wording}
                                onChange={(e) => setWording(e.target.value)}
                                disabled={pending}
                              />
                              {line.autoText && (
                                <p className="text-xs text-[var(--text-muted)]">Generated: {line.autoText}</p>
                              )}
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  disabled={pending || wording.trim() === ''}
                                  onClick={() => run(() => rewordClubChangeLine(line.id, wording), () => setEditing(null))}
                                >
                                  Save wording
                                </Button>
                                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(null)}>
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <p className="text-sm text-[var(--text-primary)] break-words">{line.text}</p>
                          )}
                          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                            <span>
                              {line.source === 'manual' ? 'Added' : 'Changed'} {line.changedOn}
                              {line.by ? ` by ${line.by}` : ''}
                            </span>
                            {line.reworded && <Badge variant="info">Reworded</Badge>}
                            {line.staleRewording && <Badge variant="warning">Changed again</Badge>}
                            {!line.known && !line.reworded && <Badge variant="warning">Needs wording</Badge>}
                          </div>
                          {why && <p className="text-xs text-[var(--color-danger)]">{why}</p>}
                        </div>
                        {canPost && !isEditing && (
                          <div className="flex flex-wrap gap-2 sm:justify-end">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={pending}
                              onClick={() => {
                                setEditing(line.id);
                                setWording(line.text);
                              }}
                            >
                              Reword
                            </Button>
                            {line.reworded && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={pending}
                                onClick={() => run(() => rewordClubChangeLine(line.id, ''))}
                              >
                                Use generated
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending || why !== null}
                              onClick={async () => {
                                const ok = await confirm({
                                  title: 'Post this line now?',
                                  message: `"${line.text}" goes on the members' What’s new page on its own. It is not sent as an announcement.`,
                                  confirmLabel: 'Post now',
                                });
                                if (ok) post([line], false, false);
                              }}
                            >
                              Post now
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={async () => {
                                const ok = await confirm({
                                  title: 'Delete this line?',
                                  message:
                                    'Members are never told about it. The setting itself stays as it is. A later change to the same setting starts a new line.',
                                  confirmLabel: 'Delete',
                                  danger: true,
                                });
                                if (ok) run(() => deleteClubChangeLine(line.id));
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {canPost && (
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <input
              className={inputClass}
              placeholder="Add a line of your own, for example: New shuttles from Monday."
              aria-label="A line of your own"
              maxLength={CLUB_CHANGE_LINE_MAX}
              value={newLine}
              onChange={(e) => setNewLine(e.target.value)}
              disabled={pending}
            />
            <Button
              variant="secondary"
              disabled={pending || newLine.trim() === ''}
              onClick={() => run(() => addClubChangeLine(newLine), () => setNewLine(''))}
            >
              Add line
            </Button>
          </div>
        )}
      </Card>

      {canPost && lines.length > 0 && (
        <Card>
          <h2 className="mb-1 text-base font-semibold text-[var(--text-primary)]">Post to members</h2>
          <p className="mb-4 text-sm text-[var(--text-muted)]">
            The ticked lines go on the What&apos;s new page as one entry, which anyone can read, signed in or not.
          </p>
          <div className="space-y-3">
            <Input
              label="Title (optional)"
              placeholder="Club changes"
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={pending}
            />
            <Textarea
              label="A sentence before the list (optional)"
              rows={2}
              maxLength={1000}
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              disabled={pending}
            />
            <div className="space-y-1">
              <Checkbox
                checked={announce && announceBlocked === null}
                onChange={setAnnounce}
                disabled={pending || announceBlocked !== null}
                label="Also post it as a club announcement, which is shared to Discord"
                showLabel
              />
              {announceBlocked && <p className="text-xs text-[var(--text-muted)]">{announceBlocked}</p>}
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Preview</p>
              <p className="text-sm font-semibold text-[var(--text-primary)]">{title.trim() || 'Club changes'}</p>
              {intro.trim() && <p className="mt-1 text-sm text-[var(--text-secondary)]">{intro.trim()}</p>}
              {chosen.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--text-muted)]">No lines are ticked.</p>
              ) : (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
                  {chosen.map((line) => (
                    <li key={line.id}>{line.text}</li>
                  ))}
                </ul>
              )}
            </div>

            {chosenBlocked && (
              <p className="text-xs text-[var(--color-danger)]">
                A ticked line needs wording first. Reword it, or untick it to leave it for later.
              </p>
            )}
            <Button
              disabled={pending || chosen.length === 0 || chosenBlocked}
              onClick={async () => {
                const ok = await confirm({
                  title: chosen.length === 1 ? 'Post 1 line?' : `Post ${chosen.length} lines?`,
                  message:
                    announce && announceBlocked === null
                      ? 'It goes on the What’s new page and out as a club announcement. A posted entry cannot be edited here.'
                      : 'It goes on the What’s new page. A posted entry cannot be edited here.',
                  confirmLabel: 'Post',
                });
                if (ok) post(chosen, announce && announceBlocked === null, true);
              }}
            >
              {chosen.length === lines.length ? 'Post all' : `Post ${chosen.length} of ${lines.length}`}
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="mb-4 text-base font-semibold text-[var(--text-primary)]">Posted</h2>
        {entries.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Nothing has been posted yet.</p>
        ) : (
          <ul className="space-y-3">
            {entries.map((entry) => (
              <li key={entry.id} className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">{entry.title ?? 'Club changes'}</p>
                  <span className="text-xs text-[var(--text-muted)]">
                    {entry.postedOn}
                    {entry.by ? ` by ${entry.by}` : ''}
                  </span>
                  {entry.announced ? (
                    <Badge variant="success">Announced</Badge>
                  ) : (
                    <Badge variant="neutral">What&apos;s new only</Badge>
                  )}
                </div>
                {entry.intro && <p className="mt-1 text-sm text-[var(--text-secondary)]">{entry.intro}</p>}
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
                  {entry.lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                {canPost && !entry.announced && announceBlocked === null && (
                  <div className="mt-3">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() =>
                        run(
                          () => announceClubChangeEntry(entry.id),
                          () => setNotice('Sent as an announcement.'),
                        )
                      }
                    >
                      Announce
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
