/**
 * Tiny cross-provider coordination so `CallProvider` (1:1) and
 * `GroupCallProvider` — two independent, sibling contexts, deliberately never
 * merged (see group-call-provider.tsx's own module docstring on why 1:1 calling
 * stays completely untouched by the group-call feature) — can't both go active
 * at once. Each sets this the moment it leaves `idle` and clears it back to
 * `null` on teardown; the OTHER provider checks it before starting or accepting
 * anything, so a group-call invite arriving mid 1:1-call (or vice versa) can't
 * silently open a second live microphone stream and RTCPeerConnection on top of
 * the first one.
 *
 * Plain module state, not React context/state — this only ever needs to be read
 * inside event handlers, never rendered, and the two providers aren't nested in
 * a way that makes passing it as a prop natural — same "module-scope state for
 * something that isn't UI" reasoning `realtime-client.ts`'s own socket/listener
 * registry already uses.
 */
export type ActiveCallKind = '1:1' | 'group' | null;

let active: ActiveCallKind = null;

export function getActiveCallKind(): ActiveCallKind {
  return active;
}

export function setActiveCallKind(kind: ActiveCallKind): void {
  active = kind;
}
