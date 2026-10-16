import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DATA_API_SCOPES } from '../scopes.js';
// The console's list. If it ever gains a scope this service does not know,
// a key minted with it would 403 on every route with nothing saying why.
import { DATA_API_SCOPES as CONSOLE_SCOPES } from '../../../../packages/shared/src/utils/data-api-key.js';

describe('scope vocabulary agrees with the console and the database', () => {
  it('is the same list, in the same order, as the shared one', () => {
    expect([...DATA_API_SCOPES]).toEqual([...CONSOLE_SCOPES]);
  });

  it('is exactly what the newest vocabulary CHECK admits', () => {
    // The last migration to restate the CHECK is the one in force.
    const dir = new URL('../../../../supabase/migrations/', import.meta.url);
    const newest = readdirSync(dir)
      .filter((name) => /^\d{5}_.*\.sql$/.test(name))
      .sort()
      .map((name) => readFileSync(new URL(name, dir), 'utf8'))
      .filter((text) => text.includes('ADD CONSTRAINT data_api_keys_scope_vocabulary'))
      .pop();
    expect(newest).toBeDefined();
    const sql = newest!;
    const check = /ADD CONSTRAINT data_api_keys_scope_vocabulary\s+CHECK \(scopes <@ ARRAY\[([^\]]+)\]/.exec(sql);
    expect(check).not.toBeNull();
    const admitted = [...check![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(admitted).toEqual([...DATA_API_SCOPES]);
  });
});
