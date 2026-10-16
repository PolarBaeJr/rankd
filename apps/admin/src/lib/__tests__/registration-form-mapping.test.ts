// A Google Form response becomes the same registration whichever road it
// takes (00287). The console's builder is checked against the REAL Apps
// Script (integrations/google-forms/registration-import.gs, run in a VM with
// a fake FormApp) followed by the REAL Data API shape check
// (apps/data-api/src/registrations.ts). The database hashes the payload with
// md5(jsonb::text), and jsonb ignores key order, so equal objects are equal
// hashes. This proves the payload SHAPE matches for the same answers and the
// same response id; it does not prove Google gives a response the same id
// through Apps Script as through the Forms API (unconfirmed).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  answersByTitle,
  buildRegistrationPayload,
  formMappingSchema,
  normalizeRegistration,
  scriptTimestamp,
  type FormMapping,
} from '../registration-form-mapping';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const SCRIPT = readFileSync(join(REPO, 'integrations/google-forms/registration-import.gs'), 'utf8');

const { parseRegistration } = (await import(
  /* @vite-ignore */ join(REPO, 'apps/data-api/src/registrations.ts')
)) as { parseRegistration: (body: unknown) => unknown };

const SINGLES = '00000000-0000-4000-8000-000000000001';
const MIXED = '00000000-0000-4000-8000-0000000000AB';
const CLUB = '00000000-0000-4000-8000-000000000099';

const TOURNAMENT_MAPPING: FormMapping = {
  EMAIL_QUESTION: 'Email address',
  NAME_QUESTION: 'Full name',
  EVENT_QUESTION: 'Which events are you entering?',
  EVENTS: { "Men's singles": SINGLES, 'Mixed doubles': MIXED },
  DEFAULT_EVENT_ID: '',
  PARTNERS: {
    'Mixed doubles': {
      NAME_QUESTION: 'Mixed doubles partner: full name',
      EMAIL_QUESTION: 'Mixed doubles partner: email',
      CATEGORY_QUESTION: 'Team category',
    },
  },
};

const CLUB_MAPPING: FormMapping = {
  EMAIL_QUESTION: 'Email address',
  NAME_QUESTION: 'Full name',
  EVENT_QUESTION: '',
  EVENTS: {},
  DEFAULT_EVENT_ID: CLUB,
  PARTNERS: {},
};

/** A response as the two roads see it: titles with Apps Script values, and API answers by question id. */
interface Fixture {
  name: string;
  mapping: FormMapping;
  /** title to the Apps Script getResponse() value: a string, or a string[] for a checkbox. */
  answers: Record<string, string | string[]>;
  submitted: string;
}

const FIXTURES: Fixture[] = [
  {
    name: 'singles and mixed with a partner, messy spacing and case',
    mapping: TOURNAMENT_MAPPING,
    answers: {
      'Email address': '  Someone.Else@Example.ORG ',
      'Full name': ' Pat   Q  Player ',
      'Which events are you entering?': ["Men's singles", 'Mixed doubles'],
      'Mixed doubles partner: full name': 'Robin  Partner',
      'Mixed doubles partner: email': 'Robin@Example.org',
      'Team category': ' Open ',
    },
    submitted: '2026-10-09T18:00:00.123Z',
  },
  {
    name: 'a choice the mapping does not know is dropped; an unanswered partner is left out',
    mapping: TOURNAMENT_MAPPING,
    answers: {
      'Email address': 'a@example.org',
      'Full name': 'Alex',
      'Which events are you entering?': ['Mixed doubles', 'Something else'],
    },
    submitted: '2026-10-09T18:01:00.000Z',
  },
  {
    name: 'a multiple choice (one answer) event question',
    mapping: TOURNAMENT_MAPPING,
    answers: { 'Email address': 'a@example.org', 'Full name': 'Alex', 'Which events are you entering?': "Men's singles" },
    submitted: '2026-10-09T18:02:00.000Z',
  },
  {
    name: 'no events chosen',
    mapping: TOURNAMENT_MAPPING,
    answers: { 'Email address': 'a@example.org', 'Full name': 'Alex' },
    submitted: '2026-10-09T18:03:00.000Z',
  },
  {
    name: 'a club event form',
    mapping: CLUB_MAPPING,
    answers: { 'Email address': 'Guest@Example.org', 'Full name': 'Guest Person', 'Anything else?': 'no' },
    submitted: '2026-10-09T18:04:00.000Z',
  },
];

/** The script's buildPayload, run as Apps Script would run it. */
function scriptPayload(fixture: Fixture, formId: string, responseId: string): unknown {
  const context: Record<string, unknown> = {
    Logger: { log: () => undefined },
  };
  runInNewContext(SCRIPT, context);
  context.CONFIG = JSON.parse(JSON.stringify(fixture.mapping));
  const form = { getId: () => formId };
  const response = {
    getId: () => responseId,
    getTimestamp: () => new Date(fixture.submitted),
    getItemResponses: () =>
      Object.entries(fixture.answers).map(([title, value]) => ({
        getItem: () => ({ getTitle: () => title }),
        getResponse: () => value,
      })),
  };
  const built = (context.buildPayload as (f: unknown, r: unknown) => unknown)(form, response);
  // Out of the VM's realm, so toEqual compares plain objects.
  return built === null ? null : JSON.parse(JSON.stringify(built));
}

/** The same response as forms.get and forms.responses.list return it. */
function apiShape(fixture: Fixture) {
  const titles = Object.keys(fixture.answers);
  const questions = titles.map((title, i) => ({ questionId: `q${i}`, title }));
  const answers: Record<string, string[]> = {};
  titles.forEach((title, i) => {
    const value = fixture.answers[title]!;
    answers[`q${i}`] = Array.isArray(value) ? value : [value];
  });
  // Google keeps more precision than the script's Date does.
  const lastSubmittedTime = fixture.submitted.replace('Z', '456Z');
  return { questions, answers, lastSubmittedTime };
}

describe('a response read by the console is the response the script sends', () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      const formId = '1FAIpQLSexampleFormId_-';
      const responseId = '2_ABaOnudExampleResponse';
      const fromScript = scriptPayload(fixture, formId, responseId);
      expect(fromScript).not.toBeNull();
      const throughDataApi = parseRegistration(fromScript);

      const api = apiShape(fixture);
      const built = buildRegistrationPayload(
        fixture.mapping,
        formId,
        { responseId, lastSubmittedTime: api.lastSubmittedTime },
        answersByTitle(api.questions, api.answers),
      );
      expect(built.ok).toBe(true);
      if (built.ok) expect(built.payload).toEqual(throughDataApi);
    });
  }

  it('skips what the script skips: no email or no name', () => {
    const fixture: Fixture = {
      name: 'no name',
      mapping: TOURNAMENT_MAPPING,
      answers: { 'Email address': 'a@example.org' },
      submitted: '2026-10-09T18:00:00.000Z',
    };
    expect(scriptPayload(fixture, 'f', 'r')).toBeNull();
    const api = apiShape(fixture);
    expect(
      buildRegistrationPayload(fixture.mapping, 'f', { responseId: 'r', lastSubmittedTime: api.lastSubmittedTime },
        answersByTitle(api.questions, api.answers)),
    ).toEqual({ ok: false, reason: 'no_email_or_name' });
  });

  it('refuses what the Data API refuses, by field', () => {
    const fixture: Fixture = {
      name: 'bad partner email',
      mapping: TOURNAMENT_MAPPING,
      answers: {
        'Email address': 'a@example.org',
        'Full name': 'Alex',
        'Which events are you entering?': ['Mixed doubles'],
        'Mixed doubles partner: email': 'not an address',
      },
      submitted: '2026-10-09T18:00:00.000Z',
    };
    expect(() => parseRegistration(scriptPayload(fixture, 'f', 'r'))).toThrow();
    const api = apiShape(fixture);
    expect(
      buildRegistrationPayload(fixture.mapping, 'f', { responseId: 'r', lastSubmittedTime: api.lastSubmittedTime },
        answersByTitle(api.questions, api.answers)),
    ).toEqual({ ok: false, reason: 'bad_payload', field: 'entries[0].partner_email' });
  });
});

describe('normalizeRegistration is parseRegistration', () => {
  const bodies: unknown[] = [
    { form_id: 'f', response_id: 'r', email: 'A@Example.ORG', name: ' x  y ', entries: [] },
    { form_id: 'f', response_id: 'r', email: 'a@example.org', name: 'x' },
    { form_id: 'f', response_id: 'r', email: 'a@example.org', name: 'x', submitted_at: '2026-10-09T18:00:00Z' },
    { form_id: 'f', response_id: 'r', email: 'a@example.org', name: 'x', submitted_at: '2026-10-09T18:00:00.1234567Z' },
    { form_id: 'f', response_id: 'r', email: 'a@example.org', name: 'x', extra: 1 },
    { form_id: 'f g', response_id: 'r', email: 'a@example.org', name: 'x' },
    { form_id: 'f', response_id: 'r', email: 'a@example.org', name: 'x'.repeat(121) },
    { form_id: 'f', response_id: 'r', email: 'a@example.org', name: 'x', entries: [{ event_id: SINGLES.toUpperCase(), category: ' ' }] },
    { form_id: 'f', response_id: 'r', email: 'a@example.org', name: 'x', entries: [{ event_id: 'nope' }] },
    { form_id: 'f', response_id: 'r', email: 'a@example.org', name: 'x', entries: [{ event_id: SINGLES, category: 'c'.repeat(41) }] },
    { form_id: 'f', response_id: 'r', email: 'a@example.org', name: 'x', entries: Array.from({ length: 21 }, () => ({ event_id: SINGLES })) },
    [],
    null,
  ];
  for (const [i, body] of bodies.entries()) {
    it(`case ${i}`, () => {
      let expected: unknown;
      try {
        expected = { ok: true, payload: parseRegistration(body) };
      } catch (err) {
        expected = { ok: false, field: (err as { field: string }).field };
      }
      expect(normalizeRegistration(body)).toEqual(expected);
    });
  }
});

describe('the mapping', () => {
  it('takes the script CONFIG shape and nothing else', () => {
    expect(formMappingSchema.safeParse(TOURNAMENT_MAPPING).success).toBe(true);
    expect(formMappingSchema.safeParse({ ...TOURNAMENT_MAPPING, EXTRA: 1 }).success).toBe(false);
    expect(formMappingSchema.safeParse({ ...TOURNAMENT_MAPPING, EMAIL_QUESTION: '' }).success).toBe(false);
    expect(formMappingSchema.safeParse({ ...TOURNAMENT_MAPPING, EVENTS: { x: 'not-a-uuid' } }).success).toBe(false);
  });

  it('turns Google\'s timestamp into the script\'s millisecond form', () => {
    expect(scriptTimestamp('2026-10-09T18:00:00.123456789Z')).toBe('2026-10-09T18:00:00.123Z');
    expect(scriptTimestamp('2026-10-09T18:00:00Z')).toBe('2026-10-09T18:00:00.000Z');
    expect(scriptTimestamp('garbage')).toBeNull();
  });

  it('keys answers by title, the later of two equal titles winning', () => {
    expect(
      answersByTitle(
        [
          { questionId: 'a', title: 'Name' },
          { questionId: 'b', title: 'Name' },
          { questionId: 'c', title: 'Unanswered' },
        ],
        { a: ['first'], b: ['second'] },
      ),
    ).toEqual({ Name: ['second'] });
  });
});
