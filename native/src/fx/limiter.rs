//! Master limiter, as src/fx/Limiter.ts: a look-ahead peak limiter at -1 dBFS (1.5 ms),
//! the window's minimum gain box-averaged so it lands as the peak leaves the delay, then a
//! slow release. Linked stereo.

use crate::js;

const LOOKAHEAD: f64 = 0.0015;
const RELEASE: f64 = 0.08;

pub struct Limiter {
    /// Look-ahead delay in frames (the limiter's latency).
    pub len: usize,
    ceiling: f64,
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    pos: usize,
    dq_val: Vec<f32>,
    dq_at: Vec<f64>,
    dq_head: usize,
    dq_tail: usize,
    boxv: Vec<f32>,
    box_sum: f64,
    box_pos: usize,
    n: f64,
    gain: f64,
    release: f64,
    /// Lowest gain in the last block (metering).
    pub reduction: f64,
}

impl Limiter {
    pub fn new(sample_rate: f64) -> Self {
        let len = (js::round(LOOKAHEAD * sample_rate) as usize).max(1);
        Limiter {
            len,
            ceiling: 10f64.powf(-1.0 / 20.0),
            delay_l: vec![0.0; len],
            delay_r: vec![0.0; len],
            pos: 0,
            dq_val: vec![0.0; len + 2],
            dq_at: vec![0.0; len + 2],
            dq_head: 0,
            dq_tail: 0,
            boxv: vec![1.0; len],
            box_sum: len as f64,
            box_pos: 0,
            n: 0.0,
            gain: 1.0,
            release: 1.0 - (-1.0 / (RELEASE * sample_rate)).exp(),
            reduction: 1.0,
        }
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let len = self.len;
        let cap = len + 2;
        let mut min_gain = 1.0;
        for i in 0..l.len() {
            let (xl, xr) = (l[i] as f64, r[i] as f64);
            let a = xl.abs().max(xr.abs());
            let need = if a > self.ceiling { self.ceiling / a } else { 1.0 };
            let now = self.n;
            self.n += 1.0;
            while self.dq_tail != self.dq_head && self.dq_val[(self.dq_tail + cap - 1) % cap] as f64 >= need {
                self.dq_tail = (self.dq_tail + cap - 1) % cap;
            }
            self.dq_val[self.dq_tail] = need as f32;
            self.dq_at[self.dq_tail] = now;
            self.dq_tail = (self.dq_tail + 1) % cap;
            while self.dq_at[self.dq_head] < now - len as f64 {
                self.dq_head = (self.dq_head + 1) % cap;
            }
            let wmin = self.dq_val[self.dq_head] as f64;
            self.box_sum += wmin - self.boxv[self.box_pos] as f64;
            self.boxv[self.box_pos] = wmin as f32;
            self.box_pos = if self.box_pos + 1 == len { 0 } else { self.box_pos + 1 };
            let target = self.box_sum / len as f64;
            self.gain = if target < self.gain { target } else { self.gain + (target - self.gain) * self.release };
            let dl = self.delay_l[self.pos] as f64;
            let dr = self.delay_r[self.pos] as f64;
            self.delay_l[self.pos] = l[i];
            self.delay_r[self.pos] = r[i];
            self.pos = if self.pos + 1 == len { 0 } else { self.pos + 1 };
            let ol = (dl * self.gain).clamp(-1.0, 1.0);
            let or = (dr * self.gain).clamp(-1.0, 1.0);
            l[i] = ol as f32;
            r[i] = or as f32;
            if self.gain < min_gain {
                min_gain = self.gain;
            }
        }
        if self.box_sum > len as f64 {
            self.box_sum = len as f64;
        }
        self.reduction = min_gain;
    }
}
