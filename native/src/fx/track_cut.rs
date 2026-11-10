//! A track's MID CUT (ported from the TypeScript engine's TrackCut.ts): one knob sets depth and width together, MID
//! FREQ the centre (an RBJ peaking cut); idle at 0.

use crate::smoother::Smoother;

const UPDATE: i32 = 32;
const TRACK_CUT_MAX_DB: f64 = 18.0;
const Q_NARROW: f64 = 2.5;
const Q_WIDE: f64 = 0.7;

pub struct TrackCut {
    sr: f64,
    freq: Smoother,
    amount: Smoother,
    counter: i32,
    freq_target: f64,
    amount_target: f64,
    b0: f64, b1: f64, b2: f64, a1: f64, a2: f64,
    x1l: f64, x2l: f64, y1l: f64, y2l: f64,
    x1r: f64, x2r: f64, y1r: f64, y2r: f64,
}

impl TrackCut {
    pub fn new(sample_rate: f64) -> Self {
        TrackCut {
            sr: sample_rate,
            freq: Smoother::new(1000.0, 0.03, sample_rate),
            amount: Smoother::new(0.0, 0.03, sample_rate),
            counter: 0,
            freq_target: 1000.0,
            amount_target: 0.0,
            b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0,
            x1l: 0.0, x2l: 0.0, y1l: 0.0, y2l: 0.0,
            x1r: 0.0, x2r: 0.0, y1r: 0.0, y2r: 0.0,
        }
    }

    pub fn set_freq(&mut self, hz: f64) {
        self.freq_target = hz;
        self.freq.set_target(hz);
    }

    pub fn set_amount(&mut self, a: f64) {
        self.amount_target = a;
        self.amount.set_target(a);
    }

    pub fn settle(&mut self) {
        self.freq.set_immediate(self.freq_target);
        self.amount.set_immediate(self.amount_target);
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if self.amount_target == 0.0 && self.amount.value() < 1e-4 {
            if self.amount.value() != 0.0 {
                self.amount.set_immediate(0.0);
                self.reset();
            }
            return;
        }
        for i in 0..l.len() {
            let f = self.freq.next();
            let a = self.amount.next();
            let due = self.counter <= 0;
            self.counter -= 1;
            if due {
                self.counter = UPDATE;
                self.coefficients(f, Q_NARROW + (Q_WIDE - Q_NARROW) * a, -TRACK_CUT_MAX_DB * a);
            }
            let xl = l[i] as f64;
            let yl = self.b0 * xl + self.b1 * self.x1l + self.b2 * self.x2l - self.a1 * self.y1l - self.a2 * self.y2l;
            self.x2l = self.x1l;
            self.x1l = xl;
            self.y2l = self.y1l;
            self.y1l = yl;
            let xr = r[i] as f64;
            let yr = self.b0 * xr + self.b1 * self.x1r + self.b2 * self.x2r - self.a1 * self.y1r - self.a2 * self.y2r;
            self.x2r = self.x1r;
            self.x1r = xr;
            self.y2r = self.y1r;
            self.y1r = yr;
            l[i] = yl as f32;
            r[i] = yr as f32;
        }
        if self.y1l.abs() < 1e-15 {
            self.y1l = 0.0;
            self.y2l = 0.0;
        }
        if self.y1r.abs() < 1e-15 {
            self.y1r = 0.0;
            self.y2r = 0.0;
        }
    }

    fn reset(&mut self) {
        self.x1l = 0.0;
        self.x2l = 0.0;
        self.y1l = 0.0;
        self.y2l = 0.0;
        self.x1r = 0.0;
        self.x2r = 0.0;
        self.y1r = 0.0;
        self.y2r = 0.0;
        self.counter = 0;
    }

    fn coefficients(&mut self, f: f64, q: f64, gain_db: f64) {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * std::f64::consts::PI * f.min(self.sr * 0.45) / self.sr;
        let alpha = w.sin() / (2.0 * q);
        let cos = w.cos();
        let a0 = 1.0 + alpha / a;
        self.b0 = (1.0 + alpha * a) / a0;
        self.b1 = (-2.0 * cos) / a0;
        self.b2 = (1.0 - alpha * a) / a0;
        self.a1 = (-2.0 * cos) / a0;
        self.a2 = (1.0 - alpha / a) / a0;
    }
}
