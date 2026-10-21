import { describe, it, expect } from 'vitest';
import {
  MAX_PASTE_ENTRIES,
  findNamedMatches,
  maskEmail,
  matchPastedPayers,
  normalisePersonName,
  parsePastedPayers,
  toFeePastePreview,
  type PasteDuesRow,
  type PasteRosterPlayer,
  type PastedEntry,
  type PastedPayer,
} from '../fee-paste';

// The pure half of "Paste a list" on /fees. What these pin is the rule the
// feature rests on: only an email or an exact full name marks anybody, and
// everything looser is a hint that is never acted on.

const payers = (entries: PastedEntry[]) => entries.filter((e): e is PastedPayer => e.kind === 'payer');
const one = (text: string) => {
  const out = parsePastedPayers(text);
  expect(out).toHaveLength(1);
  return out[0]!;
};

describe('parsePastedPayers', () => {
  it('reads a list split on newlines and semicolons', () => {
    const out = payers(parsePastedPayers('jane@example.org\nsam@example.org; kim@example.org'));
    expect(out.map((p) => p.email)).toEqual(['jane@example.org', 'sam@example.org', 'kim@example.org']);
  });

  it('splits a line with several emails on its commas', () => {
    const out = payers(parsePastedPayers('jane@example.org, Sam Lee <sam@example.org>, kim@example.org'));
    expect(out.map((p) => p.email)).toEqual(['jane@example.org', 'sam@example.org', 'kim@example.org']);
    expect(out[1]!.name).toBe('Sam Lee');
  });

  it('reads Name <email>', () => {
    expect(one('Jane Doe <jane@example.org>')).toMatchObject({ kind: 'payer', name: 'Jane Doe', email: 'jane@example.org' });
    expect(one('Jane Doe<jane@example.org>')).toMatchObject({ name: 'Jane Doe', email: 'jane@example.org' });
  });

  it('reads Name, email and email, Name', () => {
    expect(one('Jane Doe, jane@example.org')).toMatchObject({ name: 'Jane Doe', email: 'jane@example.org' });
    expect(one('jane@example.org, Jane Doe')).toMatchObject({ name: 'Jane Doe', email: 'jane@example.org' });
  });

  it('reads a spreadsheet row, cells split by tabs, with an amount', () => {
    expect(one('Jane Doe\tjane@example.org\t$25.00')).toMatchObject({
      name: 'Jane Doe',
      email: 'jane@example.org',
      amountCents: 2500,
    });
    expect(one('Jane\tDoe\tjane@example.org\t25')).toMatchObject({ name: 'Jane Doe', amountCents: 2500 });
  });

  it('does not read a student number as money', () => {
    const p = one('Jane Doe\t301234567\tjane@example.org');
    expect(p).toMatchObject({ name: 'Jane Doe', email: 'jane@example.org', amountCents: null });
  });

  it('reads an amount off a name-only line without taking it for a surname', () => {
    expect(one('Jane Doe, 25')).toMatchObject({ name: 'Jane Doe', email: null, amountCents: 2500 });
    expect(one('Jane Doe $12.50')).toMatchObject({ name: 'Jane Doe', amountCents: 1250 });
  });

  it('lowercases an email and strips the punctuation around it', () => {
    expect(one('Jane.Doe@EXAMPLE.org.')).toMatchObject({ email: 'jane.doe@example.org' });
    expect(one('(jane@example.org),')).toMatchObject({ email: 'jane@example.org' });
  });

  it('drops blank lines and header lines', () => {
    const out = parsePastedPayers('name,email\n\n   \nName\tEmail\tAmount\nEmail\njane@example.org');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ email: 'jane@example.org' });
  });

  it('collapses duplicates, by email and by name', () => {
    const out = parsePastedPayers('jane@example.org\nJANE@example.org\nSam Lee\n  sam   lee ');
    expect(out).toHaveLength(2);
  });

  it('reports a malformed email as invalid rather than reading it as a name', () => {
    const p = one('Jane Doe <jane@example>');
    expect(p.kind).toBe('invalid');
    if (p.kind === 'invalid') expect(p.reason).toMatch(/not a valid email/);
  });

  it('reports a line with nothing it can read as invalid', () => {
    expect(one('12345').kind).toBe('invalid');
  });

  it('reads "Doe, Jane" as one person, Jane Doe', () => {
    expect(one('Doe, Jane')).toMatchObject({ name: 'Jane Doe', email: null });
    expect(one('Doe, Jane, $25')).toMatchObject({ name: 'Jane Doe', amountCents: 2500 });
  });

  it('reads two full names either side of one comma as two people', () => {
    expect(payers(parsePastedPayers('Jane Doe, Sam Lee')).map((p) => p.name)).toEqual(['Jane Doe', 'Sam Lee']);
  });

  it('splits a name-only line with two or more commas into separate names', () => {
    expect(payers(parsePastedPayers('Jane, Sam, Kim')).map((p) => p.name)).toEqual(['Jane', 'Sam', 'Kim']);
  });

  it(`reads at most ${MAX_PASTE_ENTRIES} people and reports the rest as invalid`, () => {
    const text = Array.from({ length: MAX_PASTE_ENTRIES + 3 }, (_, i) => `p${i}@example.org`).join('\n');
    const out = parsePastedPayers(text);
    expect(payers(out)).toHaveLength(MAX_PASTE_ENTRIES);
    const over = out.filter((e) => e.kind === 'invalid');
    expect(over).toHaveLength(3);
    expect(over[0]).toMatchObject({ raw: `p${MAX_PASTE_ENTRIES}@example.org` });
  });

  it('counts the cap after duplicates collapse', () => {
    const text = [
      ...Array.from({ length: MAX_PASTE_ENTRIES }, (_, i) => `p${i}@example.org`),
      'p0@example.org',
    ].join('\n');
    expect(parsePastedPayers(text).every((e) => e.kind === 'payer')).toBe(true);
  });
});

describe('normalisePersonName', () => {
  it('ignores case, spacing and surrounding punctuation', () => {
    expect(normalisePersonName('  JANE    Doe. ')).toBe('jane doe');
    expect(normalisePersonName('"Jane Doe"')).toBe('jane doe');
  });

  it('keeps punctuation inside a name', () => {
    expect(normalisePersonName("O'Brien-Smith")).toBe("o'brien-smith");
  });

  it('strips diacritics, so Zoë matches Zoe', () => {
    expect(normalisePersonName('Zoë Tremblay')).toBe(normalisePersonName('Zoe Tremblay'));
    expect(normalisePersonName('ＪＡＮＥ')).toBe('jane');
  });
});

// ─── MATCHING ─────────────────────────────────────────────────────────────────

function member(id: string, fullName: string, over: Partial<PasteRosterPlayer> = {}): PasteRosterPlayer {
  const [first, ...rest] = fullName.split(' ');
  return {
    id,
    full_name: fullName,
    first_name: first ?? null,
    last_name: rest.join(' ') || null,
    display_name: null,
    email: `${id}@example.org`,
    status: 'competitive',
    is_exec: false,
    fee_exempt: false,
    deletion_requested_at: null,
    ...over,
  };
}

const ROSTER = [
  member('jane', 'Jane Doe'),
  member('sam', 'Sam Lee'),
  member('zoe', 'Zoë Tremblay'),
];

const match = (text: string, players = ROSTER, dues: PasteDuesRow[] = []) =>
  matchPastedPayers(parsePastedPayers(text), players, dues);

let dueSeq = 0;
const due = (over: Partial<PasteDuesRow>): PasteDuesRow => ({
  id: `fee-${++dueSeq}`,
  player_id: null,
  manual_name: null,
  manual_email: null,
  paid_at: null,
  method: null,
  amount_cents: null,
  ...over,
});

describe('matchPastedPayers', () => {
  it('matches an email case-insensitively', () => {
    const m = match('JANE@EXAMPLE.ORG');
    expect(m.willMark.map((w) => w.player.id)).toEqual(['jane']);
  });

  it('matches an exact full name, accents and case aside', () => {
    const m = match('zoe tremblay\nJANE DOE');
    expect(m.willMark.map((w) => w.player.id)).toEqual(['zoe', 'jane']);
  });

  it('lets the email win over a name that identifies nobody', () => {
    const m = match('Janie D <jane@example.org>');
    expect(m.willMark.map((w) => w.player.id)).toEqual(['jane']);
  });

  it('calls a line ambiguous when its name and email are two different members', () => {
    const m = match('Sam Lee <jane@example.org>');
    expect(m.willMark).toHaveLength(0);
    expect(m.ambiguous).toHaveLength(1);
    expect(m.ambiguous[0]!.candidates.map((c) => c.id).sort()).toEqual(['jane', 'sam']);
  });

  it('never marks a name two members share', () => {
    const roster = [...ROSTER, member('jane2', 'Jane Doe')];
    const m = match('Jane Doe', roster);
    expect(m.willMark).toHaveLength(0);
    expect(m.ambiguous[0]!.candidates).toHaveLength(2);
    expect(m.ambiguous[0]!.reason).toMatch(/2 members/);
  });

  it('still marks the member a shared name belongs to when the email says which', () => {
    const roster = [...ROSTER, member('jane2', 'Jane Doe')];
    const m = match('Jane Doe <jane2@example.org>', roster);
    expect(m.willMark.map((w) => w.player.id)).toEqual(['jane2']);
  });

  it.each([
    ['exec', { is_exec: true }, /exec/i],
    ['fee exempt', { fee_exempt: true }, /exempt/i],
    ['pending approval', { status: 'pending_approval' }, /pending/i],
    ['suspended', { status: 'suspended' }, /suspended/i],
    ['another status', { status: 'inactive' }, /not an active member/i],
    ['deletion requested', { deletion_requested_at: '2026-09-01T00:00:00Z' }, /deleted/i],
  ] as const)('finds but does not mark a member who is %s', (_label, over, reason) => {
    const roster = [member('x', 'Alex Kim', over)];
    const m = match('x@example.org', roster);
    expect(m.willMark).toHaveLength(0);
    expect(m.notBillable).toHaveLength(1);
    expect(m.notBillable[0]!.reason).toMatch(reason);
  });

  it('never matches a tombstoned account, by email or by name', () => {
    const roster = [member('gone', 'Pat Gone', { email: 'abc123@deleted.invalid' })];
    const m = match('abc123@deleted.invalid\nPat Gone', roster);
    expect(m.willMark).toHaveLength(0);
    expect(m.notBillable).toHaveLength(0);
    expect(m.notFound).toHaveLength(2);
    expect(m.notFound.every((n) => n.possibleMembers.length === 0)).toBe(true);
  });

  it('puts a paid member under already paid and a waived one under waived', () => {
    const dues = [
      due({ player_id: 'jane', paid_at: '2026-09-02T00:00:00Z', method: 'cash', amount_cents: 2500 }),
      due({ player_id: 'sam', paid_at: '2026-09-02T00:00:00Z', method: 'waived', amount_cents: 0 }),
      due({ player_id: 'zoe', paid_at: null }),
    ];
    const m = match('jane@example.org\nsam@example.org\nzoe@example.org', ROSTER, dues);
    expect(m.alreadyPaid.map((r) => r.player.id)).toEqual(['jane']);
    expect(m.waived.map((r) => r.player.id)).toEqual(['sam']);
    expect(m.willMark.map((r) => r.player.id)).toEqual(['zoe']);
  });

  it('recognises a named payment already recorded this season, by email or by name', () => {
    const dues = [
      due({ manual_name: 'Robin Park', manual_email: 'robin@example.net', paid_at: '2026-09-02T00:00:00Z', amount_cents: 2500 }),
      due({ manual_name: 'Chris Wu', paid_at: '2026-09-02T00:00:00Z', amount_cents: 2500 }),
    ];
    const m = match('ROBIN@example.net\nchris wu', ROSTER, dues);
    expect(m.alreadyNamed.map((r) => r.manualName)).toEqual(['Robin Park', 'Chris Wu']);
    expect(m.notFound).toHaveLength(0);
  });

  it('says a named row a Google Form filed is not paid yet (00290)', () => {
    const dues = [due({ manual_name: 'Robin Park', manual_email: 'robin@example.net', paid_at: null, amount_cents: 2000 })];
    const m = match('robin@example.net', ROSTER, dues);
    expect(m.alreadyNamed).toEqual([expect.objectContaining({ manualName: 'Robin Park', paid: false })]);
    expect(m.willMark).toHaveLength(0);
    const preview = toFeePastePreview({ id: 's', name: 'Fall 2026', competitiveFeeCents: 5000, recreationalFeeCents: 2000 }, m);
    expect(preview.alreadyNamed).toEqual([expect.objectContaining({ name: 'Robin Park', unpaid: true })]);
    expect(preview.alreadyNamed[0]!.reason).toContain('not paid yet');
  });

  it('offers weak hints for a name it cannot find, and never marks them', () => {
    const roster = [
      member('j', 'Jennifer Doe'),
      member('d', 'Dee Nguyen', { display_name: 'Jenny D' }),
    ];
    const m = match('J. Doe\nJenny D', roster);
    expect(m.willMark).toHaveLength(0);
    expect(m.notFound).toHaveLength(2);
    expect(m.notFound[0]!.possibleMembers.map((p) => p.id)).toEqual(['j']);
    expect(m.notFound[1]!.possibleMembers.map((p) => p.id)).toEqual(['d']);
  });

  it('hints by first and last name when the full name reads differently', () => {
    const roster = [member('m', 'Maria Garcia Lopez', { first_name: 'Maria', last_name: 'Garcia' })];
    const m = match('Maria Garcia', roster);
    expect(m.willMark).toHaveLength(0);
    expect(m.notFound[0]!.possibleMembers.map((p) => p.id)).toEqual(['m']);
  });

  it('lists a member reached twice only once', () => {
    const m = match('jane@example.org\nJane Doe');
    expect(m.willMark).toHaveLength(1);
    expect(m.ambiguous).toHaveLength(0);
  });

  it('passes invalid lines through', () => {
    const m = match('jane@nowhere');
    expect(m.invalid).toHaveLength(1);
  });
});

describe('findNamedMatches', () => {
  const named = (name: string, over: Partial<PasteDuesRow> = {}) =>
    due({ manual_name: name, paid_at: '2026-09-02T00:00:00Z', method: 'cash', amount_cents: 2500, ...over });

  it('finds a named payment whose email is a member, whatever the name says', () => {
    const row = named('JD', { manual_email: 'JANE@example.org' });
    const found = findNamedMatches(ROSTER, [row]);
    expect(found).toHaveLength(1);
    expect(found[0]!.row.id).toBe(row.id);
    expect(found[0]!.candidates.map((c) => [c.player.id, c.match, c.memberDues])).toEqual([['jane', 'email', 'none']]);
  });

  it('finds a named payment by the exact full name, accents and case aside', () => {
    const found = findNamedMatches(ROSTER, [named('zoe TREMBLAY')]);
    expect(found[0]!.candidates.map((c) => [c.player.id, c.match])).toEqual([['zoe', 'name']]);
  });

  it('says whether the member already has a dues row, and in what state', () => {
    const dues = [
      named('Jane Doe'),
      named('Sam Lee'),
      named('Zoe Tremblay'),
      due({ player_id: 'sam', paid_at: null }),
      due({ player_id: 'zoe', paid_at: '2026-09-02T00:00:00Z', method: 'waived', amount_cents: 0 }),
    ];
    const found = findNamedMatches(ROSTER, dues);
    expect(found.map((f) => [f.candidates[0]!.player.id, f.candidates[0]!.memberDues])).toEqual([
      ['jane', 'none'],
      ['sam', 'unpaid'],
      ['zoe', 'waived'],
    ]);
    const paid = findNamedMatches(ROSTER, [named('Jane Doe'), due({ player_id: 'jane', paid_at: '2026-09-02T00:00:00Z', method: 'cash', amount_cents: 3000 })]);
    expect(paid[0]!.candidates[0]!.memberDues).toBe('paid');
  });

  it('offers a looser resemblance as a similar hint, after the strong matches', () => {
    const roster = [member('j', 'Jennifer Doe'), member('d', 'Dee Nguyen', { display_name: 'Jenny D' })];
    const found = findNamedMatches(roster, [named('J. Doe'), named('Jenny D')]);
    expect(found.map((f) => f.candidates.map((c) => [c.player.id, c.match]))).toEqual([
      [['j', 'similar']],
      [['d', 'similar']],
    ]);
  });

  it('never offers a tombstoned account', () => {
    const roster = [member('gone', 'Pat Gone', { email: 'abc@deleted.invalid' })];
    expect(findNamedMatches(roster, [named('Pat Gone', { manual_email: 'abc@deleted.invalid' })])).toEqual([]);
  });

  it('skips a payment that already belongs to a member, and one that looks like nobody', () => {
    const dues = [
      due({ player_id: 'jane', paid_at: '2026-09-02T00:00:00Z', method: 'cash', amount_cents: 3000 }),
      named('Robin Park'),
    ];
    expect(findNamedMatches(ROSTER, dues)).toEqual([]);
  });

  it('reaches the browser as ids, names and masked addresses', () => {
    const row = named('Jane Doe', { manual_email: 'jane@example.org' });
    const preview = toFeePastePreview(
      { id: 's', name: 'Fall 2026', competitiveFeeCents: 3000, recreationalFeeCents: 2000 },
      matchPastedPayers([], ROSTER, [row]),
    );
    expect(preview.namedMatches).toEqual([
      {
        feeId: row.id,
        manualName: 'Jane Doe',
        amountCents: 2500,
        paidAt: '2026-09-02T00:00:00Z',
        candidates: [{ playerId: 'jane', name: 'Jane Doe', maskedEmail: 'j***@example.org', match: 'email', memberDues: 'none' }],
      },
    ]);
  });
});

describe('toFeePastePreview', () => {
  const season = { id: 's', name: 'Fall 2026', competitiveFeeCents: 3000, recreationalFeeCents: 2000 };

  it('hands the browser ids and names, and masks the addresses of ambiguous candidates', () => {
    const roster = [...ROSTER, member('jane2', 'Jane Doe')];
    const preview = toFeePastePreview(season, match('sam@example.org\nJane Doe', roster));
    expect(preview.willMark).toEqual([{ raw: 'sam@example.org', playerId: 'sam', fullName: 'Sam Lee', email: 'sam@example.org' }]);
    expect(preview.ambiguous[0]!.candidates).toEqual([
      { playerId: 'jane', name: 'Jane Doe', maskedEmail: 'j***@example.org', state: 'will_mark', reason: null },
      { playerId: 'jane2', name: 'Jane Doe', maskedEmail: 'j***@example.org', state: 'will_mark', reason: null },
    ]);
    expect(JSON.stringify(preview.ambiguous)).not.toContain('jane2@');
  });

  it('says where each candidate of an ambiguous line stands this season', () => {
    const roster = [
      member('a', 'Jane Doe'),
      member('b', 'Jane Doe'),
      member('c', 'Jane Doe'),
      member('d', 'Jane Doe', { is_exec: true }),
    ];
    const dues = [
      due({ player_id: 'b', paid_at: '2026-09-02T00:00:00Z', method: 'cash', amount_cents: 3000 }),
      due({ player_id: 'c', paid_at: '2026-09-02T00:00:00Z', method: 'waived', amount_cents: 0 }),
    ];
    const preview = toFeePastePreview(season, match('Jane Doe', roster, dues));
    expect(preview.ambiguous[0]!.candidates.map((c) => [c.playerId, c.state, c.reason])).toEqual([
      ['a', 'will_mark', null],
      ['b', 'already_paid', null],
      ['c', 'waived', null],
      ['d', 'not_billable', 'Exec, not billed a season fee'],
    ]);
  });

  it('offers the hinted members of a not-found line as candidates, with their state', () => {
    const roster = [member('j', 'Jennifer Doe'), member('k', 'Jo Doe')];
    const dues = [due({ player_id: 'k', paid_at: '2026-09-02T00:00:00Z', method: 'cash', amount_cents: 3000 })];
    const preview = toFeePastePreview(season, match('J. Doe', roster, dues));
    expect(preview.willMark).toHaveLength(0);
    expect(preview.notFound[0]!.possibleMembers).toEqual([
      { playerId: 'j', name: 'Jennifer Doe', maskedEmail: 'j***@example.org', state: 'will_mark', reason: null },
      { playerId: 'k', name: 'Jo Doe', maskedEmail: 'k***@example.org', state: 'already_paid', reason: null },
    ]);
  });

  it('masks an email down to its first character and domain', () => {
    expect(maskEmail('someone@example.net')).toBe('s***@example.net');
    expect(maskEmail(null)).toBeNull();
  });
});
