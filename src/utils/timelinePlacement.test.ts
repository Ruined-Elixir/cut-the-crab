import { describe, expect, it } from "vitest";

import type {
  AdjustmentLayerClip,
  TimelineTrackSettings,
  VideoTimelineClip,
} from "../types/timelineModel";
import {
  findPlanConflicts,
  isVideoRangeFree,
  planVideoPlacement,
  snapPlacementRange,
  type PlacementInput,
} from "./timelinePlacement";

function clip(
  id: string,
  trackId: string,
  start: number,
  end: number,
  layer?: number,
): VideoTimelineClip {
  return {
    id,
    trackId,
    timelineStart: start,
    timelineEnd: end,
    ...(layer === undefined ? {} : { layer }),
  } as unknown as VideoTimelineClip;
}

function adjustment(
  id: string,
  trackId: string,
  start: number,
  end: number,
  layer?: number,
): AdjustmentLayerClip {
  return {
    id,
    trackId,
    timelineStart: start,
    timelineEnd: end,
    ...(layer === undefined ? {} : { layer }),
  } as unknown as AdjustmentLayerClip;
}

function baseSettings(
  overrides: Record<string, Record<string, unknown>> = {},
): TimelineTrackSettings {
  const settings: Record<string, Record<string, unknown>> = {
    "video-1": { locked: false, muted: false, solo: false, linkedTrackId: "audio-1", deleted: false },
    "audio-1": { locked: true, muted: false, solo: false, linkedTrackId: "video-1", deleted: false },
    "video-2": { locked: false, muted: false, solo: false, linkedTrackId: "audio-2", deleted: false },
    "audio-2": { locked: true, muted: false, solo: false, linkedTrackId: "video-2", deleted: false },
  };
  for (const [id, patch] of Object.entries(overrides)) {
    settings[id] = { ...settings[id], ...patch };
  }
  return settings as unknown as TimelineTrackSettings;
}

function input(options: {
  clips?: VideoTimelineClip[];
  adjustments?: AdjustmentLayerClip[];
  settings?: TimelineTrackSettings;
  start: number;
  duration: number;
  track: string;
}): PlacementInput {
  return {
    videoClips: options.clips ?? [],
    audioClips: [],
    adjustmentLayers: options.adjustments ?? [],
    trackSettings: options.settings ?? baseSettings(),
    items: [
      {
        key: "new",
        sourceTrackId: options.track,
        start: options.start,
        duration: options.duration,
      },
    ],
    preferredTrackId: options.track,
  };
}

function plan(options: Parameters<typeof input>[0]) {
  return planVideoPlacement(input(options));
}

describe("planVideoPlacement: single clip", () => {
  it("keeps the exact start on the preferred track when it is free", () => {
    const result = plan({ clips: [clip("a", "video-1", 0, 5)], start: 6, duration: 4, track: "video-1" });
    expect(result.newTracks).toHaveLength(0);
    expect(result.assignments[0].trackId).toBe("video-1");
    expect(result.assignments[0].start).toBe(6);
    expect(result.assignments[0].onNewTrack).toBe(false);
  });

  it("uses another free track at the same time when the preferred track is full", () => {
    const result = plan({ clips: [clip("a", "video-1", 0, 10)], start: 2, duration: 3, track: "video-1" });
    expect(result.newTracks).toHaveLength(0);
    expect(result.assignments[0].trackId).toBe("video-2");
    expect(result.assignments[0].start).toBe(2);
  });

  it("creates a new track pair when every track is full", () => {
    const result = plan({
      clips: [clip("a", "video-1", 0, 10), clip("b", "video-2", 0, 10)],
      start: 2, duration: 3, track: "video-1",
    });
    expect(result.newTracks).toHaveLength(1);
    expect(result.newTracks[0].videoTrackId).toBe("video-3");
    expect(result.newTracks[0].audioTrackId).toBe("audio-3");
    expect(result.assignments[0].trackId).toBe("video-3");
    expect(result.assignments[0].onNewTrack).toBe(true);
    expect(result.assignments[0].start).toBe(2);
  });

  it("skips locked tracks", () => {
    const result = plan({ settings: baseSettings({ "video-1": { locked: true } }), start: 0, duration: 3, track: "video-1" });
    expect(result.assignments[0].trackId).toBe("video-2");
  });

  it("skips hidden tracks and creates a new one when nothing is usable", () => {
    const result = plan({
      settings: baseSettings({ "video-1": { hidden: true }, "video-2": { locked: true } }),
      start: 0, duration: 3, track: "video-1",
    });
    expect(result.newTracks).toHaveLength(1);
    expect(result.assignments[0].trackId).toBe("video-3");
  });

  it("does not treat touching edges as a collision", () => {
    const result = plan({ clips: [clip("a", "video-1", 0, 5)], start: 5, duration: 2, track: "video-1" });
    expect(result.assignments[0].trackId).toBe("video-1");
  });

  it("treats a one-frame overlap as a collision", () => {
    const result = plan({ clips: [clip("a", "video-1", 0, 5)], start: 5 - 1 / 30, duration: 2, track: "video-1" });
    expect(result.assignments[0].trackId).toBe("video-2");
  });

  it("treats an adjustment layer as occupying the track", () => {
    const result = plan({ adjustments: [adjustment("adj", "video-1", 0, 10)], start: 2, duration: 3, track: "video-1" });
    expect(result.assignments[0].trackId).toBe("video-2");
  });

  it("ignores tracks without a linked audio track", () => {
    const result = plan({
      clips: [clip("a", "video-1", 0, 10)],
      settings: baseSettings({ "video-2": { linkedTrackId: null } }),
      start: 2, duration: 3, track: "video-1",
    });
    expect(result.newTracks).toHaveLength(1);
    expect(result.assignments[0].trackId).toBe("video-3");
  });
});

describe("planVideoPlacement: layers", () => {
  it("puts a new track above every video and adjustment layer, even after a reorder", () => {
    const result = plan({
      clips: [clip("a", "video-1", 0, 10, 5000), clip("b", "video-2", 0, 10, 3000)],
      adjustments: [adjustment("adj", "video-2", 20, 30, 7000)],
      start: 2, duration: 3, track: "video-1",
    });
    expect(result.newTracks[0].layer).toBe(7000 + 1024);
    expect(result.assignments[0].layer).toBe(7000 + 1024);
  });

  it("uses the default stack when nothing has an explicit layer", () => {
    const result = plan({
      clips: [clip("a", "video-1", 0, 10), clip("b", "video-2", 0, 10)],
      start: 2, duration: 3, track: "video-1",
    });
    expect(result.newTracks[0].layer).toBe(2 * 1024 + 1024);
  });

  it("inherits the explicit layer of the nearest clip on an existing track", () => {
    const clips = [clip("a", "video-1", 0, 5, 4096), clip("b", "video-1", 20, 25, 9000)];
    expect(plan({ clips, start: 6, duration: 2, track: "video-1" }).assignments[0].layer).toBe(4096);
    expect(plan({ clips, start: 18, duration: 1, track: "video-1" }).assignments[0].layer).toBe(9000);
  });

  it("leaves the layer undefined when the track has no explicit layers", () => {
    const result = plan({ clips: [clip("a", "video-1", 0, 5)], start: 6, duration: 2, track: "video-1" });
    expect(result.assignments[0].layer).toBeUndefined();
  });
});

describe("planVideoPlacement: groups", () => {
  it("keeps clips from different source tracks on different targets", () => {
    const result = planVideoPlacement({
      videoClips: [], audioClips: [], adjustmentLayers: [], trackSettings: baseSettings(),
      items: [
        { key: "x", sourceTrackId: "video-1", start: 1, duration: 2 },
        { key: "y", sourceTrackId: "video-2", start: 1, duration: 2 },
      ],
    });
    expect(result.assignments.map((a) => a.trackId)).toEqual(["video-1", "video-2"]);
    expect(result.newTracks).toHaveLength(0);
  });

  it("remaps only the group that does not fit and returns assignments in input order", () => {
    const result = planVideoPlacement({
      videoClips: [clip("blocker", "video-2", 0, 10)], audioClips: [], adjustmentLayers: [], trackSettings: baseSettings(),
      items: [
        { key: "x", sourceTrackId: "video-1", start: 1, duration: 2 },
        { key: "y", sourceTrackId: "video-2", start: 1, duration: 2 },
      ],
    });
    expect(result.assignments.map((a) => a.key)).toEqual(["x", "y"]);
    expect(result.assignments[0].trackId).toBe("video-1");
    expect(result.assignments[1].trackId).toBe("video-3");
    expect(result.assignments[1].onNewTrack).toBe(true);
  });
});

describe("helpers", () => {
  it("snaps ranges to the frame grid", () => {
    const range = snapPlacementRange(1.01, 2);
    expect(range.start).toBeCloseTo(1, 6);
    expect(range.end).toBeCloseTo(3, 6);
  });

  it("isVideoRangeFree can exclude a clip", () => {
    const clips = [clip("a", "video-1", 0, 5)];
    expect(isVideoRangeFree(clips, [], "video-1", 1, 2)).toBe(false);
    expect(isVideoRangeFree(clips, [], "video-1", 1, 2, "a")).toBe(true);
  });
});

describe("findPlanConflicts", () => {
  it("reports no conflicts for a fresh plan", () => {
    const base = input({ clips: [clip("a", "video-1", 0, 5)], start: 6, duration: 2, track: "video-1" });
    expect(findPlanConflicts(base, planVideoPlacement(base))).toEqual([]);
  });

  it("reports a conflict when the timeline changed after planning", () => {
    const base = input({ clips: [clip("a", "video-1", 0, 5)], start: 6, duration: 2, track: "video-1" });
    const stalePlan = planVideoPlacement(base);
    const changed = { ...base, videoClips: [...base.videoClips, clip("late", "video-1", 5, 9)] };
    expect(findPlanConflicts(changed, stalePlan)).toEqual(["new"]);
  });

  it("reports a conflict when a planned new track id now exists", () => {
    const base = input({
      clips: [clip("a", "video-1", 0, 10), clip("b", "video-2", 0, 10)],
      start: 2, duration: 3, track: "video-1",
    });
    const stalePlan = planVideoPlacement(base);
    const changed = { ...base, videoClips: [...base.videoClips, clip("c", "video-3", 0, 1)] };
    expect(findPlanConflicts(changed, stalePlan)).toEqual(["new"]);
  });
});
