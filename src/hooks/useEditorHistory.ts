import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Subtitle } from "../types/subtitle";
import type { TimelineMarker } from "../types/timeline";

export type EditorHistorySnapshot = {
  subtitles: Subtitle[];
  markers: TimelineMarker[];
};

type UseEditorHistoryOptions = {
  snapshot: EditorHistorySnapshot;
  enabled?: boolean;
  coalesceMs?: number;
  maxEntries?: number;
  onApply: (snapshot: EditorHistorySnapshot) => void;
};

function cloneSnapshot(
  snapshot: EditorHistorySnapshot,
): EditorHistorySnapshot {
  return {
    subtitles: snapshot.subtitles.map((subtitle) => ({
      ...subtitle,
    })),
    markers: snapshot.markers.map((marker) => ({
      ...marker,
    })),
  };
}

function snapshotKey(snapshot: EditorHistorySnapshot): string {
  return JSON.stringify(snapshot);
}

export function useEditorHistory({
  snapshot,
  enabled = true,
  coalesceMs = 350,
  maxEntries = 100,
  onApply,
}: UseEditorHistoryOptions) {
  const serializedSnapshot = useMemo(
    () => snapshotKey(snapshot),
    [snapshot],
  );

  const latestSnapshotRef = useRef(cloneSnapshot(snapshot));
  const latestKeyRef = useRef(serializedSnapshot);

  latestSnapshotRef.current = cloneSnapshot(snapshot);
  latestKeyRef.current = serializedSnapshot;

  const baselineRef = useRef(cloneSnapshot(snapshot));
  const baselineKeyRef = useRef(serializedSnapshot);

  const pendingStartRef = useRef<EditorHistorySnapshot | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const immediateNextChangeRef = useRef(false);

  const pastRef = useRef<EditorHistorySnapshot[]>([]);
  const futureRef = useRef<EditorHistorySnapshot[]>([]);

  const suppressAppliedKeyRef = useRef<string | null>(null);

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncAvailability = useCallback(() => {
    setCanUndo(
      pastRef.current.length > 0 ||
        pendingStartRef.current !== null,
    );
    setCanRedo(futureRef.current.length > 0);
  }, []);

  const clearPendingTimer = useCallback(() => {
    if (pendingTimerRef.current !== null) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  }, []);

  const commitPending = useCallback(() => {
    clearPendingTimer();

    const pendingStart = pendingStartRef.current;

    if (!pendingStart) {
      syncAvailability();
      return;
    }

    const currentSnapshot = cloneSnapshot(latestSnapshotRef.current);
    const currentKey = latestKeyRef.current;

    pendingStartRef.current = null;

    if (currentKey === baselineKeyRef.current) {
      syncAvailability();
      return;
    }

    pastRef.current.push(cloneSnapshot(pendingStart));

    if (pastRef.current.length > maxEntries) {
      pastRef.current.splice(
        0,
        pastRef.current.length - maxEntries,
      );
    }

    baselineRef.current = currentSnapshot;
    baselineKeyRef.current = currentKey;

    futureRef.current = [];

    syncAvailability();
  }, [
    clearPendingTimer,
    maxEntries,
    syncAvailability,
  ]);

  const reset = useCallback(
    (nextSnapshot: EditorHistorySnapshot) => {
      clearPendingTimer();

      const cloned = cloneSnapshot(nextSnapshot);
      const key = snapshotKey(cloned);

      pastRef.current = [];
      futureRef.current = [];
      pendingStartRef.current = null;
      immediateNextChangeRef.current = false;

      baselineRef.current = cloned;
      baselineKeyRef.current = key;

      latestSnapshotRef.current = cloneSnapshot(cloned);
      latestKeyRef.current = key;

      suppressAppliedKeyRef.current = key;

      setCanUndo(false);
      setCanRedo(false);
    },
    [clearPendingTimer],
  );

  const markNextChangeImmediate = useCallback(() => {
    commitPending();
    immediateNextChangeRef.current = true;
  }, [commitPending]);

  const applyHistorySnapshot = useCallback(
    (nextSnapshot: EditorHistorySnapshot) => {
      const cloned = cloneSnapshot(nextSnapshot);
      const key = snapshotKey(cloned);

      baselineRef.current = cloneSnapshot(cloned);
      baselineKeyRef.current = key;
      latestSnapshotRef.current = cloneSnapshot(cloned);
      latestKeyRef.current = key;
      suppressAppliedKeyRef.current = key;

      onApply(cloned);
    },
    [onApply],
  );

  const undo = useCallback(() => {
    if (!enabled) {
      return;
    }

    commitPending();

    const previous = pastRef.current.pop();

    if (!previous) {
      syncAvailability();
      return;
    }

    const current = cloneSnapshot(baselineRef.current);

    futureRef.current.push(current);

    applyHistorySnapshot(previous);
    syncAvailability();
  }, [
    applyHistorySnapshot,
    commitPending,
    enabled,
    syncAvailability,
  ]);

  const redo = useCallback(() => {
    if (!enabled) {
      return;
    }

    commitPending();

    const next = futureRef.current.pop();

    if (!next) {
      syncAvailability();
      return;
    }

    pastRef.current.push(
      cloneSnapshot(baselineRef.current),
    );

    if (pastRef.current.length > maxEntries) {
      pastRef.current.splice(
        0,
        pastRef.current.length - maxEntries,
      );
    }

    applyHistorySnapshot(next);
    syncAvailability();
  }, [
    applyHistorySnapshot,
    commitPending,
    enabled,
    maxEntries,
    syncAvailability,
  ]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const suppressedKey = suppressAppliedKeyRef.current;

    if (
      suppressedKey &&
      serializedSnapshot === suppressedKey
    ) {
      suppressAppliedKeyRef.current = null;
      baselineRef.current = cloneSnapshot(snapshot);
      baselineKeyRef.current = serializedSnapshot;
      syncAvailability();
      return;
    }

    if (serializedSnapshot === baselineKeyRef.current) {
      return;
    }

    if (!pendingStartRef.current) {
      pendingStartRef.current = cloneSnapshot(
        baselineRef.current,
      );

      // Any new editorial change invalidates redo immediately.
      futureRef.current = [];
      setCanUndo(true);
      setCanRedo(false);
    }

    clearPendingTimer();

    if (immediateNextChangeRef.current) {
      immediateNextChangeRef.current = false;

      pendingTimerRef.current = window.setTimeout(
        commitPending,
        0,
      );

      return;
    }

    pendingTimerRef.current = window.setTimeout(
      commitPending,
      coalesceMs,
    );

    return clearPendingTimer;
  }, [
    clearPendingTimer,
    coalesceMs,
    commitPending,
    enabled,
    serializedSnapshot,
    snapshot,
    syncAvailability,
  ]);

  useEffect(() => {
    return () => {
      clearPendingTimer();
    };
  }, [clearPendingTimer]);

  return {
    canUndo,
    canRedo,
    undo,
    redo,
    resetHistory: reset,
    commitHistory: commitPending,
    markNextChangeImmediate,
  };
}
