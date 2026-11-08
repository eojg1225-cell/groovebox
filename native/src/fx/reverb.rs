//! Freeverb-style stereo reverb with pre-delay, as src/fx/Reverb.ts (PLUCK's room). Each
//! comb and allpass runs over a block at a time.

use crate::js;
use crate::smoother::Smoother;

const COMBS: [f64; 8] = [1116.0, 1188.0, 1277.0, 1356.0, 1422.0, 1491.0, 1557.0, 1617.0];
const ALLPASSES: [f64; 4] = [556.0, 441.0, 341.0, 225.0];
const STEREO_SPREAD: f64 = 23.0;
const INPUT_GAIN: f64 = 0.015;
const BLOCK: usize = 128;

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
    fn block(&mut self, x: &[f64], acc: &mut [f64], feedback: f64, damp: f64) {
        let len = self.buf.len();
        let (mut i, mut store) = (self.i, self.store);
        for j in 0..x.len() {
            let y = self.buf[i] as f64;
            store = y * (1.0 - damp) + store * damp;
            if store.abs() < 1e-15 {
                store = 0.0;
            }
            self.buf[i] = (x[j] + store * feedback) as f32;
            i += 1;
            if i == len {
                i = 0;
            }
            acc[j] += y;
        }
        self.i = i;
        self.store = store;
    }
}

struct Allpass {
    buf: Vec<f32>,
    i: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Allpass { buf: vec![0.0; len], i: 0 }
    }
    fn reset(&mut self) {
        self.buf.fill(0.0);
    }
    fn block(&mut self, v: &mut [f64]) {
        let len = self.buf.len();
        let mut i = self.i;
        for x in v.iter_mut() {
            let b = self.buf[i] as f64;
            self.buf[i] = (*x + b * 0.5) as f32;
            i += 1;
            if i == len {
                i = 0;
            }
            *x = b - *x;
        }
        self.i = i;
    }
}

pub struct Reverb {
    sr: f64,
    combs_l: Vec<Comb>,
    combs_r: Vec<Comb>,
    ap_l: Vec<Allpass>,
    ap_r: Vec<Allpass>,
    pre: Vec<f32>,
    pre_write: usize,
    pre_delay: usize,
    feedback: f64,
    damp: f64,
    width: f64,
    ret: Smoother,
    bx: [f64; BLOCK],
    bl: [f64; BLOCK],
    br: [f64; BLOCK],
}

impl Reverb {
    pub fn new(sample_rate: f64) -> Self {
        let scale = sample_rate / 44100.0;
        let mut r = Reverb {
            sr: sample_rate,
            combs_l: COMBS.iter().map(|c| Comb::new(js::round(c * scale) as usize)).collect(),
            combs_r: COMBS.iter().map(|c| Comb::new(js::round((c + STEREO_SPREAD) * scale) as usize)).collect(),
            ap_l: ALLPASSES.iter().map(|a| Allpass::new(js::round(a * scale) as usize)).collect(),
            ap_r: ALLPASSES.iter().map(|a| Allpass::new(js::round((a + STEREO_SPREAD) * scale) as usize)).collect(),
            pre: vec![0.0; (0.13 * sample_rate).ceil() as usize],
            pre_write: 0,
            pre_delay: 0,
            feedback: 0.9,
            damp: 0.5,
            width: 1.0,
            ret: Smoother::new(0.5, 0.02, sample_rate),
            bx: [0.0; BLOCK],
            bl: [0.0; BLOCK],
            br: [0.0; BLOCK],
        };
        for (id, v) in [("rev_size", 0.7), ("rev_damp", 0.5), ("rev_predelay", 15.0), ("rev_width", 1.0), ("rev_return", 0.5)] {
            r.set_param(id, v);
        }
        r
    }

    pub fn set_param(&mut self, id: &str, v: f64) {
        match id {
            "rev_size" => self.feedback = 0.7 + v * 0.28,
            "rev_damp" => self.damp = v * 0.4,
            "rev_predelay" => self.pre_delay = js::round(v / 1000.0 * self.sr) as usize,
            "rev_width" => self.width = v,
            "rev_return" => self.ret.set_target(v),
            _ => {}
        }
    }

    pub fn reset(&mut self) {
        self.combs_l.iter_mut().chain(self.combs_r.iter_mut()).for_each(Comb::reset);
        self.ap_l.iter_mut().chain(self.ap_r.iter_mut()).for_each(Allpass::reset);
        self.pre.fill(0.0);
    }

    /// In place: the wet added onto l / r (every input of a block read before it writes).
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let mut from = 0;
        while from < l.len() {
            let n = BLOCK.min(l.len() - from);
            self.process_block(&mut l[from..from + n], &mut r[from..from + n]);
            from += BLOCK;
        }
    }

    fn process_block(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len();
        let len = self.pre.len();
        let wet1 = (self.width / 2.0 + 0.5) * 3.0;
        let wet2 = ((1.0 - self.width) / 2.0) * 3.0;
        for j in 0..n {
            self.pre[self.pre_write] = ((l[j] as f64 + r[j] as f64) * INPUT_GAIN) as f32;
            let rp = (self.pre_write + len - self.pre_delay) % len;
            self.bx[j] = self.pre[rp] as f64;
            self.pre_write += 1;
            if self.pre_write == len {
                self.pre_write = 0;
            }
            self.bl[j] = 0.0;
            self.br[j] = 0.0;
        }
        for k in 0..8 {
            self.combs_l[k].block(&self.bx[..n], &mut self.bl[..n], self.feedback, self.damp);
            self.combs_r[k].block(&self.bx[..n], &mut self.br[..n], self.feedback, self.damp);
        }
        for k in 0..4 {
            self.ap_l[k].block(&mut self.bl[..n]);
            self.ap_r[k].block(&mut self.br[..n]);
        }
        for j in 0..n {
            let g = self.ret.next();
            js::add_f32(&mut l[j], (self.bl[j] * wet1 + self.br[j] * wet2) * g);
            js::add_f32(&mut r[j], (self.br[j] * wet1 + self.bl[j] * wet2) * g);
        }
    }
}
