import { useMemo, useRef, useState } from "react";

import type { ProjectMediaAsset } from "../types/project";
import type { AudioTimelineClip, TimelineTrackId } from "../types/timelineModel";

const MIN_AUDIO_CLIP_DURATION = 0.05;
const AUDIO_TRACK_ID_PATTERN = /^audio-\d+$/;

function normalizeAudioTrackId(trackId: TimelineTrackId): TimelineTrackId {
  return AUDIO_TRACK_ID_PATTERN.test(trackId) ? trackId : "audio-1";
}

function sortAudioClips(clips: AudioTimelineClip[]) {
  return [...clips].sort(
    (a, b) =>
      a.timelineStart - b.timelineStart ||
      a.timelineEnd - b.timelineEnd ||
      a.trackId.localeCompare(b.trackId),
  );
}

function findNextAvailableStart(
  clips: AudioTimelineClip[],
  trackId: TimelineTrackId,
  requestedStart: number,
  duration: number,
  excludedIds = new Set<string>(),
) {
  let start = Math.max(0, requestedStart);
  const sorted = clips
    .filter((clip) => clip.trackId === trackId && !excludedIds.has(clip.id))
    .sort((a, b) => a.timelineStart - b.timelineStart);

  for (const clip of sorted) {
    const end = start + duration;
    if (end <= clip.timelineStart) break;
    if (start >= clip.timelineEnd) continue;
    start = clip.timelineEnd;
  }

  return start;
}

function findNearestAvailableStart(
  clips: AudioTimelineClip[],
  trackId: TimelineTrackId,
  requestedStart: number,
  duration: number,
  excludedIds = new Set<string>(),
) {
  const requested = Math.max(0, requestedStart);
  const sorted = clips
    .filter((clip) => clip.trackId === trackId && !excludedIds.has(clip.id))
    .sort((a, b) => a.timelineStart - b.timelineStart);
  if (sorted.length === 0) return requested;

  const candidates: number[] = [];
  let gapStart = 0;
  for (const clip of sorted) {
    const latest = clip.timelineStart - duration;
    if (latest >= gapStart - 0.000001) {
      candidates.push(Math.max(gapStart, Math.min(requested, latest)));
    }
    gapStart = Math.max(gapStart, clip.timelineEnd);
  }
  candidates.push(Math.max(gapStart, requested));

  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best,
  candidates[0] ?? requested);
}

function splitForInsert(
  clips: AudioTimelineClip[],
  trackId: TimelineTrackId,
  insertStart: number,
  insertDuration: number,
) {
  const result: AudioTimelineClip[] = [];
  for (const clip of clips) {
    if (clip.trackId !== trackId) {
      result.push(clip);
      continue;
    }

    if (clip.timelineEnd <= insertStart) {
      result.push(clip);
      continue;
    }

    if (clip.timelineStart >= insertStart) {
      result.push({
        ...clip,
        timelineStart: clip.timelineStart + insertDuration,
        timelineEnd: clip.timelineEnd + insertDuration,
      });
      continue;
    }

    // Insert point falls inside this clip. Keep the left source fragment and
    // shift a right source fragment after the inserted media.
    const sourceSplit = clip.sourceIn + (insertStart - clip.timelineStart);
    result.push({
      ...clip,
      timelineEnd: insertStart,
      sourceOut: sourceSplit,
      fadeOutDuration: 0,
    });
    result.push({
      ...clip,
      id: crypto.randomUUID(),
      timelineStart: insertStart + insertDuration,
      timelineEnd: clip.timelineEnd + insertDuration,
      sourceIn: sourceSplit,
      fadeInDuration: 0,
    });
  }
  return result;
}

function rippleDelete(
  clips: AudioTimelineClip[],
  removedIds: Set<string>,
) {
  let next = [...clips];
  const byTrack = new Map<string, AudioTimelineClip[]>();
  for (const clip of clips.filter((clip) => removedIds.has(clip.id))) {
    const list = byTrack.get(clip.trackId) ?? [];
    list.push(clip);
    byTrack.set(clip.trackId, list);
  }

  next = next.filter((clip) => !removedIds.has(clip.id));

  for (const [trackId, removed] of byTrack) {
    const ordered = removed.sort((a, b) => a.timelineStart - b.timelineStart);
    let cumulative = 0;
    for (const removedClip of ordered) {
      const start = removedClip.timelineStart - cumulative;
      const duration = removedClip.timelineEnd - removedClip.timelineStart;
      next = next.map((clip) => {
        if (clip.trackId !== trackId || clip.timelineStart < start) return clip;
        return {
          ...clip,
          timelineStart: Math.max(0, clip.timelineStart - duration),
          timelineEnd: Math.max(0, clip.timelineEnd - duration),
        };
      });
      cumulative += duration;
    }
  }

  return sortAudioClips(next);
}

type UseAudioTimelineOptions = { rippleMode?: boolean };

export function useAudioTimeline({ rippleMode = false }: UseAudioTimelineOptions = {}) {
  const [audioClips, setAudioClips] = useState<AudioTimelineClip[]>([]);
  const [selectedAudioClipId, setSelectedAudioClipId] = useState<string | null>(null);
  const [selectedAudioClipIds, setSelectedAudioClipIds] = useState<string[]>([]);
  const moveOriginRef = useRef<{
    anchorId: string;
    selected: AudioTimelineClip[];
    all: AudioTimelineClip[];
  } | null>(null);

  const selectedAudioClip = useMemo(
    () => audioClips.find((clip) => clip.id === selectedAudioClipId) ?? null,
    [audioClips, selectedAudioClipId],
  );

  const clearAudioClipSelection = () => {
    setSelectedAudioClipId(null);
    setSelectedAudioClipIds([]);
  };

  const selectAudioClip = (id: string, mode: "single" | "toggle" | "focus" = "single") => {
    if (mode === "single") {
      setSelectedAudioClipId(id);
      setSelectedAudioClipIds([id]);
      return;
    }
    if (mode === "focus") {
      setSelectedAudioClipId(id);
      setSelectedAudioClipIds((current) => current.includes(id) ? current : [id]);
      return;
    }
    setSelectedAudioClipIds((current) => {
      if (current.includes(id)) {
        const next = current.filter((value) => value !== id);
        setSelectedAudioClipId((primary) => primary === id ? next[next.length - 1] ?? null : primary);
        return next;
      }
      setSelectedAudioClipId(id);
      return [...current, id];
    });
  };

  const selectAudioClips = (ids: string[], primaryId?: string | null) => {
    const unique = [...new Set(ids)];
    setSelectedAudioClipIds(unique);
    setSelectedAudioClipId(primaryId === undefined ? unique[0] ?? null : primaryId);
  };

  const replaceAudioClips = (clips: AudioTimelineClip[]) => {
    const normalized = clips.map((clip) => ({ ...clip, trackId: normalizeAudioTrackId(clip.trackId) }));
    setAudioClips(sortAudioClips(normalized));
    const available = new Set(normalized.map((clip) => clip.id));
    setSelectedAudioClipIds((current) => current.filter((id) => available.has(id)));
    setSelectedAudioClipId((current) => current && available.has(current) ? current : null);
  };

  const beginAudioClipMove = (id: string) => {
    if (!selectedAudioClipIds.includes(id)) return;
    const selected = new Set(selectedAudioClipIds);
    moveOriginRef.current = {
      anchorId: id,
      selected: audioClips.filter((clip) => selected.has(clip.id)).map((clip) => ({ ...clip })),
      all: audioClips.map((clip) => ({ ...clip })),
    };
  };

  const endAudioClipMove = () => { moveOriginRef.current = null; };

  const moveAudioClip = (id: string, requestedStart: number) => {
    setAudioClips((current) => {
      const origin = moveOriginRef.current;
      if (origin?.anchorId === id && origin.selected.length > 0) {
        const anchor = origin.selected.find((clip) => clip.id === id);
        if (!anchor) return current;
        const selectedIds = new Set(origin.selected.map((clip) => clip.id));
        const deltaRequested = requestedStart - anchor.timelineStart;

        if (rippleMode && origin.selected.every((clip) => clip.trackId === anchor.trackId)) {
          const without = rippleDelete(origin.all, selectedIds);
          const groupStart = Math.min(...origin.selected.map((clip) => clip.timelineStart));
          const groupEnd = Math.max(...origin.selected.map((clip) => clip.timelineEnd));
          const duration = groupEnd - groupStart;
          const anchorOffset = anchor.timelineStart - groupStart;
          const destination = Math.max(0, requestedStart - anchorOffset);
          const opened = splitForInsert(without, anchor.trackId, destination, duration);
          const inserted = origin.selected.map((clip) => ({
            ...clip,
            timelineStart: destination + (clip.timelineStart - groupStart),
            timelineEnd: destination + (clip.timelineEnd - groupStart),
          }));
          return sortAudioClips([...opened, ...inserted]);
        }

        const unselected = current.filter((clip) => !selectedIds.has(clip.id));
        let delta = deltaRequested;
        // Clamp the group by checking every selected clip against unselected clips.
        for (const clip of origin.selected) {
          const duration = clip.timelineEnd - clip.timelineStart;
          const legal = findNearestAvailableStart(
            unselected,
            clip.trackId,
            clip.timelineStart + delta,
            duration,
          );
          const clipDelta = legal - clip.timelineStart;
          if (Math.abs(clipDelta) < Math.abs(delta)) delta = clipDelta;
        }
        delta = Math.max(delta, -Math.min(...origin.selected.map((clip) => clip.timelineStart)));
        const origins = new Map(origin.selected.map((clip) => [clip.id, clip]));
        return sortAudioClips(current.map((clip) => {
          const source = origins.get(clip.id);
          return source ? {
            ...clip,
            timelineStart: source.timelineStart + delta,
            timelineEnd: source.timelineEnd + delta,
          } : clip;
        }));
      }

      const clip = current.find((value) => value.id === id);
      if (!clip) return current;
      const duration = clip.timelineEnd - clip.timelineStart;
      const start = findNearestAvailableStart(current, clip.trackId, requestedStart, duration, new Set([id]));
      return sortAudioClips(current.map((value) => value.id === id ? {
        ...value,
        timelineStart: start,
        timelineEnd: start + duration,
      } : value));
    });
  };

  const moveAudioClipToTrack = (id: string, targetTrackId: TimelineTrackId, requestedStart: number) => {
    const target = normalizeAudioTrackId(targetTrackId);
    setAudioClips((current) => {
      const origin = moveOriginRef.current;
      if (rippleMode && origin?.anchorId === id) {
        const source = origin.selected.find((clip) => clip.id === id);
        if (!source || origin.selected.length !== 1) return current;
        const removed = rippleDelete(origin.all, new Set([id]));
        const duration = source.timelineEnd - source.timelineStart;
        const start = Math.max(0, requestedStart);
        const opened = splitForInsert(removed, target, start, duration);
        return sortAudioClips([
          ...opened,
          {
            ...source,
            trackId: target,
            timelineStart: start,
            timelineEnd: start + duration,
          },
        ]);
      }

      const clip = current.find((value) => value.id === id);
      if (!clip) return current;
      const duration = clip.timelineEnd - clip.timelineStart;
      const start = findNearestAvailableStart(current, target, requestedStart, duration, new Set([id]));
      return sortAudioClips(current.map((value) => value.id === id ? {
        ...value,
        trackId: target,
        timelineStart: start,
        timelineEnd: start + duration,
      } : value));
    });
  };

  const resizeAudioClip = (id: string, newStart: number, newEnd: number) => {
    setAudioClips((current) => {
      const clip = current.find((value) => value.id === id);
      if (!clip) return current;
      const minStart = Math.max(0, clip.timelineStart - clip.sourceIn);
      const sourceDuration = clip.sourceDuration ?? clip.sourceOut;
      const maxEnd = clip.timelineEnd + Math.max(0, sourceDuration - clip.sourceOut);
      const start = Math.max(minStart, Math.min(newStart, newEnd - MIN_AUDIO_CLIP_DURATION));
      const end = Math.min(maxEnd, Math.max(start + MIN_AUDIO_CLIP_DURATION, newEnd));
      const sourceIn = clip.sourceIn + (start - clip.timelineStart);
      const sourceOut = clip.sourceOut + (end - clip.timelineEnd);
      const overlaps = current.some((other) => other.id !== id && other.trackId === clip.trackId && end > other.timelineStart && start < other.timelineEnd);
      if (overlaps) return current;
      return sortAudioClips(current.map((value) => value.id === id ? {
        ...value,
        timelineStart: start,
        timelineEnd: end,
        sourceIn,
        sourceOut,
        fadeInDuration: Math.min(value.fadeInDuration ?? 0, end - start),
        fadeOutDuration: Math.min(value.fadeOutDuration ?? 0, end - start),
      } : value));
    });
  };

  const splitAudioClip = (id: string, time: number) => {
    setAudioClips((current) => {
      const clip = current.find((value) => value.id === id);
      if (!clip || time <= clip.timelineStart + MIN_AUDIO_CLIP_DURATION || time >= clip.timelineEnd - MIN_AUDIO_CLIP_DURATION) return current;
      const sourceSplit = clip.sourceIn + (time - clip.timelineStart);
      const rightId = crypto.randomUUID();
      const left = { ...clip, timelineEnd: time, sourceOut: sourceSplit, fadeOutDuration: 0 };
      const right = { ...clip, id: rightId, timelineStart: time, sourceIn: sourceSplit, fadeInDuration: 0 };
      window.requestAnimationFrame(() => {
        setSelectedAudioClipId(rightId);
        setSelectedAudioClipIds([rightId]);
      });
      return sortAudioClips(current.flatMap((value) => value.id === id ? [left, right] : [value]));
    });
  };

  const insertAudioClipFromMedia = (asset: ProjectMediaAsset, requestedStart: number, requestedTrackId: TimelineTrackId) => {
    if (asset.duration <= 0) return null;
    const id = crypto.randomUUID();
    const trackId = normalizeAudioTrackId(requestedTrackId);
    setAudioClips((current) => {
      const start = rippleMode
        ? Math.max(0, requestedStart)
        : findNextAvailableStart(current, trackId, requestedStart, asset.duration);
      const clip: AudioTimelineClip = {
        id,
        kind: "audio",
        trackId,
        sourceId: asset.id,
        sourcePath: asset.path,
        sourceName: asset.name,
        sourceIn: 0,
        sourceOut: asset.duration,
        sourceDuration: asset.duration,
        volume: 100,
        muted: false,
        fadeInDuration: 0,
        fadeOutDuration: 0,
        timelineStart: start,
        timelineEnd: start + asset.duration,
      };
      window.requestAnimationFrame(() => {
        setSelectedAudioClipId(id);
        setSelectedAudioClipIds([id]);
      });
      if (!rippleMode) return sortAudioClips([...current, clip]);
      const opened = splitForInsert(current, trackId, start, asset.duration);
      return sortAudioClips([...opened, clip]);
    });
    return id;
  };

  const insertAudioClipCopies = (sourceClips: AudioTimelineClip[], requestedStart: number, requestedTrackId?: TimelineTrackId) => {
    if (sourceClips.length === 0) return [] as string[];
    const sourceTracks = [...new Set(sourceClips.map((clip) => clip.trackId))];
    const groupStart = Math.min(...sourceClips.map((clip) => clip.timelineStart));
    const groupEnd = Math.max(...sourceClips.map((clip) => clip.timelineEnd));
    const groupDuration = groupEnd - groupStart;
    const targetTrack = requestedTrackId && sourceTracks.length === 1 ? normalizeAudioTrackId(requestedTrackId) : undefined;
    const ids = sourceClips.map(() => crypto.randomUUID());
    setAudioClips((current) => {
      let baseStart = Math.max(0, requestedStart);
      if (!rippleMode) {
        let shift = baseStart - groupStart;
        for (const clip of sourceClips) {
          const trackId = targetTrack ?? clip.trackId;
          const legal = findNextAvailableStart(current, trackId, clip.timelineStart + shift, clip.timelineEnd - clip.timelineStart);
          shift = Math.max(shift, legal - clip.timelineStart);
        }
        baseStart = groupStart + shift;
      }
      let working = current;
      if (rippleMode) {
        const tracks = targetTrack ? [targetTrack] : sourceTracks;
        for (const trackId of tracks) working = splitForInsert(working, trackId, baseStart, groupDuration);
      }
      const copies = sourceClips.map((clip, index) => ({
        ...clip,
        id: ids[index],
        linkedVideoClipId: undefined,
        trackId: targetTrack ?? clip.trackId,
        timelineStart: baseStart + (clip.timelineStart - groupStart),
        timelineEnd: baseStart + (clip.timelineEnd - groupStart),
      }));
      window.requestAnimationFrame(() => {
        setSelectedAudioClipIds(ids);
        setSelectedAudioClipId(ids[0] ?? null);
      });
      return sortAudioClips([...working, ...copies]);
    });
    return ids;
  };

  const deleteAudioClips = (ids: string[]) => {
    const removed = new Set(ids);
    setAudioClips((current) => rippleMode ? rippleDelete(current, removed) : current.filter((clip) => !removed.has(clip.id)));
    setSelectedAudioClipIds((current) => current.filter((id) => !removed.has(id)));
    setSelectedAudioClipId((current) => current && removed.has(current) ? null : current);
  };

  const deleteAudioTrack = (trackId: TimelineTrackId) => {
    setAudioClips((current) => current.filter((clip) => clip.trackId !== trackId));
    clearAudioClipSelection();
  };

  const updateAudioClip = (id: string, patch: { volume?: number; muted?: boolean; fadeInDuration?: number; fadeOutDuration?: number }) => {
    setAudioClips((current) => current.map((clip) => {
      if (clip.id !== id) return clip;
      const duration = Math.max(MIN_AUDIO_CLIP_DURATION, clip.timelineEnd - clip.timelineStart);
      return {
        ...clip,
        volume: patch.volume === undefined ? clip.volume ?? 100 : Math.max(0, Math.min(100, patch.volume)),
        muted: patch.muted === undefined ? clip.muted ?? false : patch.muted,
        fadeInDuration: patch.fadeInDuration === undefined ? clip.fadeInDuration ?? 0 : Math.max(0, Math.min(duration, patch.fadeInDuration)),
        fadeOutDuration: patch.fadeOutDuration === undefined ? clip.fadeOutDuration ?? 0 : Math.max(0, Math.min(duration, patch.fadeOutDuration)),
      };
    }));
  };

  return {
    audioClips,
    selectedAudioClipId,
    selectedAudioClipIds,
    selectedAudioClip,
    selectAudioClip,
    selectAudioClips,
    clearAudioClipSelection,
    beginAudioClipMove,
    endAudioClipMove,
    moveAudioClip,
    moveAudioClipToTrack,
    resizeAudioClip,
    splitAudioClip,
    insertAudioClipFromMedia,
    insertAudioClipCopies,
    deleteAudioClips,
    deleteAudioTrack,
    updateAudioClip,
    replaceAudioClips,
  };
}
