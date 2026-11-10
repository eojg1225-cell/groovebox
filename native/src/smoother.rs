//! One-pole parameter smoother against zipper noise (ported from the TypeScript engine's smoother.ts).

pub struct Smoother {
    current: f64,
    target: f64,
    coeff: f64,
}

impl Smoother {
    pub fn new(value: f64, time_seconds: f64, sample_rate: f64) -> Self {
        let mut s = Smoother { current: value, target: value, coeff: 0.0 };
        s.set_time(time_seconds, sample_rate);
        s
    }

    pub fn set_time(&mut self, time_seconds: f64, sample_rate: f64) {
        self.coeff = if time_seconds <= 0.0 { 1.0 } else { 1.0 - (-1.0 / (time_seconds * sample_rate)).exp() };
    }

    pub fn set_target(&mut self, value: f64) {
        self.target = value;
    }

    pub fn set_immediate(&mut self, value: f64) {
        self.current = value;
        self.target = value;
    }

    pub fn value(&self) -> f64 {
        self.current
    }

    /// At its target (`next` returns the same value until a new one is set).
    pub fn settled(&self) -> bool {
        self.current == self.target
    }

    /// n steps of `next` at once (a block that was skipped).
    pub fn advance(&mut self, n: u32) {
        if self.current == self.target {
            return;
        }
        self.current = self.target + (self.current - self.target) * (1.0 - self.coeff).powf(n as f64);
        if (self.target - self.current).abs() < 1e-9 {
            self.current = self.target;
        }
    }

    #[inline]
    #[allow(clippy::should_implement_trait)] // the TypeScript name; not an iterator
    pub fn next(&mut self) -> f64 {
        self.current += (self.target - self.current) * self.coeff;
        // Snap when close, which also keeps denormals out of the state.
        if (self.target - self.current).abs() < 1e-9 {
            self.current = self.target;
        }
        self.current
    }
}
