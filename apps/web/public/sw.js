// Deliberately minimal for fetch handling — this exists to satisfy the
// installability requirement (a registered service worker with a fetch handler) so
// the browser will fire `beforeinstallprompt` at all, NOT to provide offline
// support. It passes every request straight through to the network, unmodified. Real
// offline caching (an app-shell strategy, never for message ciphertext/plaintext —
// that stays in IndexedDB, never the Cache API) is docs/13-roadmap.md's Phase 8,
// intentionally not attempted here alongside everything else —
// components/install-prompt.tsx is explicit with the user that installing just gives
// an app-like window, not offline access, so this isn't overclaiming what it does.
//
// The `push`/`notificationclick` handlers below (docs/13-roadmap.md's push
// notification pass) are the one thing this service worker does beyond installability
// — they're what let a notification show up while the app itself isn't running any
// JS at all, which is the whole reason push notifications need a service worker
// instead of just an in-page Notification call.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

// The push payload is deliberately generic (apps/worker's dispatch, never anything
// decrypted) — a service worker has no access to the in-memory-only KEK the page
// holds (lib/crypto/kek-holder.ts), so it structurally CANNOT decrypt message
// content even if the payload carried ciphertext. `title`/`body` here are built
// server-side from metadata the server already legitimately has (sender display
// name, conversation id) — never message plaintext.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Malformed/non-JSON payload — show nothing rather than crash the SW.
    return;
  }

  const title = data.title || 'Comm';
  const body = data.body || 'You have a new message.';
  const conversationId = data.conversationId;
  // New-device login approval (docs/07-auth-architecture.md's device-approval
  // section) — the one push type that should show even while the app is open and
  // focused: unlike a new message (already visible live in the UI, so a duplicate
  // OS notification would just be noise), a pending sign-in request has no
  // equivalent in-page surface unless the Devices screen happens to already be
  // open, so it can't assume "focused == already seen."
  const isLoginPending = data.type === 'login_pending';

  event.waitUntil(
    (async () => {
      if (!isLoginPending) {
        // If the app is already open and focused, the live WebSocket delivery
        // (docs/04-websocket-realtime.md) already showed this message in the UI —
        // a duplicate OS-level notification on top of that would just be noise.
        const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const alreadyLooking = clientsList.some((c) => c.focused);
        if (alreadyLooking) return;
      }

      await self.registration.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: isLoginPending ? 'login-pending' : conversationId ? `conversation-${conversationId}` : undefined,
        data: { conversationId, type: data.type },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const conversationId = event.notification.data && event.notification.data.conversationId;
  const url =
    event.notification.data && event.notification.data.type === 'login_pending'
      ? '/devices'
      : conversationId
        ? `/chats/${conversationId}`
        : '/chats';

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientsList) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
