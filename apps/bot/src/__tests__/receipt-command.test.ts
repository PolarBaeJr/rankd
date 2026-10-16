import { describe, it, expect, vi, beforeEach } from 'vitest';

// /receipt sends a fee receipt AS THE CALLER. The caller is read off the
// interaction and never from an option; the app is handed the attachment's url
// and never its bytes or filename; an unlinked caller is told to link and
// nothing else; and every reply is ephemeral and repeats no amount, reference
// or picture.

const { submitReceipt, fetchOwnFees } = vi.hoisted(() => ({
  submitReceipt: vi.fn(),
  fetchOwnFees: vi.fn(),
}));

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  submitReceipt,
  fetchOwnFees,
}));

import { RateLimitedError } from '../api.js';
import {
  COMMAND_DEFINITIONS,
  DEFERRED_COMMANDS,
  LINKED_ACCOUNT_PICKERS,
  OPEN_CHALLENGE_PICKERS,
  OWN_FEE_PICKERS,
  dispatch,
  handleReceiptAutocomplete,
  type InteractionContext,
  type ResolvedAttachment,
} from '../commands.js';

const CALLER = '111111111111111111';
const FEE = 'fee:00000000-0000-4000-8000-0000000000f1';
const ATTACHMENT_ID = '999999999999999999';
const CDN = 'https://cdn.discordapp.com/attachments/1/2/receipt.png?ex=1';

type Reply = {
  type: number;
  data: {
    content?: string;
    flags?: number;
    allowed_mentions?: unknown;
    choices?: { name: string; value: string }[];
  };
};

function context(file: ResolvedAttachment | null = { url: CDN, filename: 'x.png', content_type: 'image/png', size: 1000 }): InteractionContext {
  return {
    discordUserId: CALLER,
    guildId: 'g1',
    attachments: file ? { [ATTACHMENT_ID]: file } : null,
  };
}

function receipt(
  options: { name: string; value: string | number | boolean }[] = [
    { name: 'fee', value: FEE },
    { name: 'screenshot', value: ATTACHMENT_ID },
    { name: 'reference', value: 'CAabc123' },
  ],
  ctx: InteractionContext = context()
): Promise<Reply> {
  return dispatch('receipt', options, ctx) as unknown as Promise<Reply>;
}

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  submitReceipt.mockResolvedValue({ ok: true });
  fetchOwnFees.mockResolvedValue([]);
  // Anything that reached for the network directly (a channel post, a DM, a
  // download of the attachment in the bot) would land here.
  vi.stubGlobal('fetch', fetchSpy);
});

describe('the definition', () => {
  const definition = COMMAND_DEFINITIONS.find((command) => command.name === 'receipt') as unknown as {
    options: { name: string; type: number; required?: boolean; autocomplete?: boolean; min_length?: number; max_length?: number }[];
    default_member_permissions?: string;
  };

  it('is one command with a fee picker, a screenshot and a reference, all required', () => {
    expect(definition.options.map((o) => [o.name, o.type, o.required])).toEqual([
      ['fee', 3, true],
      ['screenshot', 11, true],
      ['reference', 3, true],
    ]);
    expect(definition.options[0]?.autocomplete).toBe(true);
    expect(definition.options[2]).toMatchObject({ min_length: 4, max_length: 32 });
  });

  it('is open to every member: the app decides who they are', () => {
    expect(definition.default_member_permissions).toBeUndefined();
  });

  it('is deferred, and its picker is the own-fee one', () => {
    expect(DEFERRED_COMMANDS.has('receipt')).toBe(true);
    expect(OWN_FEE_PICKERS.has('receipt')).toBe(true);
    expect(OPEN_CHALLENGE_PICKERS.has('receipt')).toBe(false);
    expect(LINKED_ACCOUNT_PICKERS.has('receipt')).toBe(false);
  });
});

describe('/receipt', () => {
  it('sends the caller, the fee, the reference and the attachment url, and nothing else', async () => {
    const reply = await receipt();
    expect(submitReceipt).toHaveBeenCalledWith({
      discordUserId: CALLER,
      fee: FEE,
      reference: 'CAabc123',
      attachmentUrl: CDN,
    });
    expect(reply.data.flags).toBe(64);
    expect(reply.data.content).toContain('Receipt sent');
    // No amount, no reference, no picture in the reply.
    expect(reply.data.content).not.toContain('CAabc123');
    expect(reply.data.content).not.toMatch(/\$/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tells an unlinked caller how to link, and nothing else', async () => {
    submitReceipt.mockResolvedValue({ ok: false, refusal: 'not_linked' });
    const reply = await receipt();
    expect(reply.data.flags).toBe(64);
    expect(reply.data.content).toContain('/link');
    expect(reply.data.content).toContain('club website');
  });

  it('refuses before calling the app when there is no attachment, or the wrong kind', async () => {
    expect((await receipt(undefined, context(null))).data.content).toMatch(/Attach a screenshot/);
    expect(
      (await receipt(undefined, context({ url: CDN, content_type: 'application/pdf', size: 10 }))).data.content
    ).toMatch(/not a JPEG, PNG or WebP/);
    expect(
      (await receipt(undefined, context({ url: CDN, content_type: 'image/png', size: 8 * 1024 * 1024 + 1 }))).data.content
    ).toMatch(/over 8 MB/);
    expect(submitReceipt).not.toHaveBeenCalled();
  });

  it('never reads the filename', async () => {
    await receipt(undefined, context({ url: CDN, filename: '../../etc/passwd.png', content_type: 'image/png', size: 10 }));
    expect(JSON.stringify(submitReceipt.mock.calls[0])).not.toContain('passwd');
  });

  it('refuses before calling the app when the fee or reference is missing', async () => {
    expect((await receipt([{ name: 'screenshot', value: ATTACHMENT_ID }, { name: 'reference', value: 'CAabc123' }])).data.content).toMatch(/Pick the fee/);
    expect((await receipt([{ name: 'fee', value: FEE }, { name: 'screenshot', value: ATTACHMENT_ID }])).data.content).toMatch(/reference/);
    expect(submitReceipt).not.toHaveBeenCalled();
  });

  it("passes the app's own sentence through for a rule, capped", async () => {
    submitReceipt.mockResolvedValue({ ok: false, refusal: 'rule', message: 'You already have a submission waiting for this fee.' });
    expect((await receipt()).data.content).toBe('You already have a submission waiting for this fee.');
    submitReceipt.mockResolvedValue({ ok: false, refusal: 'rule', message: 'x'.repeat(1000) });
    expect((await receipt()).data.content?.length).toBe(300);
  });

  it('names each file failure', async () => {
    submitReceipt.mockResolvedValue({ ok: false, refusal: 'file', file: 'too_large' });
    expect((await receipt()).data.content).toMatch(/over 8 MB/);
    submitReceipt.mockResolvedValue({ ok: false, refusal: 'file', file: 'not_image' });
    expect((await receipt()).data.content).toMatch(/not a JPEG/);
    submitReceipt.mockResolvedValue({ ok: false, refusal: 'file', file: 'unreachable' });
    expect((await receipt()).data.content).toMatch(/couldn't read that attachment/);
  });

  it('says it cannot tell, rather than that nothing happened, when the app does not answer', async () => {
    submitReceipt.mockRejectedValue(new Error('timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reply = await receipt();
    expect(reply.data.content).toMatch(/can't tell whether your receipt went through/);
    expect(reply.data.flags).toBe(64);
  });

  it('says so when the member has sent too many', async () => {
    submitReceipt.mockRejectedValue(new RateLimitedError('rate-limited'));
    expect((await receipt()).data.content).toMatch(/last hour/);
  });

  it('refuses a caller it cannot identify', async () => {
    const reply = (await dispatch(
      'receipt',
      [{ name: 'fee', value: FEE }],
      { discordUserId: null, guildId: 'g1' }
    )) as unknown as Reply;
    expect(reply.data.content).toMatch(/couldn't tell who ran that/);
    expect(submitReceipt).not.toHaveBeenCalled();
  });
});

describe('the /receipt picker', () => {
  it("lists the caller's own fees, filtered by what was typed", async () => {
    fetchOwnFees.mockResolvedValue([
      { id: 'dues:s1', label: 'Fall 2026 membership - $40.00' },
      { id: 'fee:e1', label: 'Bowling night - $15.00' },
    ]);
    const reply = (await handleReceiptAutocomplete([{ name: 'fee', value: 'bowl', focused: true }], {
      discordUserId: CALLER,
      guildId: 'g1',
    })) as unknown as Reply;
    expect(fetchOwnFees).toHaveBeenCalledWith(CALLER);
    expect(reply).toEqual({ type: 8, data: { choices: [{ name: 'Bowling night - $15.00', value: 'fee:e1' }] } });
  });

  it('answers an empty list, never an error, when the app fails or there is no caller', async () => {
    fetchOwnFees.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = (await handleReceiptAutocomplete([{ name: 'fee', value: '', focused: true }], {
      discordUserId: CALLER,
      guildId: 'g1',
    })) as unknown as Reply;
    expect(failed).toEqual({ type: 8, data: { choices: [] } });

    const anonymous = (await handleReceiptAutocomplete([{ name: 'fee', value: '', focused: true }], {
      discordUserId: null,
      guildId: 'g1',
    })) as unknown as Reply;
    expect(anonymous).toEqual({ type: 8, data: { choices: [] } });
  });
});
