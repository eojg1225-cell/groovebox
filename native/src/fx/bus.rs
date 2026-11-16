//! The two FX buses (buses.ts defines what each holds). Every track is on one of them and has
//! a level into each of its four slots (the engine mixes the track into each slot's own
//! input, `BusIn`), so a track can feed one effect without the others:
//!  FX 1 (the drum processor): COMP (slot 1: in parallel, the level is its MIX: that much of
//!        the track through the compressor, the rest straight out), two free effects (slots
//!        2-3, sends), FILTER (slot 4: one set of knobs, a filter of its own per track,
//!        `filter_track`, before everything else; the level is its MIX).
//!  FX 2 (the synths' multi FX): four free effects (sends); their returns go through the
//!        built-in TONE (low / high cut, DUCK under what the tracks send: no knobs).
//! A free slot holds any effect of the bank (specs::FX_BANK: DIST, MOD, DELAY, VERB types on
//! one TYPE knob); its two controls arrive as knob positions (0-1) and are read in the
//! loaded effect's own scale (specs::FX_FAMILY_SPECS). Each returns at its VOLUME; at 0 it
//! fades for FADE_SECONDS and is then skipped; a TYPE change fades out, switches, resets and
//! fades back; a bus quiet for QUIET_SECONDS is skipped. Allocation-free in process().

use super::compressor::Compressor;
use super::units::{DelayFx, DriveFx, ModFx, Unit, VerbFx, FX_BLOCK};
use crate::dsp::Svf;
use crate::js;
use crate::params::to_value;
use crate::smoother::Smoother;
use crate::specs;

const FADE_SECONDS: f64 = 0.15;
const SWITCH_SECONDS: f64 = 0.015;
const QUIET_SECONDS: f64 = 5.0;
const QUIET_LEVEL: f64 = 1e-6;
const PUMP_ATTACK: f64 = 0.004;
const FILTER_UPDATE: i32 = 16;
const DJ_DEAD: f64 = 0.02;

pub const NUM_BUSES: usize = 2;
/// Slots a bus has (a track's four levels).
pub const SLOTS: usize = 4;
/// A bus's inputs: one per slot, and the side chain (what the tracks send at their highest
/// level: FX 2's DUCK follows it).
pub const BUS_INPUTS: usize = SLOTS + 1;
pub const SIDE: usize = SLOTS;
/// Tracks (a filter each on FX 1).
const TRACKS: usize = 8;

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

/// A free slot: one unit of each family, ready (nothing allocated when the TYPE changes).
struct Slot {
    /// This slot's input (`BusIn` index) and its number in the parameter ids (`s<n>_vol`).
    input: usize,
    number: u8,
    units: [Unit; 4],
    family: usize,
    vol: Smoother,
    vol_target: f64,
    running: bool,
    fade_left: f64,
    switch_gain: f64,
    pending_type: i32,
    type_index: i32,
    /// The two controls, as knob positions.
    a: f64,
    b: f64,
}

impl Slot {
    fn new(sr: f64, input: usize) -> Slot {
        Slot {
            input,
            number: input as u8 + 1,
            units: [
                Unit::Drive(DriveFx::new(sr)),
                Unit::Mod(Box::new(ModFx::new(sr))),
                Unit::Delay(Box::new(DelayFx::new(sr, true))),
                Unit::Verb(Box::new(VerbFx::new(sr))),
            ],
            family: 0,
            vol: Smoother::new(0.0, 0.02, sr),
            vol_target: 0.0,
            running: false,
            fade_left: 0.0,
            switch_gain: 1.0,
            pending_type: -1,
            type_index: -1,
            a: 0.5,
            b: 0.5,
        }
    }

    /// Load bank entry `t`: its family's unit in that mode, reset, the controls applied.
    fn load(&mut self, t: i32) {
        let t = t.clamp(0, specs::FX_BANK.len() as i32 - 1);
        let (name, family) = specs::FX_BANK[t as usize];
        self.type_index = t;
        self.family = family;
        self.units[family].set_mode(name);
        self.units[family].reset();
        self.control(0);
        self.control(1);
    }

    /// Control 0 / 1 (a knob position) to the loaded unit, in its own scale.
    fn control(&mut self, which: usize) {
        let spec = &specs::FX_FAMILY_SPECS[self.family][which];
        let n = if which == 0 { self.a } else { self.b };
        self.units[self.family].set(spec.id, to_value(spec, n.clamp(0.0, 1.0)));
    }
}

/// FX 1's FILTER on one track: its own filter, on the cutoff the whole kit sets (`begin`).
#[derive(Default)]
struct TrackFilter {
    l: Svf,
    r: Svf,
    /// The cutoff it is set up for (0 = not yet).
    fc: f64,
    /// Still sounding (its input, or its own ringing): the engine keeps running it.
    ringing: bool,
}

/// A bus's inputs for one block (N frames each).
pub type BusIn<const N: usize> = [[f32; N]; BUS_INPUTS];

pub struct FxBus {
    sr: f64,
    /// FX 1: COMP on slot 1's input, FILTER per track; FX 2: TONE on the returns.
    drums: bool,
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
    duck_by_kick: bool,
    low_cut: f64,
    high_cut: f64,
    hp_l: Svf, hp_r: Svf, lp_l: Svf, lp_r: Svf,
    duck_depth: f64,
    duck_rel: f64,
    pump_stage: i32, pump_x: f64, pump_from: f64, pump_shape: f64,
    follow: f64,
    flt_pos: Smoother,
    flt_target: f64,
    flt_reso: f64, flt_env: f64, flt_rel_mul: f64,
    /// The cutoff (Hz) and side (-1 low-pass, 1 high-pass, 0 off) over this block, the same
    /// for every track (`begin`: the knob's glide and ENV from the whole kit's level), and
    /// whether the filter filters at all.
    fc_buf: [f64; FX_BLOCK],
    mode_buf: [i8; FX_BLOCK],
    flt_active: bool,
    flt_follow: f64,
    flt_counter: i32,
    flt_fc: f64,
    flt_mode: i8,
    filters: [TrackFilter; TRACKS],
}

impl FxBus {
    pub fn new(sample_rate: f64, index: usize) -> Self {
        let drums = index == 0;
        let slots: Vec<Slot> = if drums { vec![Slot::new(sample_rate, 1), Slot::new(sample_rate, 2)] } else { (0..SLOTS).map(|k| Slot::new(sample_rate, k)).collect() };
        let mut bus = FxBus {
            sr: sample_rate,
            drums,
            slots,
            comp: if drums { Some(Compressor::new(sample_rate)) } else { None },
            wet_l: [0.0; FX_BLOCK],
            wet_r: [0.0; FX_BLOCK],
            ret_l: [0.0; FX_BLOCK],
            ret_r: [0.0; FX_BLOCK],
            fade_frames: FADE_SECONDS * sample_rate,
            switch_step: 1.0 / (SWITCH_SECONDS * sample_rate),
            quiet_frames: QUIET_SECONDS * sample_rate,
            quiet: 0.0,
            duck_by_kick: false,
            low_cut: 20.0,
            high_cut: 20000.0,
            hp_l: Svf::default(), hp_r: Svf::default(), lp_l: Svf::default(), lp_r: Svf::default(),
            duck_depth: 0.0,
            duck_rel: 0.25,
            pump_stage: 0, pump_x: 0.0, pump_from: 0.0, pump_shape: 0.0,
            follow: 0.0,
            flt_pos: Smoother::new(0.5, 0.02, sample_rate),
            flt_target: 0.5,
            flt_reso: 0.0, flt_env: 0.0, flt_rel_mul: 0.0,
            fc_buf: [20.0; FX_BLOCK],
            mode_buf: [0; FX_BLOCK],
            flt_active: false,
            flt_follow: 0.0,
            flt_counter: 0,
            flt_fc: 20.0,
            flt_mode: 0,
            filters: Default::default(),
        };
        // buses.ts' defaults (specs.rs, generated from it).
        let list: &'static [crate::params::Spec] = if drums { &specs::BUS0_PARAMS } else { &specs::BUS1_PARAMS };
        for spec in list {
            bus.set_param(spec.id, spec.default);
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
            "flt_reso" => {
                self.flt_reso = v;
                for f in &mut self.filters {
                    f.fc = 0.0; // set up again
                }
                return;
            }
            "flt_env" => { self.flt_env = v; return; }
            "flt_rel" => { self.flt_rel_mul = (-1.0 / (v * self.sr)).exp(); return; }
            _ => {}
        }
        // A slot's knob: s<n>_vol / _type / _a / _b.
        let b = id.as_bytes();
        if b.len() < 4 || b[0] != b's' || b[2] != b'_' {
            return;
        }
        let number = b[1].wrapping_sub(b'0');
        let fade_frames = self.fade_frames;
        let Some(slot) = self.slots.iter_mut().find(|s| s.number == number) else { return };
        match &id[3..] {
            "vol" => {
                slot.vol_target = v;
                slot.vol.set_target(v);
                if v > 0.0 {
                    if !slot.running {
                        slot.units[slot.family].reset();
                    }
                    slot.running = true;
                    slot.fade_left = 0.0;
                } else if slot.running {
                    slot.fade_left = fade_frames;
                }
            }
            "type" => {
                let t = js::round(v) as i32;
                if t == slot.type_index && slot.pending_type < 0 {
                    return;
                }
                if !slot.running {
                    slot.pending_type = -1;
                    slot.load(t);
                } else {
                    slot.pending_type = t;
                }
            }
            "a" => {
                slot.a = v;
                slot.control(0);
            }
            "b" => {
                slot.b = v;
                slot.control(1);
            }
            _ => {}
        }
    }

    pub fn set_tempo(&mut self, bpm: f64) {
        for s in &mut self.slots {
            for u in &mut s.units {
                u.set_tempo(bpm);
            }
        }
    }

    /// A bar line (the sequencer's): the REVERSE delays' grains line up on it.
    pub fn bar(&mut self) {
        for s in &mut self.slots {
            if let Unit::Delay(d) = &mut s.units[2] {
                d.bar();
            }
        }
    }

    /// Jump to the current settings (project load).
    pub fn settle(&mut self) {
        self.flt_pos.set_immediate(self.flt_target);
        for s in &mut self.slots {
            s.vol.set_immediate(s.vol_target);
            if s.pending_type >= 0 {
                let t = s.pending_type;
                s.pending_type = -1;
                s.load(t);
            }
            s.switch_gain = 1.0;
            if let Unit::Delay(d) = &mut s.units[2] {
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

    /// The start of a block of `n` frames (FX 1, before its tracks are filtered): the cutoff
    /// over the block, one for the whole kit: the FILTER knob's glide, and ENV from the level
    /// of everything going through the filter (`kit`: the tracks summed, each by its FLT MIX),
    /// so a kick opens the filter for the hats too, as one filter over the drums would.
    pub fn begin(&mut self, n: usize, kit_l: &[f64], kit_r: &[f64]) {
        if !self.drums {
            return;
        }
        let on = dj_cutoff(self.flt_target) != 0.0 || dj_cutoff(self.flt_pos.value()) != 0.0;
        if !on {
            if self.flt_active {
                for f in &mut self.filters {
                    *f = TrackFilter::default();
                }
                self.flt_follow = 0.0;
                self.flt_counter = 0;
            }
            self.flt_pos.set_immediate(self.flt_target);
            self.flt_active = false;
            return;
        }
        self.flt_active = true;
        for i in 0..n.min(FX_BLOCK) {
            let a = kit_l[i].abs() + kit_r[i].abs();
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
                self.flt_fc = if fc < 20.0 { 20.0 } else { fc };
            }
            self.fc_buf[i] = self.flt_fc;
            self.mode_buf[i] = self.flt_mode;
        }
        if self.flt_follow < 1e-9 {
            self.flt_follow = 0.0;
        }
    }

    /// FX 1's FILTER is filtering now (after `begin`).
    pub fn filtering(&self) -> bool {
        self.flt_active
    }

    /// Track `ch`'s filter still rings (after its input stopped): keep running it.
    pub fn ringing(&self, ch: usize) -> bool {
        self.flt_active && self.filters.get(ch).is_some_and(|f| f.ringing)
    }

    /// FX 1's FILTER on track `ch`, in place: `mix[i]` of each frame filtered (the track's
    /// FLT MIX), the rest as it was. Every track has its own filter, all on the block's one
    /// cutoff (`begin`, called first), so together they sound as one filter over the kit,
    /// while each track can be in it or out of it.
    pub fn filter_track(&mut self, ch: usize, l: &mut [f64], r: &mut [f64], mix: &[f32]) {
        if !self.flt_active || ch >= TRACKS {
            return;
        }
        let f = &mut self.filters[ch];
        let mut peak = 0.0f64;
        for i in 0..l.len().min(FX_BLOCK) {
            let x = l[i];
            let y = r[i];
            let fc = self.fc_buf[i];
            if fc != f.fc {
                f.fc = fc;
                f.l.setup(fc, self.flt_reso, self.sr);
                f.r.setup(fc, self.flt_reso, self.sr);
            }
            f.l.process(x);
            f.r.process(y);
            let mode = self.mode_buf[i];
            let (fx, fy) = if mode < 0 { (f.l.low, f.r.low) } else if mode > 0 { (f.l.high, f.r.high) } else { (x, y) };
            let a = x.abs() + y.abs() + fx.abs() + fy.abs();
            if a > peak {
                peak = a;
            }
            let m = mix[i] as f64;
            if m >= 1.0 {
                l[i] = fx;
                r[i] = fy;
            } else if m > 0.0 {
                l[i] = x + (fx - x) * m;
                r[i] = y + (fy - y) * m;
            }
        }
        f.ringing = peak > 1e-7;
    }

    /// Reads the bus's inputs (FX 1's COMP input is changed in place) and ADDS the result
    /// into out: `n` frames (at most N).
    pub fn process<const N: usize>(&mut self, in_l: &mut BusIn<N>, in_r: &mut BusIn<N>, out_l: &mut [f32], out_r: &mut [f32], n: usize) {
        let n = n.min(N).min(FX_BLOCK);
        if let Some(c) = &mut self.comp {
            // In parallel: what the tracks put through it (their MIX), compressed, back in the mix.
            c.process(&mut in_l[0][..n], &mut in_r[0][..n]);
            for i in 0..n {
                js::add_f32(&mut out_l[i], in_l[0][i] as f64);
                js::add_f32(&mut out_r[i], in_r[0][i] as f64);
            }
        }
        let mut peak = 0.0f64;
        for s in &self.slots {
            for i in 0..n {
                let a = (in_l[s.input][i] as f64).abs() + (in_r[s.input][i] as f64).abs();
                if a > peak {
                    peak = a;
                }
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
            s.units[s.family].render(&in_l[s.input][..n], &in_r[s.input][..n], &mut self.wet_l, &mut self.wet_r, n);
            for i in 0..n {
                if s.pending_type >= 0 {
                    s.switch_gain -= self.switch_step;
                    if s.switch_gain <= 0.0 {
                        s.switch_gain = 0.0;
                        let t = s.pending_type;
                        s.pending_type = -1;
                        s.load(t);
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
        if any && !self.drums {
            self.tone(&in_l[SIDE][..n], &in_r[SIDE][..n], n);
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

    /// One input into every slot, as a track at every level 1 would send it (the tests'
    /// way in: FX 1 = filtered, then through COMP and into both effects; FX 2 = into all four).
    pub fn process_all(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        const N: usize = 64;
        let ones = [1.0f32; N];
        let mut done = 0;
        while done < in_l.len() {
            let n = (in_l.len() - done).min(N);
            let mut l = [0.0f32; N];
            let mut r = [0.0f32; N];
            l[..n].copy_from_slice(&in_l[done..done + n]);
            r[..n].copy_from_slice(&in_r[done..done + n]);
            let mut fl = [0.0f64; N];
            let mut fr = [0.0f64; N];
            for i in 0..n {
                fl[i] = l[i] as f64;
                fr[i] = r[i] as f64;
            }
            self.begin(n, &fl[..n], &fr[..n]);
            if self.drums && self.flt_active {
                self.filter_track(0, &mut fl[..n], &mut fr[..n], &ones[..n]);
                for i in 0..n {
                    l[i] = fl[i] as f32;
                    r[i] = fr[i] as f32;
                }
            }
            let mut bl: BusIn<N> = [l; BUS_INPUTS];
            let mut br: BusIn<N> = [r; BUS_INPUTS];
            self.process(&mut bl, &mut br, &mut out_l[done..done + n], &mut out_r[done..done + n], n);
            done += n;
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
