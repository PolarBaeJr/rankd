// A small in-memory stand-in for the service client, for the wave 2 posts and
// teams tests. Rows live in plain arrays per table; reads filter them, writes
// change them, and every write is recorded so a test can say what happened.
// Embeds (`player:players(...)`) are not resolved: a test seeds the embedded
// object on the row itself.

type Row = Record<string, unknown>;

export interface Write {
  table: string;
  op: 'insert' | 'update' | 'delete';
  values?: unknown;
  filters: string[];
}

export interface TableFake {
  tables: Record<string, Row[]>;
  writes: Write[];
  rpcs: { name: string; args: Record<string, unknown> }[];
  rpcResult: (name: string, args: Record<string, unknown>) => unknown;
  failRead: Set<string>;
  client: unknown;
}

let nextId = 1;
export const fakeId = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

export function tableFake(seed: Record<string, Row[]> = {}): TableFake {
  const fake: TableFake = {
    tables: Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))])),
    writes: [],
    rpcs: [],
    rpcResult: () => ({ ok: true }),
    failRead: new Set(),
    client: null,
  };

  const rowsOf = (table: string) => (fake.tables[table] ??= []);

  function query(table: string) {
    const predicates: Array<(row: Row) => boolean> = [];
    const filters: string[] = [];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let values: unknown = null;
    let orderBy: { column: string; ascending: boolean } | null = null;
    let limitTo: number | null = null;

    const run = (): { data: unknown; error: { message: string } | null; count?: number } => {
      if (op === 'select' && fake.failRead.has(table)) return { data: null, error: { message: `${table} unreadable` } };
      if (op === 'insert') {
        const list = (Array.isArray(values) ? values : [values]) as Row[];
        const inserted = list.map((row) => ({ id: row.id ?? fakeId(), created_at: row.created_at ?? new Date().toISOString(), ...row }));
        rowsOf(table).push(...inserted);
        fake.writes.push({ table, op, values, filters });
        return { data: Array.isArray(values) ? inserted : inserted[0], error: null };
      }
      const matched = rowsOf(table).filter((row) => predicates.every((p) => p(row)));
      if (op === 'update') {
        for (const row of matched) Object.assign(row, values as Row);
        fake.writes.push({ table, op, values, filters });
        return { data: matched, error: null, count: matched.length };
      }
      if (op === 'delete') {
        fake.tables[table] = rowsOf(table).filter((row) => !matched.includes(row));
        fake.writes.push({ table, op, filters });
        return { data: matched, error: null, count: matched.length };
      }
      let out = [...matched];
      if (orderBy) {
        const { column, ascending } = orderBy;
        out.sort((a, b) => (String(a[column] ?? '') < String(b[column] ?? '') ? -1 : String(a[column] ?? '') > String(b[column] ?? '') ? 1 : 0) * (ascending ? 1 : -1));
      }
      if (limitTo !== null) out = out.slice(0, limitTo);
      return { data: out, error: null };
    };

    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: (v: unknown) => { op = 'insert'; values = v; return chain; },
      update: (v: unknown) => { op = 'update'; values = v; return chain; },
      delete: () => { op = 'delete'; return chain; },
      eq: (column: string, value: unknown) => { filters.push(`${column}=${String(value)}`); predicates.push((row) => row[column] === value); return chain; },
      neq: (column: string, value: unknown) => { predicates.push((row) => row[column] !== value); return chain; },
      is: (column: string, value: unknown) => { predicates.push((row) => (row[column] ?? null) === value); return chain; },
      in: (column: string, list: unknown[]) => { predicates.push((row) => list.includes(row[column])); return chain; },
      lte: (column: string, value: unknown) => {
        predicates.push((row) => (typeof value === 'number'
          ? typeof row[column] === 'number' && (row[column] as number) <= value
          : String(row[column] ?? '') <= String(value)));
        return chain;
      },
      // Not evaluated: a test seeds only the rows the OR would keep.
      or: () => chain,
      gte: (column: string, value: unknown) => { predicates.push((row) => String(row[column] ?? '') >= String(value)); return chain; },
      gt: (column: string, value: unknown) => { predicates.push((row) => String(row[column] ?? '') > String(value)); return chain; },
      contains: (column: string, list: unknown[]) => {
        predicates.push((row) => Array.isArray(row[column]) && list.every((item) => (row[column] as unknown[]).includes(item)));
        return chain;
      },
      not: (column: string, operator: string, value: unknown) => {
        if (operator === 'is') predicates.push((row) => (row[column] ?? null) !== value);
        if (operator === 'in') {
          const list = String(value).replace(/[()"]/g, '').split(',');
          predicates.push((row) => !list.includes(String(row[column])));
        }
        return chain;
      },
      order: (column: string, options?: { ascending?: boolean }) => { orderBy = { column, ascending: options?.ascending !== false }; return chain; },
      limit: (n: number) => { limitTo = n; return chain; },
      single: async () => {
        const result = run();
        const data = Array.isArray(result.data) ? result.data[0] ?? null : result.data;
        return { data, error: result.error ?? (data ? null : { message: 'no row' }) };
      },
      maybeSingle: async () => {
        const result = run();
        return { data: Array.isArray(result.data) ? result.data[0] ?? null : result.data, error: result.error };
      },
      then: (resolve: (value: unknown) => void, reject: (err: unknown) => void) => {
        try { resolve(run()); } catch (err) { reject(err); }
      },
    };
    return chain;
  }

  fake.client = {
    from: (table: string) => query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      fake.rpcs.push({ name, args });
      return { data: fake.rpcResult(name, args), error: null };
    },
  };
  return fake;
}
