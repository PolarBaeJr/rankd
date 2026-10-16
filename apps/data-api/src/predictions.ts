import { REF_PATTERN } from './params.js';

// The shape check for POST and DELETE /v1/predictions, run before the database
// is asked. Each refusal names the field, which the handler turns into
// 400 {"error":"bad_request","field":"<path>"}. The write function in 00282
// repeats every check; this copy exists so a caller's mistake is a 400 that
// says where, rather than a refused row that says only what.

export const MAX_BATCH = 100;
export const MAX_BODY_BYTES = 64 * 1024;
/** How far ahead of the server clock a `made_at` may be. */
export const MADE_AT_SKEW_MS = 5 * 60_000;

const MODEL_PATTERN = /^[A-Za-z0-9 ._:+-]{1,64}$/;
const MADE_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

const PREDICTION_FIELDS = ['format', 'side_a', 'side_b', 'probability', 'model', 'made_at'] as const;
const MATCHUP_FIELDS = ['format', 'side_a', 'side_b'] as const;

export class BadBody extends Error {
  constructor(readonly field: string) {
    super(`bad field ${field}`);
  }
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The items of a batch: `{"<wrapper>": [...]}`, or one bare item. Returns each
 * item with the prefix its field names are reported under.
 */
function itemsOf(body: unknown, wrapper: string): { item: unknown; prefix: string }[] {
  if (!isObject(body)) throw new BadBody('body');
  if (!(wrapper in body)) return [{ item: body, prefix: '' }];
  for (const key of Object.keys(body)) if (key !== wrapper) throw new BadBody(key);
  const list = body[wrapper];
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_BATCH) throw new BadBody(wrapper);
  return list.map((item, i) => ({ item, prefix: `${wrapper}[${i}].` }));
}

function checkMatchup(item: unknown, prefix: string, fields: readonly string[]): Obj {
  if (!isObject(item)) throw new BadBody(prefix ? prefix.slice(0, -1) : 'body');
  for (const key of Object.keys(item)) if (!fields.includes(key)) throw new BadBody(prefix + key);
  for (const key of fields) if (!(key in item)) throw new BadBody(prefix + key);

  if (item.format !== 'singles' && item.format !== 'doubles') throw new BadBody(prefix + 'format');
  const size = item.format === 'singles' ? 1 : 2;
  const seen = new Set<string>();
  for (const side of ['side_a', 'side_b'] as const) {
    const refs = item[side];
    if (!Array.isArray(refs) || refs.length !== size) throw new BadBody(prefix + side);
    for (const ref of refs) {
      if (typeof ref !== 'string' || !REF_PATTERN.test(ref) || seen.has(ref)) throw new BadBody(prefix + side);
      seen.add(ref);
    }
  }
  return item;
}

/** The body of POST /v1/predictions, as the array the write function takes. */
export function parsePredictions(body: unknown, now: number): Obj[] {
  return itemsOf(body, 'predictions').map(({ item, prefix }) => {
    const p = checkMatchup(item, prefix, PREDICTION_FIELDS);
    if (typeof p.probability !== 'number' || !Number.isFinite(p.probability) || p.probability < 0 || p.probability > 1) {
      throw new BadBody(prefix + 'probability');
    }
    if (typeof p.model !== 'string' || !MODEL_PATTERN.test(p.model)) throw new BadBody(prefix + 'model');
    const made = typeof p.made_at === 'string' && MADE_AT_PATTERN.test(p.made_at) ? Date.parse(p.made_at) : NaN;
    if (Number.isNaN(made) || made > now + MADE_AT_SKEW_MS) throw new BadBody(prefix + 'made_at');
    return p;
  });
}

/** The body of DELETE /v1/predictions, as the array the delete function takes. */
export function parseMatchups(body: unknown): Obj[] {
  return itemsOf(body, 'matchups').map(({ item, prefix }) => checkMatchup(item, prefix, MATCHUP_FIELDS));
}
