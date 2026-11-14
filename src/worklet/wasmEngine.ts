/**
 * The Rust engine (native/, compiled to WebAssembly: native/src/wasm.rs) behind the protocol,
 * for the web build's worklet (processor.ts) and the tests. No DOM and no Web Audio: it runs
 * in an AudioWorkletGlobalScope (no TextEncoder / atob there) and in Node.
 *
 * Messages go in as JSON (`send`), `render` makes a block, then `audio` holds it interleaved
 * (L R) and `drain` returns what the engine wrote (status, pong, recorded notes, engineReset).
 */
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';

interface Exports {
  memory: WebAssembly.Memory;
  engine_new(sampleRate: number): void;
  in_buf(len: number): number;
  send(len: number): number;
  render(frames: number): void;
  audio_buf(): number;
  out_buf(): number;
  out_len(): number;
  apply(): void;
  state(): void;
  base_value(ch: number, slot: number): number;
  watch_notes(ch: number, on: number): void;
  take_notes(ch: number): number;
  notes_buf(): number;
  held_voices(ch: number): number;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 to bytes (the worklet scope has no atob). */
export function fromBase64(s: string): Uint8Array {
  const lut = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) lut[B64.charCodeAt(i)] = i;
  let len = s.length;
  while (len > 0 && s[len - 1] === '=') len--;
  const out = new Uint8Array((len * 3) >> 2);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = lut[s.charCodeAt(i)], b = lut[s.charCodeAt(i + 1)];
    const c = i + 2 < len ? lut[s.charCodeAt(i + 2)] : 0, d = i + 3 < len ? lut[s.charCodeAt(i + 3)] : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = n >> 16;
    if (i + 2 < len) out[o++] = (n >> 8) & 255;
    if (i + 3 < len) out[o++] = n & 255;
  }
  return out;
}

/** UTF-8 bytes of a string, written into `into` (sized by `utf8Length`). */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function utf8Write(s: string, into: Uint8Array): void {
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) into[o++] = c;
    else if (c < 0x800) { into[o++] = 0xc0 | (c >> 6); into[o++] = 0x80 | (c & 63); }
    else if (c >= 0xd800 && c < 0xdc00) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      into[o++] = 0xf0 | (c >> 18); into[o++] = 0x80 | ((c >> 12) & 63); into[o++] = 0x80 | ((c >> 6) & 63); into[o++] = 0x80 | (c & 63);
    } else { into[o++] = 0xe0 | (c >> 12); into[o++] = 0x80 | ((c >> 6) & 63); into[o++] = 0x80 | (c & 63); }
  }
}

function utf8Read(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length;) {
    const c = b[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 31) << 6) | (b[i++] & 63));
    else if (c < 0xf0) s += String.fromCharCode(((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63));
    else {
      const p = (((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63)) - 0x10000;
      s += String.fromCharCode(0xd800 + (p >> 10), 0xdc00 + (p & 1023));
    }
  }
  return s;
}

/** The engine's state (WasmEngine.state): what a status report carries, at any moment. */
export interface EngineState {
  playing: boolean;
  frame: number;
  /** The master limiter's look-ahead, frames. */
  latency: number;
  peakL: number;
  peakR: number;
  songRow: number;
  songBar: number;
  barPhase: number;
  barSteps: number;
  countBeats: number;
  currentStep: number[];
  heardPattern: number[];
}

export class WasmEngine {
  /** The compiled module (to start a fresh instance from). */
  readonly module: WebAssembly.Module;
  private readonly x: Exports;
  private buffer: ArrayBuffer | null = null;
  private audioView = new Float32Array(0);
  private frames = 0;

  /**
   * `bytes`: the module (engineWasm.gen.ts, decoded; compiled synchronously), or the module
   * already compiled (a fresh instance after a trap: worklet processor.ts).
   */
  constructor(bytes: Uint8Array | WebAssembly.Module, sampleRate: number, nowMs: () => number = () => Date.now()) {
    const module = bytes instanceof WebAssembly.Module ? bytes : new WebAssembly.Module(bytes as BufferSource);
    this.module = module;
    const instance = new WebAssembly.Instance(module, { env: { now_ms: nowMs } });
    this.x = instance.exports as unknown as Exports;
    this.x.engine_new(sampleRate);
  }

  /** Queue messages (handled at the start of the next block, in order). */
  send(msg: MainToWorklet | MainToWorklet[]): void {
    this.sendJson(JSON.stringify(msg));
  }

  sendJson(json: string): void {
    const n = utf8Length(json);
    const ptr = this.x.in_buf(n);
    utf8Write(json, new Uint8Array(this.x.memory.buffer, ptr, n));
    this.x.send(n);
  }

  /** Render a block of `frames` (up to 1024); then read it from `audio`. */
  render(frames: number): void {
    this.x.render(frames);
    this.frames = frames;
  }

  /** The last block, interleaved L R (a view: valid until the next call). */
  get audio(): Float32Array {
    if (this.x.memory.buffer !== this.buffer || this.audioView.length !== this.frames * 2) {
      this.buffer = this.x.memory.buffer;
      this.audioView = new Float32Array(this.buffer, this.x.audio_buf(), this.frames * 2);
    }
    return this.audioView;
  }

  /** Handle what was sent at once, without rendering (the tests; then `drain`). */
  apply(): void {
    this.x.apply();
  }

  /** The engine's state now (the tests): drain first, it reuses the output buffer. */
  state(): EngineState {
    this.x.state();
    return JSON.parse(utf8Read(new Uint8Array(this.x.memory.buffer, this.x.out_buf(), this.x.out_len()))) as EngineState;
  }

  /** A sound parameter's value on a track before live offsets, by its slot in the type's parameter list (the tests). */
  baseValue(ch: number, slot: number): number {
    return this.x.base_value(ch, slot);
  }

  /** Keep the notes track ch starts (the tests; then `takeNotes`). */
  watchNotes(ch: number, on: boolean): void {
    this.x.watch_notes(ch, on ? 1 : 0);
  }

  /** The notes track ch started since the last call. */
  takeNotes(ch: number): number[] {
    const n = this.x.take_notes(ch);
    return n ? Array.from(new Float64Array(this.x.memory.buffer, this.x.notes_buf(), n)) : [];
  }

  /** Voices held on track ch's synth (the tests). */
  heldVoices(ch: number): number {
    return this.x.held_voices(ch);
  }

  /** What the engine wrote in the last block (usually nothing: no allocation then). */
  drain(): WorkletToMain[] | null {
    const n = this.x.out_len();
    if (n === 0) return null;
    const text = utf8Read(new Uint8Array(this.x.memory.buffer, this.x.out_buf(), n));
    return JSON.parse(`[${text}]`) as WorkletToMain[];
  }
}
