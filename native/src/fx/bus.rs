//! One FX bus (ported from the TypeScript engine's FxBus.ts) (buses.ts defines what each holds):
//!  FX 1 (insert): the drums through COMP, plus MOD / DELAY returns, all through FILTER.
//!  FX 2 (send): DIST / DELAY / VERB returns through TONE (cuts, DUCK).
//! Each unit returns at its VOLUME; at 0 it fades for FADE_SECONDS and is then skipped; a
//! TYPE change fades out, switches, resets and fades back; a send quiet for QUIET_SECONDS is
//! skipped. Allocation-free in process().

use super::compressor::Compressor;
use super::units::{DelayFx, DriveFx, ModFx, Unit, VerbFx, FX_BLOCK};
use crate::dsp::Svf;
use crate::js;
use crate::smoother::Smoother;

const FADE_SECONDS: f64 = 0.15;
const SWITCH_SECONDS: f64 = 0.015;
const QUIET_SECONDS: f64 = 5.0;
const QUIET_LEVEL: f64 = 1e-6;
const PUMP_ATTACK: f64 = 0.004;
const FILTER_UPDATE: i32 = 16;
const DJ_DEAD: f64 = 0.02;

pub const NUM_BUSES: usize = 2;

#[derive(Copy, Clone, PartialEq)]
enum Kind {
    Comp,
    Mod,
    Delay,
    Verb,
    Drive,
    Tone,
    Filter,
}

struct UnitDef {
    kind: Kind,
    types: &'static [&'static str],
    /// Its four parameters in panel order, with the bus's defaults.
    params: [(&'static str, f64); 4],
}

/// buses.ts BUSES, with every unit's parameters and defaults (BUS_PARAMS' order).
fn bus_def(index: usize) -> (bool, [UnitDef; 4]) {
    match index {
        0 => (true, [
            UnitDef { kind: Kind::Comp, types: &[], params: [("cmp_ratio", 1.0), ("cmp_thresh", -18.0), ("cmp_attack", 0.005), ("cmp_release", 0.15)] },
            UnitDef { kind: Kind::Mod, types: &["FLANGER", "PHASER"], params: [("mod_vol", 0.0), ("mod_type", 0.0), ("mod_rate", 0.3), ("mod_depth", 0.5)] },
            UnitDef { kind: Kind::Delay, types: &["TAPE", "SWEEP", "REVERSE"], params: [("dly_vol", 0.0), ("dly_type", 0.0), ("dly_rate", 4.0), ("dly_fdbk", 0.35)] },
            UnitDef { kind: Kind::Filter, types: &[], params: [("flt", 0.5), ("flt_reso", 0.0), ("flt_env", 0.0), ("flt_rel", 0.15)] },
        ]),
        _ => (false, [
            UnitDef { kind: Kind::Drive, types: &["TUBE", "FUZZ", "BIT"], params: [("drv_vol", 0.0), ("drv_type", 0.0), ("drv_drive", 0.4), ("drv_tone", 5000.0)] },
            UnitDef { kind: Kind::Delay, types: &["PING-PONG", "DUB TAPE", "SLAPBACK"], params: [("dly_vol", 0.35), ("dly_type", 0.0), ("dly_rate", 5.0), ("dly_fdbk", 0.4)] },
            UnitDef { kind: Kind::Verb, types: &["ROOM", "PLATE", "SPRING"], params: [("vrb_vol", 0.25), ("vrb_type", 1.0), ("vrb_size", 0.5), ("vrb_len", 0.5)] },
            UnitDef { kind: Kind::Tone, types: &[], params: [("tone_low", 200.0), ("tone_high", 16000.0), ("tone_duck", 0.4), ("tone_rel", 0.3)] },
        ]),
    }
}

/// The FILTER knob (params.ts djCutoff): low-pass cutoff (negative) left of the centre,
/// high-pass right, 0 in the dead zone.
pub fn dj_cutoff(pos: f64) -> f64 {
    let half = 0.5 - DJ_DEAD;
    if pos < half {
        return -20000.0 * (30.0f64 / 20000.0).powf((half - pos) / half);
    }
    if pos > 0.5 + DJ_DEAD {
        return 20.0 * (16000.0f64 / 20.0).powf(((pos - 0.5 - DJ_DEAD) / half).min(1.0));
    }
    0.0
}

struct Slot {
    types: &'static [&'static str],
    prefix: &'static str,
    unit: Unit,
    vol: Smoother,
    vol_target: f64,
    running: bool,
    fade_left: f64,
    switch_gain: f64,
    pending_type: i32,
    type_index: i32,
}

impl Slot {
    fn type_name(&self, index: i32) -> &'static str {
        self.types.get(index.clamp(0, self.types.len() as i32 - 1) as usize).copied().unwrap_or("")
    }
}

pub struct FxBus {
    sr: f64,
    insert: bool,
    slots: Vec<Slot>,
    comp: Option<Compressor>,
    wet_l: [f32; FX_BLOCK],
    wet_r: [f32; FX_BLOCK],
    ret_l: [f32; FX_BLOCK],
    ret_r: [f32; FX_BLOCK],
    fade_frames: f64,
    switch_step: f64,
    quiet_frames: f64,
    quiet: f64,
    has_tone: bool,
    duck_by_kick: bool,
    low_cut: f64,
    high_cut: f64,
    hp_l: Svf, hp_r: Svf, lp_l: Svf, lp_r: Svf,
    duck_depth: f64,
    duck_rel: f64,
    pump_stage: i32, pump_x: f64, pump_from: f64, pump_shape: f64,
    follow: f64,
    has_filter: bool,
    flt_pos: Smoother,
    flt_target: f64,
    flt_mode: i32,
    flt_reso: f64, flt_env: f64, flt_rel_mul: f64,
    flt_follow: f64, flt_counter: i32,
    flt_l: Svf, flt_r: Svf,
}

impl FxBus {
    pub fn new(sample_rate: f64, index: usize) -> Self {
        let (insert, units) = bus_def(index);
        let mut slots = vec![];
        let mut comp = None;
        for u in &units {
            let (unit, prefix) = match u.kind {
                Kind::Comp => {
                    comp = Some(Compressor::new(sample_rate));
                    continue;
                }
                Kind::Mod => (Unit::Mod(Box::new(ModFx::new(sample_rate))), "mod"),
                Kind::Delay => (Unit::Delay(Box::new(DelayFx::new(sample_rate, u.types.contains(&"REVERSE")))), "dly"),
                Kind::Verb => (Unit::Verb(Box::new(VerbFx::new(sample_rate))), "vrb"),
                Kind::Drive => (Unit::Drive(DriveFx::new(sample_rate)), "drv"),
                Kind::Tone | Kind::Filter => continue,
            };
            slots.push(Slot { types: u.types, prefix, unit, vol: Smoother::new(0.0, 0.02, sample_rate), vol_target: 0.0, running: false, fade_left: 0.0, switch_gain: 1.0, pending_type: -1, type_index: 0 });
        }
        let mut bus = FxBus {
            sr: sample_rate,
            insert,
            slots,
            comp,
            wet_l: [0.0; FX_BLOCK],
            wet_r: [0.0; FX_BLOCK],
            ret_l: [0.0; FX_BLOCK],
            ret_r: [0.0; FX_BLOCK],
            fade_frames: FADE_SECONDS * sample_rate,
            switch_step: 1.0 / (SWITCH_SECONDS * sample_rate),
            quiet_frames: QUIET_SECONDS * sample_rate,
            quiet: 0.0,
            has_tone: units.iter().any(|u| u.kind == Kind::Tone),
            duck_by_kick: false,
            low_cut: 20.0,
            high_cut: 20000.0,
            hp_l: Svf::default(), hp_r: Svf::default(), lp_l: Svf::default(), lp_r: Svf::default(),
            duck_depth: 0.0,
            duck_rel: 0.25,
            pump_stage: 0, pump_x: 0.0, pump_from: 0.0, pump_shape: 0.0,
            follow: 0.0,
            has_filter: units.iter().any(|u| u.kind == Kind::Filter),
            flt_pos: Smoother::new(0.5, 0.02, sample_rate),
            flt_target: 0.5,
            flt_mode: 0,
            flt_reso: 0.0, flt_env: 0.0, flt_rel_mul: 0.0,
            flt_follow: 0.0, flt_counter: 0,
            flt_l: Svf::default(), flt_r: Svf::default(),
        };
        for s in &mut bus.slots {
            let name = s.type_name(0);
            s.unit.set_mode(name);
        }
        for u in &units {
            for (id, v) in u.params {
                bus.set_param(id, v);
            }
        }
        bus.settle();
        bus
    }

    pub fn set_param(&mut self, id: &str, v: f64) {
        if id.starts_with("cmp_") {
            if let Some(c) = &mut self.comp {
                c.set_param(id, v);
            }
            return;
        }
        match id {
            "tone_low" => { self.low_cut = v; self.hp_l.setup(v, 0.0, self.sr); self.hp_r.setup(v, 0.0, self.sr); return; }
            "tone_high" => { self.high_cut = v; self.lp_l.setup(v, 0.0, self.sr); self.lp_r.setup(v, 0.0, self.sr); return; }
            "tone_duck" => { self.duck_depth = v; return; }
            "tone_rel" => { self.duck_rel = v; return; }
            "flt" => { self.flt_target = v; self.flt_pos.set_target(v); return; }
            "flt_reso" => { self.flt_reso = v; self.flt_counter = 0; return; }
            "flt_env" => { self.flt_env = v; return; }
            "flt_rel" => { self.flt_rel_mul = (-1.0 / (v * self.sr)).exp(); return; }
            _ => {}
        }
        let fade_frames = self.fade_frames;
        let Some(slot) = self.slots.iter_mut().find(|s| id.len() > s.prefix.len() && id.starts_with(s.prefix) && id.as_bytes()[s.prefix.len()] == b'_') else { return };
        if id.ends_with("_vol") {
            slot.vol_target = v;
            slot.vol.set_target(v);
            if v > 0.0 {
                if !slot.running {
                    slot.unit.reset();
                }
                slot.running = true;
                slot.fade_left = 0.0;
            } else if slot.running {
                slot.fade_left = fade_frames;
            }
        } else if id.ends_with("_type") {
            let t = js::round(v) as i32;
            if t == slot.type_index && slot.pending_type < 0 {
                return;
            }
            if !slot.running {
                slot.type_index = t;
                let name = slot.type_name(t);
                slot.unit.set_mode(name);
                slot.unit.reset();
            } else {
                slot.pending_type = t;
            }
        } else {
            slot.unit.set(id, v);
        }
    }

    pub fn set_tempo(&mut self, bpm: f64) {
        for s in &mut self.slots {
            s.unit.set_tempo(bpm);
        }
    }

    /// Jump to the current settings (project load).
    pub fn settle(&mut self) {
        self.flt_pos.set_immediate(self.flt_target);
        for s in &mut self.slots {
            s.vol.set_immediate(s.vol_target);
            if s.pending_type >= 0 {
                s.type_index = s.pending_type;
                s.pending_type = -1;
                let name = s.type_name(s.type_index);
                s.unit.set_mode(name);
                s.unit.reset();
            }
            s.switch_gain = 1.0;
        }
        for s in &mut self.slots {
            if let Unit::Delay(d) = &mut s.unit {
                d.settle();
            }
        }
    }

    /// A KICK hit (PUMP; no bus pumps now).
    pub fn kick(&mut self) {
        if !self.duck_by_kick || self.duck_depth <= 0.0 {
            return;
        }
        self.pump_from = self.pump_shape;
        self.pump_stage = 1;
        self.pump_x = 0.0;
    }

    /// Reads the bus input (FX 1: changed in place by COMP) and ADDS the result into out.
    pub fn process(&mut self, in_l: &mut [f32], in_r: &mut [f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let n = in_l.len();
        let filtering = self.has_filter && self.filter_on();
        if self.insert {
            if let Some(c) = &mut self.comp {
                c.process(in_l, in_r);
            }
            if !filtering {
                for i in 0..n {
                    js::add_f32(&mut out_l[i], in_l[i] as f64);
                    js::add_f32(&mut out_r[i], in_r[i] as f64);
                }
            }
        }
        let mut peak = 0.0f64;
        for i in 0..n {
            let a = (in_l[i] as f64).abs() + (in_r[i] as f64).abs();
            if a > peak {
                peak = a;
            }
        }
        if peak > QUIET_LEVEL {
            self.quiet = 0.0;
        } else if self.quiet >= self.quiet_frames {
            return;
        }
        self.ret_l[..n].fill(0.0);
        self.ret_r[..n].fill(0.0);
        let mut any = false;
        for s in &mut self.slots {
            if !s.running {
                continue;
            }
            any = true;
            s.unit.render(in_l, in_r, &mut self.wet_l, &mut self.wet_r, n);
            for i in 0..n {
                if s.pending_type >= 0 {
                    s.switch_gain -= self.switch_step;
                    if s.switch_gain <= 0.0 {
                        s.switch_gain = 0.0;
                        s.type_index = s.pending_type;
                        s.pending_type = -1;
                        let name = s.type_name(s.type_index);
                        s.unit.set_mode(name);
                        s.unit.reset();
                    }
                } else if s.switch_gain < 1.0 {
                    s.switch_gain = (s.switch_gain + self.switch_step).min(1.0);
                }
                let g = s.vol.next() * s.switch_gain;
                js::add_f32(&mut self.ret_l[i], self.wet_l[i] as f64 * g);
                js::add_f32(&mut self.ret_r[i], self.wet_r[i] as f64 * g);
            }
            if s.fade_left > 0.0 {
                s.fade_left -= n as f64;
                if s.fade_left <= 0.0 {
                    s.running = false;
                }
            }
        }
        if any && self.has_tone {
            self.tone(in_l, in_r, n);
        }
        if filtering {
            for i in 0..n {
                js::add_f32(&mut self.ret_l[i], in_l[i] as f64);
                js::add_f32(&mut self.ret_r[i], in_r[i] as f64);
            }
            self.filter(n);
        }
        let mut out = 0.0f64;
        for i in 0..n {
            js::add_f32(&mut out_l[i], self.ret_l[i] as f64);
            js::add_f32(&mut out_r[i], self.ret_r[i] as f64);
            let a = (self.ret_l[i] as f64).abs() + (self.ret_r[i] as f64).abs();
            if a > out {
                out = a;
            }
        }
        if peak <= QUIET_LEVEL && out <= QUIET_LEVEL {
            self.quiet += n as f64;
        } else {
            self.quiet = 0.0;
        }
    }

    fn filter_on(&mut self) -> bool {
        if dj_cutoff(self.flt_target) != 0.0 || dj_cutoff(self.flt_pos.value()) != 0.0 {
            return true;
        }
        if self.flt_mode != 0 {
            self.flt_mode = 0;
            self.flt_l.reset();
            self.flt_r.reset();
            self.flt_follow = 0.0;
        }
        self.flt_pos.set_immediate(self.flt_target);
        false
    }

    fn filter(&mut self, n: usize) {
        for i in 0..n {
            let mut x = self.ret_l[i] as f64;
            let mut y = self.ret_r[i] as f64;
            let a = x.abs() + y.abs();
            self.flt_follow = if a > self.flt_follow { a } else { self.flt_follow * self.flt_rel_mul };
            let pos = self.flt_pos.next();
            let due = self.flt_counter <= 0;
            self.flt_counter -= 1;
            if due {
                self.flt_counter = FILTER_UPDATE;
                let c = dj_cutoff(pos);
                self.flt_mode = if c < 0.0 { -1 } else if c > 0.0 { 1 } else { 0 };
                let base = c.abs();
                let fc = if self.flt_env == 0.0 { base } else { base * 2f64.powf(self.flt_env * 8.0 * self.flt_follow.min(1.0)) };
                let f = if fc < 20.0 { 20.0 } else { fc };
                self.flt_l.setup(f, self.flt_reso, self.sr);
                self.flt_r.setup(f, self.flt_reso, self.sr);
            }
            self.flt_l.process(x);
            self.flt_r.process(y);
            if self.flt_mode < 0 {
                x = self.flt_l.low;
                y = self.flt_r.low;
            } else if self.flt_mode > 0 {
                x = self.flt_l.high;
                y = self.flt_r.high;
            }
            self.ret_l[i] = x as f32;
            self.ret_r[i] = y as f32;
        }
        if self.flt_follow < 1e-9 {
            self.flt_follow = 0.0;
        }
    }

    fn tone(&mut self, in_l: &[f32], in_r: &[f32], n: usize) {
        let low = self.low_cut > 21.0;
        let high = self.high_cut < 19990.0;
        let rel_inc = 1.0 / (self.duck_rel * self.sr);
        let attack_inc = 1.0 / (PUMP_ATTACK * self.sr);
        let follow_rel = (-1.0 / (self.duck_rel * self.sr)).exp();
        for i in 0..n {
            let mut x = self.ret_l[i] as f64;
            let mut y = self.ret_r[i] as f64;
            if low {
                self.hp_l.process(x);
                self.hp_r.process(y);
                x = self.hp_l.high;
                y = self.hp_r.high;
            }
            if high {
                self.lp_l.process(x);
                self.lp_r.process(y);
                x = self.lp_l.low;
                y = self.lp_r.low;
            }
            let mut g = 1.0;
            if self.duck_depth > 0.0 {
                if self.duck_by_kick {
                    if self.pump_stage == 1 {
                        self.pump_x += attack_inc;
                        if self.pump_x >= 1.0 {
                            self.pump_x = 0.0;
                            self.pump_stage = 2;
                            self.pump_shape = 1.0;
                        } else {
                            self.pump_shape = self.pump_from + (1.0 - self.pump_from) * self.pump_x;
                        }
                    } else if self.pump_stage == 2 {
                        self.pump_x += rel_inc;
                        if self.pump_x >= 1.0 {
                            self.pump_stage = 0;
                            self.pump_shape = 0.0;
                        } else {
                            let t = self.pump_x;
                            self.pump_shape = 1.0 - t * t * (3.0 - 2.0 * t);
                        }
                    }
                    g = 1.0 - self.duck_depth * self.pump_shape;
                } else {
                    let a = (in_l[i] as f64).abs().max((in_r[i] as f64).abs());
                    self.follow = if a > self.follow { a } else { self.follow * follow_rel };
                    g = 1.0 - self.duck_depth * (self.follow * 4.0).min(1.0);
                }
            }
            self.ret_l[i] = (x * g) as f32;
            self.ret_r[i] = (y * g) as f32;
        }
        if self.follow < 1e-9 {
            self.follow = 0.0;
        }
    }
}
