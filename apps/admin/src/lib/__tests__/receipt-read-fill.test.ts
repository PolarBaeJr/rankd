import { describe, expect, it } from 'vitest';
import { readFill } from '../../app/fees/expense-details-fields';

// Reading a receipt again (00313): a field the last read filled is corrected,
// and one the exec typed is kept.

describe('readFill', () => {
  it('fills an empty field', () => {
    expect(readFill('', undefined, 'TEST PRINT SHOP')).toBe('TEST PRINT SHOP');
  });

  it('replaces what the last read put there, so a misread is corrected', () => {
    expect(readFill('TES. PRELNT SHOP', 'TES. PRELNT SHOP', 'TEST PRINT SHOP')).toBe('TEST PRINT SHOP');
  });

  it('keeps what the exec typed over the read', () => {
    expect(readFill('Banner for the open', 'TES. PRELNT SHOP', 'TEST PRINT SHOP')).toBe('Banner for the open');
  });

  it('keeps the field when the new read found nothing', () => {
    expect(readFill('74.77', '74.77', '')).toBe('74.77');
  });
});
