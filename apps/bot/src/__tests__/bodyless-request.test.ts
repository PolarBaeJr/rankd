import { describe, it, expect, vi } from 'vitest';
import { DiscordApi } from '../discord-api.js';

// Discord rejects a request that claims a JSON body and sends none (400, code
// 50109 "The request body contains invalid JSON"). Every unban failed that way
// on 2026-10-27, because the header went on every call.

function capture() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
  return { api: new DiscordApi({ token: 't', fetchImpl, sleep: async () => {} }), calls };
}

function contentType(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string>)['content-type'];
}

describe('requests without a body', () => {
  it('an unban sends no body and no JSON content-type', async () => {
    const { api, calls } = capture();
    expect(await api.unbanMember('g1', 'u1', 'appeal accepted')).toBe('ok');
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(contentType(calls[0]!.init)).toBeUndefined();
  });

  it('a ban, which has a body, still declares JSON', async () => {
    const { api, calls } = capture();
    await api.banMember('g1', 'u1', 0, 'spam');
    expect(contentType(calls[0]!.init)).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ delete_message_seconds: 0 });
  });
});
