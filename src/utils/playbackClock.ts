import { useSyncExternalStore } from "react";

const PLAYHEAD_RENDER_INTERVAL_MS = 32;

type Listener = () => void;

let preciseTime = 0;
let renderedTime = 0;
let lastRenderedAt = 0;
let pendingTimer: number | null = null;
const listeners = new Set<Listener>();

function notify() {
  for (const listener of listeners) listener();
}

function commitRenderedTime(time: number) {
  if (pendingTimer !== null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  renderedTime = time;
  lastRenderedAt = performance.now();
  notify();
}

export function setPlaybackClockTime(time: number, immediate = false) {
  const next = Number.isFinite(time) ? Math.max(0, time) : 0;
  preciseTime = next;

  if (immediate) {
    commitRenderedTime(next);
    return;
  }

  const now = performance.now();
  const elapsed = now - lastRenderedAt;
  if (elapsed >= PLAYHEAD_RENDER_INTERVAL_MS) {
    commitRenderedTime(next);
    return;
  }

  if (pendingTimer === null) {
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null;
      commitRenderedTime(preciseTime);
    }, Math.max(0, PLAYHEAD_RENDER_INTERVAL_MS - elapsed));
  }
}

export function getPlaybackClockTime() {
  return preciseTime;
}

function getRenderedPlaybackClockTime() {
  return renderedTime;
}

function subscribePlaybackClock(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePlaybackClockTime() {
  return useSyncExternalStore(
    subscribePlaybackClock,
    getRenderedPlaybackClockTime,
    getRenderedPlaybackClockTime,
  );
}
