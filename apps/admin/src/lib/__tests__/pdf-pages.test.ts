import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_RECEIPT_PAGES, pagesToRead, pdfPageScale } from '../../app/fees/pdf-pages';

// The arithmetic behind turning a PDF receipt into pages to read (00313). The
// rendering itself needs a browser and is not run here.

describe('pdfPageScale', () => {
  it('puts the long side at about 2000 pixels, portrait or landscape', () => {
    // A US Letter page is 612 x 792 points at scale 1.
    expect(Math.round(792 * pdfPageScale(612, 792))).toBe(2000);
    expect(Math.round(792 * pdfPageScale(792, 612))).toBe(2000);
    // A till slip 227 points wide and 1400 tall.
    expect(Math.round(1400 * pdfPageScale(227, 1400))).toBe(2000);
  });

  it('answers 1 for a page with no size', () => {
    expect(pdfPageScale(0, 0)).toBe(1);
    expect(pdfPageScale(Number.NaN, 10)).toBe(1);
  });
});

describe('pagesToRead', () => {
  it('reads every page while the receipt is under the cap', () => {
    expect(pagesToRead(3, 0)).toBe(3);
    expect(pagesToRead(3, 2)).toBe(3);
  });

  it('stops at 20 pages across every file of one receipt', () => {
    expect(MAX_RECEIPT_PAGES).toBe(20);
    expect(pagesToRead(50, 0)).toBe(20);
    expect(pagesToRead(5, 18)).toBe(2);
    expect(pagesToRead(5, 20)).toBe(0);
    expect(pagesToRead(5, 25)).toBe(0);
  });
});

// The worker is SELF-HOSTED, as tesseract is (receipt-ocr-self-hosted.test.ts):
// a copy of the installed pdfjs-dist's own, so a version bump that forgets to
// copy it again fails here rather than as a worker/library mismatch in a tab.
describe('the pdf.js worker is self-hosted', () => {
  const APP = join(__dirname, '..', '..', '..');

  it('ships the installed version of the worker', () => {
    const shipped = readFileSync(join(APP, 'public', 'pdfjs', 'pdf.worker.min.mjs'));
    const installed = readFileSync(require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'));
    expect(shipped.equals(installed)).toBe(true);
  });

  it('names no remote host and serves /pdfjs/ past the session check', () => {
    const source = readFileSync(join(APP, 'src', 'app', 'fees', 'pdf-pages.ts'), 'utf8');
    for (const needle of ['jsdelivr', 'unpkg', 'cdnjs', 'http:', 'https:']) {
      expect(source.toLowerCase(), needle).not.toContain(needle);
    }
    expect(source).toContain("withBase('/pdfjs/pdf.worker.min.mjs')");
    const middleware = readFileSync(join(APP, 'src', 'middleware.ts'), 'utf8');
    expect(middleware).toMatch(/matcher:[\s\S]*\|pdfjs\//);
  });
});
