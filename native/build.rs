//! The maths tables (src/math.rs), worked out once at build time on the build machine and
//! compiled in as constants: no start-up cost, the same numbers on every device.
use std::fmt::Write;

fn table(name: &str, n: usize, f: impl Fn(usize) -> f64) -> String {
    let mut s = format!("pub(super) static {name}: [f64; {n}] = [");
    for i in 0..n {
        write!(s, "{:e},", f(i)).unwrap();
    }
    s.push_str("];\n");
    s
}

fn main() {
    const SIN_N: usize = 4096;
    const TANH_N: usize = 4096;
    const TANH_MAX: f64 = 10.0;
    const EXP_N: usize = 1024;
    let mut out = String::new();
    out += &table("SIN", SIN_N + 1, |i| (2.0 * std::f64::consts::PI * i as f64 / SIN_N as f64).sin());
    out += &table("TANH", TANH_N + 1, |i| (i as f64 / (TANH_N as f64 / TANH_MAX)).tanh());
    out += &table("EXP", EXP_N + 1, |i| 2f64.powf(i as f64 / EXP_N as f64));
    out += &table("WHOLE", 2046, |n| 2f64.powi(n as i32 - 1022));
    let path = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("tables.rs");
    std::fs::write(path, out).unwrap();
    println!("cargo:rerun-if-changed=build.rs");
}
