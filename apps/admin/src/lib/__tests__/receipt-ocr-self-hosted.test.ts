import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The console's OCR of a form receipt (00288) must never send an exec's
// browser, or the screenshot, to a third party. tesseract.js defaults its
// worker, core and language paths to a public CDN; receipt-ocr.ts overrides
// all three with the console's own /tesseract/, through withBase because the
// console is mounted under a base path. This pins both halves: no URL in the
// source, and the files it names are committed. The middleware lets them
// through without a session check, or the worker load would meet a redirect.

const APP = join(__dirname, '..', '..', '..');
const source = readFileSync(join(APP, 'src', 'app', 'fees', 'receipt-ocr.ts'), 'utf8');

describe('receipt OCR is self-hosted', () => {
  it('names no remote host', () => {
    for (const needle of ['jsdelivr', 'unpkg', 'http:', 'https:', 'tessdata.projectnaptha']) {
      expect(source.toLowerCase(), needle).not.toContain(needle);
    }
  });

  it("points every tesseract path at the console's /tesseract/", () => {
    expect(source).toContain("workerPath: withBase('/tesseract/worker.min.js')");
    expect(source).toContain("corePath: withBase('/tesseract/')");
    expect(source).toContain("langPath: withBase('/tesseract/')");
    expect(source).toContain('workerBlobURL: false');
  });

  it('serves /tesseract/ past the session check', () => {
    const middleware = readFileSync(join(APP, 'src', 'middleware.ts'), 'utf8');
    expect(middleware).toMatch(/matcher:[\s\S]*\|tesseract\/\)/);
  });

  it.each([
    'worker.min.js',
    'tesseract-core-lstm.wasm.js',
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
    'eng.traineddata.gz',
  ])('ships public/tesseract/%s', (name) => {
    expect(statSync(join(APP, 'public', 'tesseract', name)).size).toBeGreaterThan(0);
  });
});

// The server's own read (00297) is held to the same rule: the model comes off
// this app's disk, so a screenshot never leaves the container. Both apps run it.
describe.each(['admin', 'player'])('the %s server OCR is self-hosted', (app) => {
  const root = join(APP, '..', app);
  const server = readFileSync(join(root, 'src', 'lib', 'receipt-ocr-server.ts'), 'utf8');

  it('names no remote host and reads the model off disk', () => {
    for (const needle of ['jsdelivr', 'unpkg', 'http:', 'https:', 'tessdata.projectnaptha']) {
      expect(server.toLowerCase(), needle).not.toContain(needle);
    }
    expect(server).toContain("path.join(process.cwd(), 'apps', '" + app + "', 'public', 'tesseract')");
    expect(server).toContain("cacheMethod: 'none'");
    expect(statSync(join(root, 'public', 'tesseract', 'eng.traineddata.gz')).size).toBeGreaterThan(0);
  });

  it('never logs the text it read', () => {
    expect(server).not.toMatch(/console\.\w+\([^)]*data\.text/);
    expect(server).not.toMatch(/console\.\w+\([^)]*, err\)/);
  });

  it('keeps tesseract external and traces all of it into the build', () => {
    const config = readFileSync(join(root, 'next.config.js'), 'utf8');
    expect(config).toContain("serverExternalPackages: ['tesseract.js', 'tesseract.js-core']");
    expect(config).toContain("'../../node_modules/tesseract.js-core/**'");
  });
});
