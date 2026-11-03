// A PDF RECEIPT, TURNED INTO PAGES TO READ, IN THE EXEC'S BROWSER (00313).
//
// tesseract reads images, and a printing shop emails its receipt as a PDF. So
// each page is drawn onto a canvas with pdf.js and handed to the same reader as
// a photo. Nothing leaves the tab: the file is the exec's own pick, and the
// pdf.js worker is SELF-HOSTED under the console's /pdfjs/ (copied from
// pdfjs-dist's build/pdf.worker.min.mjs, the pinned version in package.json),
// through withBase as /tesseract/ is. pdf.js itself is imported only when a PDF
// is read, so it adds nothing to the page's own bundle.
//
// Never throws: a broken or password-protected PDF answers null, and the exec
// types the details.

import { withBase } from '@/lib/base-path';

/** About this many pixels on a page's long side: enough for till-slip print. */
export const PDF_TARGET_LONG_SIDE_PX = 2000;
/** At most this many pages are read, across every file of one receipt. */
export const MAX_RECEIPT_PAGES = 20;

/** The pdf.js scale that puts a page's long side at about `target` pixels. */
export function pdfPageScale(width: number, height: number, target = PDF_TARGET_LONG_SIDE_PX): number {
  const longSide = Math.max(width, height);
  if (!Number.isFinite(longSide) || longSide <= 0) return 1;
  return target / longSide;
}

/** How many of a PDF's pages to read, given how many pages are already used. */
export function pagesToRead(pageCount: number, alreadyRead: number, cap = MAX_RECEIPT_PAGES): number {
  return Math.max(0, Math.min(pageCount, cap - alreadyRead));
}

/**
 * Each page as a PNG, in order, stopping at MAX_RECEIPT_PAGES counting the
 * `alreadyRead` pages of the receipt's earlier files; null when the PDF cannot
 * be opened.
 */
export async function renderPdfPages(file: Blob, alreadyRead: number): Promise<Blob[] | null> {
  let task: { destroy(): Promise<void> } | null = null;
  try {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = withBase('/pdfjs/pdf.worker.min.mjs');
    const loading = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    task = loading;
    const doc = await loading.promise;
    const pages: Blob[] = [];
    const count = pagesToRead(doc.numPages, alreadyRead);
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pdfPageScale(base.width, base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      // White first: a PDF page with no background would read as black text
      // on a transparent (black once flattened) page.
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      page.cleanup();
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (png) pages.push(png);
    }
    return pages;
  } catch (err) {
    // The name only: a PasswordException or InvalidPDFException, never the file.
    console.warn('[fees] could not read a PDF receipt:', err instanceof Error ? err.name : typeof err);
    return null;
  } finally {
    // Ends the worker too, so a PDF read leaves nothing running in the tab.
    task?.destroy().catch(() => undefined);
  }
}
