//! AIR's room (ported from the TypeScript engine's airRoom.ts): the drum through a fixed pre-EQ,
//! early reflections and a dense damped-comb tail under a per-hit envelope (KICK, SNARE),
//! or the HAT's natural room (no envelope, SIZE = its RT60). Mono, allocation-free once built.

use crate::dsp::Svf;
use crate::js;

const NATURAL_RT_MIN: f64 = 0.03;
const NATURAL_RT_MAX: f64 = 1.2;
const TAIL_RT: f64 = 4.0;
const AIR_LENGTH: f64 = 0.5;
const ENV_POINTS: usize = 256;
const TAIL_BEND: f64 = 10.0;
const EARLY_MS: [f64; 6] = [4.3, 7.9, 11.6, 16.3, 21.7, 27.1];
const EARLY_GAIN: [f64; 6] = [0.55, -0.45, 0.38, -0.31, 0.25, -0.2];
const COMB_MS: [f64; 4] = [19.7, 23.3, 27.1, 31.9];
const ALLPASS_MS: [f64; 2] = [5.1, 1.7];
const ALLPASS_G: f64 = 0.6;
const PRE_MS: f64 = 3.0;
const DAMP: f64 = 0.35;
const EQ_RESO: f64 = 0.3;
const ROOM_GAIN: f64 = 1.175;
const TAIL_GAIN: f64 = 0.32;

pub struct AirRoom {
    hp1: Svf,
    hp2: Svf,
    lp: Svf,
    line: Vec<f32>,
    write: usize,
    early: [usize; 6],
    pre: usize,
    combs: [Vec<f32>; 4],
    comb_at: [usize; 4],
    comb_store: [f64; 4],
    comb_g: [f64; 4],
    aps: [Vec<f32>; 2],
    ap_at: [usize; 2],
    sr: f64,
    env: [f32; ENV_POINTS + 1],
    env_pos: f64,
    env_step: f64,
    natural: bool,
}

impl AirRoom {
    pub fn new(sample_rate: f64, high_pass: f64, low_pass: f64, natural: bool) -> Self {
        let n = |ms: f64| (js::round(ms / 1000.0 * sample_rate)).max(1.0) as usize;
        let mut hp1 = Svf::default();
        let mut hp2 = Svf::default();
        let mut lp = Svf::default();
        hp1.setup(high_pass, EQ_RESO, sample_rate);
        hp2.setup(high_pass, EQ_RESO, sample_rate);
        lp.setup(low_pass, EQ_RESO, sample_rate);
        let early = EARLY_MS.map(|ms| n(PRE_MS + ms));
        let pre = early[0] - js::round(EARLY_MS[0] / 1000.0 * sample_rate) as usize;
        let combs = COMB_MS.map(|ms| vec![0f32; n(ms)]);
        let mut comb_g = [0.0; 4];
        for (k, c) in combs.iter().enumerate() {
            comb_g[k] = 10f64.powf(-3.0 * c.len() as f64 / sample_rate / TAIL_RT);
        }
        let mut room = AirRoom {
            hp1,
            hp2,
            lp,
            line: vec![0f32; n(PRE_MS + EARLY_MS[5]) + 1],
            write: 0,
            early,
            pre,
            combs,
            comb_at: [0; 4],
            comb_store: [0.0; 4],
            comb_g,
            aps: ALLPASS_MS.map(|ms| vec![0f32; n(ms)]),
            ap_at: [0; 2],
            sr: sample_rate,
            env: [0.0; ENV_POINTS + 1],
            env_pos: ENV_POINTS as f64,
            env_step: ENV_POINTS as f64 / (AIR_LENGTH * sample_rate),
            natural,
        };
        room.set_tail(0.4);
        room
    }

    /// TAIL 0..1 (NATURAL: SIZE, the tail's RT60).
    pub fn set_tail(&mut self, v: f64) {
        let x = v.clamp(0.0, 1.0);
        if self.natural {
            let rt = NATURAL_RT_MIN * (NATURAL_RT_MAX / NATURAL_RT_MIN).powf(x);
            for (k, c) in self.combs.iter().enumerate() {
                self.comb_g[k] = 10f64.powf(-3.0 * c.len() as f64 / self.sr / rt);
            }
            return;
        }
        let k = 1.0 + TAIL_BEND * (2.0 * x - 1.0).abs();
        for i in 0..=ENV_POINTS {
            let t = i as f64 / ENV_POINTS as f64;
            self.env[i] = (if x < 0.5 { (1.0 - t).powf(k) } else { 1.0 - t.powf(k) }) as f32;
        }
        self.env[ENV_POINTS] = 0.0;
    }

    /// A hit: the envelope starts again.
    pub fn trigger(&mut self) {
        self.env_pos = 0.0;
    }

    pub fn reset(&mut self) {
        self.hp1.reset();
        self.hp2.reset();
        self.lp.reset();
        self.line.fill(0.0);
        for c in &mut self.combs {
            c.fill(0.0);
        }
        for a in &mut self.aps {
            a.fill(0.0);
        }
        self.comb_store = [0.0; 4];
        self.env_pos = ENV_POINTS as f64;
    }

    /// Mono in, mono wet out, in place.
    pub fn process(&mut self, buf: &mut [f32]) {
        let len = self.line.len();
        for s in buf.iter_mut() {
            self.hp1.process(*s as f64);
            self.hp2.process(self.hp1.high);
            self.lp.process(self.hp2.high);
            self.line[self.write] = self.lp.low as f32;
            let mut er = 0.0;
            for k in 0..6 {
                let rp = (self.write + len - self.early[k]) % len;
                er += self.line[rp] as f64 * EARLY_GAIN[k];
            }
            let rp = (self.write + len - self.pre) % len;
            let into = self.line[rp] as f64 * 0.25;
            let mut tail = 0.0;
            for k in 0..4 {
                let c = &mut self.combs[k];
                let at = self.comb_at[k];
                let out = c[at] as f64;
                let mut store = out * (1.0 - DAMP) + self.comb_store[k] * DAMP;
                if store < 1e-15 && store > -1e-15 {
                    store = 0.0;
                }
                self.comb_store[k] = store;
                c[at] = (into + store * self.comb_g[k]) as f32;
                self.comb_at[k] = if at + 1 == c.len() { 0 } else { at + 1 };
                tail += out;
            }
            for k in 0..2 {
                let a = &mut self.aps[k];
                let at = self.ap_at[k];
                let d = a[at] as f64;
                let v = d - ALLPASS_G * tail;
                let mut w = tail + ALLPASS_G * v;
                if w < 1e-15 && w > -1e-15 {
                    w = 0.0;
                }
                a[at] = w as f32;
                self.ap_at[k] = if at + 1 == a.len() { 0 } else { at + 1 };
                tail = v;
            }
            self.write += 1;
            if self.write == len {
                self.write = 0;
            }
            let mut g = 0.0;
            if self.natural {
                g = 1.0 / ROOM_GAIN;
            } else if self.env_pos < ENV_POINTS as f64 {
                let at = self.env_pos as usize;
                let f = self.env_pos - at as f64;
                g = self.env[at] as f64 + (self.env[at + 1] as f64 - self.env[at] as f64) * f;
                self.env_pos += self.env_step;
            }
            *s = ((er + tail * TAIL_GAIN) * g * ROOM_GAIN) as f32;
        }
    }
}
