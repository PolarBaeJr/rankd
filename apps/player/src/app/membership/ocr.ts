// READING THE RECEIPT SCREENSHOT, IN THE BROWSER.
//
// Loaded only when a member picks a screenshot (a dynamic import from
// etransfer-form.tsx), so nobody else downloads any of it.
//
// EVERYTHING IS SELF-HOSTED under /tesseract/, committed to the repo and
// pinned: the worker from tesseract.js 7.0.0, the three LSTM-only cores from
// tesseract.js-core 7.0.0 (the worker picks relaxed-SIMD, SIMD or plain by what
// the browser supports), and the English "fast" model from tessdata_fast 4.1.0,
// gzipped. Left at their defaults these paths point at a public CDN, which
// would send the member's browser to a third party; a test pins that no URL
// appears in this file.
//
// One read answers two things: the reference, and whether the screenshot is an
// e-transfer confirmation or an SFU Rec receipt (receipt-method.ts in shared).
// An SFU Rec order number ("O-600857") is preferred over the other ids on the
// same receipt. The server reads the screenshot again on its own (00297).
//
// It never throws: a failure, or a read that takes too long, answers nulls and
// the member types the reference themselves. The worker is terminated either
// way, since it holds the model in memory.

import {
  extractEtransferReference,
  extractSfuRecOrder,
  type ExtractedReference,
} from '@badminton/shared/src/utils/etransfer-reference';
import { classifyReceiptText, type ReceiptMethod } from '@badminton/shared/src/utils/receipt-method';

const OCR_TIMEOUT_MS = 30_000;

export type ReceiptRead = { reference: ExtractedReference | null; method: ReceiptMethod | null };

const NOTHING: ReceiptRead = { reference: null, method: null };

export async function readReceipt(file: Blob): Promise<ReceiptRead> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { createWorker, OEM } = await import('tesseract.js');
    const work = (async () => {
      const worker = await createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: '/tesseract/worker.min.js',
        corePath: '/tesseract/',
        langPath: '/tesseract/',
        gzip: true,
        workerBlobURL: false,
      });
      try {
        if (timedOut) return NOTHING;
        const { data } = await worker.recognize(file);
        const method = classifyReceiptText(data.text);
        // An SFU Rec receipt carries an order, an invoice and a registration
        // number; the order is the one the club checks.
        const order = method === 'sfu_rec' || method === null ? extractSfuRecOrder(data.text) : null;
        return {
          reference: order ? { value: order, confidence: 'anchored' as const } : extractEtransferReference(data.text),
          method,
        };
      } finally {
        worker.terminate().catch(() => undefined);
      }
    })();
    // A late failure after the timeout has already answered is not an error.
    work.catch(() => undefined);
    const timeout = new Promise<ReceiptRead>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(NOTHING);
      }, OCR_TIMEOUT_MS);
    });
    return await Promise.race([work, timeout]);
  } catch (err) {
    console.warn('[membership] could not read the screenshot:', err);
    return NOTHING;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
