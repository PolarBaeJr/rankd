// READING A FORM RECEIPT'S SCREENSHOT, IN THE EXEC'S BROWSER (00288).
//
// A receipt a Google Form collected arrives with no reference: the person
// uploaded a screenshot and typed nothing. This reads one off it, the way the
// member's own upload is read (apps/player/src/app/membership/ocr.ts), so the
// exec checks a guess instead of typing it. Loaded only when an exec presses
// "Read screenshot" (a dynamic import from submission-actions.tsx).
//
// EVERYTHING IS SELF-HOSTED under the console's /tesseract/, the same pinned
// files the player app ships (worker and LSTM-only cores from tesseract.js
// 7.0.0, the English "fast" model from tessdata_fast 4.1.0, gzipped). The
// console is mounted under a base path, so each path goes through withBase:
// a bare /tesseract/ would load the player app's copy instead. Left at their
// defaults these point at a public CDN; a test pins that no URL appears here.
//
// Only the reference: the method of a form receipt is always e-transfer.
// Never throws: a failure, or a read that takes too long, answers null and the
// exec types the reference. The worker is terminated either way.

import { extractEtransferReference, type ExtractedReference } from '@badminton/shared/src/utils/etransfer-reference';
import { withBase } from '@/lib/base-path';

const OCR_TIMEOUT_MS = 30_000;

export async function readReceiptReference(file: Blob): Promise<ExtractedReference | null> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { createWorker, OEM } = await import('tesseract.js');
    const work = (async () => {
      const worker = await createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: withBase('/tesseract/worker.min.js'),
        corePath: withBase('/tesseract/'),
        langPath: withBase('/tesseract/'),
        gzip: true,
        workerBlobURL: false,
      });
      try {
        if (timedOut) return null;
        const { data } = await worker.recognize(file);
        return extractEtransferReference(data.text);
      } finally {
        worker.terminate().catch(() => undefined);
      }
    })();
    // A late failure after the timeout has already answered is not an error.
    work.catch(() => undefined);
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, OCR_TIMEOUT_MS);
    });
    return await Promise.race([work, timeout]);
  } catch (err) {
    console.warn('[fees] could not read the screenshot:', err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
