// READING AN EXPENSE'S RECEIPT, IN THE EXEC'S BROWSER (00313).
//
// Every page of the receipt, one at a time and in order, through the same
// self-hosted tesseract the form receipts use (receipt-ocr.ts), then joined
// (an overlap between two photos counted once) and parsed into a pre-fill
// (parsePurchaseReceipt). Read here and not on the server: the server's own
// read retries on a missing fee amount, which every till slip lacks, and the
// Pi would read each photo three times for nothing.
//
// THE TEXT NEVER LEAVES THIS FUNCTION. It is not sent to the server, stored,
// logged or put in React state; only the parsed readout is returned, and the
// exec checks every field of it before anything is saved.
//
// A JPEG, PNG or WebP is read straight from the picked File. A HEIC is read
// from the File where the browser can decode it (Safari) and otherwise from
// the converted JPEG the pending route answers. A PDF is drawn page by page
// (pdf-pages.ts). At most MAX_RECEIPT_PAGES pages are read across all files.
// Loaded only when an exec reads a receipt (a dynamic import in
// finance-actions.tsx).

import { joinReceiptPages, parsePurchaseReceipt, type PurchaseReadout } from '@badminton/shared';
import { withBase } from '@/lib/base-path';
import { recognizeText } from './receipt-ocr';
import { MAX_RECEIPT_PAGES, renderPdfPages } from './pdf-pages';

export interface ReceiptPage {
  /** The picked file; null for one already stored on the row. */
  file: Blob | null;
  /** The storage path, in the uploader's own folder. */
  path: string;
  type: string;
}

export interface ExpenseReceiptRead {
  readout: PurchaseReadout | null;
  /** A PDF among the pages could not be opened (broken, or password-protected). */
  pdfFailed: boolean;
}

async function pendingCopy(path: string): Promise<Blob | null> {
  try {
    const response = await fetch(withBase(`/fees/expense-receipt/pending?path=${encodeURIComponent(path)}`), {
      cache: 'no-store',
    });
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

async function browserCanDecode(file: Blob): Promise<boolean> {
  try {
    (await createImageBitmap(file)).close();
    return true;
  } catch {
    return false;
  }
}

export async function readExpenseReceipt(pages: readonly ReceiptPage[]): Promise<ExpenseReceiptRead> {
  const texts: string[] = [];
  let used = 0;
  let pdfFailed = false;
  let read = false;

  for (const page of pages) {
    if (used >= MAX_RECEIPT_PAGES) break;
    if (page.type === 'application/pdf') {
      // A stored PDF has no local File, and the pending route answers images
      // only, so only a PDF picked in this dialog is read.
      if (!page.file) continue;
      const images = await renderPdfPages(page.file, used);
      if (!images) {
        pdfFailed = true;
        continue;
      }
      for (const image of images) {
        used++;
        const text = await recognizeText(image);
        if (text !== null) {
          texts.push(text);
          read = true;
        }
      }
      continue;
    }

    let image: Blob | null = page.file;
    if (page.type === 'image/heic' || page.type === 'image/heif') {
      image = page.file && (await browserCanDecode(page.file)) ? page.file : await pendingCopy(page.path);
    } else if (!image) {
      image = await pendingCopy(page.path);
    }
    used++;
    const text = image ? await recognizeText(image) : null;
    if (text !== null) {
      texts.push(text);
      read = true;
    }
  }

  return { readout: read ? parsePurchaseReceipt(joinReceiptPages(texts)) : null, pdfFailed };
}
