// A Discord gateway connection, held open for presence and, when the server
// log is switched on, for the guild events it records (server-log.ts).
//
// This bot answers interactions over HTTP -- Discord POSTs to us, we reply --
// which is a complete and supported way to build a bot, but it leaves no
// session behind. Discord decides the little dot next to a bot's name purely
// from whether it currently holds a gateway WebSocket, so an HTTP-only bot
// renders grey forever no matter how well it works. This module opens that
// socket, heartbeats it, and does nothing else with it.
//
// EVENT-FREE BY DEFAULT. With no `intents` passed we identify with 0, so
// Discord sends us no guild events at all. Publishing our own presence needs no intents --
// GUILD_PRESENCES is for RECEIVING other people's -- and asking for a
// privileged intent that is not ticked in the developer portal is what earns
// close code 4014 and a bot that never connects.
//
// That emptiness is what keeps this safe to run at any replica count. Every
// replica opens its own session and each publishes the same "online", which is
// idempotent. The moment someone handles an actual gateway EVENT here, that
// stops being true: every process holding a socket receives every event and
// would act on it once each. Anything event-driven needs a duplicate answer
// first (a single designated shard, or a Postgres advisory lock, or an
// idempotent write), not just a handler. The server log's answer is the
// idempotent write: every entry is posted with a nonce derived from the event
// and `enforce_nonce`, so the second replica's copy is dropped by Discord.
//
// And do NOT reach for proxy.unscalable as that answer. An earlier version of
// this comment said the service omits the label; it sets it
// (docker-compose.yml:223), but that changes nothing here, because the label
// governs INBOUND HTTP routing only. A gateway socket is outbound. The proxy
// cannot see it, cannot route it, and cannot stop a second process opening
// one. Every rolling replace runs two containers at once by design, so two
// live sockets is a normal state of this service, not an edge case.
//
// No dependency. Node 22+ exposes a WHATWG WebSocket as a global; the image
// runs Node 24. discord.js would drag in a tree of packages to hold one socket.

const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// Close codes Discord will never accept a retry for. Reconnecting on these
// spends the daily IDENTIFY budget on a request that cannot succeed, and a
// tight loop on 4004 is how a token gets rate limited. Log once and stay down;
// the HTTP half of the bot is unaffected either way.
const FATAL_CLOSE_CODES = new Map<number, string>([
  [4004, 'authentication failed -- DISCORD_BOT_TOKEN is wrong or was reset'],
  [4010, 'invalid shard'],
  [4011, 'sharding required'],
  [4012, 'invalid API version'],
  [4013, 'invalid intents'],
  [4014, 'disallowed intents -- a privileged intent is not enabled in the portal'],
]);

// Closing with 1000/1001 tells Discord to THROW AWAY the session, which makes
// the next connect a fresh IDENTIFY instead of a cheap RESUME. Any close we do
// intending to come back has to be in the 4000 range.
const RESUMABLE_CLOSE = 4000;

const MAX_BACKOFF_MS = 30_000;

export type GatewayState =
  | 'idle'
  | 'connecting'
  | 'identifying'
  | 'ready'
  | 'reconnecting'
  | 'stopped'
  | 'fatal';

// The subset of WebSocket this module touches. Named separately so tests can
// drive the state machine with a fake socket -- there is no other way to assert
// what we send in response to a HELLO or an INVALID_SESSION.
export interface GatewaySocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface StartGatewayOptions {
  token: string;
  /** Shown as "Watching <text>" in the member list. */
  presenceText?: string;
  createSocket?: (url: string) => GatewaySocket;
  /** Injectable so tests do not have to wait out a real backoff. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Injectable so a test can make backoff and heartbeat jitter deterministic. */
  random?: () => number;
  log?: (message: string) => void;
  /** The gateway intents bitmask. 0 (the default) asks for no events. */
  intents?: number;
  /**
   * Called for every dispatch other than READY and RESUMED. It must not throw
   * far: a throw is caught and logged, and the socket carries on.
   */
  onDispatch?: (type: string, data: unknown) => void;
}

export interface GatewayHandle {
  state(): GatewayState;
  /** Round trips since connect, for /health. */
  connectedSince(): number | null;
  stop(): void;
}

const OPEN = 1;

export function startGateway(options: StartGatewayOptions): GatewayHandle {
  const {
    token,
    presenceText = 'Club Ladder',
    createSocket = defaultCreateSocket,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    random = Math.random,
    log = (message: string) => console.log(message),
    onDispatch,
  } = options;
  // Mutable for one reason: a 4014 (privileged intent not ticked in the
  // portal) drops back to 0 rather than taking presence down with it.
  let intents = options.intents ?? 0;

  let state: GatewayState = 'idle';
  let socket: GatewaySocket | null = null;
  let heartbeatTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let heartbeatIntervalMs = 0;
  // Set when we send a heartbeat, cleared by the ACK. Still set when the next
  // beat comes due means the connection is a zombie: the socket is open, the
  // other end stopped answering, and nothing else would ever notice.
  let awaitingAck = false;
  let sequence: number | null = null;
  let sessionId: string | null = null;
  // READY hands back a URL dedicated to resuming this session. Resuming against
  // the generic gateway URL is the single most common way a "working" resume
  // silently degrades into a fresh identify.
  let resumeUrl: string | null = null;
  let attempts = 0;
  let connectedAt: number | null = null;
  let stopped = false;

  function clearHeartbeat() {
    if (heartbeatTimer !== null) {
      clearTimer(heartbeatTimer);
      heartbeatTimer = null;
    }
    awaitingAck = false;
  }

  function sendPayload(payload: unknown) {
    // Guarding on readyState is what stops a stray timer from throwing on a
    // socket that closed between the timer being set and it firing.
    if (!socket || socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      log(`[gateway] send failed: ${String(error)}`);
    }
  }

  function beat() {
    if (awaitingAck) {
      log('[gateway] heartbeat not acknowledged -- reconnecting');
      // 4000 rather than 1000: we want this session back.
      closeSocket(RESUMABLE_CLOSE);
      return;
    }
    awaitingAck = true;
    sendPayload({ op: OP.HEARTBEAT, d: sequence });
    heartbeatTimer = setTimer(beat, heartbeatIntervalMs);
  }

  function startHeartbeat(intervalMs: number) {
    clearHeartbeat();
    heartbeatIntervalMs = intervalMs;
    // Discord asks that the FIRST beat be offset by a random fraction of the
    // interval, so that a fleet restarting together does not beat in lockstep.
    heartbeatTimer = setTimer(beat, Math.floor(intervalMs * random()));
  }

  function closeSocket(code: number) {
    clearHeartbeat();
    const current = socket;
    socket = null;
    if (!current) return;
    // Detach first: a close we initiate still fires onclose, and letting it
    // through would schedule a second reconnect on top of the one we are about
    // to make.
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    try {
      current.close(code);
    } catch {
      // Already dead. Nothing to do and nothing worth logging.
    }
    if (!stopped) scheduleReconnect();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    state = 'reconnecting';
    connectedAt = null;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts);
    // Jitter so that every replica does not retry on the same tick.
    const delay = Math.floor(base * (0.5 + random() * 0.5));
    attempts += 1;
    log(`[gateway] reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts})`);
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function giveUp(reason: string) {
    state = 'fatal';
    stopped = true;
    connectedAt = null;
    clearHeartbeat();
    log(`[gateway] ${reason} -- not reconnecting. Interactions over HTTP are unaffected.`);
  }

  function identify() {
    state = 'identifying';
    sendPayload({
      op: OP.IDENTIFY,
      d: {
        token,
        intents,
        properties: { os: 'linux', browser: 'club-ladder-bot', device: 'club-ladder-bot' },
        presence: {
          since: null,
          activities: [{ name: presenceText, type: 3 }],
          status: 'online',
          afk: false,
        },
      },
    });
  }

  function resume() {
    state = 'identifying';
    sendPayload({
      op: OP.RESUME,
      d: { token, session_id: sessionId, seq: sequence },
    });
  }

  function forgetSession() {
    sessionId = null;
    resumeUrl = null;
    sequence = null;
  }

  function handleMessage(raw: unknown) {
    if (typeof raw !== 'string') return;
    let payload: { op?: unknown; d?: unknown; s?: unknown; t?: unknown };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return;
    }

    if (typeof payload.s === 'number') sequence = payload.s;

    switch (payload.op) {
      case OP.HELLO: {
        const interval = (payload.d as { heartbeat_interval?: number } | null)?.heartbeat_interval;
        startHeartbeat(typeof interval === 'number' && interval > 0 ? interval : 41_250);
        // A session we still hold is worth resuming: it replays the events we
        // missed and does not spend an IDENTIFY.
        if (sessionId && sequence !== null) resume();
        else identify();
        return;
      }

      case OP.HEARTBEAT:
        // Discord can ask for one out of band. Answer immediately and leave the
        // regular schedule alone.
        awaitingAck = true;
        sendPayload({ op: OP.HEARTBEAT, d: sequence });
        return;

      case OP.HEARTBEAT_ACK:
        awaitingAck = false;
        return;

      case OP.RECONNECT:
        log('[gateway] server asked us to reconnect');
        closeSocket(RESUMABLE_CLOSE);
        return;

      case OP.INVALID_SESSION: {
        // d is whether the session can still be resumed. False means start over.
        const resumable = payload.d === true;
        log(`[gateway] session invalidated (resumable: ${resumable})`);
        if (!resumable) forgetSession();
        closeSocket(RESUMABLE_CLOSE);
        return;
      }

      case OP.DISPATCH: {
        if (payload.t === 'READY') {
          const data = payload.d as { session_id?: string; resume_gateway_url?: string } | null;
          sessionId = data?.session_id ?? null;
          resumeUrl = data?.resume_gateway_url ?? null;
          state = 'ready';
          attempts = 0;
          connectedAt = Date.now();
          log('[gateway] connected -- presence is online');
        } else if (payload.t === 'RESUMED') {
          state = 'ready';
          attempts = 0;
          connectedAt = Date.now();
          log('[gateway] resumed');
        }
        // Every other dispatch goes to the handler, if there is one. With
        // intents 0 there should not be any beyond the lifecycle ones above.
        else if (onDispatch && typeof payload.t === 'string') {
          try {
            onDispatch(payload.t, payload.d);
          } catch (error) {
            log(`[gateway] ${payload.t} handler failed: ${String(error)}`);
          }
        }
        return;
      }

      default:
        return;
    }
  }

  function connect() {
    if (stopped) return;
    state = 'connecting';
    // The resume URL carries no query string of its own.
    const url = sessionId && resumeUrl ? `${resumeUrl}/?v=10&encoding=json` : DEFAULT_GATEWAY_URL;
    let next: GatewaySocket;
    try {
      next = createSocket(url);
    } catch (error) {
      log(`[gateway] could not open socket: ${String(error)}`);
      scheduleReconnect();
      return;
    }
    socket = next;

    next.onopen = () => {
      // Nothing to send yet -- HELLO arrives first and carries the interval.
    };
    next.onmessage = (event) => {
      try {
        handleMessage(event.data);
      } catch (error) {
        // A throw here would escape into the WebSocket's event handling and
        // could take the process down. The gateway is a nicety; the
        // interactions endpoint is the actual job.
        log(`[gateway] error handling frame: ${String(error)}`);
      }
    };
    next.onerror = (event) => {
      log(`[gateway] socket error: ${describeError(event)}`);
      // onclose follows; reconnect is handled there.
    };
    next.onclose = (event) => {
      clearHeartbeat();
      socket = null;
      connectedAt = null;
      // A privileged intent the portal has not granted. Presence needs no
      // intents, so come back with none: the server log goes quiet and says
      // why, and the bot stays online.
      if ((event.code === 4013 || event.code === 4014) && intents !== 0) {
        log(
          `[gateway] closed ${event.code}: ${FATAL_CLOSE_CODES.get(event.code)} -- ` +
            'reconnecting with no intents, so the server log is OFF until the portal is fixed'
        );
        intents = 0;
        forgetSession();
        if (!stopped) scheduleReconnect();
        return;
      }
      const fatal = FATAL_CLOSE_CODES.get(event.code);
      if (fatal) {
        giveUp(`closed ${event.code}: ${fatal}`);
        return;
      }
      // 4009 is specifically "your session timed out" -- it is retryable, but
      // the session behind it is gone, so resuming would just be refused.
      if (event.code === 4007 || event.code === 4009) forgetSession();
      log(`[gateway] closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`);
      if (!stopped) scheduleReconnect();
    };
  }

  connect();

  return {
    state: () => state,
    connectedSince: () => connectedAt,
    stop: () => {
      stopped = true;
      state = 'stopped';
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      clearHeartbeat();
      const current = socket;
      socket = null;
      connectedAt = null;
      if (current) {
        current.onopen = null;
        current.onmessage = null;
        current.onclose = null;
        current.onerror = null;
        // 1000 on a deliberate shutdown: we are not coming back for this
        // session, so let Discord drop it rather than hold it for a resume.
        try {
          current.close(1000);
        } catch {
          // Already closed.
        }
      }
    },
  };
}

function describeError(event: unknown): string {
  if (event && typeof event === 'object' && 'message' in event) {
    return String((event as { message: unknown }).message);
  }
  return String(event);
}

// The global WebSocket's handler properties are typed against DOM-ish event
// objects, which do not structurally match the narrow shape above. The cast is
// confined to this one function so the rest of the module stays checked.
function defaultCreateSocket(url: string): GatewaySocket {
  return new WebSocket(url) as unknown as GatewaySocket;
}
