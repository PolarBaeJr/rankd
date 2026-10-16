import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { clearRevocations, fetchLinkedMembers } from './api.js';
import { postAuditEntry } from './audit.js';
import { loadConfig } from './config.js';
import {
  DEFERRED_COMMANDS,
  LINKED_ACCOUNT_PICKERS,
  OPEN_CHALLENGE_PICKERS,
  OWN_FEE_PICKERS,
  dispatch,
  handleChallengeAutocomplete,
  handleReceiptAutocomplete,
  handleLinkedAccountAutocomplete,
  handleSignupInteraction,
  isSignupInteraction,
  handleProfileAutocomplete,
  handleAnnounceModal,
  handleReportModal,
  handleSayModal,
  isAnnounceModal,
  isSayModal,
  handleGuideButton,
  handleSelfRoleButton,
  handleSessionBoardButton,
  handleSessionBoardModal,
  handleSessionListModal,
  handleSessionPageButton,
  handleTournamentListModal,
  handleTournamentPageButton,
  isGuideButton,
  isReportModal,
  isSelfRoleButton,
  isSessionBoardButton,
  isSessionBoardModal,
  isSessionListModal,
  isSessionPageButton,
  isTournamentListModal,
  isTournamentPageButton,
  type BotResponse,
  type CommandOption,
  type ModalComponent,
  type ResolvedAttachment,
} from './commands.js';
import { DiscordApi, editDeferredReply } from './discord-api.js';
import { warmHandles } from './handles.js';
import { syncMembersNow } from './member-sync.js';
import { sendMultipart } from './multipart.js';
import { reconcile } from './reconcile.js';
import { registerCommandsOnBoot } from './register-commands.js';
import { runSessionPings } from './session-pings.js';
import { runTournamentEvents } from './tournament-events.js';
import { runClubEvents } from './club-events.js';
import { runAnnouncements } from './announcements.js';
import { runOutbox } from './outbox.js';
import { runSessionBoard } from './session-board.js';
import { runServerRoleSync } from './server-roles.js';
import { runMatchResults } from './match-results.js';
import { runFeedback } from './feedback.js';
import { startGateway, type GatewayHandle } from './gateway.js';
import { isAuthorizedService } from './service-auth.js';
import { verifyDiscordRequest } from './verify.js';

const PORT = Number(process.env.PORT ?? 3002);

// Discord will not POST a body larger than this, so anything bigger is not
// Discord. Cap it rather than buffering whatever arrives.
const MAX_BODY_BYTES = 256 * 1024;

// How long the autocomplete branch will wait on a cold handle cache before
// answering with nothing. Well under Discord's three seconds, because losing
// this race costs one keystroke's suggestions and missing the deadline costs
// the member an error.
const AUTOCOMPLETE_BUDGET_MS = 1_000;

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * /signup's buttons and modals: write the acknowledgement, then run the step
 * and write its answer over the message. Not awaited past the acknowledgement,
 * like the deferred commands. finish() catches its own failures; the catch
 * here is the second net.
 */
function answerSignup(
  res: ServerResponse,
  response: BotResponse,
  appId: string | undefined,
  interactionToken: string | undefined
) {
  const { finish, ...ack } = response;
  send(res, 200, ack);
  if (!finish) return;
  void (async () => {
    try {
      const final = await finish();
      if (!appId || !interactionToken) {
        console.error('[bot] signup step finished but had no interaction token');
        return;
      }
      await editDeferredReply(appId, interactionToken, final.data ?? {});
    } catch (error) {
      console.error('[bot] signup step failed:', error instanceof Error ? error.message : 'unknown');
      if (appId && interactionToken) {
        await editDeferredReply(appId, interactionToken, {
          content: 'Something went wrong. Run /signup again.',
          components: [],
          embeds: [],
        });
      }
    }
  })();
}

// The signature covers the RAW body, so it has to be kept as-received. Parsing
// and re-serialising reorders keys and drops whitespace, which invalidates every
// signature — a failure that looks like a wrong public key and is not.
function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// A sweep in flight, if there is one. Overlapping sweeps would race each
// other's role writes and double the rate-limit pressure for no benefit, and
// the scheduler firing again while the last one is still going is the ordinary
// way that happens.
//
// PER PROCESS, and that is the whole of what it guards. It is not a lock and
// must not be described as one. A real one belongs in Postgres, an advisory
// lock in the job that drives this, if it ever matters.
//
// The gap is narrower than it used to be but it has not closed. This service
// SETS proxy.unscalable (docker-compose.yml:223), reversing what an earlier
// version of this comment claimed, so the proxy normally has one process to
// route to and this flag does see every call. What it still cannot cover is a
// rolling replace, where two containers are up at once and each has its own
// copy of this variable set to false. Two concurrent sweeps remain possible
// there, which stays acceptable for the original reason: the sweep is
// convergent, so two of them reach the same end state.
let sweepInFlight = false;

async function runSweep(res: ServerResponse, trigger: 'scheduled' | 'manual') {
  if (sweepInFlight) return send(res, 409, { error: 'sweep_already_running' });
  sweepInFlight = true;
  try {
    // force: the sweep runs nightly and has no reason to act on a role map
    // cached a minute ago. Everything else is happy with the cached copy.
    const { registry, auditChannelId } = await loadConfig({ force: true });
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return send(res, 500, { error: 'DISCORD_BOT_TOKEN is not set' });

    const members = await fetchLinkedMembers();
    const api = new DiscordApi({ token });
    const summary = await reconcile(api, registry, members);

    // Bookkeeping, and it runs after the roles are already gone. A failure here
    // must not turn a successful sweep into a 500, so it is logged and dropped:
    // the tombstone simply survives to the next sweep, which finds nothing left
    // to strip and reports it clear again.
    try {
      await clearRevocations(summary.cleared);
    } catch (error) {
      console.error('[bot] could not clear revocations:', error);
    }

    // One entry per sweep, never one per member — see rule 3 in audit.ts. It is
    // awaited rather than fired off, so a sweep that has answered 200 has
    // already been written down; the alternative loses the last entry whenever
    // the container is replaced right after a sweep, which is exactly when a
    // deploy happens.
    await postAuditEntry(new DiscordApi({ token }), auditChannelId, {
      kind: 'sweep',
      summary,
      guilds: registry.size,
      trigger,
    });

    // The SUMMARY goes in the body, not just a 200. Whatever drives this is
    // likely pg_net, which follows redirects — so a 200 on its own proves
    // nothing about whether the sweep ran. The caller has to read the content.
    return send(res, 200, { ok: true, ...summary });
  } catch (error) {
    console.error('[bot] sweep failed:', error);
    return send(res, 500, { error: 'sweep_failed' });
  } finally {
    sweepInFlight = false;
  }
}

async function runMemberSync(req: IncomingMessage, res: ServerResponse) {
  let body: { discordUserIds?: unknown; reason?: unknown };
  try {
    body = JSON.parse(await readRawBody(req)) as { discordUserIds?: unknown; reason?: unknown };
  } catch {
    return send(res, 400, { error: 'bad_request' });
  }

  const ids = body.discordUserIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || ids.length === 0) {
    return send(res, 400, { error: 'invalid_body' });
  }

  // Cosmetic — it only picks the audit entry's title. Validated anyway rather
  // than interpolated, so a caller cannot write its own heading into the log.
  const reason: 'linked' | 'unlinked' | 'resynced' =
    body.reason === 'linked' || body.reason === 'unlinked' ? body.reason : 'resynced';

  try {
    // CHECKED HERE as well as inside syncMembersNow, which throws on the same
    // condition. This endpoint answers a missing token with its own 500 body
    // rather than the generic sync_failed, and that distinction is the whole
    // value of it: one names the thing an operator can fix.
    if (!process.env.DISCORD_BOT_TOKEN) {
      return send(res, 500, { error: 'DISCORD_BOT_TOKEN is not set' });
    }

    // The sync itself is shared with /forcelink; see member-sync.ts. The audit
    // entry deliberately is not, which is why it is still written here.
    const { summary, api, auditChannelId } = await syncMembersNow(ids as string[]);

    await postAuditEntry(api, auditChannelId, {
      kind: 'member',
      reason,
      discordUserIds: ids as string[],
      summary,
    });

    return send(res, 200, { ok: true, ...summary });
  } catch (error) {
    console.error('[bot] member sync failed:', error);
    return send(res, 500, { error: 'sync_failed' });
  }
}

// Held open only so Discord shows the bot online; see gateway.ts. Null when
// there is no token to connect with.
let gateway: GatewayHandle | null = null;

const server = createServer(async (req, res) => {
  // Health: a real GET, not a bare TCP accept. A reverse proxy without a health
  // path falls back to a TCP dial, and a dial cannot tell "process is up" from
  // "process cannot reach the app API", so this endpoint exists to give the
  // proxy something meaningful to ask.
  if (req.method === 'GET' && req.url === '/health') {
    // ok is deliberately not conditioned on the gateway. The proxy's health
    // check points here, so reporting a gateway blip as unhealthy would pull a perfectly
    // good interactions endpoint out of the pool -- the gateway only decides
    // whether Discord draws us green, and interactions do not travel over it.
    // Surface the state in the body so it is diagnosable without doing that.
    return send(res, 200, {
      ok: true,
      gateway: gateway ? gateway.state() : 'disabled',
      gatewayConnectedSince: gateway?.connectedSince() ?? null,
    });
  }

  // The reconciliation sweep, driven from outside rather than by a timer in
  // here: a setInterval would become one sweep PER PROCESS, all writing the
  // same roles. One HTTP request reaches exactly one process no matter how
  // many are running, which is why this shape is right even though
  // proxy.unscalable is set and there is usually only one. See reconcile.ts.
  if (req.method === 'POST' && req.url === '/sync') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    // The nightly pg_cron job posts {} and is the only scheduled driver, so an
    // explicit "manual" is how a human-triggered sweep says so. Defaulting the
    // other way would label every hand-run curl as the nightly job.
    let trigger: 'scheduled' | 'manual' = 'scheduled';
    try {
      const parsed = JSON.parse(await readRawBody(req)) as { trigger?: unknown };
      if (parsed?.trigger === 'manual') trigger = 'manual';
    } catch {
      // No body, or not JSON. Both mean the scheduled default.
    }
    return runSweep(res, trigger);
  }

  // ONE member, right now. The app calls this the moment a link is created or
  // moved, because the alternative is telling somebody their account is
  // connected and then showing them no roles until the next sweep — which,
  // until something drives POST /sync, may be never.
  // Session pings, driven by pg_cron on the same schedule as the app's own
  // reminder job. One HTTP request reaches exactly one replica, which is the
  // whole reason this is not a setInterval in here.
  if (req.method === 'POST' && req.url === '/session-pings') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    try {
      const result = await runSessionPings();
      return send(res, 200, result);
    } catch (error) {
      console.error('[bot] session pings failed:', error);
      return send(res, 500, { error: 'session_pings_failed' });
    }
  }

  // Discord scheduled events for tournaments AND club events, driven by
  // pg_cron every 15 minutes. Polled rather than pushed when an exec hits
  // Activate or Publish, so a bot that happens to be restarting at that moment
  // causes a delay instead of a lost announcement nobody would notice was lost.
  //
  // Club events ride this tick (00245) rather than getting a job of their own,
  // for the reason the outbox rides /announcements: a new job is SQL an owner
  // has to run on production. Two try/catch blocks, so neither pass can abort
  // the other. The tournament counters stay flat at the top level, as before.
  if (req.method === 'POST' && req.url === '/tournament-events') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    let tournaments: Awaited<ReturnType<typeof runTournamentEvents>> | null = null;
    let clubEvents: Awaited<ReturnType<typeof runClubEvents>> | null = null;

    try {
      tournaments = await runTournamentEvents();
    } catch (error) {
      console.error('[bot] tournament events failed:', error);
    }

    try {
      clubEvents = await runClubEvents();
    } catch (error) {
      console.error('[bot] club events failed:', error);
    }

    if (!tournaments && !clubEvents) {
      return send(res, 500, { error: 'tournament_events_failed' });
    }

    return send(res, 200, { ...(tournaments ?? {}), clubEvents });
  }

  // The announcement relay, driven by pg_cron every 5 minutes. Faster than the
  // tournament sweep because an announcement is the thing an exec publishes and
  // then watches for: "urgent, no session tonight" arriving a quarter of an
  // hour late is a different message from the one that was written.
  if (req.method === 'POST' && req.url === '/announcements') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    // FOUR JOBS, FOUR try/catch BLOCKS, ONE TICK.
    //
    // The console's outbox (00222) rides this tick rather than getting a
    // pg_cron job of its own, because a new job would need an owner to run SQL
    // on production — a step that sits undone while the feature looks shipped.
    // The session board rides it for the same reason, and because five minutes
    // is already the right interval for a schedule that changes when somebody
    // RSVPs. The role catalogue (00229) is the fourth, for the first reason
    // again: five minutes is also the staleness a picker can carry, since a role
    // renamed inside the window fails at send time with a refusal that says so.
    //
    // But they must not be able to abort each other. A relay that throws would
    // otherwise leave a queued message unsent with nothing saying why, and an
    // outbox failure would stop announcements syncing — neither has anything
    // to do with the other, and each reports its own counts. The catalogue makes
    // a Discord call per guild, so a 429 there is the likeliest of the four to
    // throw and the one that must certainly not cost somebody their message.
    let announcements: Awaited<ReturnType<typeof runAnnouncements>> | null = null;
    let outbox: Awaited<ReturnType<typeof runOutbox>> | null = null;
    let board: Awaited<ReturnType<typeof runSessionBoard>> | null = null;
    let serverRoles: Awaited<ReturnType<typeof runServerRoleSync>> | null = null;

    try {
      announcements = await runAnnouncements();
    } catch (error) {
      console.error('[bot] announcement relay failed:', error);
    }

    try {
      outbox = await runOutbox();
    } catch (error) {
      console.error('[bot] outbox drain failed:', error);
    }

    try {
      board = await runSessionBoard();
    } catch (error) {
      console.error('[bot] session board failed:', error);
    }

    try {
      serverRoles = await runServerRoleSync();
    } catch (error) {
      console.error('[bot] server role sync failed:', error);
    }

    // A 500 only when BOTH of the first two halves fell over, which is the shape
    // that means the tick achieved nothing. DELIBERATELY UNCHANGED by the board
    // and by the role catalogue: neither failing must turn a good announcement
    // tick into a 500, and the counters in the body are the only way this job is
    // diagnosed at all, because pg_net follows redirects and a 200 proves nothing.
    if (!announcements && !outbox) {
      return send(res, 500, { error: 'announcements_failed' });
    }

    return send(res, 200, { ...(announcements ?? {}), outbox, board, serverRoles });
  }

  // The match result relay, driven by pg_cron every 10 minutes. Slower than
  // announcements — nobody is waiting on a result the way they wait on "no
  // session tonight" — and faster than the tournament sweep, because results
  // land in bursts on a club night and a half-hour lag would make the channel
  // read as a digest rather than a feed.
  if (req.method === 'POST' && req.url === '/match-results') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    try {
      const result = await runMatchResults();
      return send(res, 200, result);
    } catch (error) {
      console.error('[bot] match result relay failed:', error);
      return send(res, 500, { error: 'match_results_failed' });
    }
  }

  // The feedback relay, driven by pg_cron every 10 minutes. An inbox rather
  // than a feed: nobody stands in the exec channel waiting on a bug report the
  // way they wait on "no session tonight".
  if (req.method === 'POST' && req.url === '/feedback') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    try {
      const result = await runFeedback();
      return send(res, 200, result);
    } catch (error) {
      console.error('[bot] feedback relay failed:', error);
      return send(res, 500, { error: 'feedback_failed' });
    }
  }

  if (req.method === 'POST' && req.url === '/sync-member') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    return runMemberSync(req, res);
  }

  if (req.method !== 'POST' || (req.url !== '/' && req.url !== '/interactions')) {
    return send(res, 404, { error: 'not_found' });
  }

  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    // Fail closed. Without the key nothing can be verified, and answering
    // anything other than 401 would make an unconfigured deploy look healthy.
    console.error('[bot] DISCORD_PUBLIC_KEY is not set — refusing all interactions');
    return send(res, 401, { error: 'unverified' });
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return send(res, 400, { error: 'bad_request' });
  }

  const verified = verifyDiscordRequest(
    publicKey,
    req.headers['x-signature-ed25519'] as string | undefined,
    req.headers['x-signature-timestamp'] as string | undefined,
    rawBody
  );

  // 401 on a bad signature is REQUIRED, not merely correct: Discord probes the
  // endpoint with a deliberately invalid signature during setup and rejects any
  // endpoint that answers 200.
  if (!verified) return send(res, 401, { error: 'invalid signature' });

  let interaction: {
    type: number;
    data?: {
      name: string;
      // Subcommands nest their arguments one level down, so the option shape
      // has to be recursive rather than flat.
      options?: CommandOption[];
      /** MESSAGE_COMPONENT and MODAL_SUBMIT: which button, or which modal. */
      custom_id?: string;
      /** MODAL_SUBMIT only: the filled-in text inputs, nested in action rows. */
      components?: ModalComponent[];
      /**
       * MESSAGE_COMPONENT only, and only for a select: what was chosen.
       *
       * The session board's location filter is the first select this bot has
       * ever emitted, and without this field the choice would be invisible: the
       * interaction would arrive, be routed by custom_id, and the handler would
       * have nothing to filter on. It fails closed to "no filter" when this is
       * absent or empty.
       *
       * NOTE what is still NOT declared here: `message`. The response type is
       * decided by the origin segment in the custom_id, deliberately, and
       * declaring the field would invite a future reader to read the ephemeral
       * flag off it instead.
       */
      values?: string[];
      /**
       * APPLICATION_COMMAND only: the objects behind id-valued options.
       *
       * An attachment option's value is a snowflake and nothing else — the url,
       * filename and size live here. /bug reads it for the screenshot.
       */
      resolved?: { attachments?: Record<string, ResolvedAttachment> };
    };
    // Guild context populates member.user; a DM populates user and omits
    // member entirely. /link and /unlink are precisely the commands somebody
    // runs in a DM, so both have to be read.
    // `roles` is the caller's current role ids, sent on every guild
    // interaction. The self-role toggle reads it instead of fetching the member
    // again, which keeps the whole round trip inside Discord's 3-second budget.
    // `permissions` is the CALLER'S permissions as Discord computed them for
    // this channel, a 64-bit mask sent as a string. Discarding it was harmless
    // while nothing checked it; handleSayModal now does.
    member?: { user?: { id?: string }; roles?: string[]; permissions?: string };
    user?: { id?: string };
    guild_id?: string;
    // Where it was typed. /say's `channel` option defaults to it.
    channel_id?: string;
    // Only sent for real interactions, not for the PING probe.
    application_id?: string;
    token?: string;
  };
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return send(res, 400, { error: 'bad_request' });
  }

  // PING/PONG. Discord sends this on save and periodically after.
  if (interaction.type === 1) return send(res, 200, { type: 1 });

  // APPLICATION_COMMAND
  if (interaction.type === 2 && interaction.data) {
    const context = {
      discordUserId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
      guildId: interaction.guild_id ?? null,
      // /say defaults to the channel it was typed in.
      channelId: interaction.channel_id ?? null,
      applicationId: interaction.application_id ?? null,
      interactionToken: interaction.token ?? null,
      attachments: interaction.data.resolved?.attachments ?? null,
    };

    // DEFERRED PATH. Discord gives an interaction 3 seconds to be acknowledged
    // or it tells the user the application did not respond -- and it means it,
    // whatever the bot does afterwards. /setup creates up to nine roles and
    // then writes to the app, so it cannot possibly answer inside that budget.
    //
    // So: acknowledge immediately with type 5 (a visible "thinking..."), let
    // the socket close, and PATCH the real answer in when the work is done.
    // The interaction token stays valid for 15 minutes, which is ample.
    if (DEFERRED_COMMANDS.has(interaction.data.name)) {
      const { name, options } = interaction.data;
      const { application_id: appId, token: interactionToken } = interaction;

      // flags 64 = ephemeral, and it has to be set HERE, on the deferral. A
      // deferred reply's visibility is fixed at acknowledgement time and cannot
      // be changed by the followup, so deferring non-ephemerally would publish
      // the role list to the whole channel.
      send(res, 200, { type: 5, data: { flags: 64 } });

      // Deliberately not awaited: the response is already sent.
      void (async () => {
        try {
          const response = await dispatch(name, options, context);
          if (!appId || !interactionToken) {
            // Nothing to edit. Only reachable if Discord sent a command
            // interaction without a token, which should not happen.
            console.error(`[bot] ${name} finished but had no interaction token`);
            return;
          }
          // dispatch returns a full interaction response; the webhook edit
          // wants only the message body.
          const payload = (response as { data?: unknown }).data ?? response;
          await editDeferredReply(appId, interactionToken, payload);
        } catch (error) {
          // dispatch catches its own errors, so reaching here means something
          // outside it failed. The user is still looking at "thinking...", so
          // say something rather than leaving it spinning forever.
          console.error(`[bot] deferred ${name} failed:`, error);
          if (appId && interactionToken) {
            await editDeferredReply(appId, interactionToken, {
              content: 'Something went wrong. Please try again.',
            });
          }
        }
      })();
      return;
    }

    const response = await dispatch(interaction.data.name, interaction.data.options, context);

    // ACKNOWLEDGED MID-COMMAND. The branch above defers before dispatch, which
    // is all /setup can do — it is slow from its first byte. /profile is not:
    // it decides in one fast call whether the answer is a card or an ephemeral
    // refusal, and only then does the slow work. So it dispatches normally and
    // hands back its own deferral, carrying the rest as `finish`.
    //
    // The acknowledgement is sent VERBATIM, flags included or absent, because
    // the handler chose the visibility knowing the answer — see handleProfile.
    if (response.type === 5 && response.finish) {
      const { finish, ...ack } = response;
      const { application_id: appId, token: interactionToken } = interaction;
      send(res, 200, ack);

      // Deliberately not awaited: the response is already sent.
      void (async () => {
        try {
          const final = await finish();
          if (!appId || !interactionToken) {
            console.error('[bot] deferred command finished but had no interaction token');
            return;
          }
          // The webhook edit takes a MESSAGE, not a callback, so the `data`
          // wrapper comes off — and the file travels beside it rather than in
          // it, for the same reason it does above.
          await editDeferredReply(appId, interactionToken, final.data ?? {}, fetch, final.file);
        } catch (error) {
          // finish() is written not to throw, so reaching here is a bug rather
          // than a slow render. The member is still watching a spinner.
          console.error(`[bot] deferred ${interaction.data?.name} failed:`, error);
          if (appId && interactionToken) {
            await editDeferredReply(appId, interactionToken, {
              content: 'Something went wrong. Please try again.',
            });
          }
        }
      })();
      return;
    }

    // Unreached today -- /profile was the only command that answered
    // immediately with a file, and it defers now. See the note in multipart.ts
    // before sending anything down here.
    if (response.file) {
      // The file is SPLIT OFF, never passed through. send() would
      // JSON.stringify it, and a serialised byte array is a payload Discord
      // accepts as a message with a colossal content field.
      const { file, ...payload } = response;
      return sendMultipart(res, 200, payload, file);
    }
    return send(res, 200, response);
  }

  // MODAL_SUBMIT — someone filled in the /bug or /feedback boxes and pressed
  // submit.
  //
  // A SEPARATE INTERACTION FROM THE COMMAND THAT OPENED THE MODAL, with its own
  // 3-second budget and no memory of the first one: Discord echoes back the
  // custom_id and the typed values, and nothing else. Whatever the command knew
  // has to have been encoded in that id or stashed against it.
  //
  // Without this branch a submitted modal falls through to the catch-all below
  // and is answered with type 1, which Discord renders to the member as "this
  // application did not respond" — the report typed and lost.
  if (interaction.type === 5 && interaction.data) {
    const customId = interaction.data.custom_id;

    // Same two places a command reads its caller from: a guild submit populates
    // member.user, a DM submit populates user.
    const modalContext = {
      discordUserId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
      guildId: interaction.guild_id ?? null,
      channelId: interaction.channel_id ?? null,
      // THE SUBMIT IS THE INTERACTION THAT POSTS, so it is the one that has to
      // be able to check who sent it. Discord recomputes this for the submit
      // rather than echoing what the command carried, which is what makes it
      // worth reading here and not only when the modal was opened. Absent on a
      // DM submit, where there is no member and so no permissions.
      permissions: interaction.member?.permissions ?? null,
    };

    if (isSignupInteraction(customId)) {
      return answerSignup(
        res,
        handleSignupInteraction(customId as string, interaction.data.components, modalContext),
        interaction.application_id,
        interaction.token
      );
    }

    if (isAnnounceModal(customId)) {
      try {
        const response = await handleAnnounceModal(
          customId as string,
          interaction.data.components,
          modalContext
        );
        return send(res, 200, response);
      } catch (error) {
        // THIS DOES NOT SAY "NOTHING WAS POSTED", AND THE RESTRAINT IS THE POINT.
        //
        // The obvious wording is the wrong one. api.ts aborts at 2500ms, inside
        // the modal submit's own 3-second deadline, and an abort fires against a
        // request the app may already have COMMITTED -- the row is inserted, the
        // answer is still in flight, and the fetch gives up. Telling the exec
        // nothing was posted is then false in the one direction that costs
        // something: they retype the announcement, and the club gets two of
        // them, in the channel, in front of everybody.
        //
        // A refusal the app made deliberately never reaches here; those come
        // back as a 200 with a code and are rendered as their own sentence. So
        // everything that lands in this branch is genuinely unknown, and the
        // reply says so and names the one place that settles it.
        console.error('[bot] announce modal failed:', error);
        return send(res, 200, {
          type: 4,
          data: {
            content:
              "Couldn't get an answer from the club app — I can't tell whether that went " +
              'through. Check the announcements page before you try again, in case it did. ' +
              'Your words are gone from this box, so copy them somewhere first.',
            flags: 64,
          },
        });
      }
    }

    if (isSayModal(customId)) {
      try {
        const response = await handleSayModal(
          customId as string,
          interaction.data.components,
          modalContext
        );
        return send(res, 200, response);
      } catch (error) {
        // Unlike the announce branch this one CAN say nothing was posted: the
        // handler talks to Discord and nothing else, it returns its own refusal
        // for a channel Discord would not take, and a throw from it is a bug
        // here rather than an answer lost in flight.
        console.error('[bot] say modal failed:', error);
        return send(res, 200, {
          type: 4,
          data: {
            content:
              'Something went wrong posting that, and nothing was sent. Your words are gone ' +
              'from this box, so copy them somewhere before you try again.',
            flags: 64,
          },
        });
      }
    }

    if (isReportModal(customId)) {
      try {
        const response = await handleReportModal(
          customId as string,
          interaction.data.components,
          modalContext
        );
        return send(res, 200, response);
      } catch (error) {
        console.error('[bot] report modal failed:', error);
        return send(res, 200, {
          type: 4,
          data: {
            content:
              "Couldn't reach the club app just now — nothing was filed. Try again in a moment.",
            flags: 64,
          },
        });
      }
    }

    // The paged lists' modals: "go to page" and "find". All three read, none of
    // them writes, so unlike the announce branch above they can say plainly that
    // nothing happened. Kept adjacent because sesmodal: and sesboardmodal: are
    // the pair a reader has to see together.
    if (
      isSessionListModal(customId) ||
      isSessionBoardModal(customId) ||
      isTournamentListModal(customId)
    ) {
      const fields = interaction.data.components;
      try {
        const response = isSessionListModal(customId)
          ? await handleSessionListModal(customId as string, fields, modalContext)
          : isSessionBoardModal(customId)
            ? await handleSessionBoardModal(customId as string, fields, modalContext)
            : await handleTournamentListModal(customId as string, fields, modalContext);
        return send(res, 200, response);
      } catch (error) {
        console.error('[bot] list modal failed:', error);
        return send(res, 200, {
          type: 4,
          data: {
            content: "Couldn't reach the club app just now. Try again in a moment.",
            flags: 64,
          },
        });
      }
    }

    // A modal this build does not know. type 4 rather than the components'
    // type 6, because a modal has no message to leave intact and a silent
    // acknowledgement would look like the submit vanished.
    return send(res, 200, {
      type: 4,
      data: { content: 'That form is from an older version — run the command again.', flags: 64 },
    });
  }

  // MESSAGE_COMPONENT — someone clicked a button.
  //
  // The picker's buttons live on a message that stays in the channel, so this
  // arrives long after the command that posted it, from anybody who can see the
  // channel. Everything needed to answer is on the interaction itself:
  // `member.roles` is the caller's CURRENT role list as Discord sees it, which
  // is what makes a toggle possible without a second API round-trip inside the
  // 3-second budget.
  if (interaction.type === 3 && interaction.data) {
    const customId = interaction.data.custom_id;

    // /signup. Every button but "Enter code" is acknowledged with type 6 and
    // the same ephemeral message is edited; see handleSignupInteraction.
    if (isSignupInteraction(customId)) {
      return answerSignup(
        res,
        handleSignupInteraction(customId as string, undefined, {
          discordUserId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
          guildId: interaction.guild_id ?? null,
        }),
        interaction.application_id,
        interaction.token
      );
    }

    if (isSelfRoleButton(customId)) {
      const context = {
        discordUserId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
        guildId: interaction.guild_id ?? null,
      };
      try {
        const response = await handleSelfRoleButton(
          customId as string,
          context,
          interaction.member?.roles ?? []
        );
        return send(res, 200, response);
      } catch (error) {
        console.error('[bot] self-role button failed:', error);
        return send(res, 200, {
          type: 4,
          data: { content: 'Something went wrong. Please try again.', flags: 64 },
        });
      }
    }

    // The guide message's buttons. The same two fields as above and no role
    // list, because nothing here toggles a role. Order against the self-role
    // block is a readability choice only: the two prefixes are disjoint.
    if (isGuideButton(customId)) {
      const context = {
        discordUserId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
        guildId: interaction.guild_id ?? null,
      };
      try {
        const response = await handleGuideButton(customId as string, context);
        return send(res, 200, response);
      } catch (error) {
        console.error('[bot] guide button failed:', error);
        return send(res, 200, {
          type: 4,
          data: { content: 'Something went wrong. Please try again.', flags: 64 },
        });
      }
    }

    // The paged lists. ses: and sesboard: are checked next to each other on
    // purpose: they are the pair whose disjointness carries the audience split,
    // and they diverge at index 3 (`:` against `b`).
    //
    // Which page, which filter and which response type are all decided inside the
    // handlers, from the custom_id they are given. `values` is passed only to the
    // board, which is the only family with a select on it.
    //
    // ON A THROW, a type 4 with flags 64 rather than a type 7: the member keeps
    // the message they were looking at and gets an apology beside it, exactly as
    // the self-role path does. A broken type 7 would replace a working list with
    // an error.
    if (
      isSessionPageButton(customId) ||
      isSessionBoardButton(customId) ||
      isTournamentPageButton(customId)
    ) {
      const context = {
        discordUserId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
        guildId: interaction.guild_id ?? null,
      };
      try {
        const response = isSessionPageButton(customId)
          ? await handleSessionPageButton(customId as string, context)
          : isSessionBoardButton(customId)
            ? await handleSessionBoardButton(customId as string, context, interaction.data.values)
            : await handleTournamentPageButton(customId as string, context);
        return send(res, 200, response);
      } catch (error) {
        console.error('[bot] list button failed:', error);
        return send(res, 200, {
          type: 4,
          data: { content: 'Something went wrong. Please try again.', flags: 64 },
        });
      }
    }

    // A component this build does not know — most likely a button from a
    // message posted by an older version. type 6 is DEFERRED_UPDATE_MESSAGE:
    // acknowledge and change nothing, which leaves the message intact rather
    // than showing the clicker an error for something that is not their fault.
    return send(res, 200, { type: 6 });
  }

  // APPLICATION_COMMAND_AUTOCOMPLETE: a picker refiring on every keystroke.
  //
  // FOUR COMMANDS ARRIVE HERE NOW, AND THEY NO LONGER WANT THE SAME ANSWER.
  // /profile and /forcelink both want club HANDLES, and handleProfileAutocomplete
  // serves both because it reads the FOCUSED option rather than one named
  // 'handle': that property, predicted by its own comment, is what let the second
  // command arrive here for free. /forceunlink and /forceupdate want something
  // the ladder cannot express, a CONNECTED ACCOUNT including the members the
  // ladder deliberately hides, so they get their own provider.
  //
  // ROUTED ON A SET commands.ts OWNS, on DEFERRED_COMMANDS' pattern, rather than
  // a condition written out here: the file that defines the commands is the one
  // that knows which picker each wants, and keeping the answer there is what
  // stops the two drifting. Adding a command to LINKED_ACCOUNT_PICKERS is the
  // whole change; this branch needs none.
  //
  // CANNOT BE DEFERRED. Type 8 within about three seconds is the only valid
  // answer there is, and the fall-through below would reply type 1, which the
  // picker renders as "loading options failed".
  //
  // So the cold-cache read races a timer and empty choices win it. A picker
  // that suggests nothing for one keystroke is invisible; a missed deadline is
  // an error the member sees.
  if (interaction.type === 4 && interaction.data) {
    const options = interaction.data.options;
    // The OFFICER, for the linked-account picker: its route carries the same
    // capability check the commands behind it do, so it has to be told who is
    // asking. Read from the same two places a command reads its caller from.
    const context = {
      discordUserId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
      guildId: interaction.guild_id ?? null,
    };
    try {
      // /challenge report lists the caller's own open challenges, and /receipt
      // the caller's own unpaid fees, so each is told who is asking, as the
      // linked-account picker is.
      const answered = await Promise.race([
        OPEN_CHALLENGE_PICKERS.has(interaction.data.name)
          ? handleChallengeAutocomplete(options, context)
          : OWN_FEE_PICKERS.has(interaction.data.name)
            ? handleReceiptAutocomplete(options, context)
            : LINKED_ACCOUNT_PICKERS.has(interaction.data.name)
            ? handleLinkedAccountAutocomplete(options, context)
            : handleProfileAutocomplete(options),
        new Promise<{ type: number; data: { choices: [] } }>((resolve) =>
          setTimeout(() => resolve({ type: 8, data: { choices: [] } }), AUTOCOMPLETE_BUDGET_MS)
        ),
      ]);
      return send(res, 200, answered);
    } catch (error) {
      // The whole branch, because createServer's handler has no outer catch: a
      // throw escaping here writes no response at all and raises an unhandled
      // rejection in the process.
      console.error('[bot] autocomplete failed:', error);
      return send(res, 200, { type: 8, data: { choices: [] } });
    }
  }

  // Unknown interaction type — acknowledge rather than erroring, so a future
  // Discord type does not surface to users as a broken bot.
  return send(res, 200, { type: 1 });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[bot] listening on ${PORT}`);

  // Presence. Interactions arrive over HTTP and do not need this, so a missing
  // token costs a grey dot and nothing else -- never a failed boot.
  const token = process.env.DISCORD_BOT_TOKEN;
  if (token) {
    try {
      gateway = startGateway({ token });
    } catch (error) {
      console.error(`[bot] gateway failed to start: ${String(error)}`);
    }
  } else {
    console.log('[bot] no DISCORD_BOT_TOKEN — gateway disabled, bot will show offline');
  }

  // Filled now rather than on the first keystroke: an autocomplete cannot be
  // deferred, so a cold cache spends the member's whole budget on a fetch.
  // Non-fatal, like loadConfig below — the picker simply pays for it later.
  warmHandles();

  // Where config comes from, said once. The guild map and audit channel are
  // read from the database at runtime now, so the env vars are only the
  // bootstrap fallback for a bot running against a database without 00167 —
  // and "no audit entries" and "audit entries nobody can see" look identical
  // from inside Discord, so the distinction has to be drawn here.
  loadConfig()
    .then(({ registry, auditChannelId }) => {
      console.log(
        `[bot] config: ${registry.size} guild(s), audit log ${
          auditChannelId ? `-> channel ${auditChannelId}` : 'DISABLED (no audit_channel_id)'
        }`
      );
    })
    .catch((error) => {
      // Not fatal. The app may simply not be up yet, and every operation
      // re-reads config anyway; this is a startup diagnostic, not a gate.
      console.error(`[bot] could not read config at startup: ${String(error)}`);
    });

  // Slash commands, if this deployment is the one allowed to publish them. A
  // deploy here is a pull and a restart, so this callback IS the deploy hook:
  // register-commands.ts says why that beats a CI step, and why
  // REGISTER_COMMANDS_ON_BOOT has to be set by hand first.
  //
  // IN HERE, AND NOT AWAITED, so nothing about readiness waits on Discord: the
  // listener is already bound by the time this callback runs and the gateway
  // was started synchronously above, so a hung or rate-limited registration
  // costs nothing but its own log line. The .catch is the second net - the
  // function swallows its own failures, and an unhandled rejection escaping
  // here would kill the process, which is the one thing registration must
  // never do.
  registerCommandsOnBoot().catch((error) => {
    console.error(`[bot] command registration threw: ${String(error)}`);
  });
});

// The proxy and Docker both stop containers with SIGTERM. Closing the server
// lets in-flight interactions finish instead of being cut off mid-reply.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[bot] ${signal} — shutting down`);
    gateway?.stop();
    server.close(() => process.exit(0));
  });
}
