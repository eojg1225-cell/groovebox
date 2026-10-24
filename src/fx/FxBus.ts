/**
 * One FX bus (FX 1, 2 or 3; see buses.ts for what each holds). The engine sums the tracks
 * routed here into the bus input; process() ADDS the result into the mix:
 *  FX 1 (insert): the drums themselves, through COMP, plus MOD / DELAY returns, all of it
 *  through FILTER (centred = off and skipped).
 *  FX 2 / 3 (sends): only the returns, through TONE (cuts, PUMP or DUCK).
 * Each effect unit returns at its VOLUME; at 0 it fades for FADE_SECONDS and is then skipped
 * (and starts clean when turned up again). A TYPE change fades the unit out, switches and
 * resets it, and fades back in. A send with nothing coming in or out for QUIET_SECONDS is
 * skipped altogether. Allocation-free in process().
 */
import { djCutoff } from '../engine/params';
import { Smoother } from '../engine/smoother';
import { Svf } from '../instruments/dsp';
import { BUSES, BUS_PARAMS, typeName, type UnitDef } from './buses';
import { Compressor } from './Compressor';
import { DelayFx, DriveFx, ModFx, VerbFx, type FxUnit } from './units';

/** Largest block the engine hands a bus (it renders in 64-frame chunks). */
const MAX_BLOCK = 256;
const FADE_SECONDS = 0.15;
const SWITCH_SECONDS = 0.015;
const QUIET_SECONDS = 5;
const QUIET_LEVEL = 1e-6;
/** PUMP: how fast a KICK pulls the returns down. */
const PUMP_ATTACK = 0.004;
/** FILTER: samples between cutoff updates. */
const FILTER_UPDATE = 16;

/** An effect unit on the bus, with its VOLUME, running state and TYPE switch. */
class Slot {
  readonly vol: Smoother;
  volTarget = 0;
  running = false;
  fadeLeft = 0;
  /** TYPE switch: 1 = full, falling to 0 while a switch waits, then back up. */
  switchGain = 1;
  pendingType = -1;
  type = 0;
  constructor(readonly def: UnitDef, readonly unit: FxUnit, readonly prefix: string, sampleRate: number) {
    this.vol = new Smoother(0, 0.02, sampleRate);
  }
}

export class FxBus {
  private readonly sr: number;
  private readonly insert: boolean;
  private readonly slots: Slot[] = [];
  private readonly comp: Compressor | null = null;
  private readonly delays: DelayFx[] = [];
  private readonly wetL = new Float32Array(MAX_BLOCK);
  private readonly wetR = new Float32Array(MAX_BLOCK);
  private readonly retL = new Float32Array(MAX_BLOCK);
  private readonly retR = new Float32Array(MAX_BLOCK);
  private readonly fadeFrames: number;
  private readonly switchStep: number;
  private readonly quietFrames: number;
  private quiet = 0;
  // TONE (sends)
  private readonly hasTone: boolean;
  private readonly duckByKick: boolean;
  private lowCut = 20; private highCut = 20000;
  private readonly hpL = new Svf(); private readonly hpR = new Svf();
  private readonly lpL = new Svf(); private readonly lpR = new Svf();
  private duckDepth = 0; private duckRel = 0.25;
  /** PUMP: 0 idle, 1 pulling down, 2 recovering; progress and shape (0..1). */
  private pumpStage = 0; private pumpX = 0; private pumpFrom = 0; private pumpShape = 0;
  /** DUCK: the input's level (peak follower). */
  private follow = 0;
  // FILTER (FX 1): position (smoothed; 0.5 = off), -1 low-pass / 0 off / 1 high-pass
  private readonly hasFilter: boolean;
  private readonly fltPos: Smoother;
  private fltTarget = 0.5;
  private fltMode = 0;
  private fltReso = 0; private fltEnv = 0; private fltRelMul = 0;
  private fltFollow = 0; private fltCounter = 0;
  private readonly fltL = new Svf(); private readonly fltR = new Svf();

  constructor(sampleRate: number, readonly index: number) {
    this.sr = sampleRate;
    const def = BUSES[index];
    this.insert = def.insert;
    this.fadeFrames = FADE_SECONDS * sampleRate;
    this.switchStep = 1 / (SWITCH_SECONDS * sampleRate);
    this.quietFrames = QUIET_SECONDS * sampleRate;
    const tone = def.units.find((u) => u.kind === 'tone');
    this.hasTone = !!tone;
    this.duckByKick = tone?.duck === 'kick';
    this.hasFilter = def.units.some((u) => u.kind === 'filter');
    this.fltPos = new Smoother(0.5, 0.02, sampleRate);
    for (const u of def.units) {
      switch (u.kind) {
        case 'comp': this.comp = new Compressor(sampleRate); break;
        case 'mod': this.slots.push(new Slot(u, new ModFx(sampleRate), 'mod', sampleRate)); break;
        case 'delay': {
          const d = new DelayFx(sampleRate, (u.types ?? []).includes('REVERSE'));
          this.delays.push(d);
          this.slots.push(new Slot(u, d, 'dly', sampleRate));
          break;
        }
        case 'verb': this.slots.push(new Slot(u, new VerbFx(sampleRate), 'vrb', sampleRate)); break;
        case 'drive': this.slots.push(new Slot(u, new DriveFx(sampleRate), 'drv', sampleRate)); break;
        case 'tone': case 'filter': break;
      }
    }
    for (const s of this.slots) s.unit.setMode(typeName(index, s.def.kind, 0));
    for (const p of BUS_PARAMS[index]) this.setParam(p.id, p.defaultValue);
    this.settle();
  }

  setParam(id: string, v: number): void {
    if (id.startsWith('cmp_')) { this.comp?.setParam(id, v); return; }
    switch (id) {
      case 'tone_low': this.lowCut = v; this.hpL.setup(v, 0, this.sr); this.hpR.setup(v, 0, this.sr); return;
      case 'tone_high': this.highCut = v; this.lpL.setup(v, 0, this.sr); this.lpR.setup(v, 0, this.sr); return;
      case 'tone_duck': this.duckDepth = v; return;
      case 'tone_rel': this.duckRel = v; return;
      case 'flt': this.fltTarget = v; this.fltPos.setTarget(v); return;
      case 'flt_reso': this.fltReso = v; this.fltCounter = 0; return;
      case 'flt_env': this.fltEnv = v; return;
      case 'flt_rel': this.fltRelMul = Math.exp(-1 / (v * this.sr)); return;
    }
    const slot = this.slots.find((s) => id.startsWith(`${s.prefix}_`));
    if (!slot) return;
    if (id.endsWith('_vol')) {
      slot.volTarget = v;
      slot.vol.setTarget(v);
      if (v > 0) {
        if (!slot.running) slot.unit.reset();
        slot.running = true;
        slot.fadeLeft = 0;
      } else if (slot.running) {
        slot.fadeLeft = this.fadeFrames;
      }
    } else if (id.endsWith('_type')) {
      const t = Math.round(v);
      if (t === slot.type && slot.pendingType < 0) return;
      if (!slot.running) { slot.type = t; slot.unit.setMode(typeName(this.index, slot.def.kind, t)); slot.unit.reset(); }
      else slot.pendingType = t;
    } else {
      slot.unit.set(id, v);
    }
  }

  setTempo(bpm: number): void {
    for (const s of this.slots) s.unit.setTempo(bpm);
  }

  /** Jump to the current settings (project load). */
  settle(): void {
    this.fltPos.setImmediate(this.fltTarget);
    for (const s of this.slots) {
      s.vol.setImmediate(s.volTarget);
      if (s.pendingType >= 0) {
        s.type = s.pendingType;
        s.pendingType = -1;
        s.unit.setMode(typeName(this.index, s.def.kind, s.type));
        s.unit.reset();
      }
      s.switchGain = 1;
    }
    for (const d of this.delays) d.settle();
  }

  /** A KICK hit (PUMP). */
  kick(): void {
    if (!this.duckByKick || this.duckDepth <= 0) return;
    this.pumpFrom = this.pumpShape;
    this.pumpStage = 1;
    this.pumpX = 0;
  }

  /** Reads the bus input (FX 1: changed in place by COMP) and ADDS the result into out. */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    // FX 1 with its FILTER in use: the drums go out with the returns, through it, at the end.
    const filtering = this.hasFilter && this.filterOn();
    if (this.insert) {
      // The drums themselves, through COMP, stay in the mix.
      this.comp?.process(inL, inR, 0, n);
      if (!filtering) {
        for (let i = 0; i < n; i++) {
          outL[off + i] += inL[i];
          outR[off + i] += inR[i];
        }
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(inL[i]) + Math.abs(inR[i]);
      if (a > peak) peak = a;
    }
    if (peak > QUIET_LEVEL) this.quiet = 0;
    else if (this.quiet >= this.quietFrames) return;
    const l = this.retL;
    const r = this.retR;
    l.fill(0, 0, n);
    r.fill(0, 0, n);
    let any = false;
    for (const s of this.slots) {
      if (!s.running) continue;
      any = true;
      s.unit.render(inL, inR, this.wetL, this.wetR, n);
      for (let i = 0; i < n; i++) {
        if (s.pendingType >= 0) {
          s.switchGain -= this.switchStep;
          if (s.switchGain <= 0) {
            s.switchGain = 0;
            s.type = s.pendingType;
            s.pendingType = -1;
            s.unit.setMode(typeName(this.index, s.def.kind, s.type));
            s.unit.reset();
          }
        } else if (s.switchGain < 1) {
          s.switchGain = Math.min(1, s.switchGain + this.switchStep);
        }
        const g = s.vol.next() * s.switchGain;
        l[i] += this.wetL[i] * g;
        r[i] += this.wetR[i] * g;
      }
      if (s.fadeLeft > 0 && (s.fadeLeft -= n) <= 0) s.running = false;
    }
    if (any && this.hasTone) this.tone(inL, inR, n);
    if (filtering) {
      for (let i = 0; i < n; i++) {
        l[i] += inL[i];
        r[i] += inR[i];
      }
      this.filter(n);
    }
    let out = 0;
    for (let i = 0; i < n; i++) {
      outL[off + i] += l[i];
      outR[off + i] += r[i];
      const a = Math.abs(l[i]) + Math.abs(r[i]);
      if (a > out) out = a;
    }
    if (peak <= QUIET_LEVEL && out <= QUIET_LEVEL) this.quiet += n;
    else this.quiet = 0;
  }

  /** FILTER in use (or still gliding back to the centre); off resets it, so it starts clean. */
  private filterOn(): boolean {
    if (djCutoff(this.fltTarget) !== 0 || djCutoff(this.fltPos.value) !== 0) return true;
    if (this.fltMode !== 0) {
      this.fltMode = 0;
      this.fltL.reset();
      this.fltR.reset();
      this.fltFollow = 0;
    }
    this.fltPos.setImmediate(this.fltTarget);
    return false;
  }

  /** FILTER on the drums + returns (in retL / retR): LP or HP by position, ENV on every hit. */
  private filter(n: number): void {
    const l = this.retL;
    const r = this.retR;
    for (let i = 0; i < n; i++) {
      let x = l[i];
      let y = r[i];
      const a = Math.abs(x) + Math.abs(y);
      this.fltFollow = a > this.fltFollow ? a : this.fltFollow * this.fltRelMul;
      const pos = this.fltPos.next();
      if (this.fltCounter-- <= 0) {
        this.fltCounter = FILTER_UPDATE;
        const c = djCutoff(pos);
        this.fltMode = c < 0 ? -1 : c > 0 ? 1 : 0;
        const base = c < 0 ? -c : c;
        const fc = this.fltEnv === 0 ? base : base * Math.pow(2, this.fltEnv * 8 * Math.min(1, this.fltFollow));
        const f = fc < 20 ? 20 : fc;
        this.fltL.setup(f, this.fltReso, this.sr);
        this.fltR.setup(f, this.fltReso, this.sr);
      }
      this.fltL.process(x);
      this.fltR.process(y);
      // Through the dead zone in the middle: as it comes in.
      if (this.fltMode < 0) { x = this.fltL.low; y = this.fltR.low; }
      else if (this.fltMode > 0) { x = this.fltL.high; y = this.fltR.high; }
      l[i] = x;
      r[i] = y;
    }
    if (this.fltFollow < 1e-9) this.fltFollow = 0;
  }

  /** TONE on the returns: LOW CUT, HI CUT, then PUMP (KICK) or DUCK (the bus input). */
  private tone(inL: Float32Array, inR: Float32Array, n: number): void {
    const l = this.retL;
    const r = this.retR;
    const low = this.lowCut > 21;
    const high = this.highCut < 19990;
    const relInc = 1 / (this.duckRel * this.sr);
    const attackInc = 1 / (PUMP_ATTACK * this.sr);
    const followRel = Math.exp(-1 / (this.duckRel * this.sr));
    for (let i = 0; i < n; i++) {
      let x = l[i];
      let y = r[i];
      if (low) { this.hpL.process(x); this.hpR.process(y); x = this.hpL.high; y = this.hpR.high; }
      if (high) { this.lpL.process(x); this.lpR.process(y); x = this.lpL.low; y = this.lpR.low; }
      let g = 1;
      if (this.duckDepth > 0) {
        if (this.duckByKick) {
          if (this.pumpStage === 1) {
            this.pumpX += attackInc;
            if (this.pumpX >= 1) { this.pumpX = 0; this.pumpStage = 2; this.pumpShape = 1; }
            else this.pumpShape = this.pumpFrom + (1 - this.pumpFrom) * this.pumpX;
          } else if (this.pumpStage === 2) {
            this.pumpX += relInc;
            if (this.pumpX >= 1) { this.pumpStage = 0; this.pumpShape = 0; }
            else { const t = this.pumpX; this.pumpShape = 1 - t * t * (3 - 2 * t); }
          }
          g = 1 - this.duckDepth * this.pumpShape;
        } else {
          const a = Math.max(Math.abs(inL[i]), Math.abs(inR[i]));
          this.follow = a > this.follow ? a : this.follow * followRel;
          g = 1 - this.duckDepth * Math.min(1, this.follow * 4);
        }
      }
      l[i] = x * g;
      r[i] = y * g;
    }
    if (this.follow < 1e-9) this.follow = 0;
  }
}
