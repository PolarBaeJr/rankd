import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// THE EVENT STANDARD'S TABLES ARE SERVICE-ROLE ONLY (00324, 00325). Every one
// is revoked from anon and authenticated, so a request-scoped read returns an
// empty list with NO error: the "Confirm your place" banner would never show
// and a restricted member would look unrestricted. The same hazard, and the
// same crude guard, as feedback-reports-grants.test.ts: the failure has no
// runtime signal, so the call site is the only place to catch it.

const SRC = join(__dirname, '../..');
const TABLES = ['tournament_event_confirmations', 'attendance_warnings', 'event_entry_restrictions', 'event_departures', 'event_substitutions'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('the event standard tables are only ever read with the service role', () => {
  it.each(TABLES)('has no request-scoped query of %s', (table) => {
    const offenders: string[] = [];
    const SERVICE_FACTORIES = /(createServiceRoleClient|createAdminClient)\(\)/;
    const needle = `.from('${table}')`;

    for (const file of sourceFiles(SRC)) {
      const raw = readFileSync(file, 'utf8');
      if (!raw.includes(needle)) continue;
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

      const serviceBindings = new Set<string>();
      for (const bind of text.matchAll(
        /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:await\s+)?(createServiceRoleClient|createAdminClient)\(\)/g,
      )) {
        if (bind[1]) serviceBindings.add(bind[1]);
      }
      // A helper that takes the client as a parameter named `service` is
      // handed createServiceRoleClient() by every caller (entry-restriction.ts).
      if (/\(\s*service\s*:\s*SupabaseClient/.test(text)) serviceBindings.add('service');

      const pattern = new RegExp(`([A-Za-z0-9_$]+(?:\\(\\))?)\\s*\\.from\\('${table}'\\)`, 'g');
      for (const match of text.matchAll(pattern)) {
        const receiver = match[1];
        if (!receiver) continue;
        const ok = SERVICE_FACTORIES.test(receiver) || serviceBindings.has(receiver);
        if (!ok) offenders.push(`${file.slice(SRC.length + 1)} :: ${receiver}${needle}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('finds the member-side reads it is guarding', () => {
    const files = sourceFiles(SRC).filter((file) => readFileSync(file, 'utf8').includes(".from('tournament_event_confirmations')"));
    expect(files.length).toBeGreaterThan(0);
  });
});
