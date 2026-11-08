//! JavaScript's number rules where they differ from Rust's, so ported code computes the
//! same values bit for bit.

/// Math.round: halves round up (towards +infinity); Rust's `round` rounds them away from 0.
#[inline]
pub fn round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `a[i] += x` on a Float32Array: the add in double, then rounded to float.
#[inline]
pub fn add_f32(a: &mut f32, x: f64) {
    *a = (*a as f64 + x) as f32;
}

#[cfg(test)]
mod tests {
    #[test]
    fn rounds_as_javascript() {
        for (x, want) in [(2.5, 3.0), (-2.5, -2.0), (-0.5, -0.0), (0.49999999999999994, 0.0), (1.4999, 1.0), (-1.5001, -2.0)] {
            assert_eq!(super::round(x), want, "{x}");
        }
    }
}
