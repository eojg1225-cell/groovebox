/**
 * Single parts of the Rust engine on their own (native/src/parts.rs, through the web build's
 * WebAssembly module): one instrument, an FX bus, the master limiter, a track's MID CUT,
 * behind the shapes the tests were written against (the TypeScript classes they replace).
 */
import type { ParamSpec } from '../src/engine/params';
import { INSTRUMENTS, SOUND_KINDS } from '../src/instruments/registry';
import type { SoundKind } from '../src/engine/project';
import { ENGINE_WASM } from '../src/worklet/engineWasm.gen';
import { fromBase64 } from '../src/worklet/wasmEngine';

interface X {
  memory: WebAssembly.Memory;
  part_new(what: number, sr: number): number;
  part_id_buf(len: number): number;
  part_bufs(n: number): void;
  part_buf(k: number): number;
  part_param(h: number, v: number): void;
  part_note_on(h: number, note: number, vel: number, group: number, ring: number, slideFrom: number, slide: number): void;
  part_note_off(h: number, group: number): void;
  part_do(h: number, what: number): void;
  part_set(h: number, what: number, v: number): void;
  part_run(h: number, n: number): void;
  part_post(h: number, n: number): void;
  part_info(h: number, what: number): number;
}

const x = new WebAssembly.Instance(new WebAssembly.Module(fromBase64(ENGINE_WASM) as BufferSource), { env: { now_ms: () => Date.now() } }).exports as unknown as X;

/** The engine's fixed settings per synth type (native/src/instruments/synth.rs `fixed`). */
export const BASS_FIXED = { voice: 1, envlink: 1, squelch: 1, body: 1, cz: 1 };
export const PAD_FIXED = { voice: 0, sub: 0, algo: 2, cz: 2, sawrise: 1, padfx: 1 };
export const LEAD_FIXED = { voice: 1, sub: 0, envlink: 1, squelch: 1, body: 1, cz: 1 };
export const PLUCK_FIXED = { voice: 0, sub: 0, envlink: 1, onboard: 1, cz: 2, align: 0 };
const FIXED: Partial<Record<SoundKind, Record<string, number>>> = { bass: BASS_FIXED, pad: PAD_FIXED, lead: LEAD_FIXED, pluck: PLUCK_FIXED };

function view(k: number, n: number): Float32Array {
  return new Float32Array(x.memory.buffer, x.part_buf(k), n);
}

/** Copy [start, end) of the caller's buffers into part buffers k, k + 1 (from frame 0). */
function put(k: number, l: Float32Array, r: Float32Array, start: number, end: number): void {
  const n = end - start;
  x.part_bufs(n);
  view(k, n).set(l.subarray(start, end));
  view(k + 1, n).set(r.subarray(start, end));
}

function get(k: number, l: Float32Array, r: Float32Array, start: number, end: number): void {
  const n = end - start;
  l.set(view(k, n), start);
  if (r !== l) r.set(view(k + 1, n), start);
}

class Part {
  protected readonly h: number;
  constructor(what: number, sampleRate: number) {
    this.h = x.part_new(what, sampleRate);
  }

  setParam(id: string, value: number): void {
    const p = x.part_id_buf(id.length);
    const b = new Uint8Array(x.memory.buffer, p, id.length);
    for (let i = 0; i < id.length; i++) b[i] = id.charCodeAt(i);
    x.part_param(this.h, value);
  }
}

/** An instrument (drum or synth) of a type, as the engine plays it. */
export class Instrument extends Part {
  readonly kind: SoundKind;
  readonly params: readonly ParamSpec[];
  constructor(kind: SoundKind, sampleRate: number, fixed?: Record<string, number>) {
    super(SOUND_KINDS.indexOf(kind), sampleRate);
    this.kind = kind;
    this.params = INSTRUMENTS[kind].params;
    const own = FIXED[kind] ?? {};
    // A fixed set given replaces the type's own (as the TypeScript constructor took it): what it
    // leaves out is 0.
    if (fixed) for (const id of new Set([...Object.keys(own), ...Object.keys(fixed)])) if ((fixed[id] ?? 0) !== own[id]) this.setParam(id, fixed[id] ?? 0);
  }

  noteOn(note: number, velocity: number, group = note, ring = false, slideFrom = -1, slide = false): void {
    x.part_note_on(this.h, note, velocity, group, ring ? 1 : 0, slideFrom, slide ? 1 : 0);
  }

  noteOff(group = -1): void { x.part_note_off(this.h, group); }
  cut(): void { x.part_do(this.h, 0); }
  duck(): void { x.part_do(this.h, 3); }
  setTempo(bpm: number): void { x.part_set(this.h, 0, bpm); }
  setRingLength(scale: number): void { x.part_set(this.h, 1, scale); }
  setPitchMod(st: number): void { x.part_set(this.h, 2, st); }
  setFilterMod(oct: number): void { x.part_set(this.h, 3, oct); }
  setFmMod(a: number): void { x.part_set(this.h, 4, a); }
  setChain(order: number): void { x.part_set(this.h, 5, order); }

  /** ADD the sound into outL / outR for frames [start, end). */
  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    if (end <= start) return;
    put(2, outL, outR, start, end);
    x.part_run(this.h, end - start);
    get(2, outL, outR, start, end);
  }

  /** Onboard effects on frames [0, n), in place. */
  post(l: Float32Array, r: Float32Array, n: number): void {
    put(2, l, r, 0, n);
    x.part_post(this.h, n);
    get(2, l, r, 0, n);
  }
}

const kindOf = (params: readonly ParamSpec[]): SoundKind => SOUND_KINDS.find((k) => INSTRUMENTS[k].params === params)!;

/** `new Drum(sr, KICK_PARAMS)`: the type picked by its parameter list. */
export class Drum extends Instrument {
  constructor(sampleRate: number, params: readonly ParamSpec[]) {
    super(kindOf(params), sampleRate);
  }
}

/** `new Synth(sr, PAD_PARAMS, { ...PAD_FIXED, algo: 1 })`: the type by its parameter list, fixed settings changed where given. */
export class Synth extends Instrument {
  constructor(sampleRate: number, params: readonly ParamSpec[], fixed?: Record<string, number>) {
    super(kindOf(params), sampleRate, fixed);
  }
}

/** FX 1 / FX 2 (index 0 / 1). */
export class FxBus extends Part {
  constructor(sampleRate: number, index: number) {
    super(8 + index, sampleRate);
  }

  setTempo(bpm: number): void { x.part_set(this.h, 0, bpm); }
  settle(): void { x.part_do(this.h, 1); }
  kick(): void { x.part_do(this.h, 2); }

  /** in [off, off + n) through the bus into out [off, off + n). */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    put(0, inL, inR, off, off + n);
    put(2, outL, outR, off, off + n);
    x.part_run(this.h, n);
    get(2, outL, outR, off, off + n);
  }
}

/** The master limiter: in place. */
export class Limiter extends Part {
  constructor(sampleRate: number) {
    super(10, sampleRate);
  }

  /** The look-ahead, frames. */
  get len(): number { return x.part_info(this.h, 0); }
  /** The gain reduction now (1 = none). */
  get reduction(): number { return x.part_info(this.h, 1); }

  process(l: Float32Array, r: Float32Array, frames: number): void {
    put(2, l, r, 0, frames);
    x.part_run(this.h, frames);
    get(2, l, r, 0, frames);
  }
}

/** A track's MID CUT: in place. */
export class TrackCut extends Part {
  constructor(sampleRate: number) {
    super(11, sampleRate);
  }

  setFreq(hz: number): void { this.setParam('freq', hz); }
  setAmount(a: number): void { this.setParam('amount', a); }
  settle(): void { x.part_do(this.h, 1); }

  process(l: Float32Array, r: Float32Array, n: number): void {
    put(2, l, r, 0, n);
    x.part_run(this.h, n);
    get(2, l, r, 0, n);
  }
}
