//! Stereo dub delay (ported from the TypeScript engine's Delay.ts): time follows the tempo (smoothed), a low-pass in
//! the feedback, tanh in the loop.

use crate::js;
use crate::math::tanh;
use crate::smoother::Smoother;

/// Tempo-synced divisions, in 16th notes (DLY TIME's choices).
pub const DELAY_SIXTEENTHS: [f64; 8] = [1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0];
const MAX_SECONDS: f64 = 4.5;

pub struct Delay {
    sr: f64,
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write: usize,
    bpm: f64,
    division: usize,
    time: Smoother,
    ret: Smoother,
    fdbk: f64,
    lp_coeff: f64,
    lp_l: f64,
    lp_r: f64,
}

impl Delay {
    /// max_seconds: the longest delay held (None = 4.5 s).
    pub fn new(sample_rate: f64, max_seconds: Option<f64>) -> Self {
        let len = (max_seconds.unwrap_or(MAX_SECONDS) * sample_rate).ceil() as usize;
        let mut d = Delay {
            sr: sample_rate,
            buf_l: vec![0.0; len],
            buf_r: vec![0.0; len],
            write: 0,
            bpm: 120.0,
            division: 2,
            time: Smoother::new(0.0, 0.12, sample_rate),
            ret: Smoother::new(0.6, 0.02, sample_rate),
            fdbk: 0.45,
            lp_coeff: 0.3,
            lp_l: 0.0,
            lp_r: 0.0,
        };
        d.time = Smoother::new(d.target_frames(), 0.12, sample_rate);
        d
    }

    pub fn set_tempo(&mut self, bpm: f64) {
        self.bpm = bpm;
        self.time.set_target(self.target_frames());
    }

    pub fn settle(&mut self) {
        self.time.set_immediate(self.target_frames());
    }

    pub fn set_param(&mut self, id: &str, v: f64) {
        match id {
            "dly_time" => { self.division = js::round(v) as usize; self.time.set_target(self.target_frames()); }
            "dly_fdbk" => self.fdbk = v,
            "dly_tone" => self.lp_coeff = 1.0 - (-2.0 * std::f64::consts::PI * v / self.sr).exp(),
            "dly_return" => self.ret.set_target(v),
            _ => {}
        }
    }

    /// In place: the wet added onto l / r.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let len = self.buf_l.len();
        for i in 0..l.len() {
            let d = self.time.next().min(len as f64 - 2.0);
            let mut rp = self.write as f64 - d;
            if rp < 0.0 {
                rp += len as f64;
            }
            if rp >= len as f64 {
                rp -= len as f64;
            }
            let i0 = rp.floor() as usize;
            let frac = rp - i0 as f64;
            let i1 = if i0 + 1 == len { 0 } else { i0 + 1 };
            let yl = self.buf_l[i0] as f64 + (self.buf_l[i1] as f64 - self.buf_l[i0] as f64) * frac;
            let yr = self.buf_r[i0] as f64 + (self.buf_r[i1] as f64 - self.buf_r[i0] as f64) * frac;
            self.lp_l += (yl - self.lp_l) * self.lp_coeff;
            self.lp_r += (yr - self.lp_r) * self.lp_coeff;
            if self.lp_l.abs() < 1e-15 {
                self.lp_l = 0.0;
            }
            if self.lp_r.abs() < 1e-15 {
                self.lp_r = 0.0;
            }
            self.buf_l[self.write] = (l[i] as f64 + tanh(self.lp_l * self.fdbk)) as f32;
            self.buf_r[self.write] = (r[i] as f64 + tanh(self.lp_r * self.fdbk)) as f32;
            self.write += 1;
            if self.write == len {
                self.write = 0;
            }
            let g = self.ret.next();
            js::add_f32(&mut l[i], yl * g);
            js::add_f32(&mut r[i], yr * g);
        }
    }

    pub fn reset(&mut self) {
        self.buf_l.fill(0.0);
        self.buf_r.fill(0.0);
        self.lp_l = 0.0;
        self.lp_r = 0.0;
    }

    fn target_frames(&self) -> f64 {
        DELAY_SIXTEENTHS[self.division] * 60.0 * self.sr / (self.bpm * 4.0)
    }
}
