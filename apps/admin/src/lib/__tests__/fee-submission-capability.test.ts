import { describe, expect, it } from 'vitest';
import { readReceiptAmountCents, submissionCapability } from '../fee-submissions';

// Who may settle an e-transfer receipt is decided from the fee it points at
// (00248), never from anything the browser sends. Dues and club events are
// club fees; a tournament entry is entry money; nothing else is settled by a
// receipt at all.
describe('submissionCapability', () => {
  it('maps dues and club events to the club-fee payment capability', () => {
    expect(submissionCapability('dues')).toBe('fees.clubfees.markpaid.write');
    expect(submissionCapability('event')).toBe('fees.clubfees.markpaid.write');
  });

  it('maps a tournament entry to the entry-money capability', () => {
    expect(submissionCapability('tournament')).toBe('tournaments.fees.markpaid.write');
  });

  it('refuses a reinstatement and anything unknown', () => {
    expect(submissionCapability('reinstatement')).toBeNull();
    expect(submissionCapability('something_new')).toBeNull();
    expect(submissionCapability(null)).toBeNull();
    expect(submissionCapability(undefined)).toBeNull();
  });
});

// The Review dialog prefills what was paid with what the receipt shows (00300),
// read off the reader's amount_mismatch detail, since no column stores it.
describe('readReceiptAmountCents', () => {
  it("reads the receipt's amount off an amount_mismatch detail", () => {
    expect(readReceiptAmountCents('amount_mismatch', 'Receipt shows $10.00, the fee is $5.00')).toBe(1000);
    expect(readReceiptAmountCents('amount_mismatch', 'Receipt shows $1234.05, the fee is $25.00')).toBe(123405);
  });

  it('reads nothing for another flag, no detail, or other wording', () => {
    expect(readReceiptAmountCents('payee_mismatch', 'Receipt shows $10.00, the fee is $5.00')).toBeNull();
    expect(readReceiptAmountCents('amount_mismatch', null)).toBeNull();
    expect(readReceiptAmountCents('amount_mismatch', 'The amount on the receipt is not the fee.')).toBeNull();
    expect(readReceiptAmountCents(null, null)).toBeNull();
  });
});
