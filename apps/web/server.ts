import { createServer } from 'node:http';
import { parse } from 'node:url';
import next from 'next';
import { handleRealtimeUpgrade, initRealtimeSubscriber } from './server/realtime/ws-server';

/**
 * Custom server — the reason this app isn't run via plain `next dev`/`next start`.
 * Next's own dev/start commands don't give us a raw `http.Server` to attach a
 * WebSocket `upgrade` handler to, and the realtime channel (docs/04-websocket-realtime.md)
 * needs exactly that. Everything else is handed straight to Next's own request
 * handler unchanged — this file adds one thing (the upgrade path) and gets out of
 * the way otherwise. See docs/00-overview.md and docs/01-folder-structure.md for why
 * this replaced a separate NestJS/Fastify service.
 */
const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);

/**
 * Without these, one bad WebSocket message can take the *entire* server down for
 * every single connected user — found live-debugging a real report ("the call never
 * ended on my side", then "can't send messages at all" right after): the dev server
 * process had actually died and stayed dead until manually restarted, silently, with
 * no crash message visible anywhere the user could see. Node's default behavior for
 * an uncaught exception or unhandled promise rejection is to terminate the process —
 * fine for a short-lived script, disastrous for a long-running chat server serving
 * everyone at once. `server/realtime/ws-server.ts`'s per-message handler is the most
 * likely source (an async callback per inbound WS frame, across every connected
 * device, running arbitrary business logic) but this guard is deliberately global,
 * not scoped to just that file — any future code path with the same shape (an
 * unawaited/uncaught async operation anywhere in the process) gets the same
 * protection. Logs loudly and keeps running, rather than failing silently *or*
 * crashing silently — both worse than a visible log line.
 */
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException — recovered, process staying up', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection — recovered, process staying up', reason);
});

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  // Unlike getRequestHandler(), getUpgradeHandler() requires prepare() to have
  // already resolved (it throws "prepare() must be called before performing this
  // operation" otherwise) — so this has to be obtained in here, not above.
  const handleNextUpgrade = app.getUpgradeHandler();

  // Same reasoning: deferred until here (not called at ws-server.ts's module-top-level)
  // so it runs after Next has finished loading .env, not before — see
  // initRealtimeSubscriber's own docstring for the bug this fixes.
  initRealtimeSubscriber();

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url ?? '/', true);
    void handle(req, res, parsedUrl);
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url ?? '/');
    if (pathname === '/realtime') {
      void handleRealtimeUpgrade(req, socket, head);
    } else {
      // Everything else — critically, in dev mode, Turbopack's own HMR WebSocket
      // (`/_next/*`) — must go to Next's own upgrade handler, not be dropped.
      // Destroying it here used to kill Next's dev client before it finished
      // bootstrapping, which left every page fully un-hydrated (no event handlers
      // ever attached — forms silently fell back to native browser submission).
      void handleNextUpgrade(req, socket, head);
    }
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`> Comm ready on http://localhost:${port} (${dev ? 'development' : 'production'})`);
  });
}).catch((err: unknown) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
