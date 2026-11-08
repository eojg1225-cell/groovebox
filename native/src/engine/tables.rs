//! The engine's small tables and pure helpers, as src/engine/{project,chords,lfo,arp,automation,mixParams}.ts.

use crate::math::cos_turn;
use crate::params::{to_norm, to_value, Spec};

pub const NUM_CHANNELS: usize = 8;
pub const NUM_PATTERNS: usize = 4;
pub const MAX_STEPS: usize = 128;
pub const SONG_MAX_ROWS: usize = 64;
pub const STEP_NOTES: usize = 6;
pub const NUM_SENDS: usize = 2;
pub const NUM_BUSES: usize = 2;
pub const CELLS_PER_BAR: i32 = 16;
pub const MAX_CHORD_NOTES: usize = 6;
pub const DRUM_ROOT: f64 = 33.0;
pub const NORMAL_VELOCITY: f64 = 0.8;

/// CLIP_ENTRY defaults.
pub const CLIP_GLIDE_START: f64 = -16.0;
pub const CLIP_GLIDE_END: f64 = 0.0;
pub const CLIP_FILL_LEN: f64 = 4.0;

/// METERS: each bar's four groups.
pub const METERS: [[usize; 4]; 8] = [
    [4, 4, 4, 4],
    [4, 4, 4, 0],
    [4, 4, 0, 0],
    [4, 2, 4, 0],
    [4, 3, 4, 3],
    [3, 3, 3, 2],
    [4, 3, 3, 3],
    [4, 4, 4, 3],
];

fn meter(m: usize) -> &'static [usize; 4] {
    METERS.get(m).unwrap_or(&METERS[0])
}

pub fn meter_length(m: usize) -> usize {
    meter(m).iter().sum()
}

pub fn meter_plays(m: usize, index: usize) -> bool {
    let cell = index % 16;
    cell % 4 < meter(m)[cell >> 2]
}

/// speedSteps: a pattern speed's step length in master 16ths.
pub fn speed_steps(speed: Option<&str>) -> f64 {
    match speed {
        Some("double") => 0.5,
        Some("half") => 2.0,
        Some("triplet") => 4.0 / 3.0,
        _ => 1.0,
    }
}

/// ROLL_DIVS: hits per 16th.
pub const ROLL_HITS: [f64; 7] = [1.0 / 4.0, 1.0 / 3.0, 1.0 / 2.0, 1.0, 2.0, 3.0, 4.0];
/// ARP_RATES in 16th steps.
pub const ARP_STEPS: [f64; 6] = [4.0, 2.0, 4.0 / 3.0, 1.0, 2.0 / 3.0, 0.5];
/// LFO_RATES in 16th steps; the first five are whole bars ("... BAR").
pub const LFO_STEPS: [f64; 24] = [
    64.0, 48.0, 32.0, 24.0, 16.0, 14.0, 12.0, 10.0, 8.0, 7.0, 6.0, 16.0 / 3.0, 5.0, 4.0, 3.0, 8.0 / 3.0, 2.0, 1.5,
    4.0 / 3.0, 1.0, 2.0 / 3.0, 0.5, 1.0 / 3.0, 0.25,
];
pub const LFO_BAR_RATES: usize = 5;
const LFO_SHAPES: i32 = 6;

/// lfoValue: -1..1 at cycle phase 0..1, MORPH blending into the next shape.
pub fn lfo_value(shape: i32, phase: f64, held: f64, morph: f64) -> f64 {
    let a = base_shape(shape, phase, held);
    if morph <= 0.0 {
        return a;
    }
    a + (base_shape((shape + 1) % LFO_SHAPES, phase, held) - a) * morph
}

fn base_shape(shape: i32, phase: f64, held: f64) -> f64 {
    match shape {
        1 => {
            if phase < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
        2 => 4.0 * (phase - 0.5).abs() - 1.0,
        3 => 1.0 - 2.0 * phase,
        4 => 2.0 * phase - 1.0,
        5 => held,
        _ => cos_turn(phase),
    }
}

/// dynVelocity: ACC/GHOST depth on a hit's velocity.
pub fn dyn_velocity(velocity: f64, depth: f64) -> f64 {
    if depth == 1.0 || velocity <= 0.0 {
        return velocity;
    }
    NORMAL_VELOCITY * (velocity / NORMAL_VELOCITY).powf(depth)
}

// ------------------------------------------------------------------ chords

struct Chord {
    intervals: &'static [i32],
    key: usize,
}

const CHORDS: [Chord; 18] = [
    Chord { intervals: &[0], key: 0 },
    Chord { intervals: &[0, 4, 7], key: 0 },
    Chord { intervals: &[0, 3, 7], key: 0 },
    Chord { intervals: &[0, 3, 7, 10], key: 0 },
    Chord { intervals: &[0, 4, 7, 11], key: 0 },
    Chord { intervals: &[0, 4, 7, 10], key: 0 },
    Chord { intervals: &[0, 3, 7, 10, 14], key: 0 },
    Chord { intervals: &[0, 4, 7, 11, 14], key: 0 },
    Chord { intervals: &[0, 4, 7, 10, 14], key: 0 },
    Chord { intervals: &[0, 3, 7, 10, 14, 17], key: 0 },
    Chord { intervals: &[0, 5, 7], key: 0 },
    Chord { intervals: &[0, 7], key: 0 },
    Chord { intervals: &[0, 7, 12], key: 0 },
    Chord { intervals: &[0, 4, 7, 11, 14, 17], key: 0 },
    Chord { intervals: &[0, 4, 7], key: 3 },
    Chord { intervals: &[0, 4, 7, 11], key: 4 },
    Chord { intervals: &[0, 4, 7, 11, 14], key: 5 },
    Chord { intervals: &[0, 4, 7, 11, 14, 17], key: 6 },
];

const KEY_SCALE: [i32; 7] = [0, 2, 3, 5, 7, 8, 10];
const STACK_RANK: [usize; 6] = [0, 2, 1, 3, 4, 5];

fn tone_rank(interval: i32) -> i32 {
    const ORDER: [i32; 11] = [0, 7, 4, 3, 5, 2, 10, 11, 14, 17, 12];
    match ORDER.iter().position(|&o| o == interval) {
        Some(i) => i as i32,
        None => ORDER.len() as i32 + interval,
    }
}

/// A voicing: up to six intervals and how many.
#[derive(Copy, Clone, Default)]
pub struct Voicing {
    pub n: usize,
    pub iv: [f64; MAX_CHORD_NOTES],
}

/// CHORD_VOICINGS / KEY_VOICINGS, built once.
pub struct Chords {
    plain: Vec<[Voicing; MAX_CHORD_NOTES]>,
    key: Vec<Option<[[Voicing; MAX_CHORD_NOTES]; 7]>>,
}

fn voicings(ranked: &[i32]) -> [Voicing; MAX_CHORD_NOTES] {
    let mut out = [Voicing::default(); MAX_CHORD_NOTES];
    for (n, v) in out.iter_mut().enumerate() {
        let mut s: Vec<i32> = ranked.iter().take(n + 1).copied().collect();
        s.sort();
        v.n = s.len();
        for (k, x) in s.iter().enumerate() {
            v.iv[k] = *x as f64;
        }
    }
    out
}

impl Chords {
    pub fn new() -> Self {
        let plain = CHORDS
            .iter()
            .map(|c| {
                let mut ranked: Vec<i32> = c.intervals.to_vec();
                // A stable sort, as Array.prototype.sort.
                ranked.sort_by_key(|&a| tone_rank(a));
                voicings(&ranked)
            })
            .collect();
        let key = CHORDS
            .iter()
            .map(|c| {
                if c.key == 0 {
                    return None;
                }
                let mut degrees = [[Voicing::default(); MAX_CHORD_NOTES]; 7];
                for (d, slot) in degrees.iter_mut().enumerate() {
                    let at = |k: usize| KEY_SCALE[(d + k) % 7] + 12 * ((d + k) / 7) as i32 - KEY_SCALE[d];
                    let ranked: Vec<i32> = STACK_RANK.iter().filter(|&&k| k < c.key).map(|&k| at(2 * k)).collect();
                    *slot = voicings(&ranked);
                }
                Some(degrees)
            })
            .collect();
        Chords { plain, key }
    }

    /// chordVoicing(chord, notes, note, root).
    pub fn voicing(&self, chord: usize, notes: usize, note: f64, root: f64) -> &Voicing {
        let n = notes.clamp(1, MAX_CHORD_NOTES) - 1;
        if let Some(Some(key)) = self.key.get(chord) {
            let pc = (((note - root) % 12.0) + 12.0) % 12.0;
            let mut d = KEY_SCALE.len() - 1;
            while KEY_SCALE[d] as f64 > pc {
                d -= 1;
            }
            return &key[d][n];
        }
        &self.plain.get(chord).unwrap_or(&self.plain[0])[n]
    }
}

impl Default for Chords {
    fn default() -> Self {
        Self::new()
    }
}

// ------------------------------------------------------------------ automation

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum AutoKind {
    S,
    M,
    O,
    B,
    L,
    A,
}

/// parseAutoKey: kind, index, id.
pub fn parse_auto_key(key: &str) -> Option<(AutoKind, usize, &str)> {
    let mut it = key.splitn(3, ':');
    let k = it.next()?;
    let kind = match k {
        "s" => AutoKind::S,
        "m" => AutoKind::M,
        "o" => AutoKind::O,
        "b" => AutoKind::B,
        "a" => AutoKind::A,
        "l" => {
            // l:<id> (the regex /^(l):()(.+)$/: everything after the first colon).
            let id = &key[2..];
            return if id.is_empty() { None } else { Some((AutoKind::L, 0, id)) };
        }
        _ => return None,
    };
    let index = it.next()?;
    let id = it.next()?;
    if index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) || id.is_empty() {
        return None;
    }
    Some((kind, index.parse().ok()?, id))
}

/// valueAt: NaN before the first point, the last value after the last, a glide between.
pub fn value_at(pos: &[f64], val: &[f64], p: f64, spec: Option<&Spec>) -> f64 {
    let n = pos.len();
    if n == 0 || p < pos[0] {
        return f64::NAN;
    }
    if p >= pos[n - 1] {
        return val[n - 1];
    }
    let mut i = 0;
    while i + 2 < n && p >= pos[i + 1] {
        i += 1;
    }
    let a = val[i];
    let b = val[i + 1];
    if let Some(s) = spec {
        if s.options > 0 || s.coarse {
            return a;
        }
    }
    let f = (p - pos[i]) / (pos[i + 1] - pos[i]);
    match spec {
        None => a + (b - a) * f,
        Some(s) => {
            let na = to_norm(s, a);
            to_value(s, na + (to_norm(s, b) - na) * f)
        }
    }
}

/// Math.max / Math.min: NaN wins (Rust's f64::max / min drop it).
pub fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}
pub fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}
