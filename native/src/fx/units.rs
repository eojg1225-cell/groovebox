//! The FX buses' effect units (ported from the TypeScript engine's units.ts): each writes its wet signal for a block
//! into the given buffers. MOD (CHORUS / ENSEMBLE / FLANGER / PHASER), DELAY (STEREO /
//! PING-PONG / TAPE / DUB TAPE / SWEEP / REVERSE / SLAPBACK), VERB (ROOM / HALL / PLATE /
//! EARLY / SHIMMER / SPRING), DIST (TUBE / FUZZ / BIT).

use crate::js;
use crate::math::{exp2, sin_rad, sin_turn, tanh};
use crate::dsp::Svf;
use crate::smoother::Smoother;

const TAU: f64 = 2.0 * std::f64::consts::PI;
/// The most samples a unit renders at once.
pub const FX_BLOCK: usize = 256;

/// Tiny values to 0 (as the TypeScript: a NaN becomes 0 too, which `contains` would not do).
#[inline]
#[allow(clippy::manual_range_contains)]
fn flush(x: f64) -> f64 {
    if x > 1e-15 || x < -1e-15 { x } else { 0.0 }
}

/// Linear-interpolated read `delay` samples behind `write`.
#[inline]
fn tap(buf: &[f32], write: usize, delay: f64) -> f64 {
    let len = buf.len() as f64;
    let mut rp = write as f64 - delay;
    if rp < 0.0 {
        rp += len;
    }
    if rp >= len {
        rp -= len;
    }
    let i0 = rp.floor() as usize;
    let i1 = if i0 + 1 == buf.len() { 0 } else { i0 + 1 };
    let f = rp - i0 as f64;
    buf[i0] as f64 + (buf[i1] as f64 - buf[i0] as f64) * f
}

fn one_pole(hz: f64, sr: f64) -> f64 {
    1.0 - (-TAU * hz.min(sr * 0.45) / sr).exp()
}

pub const MOD_MODES: [&str; 4] = ["CHORUS", "ENSEMBLE", "FLANGER", "PHASER"];
pub const VERB_MODES: [&str; 6] = ["ROOM", "HALL", "PLATE", "EARLY", "SHIMMER", "SPRING"];
pub const DELAY_MODES: [&str; 7] = ["STEREO", "PING-PONG", "TAPE", "DUB TAPE", "SWEEP", "REVERSE", "SLAPBACK"];
pub const DRIVE_MODES: [&str; 3] = ["TUBE", "FUZZ", "BIT"];
/// Tempo-synced delay times, in 16th steps (buses.ts FX_DELAY_TIMES).
pub const FX_DELAY_STEPS: [f64; 12] = [0.5, 2.0 / 3.0, 1.0, 4.0 / 3.0, 2.0, 3.0, 8.0 / 3.0, 4.0, 6.0, 8.0, 12.0, 16.0];
const PHASER_STAGES: usize = 6;
const MOD_UPDATE: i32 = 16;

fn mode_index(modes: &[&str], name: &str) -> usize {
    modes.iter().position(|m| *m == name).unwrap_or(0)
}

pub struct ModFx {
    sr: f64,
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write: usize,
    mode: usize,
    rate: f64,
    depth: f64,
    phase: f64,
    fb_l: f64,
    fb_r: f64,
    ap_xl: [f64; PHASER_STAGES],
    ap_yl: [f64; PHASER_STAGES],
    ap_xr: [f64; PHASER_STAGES],
    ap_yr: [f64; PHASER_STAGES],
    a_l: f64,
    a_r: f64,
    counter: i32,
}

impl ModFx {
    pub fn new(sample_rate: f64) -> Self {
        let len = (0.04 * sample_rate).ceil() as usize;
        ModFx {
            sr: sample_rate,
            buf_l: vec![0.0; len],
            buf_r: vec![0.0; len],
            write: 0,
            mode: 0,
            rate: 0.5,
            depth: 0.5,
            phase: 0.0,
            fb_l: 0.0,
            fb_r: 0.0,
            ap_xl: [0.0; PHASER_STAGES],
            ap_yl: [0.0; PHASER_STAGES],
            ap_xr: [0.0; PHASER_STAGES],
            ap_yr: [0.0; PHASER_STAGES],
            a_l: 0.0,
            a_r: 0.0,
            counter: 0,
        }
    }

    pub fn set_mode(&mut self, name: &str) {
        self.mode = mode_index(&MOD_MODES, name);
    }

    pub fn set(&mut self, id: &str, v: f64) {
        match id {
            "mod_rate" => self.rate = v,
            "mod_depth" => self.depth = v,
            _ => {}
        }
    }

    pub fn reset(&mut self) {
        self.buf_l.fill(0.0);
        self.buf_r.fill(0.0);
        self.fb_l = 0.0;
        self.fb_r = 0.0;
        self.ap_xl = [0.0; PHASER_STAGES];
        self.ap_yl = [0.0; PHASER_STAGES];
        self.ap_xr = [0.0; PHASER_STAGES];
        self.ap_yr = [0.0; PHASER_STAGES];
        self.counter = 0;
    }

    pub fn render(&mut self, in_l: &[f32], in_r: &[f32], wet_l: &mut [f32], wet_r: &mut [f32], n: usize) {
        let ms = self.sr / 1000.0;
        let inc = self.rate / self.sr;
        let d = self.depth;
        let len = self.buf_l.len();
        for i in 0..n {
            self.phase += inc;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
            let p = self.phase;
            let (mut yl, mut yr) = (0.0, 0.0);
            match self.mode {
                0 => {
                    self.buf_l[self.write] = in_l[i];
                    self.buf_r[self.write] = in_r[i];
                    yl = tap(&self.buf_l, self.write, (12.0 + 7.0 * d * (0.5 + 0.5 * sin_turn(p))) * ms);
                    yr = tap(&self.buf_r, self.write, (12.0 + 7.0 * d * (0.5 + 0.5 * sin_turn(p + 0.4))) * ms);
                }
                1 => {
                    self.buf_l[self.write] = in_l[i];
                    self.buf_r[self.write] = in_r[i];
                    let vib = 0.35 * d * sin_rad(TAU * p * 7.0) * ms;
                    for k in 0..3 {
                        let o = k as f64 / 3.0;
                        yl += tap(&self.buf_l, self.write, (9.0 + 3.0 * d * (0.5 + 0.5 * sin_turn(p + o))) * ms + vib);
                        yr += tap(&self.buf_r, self.write, (9.0 + 3.0 * d * (0.5 + 0.5 * sin_turn(p + o + 1.0 / 6.0))) * ms - vib);
                    }
                    yl *= 0.47;
                    yr *= 0.47;
                }
                2 => {
                    self.buf_l[self.write] = (in_l[i] as f64 + self.fb_l * 0.65) as f32;
                    self.buf_r[self.write] = (in_r[i] as f64 + self.fb_r * 0.65) as f32;
                    yl = tap(&self.buf_l, self.write, (0.25 + 4.75 * d * (0.5 + 0.5 * sin_turn(p))) * ms);
                    yr = tap(&self.buf_r, self.write, (0.25 + 4.75 * d * (0.5 + 0.5 * sin_turn(p + 0.25))) * ms);
                    self.fb_l = flush(yl);
                    self.fb_r = flush(yr);
                }
                _ => {
                    let due = self.counter <= 0;
                    self.counter -= 1;
                    if due {
                        self.counter = MOD_UPDATE;
                        let sr = self.sr;
                        let coef = |hz: f64| {
                            let tn = (std::f64::consts::PI * hz.min(sr * 0.45) / sr).tan();
                            (tn - 1.0) / (tn + 1.0)
                        };
                        self.a_l = coef(150.0 * exp2(d * 5.0 * (0.5 + 0.5 * sin_turn(p))));
                        self.a_r = coef(150.0 * exp2(d * 5.0 * (0.5 + 0.5 * sin_turn(p + 0.25))));
                    }
                    let mut xl = in_l[i] as f64 + self.fb_l * 0.5;
                    let mut xr = in_r[i] as f64 + self.fb_r * 0.5;
                    for k in 0..PHASER_STAGES {
                        let ol = self.a_l * xl + self.ap_xl[k] - self.a_l * self.ap_yl[k];
                        self.ap_xl[k] = xl;
                        self.ap_yl[k] = flush(ol);
                        xl = ol;
                        let or = self.a_r * xr + self.ap_xr[k] - self.a_r * self.ap_yr[k];
                        self.ap_xr[k] = xr;
                        self.ap_yr[k] = flush(or);
                        xr = or;
                    }
                    self.fb_l = flush(xl);
                    self.fb_r = flush(xr);
                    yl = xl;
                    yr = xr;
                }
            }
            self.write += 1;
            if self.write == len {
                self.write = 0;
            }
            wet_l[i] = yl as f32;
            wet_r[i] = yr as f32;
        }
    }
}

/// Allpass diffuser (the reverbs; REVERSE's smear later).
struct Allpass {
    buf: Vec<f32>,
    i: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Allpass { buf: vec![0.0; len.max(1)], i: 0 }
    }
    fn reset(&mut self) {
        self.buf.fill(0.0);
        self.i = 0;
    }
    #[inline]
    fn process(&mut self, x: f64, g: f64) -> f64 {
        let d = self.buf[self.i] as f64;
        let y = d - g * x;
        self.buf[self.i] = flush(x + g * y) as f32;
        self.i += 1;
        if self.i >= self.buf.len() {
            self.i = 0;
        }
        y
    }
    fn block(&mut self, v: &mut [f64], g: f64) {
        for x in v.iter_mut() {
            *x = self.process(*x, g);
        }
    }
}

/// Freeverb comb whose length follows SIZE.
struct Comb {
    buf: Vec<f32>,
    i: usize,
    store: f64,
}

impl Comb {
    fn new(len: usize) -> Self {
        Comb { buf: vec![0.0; len], i: 0, store: 0.0 }
    }
    fn reset(&mut self) {
        self.buf.fill(0.0);
        self.store = 0.0;
    }
    #[inline]
    fn write(&mut self, y: f64, x: f64, feedback: f64, damp: f64) -> f64 {
        self.store = flush(y * (1.0 - damp) + self.store * damp);
        self.buf[self.i] = (x + self.store * feedback) as f32;
        self.i += 1;
        if self.i == self.buf.len() {
            self.i = 0;
        }
        y
    }
    fn process(&mut self, x: f64, delay: f64, feedback: f64, damp: f64) -> f64 {
        let y = tap(&self.buf, self.i, delay);
        self.write(y, x, feedback, damp)
    }
    fn process_int(&mut self, x: f64, delay: usize, feedback: f64, damp: f64) -> f64 {
        let len = self.buf.len();
        let y = self.buf[(self.i + len - delay) % len] as f64;
        self.write(y, x, feedback, damp)
    }
    fn block_int(&mut self, x: &[f64], acc: &mut [f64], delay: usize, feedback: f64, damp: f64) {
        for j in 0..x.len() {
            acc[j] += self.process_int(x[j], delay, feedback, damp);
        }
    }
}

const COMBS: [f64; 8] = [1116.0, 1188.0, 1277.0, 1356.0, 1422.0, 1491.0, 1557.0, 1617.0];
const ALLPASSES: [f64; 4] = [556.0, 441.0, 341.0, 225.0];
const SPREAD: f64 = 23.0;
const MAX_STRETCH: f64 = 1.4;
const PLATE_DIFFUSE: [f64; 4] = [142.0, 107.0, 379.0, 277.0];
const EARLY_TAPS: [f64; 12] = [0.043, 0.097, 0.131, 0.197, 0.263, 0.331, 0.419, 0.523, 0.661, 0.787, 0.883, 1.0];
const SPRING_DISPERSE: [f64; 6] = [37.0, 53.0, 71.0, 89.0, 113.0, 131.0];
const SHIMMER_WINDOW: usize = 2048;

pub struct VerbFx {
    sr: f64,
    combs_l: Vec<Comb>,
    combs_r: Vec<Comb>,
    ap_l: Vec<Allpass>,
    ap_r: Vec<Allpass>,
    diff_l: Vec<Allpass>,
    diff_r: Vec<Allpass>,
    pre: Vec<f32>,
    pre_write: usize,
    stretch: Smoother,
    bx_l: [f64; FX_BLOCK],
    bx_r: [f64; FX_BLOCK],
    bl: [f64; FX_BLOCK],
    br: [f64; FX_BLOCK],
    mode: usize,
    size: f64,
    length: f64,
    early: Vec<f32>,
    early_write: usize,
    shim_buf: Vec<f32>,
    shim_write: usize,
    shim_phase: f64,
    shim_l: f64,
    shim_r: f64,
    spring_l: Vec<f32>,
    spring_r: Vec<f32>,
    spring_write: usize,
    disp_l: Vec<Allpass>,
    disp_r: Vec<Allpass>,
    spring_lp_l: f64,
    spring_lp_r: f64,
    int_l: [usize; 8],
    int_r: [usize; 8],
}

impl VerbFx {
    pub fn new(sample_rate: f64) -> Self {
        let scale = sample_rate / 44100.0;
        let ps = sample_rate / 29761.0;
        let s48 = sample_rate / 48000.0;
        let r = |x: f64| js::round(x) as usize;
        VerbFx {
            sr: sample_rate,
            combs_l: COMBS.iter().map(|c| Comb::new((c * scale * MAX_STRETCH).ceil() as usize + 4)).collect(),
            combs_r: COMBS.iter().map(|c| Comb::new(((c + SPREAD) * scale * MAX_STRETCH).ceil() as usize + 4)).collect(),
            ap_l: ALLPASSES.iter().map(|a| Allpass::new(r(a * scale))).collect(),
            ap_r: ALLPASSES.iter().map(|a| Allpass::new(r((a + SPREAD) * scale))).collect(),
            diff_l: PLATE_DIFFUSE.iter().map(|d| Allpass::new(r(d * ps))).collect(),
            diff_r: PLATE_DIFFUSE.iter().map(|d| Allpass::new(r(d * ps * 1.05))).collect(),
            pre: vec![0.0; (0.06 * sample_rate).ceil() as usize],
            pre_write: 0,
            stretch: Smoother::new(1.0, 0.08, sample_rate),
            bx_l: [0.0; FX_BLOCK],
            bx_r: [0.0; FX_BLOCK],
            bl: [0.0; FX_BLOCK],
            br: [0.0; FX_BLOCK],
            mode: 0,
            size: 0.5,
            length: 0.5,
            early: vec![0.0; (0.1 * sample_rate).ceil() as usize],
            early_write: 0,
            shim_buf: vec![0.0; SHIMMER_WINDOW * 2],
            shim_write: 0,
            shim_phase: 0.0,
            shim_l: 0.0,
            shim_r: 0.0,
            spring_l: vec![0.0; (0.09 * sample_rate).ceil() as usize],
            spring_r: vec![0.0; (0.09 * sample_rate).ceil() as usize],
            spring_write: 0,
            disp_l: SPRING_DISPERSE.iter().map(|d| Allpass::new(r(d * s48))).collect(),
            disp_r: SPRING_DISPERSE.iter().map(|d| Allpass::new(r(d * s48 * 1.13))).collect(),
            spring_lp_l: 0.0,
            spring_lp_r: 0.0,
            int_l: [0; 8],
            int_r: [0; 8],
        }
    }

    pub fn set_mode(&mut self, name: &str) {
        self.mode = mode_index(&VERB_MODES, name);
        self.stretch.set_immediate(self.stretch_target());
    }

    pub fn set(&mut self, id: &str, v: f64) {
        match id {
            "vrb_size" => { self.size = v; self.stretch.set_target(self.stretch_target()); }
            "vrb_len" => self.length = v,
            _ => {}
        }
    }

    fn stretch_target(&self) -> f64 {
        let s = self.size;
        match self.mode {
            0 => 0.3 + 0.45 * s,
            1 | 4 => 0.75 + 0.6 * s,
            2 => 0.45 + 0.5 * s,
            _ => 1.0,
        }
    }

    pub fn reset(&mut self) {
        self.combs_l.iter_mut().chain(self.combs_r.iter_mut()).for_each(Comb::reset);
        for a in self.ap_l.iter_mut().chain(&mut self.ap_r).chain(&mut self.diff_l).chain(&mut self.diff_r).chain(&mut self.disp_l).chain(&mut self.disp_r) {
            a.reset();
        }
        self.pre.fill(0.0);
        self.early.fill(0.0);
        self.shim_buf.fill(0.0);
        self.shim_l = 0.0;
        self.shim_r = 0.0;
        self.spring_l.fill(0.0);
        self.spring_r.fill(0.0);
        self.spring_lp_l = 0.0;
        self.spring_lp_r = 0.0;
    }

    pub fn render(&mut self, in_l: &[f32], in_r: &[f32], wet_l: &mut [f32], wet_r: &mut [f32], n: usize) {
        if self.mode == 3 {
            self.render_early(in_l, in_r, wet_l, wet_r, n);
            return;
        }
        if self.mode == 5 {
            self.render_spring(in_l, in_r, wet_l, wet_r, n);
            return;
        }
        let m = self.mode;
        let sr = self.sr;
        let scale = sr / 44100.0;
        let len = self.length;
        let feedback = if m == 0 { 0.55 + 0.35 * len } else if m == 2 { 0.75 + 0.23 * len } else { 0.78 + 0.2 * len };
        let damp = if m == 0 { 0.45 } else if m == 2 { 0.08 } else { 0.3 };
        let pre_ms = if m == 0 { 2.0 } else if m == 2 { 1.0 } else { 8.0 + 40.0 * self.size };
        let pre_delay = js::round(pre_ms * sr / 1000.0) as usize;
        let shimmer = if m == 4 { 0.3 + 0.35 * len } else { 0.0 };
        let pre_len = self.pre.len();
        let st_end = self.stretch_target();
        for k in 0..8 {
            self.int_l[k] = js::round(COMBS[k] * scale * st_end) as usize;
            self.int_r[k] = js::round((COMBS[k] + SPREAD) * scale * st_end) as usize;
        }
        if shimmer == 0.0 && self.stretch.settled() && self.stretch.value() == st_end {
            self.render_block(in_l, in_r, wet_l, wet_r, n, feedback, damp, pre_delay);
            return;
        }
        let pd = pre_delay.min(pre_len - 1);
        for i in 0..n {
            let st = self.stretch.next();
            self.pre[self.pre_write] = ((in_l[i] as f64 + in_r[i] as f64) * 0.015) as f32;
            let rp = (self.pre_write + pre_len - pd) % pre_len;
            let mut xl = self.pre[rp] as f64;
            self.pre_write += 1;
            if self.pre_write == pre_len {
                self.pre_write = 0;
            }
            let mut xr = xl;
            if m == 2 {
                for k in 0..self.diff_l.len() {
                    let g = if k < 2 { 0.75 } else { 0.625 };
                    xl = self.diff_l[k].process(xl, g);
                    xr = self.diff_r[k].process(xr, g);
                }
            }
            if shimmer > 0.0 {
                xl += self.shim_l * shimmer * 0.015;
                xr += self.shim_r * shimmer * 0.015;
            }
            let (mut l, mut r) = (0.0, 0.0);
            if st == st_end {
                for k in 0..8 {
                    l += self.combs_l[k].process_int(xl, self.int_l[k], feedback, damp);
                    r += self.combs_r[k].process_int(xr, self.int_r[k], feedback, damp);
                }
            } else {
                for k in 0..8 {
                    l += self.combs_l[k].process(xl, COMBS[k] * scale * st, feedback, damp);
                    r += self.combs_r[k].process(xr, (COMBS[k] + SPREAD) * scale * st, feedback, damp);
                }
            }
            for k in 0..4 {
                l = self.ap_l[k].process(l, 0.5);
                r = self.ap_r[k].process(r, 0.5);
            }
            if shimmer > 0.0 {
                self.shimmer_step(l, r);
            }
            wet_l[i] = (l * 3.0) as f32;
            wet_r[i] = (r * 3.0) as f32;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render_block(&mut self, in_l: &[f32], in_r: &[f32], wet_l: &mut [f32], wet_r: &mut [f32], n: usize, feedback: f64, damp: f64, pre_delay: usize) {
        let pre_len = self.pre.len();
        let pd = pre_delay.min(pre_len - 1);
        for i in 0..n {
            self.pre[self.pre_write] = ((in_l[i] as f64 + in_r[i] as f64) * 0.015) as f32;
            let rp = (self.pre_write + pre_len - pd) % pre_len;
            self.bx_l[i] = self.pre[rp] as f64;
            self.bx_r[i] = self.bx_l[i];
            self.pre_write += 1;
            if self.pre_write == pre_len {
                self.pre_write = 0;
            }
            self.bl[i] = 0.0;
            self.br[i] = 0.0;
        }
        if self.mode == 2 {
            for k in 0..self.diff_l.len() {
                let g = if k < 2 { 0.75 } else { 0.625 };
                self.diff_l[k].block(&mut self.bx_l[..n], g);
                self.diff_r[k].block(&mut self.bx_r[..n], g);
            }
        }
        for k in 0..8 {
            self.combs_l[k].block_int(&self.bx_l[..n], &mut self.bl[..n], self.int_l[k], feedback, damp);
            self.combs_r[k].block_int(&self.bx_r[..n], &mut self.br[..n], self.int_r[k], feedback, damp);
        }
        for k in 0..4 {
            self.ap_l[k].block(&mut self.bl[..n], 0.5);
            self.ap_r[k].block(&mut self.br[..n], 0.5);
        }
        for i in 0..n {
            wet_l[i] = (self.bl[i] * 3.0) as f32;
            wet_r[i] = (self.br[i] * 3.0) as f32;
        }
    }

    fn shimmer_step(&mut self, l: f64, r: f64) {
        let w = SHIMMER_WINDOW as f64;
        self.shim_buf[self.shim_write] = ((l + r) * 0.5) as f32;
        self.shim_phase += 1.0 / w;
        if self.shim_phase >= 1.0 {
            self.shim_phase -= 1.0;
        }
        let mut y = 0.0;
        for k in 0..2 {
            let mut ph = self.shim_phase + k as f64 * 0.5;
            if ph >= 1.0 {
                ph -= 1.0;
            }
            let g = sin_rad(std::f64::consts::PI * ph);
            y += tap(&self.shim_buf, self.shim_write, w * (1.0 - ph) + 1.0) * g * g;
        }
        self.shim_write += 1;
        if self.shim_write == self.shim_buf.len() {
            self.shim_write = 0;
        }
        self.shim_l = flush(y);
        self.shim_r = flush(y);
    }

    fn render_early(&mut self, in_l: &[f32], in_r: &[f32], wet_l: &mut [f32], wet_r: &mut [f32], n: usize) {
        let span = (10.0 + 80.0 * self.size) * self.sr / 1000.0;
        let steep = 1.0 + 3.0 * (1.0 - self.length);
        let len = self.early.len();
        let taps = EARLY_TAPS.len();
        for i in 0..n {
            self.early[self.early_write] = ((in_l[i] as f64 + in_r[i] as f64) * 0.5) as f32;
            let (mut l, mut r) = (0.0, 0.0);
            for k in 0..taps {
                let g = (1.0 - k as f64 / taps as f64).powf(steep) * if k % 2 == 1 { -0.55 } else { 0.6 };
                l += tap(&self.early, self.early_write, (len as f64 - 2.0).min(EARLY_TAPS[k] * span + 1.0)) * g;
                r += tap(&self.early, self.early_write, (len as f64 - 2.0).min(EARLY_TAPS[(k + 3) % taps] * span * 0.93 + 1.0)) * g;
            }
            self.early_write += 1;
            if self.early_write == len {
                self.early_write = 0;
            }
            wet_l[i] = l as f32;
            wet_r[i] = r as f32;
        }
    }

    fn render_spring(&mut self, in_l: &[f32], in_r: &[f32], wet_l: &mut [f32], wet_r: &mut [f32], n: usize) {
        let len = self.spring_l.len();
        let d = (30.0 + 50.0 * self.size) * self.sr / 1000.0;
        let fb = 0.5 + 0.45 * self.length;
        let lp = one_pole(4500.0, self.sr);
        for i in 0..n {
            let mut l = tap(&self.spring_l, self.spring_write, (len as f64 - 2.0).min(d));
            let mut r = tap(&self.spring_r, self.spring_write, (len as f64 - 2.0).min(d * 0.87));
            for k in 0..self.disp_l.len() {
                l = self.disp_l[k].process(l, 0.65);
                r = self.disp_r[k].process(r, 0.65);
            }
            self.spring_lp_l = flush(self.spring_lp_l + (l - self.spring_lp_l) * lp);
            self.spring_lp_r = flush(self.spring_lp_r + (r - self.spring_lp_r) * lp);
            let x = (in_l[i] as f64 + in_r[i] as f64) * 0.3;
            self.spring_l[self.spring_write] = (x + tanh(self.spring_lp_l * fb)) as f32;
            self.spring_r[self.spring_write] = (x + tanh(self.spring_lp_r * fb)) as f32;
            self.spring_write += 1;
            if self.spring_write == len {
                self.spring_write = 0;
            }
            wet_l[i] = self.spring_lp_l as f32;
            wet_r[i] = self.spring_lp_r as f32;
        }
    }
}

/// One unit of a bus, by kind.
pub enum Unit {
    Mod(Box<ModFx>),
    Delay(Box<DelayFx>),
    Verb(Box<VerbFx>),
    Drive(DriveFx),
}

impl Unit {
    pub fn set_mode(&mut self, name: &str) {
        match self {
            Unit::Mod(u) => u.set_mode(name),
            Unit::Delay(u) => u.set_mode(name),
            Unit::Verb(u) => u.set_mode(name),
            Unit::Drive(u) => u.set_mode(name),
        }
    }
    pub fn set(&mut self, id: &str, v: f64) {
        match self {
            Unit::Mod(u) => u.set(id, v),
            Unit::Delay(u) => u.set(id, v),
            Unit::Verb(u) => u.set(id, v),
            Unit::Drive(u) => u.set(id, v),
        }
    }
    pub fn set_tempo(&mut self, bpm: f64) {
        if let Unit::Delay(u) = self {
            u.set_tempo(bpm);
        }
    }
    pub fn reset(&mut self) {
        match self {
            Unit::Mod(u) => u.reset(),
            Unit::Delay(u) => u.reset(),
            Unit::Verb(u) => u.reset(),
            Unit::Drive(u) => u.reset(),
        }
    }
    pub fn render(&mut self, in_l: &[f32], in_r: &[f32], wet_l: &mut [f32], wet_r: &mut [f32], n: usize) {
        match self {
            Unit::Mod(u) => u.render(in_l, in_r, wet_l, wet_r, n),
            Unit::Delay(u) => u.render(in_l, in_r, wet_l, wet_r, n),
            Unit::Verb(u) => u.render(in_l, in_r, wet_l, wet_r, n),
            Unit::Drive(u) => u.render(in_l, in_r, wet_l, wet_r, n),
        }
    }
}

const SMEAR: [f64; 6] = [225.0, 341.0, 441.0, 556.0, 1100.0, 1700.0];

pub struct DelayFx {
    sr: f64,
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write: usize,
    mode: usize,
    bpm: f64,
    steps: f64,
    fdbk: f64,
    time: Smoother,
    lp_l: f64, lp_r: f64, hp_l: f64, hp_r: f64,
    lfo: f64,
    bp_l: Svf,
    bp_r: Svf,
    counter: i32,
    cycle: usize,
    wet_l: f64, wet_r: f64,
    sm_l: Vec<Allpass>,
    sm_r: Vec<Allpass>,
}

impl DelayFx {
    /// reverse: this unit may be asked for REVERSE (a longer buffer).
    pub fn new(sample_rate: f64, reverse: bool) -> Self {
        let seconds = if reverse { 8.5 } else { 6.2 };
        let len = (seconds * sample_rate).ceil() as usize;
        let scale = sample_rate / 48000.0;
        let mut d = DelayFx {
            sr: sample_rate,
            buf_l: vec![0.0; len],
            buf_r: vec![0.0; len],
            write: 0,
            mode: 0,
            bpm: 120.0,
            steps: 2.0,
            fdbk: 0.4,
            time: Smoother::new(0.0, 0.12, sample_rate),
            lp_l: 0.0, lp_r: 0.0, hp_l: 0.0, hp_r: 0.0,
            lfo: 0.0,
            bp_l: Svf::default(),
            bp_r: Svf::default(),
            counter: 0,
            cycle: 0,
            wet_l: 0.0, wet_r: 0.0,
            sm_l: if reverse { SMEAR.iter().map(|d| Allpass::new(js::round(d * scale) as usize)).collect() } else { vec![] },
            sm_r: if reverse { SMEAR.iter().map(|d| Allpass::new(js::round(d * scale * 1.07) as usize)).collect() } else { vec![] },
        };
        d.time = Smoother::new(d.target(), 0.12, sample_rate);
        d
    }

    pub fn set_mode(&mut self, name: &str) {
        self.mode = mode_index(&DELAY_MODES, name);
    }

    pub fn set(&mut self, id: &str, v: f64) {
        match id {
            "dly_rate" => {
                let i = js::round(v);
                self.steps = if i < 0.0 { 2.0 } else { FX_DELAY_STEPS.get(i as usize).copied().unwrap_or(2.0) };
                self.time.set_target(self.target());
            }
            "dly_fdbk" => self.fdbk = v,
            _ => {}
        }
    }

    pub fn set_tempo(&mut self, bpm: f64) {
        self.bpm = bpm;
        self.time.set_target(self.target());
    }

    pub fn settle(&mut self) {
        self.time.set_immediate(self.target());
    }

    pub fn reset(&mut self) {
        self.buf_l.fill(0.0);
        self.buf_r.fill(0.0);
        self.lp_l = 0.0;
        self.lp_r = 0.0;
        self.hp_l = 0.0;
        self.hp_r = 0.0;
        self.bp_l.reset();
        self.bp_r.reset();
        self.wet_l = 0.0;
        self.wet_r = 0.0;
        self.sm_l.iter_mut().chain(&mut self.sm_r).for_each(Allpass::reset);
    }

    fn target(&self) -> f64 {
        self.steps * 60.0 * self.sr / (self.bpm * 4.0)
    }

    pub fn render(&mut self, in_l: &[f32], in_r: &[f32], wet_l: &mut [f32], wet_r: &mut [f32], n: usize) {
        if self.mode == 5 {
            self.render_reverse(in_l, in_r, wet_l, wet_r, n);
            return;
        }
        let sr = self.sr;
        let len = self.buf_l.len();
        let m = self.mode;
        let lp_hz = match m { 2 => 3500.0, 3 => 1800.0, 6 => 7000.0, _ => 6000.0 };
        let hp_hz = match m { 2 => 100.0, 3 => 300.0, _ => 40.0 };
        let lp = one_pole(lp_hz, sr);
        let hp = one_pole(hp_hz, sr);
        let sat = match m { 3 => 2.0, 2 => 1.3, _ => 1.0 };
        let wow = match m { 3 => 0.004, 2 => 0.0025, _ => 0.0 };
        let fb = if m == 6 { self.fdbk * 0.3 } else { self.fdbk };
        let lfo_inc = (self.bpm / 60.0 / 8.0) / sr;
        for i in 0..n {
            self.lfo += if m == 4 { lfo_inc } else if m == 2 || m == 3 { 0.6 / sr } else { 0.0 };
            if self.lfo >= 1.0 {
                self.lfo -= 1.0;
            }
            let mut d = self.time.next();
            if wow > 0.0 {
                d *= 1.0 + wow * sin_turn(self.lfo) + wow * 0.2 * sin_rad(TAU * self.lfo * 11.7);
            }
            d = d.max(2.0).min(len as f64 - 2.0);
            let mut yl = tap(&self.buf_l, self.write, d);
            let mut yr = tap(&self.buf_r, self.write, d);
            self.lp_l += (yl - self.lp_l) * lp;
            self.lp_r += (yr - self.lp_r) * lp;
            self.hp_l += (self.lp_l - self.hp_l) * hp;
            self.hp_r += (self.lp_r - self.hp_r) * hp;
            let mut fl = self.lp_l - self.hp_l;
            let mut fr = self.lp_r - self.hp_r;
            if m == 4 {
                let due = self.counter <= 0;
                self.counter -= 1;
                if due {
                    self.counter = 16;
                    let hz = 400.0 * exp2(3.3 * (0.5 + 0.5 * sin_turn(self.lfo)));
                    self.bp_l.setup(hz, 0.75, sr);
                    self.bp_r.setup(hz * 1.12, 0.75, sr);
                }
                self.bp_l.process(fl);
                self.bp_r.process(fr);
                fl = self.bp_l.band * 1.6;
                fr = self.bp_r.band * 1.6;
                yl = fl;
                yr = fr;
            }
            if sat > 1.0 {
                fl = tanh(fl * sat) / sat;
                fr = tanh(fr * sat) / sat;
            }
            let sl = flush(tanh(fl * fb));
            let srr = flush(tanh(fr * fb));
            let (il, ir) = (in_l[i] as f64, in_r[i] as f64);
            if m == 1 {
                self.buf_l[self.write] = ((il + ir) * 0.5 + srr) as f32;
                self.buf_r[self.write] = sl as f32;
            } else if m == 6 {
                let mono = (il + ir) * 0.5;
                self.buf_l[self.write] = (mono + sl) as f32;
                self.buf_r[self.write] = (mono + srr) as f32;
            } else {
                self.buf_l[self.write] = (il + sl) as f32;
                self.buf_r[self.write] = (ir + srr) as f32;
            }
            self.write += 1;
            if self.write == len {
                self.write = 0;
            }
            if m == 2 || m == 3 {
                yl = self.lp_l - self.hp_l;
                yr = self.lp_r - self.hp_r;
            }
            wet_l[i] = yl as f32;
            wet_r[i] = yr as f32;
        }
        self.lp_l = flush(self.lp_l);
        self.lp_r = flush(self.lp_r);
        self.hp_l = flush(self.hp_l);
        self.hp_r = flush(self.hp_r);
    }

    fn render_reverse(&mut self, in_l: &[f32], in_r: &[f32], wet_l: &mut [f32], wet_r: &mut [f32], n: usize) {
        let size = self.buf_l.len();
        let len = (js::round(self.time.value()).min((size / 2) as f64 - 2.0)).max(256.0) as usize;
        let g = 0.57;
        for i in 0..n {
            self.time.next();
            let fb = self.fdbk;
            self.buf_l[self.write] = (in_l[i] as f64 + if fb > 0.0 { tanh(self.wet_l * fb) } else { 0.0 }) as f32;
            self.buf_r[self.write] = (in_r[i] as f64 + if fb > 0.0 { tanh(self.wet_r * fb) } else { 0.0 }) as f32;
            if self.cycle >= len {
                self.cycle -= len;
            }
            let (mut yl, mut yr) = (0.0, 0.0);
            for k in 0..2 {
                let mut ph = self.cycle as f64 / len as f64 + k as f64 * 0.5;
                if ph >= 1.0 {
                    ph -= 1.0;
                }
                let w = sin_rad(std::f64::consts::PI * ph);
                let win = w * w;
                let d = 2.0 * len as f64 * ph + 1.0;
                yl += tap(&self.buf_l, self.write, d) * win;
                yr += tap(&self.buf_r, self.write, d) * win;
            }
            let (mut dl, mut dr) = (yl, yr);
            for a in 0..self.sm_l.len() {
                dl = self.sm_l[a].process(dl, g);
                dr = self.sm_r[a].process(dr, g);
            }
            yl += (dl - yl) * 0.4;
            yr += (dr - yr) * 0.4;
            self.wet_l = flush(yl);
            self.wet_r = flush(yr);
            self.write += 1;
            if self.write >= size {
                self.write = 0;
            }
            self.cycle += 1;
            wet_l[i] = yl as f32;
            wet_r[i] = yr as f32;
        }
    }
}

pub struct DriveFx {
    sr: f64,
    mode: usize,
    drive: f64,
    lp: f64,
    lp_l: f64, lp_r: f64,
    dc_xl: f64, dc_yl: f64, dc_xr: f64, dc_yr: f64,
    hold: i32, held_l: f64, held_r: f64,
}

impl DriveFx {
    pub fn new(sample_rate: f64) -> Self {
        DriveFx { sr: sample_rate, mode: 0, drive: 0.4, lp: 0.5, lp_l: 0.0, lp_r: 0.0, dc_xl: 0.0, dc_yl: 0.0, dc_xr: 0.0, dc_yr: 0.0, hold: 0, held_l: 0.0, held_r: 0.0 }
    }

    pub fn set_mode(&mut self, name: &str) {
        self.mode = mode_index(&DRIVE_MODES, name);
    }

    pub fn set(&mut self, id: &str, v: f64) {
        match id {
            "drv_drive" => self.drive = v,
            "drv_tone" => self.lp = one_pole(v, self.sr),
            _ => {}
        }
    }

    pub fn reset(&mut self) {
        self.lp_l = 0.0;
        self.lp_r = 0.0;
        self.dc_xl = 0.0;
        self.dc_yl = 0.0;
        self.dc_xr = 0.0;
        self.dc_yr = 0.0;
        self.hold = 0;
    }

    pub fn render(&mut self, in_l: &[f32], in_r: &[f32], wet_l: &mut [f32], wet_r: &mut [f32], n: usize) {
        let d = self.drive;
        let dc = 1.0 - TAU * 10.0 / self.sr;
        let g = if self.mode == 1 { 1.0 + 200.0 * d * d } else { 1.0 + 30.0 * d * d };
        let bias = 0.2;
        let tb = tanh(bias);
        let levels = 2f64.powf(16.0 - 13.0 * d);
        let hold_n = 1 + (d * d * 30.0).floor() as i32;
        for i in 0..n {
            let mut l = in_l[i] as f64;
            let mut r = in_r[i] as f64;
            if self.mode == 0 {
                l = (tanh(l * g + bias) - tb) * 0.8;
                r = (tanh(r * g + bias) - tb) * 0.8;
                let yl = l - self.dc_xl + dc * self.dc_yl;
                self.dc_xl = l;
                self.dc_yl = flush(yl);
                l = yl;
                let yr = r - self.dc_xr + dc * self.dc_yr;
                self.dc_xr = r;
                self.dc_yr = flush(yr);
                r = yr;
            } else if self.mode == 1 {
                l = (tanh(l * g) * 1.5).clamp(-1.0, 1.0) * 0.6;
                r = (tanh(r * g) * 1.5).clamp(-1.0, 1.0) * 0.6;
            } else {
                if self.hold <= 0 {
                    self.held_l = js::round(l * levels) / levels;
                    self.held_r = js::round(r * levels) / levels;
                    self.hold = hold_n;
                }
                self.hold -= 1;
                l = self.held_l;
                r = self.held_r;
            }
            self.lp_l += (l - self.lp_l) * self.lp;
            self.lp_r += (r - self.lp_r) * self.lp;
            wet_l[i] = self.lp_l as f32;
            wet_r[i] = self.lp_r as f32;
        }
        self.lp_l = flush(self.lp_l);
        self.lp_r = flush(self.lp_r);
    }
}
