declare module "@biliblitz/libass-wasm" {
  export type SubtitlesOctopusOptions = {
    video: HTMLVideoElement;
    canvas: HTMLCanvasElement;

    renderMode?: string;
    lossyRender?: boolean;

    libassMemoryLimit?: number;
    libassGlyphLimit?: number;

    targetFps?: number;

    prescaleFactor?: number;
    prescaleHeightLimit?: number;
    maxRenderHeight?: number;

    dropAllAnimations?: boolean;

    fonts?: string[];

    availableFonts?: Record<string, string>;

    fallbackFont?: string;

    lazyFileLoading?: boolean;

    onReady?: () => void;

    subUrl?: string;
    subContent?: string;

    onError?: (error: Error) => void;

    debug?: boolean;

    timeOffset?: number;
  };

  export default class SubtitlesOctopus {
    constructor(options: SubtitlesOctopusOptions);

    dispose(): void;
  }
}
