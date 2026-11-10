//! Small allocation-free DSP building blocks shared by the instruments.

/// Multiplier that makes an exponential decay fall by 60 dB in `seconds`.
pub fn decay_mul(seconds: f64, sample_rate: f64) -> f64 {
    0.001f64.powf(1.0 / (seconds.max(1e-4) * sample_rate))
}

/// Fast deterministic white noise (xorshift32), output -1..1.
pub struct Noise {
    s: u32,
}

impl Noise {
    pub const DEFAULT_SEED: u32 = 0x9e37_79b9;

    pub fn new(seed: u32) -> Self {
        Noise { s: if seed == 0 { 1 } else { seed } }
    }

    #[inline]
    #[allow(clippy::should_implement_trait)] // the TypeScript name; not an iterator
    pub fn next(&mut self) -> f64 {
        let mut x = self.s;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.s = x;
        x as i32 as f64 / 2_147_483_648.0
    }
}

impl Default for Noise {
    fn default() -> Self {
        Noise::new(Noise::DEFAULT_SEED)
    }
}

/// Zero-delay-feedback state-variable filter (Simper / Cytomic TPT form). Call `setup` when
/// cutoff / resonance change, then `process` per sample; read low / band / high after.
#[derive(Clone)]
pub struct Svf {
    pub low: f64,
    pub band: f64,
    pub high: f64,
    ic1: f64,
    ic2: f64,
    a1: f64,
    a2: f64,
    a3: f64,
    k: f64,
}

impl Default for Svf {
    fn default() -> Self {
        Svf { low: 0.0, band: 0.0, high: 0.0, ic1: 0.0, ic2: 0.0, a1: 1.0, a2: 0.0, a3: 0.0, k: 2.0 }
    }
}

impl Svf {
    /// resonance 0..1 (approaching 1 self-oscillates).
    pub fn setup(&mut self, cutoff: f64, resonance: f64, sample_rate: f64) {
        let fc = cutoff.min(sample_rate * 0.45);
        let g = (std::f64::consts::PI * fc / sample_rate).tan();
        self.k = 2.0 - 2.0 * resonance.min(0.98);
        self.a1 = 1.0 / (1.0 + g * (g + self.k));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
    }

    #[inline]
    pub fn process(&mut self, x: f64) {
        let v3 = x - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        // Flush denormals.
        if self.ic1.abs() < 1e-15 {
            self.ic1 = 0.0;
        }
        if self.ic2.abs() < 1e-15 {
            self.ic2 = 0.0;
        }
        self.low = v2;
        self.band = v1;
        self.high = x - self.k * v1 - v2;
    }

    pub fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }

    /// Died away (its state flushed to zero): silence in = silence out.
    pub fn quiet(&self) -> bool {
        self.ic1 == 0.0 && self.ic2 == 0.0
    }
}

const IDLE_LEVEL: f32 = 1e-6;

/// An onboard effect's idle switch (PLUCK's delay + room, the drums' AIR): once silence has
/// gone in and (nearly) silence come out for longer than its longest echo, it is skipped
/// until sound comes in again. Call `skip` before processing a block and `done` after.
pub struct IdleGate {
    quiet: usize,
    silent_in: bool,
    frames: usize,
}

impl IdleGate {
    pub fn new(seconds: f64, sample_rate: f64) -> Self {
        IdleGate { quiet: 0, silent_in: false, frames: (seconds * sample_rate).round() as usize }
    }

    pub fn skip(&mut self, l: &[f32], r: &[f32]) -> bool {
        self.silent_in = silent(l, r);
        if !self.silent_in {
            self.quiet = 0;
        }
        self.silent_in && self.quiet >= self.frames
    }

    pub fn done(&mut self, l: &[f32], r: &[f32]) {
        if !self.silent_in {
            return;
        }
        if l.iter().zip(r).any(|(a, b)| a.abs() > IDLE_LEVEL || b.abs() > IDLE_LEVEL) {
            self.quiet = 0;
            return;
        }
        self.quiet += l.len();
    }
}

/// Nothing but zeros in l / r.
pub fn silent(l: &[f32], r: &[f32]) -> bool {
    l.iter().zip(r).all(|(a, b)| *a == 0.0 && *b == 0.0)
}

/// PolyBLEP correction for a discontinuity at phase 0 (phase, increment in cycles).
#[inline]
pub fn poly_blep(t: f64, dt: f64) -> f64 {
    if t < dt {
        let x = t / dt;
        return x + x - x * x - 1.0;
    }
    if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        return x * x + x + x + 1.0;
    }
    0.0
}

pub fn midi_to_hz(note: f64) -> f64 {
    440.0 * 2f64.powf((note - 69.0) / 12.0)
}

/// CRUSH on a squared knob: the hold's step on the fractional clock, a new sample every
/// 1 + 24 c^2 samples of c = knob^2 ...
pub fn crush_step(knob: f64) -> f64 {
    let c = knob * knob;
    1.0 / (1.0 + c * c * 24.0)
}

/// ... and 16 - 12 c bits.
pub fn crush_levels(knob: f64) -> f64 {
    2f64.powf(16.0 - knob * knob * 12.0)
}

/// The velocity of a NORMAL step (and of keys played with no dynamic armed).
const NORMAL_VELOCITY: f64 = 0.8;
/// GHOST's and ACCENT's velocities (DYNAMIC_VELOCITY), the ends of `dynamic_of`.
const GHOST_VELOCITY: f64 = 0.45;
const ACCENT_VELOCITY: f64 = 1.0;

/// How ghosted (-1) or accented (+1) a note is from its velocity: 0 = NORMAL, linear to GHOST
/// below and ACCENT above (ACC/GHOST's depth per track, rolls' ramps and live keys fall between).
pub fn dynamic_of(velocity: f64) -> f64 {
    if velocity < NORMAL_VELOCITY {
        ((velocity - NORMAL_VELOCITY) / (NORMAL_VELOCITY - GHOST_VELOCITY)).max(-1.0)
    } else {
        ((velocity - NORMAL_VELOCITY) / (ACCENT_VELOCITY - NORMAL_VELOCITY)).min(1.0)
    }
}
