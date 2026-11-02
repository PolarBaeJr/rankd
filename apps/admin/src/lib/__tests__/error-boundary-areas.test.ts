import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Every route error boundary names its area, so a numeric digest from a page
// that threw a plain Error still reads as FEE-000 or TRN-000 rather than
// GEN-000. A new error.tsx fails here until it is given one.
const APP = join(__dirname, '../../app');

function errorBoundaries(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return errorBoundaries(path);
    return entry.name === 'error.tsx' ? [path] : [];
  });
}

function expectedArea(route: string): string {
  if (route.startsWith('fees/')) return 'FEE';
  if (route.startsWith('finances/')) return 'FEE';
  if (route.startsWith('tournaments/')) return 'TRN';
  return 'GEN';
}

describe('route error boundaries', () => {
  const files = errorBoundaries(APP);

  it('finds the boundaries', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(APP, f), f]))('%s names its area', (route, file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain(`<RouteError area="${expectedArea(route)}"`);
  });
});
