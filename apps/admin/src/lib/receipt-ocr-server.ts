import 'server-only';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { OcrRead, ReceiptOcr } from '@badminton/shared/src/utils/receipt-check';

// READING A RECEIPT'S SCREENSHOT ON THE SERVER (00297), for the automatic
// confirmation in @badminton/shared/src/utils/receipt-check.
//
// tesseract.js in Node: the worker is a worker_threads script and the core is
// tesseract.js-core's LSTM-only build, both from node_modules (next.config.js
// keeps them external and traces them into the standalone bundle). The model
// is the same gzipped English "fast" one the browser reads, off this app's own
// public/tesseract/ on disk: nothing is fetched from anywhere. cacheMethod
// 'none', or the worker would write the unzipped model into the working
// directory, which the container's user cannot write to.
//
// ONE READ AT A TIME, two waiting at most. A read holds the model in memory
// (100 to 200 MB) for a few seconds on the Pi, and a burst of uploads must not
// stack them up; a third waiting answers 'busy' and the receipt is left queued
// for the console's sweep.
//
// THE TEXT IS NEVER LOGGED, here or by a caller: it carries a member's name
// and student ID. A failure is logged by its kind only.

const OCR_TIMEOUT_MS = 30_000;
const MAX_WAITING = 2;

function langPath(): string {
  const candidates = [
    path.join(process.cwd(), 'apps', 'admin', 'public', 'tesseract'),
    path.join(process.cwd(), 'public', 'tesseract'),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, 'eng.traineddata.gz'))) ?? candidates[1]!;
}

// Any amount with cents, with or without a "$".
const MONEY_SEEN = /\d\.\d{2}\b/;
const SMALLER_SCALES = [0.5, 0.3];

async function readSmaller(
  worker: { recognize(image: Buffer): Promise<{ data: { text: string } }> },
  bytes: Uint8Array,
): Promise<string | null> {
  const { default: sharp } = await import('sharp');
  const width = (await sharp(Buffer.from(bytes)).metadata()).width;
  if (!width) return null;
  for (const scale of SMALLER_SCALES) {
    const smaller = await sharp(Buffer.from(bytes)).resize(Math.max(64, Math.round(width * scale))).png().toBuffer();
    const { data } = await worker.recognize(smaller);
    // Only the lines with the amount: the rest of a shrunken read is worse
    // than the full-size one, and a garbled second copy of the payee's
    // address would make the address look ambiguous.
    if (MONEY_SEEN.test(data.text)) return data.text.split('\n').filter((line) => MONEY_SEEN.test(line)).join('\n');
  }
  return null;
}

let busy = false;
const waiting: (() => void)[] = [];

async function withSlot<T>(work: () => Promise<T>): Promise<T | 'busy'> {
  if (busy) {
    if (waiting.length >= MAX_WAITING) return 'busy';
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  busy = true;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else busy = false;
  }
}

async function read(bytes: Uint8Array): Promise<OcrRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let worker: { terminate(): Promise<unknown> } | null = null;
  // Terminated on the timeout too, so a stuck read never outlives its slot.
  const stop = () => {
    worker?.terminate().catch(() => undefined);
    worker = null;
  };
  try {
    const { createWorker, OEM } = await import('tesseract.js');
    const work = (async (): Promise<OcrRead> => {
      const created = await createWorker('eng', OEM.LSTM_ONLY, {
        langPath: langPath(),
        gzip: true,
        cacheMethod: 'none',
      });
      if (timedOut) {
        created.terminate().catch(() => undefined);
        return { error: 'timeout' };
      }
      worker = created;
      const { data } = await created.recognize(Buffer.from(bytes));
      if (MONEY_SEEN.test(data.text)) return { text: data.text };
      // A banking app's big centred amount ("5.00") is skipped at full size
      // and read once the glyphs are smaller, so a read with no money in it
      // tries shrunken copies and adds the first that finds one.
      const extra = await readSmaller(created, bytes);
      return { text: extra ? `${data.text}\n${extra}` : data.text };
    })();
    // A late failure after the timeout has already answered is not an error.
    work.catch(() => undefined);
    const timeout = new Promise<OcrRead>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve({ error: 'timeout' });
      }, OCR_TIMEOUT_MS);
    });
    return await Promise.race([work, timeout]);
  } catch (err) {
    console.error('[receipts] the server could not read a screenshot:', err instanceof Error ? err.name : typeof err);
    return { error: 'failed' };
  } finally {
    if (timer) clearTimeout(timer);
    stop();
  }
}

export const serverReceiptOcr: ReceiptOcr = { withSlot, read };
