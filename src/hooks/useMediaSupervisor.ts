import { useEffect, useRef, useState } from "react";

export type SupervisedMediaElement = {
  id: string;
  element: HTMLMediaElement | null;
  active: boolean;
  shouldAdvance: boolean;
};

type MediaSupervisorClock = {
  time: number;
  resync: () => void;
};

type MediaSupervisorOptions = {
  getElements: () => SupervisedMediaElement[];
  isPlaying: () => boolean;
  getClock: () => MediaSupervisorClock;
  onRebuild: (id: string, reason: string) => void;
  /** Called once when a clip keeps failing and rebuilding is abandoned. */
  onGiveUp?: (id: string, reason: string) => void;
};

export type MediaSupervisorReport =
  | "loadstart"
  | "seeking"
  | "seeked"
  | "playing"
  | "progress"
  | "stalled"
  | "waiting"
  | "error"
  | "emptied"
  | "abort";

/* ------------------------------------------------------------------------ *
 * Pure decision logic (no DOM, unit-testable)
 *
 * Design rules:
 *  - A rebuild remounts the <video> and throws away its decoder. That is far
 *    more disruptive than the problems it fixes, so it is reserved for media
 *    that is PROVABLY dead, never for media that is merely loading, buffering
 *    or briefly paused.
 *  - `emptied` and `abort` fire during ordinary loads and source swaps. They
 *    are never failures on their own.
 *  - A clip whose file cannot be read would otherwise be rebuilt forever. The
 *    gate below caps attempts, backs off, then gives up and reports it.
 * ------------------------------------------------------------------------ */

const NETWORK_IDLE = 1;
const NETWORK_NO_SOURCE = 3;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;

export const SEEK_STUCK_MS = 2000;
export const IDLE_WITHOUT_DATA_GRACE_MS = 2000;
export const PLAYBACK_STALL_MS = 1500;
export const STUCK_PAUSED_MS = 2500;
export const MAX_REBUILDS_PER_WINDOW = 3;
export const REBUILD_WINDOW_MS = 30000;
export const REBUILD_BASE_GAP_MS = 350;

export type MediaHealthSnapshot = {
  hasError: boolean;
  networkState: number;
  readyState: number;
  seeking: boolean;
  paused: boolean;
  ended: boolean;
};

export type MediaHealthContext = {
  /** Whether this clip is the active Program clip at the current timeline time. */
  active: boolean;
  /** ms since this element was first seen / started loading. */
  mountedForMs: number;
  /** ms the element has been continuously seeking (0 if it is not). */
  seekingForMs: number;
  /** ms the playhead has not advanced although it should (0 = unknown). */
  stalledForMs: number;
  /** ms the element has been paused although it should be playing. */
  pausedForMs: number;
  /** True only for the active clip while the transport is playing. */
  expectPlayback: boolean;
};

/** Returns a reason when the element is provably broken, otherwise null. */
export function diagnoseMedia(
  snapshot: MediaHealthSnapshot,
  context: MediaHealthContext,
): string | null {
  if (snapshot.hasError) return "media error";

  // WebKit transiently reports NETWORK_NO_SOURCE while a <video> is swapping
  // from the original to an edit proxy (and while the editor is mounting after
  // project load). Treat it as fatal only if it persists beyond the normal
  // loading grace period; rebuilding immediately on the accompanying `abort`
  // event just tears down a decoder that was already recovering correctly.
  if (
    snapshot.networkState === NETWORK_NO_SOURCE &&
    context.mountedForMs > IDLE_WITHOUT_DATA_GRACE_MS
  ) {
    return "no usable source";
  }

  // Hidden/prewarmed decks are deliberately paused and can sit in WebKit's
  // `seeking` state longer than the visible Program clip. Rebuilding those
  // decks repeatedly churns decoder memory and can produce large transient
  // allocations. Only treat a seek as fatal when the clip is actually active.
  if (
    context.active &&
    snapshot.seeking &&
    context.seekingForMs > SEEK_STUCK_MS
  ) {
    return "seek stuck";
  }

  // Idle with nothing loaded (not "loading", not "empty"): the browser dropped
  // the resource, e.g. after the page was suspended.
  if (
    snapshot.readyState < HAVE_METADATA &&
    snapshot.networkState === NETWORK_IDLE &&
    context.mountedForMs > IDLE_WITHOUT_DATA_GRACE_MS
  ) {
    return "decoder purged";
  }

  if (!context.expectPlayback || snapshot.ended) return null;

  if (
    snapshot.paused &&
    snapshot.readyState >= HAVE_CURRENT_DATA &&
    !snapshot.seeking &&
    context.pausedForMs > STUCK_PAUSED_MS
  ) {
    return "stuck paused";
  }

  if (
    !snapshot.paused &&
    !snapshot.seeking &&
    snapshot.readyState >= HAVE_CURRENT_DATA &&
    context.stalledForMs > PLAYBACK_STALL_MS
  ) {
    return "playback stalled";
  }

  return null;
}

export type RebuildGateResult = {
  decision: "allow" | "wait" | "give-up";
  history: number[];
};

/**
 * Rate-limits rebuilds per clip: exponential back-off between attempts and a
 * hard cap per window, after which the clip is abandoned (and reported).
 */
export function gateRebuild(history: number[], now: number): RebuildGateResult {
  const recent = history.filter((at) => now - at < REBUILD_WINDOW_MS);

  if (recent.length >= MAX_REBUILDS_PER_WINDOW) {
    return { decision: "give-up", history: recent };
  }

  const minGap = REBUILD_BASE_GAP_MS * 2 ** recent.length;
  const last = recent[recent.length - 1];
  if (last !== undefined && now - last < minGap) {
    return { decision: "wait", history: recent };
  }

  return { decision: "allow", history: [...recent, now] };
}

/* ------------------------------ the hook --------------------------------- */

export function useMediaSupervisor(options: MediaSupervisorOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [epochs, setEpochs] = useState<Record<string, number>>({});
  const [failedIds, setFailedIds] = useState<Record<string, string>>({});

  const firstSeenRef = useRef<Record<string, number>>({});
  const seekingSinceRef = useRef<Record<string, number>>({});
  const lastProgressRef = useRef<
    Record<string, { mediaTime: number; observedAt: number }>
  >({});
  const pausedSinceRef = useRef<Record<string, number>>({});
  const rebuildHistoryRef = useRef<Record<string, number[]>>({});
  const givenUpRef = useRef<Record<string, string>>({});
  const lastWakeRef = useRef(0);

  const forget = (id: string) => {
    delete firstSeenRef.current[id];
    delete seekingSinceRef.current[id];
    delete lastProgressRef.current[id];
    delete pausedSinceRef.current[id];
  };

  const rebuild = (id: string, reason: string) => {
    if (givenUpRef.current[id]) return;

    const gate = gateRebuild(rebuildHistoryRef.current[id] ?? [], performance.now());
    rebuildHistoryRef.current[id] = gate.history;

    if (gate.decision === "wait") return;

    if (gate.decision === "give-up") {
      givenUpRef.current[id] = reason;
      console.error(
        `[CTC media supervisor] Giving up on ${id} after repeated failures (${reason}). ` +
          `The file is probably unreadable (missing, moved, or not allowed by the asset scope).`,
      );
      setFailedIds((current) => ({ ...current, [id]: reason }));
      optionsRef.current.onGiveUp?.(id, reason);
      return;
    }

    forget(id);
    optionsRef.current.onRebuild(id, reason);
    setEpochs((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  };

  const markHealthy = (id: string) => {
    delete rebuildHistoryRef.current[id];
  };

  const report = (
    id: string,
    event: MediaSupervisorReport,
    mediaTime?: number,
  ) => {
    const now = performance.now();
    const element = optionsRef.current
      .getElements()
      .find((item) => item.id === id)?.element;
    const observedMediaTime =
      mediaTime ?? element?.currentTime ?? lastProgressRef.current[id]?.mediaTime ?? 0;

    switch (event) {
      case "loadstart":
        // A fresh load is not a seek. Starting the "stuck seek" clock here
        // would make every element look stuck until its first real seek.
        firstSeenRef.current[id] = now;
        delete seekingSinceRef.current[id];
        delete lastProgressRef.current[id];
        delete pausedSinceRef.current[id];
        break;
      case "seeking":
        seekingSinceRef.current[id] = now;
        break;
      case "seeked":
        delete seekingSinceRef.current[id];
        lastProgressRef.current[id] = { mediaTime: observedMediaTime, observedAt: now };
        if ((element?.readyState ?? 0) >= HAVE_CURRENT_DATA) markHealthy(id);
        break;
      case "playing":
      case "progress":
        lastProgressRef.current[id] = { mediaTime: observedMediaTime, observedAt: now };
        delete pausedSinceRef.current[id];
        markHealthy(id);
        break;
      case "waiting":
      case "stalled":
        // Buffering is normal (especially for full-size originals read through
        // the asset protocol). Extend the grace period; never backdate it.
        lastProgressRef.current[id] = { mediaTime: observedMediaTime, observedAt: now };
        break;
      case "error":
        // A real media error is actionable immediately. NETWORK_NO_SOURCE by
        // itself is handled by the watchdog after a grace period because it is
        // also a normal transient state during source/proxy swaps.
        if (element?.error) {
          rebuild(id, "error");
        }
        break;
      case "emptied":
      case "abort":
        // Both events are expected during project mount, proxy promotion and
        // source replacement. Restart the health grace window instead of
        // remounting immediately; a genuinely unusable source will still be
        // caught by the watchdog once NETWORK_NO_SOURCE persists.
        firstSeenRef.current[id] = now;
        delete seekingSinceRef.current[id];
        delete lastProgressRef.current[id];
        delete pausedSinceRef.current[id];
        break;
    }
  };

  useEffect(() => {
    const snapshotOf = (media: HTMLMediaElement): MediaHealthSnapshot => ({
      hasError: media.error !== null,
      networkState: media.networkState,
      readyState: media.readyState,
      seeking: media.seeking,
      paused: media.paused,
      ended: media.ended,
    });

    const inspectMountedMedia = () => {
      const now = performance.now();
      for (const item of optionsRef.current.getElements()) {
        const media = item.element;
        if (!media) continue;

        firstSeenRef.current[item.id] ??= now;
        const seekingSince = seekingSinceRef.current[item.id];

        const reason = diagnoseMedia(snapshotOf(media), {
          active: item.active,
          mountedForMs: now - firstSeenRef.current[item.id],
          seekingForMs: media.seeking && seekingSince ? now - seekingSince : 0,
          stalledForMs: 0,
          pausedForMs: 0,
          expectPlayback: false,
        });

        if (reason) {
          console.warn("[CTC media supervisor]", item.id, reason, snapshotOf(media));
          rebuild(item.id, reason);
        }
      }
    };

    const wake = () => {
      if (document.visibilityState !== "visible") return;

      const now = performance.now();
      // `focus`, `pageshow` and `visibilitychange` often arrive together, and
      // native menus/dialogs also bounce focus. Handle one wake at a time.
      if (now - lastWakeRef.current < 300) return;

      // After a long absence, give clips we had abandoned one more chance.
      if (now - lastWakeRef.current > 10000 && Object.keys(givenUpRef.current).length) {
        givenUpRef.current = {};
        rebuildHistoryRef.current = {};
        setFailedIds({});
      }
      lastWakeRef.current = now;

      inspectMountedMedia();
      optionsRef.current.getClock().resync();
    };

    const watchdog = window.setInterval(() => {
      const playing = optionsRef.current.isPlaying();
      if (document.visibilityState !== "visible") return;

      const now = performance.now();
      const live = new Set<string>();

      for (const item of optionsRef.current.getElements()) {
        live.add(item.id);
        const media = item.element;
        if (!media) continue;

        firstSeenRef.current[item.id] ??= now;

        const expectPlayback = playing && item.active && item.shouldAdvance;
        const seekingSince = seekingSinceRef.current[item.id];

        let stalledForMs = 0;
        let pausedForMs = 0;

        if (expectPlayback) {
          const previous = lastProgressRef.current[item.id];
          const advanced =
            !previous || Math.abs(media.currentTime - previous.mediaTime) > 0.008;

          if (media.paused) {
            pausedSinceRef.current[item.id] ??= now;
            pausedForMs = now - pausedSinceRef.current[item.id];
            // Not advancing because it is paused is a different problem from a
            // stalled decoder; keep the stall clock fresh.
            lastProgressRef.current[item.id] = {
              mediaTime: media.currentTime,
              observedAt: now,
            };
          } else {
            delete pausedSinceRef.current[item.id];
            if (advanced) {
              lastProgressRef.current[item.id] = {
                mediaTime: media.currentTime,
                observedAt: now,
              };
            } else {
              stalledForMs = now - previous.observedAt;
            }
          }
        } else {
          delete pausedSinceRef.current[item.id];
          delete lastProgressRef.current[item.id];
        }

        const reason = diagnoseMedia(snapshotOf(media), {
          active: item.active,
          mountedForMs: now - firstSeenRef.current[item.id],
          seekingForMs: media.seeking && seekingSince ? now - seekingSince : 0,
          stalledForMs,
          pausedForMs,
          expectPlayback,
        });

        if (reason) {
          console.warn("[CTC media supervisor]", item.id, reason, snapshotOf(media));
          rebuild(item.id, reason);
        }
      }

      // Don't let bookkeeping for unmounted clips accumulate.
      for (const id of Object.keys(firstSeenRef.current)) {
        if (!live.has(id)) {
          forget(id);
          delete rebuildHistoryRef.current[id];
        }
      }
    }, 500);

    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", wake);

    return () => {
      window.clearInterval(watchdog);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  return { epochs, report, failedIds };
}