// Which buttons a roster row shows, decided by the tab you are looking at.
//
// The list used to show Edit / Ban / Remove on every tab, which is how an
// INACTIVE account ended up with no way back and a SUSPENDED one was offered
// "Ban". The club owner asked for the actions to match the tab instead:
//
//   Inactive        Edit, Restore
//   Suspended       Edit, Unban
//   Needs attention Edit
//   Recreational    Edit, Ban, Inactive
//   Competitive     Edit, Ban, Inactive
//
// "Needs attention" used to carry a Recreational and a Competitive button too.
// The club owner took them off: a signup can be an alumnus or an external as
// well as a division, so a two-button quick-approve was never the whole
// decision — it just made the common half look like all of it. The Edit dialog
// asks the whole question, and approving from it still goes through
// approvePlayer (see player-actions.tsx).
//
// Three columns are being conflated whenever this gets it wrong, so keep them
// apart:
//
//   is_banned    set by banPlayer, cleared by reinstatePlayer. "Unban".
//   status       competitive | recreational | suspended | pending_approval.
//   active_flag  "inactive". Cleared by removePlayer and nightly by the
//                mark-inactive-players edge function. NOT a status value.
//
// A pure function, deliberately: it is the one part of this feature that can be
// checked without a database, a browser or a session.

// ---------------------------------------------------------------------------

/**
 * Tabs on /players. Anything unrecognised falls back to the roster tabs.
 *
 * `all` is deliberately one of the ones that falls back, rather than earning a
 * case of its own. It is the unfiltered roster, so its rows arrive in every
 * state at once — and the default branch is the only one that decides per ROW
 * rather than per tab: it offers Unban to a banned member, Ban to everyone
 * else, and withholds Inactive from anybody moderated. A dedicated case could
 * only reproduce that, less well.
 */
export type RosterTab =
  | 'all'
  | 'competitive'
  | 'recreational'
  | 'attention'
  | 'suspended'
  | 'inactive';

export type RosterAction =
  | { kind: 'edit' }
  /** banPlayer — sets is_banned. */
  | { kind: 'ban' }
  /** reinstatePlayer — clears is_banned (and records the fee, for an admin). */
  | { kind: 'unban' }
  /** updatePlayer { active_flag: true, status } — back onto the active roster. */
  | { kind: 'restore' }
  /** updatePlayer { active_flag: false } — off the active roster, status untouched. */
  | { kind: 'inactive' }
  | { kind: 'remove' };

/** Only what changes which action applies — everything else is display. */
export interface RosterRowState {
  is_banned?: boolean | null;
  status?: string | null;
  /** An erased guest (00292): kept only as "Former guest#...", so nothing to act on. */
  erasedGuest?: boolean;
}

// removePlayer asks for players.remove.write, which no baseline below admin
// holds — an exec who saw the button would only get "Admin access required" on
// click, which is the thing this file exists to stop.
export interface RosterViewerState {
  isAdmin?: boolean;
}

/**
 * Two tabs list rows that reached them by different routes, so the flag decides:
 *
 *  - Suspended is `status = 'suspended' OR is_banned` — a member who was
 *    suspended without ever being banned needs their status put back, not a ban
 *    lifted that was never applied (reinstatePlayer would file a
 *    reinstatement_fees row for a ban that does not exist).
 *  - Competitive/Recreational list by status, so a banned member still appears
 *    there. Offering "Ban" to someone already banned is the bug in miniature.
 */
export function rosterActionsFor(
  tab: string,
  player: RosterRowState,
  viewer: RosterViewerState = {},
): RosterAction[] {
  // Remove is deliberately not offered anywhere. It wrote
  // { status: 'suspended', active_flag: false } — the same deactivation as
  // "Inactive", plus a silent suspension nobody asked for, which then put the
  // member on the Suspended tab offering to lift a ban that never happened.
  // "Inactive" does the reversible half and is undone from the Inactive tab, so
  // the two buttons were one action with a worse version of itself attached.
  // removePlayer() is still exported for an off-console/bulk path; it is the
  // button that was wrong, not the audited action.
  if (player.erasedGuest) return [];
  switch (tab) {
    case 'inactive':
      return [{ kind: 'edit' }, { kind: 'restore' }];
    case 'suspended':
      return [{ kind: 'edit' }, player.is_banned ? { kind: 'unban' } : { kind: 'restore' }];
    case 'attention':
      return [{ kind: 'edit' }];
    // A guest (00292) is not on the roster to be banned or marked inactive;
    // their own controls are Export data and Erase (GuestActions).
    case 'guests':
      return [{ kind: 'edit' }];
    default: {
      // "when a user is suspended please make it so they cannot be marked as
      // inactive, since they may get removed from suspended" — the club owner.
      // A banned member still appears on the roster tabs (they keep their
      // status), and is_banned reads to a member as exactly the same thing a
      // suspension does, so both withhold the button. updatePlayer() refuses
      // the same pair server-side; this only stops offering a control that is
      // certain to fail.
      const moderated = player.is_banned === true || player.status === 'suspended';
      return [
        { kind: 'edit' },
        player.is_banned ? { kind: 'unban' } : { kind: 'ban' },
        ...(moderated ? [] : [{ kind: 'inactive' } as RosterAction]),
      ];
    }
  }
}

/** Stable React key. No tab repeats a kind, so the kind is the key. */
export function rosterActionKey(action: RosterAction): string {
  return action.kind;
}
