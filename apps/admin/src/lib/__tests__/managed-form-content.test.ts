// What a made Form says, and the mapping that reads it (00296). The script
// finds its sections and questions by title, so the titles it pins must be
// the ones the mapping names; a choice keeps the label responses already
// carry; and the fingerprint moves only when something written changes.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contentFingerprint,
  formContent,
  isPaid,
  managedMapping,
  TEMPLATE_TITLES,
  tournamentChoices,
  type ChoiceEvent,
} from '../managed-form-content';
import { formMappingSchema, mappedQuestionTitles } from '../registration-form-mapping';

const SCRIPT = readFileSync(
  join(__dirname, '..', '..', '..', '..', '..', 'integrations', 'google-forms', 'form-maker.gs'),
  'utf8',
);

const EVENT = '00000000-0000-4000-8000-000000000001';
const TOURNAMENT = '00000000-0000-4000-8000-000000000002';
const E1 = '00000000-0000-4000-8000-0000000000e1';
const E2 = '00000000-0000-4000-8000-0000000000e2';
const E3 = '00000000-0000-4000-8000-0000000000e3';
const E9 = '00000000-0000-4000-8000-0000000000e9';

function event(id: string, type: string, at: string, external = false): ChoiceEvent {
  return { id, event_type: type, external_event: external, created_at: at };
}

describe('the script pins the same titles', () => {
  it.each([
    ['PAYMENT_SECTION', TEMPLATE_TITLES.common.paymentSection],
    ['RECEIPT_QUESTION', TEMPLATE_TITLES.common.receipt],
    ['EVENTS_QUESTION', TEMPLATE_TITLES.tournament.events],
    ['PARTNER_SECTION', TEMPLATE_TITLES.tournament.partnerSection],
  ])('%s', (name, title) => {
    expect(SCRIPT).toContain(`var ${name} = '${title}';`);
  });

  it('builds partner questions the way the mapping names them', () => {
    const choices = tournamentChoices([event(E1, 'mens_doubles', '2026-01-01T00:00:00Z')], null);
    const mapping = managedMapping('tournament', TOURNAMENT, choices, false, '1');
    const partner = mapping.PARTNERS[choices[0]!.label]!;
    expect(SCRIPT).toContain(`var PARTNER_NAME_SUFFIX = '${partner.NAME_QUESTION.slice(choices[0]!.label.length)}';`);
    expect(SCRIPT).toContain(`var PARTNER_EMAIL_SUFFIX = '${partner.EMAIL_QUESTION.slice(choices[0]!.label.length)}';`);
  });

  it('names no address, id or account', () => {
    for (const text of [SCRIPT, readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'integrations', 'google-forms', 'FORM-MAKER.md'), 'utf8')]) {
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/@[a-z0-9-]+\./i);
      expect(text).not.toMatch(/\bsfu\b|polardev|aquarium/i);
      expect(text).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
    }
  });
});

describe('tournamentChoices', () => {
  it('orders by creation and numbers a label taken twice', () => {
    const choices = tournamentChoices(
      [
        event(E2, 'mens_singles', '2026-01-02T00:00:00Z'),
        event(E1, 'mens_singles', '2026-01-01T00:00:00Z'),
        event(E3, 'mens_singles', '2026-01-03T00:00:00Z', true),
      ],
      null,
    );
    expect(choices.map((c) => c.eventId)).toEqual([E1, E2, E3]);
    expect(new Set(choices.map((c) => c.label)).size).toBe(3);
    expect(choices[1]!.label).toBe(`${choices[0]!.label} 2`);
    expect(choices[2]!.label).toBe(`${choices[0]!.label} (external)`);
  });

  it('keeps the label a choice had, and drops a deleted event', () => {
    const previous = formMappingSchema.parse({
      EMAIL_QUESTION: 'Email address',
      NAME_QUESTION: 'Full name',
      EVENT_QUESTION: 'Which events are you entering?',
      EVENTS: { 'Open singles': E1, Gone: E9 },
      DEFAULT_EVENT_ID: '',
      PARTNERS: {},
    });
    const choices = tournamentChoices(
      [event(E1, 'mens_singles', '2026-01-01T00:00:00Z'), event(E2, 'mixed_doubles', '2026-01-02T00:00:00Z')],
      previous,
    );
    expect(choices.map((c) => [c.label, c.eventId])).toEqual([
      ['Open singles', E1],
      [expect.any(String), E2],
    ]);
    expect(choices[1]!.doubles).toBe(true);
  });
});

describe('managedMapping', () => {
  it('maps a club event to itself, with the receipt only when paid', () => {
    const paid = managedMapping('club_event', EVENT, null, true, '2026-09');
    expect(paid).toMatchObject({
      DEFAULT_EVENT_ID: EVENT,
      EVENT_QUESTION: '',
      EVENTS: {},
      RECEIPT_QUESTION: TEMPLATE_TITLES.common.receipt,
      WAIVER_QUESTION: TEMPLATE_TITLES.common.waiver,
      WAIVER_VERSION: '2026-09',
      SIGNATURE_QUESTION: TEMPLATE_TITLES.common.signature,
      MEDIA_QUESTION: TEMPLATE_TITLES.common.media,
      MEDIA_ALLOW_ANSWER: TEMPLATE_TITLES.common.mediaAllow,
    });
    expect(managedMapping('club_event', EVENT, null, false, '1').RECEIPT_QUESTION).toBe('');
  });

  it('names a partner pair for each doubles choice of a tournament', () => {
    const choices = tournamentChoices(
      [event(E1, 'mens_singles', '2026-01-01T00:00:00Z'), event(E2, 'mixed_doubles', '2026-01-02T00:00:00Z')],
      null,
    );
    const mapping = managedMapping('tournament', TOURNAMENT, choices, false, '1');
    expect(Object.values(mapping.EVENTS)).toEqual([E1, E2]);
    expect(Object.keys(mapping.PARTNERS)).toEqual([choices[1]!.label]);
    expect(mappedQuestionTitles(mapping)).toContain(TEMPLATE_TITLES.tournament.events);
    expect(mappedQuestionTitles(mapping)).toContain(mapping.PARTNERS[choices[1]!.label]!.EMAIL_QUESTION);
  });
});

describe('formContent', () => {
  const clubRow = {
    id: EVENT,
    title: 'Social night',
    description: 'Bring shoes.',
    location: 'Gym',
    starts_at: '2026-11-03T02:00:00Z',
    cost_cents: 500,
  };

  it('a paid club event says what to send where', () => {
    const content = formContent('club_event', clubRow, { etransferEmail: 'pay@example.org' });
    expect(content.title).toBe('Social night');
    expect(content.description).toContain('Bring shoes.');
    expect(content.description).toContain('When: ');
    expect(content.description).toContain('Where: Gym');
    expect(content.payment?.text).toContain('pay@example.org');
    expect(content.choices).toBeNull();
    expect(content.closedMessage).toBe('Sign-ups for Social night are closed.');
  });

  it('a free event, or no e-transfer email, has no payment text', () => {
    expect(formContent('club_event', { ...clubRow, cost_cents: 0 }, { etransferEmail: 'a@example.org' }).payment).toBeNull();
    expect(formContent('club_event', clubRow, { etransferEmail: null }).payment).toBeNull();
  });

  it('a tournament lists every fee tier', () => {
    const tiers = [
      { name: 'Member', amount_cents: 1000 },
      { name: 'Guest', amount_cents: 1500 },
    ];
    expect(isPaid('tournament', { name: 'Open', start_date: null, end_date: null }, tiers)).toBe(true);
    const content = formContent(
      'tournament',
      { name: 'Open', start_date: '2026-11-07', end_date: '2026-11-08' },
      { etransferEmail: 'pay@example.org', tiers, choices: [] },
    );
    expect(content.payment?.text.split('\n').slice(1)).toEqual(['Member: $10.00', 'Guest: $15.00']);
    expect(content.description).toMatch(/^When: .+ to .+$/);
  });

  it('the fingerprint ignores the closed message and follows what is written', () => {
    const a = formContent('club_event', clubRow, { etransferEmail: 'pay@example.org' });
    expect(contentFingerprint({ ...a, closedMessage: 'other' })).toBe(contentFingerprint(a));
    expect(contentFingerprint({ ...a, title: 'Other' })).not.toBe(contentFingerprint(a));
  });
});
