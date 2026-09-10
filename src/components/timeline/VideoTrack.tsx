import type {
  TimelineTrack,
  VideoTimelineClip,
} from "../../types/timelineModel";

import TimelineTrackLabel from "./TimelineTrackLabel";

type VideoTrackProps = {
  duration: number;
  track: TimelineTrack;
  onSeek?: (time: number) => void;
};

function VideoTrack({
  duration,
  track,
  onSeek,
}: VideoTrackProps) {
  const clip = track.clips.find(
    (item): item is VideoTimelineClip =>
      item.kind === "video",
  );

  const handleClick = (
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    if (duration <= 0) {
      return;
    }

    const rect =
      event.currentTarget.getBoundingClientRect();

    const ratio =
      (event.clientX - rect.left) / rect.width;

    onSeek?.(
      Math.max(
        0,
        Math.min(duration, ratio * duration),
      ),
    );
  };

  return (
    <div className="timeline-row timeline-video-row">
      <TimelineTrackLabel
        shortLabel={track.shortLabel}
        name={track.name}
        locked={track.locked}
      />

      <div
        className="video-track"
        onClick={handleClick}
      >
        {clip ? (
          <div
            className="timeline-video-clip"
            style={{
              left: `${
                duration > 0
                  ? (clip.timelineStart / duration) * 100
                  : 0
              }%`,
              width: `${
                duration > 0
                  ? ((clip.timelineEnd -
                      clip.timelineStart) /
                      duration) *
                    100
                  : 0
              }%`,
            }}
            title={clip.sourceName}
          >
            <div className="timeline-video-filmstrip">
              {Array.from({ length: 12 }).map(
                (_, index) => (
                  <span key={index} />
                ),
              )}
            </div>

            <span className="timeline-video-clip-name">
              {clip.sourceName}
            </span>
          </div>
        ) : (
          <span className="timeline-empty-track">
            No video
          </span>
        )}
      </div>
    </div>
  );
}

export default VideoTrack;
