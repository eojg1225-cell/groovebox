//! Bus compressor (FX 1) (ported from the TypeScript engine's Compressor.ts): stereo-linked peak detection, gain
//! smoothed in dB, automatic make-up; RATIO 1:1 = off (bit-transparent).

use crate::math::pow10;

pub struct Compressor {
    sr: f64,
    thresh: f64,
    ratio: f64,
    attack: f64,
    release: f64,
    makeup_db: f64,
    gr_db: f64,
    last_exp: f64,
    last_gain: f64,
    /// Deepest gain reduction (dB) since the last read (metering).
    pub reduction: f64,
}

impl Compressor {
    pub fn new(sample_rate: f64) -> Self {
        let mut c = Compressor { sr: sample_rate, thresh: -18.0, ratio: 1.0, attack: 0.0, release: 0.0, makeup_db: 0.0, gr_db: 0.0, last_exp: f64::NAN, last_gain: 1.0, reduction: 0.0 };
        for (id, v) in [("cmp_thresh", -18.0), ("cmp_ratio", 1.0), ("cmp_attack", 0.005), ("cmp_release", 0.15)] {
            c.set_param(id, v);
        }
        c
    }

    pub fn set_param(&mut self, id: &str, v: f64) {
        match id {
            "cmp_thresh" => self.thresh = v,
            "cmp_ratio" => self.ratio = v.max(1.0),
            "cmp_attack" => self.attack = 1.0 - (-1.0 / (v.max(1e-5) * self.sr)).exp(),
            "cmp_release" => self.release = 1.0 - (-1.0 / (v.max(1e-4) * self.sr)).exp(),
            _ => {}
        }
        self.makeup_db = -self.thresh * (1.0 - 1.0 / self.ratio) / 2.0;
    }

    pub fn active(&self) -> bool {
        self.ratio > 1.0001 || self.gr_db > 1e-4
    }

    fn gain(&mut self, l: f64, r: f64) -> f64 {
        let a = l.abs().max(r.abs());
        let slope = 1.0 - 1.0 / self.ratio;
        let mut target = 0.0;
        if slope > 0.0 && a > 1e-6 {
            let over = 20.0 * a.log10() - self.thresh;
            if over > 0.0 {
                target = over * slope;
            }
        }
        self.gr_db += (target - self.gr_db) * if target > self.gr_db { self.attack } else { self.release };
        if self.gr_db > self.reduction {
            self.reduction = self.gr_db;
        }
        let e = (self.makeup_db - self.gr_db) / 20.0;
        if e != self.last_exp {
            self.last_exp = e;
            self.last_gain = pow10(e);
        }
        self.last_gain
    }

    /// In place.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if !self.active() {
            return;
        }
        for i in 0..l.len() {
            let g = self.gain(l[i] as f64, r[i] as f64);
            l[i] = (l[i] as f64 * g) as f32;
            r[i] = (r[i] as f64 * g) as f32;
        }
        if self.gr_db < 1e-6 {
            self.gr_db = 0.0;
        }
    }
}
