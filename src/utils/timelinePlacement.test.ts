import { describe, expect, it } from "vitest";
import { findPlanConflicts, isVideoRangeFree, planVideoPlacement, snapPlacementRange } from "./timelinePlacement";
import type { VideoTimelineClip } from "../types/timelineModel";

function clip(trackId: string, start: number, end: number): VideoTimelineClip {
  return { id: `${trackId}:${start}`, kind: "video", trackId, timelineStart: start, timelineEnd: end } as VideoTimelineClip;
}
const settings = {
  "video-1": { locked: false, hidden: false, linkedTrackId: "audio-1" },
  "audio-1": { locked: true, linkedTrackId: "video-1" },
};
function plan(clips: VideoTimelineClip[], start: number, duration: number, extraSettings = {}) {
  const input = {
    videoClips: clips, audioClips: [], adjustmentLayers: [], trackSettings: { ...settings, ...extraSettings },
    items: [{ key: "new", sourceTrackId: "video-1", start, duration }], preferredTrackId: "video-1",
  };
  return { input, result: planVideoPlacement(input) };
}
describe("exact-time free-track placement", () => {
  it("snaps a requested start to the frame grid", () => {
    expect(snapPlacementRange(1.01, 1).start).toBeCloseTo(1);
  });
  it("uses V1 when no clip overlaps", () => {
    const { input, result } = plan([], 2, 3);
    expect(result.assignments[0]).toMatchObject({ trackId: "video-1", start: 2, end: 5 });
    expect(result.newTracks).toHaveLength(0);
    expect(findPlanConflicts(input, result)).toEqual([]);
  });
  it("reuses another available linked video track", () => {
    const { result } = plan([clip("video-1", 0, 10)], 2, 3, {
      "video-2": { locked: false, hidden: false, linkedTrackId: "audio-2" },
      "audio-2": { locked: true, linkedTrackId: "video-2" },
    });
    expect(result.assignments[0]).toMatchObject({ trackId: "video-2", start: 2 });
    expect(result.newTracks).toHaveLength(0);
  });
  it("creates a linked pair only if all eligible tracks overlap", () => {
    const { input, result } = plan([clip("video-1", 0, 10)], 2, 3);
    expect(result.assignments[0].start).toBe(2);
    expect(result.newTracks).toEqual([{ videoTrackId: "video-2", audioTrackId: "audio-2" }]);
    expect(findPlanConflicts(input, result)).toEqual([]);
  });
  it("treats adjacent boundaries as free", () => {
    expect(isVideoRangeFree([clip("video-1", 0, 5)], [], "video-1", 5, 7)).toBe(true);
  });
  it("skips locked tracks", () => {
    const { result } = plan([clip("video-1", 0, 10)], 2, 1, {
      "video-2": { locked: true, linkedTrackId: "audio-2" },
      "audio-2": { locked: true, linkedTrackId: "video-2" },
    });
    expect(result.assignments[0].trackId).toBe("video-3");
  });
});

describe("exact-time grouped placement", () => {
  it("keeps clips from the same source track together when the original track is blocked", () => {
    const input = {
      videoClips: [clip("video-1", 0, 10), clip("video-2", 5, 5.5)],
      audioClips: [], adjustmentLayers: [],
      trackSettings: {
        ...settings,
        "video-2": { locked: false, hidden: false, linkedTrackId: "audio-2" },
        "audio-2": { locked: true, linkedTrackId: "video-2" },
      },
      items: [
        { key: "first", sourceTrackId: "video-1", start: 1, duration: 2 },
        { key: "second", sourceTrackId: "video-1", start: 4, duration: 2 },
      ],
      preferredTrackId: "video-1",
    };
    const result = planVideoPlacement(input);
    expect(result.assignments.map(item => item.trackId)).toEqual(["video-3", "video-3"]);
    expect(result.newTracks).toHaveLength(1);
    expect(findPlanConflicts(input, result)).toEqual([]);
  });
  it("retargets a same-track group without changing its spacing", () => {
    const input = {
      videoClips: [], audioClips: [], adjustmentLayers: [],
      trackSettings: { ...settings,
        "video-2": { locked: false, linkedTrackId: "audio-2" },
        "audio-2": { locked: true, linkedTrackId: "video-2" },
      },
      items: [
        { key: "first", sourceTrackId: "video-1", start: 1, duration: 2 },
        { key: "second", sourceTrackId: "video-1", start: 4, duration: 2 },
      ],
      preferredTrackId: "video-2",
    };
    const result = planVideoPlacement(input);
    expect(result.assignments.map(item => item.trackId)).toEqual(["video-2", "video-2"]);
    expect(result.assignments.map(item => item.start)).toEqual([1, 4]);
  });
});
