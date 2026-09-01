import type { Subtitle } from "../types/subtitle";

const parseTimestamp = (timestamp: string) => {
  const normalized =
    timestamp.trim().replace(".", ",");

  const [hours, minutes, rest] =
    normalized.split(":");

  if (!hours || !minutes || !rest) {
    return 0;
  }

  const [seconds, milliseconds = "0"] =
    rest.split(",");

  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(
      milliseconds
        .padEnd(3, "0")
        .slice(0, 3)
    ) /
      1000
  );
};

const formatTimestamp = (time: number) => {
  const safeTime = Math.max(0, time);

  const totalMilliseconds =
    Math.round(safeTime * 1000);

  const hours = Math.floor(
    totalMilliseconds / 3_600_000
  );

  const minutes = Math.floor(
    (totalMilliseconds % 3_600_000) /
      60_000
  );

  const seconds = Math.floor(
    (totalMilliseconds % 60_000) /
      1000
  );

  const milliseconds =
    totalMilliseconds % 1000;

  return `${hours
    .toString()
    .padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")},${milliseconds
    .toString()
    .padStart(3, "0")}`;
};

export const parseSrt = (
  content: string
): Subtitle[] => {
  const trimmed = content.trim();

  if (!trimmed) {
    return [];
  }

  const blocks =
    trimmed.split(/\r?\n\r?\n/);

  const subtitles: Subtitle[] = [];

  for (const block of blocks) {
    const lines =
      block.split(/\r?\n/);

    if (lines.length < 3) {
      continue;
    }

    const timingLine = lines[1];

    const [start, end] =
      timingLine.split(/\s+-->\s+/);

    if (!start || !end) {
      continue;
    }

    subtitles.push({
      id: crypto.randomUUID(),
      startTime: parseTimestamp(start),
      endTime: parseTimestamp(end),
      text: lines.slice(2).join("\n"),
    });
  }

  return subtitles.sort(
    (a, b) =>
      a.startTime - b.startTime
  );
};

export const generateSrt = (
  subtitles: Subtitle[]
) => {
  return [...subtitles]
    .sort(
      (a, b) =>
        a.startTime - b.startTime
    )
    .map((subtitle, index) => {
      const timing = [
        formatTimestamp(
          subtitle.startTime
        ),
        formatTimestamp(
          subtitle.endTime
        ),
      ].join(" --> ");

      return [
        index + 1,
        timing,
        subtitle.text,
      ].join("\n");
    })
    .join("\n\n");
};