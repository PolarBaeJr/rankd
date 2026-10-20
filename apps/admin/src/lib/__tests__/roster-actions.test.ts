import { describe, it, expect } from 'vitest';
import { rosterActionsFor, rosterActionKey, type RosterAction } from '../roster-actions';

const kinds = (actions: RosterAction[]) => actions.map((a) => a.kind);

describe('rosterActionsFor', () => {
  it('offers an inactive account a way back', () => {
    expect(kinds(rosterActionsFor('inactive', {}))).toEqual(['edit', 'restore']);
  });

  it('offers Unban — not Ban — on the suspended tab when they are actually banned', () => {
    expect(kinds(rosterActionsFor('suspended', { is_banned: true }))).toEqual(['edit', 'unban']);
  });

  it('restores rather than unbans a member who was suspended but never banned', () => {
    // The Suspended tab is `status = 'suspended' OR is_banned`. Unbanning here
    // would file a reinstatement_fees row for a ban that never happened.
    expect(kinds(rosterActionsFor('suspended', { is_banned: false }))).toEqual(['edit', 'restore']);
    expect(kinds(rosterActionsFor('suspended', {}))).toEqual(['edit', 'restore']);
  });

  it('offers a Needs Attention row nothing but Edit', () => {
    // The Recreational / Competitive quick-approve is gone: a signup can be an
    // alumnus or an external, so the division was never the whole decision.
    // Edit asks all of it, and approving from it still runs approvePlayer.
    expect(kinds(rosterActionsFor('attention', {}))).toEqual(['edit']);
  });

  it('gives the roster tabs Edit / Ban / Inactive', () => {
    for (const tab of ['competitive', 'recreational']) {
      expect(kinds(rosterActionsFor(tab, {}))).toEqual(['edit', 'ban', 'inactive']);
    }
  });

  it('never offers Inactive to a banned or suspended member', () => {
    // "when a user is suspended please make it so they cannot be marked as
    // inactive, since they may get removed from suspended" — the club owner.
    // A banned member keeps their division, so they are still listed on the
    // roster tabs; is_banned reads to a member as a suspension, so both count.
    for (const tab of ['competitive', 'recreational', '']) {
      expect(kinds(rosterActionsFor(tab, { is_banned: true }))).toEqual(['edit', 'unban']);
      expect(kinds(rosterActionsFor(tab, { status: 'suspended' }))).toEqual(['edit', 'ban']);
    }
  });

  it('never offers Ban to someone already banned', () => {
    // A banned member keeps their status, so they still appear on the roster
    // tabs as well as under Suspended.
    for (const tab of ['competitive', 'recreational', 'suspended']) {
      expect(kinds(rosterActionsFor(tab, { is_banned: true }))).not.toContain('ban');
    }
  });

  it('falls back to the roster actions for an unknown tab', () => {
    expect(kinds(rosterActionsFor('', {}))).toEqual(['edit', 'ban', 'inactive']);
    expect(kinds(rosterActionsFor('nonsense', {}))).toEqual(['edit', 'ban', 'inactive']);
  });

  it('never offers Remove — deactivating is Inactive now, and it is reversible', () => {
    for (const tab of ['competitive', 'recreational', 'attention', 'suspended', 'inactive']) {
      expect(kinds(rosterActionsFor(tab, {}))).not.toContain('delete');
    }
  });

  it('keys every button in a row uniquely', () => {
    for (const tab of ['competitive', 'recreational', 'attention', 'suspended', 'inactive']) {
      const keys = rosterActionsFor(tab, {}).map(rosterActionKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('always starts with Edit', () => {
    for (const tab of ['competitive', 'recreational', 'attention', 'suspended', 'inactive']) {
      expect(rosterActionsFor(tab, {})[0]?.kind).toBe('edit');
      expect(rosterActionsFor(tab, { is_banned: true })[0]?.kind).toBe('edit');
    }
  });

  // Remove wrote { status: 'suspended', active_flag: false } — "Inactive" plus a
  // silent suspension, which then parked the member on the Suspended tab
  // offering to lift a ban that never happened. Every case here previously ran
  // with viewer = {}, so the admin branch that actually rendered the button was
  // untested and it went on appearing on "needs attention".
  it('never offers Remove, including to an admin', () => {
    for (const tab of ['competitive', 'recreational', 'attention', 'suspended', 'inactive']) {
      for (const player of [{}, { is_banned: true }, { status: 'suspended' }]) {
        const kinds = rosterActionsFor(tab, player, { isAdmin: true }).map((a) => a.kind);
        expect(kinds).not.toContain('remove');
      }
    }
  });

  // The owner specified this tab exactly: "in the players tab make it so its
  // just the edit button". An admin gets no extra one either.
  it('offers exactly Edit on "needs attention", admin or not', () => {
    expect(rosterActionsFor('attention', {}, { isAdmin: true }).map((a) => a.kind)).toEqual(['edit']);
  });
});

// ---- THE ALL TAB ----
//
// It has no case in rosterActionsFor and must not grow one: its rows arrive in
// every state at once, so the per-row default branch is the only one that can
// be right for all of them.

describe('the All tab', () => {
  it('offers Ban to an ordinary member and Unban to a banned one', () => {
    expect(rosterActionsFor('all', { status: 'competitive' })).toEqual([
      { kind: 'edit' },
      { kind: 'ban' },
      { kind: 'inactive' },
    ]);
    expect(rosterActionsFor('all', { status: 'competitive', is_banned: true })).toEqual([
      { kind: 'edit' },
      { kind: 'unban' },
    ]);
  });

  it('withholds Inactive from a suspended member, the same as the roster tabs', () => {
    // The club owner's rule — a suspended member must not be markable inactive,
    // because they can be taken off Suspended. It has to hold on a tab that
    // lists them beside everybody else, which is exactly where it is easiest to
    // lose.
    const actions = rosterActionsFor('all', { status: 'suspended' });
    expect(actions.map((a) => a.kind)).not.toContain('inactive');
  });

  it('offers nothing on an erased guest, even Restore from Inactive (00292)', () => {
    for (const tab of ['inactive', 'guests', 'all', 'suspended']) {
      expect(rosterActionsFor(tab, { status: 'recreational', erasedGuest: true }, { isAdmin: true })).toEqual([]);
    }
  });
});
