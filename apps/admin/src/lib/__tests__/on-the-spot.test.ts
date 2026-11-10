import { describe, expect, it } from 'vitest';
import { onTheSpotCheckInLocked, onTheSpotChecksIn, onTheSpotFeePath, onTheSpotMessage, singlesNeedingPartner, walkInPlayers } from '../on-the-spot';

describe('onTheSpotChecksIn', () => {
  it('checks them in from check-in until the event is completed', () => {
    for (const s of ['checkin', 'bracket_generated', 'live', 'pool_live']) expect(onTheSpotChecksIn(s)).toBe(true);
  });

  it('leaves them registered before check-in opens, and never adds to a finished event', () => {
    expect(onTheSpotChecksIn('registration')).toBe(false);
    expect(onTheSpotChecksIn('completed')).toBe(false);
    expect(onTheSpotChecksIn(null)).toBe(false);
  });
});

describe('onTheSpotCheckInLocked', () => {
  it('with check_in_after_draw off, locks check-in once the event is past the draw', () => {
    for (const s of ['bracket_generated', 'live', 'pool_live']) expect(onTheSpotCheckInLocked(s, false), s).toBe(true);
  });

  it('never locks during check-in, before it, after the event, or with the switch on', () => {
    for (const s of [null, 'registration', 'checkin', 'completed']) expect(onTheSpotCheckInLocked(s, false), String(s)).toBe(false);
    for (const s of [null, 'registration', 'checkin', 'bracket_generated', 'live', 'pool_live', 'completed']) {
      expect(onTheSpotCheckInLocked(s, true), String(s)).toBe(false);
    }
  });
});

describe('onTheSpotFeePath', () => {
  it('on a linked club event, charges or waives the club-event fee, never the tournament fee', () => {
    expect(onTheSpotFeePath(true, true)).toBe('club');
    expect(onTheSpotFeePath(true, false)).toBe('club_waived');
  });

  it('on an unlinked tournament, charges the entry fee or nothing', () => {
    expect(onTheSpotFeePath(false, true)).toBe('tournament');
    expect(onTheSpotFeePath(false, false)).toBe('none');
  });
});

describe('walkInPlayers', () => {
  it('leaves out a partner who was signed up for the club event before the add', () => {
    expect(walkInPlayers(['guest', 'partner'], new Set(['partner']))).toEqual(['guest']);
  });

  it('includes a guest the add just made', () => {
    expect(walkInPlayers(['guest'], new Set())).toEqual(['guest']);
  });

  it('is empty when everybody was already signed up', () => {
    expect(walkInPlayers(['member', 'partner'], new Set(['member', 'partner']))).toEqual([]);
  });
});

describe('singlesNeedingPartner', () => {
  it('lists active players in no active team', () => {
    const participants = [
      { player_id: 'a', status: 'checked_in' }, { player_id: 'b', status: 'registered' },
      { player_id: 'c', status: 'checked_in' }, { player_id: 'd', status: 'withdrawn' },
      { player_id: 'e', status: 'registered' },
    ];
    const pairs = [
      { player1_id: 'b', player2_id: 'x', status: 'checked_in' },
      { player1_id: 'e', player2_id: 'y', status: 'withdrawn' },
    ];
    expect(singlesNeedingPartner(participants, pairs).map((p) => p.player_id)).toEqual(['a', 'c', 'e']);
  });
});

describe('onTheSpotMessage', () => {
  it('says what happened and what is left to do', () => {
    expect(onTheSpotMessage({ name: 'Ann', checkedIn: true, waiverUnsigned: false, checkInLocked: false, needsPartner: false })).toBe('Ann added and checked in.');
    expect(onTheSpotMessage({ name: 'Bo', checkedIn: false, waiverUnsigned: true, checkInLocked: false, needsPartner: true })).toBe(
      'Bo added. Waiver not signed: they can sign it on their phone, then check them in. They need a partner before a group can take them.',
    );
  });

  it('says when check-in is locked after the draw', () => {
    expect(onTheSpotMessage({ name: 'Cy', checkedIn: false, waiverUnsigned: false, checkInLocked: true, needsPartner: false })).toBe(
      'Cy added. Check-in is locked after the draw, so they stay registered.',
    );
  });
});
