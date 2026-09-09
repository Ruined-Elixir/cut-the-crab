import { useMemo, useRef, useState } from "react";

import type { Subtitle, SubtitleStyle } from "../types/subtitle";

const INITIAL_SUBTITLES: Subtitle[] = [
  {
    id: "1",
    startTime: 1.2,
    endTime: 3.8,
    text: "Hello everyone",
  },
  {
    id: "2",
    startTime: 4.5,
    endTime: 7.1,
    text: "This is a subtitle test",
  },
];

function sortSubtitles(subtitles: Subtitle[]) {
  return [...subtitles].sort((a, b) => a.startTime - b.startTime);
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
  ) => {
    if (mode === "toggle") {
      setSelectedSubtitleIds((current) => {
        const isSelected = current.includes(id);
        const next = isSelected
          ? current.filter((selectedId) => selectedId !== id)
          : [...current, id];

        setSelectedSubtitleId(
          next.includes(id)
            ? id
            : next[next.length - 1] ?? null,
        );

        return next;
      });

      selectionAnchorIdRef.current = id;
      return;
    }

    if (mode === "range") {
      const orderedIds = sortSubtitles(subtitles).map(
        (subtitle) => subtitle.id,
      );

      const anchorId =
        selectionAnchorIdRef.current ?? selectedSubtitleId ?? id;

      const anchorIndex = orderedIds.indexOf(anchorId);
      const targetIndex = orderedIds.indexOf(id);

      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        const rangeIds = orderedIds.slice(start, end + 1);

        setSelectedSubtitleIds(rangeIds);
        setSelectedSubtitleId(id);
        return;
      }
    }

    setSelectedSubtitleIds([id]);
    setSelectedSubtitleId(id);
    selectionAnchorIdRef.current = id;
  };

  const selectAllSubtitles = () => {
    const orderedIds = sortSubtitles(subtitles).map(
      (subtitle) => subtitle.id,
    );

    setSelectedSubtitleIds(orderedIds);
    setSelectedSubtitleId(orderedIds[0] ?? null);
    selectionAnchorIdRef.current = orderedIds[0] ?? null;
  };

  const focusSelectedSubtitle = (id: string) => {
    if (!selectedSubtitleIds.includes(id)) {
      return;
    }

    setSelectedSubtitleId(id);
  };

  const nudgeSelectedSubtitles = (requestedDelta: number) => {
    if (
      selectedSubtitleIds.length === 0 ||
      requestedDelta === 0
    ) {
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

      const maxEnd = Math.max(
        ...selected.map((subtitle) => subtitle.endTime),
      );

      let minimumDelta = -minStart;
      let maximumDelta =
        videoDuration > 0
          ? videoDuration - maxEnd
          : Number.POSITIVE_INFINITY;

      if (requestedDelta > 0) {
        for (const moving of selected) {
          for (const obstacle of unselected) {
            if (obstacle.startTime >= moving.endTime) {
              maximumDelta = Math.min(
                maximumDelta,
                obstacle.startTime - moving.endTime,
              );
            }
          }
        }
      } else {
        for (const moving of selected) {
          for (const obstacle of unselected) {
            if (obstacle.endTime <= moving.startTime) {
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
        subtitle.id === id
          ? {
              ...subtitle,
              positionX,
              positionY,
            }
          : subtitle,
      ),
    );
  };

  const moveSubtitle = (id: string, newStartTime: number) => {
    setSubtitles((current) =>
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
    );
  };

  const moveSubtitleGroup = (
    ids: string[],
    anchorId: string,
    newAnchorStartTime: number,
  ) => {
    const selectedIds = new Set(ids);

    setSubtitles((current) => {
      const anchor = current.find(
        (subtitle) => subtitle.id === anchorId,
      );

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
      current.map((subtitle) =>
        subtitle.id === id
          ? {
              ...subtitle,
              startTime: newStartTime,
              endTime: newEndTime,
            }
          : subtitle,
      ),
    );
  };

  const addSubtitle = (startTime: number) => {
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
      startTime: safeStart,
      endTime,
      text: "New subtitle",
    };

    setSubtitles((current) => sortSubtitles([...current, subtitle]));

    setSelectedSubtitleIds([subtitle.id]);
    setSelectedSubtitleId(subtitle.id);
    selectionAnchorIdRef.current = subtitle.id;
  };

  const splitSubtitle = (
    id: string,
    splitTime: number,
  ) => {
    const MIN_SPLIT_GAP = 0.05;

    setSubtitles((current) => {
      const target = current.find(
        (subtitle) => subtitle.id === id,
      );

      if (!target) {
        return current;
      }

      const safeSplitTime = Math.max(
        target.startTime + MIN_SPLIT_GAP,
        Math.min(
          target.endTime - MIN_SPLIT_GAP,
          splitTime,
        ),
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
        subtitle.id === id
          ? [firstSubtitle, secondSubtitle]
          : [subtitle],
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

  const deleteSubtitle = (id: string) => {
    deleteSubtitles([id]);
  };

  const replaceSubtitles = (nextSubtitles: Subtitle[]) => {
    setSubtitles(sortSubtitles(nextSubtitles));

    clearSubtitleSelection();
  };

  const replaceWithGeneratedSubtitles = (
    segments: {
      startTime: number;
      endTime: number;
      text: string;
    }[],
  ) => {
    const generated: Subtitle[] = segments.map((segment) => ({
      id: crypto.randomUUID(),
      startTime: segment.startTime,
      endTime: segment.endTime,
      text: segment.text,
    }));

    setSubtitles(sortSubtitles(generated));

    const firstId = generated[0]?.id ?? null;

    setSelectedSubtitleIds(firstId ? [firstId] : []);
    setSelectedSubtitleId(firstId);
    selectionAnchorIdRef.current = firstId;
  };

  const updateSubtitleStyle = (id: string, style: SubtitleStyle) => {
    setSubtitles((current) =>
      current.map((subtitle) =>
        subtitle.id === id
          ? {
              ...subtitle,
              ...style,
            }
          : subtitle,
      ),
    );
  };

  const updateSubtitleStyles = (
    ids: string[],
    style: SubtitleStyle,
  ) => {
    const selectedIds = new Set(ids);

    setSubtitles((current) =>
      current.map((subtitle) =>
        selectedIds.has(subtitle.id)
          ? {
              ...subtitle,
              ...style,
            }
          : subtitle,
      ),
    );
  };

  const updateAllSubtitleStyles = (style: SubtitleStyle) => {
    setSubtitles((current) =>
      current.map((subtitle) => ({
        ...subtitle,
        ...style,
      })),
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
    selectAllSubtitles,
    focusSelectedSubtitle,
    clearSubtitleSelection,

    updateSubtitleText,
    updateSubtitlePosition,
    updateSubtitleStyle,
    updateSubtitleStyles,
    updateAllSubtitleStyles,

    moveSubtitle,
    moveSubtitleGroup,
    nudgeSelectedSubtitles,
    resizeSubtitle,
    addSubtitle,
    splitSubtitle,
    deleteSubtitle,
    deleteSubtitles,
    replaceSubtitles,
    replaceWithGeneratedSubtitles,
  };
}
