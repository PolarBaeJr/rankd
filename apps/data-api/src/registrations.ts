import { BadBody } from './predictions.js';

// The shape check for POST /v1/registrations, run before the database is
// asked. The import function in 00283 repeats every check; this copy exists so
// a script's mistake is a 400 naming the field rather than a refused import.
//
// The body is one Google Form response:
//   { "form_id": "...", "response_id": "...", "submitted_at": "<ISO>"?,
//     "email": "...", "name": "...",
//     "entries": [ { "event_id": "<uuid>", "partner_email"?: "...",
//                    "partner_name"?: "...", "category"?: "..." } ]? }
//
// Nothing here is ever logged: the body carries a typed name and email.

export const MAX_ENTRIES = 20;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const SUBMITTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

const TOP_FIELDS = ['form_id', 'response_id', 'submitted_at', 'email', 'name', 'entries'] as const;
const ENTRY_FIELDS = ['event_id', 'partner_email', 'partner_name', 'category'] as const;

type Obj = Record<string, unknown>;

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

function isObject(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadBody(field);
    return undefined;
  }
  if (typeof value !== 'string') throw new BadBody(field);
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) {
    if (required) throw new BadBody(field);
    return undefined;
  }
  if (trimmed.length > max) throw new BadBody(field);
  return trimmed;
}

function email(value: unknown, field: string, required: boolean): string | undefined {
  const raw = text(value, field, 254, required);
  if (raw === undefined) return undefined;
  const lowered = raw.toLowerCase();
  if (!EMAIL_PATTERN.test(lowered)) throw new BadBody(field);
  return lowered;
}

export function parseRegistration(body: unknown): RegistrationPayload {
  if (!isObject(body)) throw new BadBody('body');
  for (const key of Object.keys(body)) {
    if (!(TOP_FIELDS as readonly string[]).includes(key)) throw new BadBody(key);
  }

  const formId = text(body.form_id, 'form_id', 200, true)!;
  if (!ID_PATTERN.test(formId)) throw new BadBody('form_id');
  const responseId = text(body.response_id, 'response_id', 200, true)!;
  if (!ID_PATTERN.test(responseId)) throw new BadBody('response_id');

  let submittedAt: string | undefined;
  if (body.submitted_at !== undefined && body.submitted_at !== null) {
    if (typeof body.submitted_at !== 'string' || !SUBMITTED_AT_PATTERN.test(body.submitted_at)
        || Number.isNaN(Date.parse(body.submitted_at))) {
      throw new BadBody('submitted_at');
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
    if (!Array.isArray(body.entries) || body.entries.length > MAX_ENTRIES) throw new BadBody('entries');
    payload.entries = body.entries.map((entry, i) => {
      const prefix = `entries[${i}].`;
      if (!isObject(entry)) throw new BadBody(`entries[${i}]`);
      for (const key of Object.keys(entry)) {
        if (!(ENTRY_FIELDS as readonly string[]).includes(key)) throw new BadBody(prefix + key);
      }
      if (typeof entry.event_id !== 'string' || !UUID_PATTERN.test(entry.event_id)) {
        throw new BadBody(prefix + 'event_id');
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
  return payload;
}
