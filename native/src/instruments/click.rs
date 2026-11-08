//! METRONOME / COUNT-IN click, as src/instruments/Click.ts: a short sine blip, higher and
//! louder on a bar's first beat.

use crate::js;
use crate::math::sin_turn;

/// How long the click rings (s, to 1/e).
const CLICK_DECAY: f64 = 0.012;

pub struct Click {
    sample_rate: f64,
    phase: f64,
    inc: f64,
    env: f64,
    decay: f64,
}

impl Click {
    pub fn new(sample_rate: f64) -> Self {
        Click { sample_rate, phase: 0.0, inc: 0.0, env: 0.0, decay: (-1.0 / (CLICK_DECAY * sample_rate)).exp() }
    }

    pub fn trigger(&mut self, accent: bool) {
        self.inc = if accent { 1600.0 } else { 1000.0 } / self.sample_rate;
        self.phase = 0.0;
        self.env = if accent { 1.0 } else { 0.6 };
    }

    /// ADD into out[start .. start + n); false = silent (nothing written).
    pub fn render(&mut self, out: &mut [f32], start: usize, n: usize) -> bool {
        if self.env < 1e-4 {
            return false;
        }
        let (mut phase, mut env) = (self.phase, self.env);
        for o in &mut out[start..start + n] {
            js::add_f32(o, sin_turn(phase) * env);
            phase += self.inc;
            if phase >= 1.0 {
                phase -= 1.0;
            }
            env *= self.decay;
        }
        self.phase = phase;
        self.env = env;
        true
    }
}
