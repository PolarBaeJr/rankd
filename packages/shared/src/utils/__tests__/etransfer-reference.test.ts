import { describe, it, expect } from 'vitest';
import {
  extractEtransferReference,
  extractSfuRecOrder,
  isHiddenEtransferReference,
  isPlausibleReference,
  normaliseReference,
} from '../etransfer-reference';

// EVERY FIXTURE BELOW IS SYNTHETIC. None is text read off a real bank's
// e-Transfer screen: the layout of those screens is unverified, and the
// references here are made up. They pin the behaviour the helper promises,
// not any bank's format.

describe('extractEtransferReference (synthetic fixtures)', () => {
  it('reads a reference on the same line as its label', () => {
    const text = 'Interac e-Transfer sent\nReference number: CA7Hd2k9QmP4\nAmount $25.00';
    expect(extractEtransferReference(text)).toEqual({ value: 'CA7Hd2k9QmP4', confidence: 'anchored' });
  });

  it('reads a reference on the line under its label', () => {
    const text = 'Confirmation #\nC1AbX7Yz3456\nTo: Club Ladder';
    expect(extractEtransferReference(text)).toEqual({ value: 'C1AbX7Yz3456', confidence: 'anchored' });
  });

  it('fixes an O read for a zero inside a mostly numeric token', () => {
    const text = 'Ref #: 12O4567890';
    expect(extractEtransferReference(text)?.value).toBe('1204567890');
  });

  it('prefers the reference to the amount beside it', () => {
    const text = 'Amount: $125.00 CAD\nTransaction ID: 20260924AB77\nStatus: Sent';
    expect(extractEtransferReference(text)).toEqual({ value: '20260924AB77', confidence: 'anchored' });
  });

  it('falls back to a guess when no label is found', () => {
    const text = 'Money sent\nQ9w8E7r6T5y4\nThank you';
    expect(extractEtransferReference(text)).toEqual({ value: 'Q9w8E7r6T5y4', confidence: 'guess' });
  });

  it('does not take an email address for a reference', () => {
    expect(extractEtransferReference('Sent to treasurer2026@example.com')).toBeNull();
    expect(extractEtransferReference('Reference number: treasurer2026@example.com')).toBeNull();
  });

  it('does not take a date for a reference', () => {
    expect(extractEtransferReference('Date: 2026-09-24')).toBeNull();
    expect(extractEtransferReference('Reference number:\n24-09-2026')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(extractEtransferReference('')).toBeNull();
    expect(extractEtransferReference('   \n  ')).toBeNull();
    expect(extractEtransferReference(null)).toBeNull();
  });
});

describe('isPlausibleReference', () => {
  it('accepts what the database CHECK accepts', () => {
    expect(isPlausibleReference('CA7Hd2k9')).toBe(true);
    expect(isPlausibleReference('  CA7-Hd2k9  ')).toBe(true);
    expect(isPlausibleReference('A'.repeat(32))).toBe(true);
  });

  it('refuses the rest', () => {
    expect(isPlausibleReference('12345')).toBe(false);
    expect(isPlausibleReference('A'.repeat(33))).toBe(false);
    expect(isPlausibleReference('CA7 Hd2k9')).toBe(false);
    expect(isPlausibleReference("CA7'; drop")).toBe(false);
  });
});

describe('Campus Rec receipt numbers (synthetic fixtures)', () => {
  it('reads a number beside a receipt label', () => {
    expect(extractEtransferReference('Receipt #: 20260924118\nTotal $40.00')).toEqual({
      value: '20260924118',
      confidence: 'anchored',
    });
  });

  it('reads a number under an order label', () => {
    expect(extractEtransferReference('Order Number\n88412093\nVisa ****1234')).toEqual({
      value: '88412093',
      confidence: 'anchored',
    });
  });

  it('drops one leading hash', () => {
    expect(normaliseReference('#12345678')).toBe('12345678');
    expect(normaliseReference('  # 12345678 ')).toBe('12345678');
    expect(isPlausibleReference(normaliseReference('#12345678'))).toBe(true);
  });

  it('allows 4 characters on anything not stored as an e-transfer (00253)', () => {
    expect(isPlausibleReference('4821', 'sfu_rec')).toBe(true);
    // An undetected dues receipt: the exec settles it, and confirm refuses a
    // short reference as an e-transfer.
    expect(isPlausibleReference('4821', null)).toBe(true);
    expect(isPlausibleReference('4821', 'e_transfer')).toBe(false);
    expect(isPlausibleReference('4821')).toBe(false);
    expect(isPlausibleReference('482', 'sfu_rec')).toBe(false);
  });
});

// The Campus Rec layouts below copy the shape of real receipts with every value
// made up. The phone's member line is "Ana Lee" and an invented ID.
const SFU_REC_DESKTOP = [
  'Order #: O-600857',
  'Invoice #: 1-502003',
  'Registration #: R-497881',
  'Total Before Tax: $25.00',
  'Program Name: Badminton Club',
].join('\n');

const SFU_REC_PHONE = ['Receipt', '', 'O-601558', 'Thank you for', 'your purchase.', 'Ana Lee | ID #: 301234567'].join('\n');

describe('extractSfuRecOrder (00297)', () => {
  it('reads the order on a desktop receipt, never the invoice or registration', () => {
    expect(extractSfuRecOrder(SFU_REC_DESKTOP)).toBe('O-600857');
    expect(extractSfuRecOrder(SFU_REC_DESKTOP.replace('1-502003', 'I-502003'))).toBe('O-600857');
  });

  it('reads the order alone on its line on a phone receipt, never the student ID', () => {
    expect(extractSfuRecOrder(SFU_REC_PHONE)).toBe('O-601558');
  });

  it('reads an OCR zero for the O, and spaces round the hyphen', () => {
    expect(extractSfuRecOrder('Order #: 0-600857')).toBe('O-600857');
    expect(extractSfuRecOrder('Receipt\no - 600857')).toBe('O-600857');
  });

  it('finds nothing without an order', () => {
    expect(extractSfuRecOrder('Invoice #: I-502003\nRegistration #: R-497881')).toBeNull();
    expect(extractSfuRecOrder('')).toBeNull();
    expect(extractSfuRecOrder(null)).toBeNull();
  });
});

describe('an e-transfer number shown with part of it hidden (00297)', () => {
  it('reads an elided number whole, with three dots or the ellipsis character', () => {
    expect(extractEtransferReference('Confirmation number: H99517225...111525803')?.value).toBe(
      'H99517225...111525803',
    );
    expect(normaliseReference(extractEtransferReference('Confirmation number: H99517225\u2026111525803')!.value)).toBe(
      'H99517225...111525803',
    );
  });

  it('reads a masked number whole', () => {
    expect(extractEtransferReference('Confirmation # C1Aarp***bAz')?.value).toBe('C1Aarp***bAz');
  });

  it('accepts a hidden number only as an e-transfer', () => {
    expect(isHiddenEtransferReference('H99517225...111525803')).toBe(true);
    expect(isHiddenEtransferReference('C1Aarp***bAz')).toBe(true);
    expect(isHiddenEtransferReference('CA1Q7r2Kp9Xb')).toBe(false);
    expect(isHiddenEtransferReference('a...b')).toBe(false);
    expect(isPlausibleReference('C1Aarp***bAz', 'e_transfer')).toBe(true);
    expect(isPlausibleReference('C1Aarp***bAz', 'sfu_rec')).toBe(false);
    expect(isPlausibleReference('C1Aarp***bAz')).toBe(false);
  });

  it('turns the ellipsis character into three dots', () => {
    expect(normaliseReference('H99517225\u2026111525803')).toBe('H99517225...111525803');
  });
});
