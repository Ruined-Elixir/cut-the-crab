import { describe, it, expect } from "vitest";
import { insertCompoundCopyAt, type CompoundTimelineState, type CompoundVideoPlacement } from "./compoundClips";
const video = (id: string, trackId: string, start: number, end: number, extra = {}) =>
  ({ id, trackId, timelineStart: start, timelineEnd: end, compoundId: "c1", ...extra }) as never;
function source(): CompoundTimelineState {
  return {
    videoClips: [video("v1", "video-1", 10, 14, {compoundAnchor:true,compoundName:"Test"}), video("v2","video-2",11,13)],
    audioClips: [{ id:"a1",trackId:"audio-3",timelineStart:10,timelineEnd:12,compoundId:"c1",linkedVideoClipId:"v1" } as never],
    subtitles: [{id:"s1",trackId:"subtitle-1",startTime:10.5,endTime:12,compoundId:"c1",linkedVideoClipId:"v1",text:"hi"} as never],
  };
}
const placements = new Map<string, CompoundVideoPlacement>([
  ["v1", {trackId:"video-3",start:20,end:24,layer:9000}],
  ["v2", {trackId:"video-4",start:21,end:23,layer:10024}],
]);
describe("insertCompoundCopyAt", () => {
  it("retargets videos and relinks both audio and subtitles", () => {
    const s=source();const result=insertCompoundCopyAt(s,s,"c1",20,placements);
    if (!result || result==="blocked") throw new Error("expected copy");
    const anchor=result.state.videoClips.find(c=>c.id===result.anchorVideoId)!;
    expect(anchor.trackId).toBe("video-3");
    expect(anchor.timelineStart).toBe(20);
    expect(result.state.audioClips.find(c=>c.compoundId===result.compoundId)?.linkedVideoClipId).toBe(anchor.id);
    expect(result.state.subtitles.find(c=>c.compoundId===result.compoundId)?.linkedVideoClipId).toBe(anchor.id);
    expect(s.videoClips[0].timelineStart).toBe(10);
  });
  it("rejects an audio collision without mutation", () => {
    const s=source();const current={...s,audioClips:[...s.audioClips,{id:"block",trackId:"audio-3",timelineStart:19,timelineEnd:21} as never]};
    expect(insertCompoundCopyAt(current,s,"c1",20,placements)).toBe("blocked");
    expect(current.videoClips).toHaveLength(2);
  });
  it("rejects a subtitle collision", () => {
    const s=source();const current={...s,subtitles:[...s.subtitles,{id:"block",trackId:"subtitle-1",startTime:20,endTime:21} as never]};
    expect(insertCompoundCopyAt(current,s,"c1",20,placements)).toBe("blocked");
  });
});
