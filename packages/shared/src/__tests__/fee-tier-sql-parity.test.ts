import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { selectFeeTier, type PricingTier } from '../utils/fee-tiers';

// 00283 prices a non-member's form entry in SQL with select_fee_tier, a twin
// of selectFeeTier. The migration's $proof$ block runs its case table against
// the SQL twin when it is applied; this test runs the same table, read from
// the same file, against the TypeScript one. A case either side gets wrong
// fails one of the two, so the twins cannot drift apart on these cases.
//
// One known difference stays outside the table on purpose: the SQL breaks a
// final tie by name COLLATE "C", the TypeScript by localeCompare, and the two
// disagree only for two tiers in the same bucket with the same sort_order whose
// names differ by letter case.

const MIGRATIONS = join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations');

interface TierCase {
  name: string;
  group: string | null;
  tiers: PricingTier[];
  expected: string | null;
}

function cases(): TierCase[] {
  const file = readdirSync(MIGRATIONS).find((f) => f.startsWith('00283_'));
  expect(file).toBeDefined();
  const sql = readFileSync(join(MIGRATIONS, file!), 'utf8');
  const start = sql.indexOf('-- @fee-tier-cases-begin');
  const end = sql.indexOf('-- @fee-tier-cases-end');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = sql.slice(start, end);
  return JSON.parse(block.slice(block.indexOf('['), block.lastIndexOf(']') + 1)) as TierCase[];
}

describe('select_fee_tier (00283) and selectFeeTier agree', () => {
  const table = cases();

  it('reads a non-trivial case table', () => {
    expect(table.length).toBeGreaterThanOrEqual(10);
    expect(new Set(table.map((c) => c.name)).size).toBe(table.length);
  });

  for (const c of table) {
    it(c.name, () => {
      expect(selectFeeTier(c.group, c.tiers)?.tier.id ?? null).toBe(c.expected);
    });
  }
});
