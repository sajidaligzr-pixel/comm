import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { createRedisSubscriber } from '@comm/security';
import { parse as parseCookies } from 'cookie';
import { authenticateAccessToken, type AuthContext } from '../common/auth';
import { ACCESS_TOKEN_COOKIE } from '../common/cookies';
import {
  DEVICE_EVENTS_CHANNEL,
  MESSAGE_EVENTS_CHANNEL,
  CALL_EVENTS_CHANNEL,
  GROUP_EVENTS_CHANNEL,
  GROUP_CALL_EVENTS_CHANNEL,
  LOCATION_EVENTS_CHANNEL,
  type DeviceEvent,
  type MessageEvent,
  type CallEvent,
  type GroupEvent,
  type GroupCallEvent,
  type LocationEvent,
} from './bus';
import { handleInboundWsMessage } from './message-handlers';

/**
 * The realtime channel docs/04-websocket-realtime.md describes: one authenticated
 * socket per device, carrying messages/typing/presence/delivery-and-read-state and
 * (audio) call signaling. Connection/auth/registry plumbing lives here;
 * what each event actually *means* is message-handlers.ts's job, kept separate so
 * this file stays about sockets, not business logic.
 */
const wss = new WebSocketServer({ noServer: true });

/** `ws`'s own `'connection'` event only ever carries `(socket, request)` — rather
 * than fight that typed signature to smuggle the authenticated context through as a
 * third argument, it's attached directly to the socket instance before the
 * `'connection'` event fires, and read back off it inside the handler below. */
type AuthenticatedSocket = WebSocket & { ctx?: AuthContext };

// deviceId -> live sockets for that device (normally one, but nothing here assumes
// exactly one — see the multi-tab note in docs/04-websocket-realtime.md).
const socketsByDevice = new Map<string, Set<WebSocket>>();

function registerSocket(deviceId: string, socket: WebSocket): void {
  const set = socketsByDevice.get(deviceId) ?? new Set<WebSocket>();
  set.add(socket);
  socketsByDevice.set(deviceId, set);
  socket.once('close', () => {
    set.delete(socket);
    if (set.size === 0) socketsByDevice.delete(deviceId);
  });
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch (err) {
    // JSON.stringify throws synchronously on a value it can't serialize (a raw
    // BigInt anywhere in the payload is the concrete way that happens in this
    // codebase — Prisma's `encryptedSizeBytes` is one) — caught here, at the one
    // place every outbound event funnels through (this device's direct response AND
    // forwardToDevice's Redis-forwarded events below), so a single bad payload can
    // never take down the whole process, and — just as important — never silently
    // stops `forwardToDevice`'s loop from reaching this device's *other* open
    // sockets/tabs, or any of it from mattering to sockets belonging to other users
    // entirely.
    console.error('[realtime] failed to serialize/send outbound event', err);
  }
}

function forwardToDevice(deviceId: string, payload: unknown): void {
  const sockets = socketsByDevice.get(deviceId);
  if (!sockets) return;
  for (const socket of sockets) sendJson(socket, payload);
}

/**
 * Pub/sub requires its own dedicated connection — an ioredis connection in
 * subscriber mode can't issue other commands (docs/00-overview.md's Redis row).
 *
 * Deliberately NOT created at module-top-level. `server.ts` statically imports this
 * file before it ever calls `next({dev})`/`app.prepare()` — and Next's own `.env`
 * loading (docs/11-deployment-architecture.md) happens as part of that
 * initialization, not before. A top-level `createRedisSubscriber()` call here used to
 * run before `REDIS_URL` was actually in `process.env` yet; it only ever appeared to
 * work because of a hardcoded `'redis://localhost:6379'` fallback that happened to
 * match the real dev value by coincidence, silently masking the ordering bug. This is
 * now an explicit function `server.ts` calls from inside `app.prepare().then(...)`,
 * after Next has finished loading env — the same fix apps/worker's own README note
 * documents for a materially identical class of "this only worked by accident"
 * env-loading problem.
 */
export function initRealtimeSubscriber(): void {
  const subscriber = createRedisSubscriber();
  subscriber
    .subscribe(
      DEVICE_EVENTS_CHANNEL,
      MESSAGE_EVENTS_CHANNEL,
      CALL_EVENTS_CHANNEL,
      GROUP_EVENTS_CHANNEL,
      GROUP_CALL_EVENTS_CHANNEL,
      LOCATION_EVENTS_CHANNEL,
    )
    .catch((err) => {
      console.error('[realtime] failed to subscribe to realtime channels', err);
    });
  subscriber.on('message', (channel, raw) => {
    if (channel === DEVICE_EVENTS_CHANNEL) {
      let event: DeviceEvent;
      try {
        event = JSON.parse(raw) as DeviceEvent;
      } catch {
        return;
      }
      if (event.type === 'revoked') {
        const sockets = socketsByDevice.get(event.deviceId);
        if (!sockets) return;
        for (const socket of sockets) {
          // 4001 is an application-defined close code (the 4000-4999 range is
          // reserved for private use by the WebSocket spec) — the client
          // distinguishes "signed out elsewhere" from a generic disconnect using this.
          socket.close(4001, 'device_revoked');
        }
      }
      return;
    }

    if (channel === MESSAGE_EVENTS_CHANNEL) {
      let event: MessageEvent;
      try {
        event = JSON.parse(raw) as MessageEvent;
      } catch {
        return;
      }
      forwardToDevice(event.targetDeviceId, event);
      return;
    }

    if (channel === CALL_EVENTS_CHANNEL) {
      let event: CallEvent;
      try {
        event = JSON.parse(raw) as CallEvent;
      } catch {
        return;
      }
      forwardToDevice(event.targetDeviceId, event);
      return;
    }

    if (channel === GROUP_EVENTS_CHANNEL) {
      let event: GroupEvent;
      try {
        event = JSON.parse(raw) as GroupEvent;
      } catch {
        return;
      }
      forwardToDevice(event.targetDeviceId, event);
      return;
    }

    if (channel === GROUP_CALL_EVENTS_CHANNEL) {
      let event: GroupCallEvent;
      try {
        event = JSON.parse(raw) as GroupCallEvent;
      } catch {
        return;
      }
      forwardToDevice(event.targetDeviceId, event);
      return;
    }

    if (channel === LOCATION_EVENTS_CHANNEL) {
      let event: LocationEvent;
      try {
        event = JSON.parse(raw) as LocationEvent;
      } catch {
        return;
      }
      forwardToDevice(event.targetDeviceId, event);
    }
  });
}

const HEARTBEAT_INTERVAL_MS = 30_000;

wss.on('connection', (socket: AuthenticatedSocket) => {
  const ctx = socket.ctx;
  if (!ctx) {
    // Unreachable in practice — handleRealtimeUpgrade always sets `ctx` before
    // completing the handshake — but a socket with no authenticated identity must
    // never be treated as connected either way.
    socket.close(4000, 'unauthenticated');
    return;
  }

  let alive = true;
  socket.on('pong', () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, HEARTBEAT_INTERVAL_MS);
  socket.once('close', () => clearInterval(heartbeat));

  socket.on('message', (data) => {
    void (async () => {
      const response = await handleInboundWsMessage(ctx, data.toString());
      if (response) sendJson(socket, response);
    })().catch((err: unknown) => {
      // handleInboundWsMessage already catches everything it can reach internally
      // (see message-handlers.ts's own try/catch) and always resolves rather than
      // rejects — but sendJson's JSON.stringify above it is NOT inside that guard,
      // and a value that can't be serialized (a raw BigInt slipping into a payload
      // is the concrete way this happens — JSON.stringify throws synchronously on
      // one) would otherwise turn into an unhandled rejection here, invisible until
      // server.ts's global handler caught the resulting crash. Caught locally too,
      // not just globally, so a bad payload for this one socket doesn't so much as
      // interrupt this one device's connection, let alone the whole process.
      console.error('[realtime] failed to handle inbound WS message', err);
    });
  });
});

/**
 * Cross-Site WebSocket Hijacking guard (found in security review): the access-token
 * cookie is `SameSite=Strict` (server/common/cookies.ts), which already stops a
 * browser from attaching it to a cross-site WS handshake in practice — but that's one
 * cookie attribute standing alone as the only defense for an unauthenticated-until-
 * this-point connection. Checking the handshake's `Origin` header against the
 * configured `WEB_ORIGIN` is the same "don't rely on a single mechanism" posture this
 * codebase already applies elsewhere (e.g. local-fs-storage.ts's belt-and-suspenders
 * objectKey format check on top of its own UUID-generation invariant).
 *
 * A MISSING Origin header is allowed, not rejected — this was a real, severe bug
 * (found live, traced all the way through with temporary connection-level logging
 * after days of reports that looked like a dozen unrelated small bugs): a browser
 * always sends `Origin` on a WebSocket handshake, but apps/mobile's ws_client.dart
 * is a native Dart WebSocket client with no such concept, so it never has and never
 * will send one — `if (!origin) return false` silently 401'd EVERY mobile WS
 * connection attempt, forever, with `ws_client.dart`'s own reconnect-with-backoff
 * masking it as "just" occasional flakiness. That's the actual root cause behind an
 * entire session's worth of "message/tick/call doesn't show up live, only after I
 * reopen the app" reports across every realtime feature — mobile was never actually
 * holding a live socket at all, only ever catching up after the fact through REST
 * fallbacks. The Origin check's real job is stopping a BROWSER from being tricked
 * into riding its own ambient cookies against this endpoint from a hostile page — a
 * client that was never a browser to begin with was never that threat model, so
 * letting a missing Origin through gives up nothing; a PRESENT-but-wrong Origin (an
 * actual hostile page, which — being a browser — always sends one) is still
 * rejected exactly as before.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  const allowed = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  return origin === allowed;
}

/**
 * Called from server.ts's `upgrade` handler. Authenticates using the same cookie the
 * HTTP API trusts — no separate, weaker WS auth path (docs/04-websocket-realtime.md's
 * "Transport & auth"). A failed check destroys the raw socket with a plain HTTP 401
 * before any WebSocket framing begins, rather than completing the handshake and
 * closing immediately after — cheaper to reject and avoids handing an unauthenticated
 * caller anything WebSocket-shaped to interact with.
 */
export async function handleRealtimeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  try {
    if (!isAllowedOrigin(req.headers.origin)) {
      throw new Error('origin_rejected');
    }
    const cookies = parseCookies(req.headers.cookie ?? '');
    const ctx = await authenticateAccessToken(cookies[ACCESS_TOKEN_COOKIE]);

    wss.handleUpgrade(req, socket, head, (ws: AuthenticatedSocket) => {
      ws.ctx = ctx;
      registerSocket(ctx.deviceId, ws);
      wss.emit('connection', ws, req);
    });
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
}
