import { describe, it, expect } from 'vitest';
import { PAYMENT_METHODS, SFU_REC_METHOD, isCollectedBySfuRec } from '../payment-methods';

describe('isCollectedBySfuRec', () => {
  it('is the value the Campus Rec website option stores', () => {
    expect(PAYMENT_METHODS.find((m) => m.label === 'Campus Rec website')?.value).toBe(SFU_REC_METHOD);
    expect(isCollectedBySfuRec('sfu_rec')).toBe(true);
  });

  // Free text stays club money: only the fixed option moves a payment out of
  // the club's income.
  it.each(['Campus Rec', 'Campus Rec website', 'CAMPUS REC', ' sfu_rec', 'sfu_rec ', 'e_transfer', 'cash', 'waived', '', null, undefined])(
    'does not match %j',
    (method) => {
      expect(isCollectedBySfuRec(method)).toBe(false);
    },
  );
});
