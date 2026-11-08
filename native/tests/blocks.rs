//! Null tests of the building blocks against the TypeScript engine's own output
//! (tests/vectors/blocks.json, written by the app's tests/nativeVectors.test.ts). Each prints
//! its worst difference; the limit is far under the plan's -100 dB.

use groovebox_native::drive_comp::{drive_comp_gain, drive_rise};
use groovebox_native::dsp::{crush_levels, crush_step, decay_mul, midi_to_hz, poly_blep, IdleGate, Noise, Svf};
use groovebox_native::kind::SoundKind;
use groovebox_native::math::{exp2, pow10, sin_turn, tanh};
use groovebox_native::smoother::Smoother;
use serde_json::Value;

const SR: f64 = 48000.0;
/// -200 dB: what is left is the last bits of a double (the TypeScript side's Math.sin and
/// Rust's may differ in the last place).
const LIMIT: f64 = 1e-10;

fn vectors() -> Value {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/blocks.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// A number from the file (null = infinity, as JSON writes it).
fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::INFINITY)
}

fn nums(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(num).collect()
}

/// The worst difference, relative where the value is large (2^x up to 1e308).
fn check(name: &str, got: &[f64], want: &[f64]) {
    assert_eq!(got.len(), want.len(), "{name}: length");
    let mut worst = 0.0f64;
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        if g == w {
            continue;
        }
        let d = (g - w).abs() / w.abs().max(1.0);
        assert!(d <= LIMIT, "{name}[{i}]: got {g}, want {w}");
        worst = worst.max(d);
    }
    let db = if worst == 0.0 { "bit-identical".to_string() } else { format!("{:.0} dB", 20.0 * worst.log10()) };
    println!("{name}: {} values, {db}", got.len());
}

#[test]
fn maths_tables() {
    let v = vectors();
    for (name, f) in [("sinTurn", sin_turn as fn(f64) -> f64), ("tanh", tanh), ("exp2", exp2), ("pow10", pow10)] {
        let input = nums(&v[name]["input"]);
        let got: Vec<f64> = input.iter().map(|&x| f(x)).collect();
        check(name, &got, &nums(&v[name]["output"]));
    }
}

#[test]
fn helpers() {
    let v = vectors();
    let pairs = |key: &str| v[key].as_array().unwrap().iter().map(nums).collect::<Vec<_>>();
    let d = pairs("decayMul");
    check("decayMul", &d.iter().map(|p| decay_mul(p[0], SR)).collect::<Vec<_>>(), &d.iter().map(|p| p[1]).collect::<Vec<_>>());
    let b = pairs("polyBlep");
    check("polyBlep", &b.iter().map(|p| poly_blep(p[0], p[1])).collect::<Vec<_>>(), &b.iter().map(|p| p[2]).collect::<Vec<_>>());
    check("midiToHz", &(0..128).map(|n| midi_to_hz(n as f64)).collect::<Vec<_>>(), &nums(&v["midiToHz"]));
    let c = pairs("crush");
    check("crushStep", &c.iter().map(|p| crush_step(p[0])).collect::<Vec<_>>(), &c.iter().map(|p| p[1]).collect::<Vec<_>>());
    check("crushLevels", &c.iter().map(|p| crush_levels(p[0])).collect::<Vec<_>>(), &c.iter().map(|p| p[2]).collect::<Vec<_>>());
}

#[test]
fn noise_is_the_same_sequence() {
    let v = vectors();
    for (key, mut n) in [("noiseDefault", Noise::default()), ("noiseSeeded", Noise::new(777)), ("noiseZero", Noise::new(0))] {
        let got: Vec<f64> = (0..2000).map(|_| n.next()).collect();
        let want = nums(&v[key]);
        assert_eq!(got, want, "{key}: the noise must be bit-identical");
        println!("{key}: 2000 values, bit-identical");
    }
}

#[test]
fn state_variable_filter() {
    let v = vectors();
    for (c, case) in v["svf"].as_array().unwrap().iter().enumerate() {
        let mut f = Svf::default();
        let mut src = Noise::new(12345);
        let (mut low, mut band, mut high) = (vec![], vec![], vec![]);
        for s in case["settings"].as_array().unwrap() {
            let s = nums(s);
            f.setup(s[0], s[1], SR);
            for _ in 0..500 {
                f.process(src.next());
                low.push(f.low);
                band.push(f.band);
                high.push(f.high);
            }
        }
        check(&format!("svf{c}.low"), &low, &nums(&case["low"]));
        check(&format!("svf{c}.band"), &band, &nums(&case["band"]));
        check(&format!("svf{c}.high"), &high, &nums(&case["high"]));
    }
}

#[test]
fn smoother() {
    let v = vectors();
    let mut s = Smoother::new(0.2, 0.01, SR);
    let mut out = vec![];
    s.set_target(0.9);
    for _ in 0..300 {
        out.push(s.next());
    }
    s.advance(700);
    out.push(s.value());
    s.set_target(-0.5);
    for _ in 0..300 {
        out.push(s.next());
    }
    s.set_time(0.0, SR);
    s.set_target(0.1);
    out.push(s.next());
    check("smoother", &out, &nums(&v["smoother"]));
}

#[test]
fn idle_gate() {
    let v = vectors();
    let mut g = IdleGate::new(0.01, SR);
    let (mut l, mut r) = (vec![0f32; 128], vec![0f32; 128]);
    let mut skips = vec![];
    for b in 0..12 {
        for i in 0..128 {
            l[i] = if b < 2 { 0.5 } else { 0.0 };
            r[i] = if b == 4 && i == 7 { 1e-5 } else { 0.0 };
        }
        skips.push(Value::Bool(g.skip(&l, &r)));
        g.done(&l, &r);
    }
    assert_eq!(Value::Array(skips), v["idleGate"]);
}

#[test]
fn drive_compensation() {
    let v = vectors();
    for kind in SoundKind::ALL {
        let cases: Vec<Vec<f64>> = v["driveComp"][kind.id()].as_array().unwrap().iter().map(nums).collect();
        let got: Vec<f64> = cases.iter().map(|p| drive_comp_gain(drive_rise(kind), p[0])).collect();
        check(&format!("driveComp.{}", kind.id()), &got, &cases.iter().map(|p| p[1]).collect::<Vec<_>>());
    }
}
