import { describe, it, expect } from 'vitest';
import { RECEIPT_FLAGS, decideAutoConfirm, namesMatch, parseReceiptText, type AutoConfirmContext } from '../receipt-read';

// EVERY VALUE BELOW IS MADE UP. The layouts copy the shape the server's OCR
// gives for real receipts (labels on the line above their values, blank lines
// between blocks, the phone's "|" before "ID #"); the names, numbers and
// addresses are invented.

const ETRANSFER = [
  'Interac e-Transfer sent',
  '',
  'Amount',
  '',
  '$15.00',
  '',
  'Sent to',
  '',
  'Riverside Smash Club',
  'Reference number',
  'CA1Q7r2Kp9Xb',
].join('\n');

const ALL_SET = [
  'e-Transfer sent',
  'All set!',
  '$5.00 CAD has been sent to Riverside Smash with Interac e-Transfer.',
  'From Chequing',
  'To Riverside Smash',
  'Email club@example.org',
  'Autodeposit enabled',
  'Amount $5.00 CAD',
].join('\n');

const REC_DESKTOP = [
  'Order #: O-600857',
  'Invoice #: 1-502003',
  'Registration #: R-497881',
  '',
  'Total Before Tax: $25.00',
  '',
  'Program Name: Badminton Club',
  'Offering/Instance: Main Campus Fall 2026 - Casual',
].join('\n');

const REC_PHONE = ['O-601558', '', 'Receipt', '', 'Thank you for', 'your purchase.', '', 'Ana Lee | ID #: 301234567'].join(
  '\n',
);

const DUES: AutoConfirmContext = {
  feeType: 'dues',
  amountCents: 2500,
  payerName: 'Ana Lee',
  clubEmail: 'club@example.org',
  clubPayeeName: 'Riverside Smash Club',
};

describe('parseReceiptText', () => {
  it('reads an e-transfer with its labels above the values', () => {
    expect(parseReceiptText(ETRANSFER)).toEqual({
      kind: 'e_transfer',
      reference: 'CA1Q7r2Kp9Xb',
      amountCents: 1500,
      programName: null,
      payerName: null,
      payeeName: 'Riverside Smash Club',
      payeeEmail: null,
    });
  });

  it('reads the "All set!" screen, which has no number', () => {
    const read = parseReceiptText(ALL_SET);
    expect(read.kind).toBe('e_transfer');
    expect(read.reference).toBeNull();
    expect(read.amountCents).toBe(500);
    expect(read.payeeName).toBe('Riverside Smash');
    expect(read.payeeEmail).toBe('club@example.org');
  });

  it('classifies the desktop SFU Rec receipt by its order and program sheet', () => {
    const read = parseReceiptText(REC_DESKTOP);
    expect(read.kind).toBe('sfu_rec');
    expect(read.reference).toBe('O-600857');
    expect(read.amountCents).toBe(2500);
    expect(read.programName).toBe('Badminton Club');
  });

  it('classifies the phone SFU Rec receipt and reads the name beside the ID', () => {
    const read = parseReceiptText(REC_PHONE);
    expect(read.kind).toBe('sfu_rec');
    expect(read.reference).toBe('O-601558');
    expect(read.payerName).toBe('Ana Lee');
    expect(read.amountCents).toBeNull();
  });

  it('reads nothing from text that is not a receipt', () => {
    expect(parseReceiptText('A photo of a cat').kind).toBeNull();
    expect(parseReceiptText('').kind).toBeNull();
    expect(parseReceiptText(null).kind).toBeNull();
  });

  it('keeps an unlabelled guess out of the reference', () => {
    const read = parseReceiptText('Interac e-Transfer sent\nAmount $15.00 CAD\nTo Riverside Smash Club\nZQ7X2K9P');
    expect(read.reference).toBeNull();
  });
});

describe('namesMatch', () => {
  it('matches first and last names, case, accents and one slip aside', () => {
    expect(namesMatch('ANA LEE', 'Ana Lee')).toBe(true);
    expect(namesMatch('Ana Maria Lee', 'Ana Lee')).toBe(true);
    expect(namesMatch('Aná Lee', 'Ana Lee')).toBe(true);
    expect(namesMatch('Ana Lce', 'Ana Lee')).toBe(true);
  });

  it('refuses another name', () => {
    expect(namesMatch('Ben Park', 'Ana Lee')).toBe(false);
    expect(namesMatch('Ana Park', 'Ana Lee')).toBe(false);
    expect(namesMatch('', 'Ana Lee')).toBe(false);
  });
});

describe('decideAutoConfirm', () => {
  const etransfer = { ...DUES, amountCents: 1500 };

  it('confirms a clean e-transfer', () => {
    expect(decideAutoConfirm(parseReceiptText(ETRANSFER), etransfer)).toEqual({
      confirm: true,
      method: 'e_transfer',
      reference: 'CA1Q7r2Kp9Xb',
      amountCents: 1500,
    });
  });

  it('confirms a clean SFU Rec receipt, desktop and phone', () => {
    expect(decideAutoConfirm(parseReceiptText(REC_DESKTOP), DUES)).toMatchObject({ confirm: true, reference: 'O-600857' });
    expect(decideAutoConfirm(parseReceiptText(REC_PHONE), DUES)).toMatchObject({ confirm: true, reference: 'O-601558' });
  });

  it('reads an amount printed with no dollar sign', () => {
    const sent = 'Sent\n5.00\nto treasurer@example.org\ntreasurer@example.org\nAutodeposit';
    expect(parseReceiptText(sent)).toMatchObject({ kind: 'e_transfer', amountCents: 500 });
    expect(
      decideAutoConfirm(parseReceiptText(sent), { ...etransfer, amountCents: 500, clubEmail: 'treasurer@example.org' }),
    ).toMatchObject({ confirm: true, amountCents: 500 });
    expect(parseReceiptText('Interac e-Transfer\nAmount 12.50\nSent to Treasurer')).toMatchObject({ amountCents: 1250 });
  });

  it('reads an amount under an "Amount Date" line, and an l the OCR read as a capital I', () => {
    // RBC's dark "Confirmation" screen, as tesseract reads it.
    const rbc = [
      'Confirmation x',
      'Your Interac e-transfer was sent!',
      'Reference number: H012345672026101012345678 [ )]',
      'New account balance',
      'Chequing - Preferred Package',
      'riverside smash',
      'Ilsa1@example.org',
      'Legal name',
      'Contact method',
      'Email',
      'Amount Date',
      '$5.00 Oct 22, 2026',
      'Make another transfer',
    ].join('\n');
    expect(parseReceiptText(rbc)).toMatchObject({ kind: 'e_transfer', amountCents: 500, payeeEmail: 'llsa1@example.org' });
    const ctx = { ...etransfer, amountCents: 500, clubEmail: 'llsa1@example.org', clubPayeeName: null };
    expect(decideAutoConfirm(parseReceiptText(rbc), ctx)).toMatchObject({ confirm: true, amountCents: 500 });
    // A real lower case i stays an i.
    expect(decideAutoConfirm(parseReceiptText(rbc.replace('Ilsa1', 'ilsa1')), ctx)).toMatchObject({
      confirm: false,
      flag: 'payee_mismatch',
    });
    // The date's figures are never taken for the amount.
    expect(parseReceiptText('Interac e-transfer\nAmount Date\nOct 22, 2026')).toMatchObject({ amountCents: null });
  });

  it('reads a bank\'s deposited notice, and matches one of several payee names', () => {
    const notice =
      'Hi Sam,\n\nYour transfer to ALEX CHEN was\nsuccessfully deposited.\n\nThe $5.00 (CAD) you sent to ALEX CHEN has been successfully\ndeposited.\n';
    expect(parseReceiptText(notice)).toMatchObject({ kind: 'e_transfer', amountCents: 500, payeeName: 'ALEX CHEN' });
    const ctx = { ...etransfer, amountCents: 500, clubEmail: null };
    expect(decideAutoConfirm(parseReceiptText(notice), { ...ctx, clubPayeeName: 'Riverside Smash, Alex Chen' })).toMatchObject({
      confirm: true,
    });
    expect(decideAutoConfirm(parseReceiptText(notice), { ...ctx, clubPayeeName: 'Riverside Smash' })).toMatchObject({
      confirm: false,
      flag: 'payee_mismatch',
    });
  });

  it('matches the payee by the email when the name differs', () => {
    const decision = decideAutoConfirm(parseReceiptText(ALL_SET.replace('Riverside Smash', 'Treasurer')), {
      ...etransfer,
      amountCents: 500,
    });
    // The "All set" screen shows no number: the payee and amount settle it (00298).
    expect(decision).toMatchObject({ confirm: true, method: 'e_transfer', reference: null, amountCents: 500 });
  });

  const holds: [string, string, AutoConfirmContext, string][] = [
    ['fee_not_payable', ETRANSFER, { ...etransfer, amountCents: null }, ''],
    ['not_a_receipt', 'A photo of a cat', etransfer, ''],
    ['wrong_method', REC_DESKTOP, { ...DUES, feeType: 'tournament' }, ''],
    ['no_reference', 'SFU Recreation\nPowered By Fusion\nTotal Before Tax: $25.00', DUES, ''],
    ['not_a_receipt', REC_DESKTOP.replace('Order #: O-600857', 'Order #: O-60'), DUES, ''],
    ['name_mismatch', REC_PHONE, { ...DUES, payerName: 'Ben Park' }, ''],
    ['amount_mismatch', REC_DESKTOP, { ...DUES, amountCents: 2000 }, 'Receipt shows $25.00, the fee is $20.00'],
    ['program_mismatch', REC_DESKTOP.replace('Badminton Club', 'Climbing Club'), DUES, ''],
    ['amount_unreadable', ETRANSFER.replace('$15.00', 'fifteen'), etransfer, ''],
    ['amount_mismatch', ETRANSFER, { ...etransfer, amountCents: 2500 }, 'Receipt shows $15.00, the fee is $25.00'],
    ['payee_mismatch', ETRANSFER.replace('Riverside Smash Club', 'Someone Else'), etransfer, ''],
    ['payee_unreadable', ETRANSFER.replace('Sent to\n\nRiverside Smash Club\n', ''), etransfer, ''],
  ];

  it.each(holds)('holds %s', (flag, text, ctx, detail) => {
    const decision = decideAutoConfirm(parseReceiptText(text), ctx);
    expect(decision.confirm).toBe(false);
    if (decision.confirm) return;
    expect(decision.flag).toBe(flag);
    if (detail) expect(decision.detail).toBe(detail);
  });

  it('holds a payee name that differs from the setting only by more than case and spacing', () => {
    // Equality, not a fuzzy match: "Riverside Smash Club" is not "Riverside Smash".
    expect(decideAutoConfirm(parseReceiptText(ETRANSFER), { ...etransfer, clubPayeeName: 'Riverside Smash', clubEmail: null })).toMatchObject({
      confirm: false,
      flag: 'payee_mismatch',
    });
    expect(
      decideAutoConfirm(parseReceiptText(ETRANSFER), { ...etransfer, clubPayeeName: '  riverside  smash CLUB ', clubEmail: null }),
    ).toMatchObject({ confirm: true });
  });

  it('never quotes a name in a flag detail', () => {
    for (const [, text, ctx] of holds) {
      const decision = decideAutoConfirm(parseReceiptText(text), ctx);
      if (decision.confirm || !decision.detail) continue;
      expect(decision.detail).not.toMatch(/Ana|Lee|Ben|Park/);
    }
  });

  it('only ever answers a flag the database accepts', () => {
    for (const [flag] of holds) expect(RECEIPT_FLAGS).toContain(flag);
  });
});
