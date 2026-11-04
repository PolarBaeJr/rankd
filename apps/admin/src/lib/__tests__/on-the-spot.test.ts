import { describe, expect, it } from 'vitest';
import { onTheSpotChecksIn, onTheSpotFeePath, onTheSpotMessage, singlesNeedingPartner } from '../on-the-spot';

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
    expect(onTheSpotMessage({ name: 'Ann', checkedIn: true, waiverUnsigned: false, needsPartner: false })).toBe('Ann added and checked in.');
    expect(onTheSpotMessage({ name: 'Bo', checkedIn: false, waiverUnsigned: true, needsPartner: true })).toBe(
      'Bo added. Waiver not signed: they can sign it on their phone, then check them in. They need a partner before a group can take them.',
    );
  });
});
