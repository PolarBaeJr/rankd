import { createHash } from 'node:crypto';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  formatClubEventCost,
  formatClubEventTime,
  isDoublesEvent,
  type TournamentEventType,
} from '@badminton/shared';
import {
  DEFAULT_EMAIL_QUESTION,
  DEFAULT_EVENT_QUESTION,
  DEFAULT_MEDIA_ALLOW_ANSWER,
  DEFAULT_MEDIA_QUESTION,
  DEFAULT_NAME_QUESTION,
  DEFAULT_RECEIPT_QUESTION,
  DEFAULT_SIGNATURE_QUESTION,
  DEFAULT_WAIVER_QUESTION,
  defaultPartnerQuestions,
  formMappingSchema,
  type FormMapping,
} from './registration-form-mapping';

// WHAT A FORM THE CONSOLE MAKES SAYS, AND HOW IT IS READ (00296).
//
// The form maker (integrations/google-forms/form-maker.gs) copies a template
// whose questions carry the titles below, and writes only what this file
// computes: the title, the description, the payment text and, for a
// tournament, the event choices and their partner questions. The mapping the
// console saves on the binding is built from the same titles, so a made Form
// maps with nobody typing anything. A test reads the script and checks it
// pins the same titles.
//
// Server only: the fingerprint uses node:crypto.

export const TEMPLATE_TITLES = {
  common: {
    name: DEFAULT_NAME_QUESTION,
    email: DEFAULT_EMAIL_QUESTION,
    receipt: DEFAULT_RECEIPT_QUESTION,
    paymentSection: 'Payment',
    waiver: DEFAULT_WAIVER_QUESTION,
    signature: DEFAULT_SIGNATURE_QUESTION,
    media: DEFAULT_MEDIA_QUESTION,
    mediaAllow: DEFAULT_MEDIA_ALLOW_ANSWER,
  },
  tournament: {
    events: DEFAULT_EVENT_QUESTION,
    partnerSection: 'Partners',
  },
} as const;

/** The data API consumer 00296 seeds to own these bindings. */
export const FORM_MAKER_CONSUMER_NAME = 'Google Forms made by the console';

export type ManagedKind = 'club_event' | 'tournament';

export interface TournamentChoice {
  label: string;
  eventId: string;
  doubles: boolean;
}

export interface ChoiceEvent {
  id: string;
  event_type: string;
  external_event: boolean | null;
  created_at: string;
}

/**
 * The tournament's event choices, oldest event first. A choice keeps the label
 * it had in the previous mapping (responses already given carry that text);
 * a new event takes its type's label, with " (external)" for an external one,
 * and " 2", " 3" when that label is taken. A deleted event drops out.
 */
export function tournamentChoices(events: ChoiceEvent[], previous: FormMapping | null): TournamentChoice[] {
  const ordered = [...events].sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.created_at < b.created_at ? -1 : 1,
  );
  const sticky = new Map<string, string>();
  for (const [label, eventId] of Object.entries(previous?.EVENTS ?? {})) {
    if (!sticky.has(eventId)) sticky.set(eventId, label);
  }
  const taken = new Set<string>();
  for (const event of ordered) {
    const label = sticky.get(event.id);
    if (label) taken.add(label);
  }
  const choices: TournamentChoice[] = [];
  for (const event of ordered) {
    let label = sticky.get(event.id);
    if (!label) {
      const base = `${(TOURNAMENT_EVENT_TYPE_LABELS as Record<string, string>)[event.event_type] ?? event.event_type}${
        event.external_event ? ' (external)' : ''
      }`;
      label = base;
      for (let n = 2; taken.has(label); n++) label = `${base} ${n}`;
      taken.add(label);
    }
    choices.push({ label, eventId: event.id, doubles: isDoublesEvent(event.event_type as TournamentEventType) });
  }
  return choices;
}

/**
 * The question mapping for a made Form, as the reader card would build it
 * (FormReaderPanel's build()), validated by the same schema.
 */
export function managedMapping(
  kind: ManagedKind,
  targetId: string,
  choices: TournamentChoice[] | null,
  paid: boolean,
  waiverVersion: string,
): FormMapping {
  const common = TEMPLATE_TITLES.common;
  const events: Record<string, string> = {};
  const partners: FormMapping['PARTNERS'] = {};
  if (kind === 'tournament') {
    for (const choice of choices ?? []) {
      events[choice.label] = choice.eventId;
      if (choice.doubles) partners[choice.label] = defaultPartnerQuestions(choice.label);
    }
  }
  return formMappingSchema.parse({
    EMAIL_QUESTION: common.email,
    NAME_QUESTION: common.name,
    EVENT_QUESTION: kind === 'tournament' ? TEMPLATE_TITLES.tournament.events : '',
    EVENTS: events,
    DEFAULT_EVENT_ID: kind === 'club_event' ? targetId : '',
    PARTNERS: partners,
    RECEIPT_QUESTION: paid ? common.receipt : '',
    WAIVER_QUESTION: common.waiver,
    WAIVER_VERSION: waiverVersion,
    SIGNATURE_QUESTION: common.signature,
    MEDIA_QUESTION: common.media,
    MEDIA_ALLOW_ANSWER: common.mediaAllow,
  });
}

export interface ClubEventContentRow {
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  cost_cents: number | null;
}

export interface TournamentContentRow {
  name: string;
  start_date: string | null;
  end_date: string | null;
}

export interface FeeTierRow {
  name: string;
  amount_cents: number | null;
}

export interface FormContent {
  title: string;
  description: string;
  payment: { text: string } | null;
  choices: { label: string; doubles: boolean }[] | null;
  closedMessage: string;
}

function money(cents: number | null): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

/** A tournament date (YYYY-MM-DD) as "Nov 3, 2026". A date has no time, so no zone. */
function formatDay(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return at.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Whether people pay to enter: a club event with a cost, or a tournament with a priced tier. */
export function isPaid(
  kind: ManagedKind,
  row: ClubEventContentRow | TournamentContentRow,
  tiers: FeeTierRow[] = [],
): boolean {
  if (kind === 'club_event') return ((row as ClubEventContentRow).cost_cents ?? 0) > 0;
  return tiers.some((tier) => (tier.amount_cents ?? 0) > 0);
}

/**
 * What the Form shows. A paid target with no e-transfer email set gets no
 * payment text (the caller refuses to make or update it instead).
 */
export function formContent(
  kind: ManagedKind,
  row: ClubEventContentRow | TournamentContentRow,
  extras: { etransferEmail: string | null; tiers?: FeeTierRow[]; choices?: TournamentChoice[] | null },
): FormContent {
  const paid = isPaid(kind, row, extras.tiers);
  if (kind === 'club_event') {
    const event = row as ClubEventContentRow;
    const lines = [event.description?.trim() ?? '', `When: ${formatClubEventTime(event.starts_at)}`];
    if (event.location?.trim()) lines.push(`Where: ${event.location.trim()}`);
    const cost = formatClubEventCost(event.cost_cents);
    return {
      title: event.title,
      description: lines.filter(Boolean).join('\n\n'),
      payment:
        paid && extras.etransferEmail
          ? {
              text: `Send ${cost} by Interac e-Transfer to ${extras.etransferEmail}, then upload a screenshot of the confirmation below.`,
            }
          : null,
      choices: null,
      closedMessage: `Sign-ups for ${event.title} are closed.`,
    };
  }

  const tournament = row as TournamentContentRow;
  const dates =
    tournament.start_date && tournament.end_date && tournament.end_date !== tournament.start_date
      ? `${formatDay(tournament.start_date)} to ${formatDay(tournament.end_date)}`
      : tournament.start_date
        ? formatDay(tournament.start_date)
        : '';
  const tiers = extras.tiers ?? [];
  const tierLines = tiers.map((tier) => `${tier.name}: ${money(tier.amount_cents)}`);
  return {
    title: tournament.name,
    description: dates ? `When: ${dates}` : '',
    payment:
      paid && extras.etransferEmail
        ? {
            text: [
              `Send your entry fee by Interac e-Transfer to ${extras.etransferEmail}, then upload a screenshot of the confirmation below.`,
              ...tierLines,
            ].join('\n'),
          }
        : null,
    choices: (extras.choices ?? []).map((choice) => ({ label: choice.label, doubles: choice.doubles })),
    closedMessage: `Sign-ups for ${tournament.name} are closed.`,
  };
}

/** JSON with every object's keys in order, so equal content always hashes the same. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** What was last written to the Form, minus the closed message, which only close writes. */
export function contentFingerprint(content: FormContent): string {
  const { closedMessage: _closedMessage, ...written } = content;
  return createHash('sha256').update(stableJson(written)).digest('hex');
}
