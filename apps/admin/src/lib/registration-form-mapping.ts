import { z } from 'zod';

// HOW A GOOGLE FORM'S ANSWERS BECOME A REGISTRATION (00287).
//
// The mapping is the Apps Script's CONFIG (integrations/google-forms/
// registration-import.gs), stored on the binding as jsonb with the same keys,
// so an exec who has set up the script has already written it, and the card
// edits it field by field. Questions are found by TITLE, as the script does.
//
// buildRegistrationPayload is the script's buildPayload, entryFor and single,
// line for line, followed by normalizeRegistration, which is the Data API's
// parseRegistration (apps/data-api/src/registrations.ts) line for line. The
// payload the database hashes is therefore the same whichever road a
// response takes, and a test runs both builders over the same fixtures.
//
// No node imports: the card imports the types and the defaults.

const title = z.string().trim().max(300);
const eventId = z.string().uuid();

export const formMappingSchema = z
  .object({
    EMAIL_QUESTION: title.min(1, 'Name the question that asks for the email'),
    NAME_QUESTION: title.min(1, 'Name the question that asks for the full name'),
    EVENT_QUESTION: title,
    EVENTS: z.record(z.string().max(300), eventId).refine((events) => Object.keys(events).length <= 40, {
      message: 'At most 40 event choices',
    }),
    DEFAULT_EVENT_ID: z.union([eventId, z.literal('')]),
    PARTNERS: z
      .record(
        z.string().max(300),
        z
          .object({
            NAME_QUESTION: title,
            EMAIL_QUESTION: title,
            CATEGORY_QUESTION: title,
          })
          .strict(),
      )
      .refine((partners) => Object.keys(partners).length <= 40, { message: 'At most 40 partner entries' }),
  })
  .strict();

export type FormMapping = z.infer<typeof formMappingSchema>;

/** The registration body, exactly as POST /v1/registrations accepts it after its shape check. */
export interface RegistrationEntry {
  event_id: string;
  partner_email?: string;
  partner_name?: string;
  category?: string;
}

export interface RegistrationPayload {
  form_id: string;
  response_id: string;
  submitted_at?: string;
  email: string;
  name: string;
  entries: RegistrationEntry[];
}

// ---- the Data API's parseRegistration, ported ------------------------------

const MAX_ENTRIES = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const SUBMITTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const TOP_FIELDS = ['form_id', 'response_id', 'submitted_at', 'email', 'name', 'entries'];
const ENTRY_FIELDS = ['event_id', 'partner_email', 'partner_name', 'category'];

class BadField extends Error {
  constructor(readonly field: string) {
    super(`bad field ${field}`);
  }
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadField(field);
    return undefined;
  }
  if (typeof value !== 'string') throw new BadField(field);
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) {
    if (required) throw new BadField(field);
    return undefined;
  }
  if (trimmed.length > max) throw new BadField(field);
  return trimmed;
}

function email(value: unknown, field: string, required: boolean): string | undefined {
  const raw = text(value, field, 254, required);
  if (raw === undefined) return undefined;
  const lowered = raw.toLowerCase();
  if (!EMAIL_PATTERN.test(lowered)) throw new BadField(field);
  return lowered;
}

/**
 * parseRegistration, returning the refused field instead of throwing. The
 * script path answers such a body with a 400 and imports nothing, so the
 * reader skips it the same way.
 */
export function normalizeRegistration(
  body: unknown,
): { ok: true; payload: RegistrationPayload } | { ok: false; field: string } {
  try {
    if (!isObject(body)) throw new BadField('body');
    for (const key of Object.keys(body)) {
      if (!TOP_FIELDS.includes(key)) throw new BadField(key);
    }
    const formId = text(body.form_id, 'form_id', 200, true)!;
    if (!ID_PATTERN.test(formId)) throw new BadField('form_id');
    const responseId = text(body.response_id, 'response_id', 200, true)!;
    if (!ID_PATTERN.test(responseId)) throw new BadField('response_id');

    let submittedAt: string | undefined;
    if (body.submitted_at !== undefined && body.submitted_at !== null) {
      if (
        typeof body.submitted_at !== 'string' ||
        !SUBMITTED_AT_PATTERN.test(body.submitted_at) ||
        Number.isNaN(Date.parse(body.submitted_at))
      ) {
        throw new BadField('submitted_at');
      }
      submittedAt = body.submitted_at;
    }

    const payload: RegistrationPayload = {
      form_id: formId,
      response_id: responseId,
      email: email(body.email, 'email', true)!,
      name: text(body.name, 'name', 120, true)!,
      entries: [],
    };
    if (submittedAt) payload.submitted_at = submittedAt;

    if (body.entries !== undefined) {
      if (!Array.isArray(body.entries) || body.entries.length > MAX_ENTRIES) throw new BadField('entries');
      payload.entries = body.entries.map((entry, i) => {
        const prefix = `entries[${i}].`;
        if (!isObject(entry)) throw new BadField(`entries[${i}]`);
        for (const key of Object.keys(entry)) {
          if (!ENTRY_FIELDS.includes(key)) throw new BadField(prefix + key);
        }
        if (typeof entry.event_id !== 'string' || !UUID_PATTERN.test(entry.event_id)) {
          throw new BadField(prefix + 'event_id');
        }
        const out: RegistrationEntry = { event_id: entry.event_id.toLowerCase() };
        const partnerEmail = email(entry.partner_email, prefix + 'partner_email', false);
        const partnerName = text(entry.partner_name, prefix + 'partner_name', 120, false);
        const category = text(entry.category, prefix + 'category', 40, false);
        if (partnerEmail) out.partner_email = partnerEmail;
        if (partnerName) out.partner_name = partnerName;
        if (category) out.category = category;
        return out;
      });
    }
    return { ok: true, payload };
  } catch (err) {
    if (err instanceof BadField) return { ok: false, field: err.field };
    throw err;
  }
}

// ---- the Apps Script's buildPayload, ported --------------------------------

/** The script's single(): an array joined by spaces, trimmed. */
function single(answer: string | string[] | undefined): string {
  if (answer === undefined || answer === null) return '';
  const value = Array.isArray(answer) ? answer.join(' ') : String(answer);
  return value.trim();
}

/**
 * A response's answers keyed by question TITLE, as the script's
 * `answers[itemResponse.getItem().getTitle()] = itemResponse.getResponse()`.
 * A choice question's answer is the list of choices; a text answer is a list
 * of one. Two questions with one title: the later one wins, as in the script.
 */
export function answersByTitle(
  questions: { questionId: string; title: string }[],
  answers: Record<string, string[]>,
): Record<string, string[]> {
  const byTitle: Record<string, string[]> = {};
  for (const question of questions) {
    const values = answers[question.questionId];
    if (values && values.length > 0) byTitle[question.title] = values;
  }
  return byTitle;
}

/** The script's submitted_at: a JavaScript Date's toISOString(), millisecond precision. */
export function scriptTimestamp(lastSubmittedTime: string): string | null {
  const at = new Date(lastSubmittedTime);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export type BuiltPayload =
  | { ok: true; payload: RegistrationPayload }
  | { ok: false; reason: 'no_email_or_name' | 'bad_payload'; field?: string };

/**
 * One response as the script would send it, then as the Data API would pass
 * it to the database. Entries follow the order of the event question's
 * answer; a choice with no event id is dropped, as the script drops it.
 */
export function buildRegistrationPayload(
  mapping: FormMapping,
  formId: string,
  response: { responseId: string; lastSubmittedTime: string },
  answers: Record<string, string[]>,
): BuiltPayload {
  const pick = (question: string): string[] | undefined => (question ? answers[question] : undefined);
  const emailAnswer = single(pick(mapping.EMAIL_QUESTION));
  const nameAnswer = single(pick(mapping.NAME_QUESTION));
  if (!emailAnswer || !nameAnswer) return { ok: false, reason: 'no_email_or_name' };

  const choices = pick(mapping.EVENT_QUESTION) ?? [];
  const entries: Record<string, string>[] = [];
  for (const choice of choices) {
    const eventId = Object.prototype.hasOwnProperty.call(mapping.EVENTS, choice) ? mapping.EVENTS[choice] : undefined;
    if (!eventId) continue;
    const entry: Record<string, string> = { event_id: eventId };
    const partner = Object.prototype.hasOwnProperty.call(mapping.PARTNERS, choice) ? mapping.PARTNERS[choice] : undefined;
    if (partner) {
      const partnerName = single(pick(partner.NAME_QUESTION));
      const partnerEmail = single(pick(partner.EMAIL_QUESTION));
      const category = partner.CATEGORY_QUESTION ? single(pick(partner.CATEGORY_QUESTION)) : '';
      if (partnerName) entry.partner_name = partnerName;
      if (partnerEmail) entry.partner_email = partnerEmail;
      if (category) entry.category = category;
    }
    entries.push(entry);
  }
  if (choices.length === 0 && mapping.DEFAULT_EVENT_ID) {
    entries.push({ event_id: mapping.DEFAULT_EVENT_ID });
  }

  const submittedAt = scriptTimestamp(response.lastSubmittedTime);
  const raw: Record<string, unknown> = {
    form_id: formId,
    response_id: response.responseId,
    email: emailAnswer,
    name: nameAnswer,
    entries,
  };
  if (submittedAt) raw.submitted_at = submittedAt;
  const normalized = normalizeRegistration(raw);
  return normalized.ok ? normalized : { ok: false, reason: 'bad_payload', field: normalized.field };
}

/** The questions a mapping needs to find on the form for any response to import. */
export function requiredQuestions(mapping: FormMapping): string[] {
  return [mapping.EMAIL_QUESTION, mapping.NAME_QUESTION];
}

// ---- defaults the card starts from -----------------------------------------

/** The script's example titles, so a form built from its comments maps with no typing. */
export const DEFAULT_EMAIL_QUESTION = 'Email address';
export const DEFAULT_NAME_QUESTION = 'Full name';
export const DEFAULT_EVENT_QUESTION = 'Which events are you entering?';

export function defaultPartnerQuestions(choice: string) {
  return {
    NAME_QUESTION: `${choice} partner: full name`,
    EMAIL_QUESTION: `${choice} partner: email`,
    CATEGORY_QUESTION: '',
  };
}
