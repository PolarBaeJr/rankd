'use client';

import { useState, useTransition } from 'react';
import { Button, Dialog, Select, Textarea } from '@badminton/ui';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@/components/toast-provider';
import { setConsoleAccess } from '@/lib/actions';
import { EXEC_ROLE_OPTIONS, type ExecRole } from '@/lib/console-access';
import { consoleAccessOffer } from '@/lib/console-access-offer';
import { REASON_MIN } from '@/lib/audit-reason';

// CHANGING SOMEBODY'S CONSOLE ACCESS FROM THE ROSTER, which the club owner asked
// for: "allow me to edit access from the player menu too, but only to people who
// have permission to do edits on the player menu."
//
// THIS REVERSES AN EARLIER DECISION OF THEIRS AND IS NOT THE OLD CONTROL COMING
// BACK. The one that used to live in the Edit dialog wrote role / is_exec /
// is_trainer through updatePlayer under a bare isAdmin check, with no self-edit
// refusal, no admin-target refusal and no closure test in either direction. This
// one calls setConsoleAccess — the /permissions action — so the roster and
// /permissions are the same act reached from two places rather than two writers
// that can disagree about what Admin means. player-field-access.ts still refuses
// the three columns from updatePlayer, from every caller, and that stays true:
// writeConsoleLevel is still the only thing that writes them.
//
// WHICH CAPABILITY "permission to do edits on the player menu" IS. It is
// players.consoleaccess.write, not players.update.write. setConsoleAccess
// requires the former server-side, so a control drawn for update holders would
// be a button that always refuses — and drawing it for them is exactly the
// escalation the capability was split out to prevent: somebody who may fix a
// member's phone number would be able to make themselves an executive.
//
// A COMPONENT OF ITS OWN, beside View and the two review controls rather than
// inside the tab's action set, for the reason PrivilegeReviewActions gives: the
// action set is roster-actions.ts's answer to "what does this tab offer", and a
// console level is orthogonal to the tab — an admin is an admin on Inactive too.

export function ConsoleAccessActions({
  playerId,
  playerName,
  current,
  canWrite,
  isSelf,
  viewerIsSuperAdmin,
}: {
  playerId: string;
  playerName: string;
  /** toRoleValue(role, is_exec, is_trainer) — what they hold today. */
  current: ExecRole;
  /** players.consoleaccess.write. The action is the gate; this only decides what is drawn. */
  canWrite: boolean;
  isSelf: boolean;
  /** Only a super admin may make, unmake or change an admin (00321). */
  viewerIsSuperAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<ExecRole>(current);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const { offered, options } = consoleAccessOffer({ canWrite, isSelf, current, viewerIsSuperAdmin });
  if (!offered) return null;

  // Whether a stored hand-picked set would survive, decided by the same rule
  // setConsoleAccessImpl uses: a composition is only consulted at executive and
  // trainer, so that one move keeps it and every other clears it. The roster row
  // does not know whether this member HAS one — widening the roster's query for
  // a rare case is not worth it — so the sentence is conditional and the panel
  // that can see the set is one link away.
  const live = (value: ExecRole) => value === 'executive' || value === 'trainer';
  const clears = !(live(current) && live(access));
  const changed = access !== current;

  // SEEDED ON OPEN, NOT RESET ON CLOSE, and the difference is a real defect
  // rather than a preference. useState does not re-initialise when `current`
  // changes, and a reset written into close() captures the value from the render
  // that defined it — the level as it was BEFORE the change. After a successful
  // none -> executive the router.refresh() makes `current` 'executive' while
  // `access` sits at the stale 'none', so reopening the dialog would show None
  // already selected, already counted as a change, with the reason box open and
  // Apply pointed straight back at the level they had just left.
  //
  // /permissions does not hit this because it drops the selection on success and
  // the panel unmounts. A roster row cannot drop itself, so it seeds instead.
  const openDialog = () => {
    setAccess(current);
    setReason('');
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setReason('');
  };

  const apply = () =>
    startTransition(async () => {
      const res = await setConsoleAccess(playerId, access, reason);
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      toast(
        access === 'none'
          ? `${playerName} no longer has console access`
          : `${playerName} — ${EXEC_ROLE_OPTIONS.find((o) => o.value === access)?.label}`,
        'success',
      );
      close();
      router.refresh();
    });

  return (
    <>
      <Button variant="ghost" onClick={openDialog} disabled={isPending}>
        Access
      </Button>

      {/* A SIBLING OF THE STRIP, never a child of anything sticky: Dialog is
          `fixed inset-0 z-50`, and a positioned ancestor makes a stacking
          context that traps it behind the table header. */}
      <Dialog open={open} onClose={close} title={`Console access — ${playerName}`}>
        <div className="space-y-4">
          <Select
            label="Level"
            // ADMIN IS OFFERED TO ADMINS ONLY, filtered rather than disabled —
            // see console-access-offer.ts. A greyed-out option invites "why
            // not", and the answer is documentation, not a tooltip.
            options={options}
            value={access}
            onChange={(e) => setAccess(e.target.value as ExecRole)}
          />

          {changed && (
            <>
              <p className="text-sm text-[var(--text-secondary)]">
                {access === 'none'
                  ? `${playerName} loses the console entirely.`
                  : current === 'none'
                    ? `${playerName} gets the console, starting from everything that level has always had.`
                    : access === 'admin' || access === 'super_admin'
                      ? 'Admins hold every capability by level, so nothing narrower is consulted afterwards.'
                      : 'Their level changes. The capability resolver does not look at levels, so a narrowed set goes on applying.'}
              </p>
              <p className="text-sm text-[var(--text-muted)]">
                {clears ? (
                  <>
                    If they have a hand-picked permission set, this clears it — a stored set nobody
                    can reach would sit dormant and wake up if they were promoted again. Look at it
                    first on{' '}
                    <Link href="/permissions" className="underline">
                      Permissions
                    </Link>
                    , which is the screen that can show you what they hold.
                  </>
                ) : (
                  <>
                    Executive and varsity trainer both consult a hand-picked set, so anything set for
                    them on{' '}
                    <Link href="/permissions" className="underline">
                      Permissions
                    </Link>{' '}
                    survives this move unchanged.
                  </>
                )}
              </p>
              <Textarea
                label="Reason (required)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this changing?"
              />
            </>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={isPending}>
              Cancel
            </Button>
            <Button
              onClick={apply}
              // REASON_MIN rather than a shorter floor of its own: this reason is
              // forwarded into setPlayerPermissions when the move clears a stored
              // composition, and that measures against the shared floor.
              disabled={!changed || reason.trim().length < REASON_MIN || isPending}
            >
              {isPending ? 'Saving…' : 'Apply'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
