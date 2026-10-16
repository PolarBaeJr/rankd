import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canUploadReceipt } from '@/lib/fees';

// Which outstanding lines get the receipt form (00253). Dues can be bought on
// the Campus Rec website, so they get it with no e-transfer address set; nothing
// else does.

const line = (over: Partial<Parameters<typeof canUploadReceipt>[0]> = {}) => ({
  kind: 'season' as const,
  owedCents: 4000,
  waiting: false,
  etransferConfigured: true,
  ...over,
});

describe('canUploadReceipt', () => {
  it('offers the form on every priced, unsent line when an address is set', () => {
    for (const kind of ['season', 'tournament', 'event'] as const) {
      expect(canUploadReceipt(line({ kind })), kind).toBe(true);
    }
  });

  it('offers it for dues alone when no address is set', () => {
    expect(canUploadReceipt(line({ etransferConfigured: false }))).toBe(true);
    expect(canUploadReceipt(line({ kind: 'tournament', etransferConfigured: false }))).toBe(false);
    expect(canUploadReceipt(line({ kind: 'event', etransferConfigured: false }))).toBe(false);
  });

  it('never offers it for a reinstatement, an unpriced line, or one already waiting', () => {
    expect(canUploadReceipt(line({ kind: 'reinstatement' }))).toBe(false);
    expect(canUploadReceipt(line({ owedCents: null }))).toBe(false);
    expect(canUploadReceipt(line({ waiting: true }))).toBe(false);
  });
});

const APP = join(__dirname, '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(APP, 'src', ...parts), 'utf8');

describe('the receipt wiring', () => {
  it('stores the method on every insert', () => {
    // The insert lives in the core both doors (the Membership page and Discord
    // /receipt) file through.
    const core = read('lib', 'fee-submission-core.ts');
    const insert = core.slice(core.indexOf(".from('fee_submissions').insert("));
    expect(insert.slice(0, insert.indexOf('});'))).toContain('method: checked.method,');
  });

  it('files every receipt through the shared core, never a second insert', () => {
    const action = read('lib', 'actions', 'fee-submissions.ts');
    const discord = read('app', 'api', 'discord', 'receipts', 'route.ts');
    for (const source of [action, discord]) {
      expect(source).toContain('fileFeeSubmission(');
      expect(source).not.toContain(".from('fee_submissions')");
    }
  });

  it('gates the form on canUploadReceipt, not on the e-transfer address alone', () => {
    const section = read('app', 'membership', 'member-section.tsx');
    expect(section).not.toContain('etransferEmail && payable');
    expect(section).toContain('canUploadReceipt(');
  });
});
