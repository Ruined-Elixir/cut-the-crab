import { describe, expect, it } from "vitest";
import { hitTestLayers } from "./programHitTest";
const shell = {width: 1920, height: 1080};
describe("program layer hit test", () => {
  it("returns front to back hits", () => {
    const layers = ["top", "bottom"].map(id => ({id, sourceWidth:1920,sourceHeight:1080}));
    expect(hitTestLayers({x:960,y:540}, shell,layers)).toEqual(["top","bottom"]);
  });
  it("ignores letterboxed space", () => {
    expect(hitTestLayers({x:100,y:540},shell,[{id:"reel",sourceWidth:1080,sourceHeight:1920}])).toEqual([]);
  });
  it("respects crop", () => {
    expect(hitTestLayers({x:200,y:540},shell,[{id:"cropped",sourceWidth:1920,sourceHeight:1080,cropLeft:25}])).toEqual([]);
  });
  it("respects translation and scaling", () => {
    const layers=[{id:"shifted",sourceWidth:800,sourceHeight:800,positionX:20,scale:50}];
    expect(hitTestLayers({x:1344,y:540},shell,layers)).toEqual(["shifted"]);
  });
});
