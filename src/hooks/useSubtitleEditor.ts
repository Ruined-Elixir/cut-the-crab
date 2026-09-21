import { useMemo, useRef, useState } from "react";

import {
  DEFAULT_SUBTITLE_TRACK_ID,
  getSubtitleTrackId,
  type Subtitle,
  type SubtitleStyle,
} from "../types/subtitle";

const INITIAL_SUBTITLES: Subtitle[] = [
  {
    id: "1",
    trackId: DEFAULT_SUBTITLE_TRACK_ID,
    startTime: 1.2,
    endTime: 3.8,
    text: "Hello everyone",
  },
  {
    id: "2",
    trackId: DEFAULT_SUBTITLE_TRACK_ID,
    startTime: 4.5,
    endTime: 7.1,
    text: "This is a subtitle test",
  },
];

function subtitleTrackIndex(trackId: string) {
  const match = /^subtitle-(\d+)$/.exec(trackId);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function sortSubtitles(subtitles: Subtitle[]) {
  return [...subtitles].sort(
    (a, b) =>
      a.startTime - b.startTime ||
      subtitleTrackIndex(getSubtitleTrackId(a)) -
        subtitleTrackIndex(getSubtitleTrackId(b)) ||
      a.endTime - b.endTime,
  );
}

function clampStartAgainstTrackCollisions(
  subtitles: Subtitle[],
  movingId: string,
  targetTrackId: string,
  requestedStart: number,
  subtitleDuration: number,
  timelineDuration: number,
) {
  let start = Math.max(
    0,
    Math.min(Math.max(0, timelineDuration - subtitleDuration), requestedStart),
  );

  const obstacles = subtitles
    .filter(
      (subtitle) =>
        subtitle.id !== movingId &&
        getSubtitleTrackId(subtitle) === targetTrackId,
    )
    .sort((a, b) => a.startTime - b.startTime);

  for (const obstacle of obstacles) {
    const end = start + subtitleDuration;

    if (end <= obstacle.startTime || start >= obstacle.endTime) {
      continue;
    }

    const left = obstacle.startTime - subtitleDuration;
    const right = obstacle.endTime;
    const candidate =
      Math.abs(requestedStart - left) <= Math.abs(requestedStart - right)
        ? left
        : right;

    start = Math.max(
      0,
      Math.min(Math.max(0, timelineDuration - subtitleDuration), candidate),
    );
  }

  return start;
}

export function useSubtitleEditor(currentTime: number, videoDuration: number) {
  const [subtitles, setSubtitles] = useState<Subtitle[]>(INITIAL_SUBTITLES);
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(
    null,
  );
  const [selectedSubtitleIds, setSelectedSubtitleIds] = useState<string[]>([]);
  const selectionAnchorIdRef = useRef<string | null>(null);
  const [subtitleSearch, setSubtitleSearch] = useState("");

  const filteredSubtitles = useMemo(() => {
    const query = subtitleSearch.trim().toLowerCase();

    if (!query) {
      return subtitles;
    }

    return subtitles.filter((subtitle) =>
      subtitle.text.toLowerCase().includes(query),
    );
  }, [subtitles, subtitleSearch]);

  const activeSubtitleId =
    subtitles.find(
      (subtitle) =>
        currentTime >= subtitle.startTime && currentTime <= subtitle.endTime,
    )?.id ?? null;

  type SelectionMode = "single" | "toggle" | "range";

  const selectSubtitle = (
    id: string,
    mode: SelectionMode = "single",
    eligibleIds?: ReadonlySet<string>,
  ) => {
    if (eligibleIds && !eligibleIds.has(id)) {
      return;
    }

    if (mode === "toggle") {
      setSelectedSubtitleIds((current) => {
        const isSelected = current.includes(id);
        const next = isSelected
          ? current.filter((selectedId) => selectedId !== id)
          : [...current, id];

        setSelectedSubtitleId(
          next.includes(id) ? id : (next[next.length - 1] ?? null),
        );

        return next;
      });

      selectionAnchorIdRef.current = id;
      return;
    }

    if (mode === "range") {
      const target = subtitles.find((subtitle) => subtitle.id === id);
      const targetTrackId = target
        ? getSubtitleTrackId(target)
        : DEFAULT_SUBTITLE_TRACK_ID;
      const orderedIds = sortSubtitles(
        subtitles.filter(
          (subtitle) =>
            getSubtitleTrackId(subtitle) === targetTrackId &&
            (!eligibleIds || eligibleIds.has(subtitle.id)),
        ),
      ).map((subtitle) => subtitle.id);

      const anchorCandidate =
        selectionAnchorIdRef.current ?? selectedSubtitleId ?? id;
      const anchor = subtitles.find(
        (subtitle) => subtitle.id === anchorCandidate,
      );
      const anchorId =
        anchor && getSubtitleTrackId(anchor) === targetTrackId
          ? anchorCandidate
          : id;

      const anchorIndex = orderedIds.indexOf(anchorId);
      const targetIndex = orderedIds.indexOf(id);

      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        const rangeIds = orderedIds.slice(start, end + 1);

        setSelectedSubtitleIds(rangeIds);
        setSelectedSubtitleId(id);
        selectionAnchorIdRef.current = anchorId;
        return;
      }
    }

    setSelectedSubtitleIds([id]);
    setSelectedSubtitleId(id);
    selectionAnchorIdRef.current = id;
  };

  const selectAllSubtitles = (
    trackId?: string,
    eligibleIds?: ReadonlySet<string>,
  ) => {
    const orderedIds = sortSubtitles(
      subtitles.filter(
        (subtitle) =>
          (!trackId || getSubtitleTrackId(subtitle) === trackId) &&
          (!eligibleIds || eligibleIds.has(subtitle.id)),
      ),
    ).map((subtitle) => subtitle.id);

    setSelectedSubtitleIds(orderedIds);
    setSelectedSubtitleId(orderedIds[0] ?? null);
    selectionAnchorIdRef.current = orderedIds[0] ?? null;
  };

  const selectSubtitles = (ids: string[], primaryId?: string | null) => {
    const uniqueIds = [...new Set(ids)].filter((id) =>
      subtitles.some((subtitle) => subtitle.id === id),
    );
    const nextPrimaryId =
      primaryId && uniqueIds.includes(primaryId)
        ? primaryId
        : (uniqueIds[0] ?? null);

    setSelectedSubtitleIds(uniqueIds);
    setSelectedSubtitleId(nextPrimaryId);
    selectionAnchorIdRef.current = nextPrimaryId;
  };

  const focusSelectedSubtitle = (id: string) => {
    if (!selectedSubtitleIds.includes(id)) {
      return;
    }

    setSelectedSubtitleId(id);
  };

  const nudgeSelectedSubtitles = (requestedDelta: number) => {
    if (selectedSubtitleIds.length === 0 || requestedDelta === 0) {
      return;
    }

    const selectedIds = new Set(selectedSubtitleIds);

    setSubtitles((current) => {
      const selected = current.filter((subtitle) =>
        selectedIds.has(subtitle.id),
      );

      if (selected.length === 0) {
        return current;
      }

      const unselected = current.filter(
        (subtitle) => !selectedIds.has(subtitle.id),
      );
      const minStart = Math.min(
        ...selected.map((subtitle) => subtitle.startTime),
      );
      const maxEnd = Math.max(...selected.map((subtitle) => subtitle.endTime));

      let minimumDelta = -minStart;
      let maximumDelta =
        videoDuration > 0 ? videoDuration - maxEnd : Number.POSITIVE_INFINITY;

      if (requestedDelta > 0) {
        for (const moving of selected) {
          const trackId = getSubtitleTrackId(moving);
          for (const obstacle of unselected) {
            if (
              getSubtitleTrackId(obstacle) === trackId &&
              obstacle.startTime >= moving.endTime
            ) {
              maximumDelta = Math.min(
                maximumDelta,
                obstacle.startTime - moving.endTime,
              );
            }
          }
        }
      } else {
        for (const moving of selected) {
          const trackId = getSubtitleTrackId(moving);
          for (const obstacle of unselected) {
            if (
              getSubtitleTrackId(obstacle) === trackId &&
              obstacle.endTime <= moving.startTime
            ) {
              minimumDelta = Math.max(
                minimumDelta,
                obstacle.endTime - moving.startTime,
              );
            }
          }
        }
      }

      const safeDelta = Math.max(
        minimumDelta,
        Math.min(maximumDelta, requestedDelta),
      );

      if (Math.abs(safeDelta) < 0.000001) {
        return current;
      }

      return sortSubtitles(
        current.map((subtitle) =>
          selectedIds.has(subtitle.id)
            ? {
                ...subtitle,
                startTime: subtitle.startTime + safeDelta,
                endTime: subtitle.endTime + safeDelta,
              }
            : subtitle,
        ),
      );
    });
  };

  const clearSubtitleSelection = () => {
    setSelectedSubtitleIds([]);
    setSelectedSubtitleId(null);
    selectionAnchorIdRef.current = null;
  };

  const updateSubtitleText = (id: string, text: string) => {
    setSubtitles((current) =>
      current.map((subtitle) =>
        subtitle.id === id ? { ...subtitle, text } : subtitle,
      ),
    );
  };

  const updateSubtitlePosition = (
    id: string,
    positionX: number,
    positionY: number,
  ) => {
    setSubtitles((current) =>
      current.map((subtitle) =>
        subtitle.id === id ? { ...subtitle, positionX, positionY } : subtitle,
      ),
    );
  };

  const moveSubtitle = (id: string, newStartTime: number) => {
    setSubtitles((current) =>
      sortSubtitles(
        current.map((subtitle) => {
          if (subtitle.id !== id) {
            return subtitle;
          }

          const duration = subtitle.endTime - subtitle.startTime;

          return {
            ...subtitle,
            startTime: newStartTime,
            endTime: newStartTime + duration,
          };
        }),
      ),
    );
  };

  const moveSubtitleToTrack = (
    id: string,
    targetTrackId: string,
    requestedStartTime: number,
  ) => {
    if (!/^subtitle-\d+$/.test(targetTrackId)) {
      return;
    }

    setSubtitles((current) => {
      const target = current.find((subtitle) => subtitle.id === id);
      if (!target) return current;

      const duration = target.endTime - target.startTime;
      const safeStart = clampStartAgainstTrackCollisions(
        current,
        id,
        targetTrackId,
        requestedStartTime,
        duration,
        Math.max(videoDuration, requestedStartTime + duration),
      );

      return sortSubtitles(
        current.map((subtitle) =>
          subtitle.id === id
            ? {
                ...subtitle,
                trackId: targetTrackId,
                startTime: safeStart,
                endTime: safeStart + duration,
              }
            : subtitle,
        ),
      );
    });
  };

  const moveSubtitleGroup = (
    ids: string[],
    anchorId: string,
    newAnchorStartTime: number,
  ) => {
    const selectedIds = new Set(ids);

    setSubtitles((current) => {
      const anchor = current.find((subtitle) => subtitle.id === anchorId);

      if (!anchor) {
        return current;
      }

      const delta = newAnchorStartTime - anchor.startTime;

      return sortSubtitles(
        current.map((subtitle) =>
          selectedIds.has(subtitle.id)
            ? {
                ...subtitle,
                startTime: subtitle.startTime + delta,
                endTime: subtitle.endTime + delta,
              }
            : subtitle,
        ),
      );
    });
  };

  const resizeSubtitle = (
    id: string,
    newStartTime: number,
    newEndTime: number,
  ) => {
    setSubtitles((current) =>
      sortSubtitles(
        current.map((subtitle) =>
          subtitle.id === id
            ? {
                ...subtitle,
                startTime: newStartTime,
                endTime: newEndTime,
              }
            : subtitle,
        ),
      ),
    );
  };

  const addSubtitle = (
    startTime: number,
    trackId = DEFAULT_SUBTITLE_TRACK_ID,
  ) => {
    const safeStart = Math.max(
      0,
      Math.min(startTime, videoDuration || startTime),
    );
    const endTime =
      videoDuration > 0
        ? Math.min(videoDuration, safeStart + 2)
        : safeStart + 2;

    const subtitle: Subtitle = {
      id: crypto.randomUUID(),
      trackId,
      startTime: safeStart,
      endTime,
      text: "New subtitle",
    };

    setSubtitles((current) => sortSubtitles([...current, subtitle]));
    setSelectedSubtitleIds([subtitle.id]);
    setSelectedSubtitleId(subtitle.id);
    selectionAnchorIdRef.current = subtitle.id;
  };

  const splitSubtitle = (id: string, splitTime: number) => {
    const MIN_SPLIT_GAP = 0.05;

    setSubtitles((current) => {
      const target = current.find((subtitle) => subtitle.id === id);

      if (!target) {
        return current;
      }

      const safeSplitTime = Math.max(
        target.startTime + MIN_SPLIT_GAP,
        Math.min(target.endTime - MIN_SPLIT_GAP, splitTime),
      );

      if (
        safeSplitTime <= target.startTime ||
        safeSplitTime >= target.endTime
      ) {
        return current;
      }

      const secondSubtitle: Subtitle = {
        ...target,
        id: crypto.randomUUID(),
        startTime: safeSplitTime,
        endTime: target.endTime,
      };
      const firstSubtitle: Subtitle = {
        ...target,
        endTime: safeSplitTime,
      };

      const next = current.flatMap((subtitle) =>
        subtitle.id === id ? [firstSubtitle, secondSubtitle] : [subtitle],
      );

      window.requestAnimationFrame(() => {
        setSelectedSubtitleIds([secondSubtitle.id]);
        setSelectedSubtitleId(secondSubtitle.id);
        selectionAnchorIdRef.current = secondSubtitle.id;
      });

      return sortSubtitles(next);
    });
  };

  const deleteSubtitles = (ids: string[]) => {
    const idsToDelete = new Set(ids);

    setSubtitles((current) =>
      current.filter((subtitle) => !idsToDelete.has(subtitle.id)),
    );
    setSelectedSubtitleIds((current) =>
      current.filter((id) => !idsToDelete.has(id)),
    );
    setSelectedSubtitleId((current) =>
      current && idsToDelete.has(current) ? null : current,
    );
    selectionAnchorIdRef.current = null;
  };

  const replaceSubtitles = (nextSubtitles: Subtitle[]) => {
    setSubtitles(
      sortSubtitles(
        nextSubtitles.map((subtitle) => ({
          ...subtitle,
          trackId: getSubtitleTrackId(subtitle),
        })),
      ),
    );
    clearSubtitleSelection();
  };

  const replaceWithGeneratedSubtitles = (
    segments: { startTime: number; endTime: number; text: string }[],
    trackId = DEFAULT_SUBTITLE_TRACK_ID,
  ) => {
    const generated: Subtitle[] = segments.map((segment) => ({
      id: crypto.randomUUID(),
      trackId,
      startTime: segment.startTime,
      endTime: segment.endTime,
      text: segment.text,
    }));

    setSubtitles((current) =>
      sortSubtitles([
        ...current.filter(
          (subtitle) => getSubtitleTrackId(subtitle) !== trackId,
        ),
        ...generated,
      ]),
    );

    const firstId = generated[0]?.id ?? null;
    setSelectedSubtitleIds(firstId ? [firstId] : []);
    setSelectedSubtitleId(firstId);
    selectionAnchorIdRef.current = firstId;
  };

  const updateSubtitleStyle = (id: string, style: SubtitleStyle) => {
    setSubtitles((current) =>
      current.map((subtitle) =>
        subtitle.id === id ? { ...subtitle, ...style } : subtitle,
      ),
    );
  };

  const updateSubtitleStyles = (ids: string[], style: SubtitleStyle) => {
    const selectedIds = new Set(ids);

    setSubtitles((current) =>
      current.map((subtitle) =>
        selectedIds.has(subtitle.id) ? { ...subtitle, ...style } : subtitle,
      ),
    );
  };

  const updateAllSubtitleStyles = (style: SubtitleStyle) => {
    setSubtitles((current) =>
      current.map((subtitle) => ({ ...subtitle, ...style })),
    );
  };

  return {
    subtitles,
    filteredSubtitles,
    selectedSubtitleId,
    selectedSubtitleIds,
    subtitleSearch,
    activeSubtitleId,

    setSubtitleSearch,
    selectSubtitle,
    selectSubtitles,
    selectAllSubtitles,
    focusSelectedSubtitle,
    clearSubtitleSelection,

    updateSubtitleText,
    updateSubtitlePosition,
    updateSubtitleStyle,
    updateSubtitleStyles,
    updateAllSubtitleStyles,

    moveSubtitle,
    moveSubtitleToTrack,
    moveSubtitleGroup,
    nudgeSelectedSubtitles,
    resizeSubtitle,
    addSubtitle,
    splitSubtitle,
    deleteSubtitles,
    replaceSubtitles,
    replaceWithGeneratedSubtitles,
  };
}
