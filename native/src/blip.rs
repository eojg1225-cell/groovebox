//! The test blip: a 1 kHz sine with a 1 ms attack and a 60 ms decay, started by a tap.
//! Nothing is allocated while rendering.

pub struct Blip {
    rate: f64,
    phase: f64,
    /// Samples since the blip started (past `len` = silent).
    t: u32,
    len: u32,
    attack: u32,
    /// The tap count last seen: a new one starts the blip.
    seen: u32,
}

const FREQ: f64 = 1000.0;
const LEVEL: f64 = 0.5;

impl Blip {
    pub fn new(rate: f64) -> Self {
        let len = (rate * 0.06) as u32;
        Blip { rate, phase: 0.0, t: len, len, attack: (rate * 0.001).max(1.0) as u32, seen: 0 }
    }

    /// Fill `out` (stereo, interleaved). `taps` counts taps so far: a new value starts the blip
    /// at the top of this block.
    pub fn render(&mut self, out: &mut [f32], taps: u32) {
        if taps != self.seen {
            self.seen = taps;
            self.t = 0;
            self.phase = 0.0;
        }
        let step = FREQ / self.rate;
        for frame in out.as_chunks_mut::<2>().0 {
            let v = if self.t < self.len {
                let env = if self.t < self.attack {
                    self.t as f64 / self.attack as f64
                } else {
                    let d = (self.t - self.attack) as f64 / (self.len - self.attack) as f64;
                    (1.0 - d) * (1.0 - d)
                };
                self.t += 1;
                let s = (self.phase * std::f64::consts::TAU).sin() * env * LEVEL;
                self.phase += step;
                if self.phase >= 1.0 {
                    self.phase -= 1.0;
                }
                s as f32
            } else {
                0.0
            };
            frame[0] = v;
            frame[1] = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Blip;

    #[test]
    fn silent_until_tapped_then_a_short_blip() {
        let mut b = Blip::new(48000.0);
        let mut out = vec![1.0f32; 2 * 4800];
        b.render(&mut out, 0);
        assert!(out.iter().all(|&s| s == 0.0));
        b.render(&mut out, 1);
        let peak = out.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        assert!(peak > 0.4 && peak <= 0.5, "peak {peak}");
        assert_eq!(out[0], 0.0); // starts from silence: no click
        // 60 ms later it has died away.
        b.render(&mut out, 1);
        assert!(out.iter().all(|&s| s == 0.0));
        // Another tap starts it again.
        b.render(&mut out, 2);
        assert!(out.iter().any(|&s| s.abs() > 0.4));
    }
}
