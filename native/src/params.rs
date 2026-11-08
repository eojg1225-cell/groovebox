//! Parameter descriptions and their knob scaling, as src/engine/params.ts.

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Curve {
    Linear,
    Exp,
    Square,
    Power,
}

/// A parameter: range, curve, choices (`options` = how many, 0 = continuous).
#[derive(Copy, Clone, Debug)]
pub struct Spec {
    pub id: &'static str,
    pub min: f64,
    pub max: f64,
    pub default: f64,
    pub curve: Curve,
    pub power: f64,
    pub options: u32,
    pub coarse: bool,
}

fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    if x < lo { lo } else if x > hi { hi } else { x }
}

/// Normalised 0..1 -> real value.
pub fn to_value(s: &Spec, norm: f64) -> f64 {
    let n = clamp(norm, 0.0, 1.0);
    if s.options > 0 {
        return crate::js::round(n * (s.options - 1) as f64);
    }
    match s.curve {
        Curve::Exp => s.min * (s.max / s.min).powf(n),
        Curve::Square => s.min + (s.max - s.min) * n * n,
        Curve::Power => s.min + (s.max - s.min) * n.powf(s.power),
        Curve::Linear => s.min + (s.max - s.min) * n,
    }
}

/// Real value -> normalised 0..1.
pub fn to_norm(s: &Spec, value: f64) -> f64 {
    let v = clamp(value, s.min, s.max);
    match s.curve {
        Curve::Exp => (v / s.min).ln() / (s.max / s.min).ln(),
        Curve::Square => ((v - s.min) / (s.max - s.min)).sqrt(),
        Curve::Power => ((v - s.min) / (s.max - s.min)).powf(1.0 / s.power),
        Curve::Linear => (v - s.min) / (s.max - s.min),
    }
}
