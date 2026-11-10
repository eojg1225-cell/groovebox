//! The engine's per-sample maths from tables with linear interpolation: sin / cos within 3e-7, tanh within 6e-7, 2^x / 10^x within 2e-7
//! of the value. The tables come from build.rs.

// Table entries such as sqrt 2 and 1/sqrt 2 are values of the functions, not constants.
#[allow(clippy::approx_constant)]
mod tables {
    include!(concat!(env!("OUT_DIR"), "/tables.rs"));
}
use tables::{EXP, SIN, TANH, WHOLE};

const SIN_N: usize = 4096;
const INV_TWO_PI: f64 = 1.0 / (2.0 * std::f64::consts::PI);
const TANH_MAX: f64 = 10.0;
const TANH_SCALE: f64 = 4096.0 / TANH_MAX;
const EXP_N: usize = 1024;
const WHOLE_MIN: i32 = -1022;
const LOG2_10: f64 = std::f64::consts::LOG2_10;

/// sin(2 pi t): a phase in turns.
#[inline]
pub fn sin_turn(t: f64) -> f64 {
    let x = (t - t.floor()) * SIN_N as f64;
    // A phase a hair below a whole turn rounds t - floor(t) to exactly 1: the last interval
    // then (its end is the value), never one past the table.
    let i = if x < SIN_N as f64 { x as usize } else { SIN_N - 1 };
    let a = SIN[i];
    a + (SIN[i + 1] - a) * (x - i as f64)
}

/// cos(2 pi t).
#[inline]
pub fn cos_turn(t: f64) -> f64 {
    sin_turn(t + 0.25)
}

/// sin(x), x in radians.
#[inline]
pub fn sin_rad(x: f64) -> f64 {
    sin_turn(x * INV_TWO_PI)
}

/// tanh on 0..10 (odd: the sign put back), 1 beyond.
#[inline]
pub fn tanh(x: f64) -> f64 {
    let a = x.abs();
    if a >= TANH_MAX {
        return if x < 0.0 { -1.0 } else { 1.0 };
    }
    let p = a * TANH_SCALE;
    let i = p as usize;
    let y = TANH[i] + (TANH[i + 1] - TANH[i]) * (p - i as f64);
    if x < 0.0 { -y } else { y }
}

/// 2^x = 2^floor(x) (a table of whole powers) x 2^frac (interpolated).
#[inline]
pub fn exp2(x: f64) -> f64 {
    let nf = x.floor();
    if nf < WHOLE_MIN as f64 {
        return 0.0;
    }
    if nf > 1023.0 {
        return f64::INFINITY;
    }
    let n = nf as i32;
    let p = (x - nf) * EXP_N as f64;
    let i = if p < EXP_N as f64 { p as usize } else { EXP_N - 1 };
    WHOLE[(n - WHOLE_MIN) as usize] * (EXP[i] + (EXP[i + 1] - EXP[i]) * (p - i as f64))
}

/// 10^x.
#[inline]
pub fn pow10(x: f64) -> f64 {
    exp2(x * LOG2_10)
}
