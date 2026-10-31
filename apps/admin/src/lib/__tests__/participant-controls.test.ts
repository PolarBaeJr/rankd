import { describe, it, expect } from 'vitest';
import {
  participantControls,
  regenerateDrawControl,
  type DrawCapabilities,
  type ParticipantControls,
} from '../participant-controls';

// THE PARTICIPANTS TAB OFFERED ITS CONTROLS TO EVERYBODY WHO COULD SEE THE PAGE.
//
// `canModify` was `event.status === 'registration'` and nothing else, so Add,
// Auto-Seed and Clear Seeds rendered for any viewer the event page admitted and
// the server action refused on click. These tests are the pair to that refusal:
// the button now has to agree with the action about who may press it, and the
// status rule it already had has to survive intact.

const NOBODY: DrawCapabilities = {
  add: false,
  remove: false,
  seedSet: false,
  seedAuto: false,
  seedClear: false,
  exit: false,
  soloAdd: false,
  soloRemove: false,
  generate: false,
  // Added for the Court Management tab (00135). Listed here so the exhaustive
  // sweeps below — which iterate Object.keys(NOBODY) — cover it: no participants
  // control and no redraw button may start reading it by accident.
  manageCourts: false,
  enterResult: false,
  // Settling a category change after play (00279), results.edit.write.
  approveCategory: false,
};

const EVERYTHING: DrawCapabilities = {
  add: true,
  remove: true,
  seedSet: true,
  seedAuto: true,
  seedClear: true,
  exit: true,
  soloAdd: true,
  soloRemove: true,
  generate: true,
  manageCourts: true,
  enterResult: true,
  approveCategory: true,
};

const only = (key: keyof DrawCapabilities): DrawCapabilities => ({ ...NOBODY, [key]: true });

const shown = (c: ParticipantControls) =>
  (Object.keys(c) as Array<keyof ParticipantControls>).filter((k) => c[k]).sort();

const registration = { status: 'registration', drawLocked: false };
const drawn = { status: 'bracket_generated', drawLocked: true };

describe('participantControls: a team category in a staged event', () => {
  it('is offered on a staged event to a holder of seed.set.write, through play', () => {
    for (const status of ['registration', 'checkin', 'bracket_generated', 'live']) {
      expect(participantControls({ status, drawLocked: false, staged: true }, only('seedSet')).editCategory).toBe(true);
    }
  });

  it('is not offered without the capability, on a locked or finalised event, or off a staged one', () => {
    expect(participantControls({ status: 'live', drawLocked: false, staged: true }, NOBODY).editCategory).toBe(false);
    expect(participantControls({ status: 'live', drawLocked: true, staged: true }, EVERYTHING).editCategory).toBe(false);
    expect(participantControls({ status: 'completed', drawLocked: false, staged: true }, EVERYTHING).editCategory).toBe(false);
    expect(participantControls({ status: 'live', drawLocked: false }, EVERYTHING).editCategory).toBe(false);
    expect(participantControls({ status: 'live', drawLocked: false, staged: false }, EVERYTHING).editCategory).toBe(false);
  });

  // Approving or declining a change after play (00279): its own key, open until
  // the event is finalised, and the draw lock does not close it, because the
  // lock freezes the entry list and this decides what played matches mean.
  it.each([
    // status,             drawLocked, staged, capability,         decide
    ['registration',       false,      true,   'approveCategory',  true],
    ['checkin',            false,      true,   'approveCategory',  true],
    ['bracket_generated',  false,      true,   'approveCategory',  true],
    ['live',               false,      true,   'approveCategory',  true],
    ['live',               true,       true,   'approveCategory',  true],
    ['completed',          false,      true,   'approveCategory',  false],
    ['live',               false,      false,  'approveCategory',  false],
    ['live',               false,      true,   'seedSet',          false],
    ['live',               false,      true,   'enterResult',      false],
  ] as const)('decideCategory at %s, locked %s, staged %s, holding %s: %s', (status, drawLocked, staged, key, decide) => {
    expect(participantControls({ status, drawLocked, staged }, only(key)).decideCategory).toBe(decide);
  });

  it('does not offer the category cell to an approver who cannot set seeds', () => {
    expect(participantControls({ status: 'live', drawLocked: false, staged: true }, only('approveCategory')).editCategory).toBe(false);
  });
});

describe('participantControls: a late entry into a staged event (00308)', () => {
  const late = { status: 'live', drawLocked: false, staged: true, lateEntry: true };

  it('opens Add, and only Add, while the window is open', () => {
    expect(participantControls(late, EVERYTHING).add).toBe(true);
    expect(participantControls({ ...late, status: 'bracket_generated' }, EVERYTHING).add).toBe(true);
    expect(participantControls(late, EVERYTHING).addSolo).toBe(false);
    expect(participantControls(late, EVERYTHING).pair).toBe(false);
  });

  it('still asks the capability and the draw lock', () => {
    expect(participantControls(late, NOBODY).add).toBe(false);
    expect(participantControls({ ...late, drawLocked: true }, EVERYTHING).add).toBe(false);
  });

  it('changes nothing when the window is shut', () => {
    expect(participantControls({ ...late, lateEntry: false }, EVERYTHING))
      .toEqual(participantControls({ status: 'live', drawLocked: false, staged: true }, EVERYTHING));
  });
});

describe('participantControls — capability, not just status', () => {
  it('offers nothing at all to a viewer holding none of the six', () => {
    // The whole bug, in one assertion. This viewer could open the event page,
    // and got the full control bar.
    expect(shown(participantControls(registration, NOBODY))).toEqual([]);
    expect(shown(participantControls(drawn, NOBODY))).toEqual([]);
    expect(shown(participantControls({ status: 'live', drawLocked: false }, NOBODY))).toEqual([]);
  });

  it('offers the whole bar during registration to somebody who holds it all', () => {
    const c = participantControls(registration, EVERYTHING);

    expect(c.add).toBe(true);
    expect(c.autoSeed).toBe(true);
    expect(c.clearSeeds).toBe(true);
    expect(c.editSeed).toBe(true);
    expect(c.remove).toBe(true);
    // No draw yet, so there is nothing to withdraw FROM.
    expect(c.withdraw).toBe(false);
  });

  it('does not let one capability stand in for another', () => {
    // A seeding desk without the roster, and a roster desk without the seeds.
    // The actions ask different questions, so the buttons do too.
    //
    // `add` brings `pair` with it and `remove` brings `unpair`, and that is not
    // a leak: both pairs are the SAME capability behind the same action —
    // pairs.add.write for addPairToEvent, pairs.remove.write for unpairEntry —
    // differing only in which of the two the exec is looking at.
    //
    // `autoPair` joins that group for the same reason and NO new capability was
    // minted for it: autoPairWaitingEntrants asks pairs.add.write and then calls
    // addPairToEvent once per pair, so it is the same act in bulk.
    expect(shown(participantControls(registration, only('add')))).toEqual(['add', 'autoPair', 'pair']);
    // Notably NOT 'swapMember': it needs both pair keys, so one alone buys
    // nothing. That is the assertion that keeps the swap from becoming the way
    // a holder of add does remove's job.
    expect(shown(participantControls(registration, only('add')))).not.toContain('swapMember');
    expect(shown(participantControls(registration, only('remove')))).not.toContain('swapMember');
    expect(shown(participantControls(registration, only('seedAuto')))).toEqual(['autoSeed']);
    expect(shown(participantControls(registration, only('seedClear')))).toEqual(['clearSeeds']);
    expect(shown(participantControls(registration, only('seedSet')))).toEqual(['editSeed']);
    expect(shown(participantControls(registration, only('remove')))).toEqual([
      'actionsColumn', 'remove', 'unpair',
    ]);
    // The two participants.* keys a doubles event now also asks for. They are
    // NOT the same as add/remove, which are the pairs.* keys in a doubles
    // event, and holding one must not offer the other.
    expect(shown(participantControls(registration, only('soloAdd')))).toEqual(['addSolo']);
    expect(shown(participantControls(registration, only('soloRemove')))).toEqual(['removeSolo']);
  });

  it('keeps pairing and removal available at check-in, when adding is not', () => {
    // Check-in is when the club finds out who turned up without a partner, so
    // pairing them up has to be possible at the door — and the actions accept
    // it (addPairToEvent, unpairEntry and withdrawPairMember all take
    // 'registration' or 'checkin').
    //
    // REMOVAL MOVED HERE AFTER A DEAD END. It used to stop at registration, and
    // withdrawal only begins once a draw exists, so an event at check-in
    // offered no way to take anybody out at all — with forward-only status
    // transitions, there was no way back either. The owner hit it live: one
    // entrant to remove, under two checked in, and the event stuck.
    //
    // ADDING deliberately did NOT move. Check-in is when somebody has to come
    // out, not when more come in.
    const checkin = participantControls({ status: 'checkin', drawLocked: false }, EVERYTHING);
    expect(checkin.pair).toBe(true);
    // Auto pair especially: a room of people who turned up without partners is
    // the exact situation it exists for, and it is a check-in-desk situation.
    expect(checkin.autoPair).toBe(true);
    expect(checkin.unpair).toBe(true);
    expect(checkin.withdrawMember).toBe(true);
    // The injury substitution is a check-in-morning operation if anything is.
    expect(checkin.swapMember).toBe(true);
    expect(checkin.add).toBe(false);
    expect(checkin.addSolo).toBe(false);
    expect(checkin.remove).toBe(true);
    expect(checkin.removeSolo).toBe(true);
  });

  it('never offers a pairing control once a draw exists', () => {
    // A seeded pair cannot be split up — tournament_matches.pair_a_id and its
    // three siblings reference tournament_pairs(id) with no ON DELETE action,
    // so the database refuses the delete outright. The whole-pair withdrawal is
    // the only coherent exit from here.
    for (const status of ['bracket_generated', 'live', 'completed']) {
      const c = participantControls({ status, drawLocked: false }, EVERYTHING);
      expect(c.pair).toBe(false);
      expect(c.autoPair).toBe(false);
      expect(c.unpair).toBe(false);
      expect(c.withdrawMember).toBe(false);
      // Swapping matters most here, because unlike unpairing it is an UPDATE —
      // no foreign key refuses it, so the button going away and the function's
      // own check are the only two things between an exec and rewriting who
      // played a match that is already rated.
      expect(c.swapMember).toBe(false);
    }
    // And a locked draw freezes them too, capability or no capability.
    const locked = participantControls({ status: 'registration', drawLocked: true }, EVERYTHING);
    expect(locked.pair).toBe(false);
    expect(locked.autoPair).toBe(false);
    expect(locked.unpair).toBe(false);
    expect(locked.withdrawMember).toBe(false);
    expect(locked.swapMember).toBe(false);
  });

  it('offers Auto pair exactly when it offers manual pairing, and never otherwise', () => {
    // THE ASSERTION THAT KEEPS THE TWO FROM DRIFTING APART. Auto pair calls
    // addPairToEvent once per pair, so a state where the bulk button is offered
    // and the single one is not would be a button that is guaranteed to be
    // refused — and the reverse would be a capability check the bulk path had
    // quietly widened. Swept over every status, both lock states, and every
    // single-capability holder rather than asserted on the happy path.
    const statuses = ['registration', 'checkin', 'bracket_generated', 'live', 'completed', 'cancelled'];
    const holders: DrawCapabilities[] = [
      NOBODY,
      EVERYTHING,
      ...(Object.keys(NOBODY) as Array<keyof DrawCapabilities>).map((k) => only(k)),
    ];

    for (const status of statuses) {
      for (const drawLocked of [false, true]) {
        for (const can of holders) {
          const c = participantControls({ status, drawLocked }, can);
          expect(c.autoPair).toBe(c.pair);
        }
      }
    }
  });

  it('keeps the status condition — both have to hold', () => {
    // Holding everything is not a way past a locked draw or a live event.
    const locked = participantControls({ status: 'registration', drawLocked: true }, EVERYTHING);
    expect(locked.add).toBe(false);
    expect(locked.autoSeed).toBe(false);
    expect(locked.clearSeeds).toBe(false);
    expect(locked.editSeed).toBe(false);
    expect(locked.remove).toBe(false);

    const live = participantControls({ status: 'live', drawLocked: false }, EVERYTHING);
    expect(live.add).toBe(false);
    expect(live.editSeed).toBe(false);
    expect(live.remove).toBe(false);
  });

  it('offers Withdraw only once a draw exists, and never after the event is over', () => {
    for (const status of ['bracket_generated', 'live']) {
      expect(participantControls({ status, drawLocked: false }, EVERYTHING).withdraw).toBe(true);
    }
    for (const status of ['registration', 'checkin', 'completed']) {
      expect(participantControls({ status, drawLocked: false }, EVERYTHING).withdraw).toBe(false);
    }
  });

  it('never offers Remove and Withdraw at the same time', () => {
    // Remove deletes the entry outright and is only safe before a draw; withdraw
    // forfeits the matches they are seeded into. Offering both would mean one
    // bracket could take two different exits for the same player.
    for (const status of ['registration', 'checkin', 'bracket_generated', 'live', 'completed']) {
      for (const drawLocked of [true, false]) {
        const c = participantControls({ status, drawLocked }, EVERYTHING);
        expect(c.remove && c.withdraw).toBe(false);
      }
    }
  });

  it('draws the Actions column only when a row actually has an action', () => {
    // A column headed "Actions" whose every cell is empty is the same dead
    // invitation one row up.
    expect(participantControls(registration, only('remove')).actionsColumn).toBe(true);
    expect(participantControls(drawn, only('exit')).actionsColumn).toBe(true);

    // Holds the seeding capabilities and neither row action.
    const seedsOnly = { ...NOBODY, seedSet: true, seedAuto: true, seedClear: true };
    expect(participantControls(registration, seedsOnly).actionsColumn).toBe(false);
    // Holds remove, but the draw is locked, so the rows have nothing to offer.
    expect(
      participantControls({ status: 'registration', drawLocked: true }, only('remove')).actionsColumn,
    ).toBe(false);
  });

  it('lets the draw lock freeze the list without touching the withdrawal path', () => {
    // draw_locked is the event's own switch, not a permission — and a locked
    // draw is exactly when a withdrawal is the only coherent exit left.
    expect(participantControls(drawn, EVERYTHING).withdraw).toBe(true);
    expect(participantControls(drawn, EVERYTHING).remove).toBe(false);
  });

  it('says nothing about a status it has never heard of', () => {
    // A migration adding a sixth event status must not open a control by
    // default. Every branch here is an allow-list.
    expect(shown(participantControls({ status: 'archived', drawLocked: false }, EVERYTHING))).toEqual(
      [],
    );
  });

  it('does not let the new generate capability open a participants control', () => {
    // `generate` was added to DrawCapabilities for the header's Regenerate
    // button, and nothing on this tab may start reading it by accident.
    expect(shown(participantControls(registration, only('generate')))).toEqual([]);
    expect(shown(participantControls({ status: 'bracket_generated', drawLocked: false }, only('generate')))).toEqual([]);
  });
});

describe('regenerateDrawControl — a way back to Generate', () => {
  const at = (status: string, drawLocked = false, playedMatches = 0) =>
    ({ status, drawLocked, playedMatches });

  it('offers the redraw exactly where a draw exists and can still honestly be redone', () => {
    for (const status of ['bracket_generated', 'live']) {
      const c = regenerateDrawControl(at(status), EVERYTHING);
      expect(c.show, status).toBe(true);
      expect(c.blockedReason, status).toBeNull();
    }
  });

  it('OFFERS IT AT `live`, WHICH IT USED TO REFUSE ON PRINCIPLE', () => {
    // The old rule was `status !== 'bracket_generated' -> hidden`, argued on
    // the grounds that going live records walkovers for anyone who withdrew
    // (setEventStatus -> forfeitOutOfEventEntries) so the action would usually
    // refuse anyway. It was wrong about the frequency and the owner walked into
    // the gap: they pressed "Start Tournament" and the button disappeared with
    // no way back. Three of the four live events on staging have nothing played
    // — the sweep only fires when somebody actually withdrew.
    const live = regenerateDrawControl(at('live'), EVERYTHING);
    expect(live.show).toBe(true);
    expect(live.blockedReason).toBeNull();
  });

  it('never offers it at any other status', () => {
    // `completed` is the one that stays refused, and not for want of a guard:
    // finalizeEvent has already awarded final positions, tournament points and
    // placement bonuses off the current draw, and nothing in the console can
    // take those back (assertNotFinalised).
    for (const status of ['registration', 'checkin', 'completed', 'cancelled', 'archived']) {
      expect(regenerateDrawControl(at(status), EVERYTHING).show, status).toBe(false);
    }
  });

  it('asks the capability, and asks only that one', () => {
    for (const status of ['bracket_generated', 'live']) {
      expect(regenerateDrawControl(at(status), NOBODY).show, status).toBe(false);
      expect(regenerateDrawControl(at(status), only('generate')).show, status).toBe(true);
      // No other key buys it. Holding the seeding desk or the roster is not
      // permission to throw the draw away and build another.
      for (const key of Object.keys(NOBODY) as Array<keyof DrawCapabilities>) {
        if (key === 'generate') continue;
        expect(regenerateDrawControl(at(status), only(key)).show, `${status}/${key}`).toBe(false);
      }
    }
  });

  it('shows a locked draw greyed with a reason rather than hiding it', () => {
    // Hiding it would look identical to not holding the capability, and the
    // Unlock Draw button is right next to it.
    for (const status of ['bracket_generated', 'live']) {
      const locked = regenerateDrawControl(at(status, true), EVERYTHING);
      expect(locked.show, status).toBe(true);
      expect(locked.blockedReason, status).toBe('Unlock the draw before redrawing it');
    }
  });

  it('greys a draw with results in it and SAYS HOW MANY', () => {
    // The server refuses this either way (assertDrawIsRebuildable). Saying it
    // before the click is the difference between "the console knows" and "the
    // console guesses" — and on a 128-match live draw the number is the only
    // part of the message anybody can act on.
    const one = regenerateDrawControl(at('live', false, 1), EVERYTHING);
    expect(one.show).toBe(true);
    expect(one.blockedReason).toBe('1 match has been played — void it first');

    const many = regenerateDrawControl(at('bracket_generated', false, 7), EVERYTHING);
    expect(many.blockedReason).toBe('7 matches have been played — void them first');
  });

  it('greys a draw with a match ON COURT, which it used to offer', () => {
    // 'live' is not in RESULT_MATCH_STATUSES — correctly, a live match has no
    // result — so isPlayedMatch read it as zero and this button stayed
    // pressable while three rallies were in progress. That needed no race at
    // all. The remedy named is the cheap one: un-starting a match is one click
    // on the Court Management tab and touches no rating.
    const one = regenerateDrawControl(
      { status: 'live', drawLocked: false, playedMatches: 0, liveMatches: 1 }, EVERYTHING);
    expect(one.show).toBe(true);
    expect(one.blockedReason).toBe('1 match is on court — undo the start or wait for the result');

    const many = regenerateDrawControl(
      { status: 'live', drawLocked: false, playedMatches: 0, liveMatches: 3 }, EVERYTHING);
    expect(many.blockedReason).toBe('3 matches are on court — undo the start or wait for the result');
  });

  it('greys a draw holding an unreversed rating, and says how to clear it', () => {
    // A row that reads `voided` and still carries elo_snapshot. "Void it first"
    // would be a dead end — it is already voided — so this one gets its own
    // sentence rather than being folded into the played count.
    const c = regenerateDrawControl(
      { status: 'live', drawLocked: false, playedMatches: 0, ratedMatches: 1 }, EVERYTHING);
    expect(c.show).toBe(true);
    expect(c.blockedReason).toBe('1 match carries an unreversed rating — unvoid then undo it first');
  });

  it('names the blockers in the order the server refuses them', () => {
    // The greyed reason and the refusal an exec would get by clicking anyway
    // must name the SAME blocker, or the console sends them to fix the wrong
    // thing. delete_phase_matches (00144) raises played, then rated, then live.
    const all = regenerateDrawControl(
      { status: 'live', drawLocked: false, playedMatches: 2, ratedMatches: 1, liveMatches: 3 },
      EVERYTHING);
    expect(all.blockedReason).toBe('2 matches have been played — void them first');

    const ratedAndLive = regenerateDrawControl(
      { status: 'live', drawLocked: false, playedMatches: 0, ratedMatches: 1, liveMatches: 3 },
      EVERYTHING);
    expect(ratedAndLive.blockedReason).toBe('1 match carries an unreversed rating — unvoid then undo it first');
  });

  it('names the LOCK before the results when both are true', () => {
    // Both refuse, but only one of them has its remedy in the same button row.
    const both = regenerateDrawControl(at('live', true, 3), EVERYTHING);
    expect(both.blockedReason).toBe('Unlock the draw before redrawing it');
  });

  it('counts nothing when the caller has not supplied a figure', () => {
    // `playedMatches` is optional so a caller that has not got the count falls
    // back to the old behaviour — offer it, let the server refuse — rather than
    // greying the button on a silent `undefined`.
    const c = regenerateDrawControl({ status: 'live', drawLocked: false }, EVERYTHING);
    expect(c.show).toBe(true);
    expect(c.blockedReason).toBeNull();
  });

  it('never offers a reason for a button it is not drawing', () => {
    // A blockedReason on a hidden control would be rendered by a caller that
    // read the fields in the wrong order.
    for (const status of ['registration', 'checkin', 'completed']) {
      for (const drawLocked of [true, false]) {
        for (const played of [0, 4]) {
          const c = regenerateDrawControl(at(status, drawLocked, played), EVERYTHING);
          expect(c.blockedReason, status).toBeNull();
        }
      }
    }
    expect(regenerateDrawControl(at('bracket_generated', true), NOBODY).blockedReason).toBeNull();
    expect(regenerateDrawControl(at('live', false, 2), NOBODY).blockedReason).toBeNull();
  });
});
