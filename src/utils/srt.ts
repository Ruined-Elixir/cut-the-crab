import type { Subtitle } from "../types/subtitle";

const parseTimestamp = (timestamp: string) => {
  const [hours, minutes, rest] = timestamp.split(":");
  const [seconds, milliseconds] = rest.split(",");

  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(milliseconds) / 1000
  );
};

const formatTimestamp = (time: number) => {
  const hours = Math.floor(time / 3600);
  const minutes = Math.floor((time % 3600) / 60);
  const seconds = Math.floor(time % 60);
  const milliseconds = Math.floor((time % 1) * 1000);

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")},${milliseconds
    .toString()
    .padStart(3, "0")}`;
};

export const parseSrt = (content: string): Subtitle[] => {
  const blocks = content
    .trim()
    .split(/\r?\n\r?\n/);

  const subtitles: Subtitle[] = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);

    if (lines.length < 3) {
      continue;
    }

    const timingLine = lines[1];
    const [start, end] = timingLine.split(" --> ");

    if (!start || !end) {
      continue;
    }

    const subtitle: Subtitle = {
      id: crypto.randomUUID(),
      startTime: parseTimestamp(start.trim()),
      endTime: parseTimestamp(end.trim()),
      text: lines.slice(2).join("\n"),
    };

    subtitles.push(subtitle);
  }

  return subtitles;
};

export const generateSrt = (subtitles: Subtitle[]) => {
  return subtitles
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
    .map((subtitle, index) => {
      return [
        index + 1,
        `${formatTimestamp(subtitle.startTime)} --> ${formatTimestamp(
          subtitle.endTime
        )}`,
        subtitle.text,
      ].join("\n");
    })
    .join("\n\n");
};