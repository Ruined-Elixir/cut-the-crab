import { useEffect, useMemo, useState } from "react";

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

  const selectSubtitle = (id: string) => {
    setSelectedSubtitleId(id);
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

    setSelectedSubtitleId(subtitle.id);
  };

  const deleteSubtitle = (id: string) => {
    setSubtitles((current) => current.filter((subtitle) => subtitle.id !== id));

    setSelectedSubtitleId((selectedId) =>
      selectedId === id ? null : selectedId,
    );
  };

  const replaceSubtitles = (nextSubtitles: Subtitle[]) => {
    setSubtitles(sortSubtitles(nextSubtitles));

    setSelectedSubtitleId(null);
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

    setSelectedSubtitleId(generated[0]?.id ?? null);
  };

  // Delete selected subtitle with keyboard
  useEffect(() => {
    const handleDeleteKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;

      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedSubtitleId
      ) {
        deleteSubtitle(selectedSubtitleId);
      }
    };

    window.addEventListener("keydown", handleDeleteKey);

    return () => {
      window.removeEventListener("keydown", handleDeleteKey);
    };
  }, [selectedSubtitleId]);

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
    subtitleSearch,
    activeSubtitleId,

    setSubtitleSearch,
    selectSubtitle,

    updateSubtitleText,
    updateSubtitlePosition,
    updateSubtitleStyle,
    updateAllSubtitleStyles,

    moveSubtitle,
    resizeSubtitle,
    addSubtitle,
    deleteSubtitle,
    replaceSubtitles,
    replaceWithGeneratedSubtitles,
  };
}
