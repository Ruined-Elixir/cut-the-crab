export function formatPlaybackTime(
  time: number
) {
  if (!Number.isFinite(time) || time < 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(time);

  const hours = Math.floor(
    totalSeconds / 3600
  );

  const minutes = Math.floor(
    (totalSeconds % 3600) / 60
  );

  const seconds =
    totalSeconds % 60;

  if (hours > 0) {
    return `${hours
      .toString()
      .padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes
    .toString()
    .padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

export function formatSubtitleTime(
  time: number
) {
  return formatPlaybackTime(time);
}