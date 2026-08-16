'use client';

/**
 * Client-side WebSocket connection to the realtime channel
 * (docs/04-websocket-realtime.md) — one socket per tab (matching the "each browser
 * tab is its own device-scoped identity" model, docs/06-device-architecture.md),
 * auth cookie riding along automatically since this is a same-origin connection.
 * Reconnects with exponential backoff + jitter; consumers subscribe to event types
 * rather than reading raw socket data, so UI code never touches the wire format.
 */
type Listener = (payload: Record<string, unknown>) => void;

const listeners = new Map<string, Set<Listener>>();
let socket: WebSocket | null = null;
let reconnectAttempt = 0;
let intentionallyClosed = false;

function emit(type: string, payload: Record<string, unknown>): void {
  for (const listener of listeners.get(type) ?? []) listener(payload);
}

export function onRealtimeEvent(type: string, listener: Listener): () => void {
  const set = listeners.get(type) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(type, set);
  return () => set.delete(listener);
}

export function sendRealtimeEvent(payload: Record<string, unknown>): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
  // A dropped/reconnecting socket silently drops the send here — callers that need
  // guaranteed delivery (message.send) fall back to the REST endpoint themselves
  // (docs/04-websocket-realtime.md's "REST fallback for offline-queued sends"),
  // rather than this module growing its own retry/outbox logic.
}

function scheduleReconnect(): void {
  if (intentionallyClosed) return;
  const delayMs = Math.min(1000 * 2 ** reconnectAttempt, 30_000) + Math.random() * 500;
  reconnectAttempt += 1;
  setTimeout(connectRealtime, delayMs);
}

export function connectRealtime(): void {
  if (typeof window === 'undefined') return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  intentionallyClosed = false;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}/realtime`);

  socket.onopen = () => {
    reconnectAttempt = 0;
    emit('connection.open', {});
  };

  socket.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data as string) as { type?: string };
      if (typeof parsed.type === 'string') emit(parsed.type, parsed as Record<string, unknown>);
    } catch {
      // Malformed frame — ignored rather than crashing the connection.
    }
  };

  socket.onclose = (event) => {
    emit('connection.close', { code: event.code });
    // 4001 = device_revoked (server/realtime/ws-server.ts) — don't reconnect into a
    // session that's been explicitly torn down.
    if (event.code === 4001) {
      intentionallyClosed = true;
      return;
    }
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose always follows onerror for a WebSocket — reconnect scheduling happens
    // there, not duplicated here.
  };
}

export function disconnectRealtime(): void {
  intentionallyClosed = true;
  socket?.close(1000, 'client_disconnect');
  socket = null;
}
