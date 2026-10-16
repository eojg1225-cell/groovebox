// Minimal typings for the AudioWorkletGlobalScope (not included in TypeScript's DOM lib).
declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

declare function registerProcessor(
  name: string,
  ctor: new (options?: unknown) => AudioWorkletProcessor,
): void;
