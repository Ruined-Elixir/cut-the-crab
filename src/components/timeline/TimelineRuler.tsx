type TimelineRulerProps = {
  duration: number;
  zoom: number;
};

function getMarkerInterval(duration: number, zoom: number) {
  const visibleDuration = duration / zoom;

  if (visibleDuration <= 15) return 1;
  if (visibleDuration <= 30) return 2;
  if (visibleDuration <= 60) return 5;
  if (visibleDuration <= 120) return 10;
  if (visibleDuration <= 300) return 30;

  return 60;
}

function TimelineRuler({ duration, zoom }: TimelineRulerProps) {
  const interval = getMarkerInterval(duration, zoom);

  const markerTimes: number[] = [];

  for (let time = 0; time <= duration; time += interval) {
    markerTimes.push(time);
  }

  const lastMarker = markerTimes[markerTimes.length - 1];

  if (duration > 0 && Math.abs(lastMarker - duration) > 0.001) {
    markerTimes.push(duration);
  }

  return (
    <div className="timeline-ruler">
      {markerTimes.map((time, index) => {
        const position = duration > 0 ? (time / duration) * 100 : 0;

        const label = time % 1 === 0 ? `${time}s` : `${time.toFixed(1)}s`;

        return (
          <div
            key={`${time}-${index}`}
            className="timeline-marker"
            style={{
              left: `${position}%`,
            }}
          >
            <span>{label}</span>
            <div className="timeline-tick" />
          </div>
        );
      })}
    </div>
  );
}

export default TimelineRuler;
