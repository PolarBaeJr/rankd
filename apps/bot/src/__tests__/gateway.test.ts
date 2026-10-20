import { describe, expect, it } from 'vitest';
import { startGateway, type GatewaySocket, type StartGatewayOptions } from '../gateway.js';

// The gateway is a protocol state machine with no return value -- what it does
// is SEND things at the right moment. Nothing about it is observable without
// driving it frame by frame, so the socket and the clock are both injected and
// every assertion here is about what went out on the wire.

class FakeSocket implements GatewaySocket {
  readyState = 1;
  sent: string[] = [];
  closedWith: number[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000) {
    this.closedWith.push(code);
    this.readyState = 3;
  }

  /** Deliver a gateway frame as Discord would. */
  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  fireClose(code: number, reason = '') {
    this.onclose?.({ code, reason });
  }

  payloads(): Array<{ op: number; d?: unknown }> {
    return this.sent.map((raw) => JSON.parse(raw) as { op: number; d?: unknown });
  }

  ops(): number[] {
    return this.payloads().map((p) => p.op);
  }
}

function harness(extra: Partial<StartGatewayOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  let nextId = 0;
  const pending = new Map<number, () => void>();

  const handle = startGateway({
    token: 'test-token',
    createSocket: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimer: (fn) => {
      const id = ++nextId;
      pending.set(id, fn);
      return id;
    },
    clearTimer: (h) => {
      pending.delete(h as number);
    },
    // Removes jitter so backoff and the first-heartbeat offset are assertable.
    random: () => 0.5,
    log: () => {},
    ...extra,
  });

  return {
    handle,
    sockets,
    urls,
    socket: () => sockets[sockets.length - 1] as FakeSocket,
    pendingCount: () => pending.size,
    /** Fire the earliest outstanding timer (heartbeat or reconnect). */
    tick() {
      const entry = [...pending.entries()][0];
      if (!entry) throw new Error('no timer pending');
      pending.delete(entry[0]);
      entry[1]();
    },
  };
}

const HELLO = { op: 10, d: { heartbeat_interval: 1000 } };
const READY = {
  op: 0,
  s: 1,
  t: 'READY',
  d: { session_id: 'sess-1', resume_gateway_url: 'wss://resume.example' },
};

describe('startGateway', () => {
  it('identifies on HELLO with no intents and an online presence', () => {
    const h = harness();
    h.socket().receive(HELLO);

    const identify = h.socket().payloads().find((p) => p.op === 2);
    expect(identify).toBeDefined();
    const d = identify?.d as {
      token: string;
      intents: number;
      presence: { status: string; activities: Array<{ name: string; type: number }> };
    };
    expect(d.token).toBe('test-token');
    // Zero is load-bearing: any privileged intent not ticked in the portal
    // closes the socket with 4014 and the bot never comes online at all.
    expect(d.intents).toBe(0);
    expect(d.presence.status).toBe('online');
    expect(d.presence.activities[0]?.type).toBe(3);
  });

  it('heartbeats with the current sequence and reports ready after READY', () => {
    const h = harness();
    h.socket().receive(HELLO);
    h.socket().receive(READY);
    expect(h.handle.state()).toBe('ready');
    expect(h.handle.connectedSince()).not.toBeNull();

    h.tick(); // first heartbeat
    const beat = h.socket().payloads().find((p) => p.op === 1);
    expect(beat?.d).toBe(1);
  });

  it('reconnects when a heartbeat goes unacknowledged', () => {
    const h = harness();
    h.socket().receive(HELLO);
    h.socket().receive(READY);

    h.tick(); // beat 1 -- no ACK comes back
    h.tick(); // beat 2 finds awaitingAck still set

    // 4000, not 1000: a 1000 tells Discord to discard the session, which would
    // turn the resume below into a fresh identify.
    expect(h.socket().closedWith).toEqual([4000]);
  });

  it('an ACK clears the zombie flag so the next beat goes out normally', () => {
    const h = harness();
    h.socket().receive(HELLO);
    h.socket().receive(READY);

    h.tick();
    h.socket().receive({ op: 11 });
    h.tick();

    expect(h.socket().closedWith).toEqual([]);
    expect(h.socket().ops().filter((op) => op === 1)).toHaveLength(2);
  });

  it('resumes against resume_gateway_url rather than re-identifying', () => {
    const h = harness();
    h.socket().receive(HELLO);
    h.socket().receive(READY);
    h.socket().fireClose(1006);

    h.tick(); // reconnect backoff
    expect(h.sockets).toHaveLength(2);
    expect(h.urls[1]).toContain('resume.example');

    h.socket().receive(HELLO);
    const ops = h.socket().ops();
    expect(ops).toContain(6); // RESUME
    expect(ops).not.toContain(2); // not a fresh IDENTIFY
    const resume = h.socket().payloads().find((p) => p.op === 6);
    expect((resume?.d as { session_id: string }).session_id).toBe('sess-1');
  });

  it('re-identifies from scratch when the session is invalidated unresumably', () => {
    const h = harness();
    h.socket().receive(HELLO);
    h.socket().receive(READY);
    h.socket().receive({ op: 9, d: false });

    h.tick();
    expect(h.urls[1]).toContain('gateway.discord.gg');
    h.socket().receive(HELLO);
    expect(h.socket().ops()).toContain(2);
  });

  it('reconnects on an op 7 RECONNECT', () => {
    const h = harness();
    h.socket().receive(HELLO);
    h.socket().receive(READY);
    h.socket().receive({ op: 7 });

    expect(h.socket().closedWith).toEqual([4000]);
    h.tick();
    expect(h.sockets).toHaveLength(2);
  });

  it('answers an out-of-band heartbeat request immediately', () => {
    const h = harness();
    h.socket().receive(HELLO);
    h.socket().receive(READY);
    h.socket().receive({ op: 1 });

    expect(h.socket().ops()).toContain(1);
  });

  it('stops permanently on a fatal close code and schedules nothing', () => {
    const h = harness();
    h.socket().receive(HELLO);
    h.socket().fireClose(4004);

    expect(h.handle.state()).toBe('fatal');
    // A retry loop on a bad token burns the daily IDENTIFY budget for nothing.
    expect(h.pendingCount()).toBe(0);
  });

  it('does not reconnect on 4014 disallowed intents', () => {
    const h = harness();
    h.socket().receive(HELLO);
    h.socket().fireClose(4014);

    expect(h.handle.state()).toBe('fatal');
    expect(h.pendingCount()).toBe(0);
  });

  it('backs off on an ordinary close instead of hammering', () => {
    const h = harness();
    h.socket().fireClose(1006);
    expect(h.handle.state()).toBe('reconnecting');
    expect(h.pendingCount()).toBe(1);
  });

  it('stop() closes cleanly and leaves no timers behind', () => {
    const h = harness();
    h.socket().receive(HELLO);
    h.socket().receive(READY);
    h.handle.stop();

    // 1000 here on purpose: we are not coming back, so Discord should drop the
    // session rather than hold it open for a resume that never arrives.
    expect(h.socket().closedWith).toEqual([1000]);
    expect(h.handle.state()).toBe('stopped');
    expect(h.pendingCount()).toBe(0);
  });

  it('does not reconnect after stop(), even if a close arrives late', () => {
    const h = harness();
    h.socket().receive(HELLO);
    h.socket().receive(READY);
    const socket = h.socket();
    h.handle.stop();
    socket.fireClose(1006);

    expect(h.sockets).toHaveLength(1);
    expect(h.pendingCount()).toBe(0);
  });

  it('survives a malformed frame', () => {
    const h = harness();
    h.socket().onmessage?.({ data: 'not json' });
    h.socket().onmessage?.({ data: 42 });
    expect(h.handle.state()).toBe('connecting');
  });

  describe('with the server log on', () => {
    it('identifies with the intents it was given', () => {
      const h = harness({ intents: (1 << 2) | (1 << 9) });
      h.socket().receive(HELLO);
      const identify = h.socket().payloads().find((p) => p.op === 2);
      expect((identify?.d as { intents: number }).intents).toBe((1 << 2) | (1 << 9));
    });

    it('hands every other dispatch to the handler, and survives one that throws', () => {
      const seen: string[] = [];
      const h = harness({
        intents: 1 << 9,
        onDispatch: (type) => {
          seen.push(type);
          if (type === 'MESSAGE_DELETE') throw new Error('boom');
        },
      });
      h.socket().receive(HELLO);
      h.socket().receive(READY);
      h.socket().receive({ op: 0, s: 2, t: 'MESSAGE_DELETE', d: { id: '1' } });
      h.socket().receive({ op: 0, s: 3, t: 'GUILD_MEMBER_ADD', d: {} });
      expect(seen).toEqual(['MESSAGE_DELETE', 'GUILD_MEMBER_ADD']);
      expect(h.handle.state()).toBe('ready');
    });

    it('drops to no intents on 4014 instead of going offline', () => {
      const h = harness({ intents: 1 << 15 });
      h.socket().receive(HELLO);
      h.socket().fireClose(4014);
      expect(h.handle.state()).toBe('reconnecting');
      h.tick();
      h.socket().receive(HELLO);
      const identify = h.socket().payloads().find((p) => p.op === 2);
      expect((identify?.d as { intents: number }).intents).toBe(0);
    });
  });
});
