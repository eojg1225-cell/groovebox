//! The synth voice engine: BASS, PAD, LEAD, PLUCK. Six voices; per voice OSC 1 / OSC 2 (SHAPE's
//! waves, CZ, the FM pair or the PAD's two stacks), UNISON, envelopes, the filter (FX ROUTING:
//! before or after DRIVE / CRUSH, or after SPACE), then DC block, CRUSH, OUT GAIN x FM COMP,
//! DUCK; post: PLUCK's delay + room or the PAD's LOW CUT / MOD / VERB. (Ported line for line
//! from the TypeScript engine, retired in November 2026; its knob tables stay in
//! src/instruments/synthSpecs.ts.)
//!
//! Per voice two elements, OSC 1 and OSC 2 (OSC 2 detuned by DETUNE), each with a continuous
//! SHAPE (sine -> triangle -> saw -> square) blended by FM with an FM pair (sine carrier, sine
//! modulator at FM RATIO), each with its own ATTACK / DECAY / SUSTAIN / RELEASE; a sine sub joins
//! OSC 1. UNISON adds four more detuned copies (two per element, spread by DETUNE) for
//! supersaws. Then a resonant low-pass with its own envelope, drive, CRUSH. MONO uses one voice
//! with glide. Ranges go far past "sensible" on purpose.

use crate::drive_comp::{drive_comp_gain, drive_rise};
use crate::dsp::{crush_levels, crush_step, decay_mul, dynamic_of, midi_to_hz, poly_blep, IdleGate, Svf};
use crate::fx::delay::Delay;
use crate::fx::reverb::Reverb;
use crate::fx::units::{ModFx, VerbFx, FX_BLOCK};
use crate::js;
use crate::kind::SoundKind;
use crate::math::{cos_turn, exp2, sin_rad, sin_turn, tanh};
use std::f64::consts::PI;

const CUT_FADE: f64 = 0.003;
const MAX_VOICES: usize = 6;
const OCTAVE_ZERO: f64 = 4.0;
const SQUELCH_FROM: f64 = 0.6;
const BODY: f64 = 1.4;
/// FM RATIO: carrier, modulator, polarity.
const FM_PAIRS: [(f64, f64, f64); 8] = [(1.0, 1.0, 1.0), (1.0, 2.0, 1.0), (1.0, 3.0, 1.0), (3.0, 2.0, -1.0), (3.0, 4.0, 1.0), (1.0, 4.0, 1.0), (1.0, 5.0, 1.0), (1.0, 7.0, 1.0)];
const FM_RISE: [f64; 11] = [0.0, 0.19, 0.36, 0.5, 0.64, 0.76, 0.86, 0.95, 1.0, 0.9, 0.69];
const SQUELCH_TOP: f64 = 8.0;
const RING_STRETCH: f64 = 2.0;
const SLIDE_SECONDS: f64 = 0.06;
const VEL_SMOOTH: f64 = 0.004;
/// How far a note's dynamic moves its filter / FM envelope depth (x 1 - this ... 1 + this).
const ENV_DYNAMIC: f64 = 0.5;
const FM_MAX_INDEX: f64 = 13.0;
const MAX_FEEDBACK: f64 = 1.6;
const MAX_CARRIER_FEEDBACK: f64 = 1.3;
const DC_HZ: f64 = 8.0;
const PULSE_MIN: f64 = 0.125;
const CZ_OPEN: f64 = 0.9;
const CZ_FLOOR: f64 = 0.12;
const PHASE_POINTS: usize = 64;
const PHASE_DT: f64 = 220.0 / 48000.0;
const UNISON_SPREAD: [f64; 4] = [-1.0, -0.4, 0.4, 1.0];
const UNISON_PHASE: [f64; 4] = [0.13, 0.61, 0.37, 0.89];
const FILTER_UPDATE: i32 = 16;
const BLOCK: usize = 64;
const PAD_MOD_TYPES: [&str; 3] = ["CHORUS", "FLANGER", "PHASER"];
const LOW_CUT_OFF: f64 = 20.5;
const LOW_CUT_RESO: f64 = 0.3;
const DUCK_ATTACK: f64 = 0.003;
const ONBOARD_DELAY_SECONDS: f64 = 2.5;
const ONBOARD_VERB_GAIN: f64 = 0.7;
const ONBOARD_DLY_TONE: f64 = 3500.0;
const LEGACY_WAVE_TO_SHAPE: [f64; 4] = [2.0, 3.0, 1.0, 0.0];

/// Every synth parameter with its default, in synthSpecs.ts SYNTH_PARAMS' order.
const ALL: [(&str, f64); 55] = [
    ("timbre", 0.33), ("intensity", 0.5), ("shape", 2.0), ("fm", 0.0), ("fm2", 0.0), ("fmratio", 2.0), ("cratio", 1.0),
    ("detune", 0.0), ("sub", 0.0), ("unison", 0.0), ("ratio2", 1.0), ("ratio3", 1.0), ("feedback", 0.0), ("cfeedback", 0.0),
    ("carriers", 0.35), ("octave", 4.0), ("voice", 0.0), ("glide", SLIDE_SECONDS), ("cutoff", 1200.0), ("reso", 0.3),
    ("fenv", 0.4), ("fattack", 0.0005), ("fdecay", 0.3), ("fmattack", 0.0005), ("fmdecay", 0.3), ("vibrato", 0.0),
    ("vibrate", 5.5), ("vibdelay", 0.3), ("bend", 0.0), ("bendtime", 0.08), ("drive", 1.0), ("crush", 0.0), ("level", 0.7),
    ("ogain", 1.0), ("fmcomp", 0.0), ("fmpair", 0.0), ("attack", 0.003), ("decay", 0.4), ("attack2", 0.003), ("decay2", 0.4),
    ("sustain", 0.5), ("release", 0.15), ("sustain2", 0.5), ("release2", 0.15), ("dratio", 1.0), ("duck", 0.0),
    ("duckrel", 0.2), ("midfreq", 1000.0), ("dtime", 2.0), ("dfdbk", 0.35), ("dmix", 0.0), ("verb", 0.0), ("lowcut", 20.0),
    ("modmix", 0.0), ("modtype", 0.0),
];

const MORPHED: [&str; 15] = ["timbre", "intensity", "shape", "fm", "fmratio", "fmattack", "fmdecay", "detune", "unison", "cutoff", "reso", "fattack", "fenv", "fdecay", "drive"];

/// The settings each type fixes (no knob), in this order.
fn fixed(kind: SoundKind) -> &'static [(&'static str, f64)] {
    match kind {
        SoundKind::Bass => &[("voice", 1.0), ("envlink", 1.0), ("squelch", 1.0), ("body", 1.0), ("cz", 1.0)],
        SoundKind::Pad => &[("voice", 0.0), ("sub", 0.0), ("algo", 2.0), ("cz", 2.0), ("sawrise", 1.0), ("padfx", 1.0)],
        SoundKind::Lead => &[("voice", 1.0), ("sub", 0.0), ("envlink", 1.0), ("squelch", 1.0), ("body", 1.0), ("cz", 1.0)],
        SoundKind::Pluck => &[("voice", 0.0), ("sub", 0.0), ("envlink", 1.0), ("onboard", 1.0), ("cz", 2.0), ("align", 0.0)],
        _ => panic!("not a synth"),
    }
}

/// Each type's parameters (knob order) and their own defaults (synthSpecs.ts BASS_PARAMS ...).
pub fn type_params(kind: SoundKind) -> Vec<(&'static str, f64)> {
    let no_ratio: Vec<&str> = MORPHED.iter().copied().filter(|id| *id != "fmratio").collect();
    let shared = ["attack", "decay", "sustain", "release", "dratio", "crush", "level"];
    let (ids, own): (Vec<&'static str>, &[(&str, f64)]) = match kind {
        SoundKind::Bass => (
            [&no_ratio[..], &["fmpair", "ogain", "fmcomp", "sub", "octave", "glide"], &shared, &["duck", "duckrel", "midfreq"]].concat(),
            &[("attack", 0.002), ("decay", 0.6), ("sustain", 0.6), ("release", 0.06), ("level", 0.75), ("midfreq", 350.0)],
        ),
        SoundKind::Pad => (
            [&MORPHED[..], &["fm2", "ogain", "octave", "glide", "attack", "decay", "attack2", "decay2", "sustain", "release", "crush", "level", "sustain2", "release2", "ratio2", "ratio3", "feedback", "carriers", "cfeedback", "midfreq", "lowcut", "verb", "modmix", "modtype"]].concat(),
            &[("attack", 0.03), ("attack2", 0.03), ("decay", 0.6), ("decay2", 0.6), ("sustain", 0.85), ("sustain2", 0.85), ("release", 0.2), ("release2", 0.2), ("level", 0.5), ("detune", 0.25), ("midfreq", 500.0)],
        ),
        SoundKind::Lead => (
            [&no_ratio[..], &["fmpair", "ogain", "fmcomp", "octave", "glide"], &shared, &["vibrato", "vibrate", "vibdelay", "bend", "bendtime", "midfreq"]].concat(),
            &[("midfreq", 1000.0), ("octave", OCTAVE_ZERO + 1.0), ("attack", 0.004), ("decay", 0.6), ("sustain", 0.75), ("release", 0.2), ("level", 0.55), ("detune", 0.08)],
        ),
        SoundKind::Pluck => (
            [&MORPHED[..], &["cfeedback", "ogain", "octave", "glide"], &shared, &["dtime", "dfdbk", "dmix", "verb", "midfreq"]].concat(),
            &[("midfreq", 800.0), ("attack", 0.001), ("decay", 0.35), ("sustain", 0.0), ("release", 0.08), ("level", 0.55), ("detune", 0.15)],
        ),
        _ => panic!("not a synth"),
    };
    ids.into_iter()
        .map(|id| (id, own.iter().find(|(o, _)| *o == id).map(|p| p.1).unwrap_or_else(|| ALL.iter().find(|(a, _)| *a == id).unwrap().1)))
        .collect()
}

#[inline]
fn fm_env_gain(env: f64) -> f64 {
    0.6 + 1.8 * env
}

fn fm_gain_of(comp: f64, fm: f64) -> f64 {
    if comp == 0.0 {
        return 1.0;
    }
    let u = fm.clamp(0.0, 1.0) * 10.0;
    let i = 9f64.min(u.floor()) as usize;
    let rise = FM_RISE[i] + (FM_RISE[i + 1] - FM_RISE[i]) * (u - i as f64);
    10f64.powf(-comp * rise / 20.0)
}

fn squelch(fm: f64) -> f64 {
    if fm <= SQUELCH_FROM {
        return fm;
    }
    let x = (fm - SQUELCH_FROM) / (1.0 - SQUELCH_FROM);
    fm * (1.0 + (SQUELCH_TOP - 1.0) * x * x)
}

fn stack_index(fm: f64) -> f64 {
    if fm <= 0.0 { 0.0 } else { FM_MAX_INDEX * fm * fm }
}

#[inline]
fn wrap(p: f64) -> f64 {
    p - p.floor()
}

#[inline]
fn wave(w: usize, phase: f64, dt: f64, ss: f64) -> f64 {
    match w {
        0 => sin_turn(phase),
        1 => 4.0 * (phase - 0.5).abs() - 1.0,
        2 => ss * (1.0 - 2.0 * phase + poly_blep(phase, dt)),
        _ => {
            let mut p2 = phase + 0.5;
            if p2 >= 1.0 {
                p2 -= 1.0;
            }
            (if phase < 0.5 { 1.0 } else { -1.0 }) + poly_blep(phase, dt) - poly_blep(p2, dt)
        }
    }
}

#[inline]
fn pulse(phase: f64, dt: f64, f: f64) -> f64 {
    let width = 0.5 - (0.5 - PULSE_MIN) * f;
    let mut p2 = phase + 1.0 - width;
    if p2 >= 1.0 {
        p2 -= 1.0;
    }
    (if phase < width { 1.0 } else { -1.0 }) + poly_blep(phase, dt) - poly_blep(p2, dt) + 1.0 - 2.0 * width
}

#[allow(clippy::too_many_arguments)]
fn waves(w: usize, f: f64, phase: &[f64], dt: &[f64], scale: f64, out: &mut [f64], n: usize, ss: f64) {
    if w == 3 {
        for j in 0..n {
            out[j] = pulse(phase[j], dt[j] * scale, f);
        }
    } else if f > 0.0 {
        for j in 0..n {
            let d = dt[j] * scale;
            let a = wave(w, phase[j], d, ss);
            out[j] = a + (wave(w + 1, phase[j], d, ss) - a) * f;
        }
    } else {
        for j in 0..n {
            out[j] = wave(w, phase[j], dt[j] * scale, ss);
        }
    }
}

#[inline]
fn shaped(w: usize, f: f64, phase: f64, dt: f64, ss: f64) -> f64 {
    if w == 3 {
        return pulse(phase, dt, f);
    }
    let a = wave(w, phase, dt, ss);
    if f > 0.0 { a + (wave(w + 1, phase, dt, ss) - a) * f } else { a }
}

#[inline]
fn cz_wave(w: usize, phase: f64, bend: f64, edge: f64, pw: f64, ss: f64) -> f64 {
    if w == 0 {
        return sin_turn(phase);
    }
    if w == 1 {
        let c = cos_turn(phase);
        return c + (4.0 * (phase - 0.5).abs() - 1.0 - c) * bend;
    }
    if w == 2 {
        let q = if phase < edge { 0.5 * phase / edge } else { 0.5 + 0.5 * (phase - edge) / (1.0 - edge) };
        return -ss * cos_turn(q);
    }
    let b = 0.5 + (pw - 0.5) * bend;
    let e = edge.min(b).min(1.0 - b);
    let q = if phase < e { 0.5 * phase / e } else if phase < b { 0.5 } else if phase < b + e { 0.5 + 0.5 * (phase - b) / e } else { 1.0 };
    -cos_turn(q) + 1.0 - 2.0 * b
}

fn plain_wave(k: usize, p: f64, width: f64, ss: f64) -> f64 {
    match k {
        0 => sin_turn(p),
        1 => 4.0 * (p - 0.5).abs() - 1.0,
        2 => ss * (1.0 - 2.0 * p),
        _ => (if p < width { 1.0 } else { -1.0 }) + 1.0 - 2.0 * width,
    }
}

fn fundamental_phase(shape: f64, bend: f64, ss: f64) -> f64 {
    let w = if shape > 3.0 { 3 } else { 2f64.min(shape.floor()) as usize };
    let wf = shape - w as f64;
    let pw = if w == 3 { 0.5 - (0.5 - PULSE_MIN) * wf } else { 0.5 };
    let top = if bend < 0.0 { 1.0 } else if bend > CZ_OPEN { (bend - CZ_OPEN) / (1.0 - CZ_OPEN) } else { 0.0 };
    let b = CZ_FLOOR + (1.0 - CZ_FLOOR) * bend.max(0.0);
    let edge = 0.5 * (0.5f64.min(1.5 * PHASE_DT) / 0.5).powf(b);
    let (mut sx, mut cx) = (0.0, 0.0);
    for i in 0..PHASE_POINTS {
        let p = i as f64 / PHASE_POINTS as f64;
        let mut x = if w < 3 && wf > 0.0 {
            plain_wave(w, p, 0.5, ss) + (plain_wave(w + 1, p, 0.5, ss) - plain_wave(w, p, 0.5, ss)) * wf
        } else {
            plain_wave(w, p, pw, ss)
        };
        if top < 1.0 {
            let mut c = cz_wave(w, p, b, edge, pw, ss);
            if w < 3 && wf > 0.0 {
                c += (cz_wave(w + 1, p, b, edge, 0.5, ss) - c) * wf;
            }
            x = c + (x - c) * top;
        }
        sx += x * sin_turn(p);
        cx += x * cos_turn(p);
    }
    let t = cx.atan2(sx) / (2.0 * PI);
    if t.abs() < 1e-9 { 0.0 } else { t }
}

const OFF: u8 = 0;
const ATTACK: u8 = 1;
const DECAY: u8 = 2;
const SUSTAIN: u8 = 3;
const RELEASE: u8 = 4;

#[derive(Default)]
struct Voice {
    note: f64,
    group: i32,
    freq: f64,
    target_freq: f64,
    velocity: f64,
    vel: f64,
    glide: f64,
    ring: bool,
    p1: f64, p2: f64, p3: f64, p4: f64,
    p5: f64, p6: f64, fb1: f64, fb2: f64, cf1: f64, cf2: f64,
    u: [f64; 4],
    stage: [u8; 2],
    amp: [f64; 2],
    fenv: f64,
    /// The note's envelope depth from its dynamic: the filter and FM envelopes' lift x this
    /// (GHOST 0.5, NORMAL 1, ACCENT 1.5, as a 303's accent opens its filter).
    env_dyn: f64,
    fattacking: bool,
    fmenv: f64,
    fmattacking: bool,
    age: u64,
    counter: i32,
    cut_left: i32,
    note_t: f64,
    vib_ph: f64,
    filter: Svf,
    crush_phase: f64,
    held: f64,
}

impl Voice {
    fn new() -> Self {
        Voice { group: -1, freq: 110.0, target_freq: 110.0, velocity: 1.0, vel: 1.0, glide: 1.0, crush_phase: 1.0, env_dyn: 1.0, ..Default::default() }
    }
    fn sounding(&self) -> bool {
        self.stage[0] != OFF || self.stage[1] != OFF
    }
    fn held(&self) -> bool {
        let (a, b) = (self.stage[0], self.stage[1]);
        (a != OFF && a != RELEASE) || (b != OFF && b != RELEASE)
    }
}

/// PAD's LOW CUT / MOD / VERB.
struct PadFx {
    hp_l: Svf,
    hp_r: Svf,
    m: ModFx,
    verb: VerbFx,
    wet_l: [f32; FX_BLOCK],
    wet_r: [f32; FX_BLOCK],
}

/// A voice's block between the stages.
struct Bufs {
    dt: [f64; BLOCK],
    p1: [f64; BLOCK],
    p2: [f64; BLOCK],
    sub: [f64; BLOCK],
    env: [f64; BLOCK],
    pa: [f64; BLOCK],
    da: [f64; BLOCK],
    pb: [f64; BLOCK],
    db: [f64; BLOCK],
    c1: [f64; BLOCK],
    u: [[f64; BLOCK]; 4],
    o1: [f64; BLOCK],
    top: [f64; BLOCK],
    o2: [f64; BLOCK],
}

pub struct Synth {
    /// The notes started, for the web build's tests (None = not kept, the normal case).
    pub notes: Option<Vec<f64>>,
    sr: f64,
    cut_len: i32,
    vel_k: f64,
    voices: Vec<Voice>,
    b: Box<Bufs>,
    rise: &'static [f64; 12],
    shape: f64, fm: f64, fm_ratio: f64,
    cz: i32, intensity: f64, cz_bend: f64,
    saw_sign: f64, align: bool,
    c_ratio: f64,
    o_gain: f64,
    fm_comp: f64, fm_gain: f64,
    pair_fm: f64, squelch_on: bool,
    pair_sign: f64,
    pair_phase: f64,
    body_on: bool,
    algo: i32, ratio2: f64, ratio3: f64, feedback: f64, fm_index: f64, fm2: f64, fm2_index: f64, carriers: f64,
    dc_xl: f64, dc_yl: f64, dc_xr: f64, dc_yr: f64, dc_r: f64,
    fm_mod: f64, fm_eff: f64, detune: f64, sub: f64, octave: f64, mono: bool,
    unison: f64,
    poly_limit: usize, voice_count: usize,
    mono_voice: usize,
    c_feedback: f64,
    u_ratio: [f64; 4],
    slide_coeff: f64,
    cutoff: f64, reso: f64, fenv_amt: f64, fdecay_mul: f64, fattack_inc: f64,
    fm_decay_mul: f64, fm_attack_inc: f64,
    fm_decay_ring_mul: f64, fdecay_ring_mul: f64,
    filter_mod: f64,
    drive: f64, crush: f64, level: f64, drive_comp: f64,
    crush_phase: f64, held: f64,
    filter_pos: i32,
    last_voice: Option<usize>,
    post_filter_l: Svf,
    post_filter_r: Svf,
    post_counter: i32,
    attack_inc: [f64; 2],
    decay_mul: [f64; 2],
    decay_ring_mul: [f64; 2],
    sustain: [f64; 2],
    release_mul: [f64; 2],
    age_counter: u64,
    pitch_mod: f64,
    vib_depth: f64, vib_rate: f64, vib_delay: f64, bend: f64, bend_time: f64, pitch_fx: bool,
    env_link: bool,
    decay1: f64, d_ratio: f64,
    duck_depth: f64, duck_rel_inc: f64, duck_stage: i32, duck_x: f64, duck_from: f64, duck_shape: f64,
    duck_attack_inc: f64,
    delay: Option<Box<Delay>>,
    room: Option<Box<Reverb>>,
    pad: Option<Box<PadFx>>,
    low_cut: f64, mod_mix: f64, verb_mix: f64,
    post_idle: IdleGate,
}

impl Synth {
    pub fn new(sample_rate: f64, kind: SoundKind) -> Self {
        let sr = sample_rate;
        let fixed_list = fixed(kind);
        let has = |id: &str| fixed_list.iter().any(|(f, v)| *f == id && *v != 0.0);
        let delay = has("onboard").then(|| {
            let mut d = Delay::new(sr, Some(ONBOARD_DELAY_SECONDS));
            d.set_param("dly_tone", ONBOARD_DLY_TONE);
            Box::new(d)
        });
        let room = has("onboard").then(|| {
            let mut r = Reverb::new(sr);
            for (id, v) in [("rev_size", 0.35), ("rev_damp", 0.55), ("rev_predelay", 8.0), ("rev_width", 1.0)] {
                r.set_param(id, v);
            }
            Box::new(r)
        });
        let pad = has("padfx").then(|| {
            let mut m = ModFx::new(sr);
            m.set("mod_rate", 0.5);
            m.set("mod_depth", 0.5);
            let mut verb = VerbFx::new(sr);
            verb.set_mode("HALL");
            verb.set("vrb_size", 0.7);
            verb.set("vrb_len", 0.6);
            Box::new(PadFx { hp_l: Svf::default(), hp_r: Svf::default(), m, verb, wet_l: [0.0; FX_BLOCK], wet_r: [0.0; FX_BLOCK] })
        });
        let z = [0.0; BLOCK];
        let mut s = Synth {
            notes: None,
            sr,
            cut_len: (js::round(CUT_FADE * sr) as i32).max(1),
            vel_k: 1.0 - (-1.0 / (VEL_SMOOTH * sr)).exp(),
            voices: (0..MAX_VOICES).map(|_| Voice::new()).collect(),
            b: Box::new(Bufs { dt: z, p1: z, p2: z, sub: z, env: z, pa: z, da: z, pb: z, db: z, c1: z, u: [z; 4], o1: z, top: z, o2: z }),
            rise: drive_rise(kind),
            shape: 2.0, fm: 0.0, fm_ratio: 2.0,
            cz: 0, intensity: 0.5, cz_bend: 1.0,
            saw_sign: 1.0, align: true,
            c_ratio: 1.0,
            o_gain: 1.0,
            fm_comp: 0.0, fm_gain: 1.0,
            pair_fm: 0.0, squelch_on: false,
            pair_sign: 1.0,
            pair_phase: 0.0,
            body_on: false,
            algo: 0, ratio2: 1.0, ratio3: 1.0, feedback: 0.0, fm_index: 0.0, fm2: 0.0, fm2_index: 0.0, carriers: 0.35,
            dc_xl: 0.0, dc_yl: 0.0, dc_xr: 0.0, dc_yr: 0.0, dc_r: 1.0 - 2.0 * PI * DC_HZ / sr,
            fm_mod: 0.0, fm_eff: 0.0, detune: 0.0, sub: 0.0, octave: 0.0, mono: false,
            unison: 0.0,
            poly_limit: MAX_VOICES, voice_count: MAX_VOICES,
            mono_voice: 0,
            c_feedback: 0.0,
            u_ratio: [0.0; 4],
            slide_coeff: 1.0,
            cutoff: 1200.0, reso: 0.3, fenv_amt: 0.4, fdecay_mul: 0.0, fattack_inc: 0.0,
            fm_decay_mul: 0.0, fm_attack_inc: 0.0,
            fm_decay_ring_mul: 0.0, fdecay_ring_mul: 0.0,
            filter_mod: 0.0,
            drive: 1.0, crush: 0.0, level: 0.7, drive_comp: 1.0,
            crush_phase: 1.0, held: 0.0,
            filter_pos: 0,
            last_voice: None,
            post_filter_l: Svf::default(),
            post_filter_r: Svf::default(),
            post_counter: 0,
            attack_inc: [1.0, 1.0],
            decay_mul: [0.0; 2],
            decay_ring_mul: [0.0; 2],
            sustain: [0.5, 0.5],
            release_mul: [0.0; 2],
            age_counter: 0,
            pitch_mod: 1.0,
            vib_depth: 0.0, vib_rate: 5.5, vib_delay: 0.3, bend: 0.0, bend_time: 0.08, pitch_fx: false,
            env_link: false,
            decay1: 0.4, d_ratio: 1.0,
            duck_depth: 0.0, duck_rel_inc: 0.0, duck_stage: 0, duck_x: 0.0, duck_from: 0.0, duck_shape: 0.0,
            duck_attack_inc: 1.0 / (DUCK_ATTACK * sr),
            delay,
            room,
            pad,
            low_cut: 20.0, mod_mix: 0.0, verb_mix: 0.0,
            post_idle: IdleGate::new(ONBOARD_DELAY_SECONDS * 2.0, sr),
        };
        for (id, v) in ALL {
            s.set_param(id, v);
        }
        for &(id, v) in fixed_list {
            s.set_param(id, v);
        }
        for (id, v) in type_params(kind) {
            s.set_param(id, v);
        }
        s
    }

    /// Voices held now (attack, decay or sustain on OSC 1), for the web build's tests.
    pub fn held_voices(&self) -> usize {
        self.voices.iter().filter(|v| (1..=3).contains(&v.stage[0])).count()
    }

    pub fn note_on(&mut self, note: f64, velocity: f64, group: i32, ring: bool, slide_from: i32, _slide: bool) {
        if let Some(log) = self.notes.as_mut() {
            log.push(note);
        }
        let n = note + self.octave * 12.0;
        let freq = midi_to_hz(n);
        if slide_from >= 0 {
            let mut s: Option<usize> = None;
            for i in 0..self.voice_count {
                let c = &self.voices[i];
                if c.group == slide_from && c.held() && s.is_none_or(|k| c.age < self.voices[k].age) {
                    s = Some(i);
                }
            }
            if let Some(k) = s {
                let v = &mut self.voices[k];
                v.note = note;
                v.group = group;
                v.target_freq = freq;
                v.glide = self.slide_coeff;
                v.velocity = velocity;
                v.ring = ring;
                return;
            }
        }
        let vi = if self.mono {
            let cut_len = self.cut_len;
            let old = &mut self.voices[self.mono_voice];
            if old.sounding() {
                if old.cut_left == 0 {
                    old.cut_left = cut_len;
                }
                self.mono_voice ^= 1;
            }
            let v = &mut self.voices[self.mono_voice];
            if v.sounding() {
                v.stage = [OFF; 2];
                v.amp = [0.0; 2];
                v.filter.reset();
            }
            v.freq = freq;
            self.mono_voice
        } else {
            let k = self.allocate();
            self.voices[k].freq = freq;
            k
        };
        let (fattack, fmattack) = (self.fattack_inc > 0.0, self.fm_attack_inc > 0.0);
        self.age_counter += 1;
        let age = self.age_counter;
        let v = &mut self.voices[vi];
        v.note = note;
        v.group = group;
        v.target_freq = freq;
        v.glide = 1.0;
        v.ring = ring;
        v.velocity = velocity;
        if !v.sounding() {
            v.vel = velocity;
            v.u = UNISON_PHASE;
            v.fb1 = 0.0;
            v.fb2 = 0.0;
            v.cf1 = 0.0;
            v.cf2 = 0.0;
        }
        v.stage = [ATTACK; 2];
        v.fattacking = fattack;
        v.fenv = if fattack { 0.0 } else { 1.0 };
        v.env_dyn = 1.0 + ENV_DYNAMIC * dynamic_of(velocity);
        v.fmattacking = fmattack;
        v.fmenv = if fmattack { 0.0 } else { 1.0 };
        v.age = age;
        v.counter = 0;
        v.cut_left = 0;
        v.note_t = 0.0;
        v.vib_ph = 0.0;
        self.last_voice = Some(vi);
    }

    pub fn set_chain(&mut self, order: f64) {
        let most = if self.pad.is_some() || self.delay.is_some() { 2.0 } else { 1.0 };
        let pos = js::round(order).min(most).max(0.0) as i32;
        if pos == self.filter_pos {
            return;
        }
        self.filter_pos = pos;
        for v in &mut self.voices {
            v.crush_phase = 1.0;
            v.held = 0.0;
            v.filter.reset();
        }
        self.post_filter_l.reset();
        self.post_filter_r.reset();
    }

    pub fn set_pitch_mod(&mut self, semitones: f64) {
        self.pitch_mod = if semitones == 0.0 { 1.0 } else { 2f64.powf(semitones / 12.0) };
    }

    pub fn set_filter_mod(&mut self, octaves: f64) {
        self.filter_mod = octaves;
    }

    pub fn set_fm_mod(&mut self, amount: f64) {
        self.fm_mod = amount;
        self.update_fm();
    }

    fn update_fm(&mut self) {
        let f = self.fm + self.fm_mod;
        self.fm_eff = f.clamp(0.0, 1.0);
        self.pair_fm = if self.squelch_on { squelch(self.fm_eff) } else { self.fm_eff };
        self.fm_gain = fm_gain_of(self.fm_comp, self.fm_eff);
        self.fm_index = stack_index(self.fm_eff);
        let f2 = self.fm2 + self.fm_mod;
        self.fm2_index = stack_index(f2.clamp(0.0, 1.0));
    }

    pub fn cut(&mut self) {
        for v in &mut self.voices {
            if !v.sounding() || v.cut_left != 0 {
                continue;
            }
            v.cut_left = self.cut_len;
        }
    }

    pub fn note_off(&mut self, group: i32) {
        for v in &mut self.voices {
            if !v.held() || (group >= 0 && v.group != group) {
                continue;
            }
            for k in 0..2 {
                if v.stage[k] != OFF {
                    v.stage[k] = RELEASE;
                }
            }
        }
    }

    pub fn set_param(&mut self, id: &str, value: f64) {
        let sr = self.sr;
        match id {
            "shape" => { self.shape = value.clamp(0.0, 4.0); self.update_phase(); }
            "cz" => { self.cz = js::round(value) as i32; self.set_intensity(self.intensity); }
            "sawrise" => { self.saw_sign = if value > 0.0 { -1.0 } else { 1.0 }; self.update_phase(); }
            "align" => { self.align = value > 0.0; self.update_phase(); }
            "wave" => self.shape = LEGACY_WAVE_TO_SHAPE.get(js::round(value) as usize).copied().unwrap_or(2.0),
            "fmratio" => self.fm_ratio = value,
            "cratio" => self.c_ratio = if value > 0.0 { value } else { 1.0 },
            "fm" => { self.fm = value; self.update_fm(); }
            "intensity" => self.set_intensity(value),
            "vibrato" => { self.vib_depth = value; self.pitch_fx = self.vib_depth > 0.0 || self.bend != 0.0; }
            "vibrate" => self.vib_rate = value,
            "vibdelay" => self.vib_delay = value,
            "bend" => { self.bend = value; self.pitch_fx = self.vib_depth > 0.0 || self.bend != 0.0; }
            "bendtime" => self.bend_time = value.max(0.001),
            "squelch" => { self.squelch_on = value == 1.0; self.update_fm(); }
            "body" => self.body_on = value == 1.0,
            "fm2" => { self.fm2 = value; self.update_fm(); }
            "ratio2" => self.ratio2 = value,
            "ratio3" => self.ratio3 = value,
            "feedback" => self.feedback = value,
            "cfeedback" => self.c_feedback = value,
            "carriers" => self.carriers = value,
            "algo" => self.algo = js::round(value) as i32,
            "detune" => self.detune = value,
            "sub" => self.sub = value,
            "unison" => self.unison = value,
            "octave" => self.octave = js::round(value) - OCTAVE_ZERO,
            "voice" => { self.mono = js::round(value) == 1.0; self.update_voice_count(); }
            "voices" => { self.poly_limit = js::round(value).clamp(1.0, MAX_VOICES as f64) as usize; self.update_voice_count(); }
            "glide" => self.slide_coeff = if value <= 0.0005 { 1.0 } else { 1.0 - (-1.0 / (value * sr)).exp() },
            "cutoff" => self.cutoff = value,
            "reso" => self.reso = value,
            "fenv" => self.fenv_amt = value,
            "fdecay" => { self.fdecay_mul = decay_mul(value, sr); self.fdecay_ring_mul = decay_mul(value * RING_STRETCH, sr); }
            "fattack" => self.fattack_inc = if value <= 0.0006 { 0.0 } else { 1.0 / (value * sr) },
            "fmdecay" => { self.fm_decay_mul = decay_mul(value, sr); self.fm_decay_ring_mul = decay_mul(value * RING_STRETCH, sr); }
            "fmattack" => self.fm_attack_inc = if value <= 0.0006 { 0.0 } else { 1.0 / (value * sr) },
            "drive" => { self.drive = value; self.drive_comp = drive_comp_gain(self.rise, value); }
            "crush" => self.crush = value,
            "level" => self.level = value,
            "ogain" => self.o_gain = value,
            "fmpair" => {
                let (c, m, sign) = FM_PAIRS[js::round(value).clamp(0.0, 7.0) as usize];
                self.c_ratio = c;
                self.fm_ratio = m;
                self.pair_sign = sign;
            }
            "fmcomp" => { self.fm_comp = value; self.update_fm(); }
            "attack" => {
                self.attack_inc[0] = 1.0 / (value * sr);
                if self.env_link {
                    self.attack_inc[1] = self.attack_inc[0];
                }
            }
            "decay" => {
                self.decay1 = value;
                self.set_decay(0, value);
                if self.env_link {
                    self.set_decay(1, value * self.d_ratio);
                }
            }
            "sustain" => { self.sustain[0] = value; if self.env_link { self.sustain[1] = value; } }
            "release" => {
                self.release_mul[0] = decay_mul(value, sr);
                if self.env_link {
                    self.release_mul[1] = self.release_mul[0];
                }
            }
            "attack2" => if !self.env_link { self.attack_inc[1] = 1.0 / (value * sr); },
            "decay2" => if !self.env_link { self.set_decay(1, value); },
            "sustain2" => if !self.env_link { self.sustain[1] = value; },
            "release2" => if !self.env_link { self.release_mul[1] = decay_mul(value, sr); },
            "dratio" => { self.d_ratio = value; if self.env_link { self.set_decay(1, self.decay1 * value); } }
            "envlink" => {
                self.env_link = value > 0.0;
                if self.env_link {
                    self.attack_inc[1] = self.attack_inc[0];
                    self.sustain[1] = self.sustain[0];
                    self.release_mul[1] = self.release_mul[0];
                    self.set_decay(1, self.decay1 * self.d_ratio);
                }
            }
            "duck" => self.duck_depth = value,
            "duckrel" => self.duck_rel_inc = 1.0 / (value * sr),
            "dtime" => if let Some(d) = &mut self.delay { d.set_param("dly_time", value); },
            "dfdbk" => if let Some(d) = &mut self.delay { d.set_param("dly_fdbk", value); },
            "dmix" => if let Some(d) = &mut self.delay { d.set_param("dly_return", value); },
            "verb" => {
                if let Some(r) = &mut self.room {
                    r.set_param("rev_return", value * ONBOARD_VERB_GAIN);
                }
                if let Some(p) = &mut self.pad {
                    if self.verb_mix <= 0.0 && value > 0.0 {
                        p.verb.reset();
                    }
                }
                self.verb_mix = value;
            }
            "lowcut" => {
                self.low_cut = value;
                if let Some(p) = &mut self.pad {
                    p.hp_l.setup(value, LOW_CUT_RESO, sr);
                    p.hp_r.setup(value, LOW_CUT_RESO, sr);
                }
            }
            "modmix" => {
                if let Some(p) = &mut self.pad {
                    if self.mod_mix <= 0.0 && value > 0.0 {
                        p.m.reset();
                    }
                }
                self.mod_mix = value;
            }
            "modtype" => if let Some(p) = &mut self.pad { p.m.set_mode(PAD_MOD_TYPES[js::round(value).clamp(0.0, 2.0) as usize]); },
            _ => {}
        }
    }

    fn set_decay(&mut self, k: usize, seconds: f64) {
        self.decay_mul[k] = decay_mul(seconds, self.sr);
        self.decay_ring_mul[k] = decay_mul(seconds * RING_STRETCH, self.sr);
    }

    pub fn set_tempo(&mut self, bpm: f64) {
        if let Some(d) = &mut self.delay {
            d.set_tempo(bpm);
        }
    }

    pub fn duck(&mut self) {
        if self.duck_depth <= 0.0 {
            return;
        }
        self.duck_from = self.duck_shape;
        self.duck_stage = 1;
        self.duck_x = 0.0;
    }

    /// SPACE, then FX ROUTING's filter last (on the track's output, in place).
    pub fn post(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.space(l, r);
        if self.filter_pos == 2 {
            self.post_filter(l, r);
        }
    }

    fn space(&mut self, l: &mut [f32], r: &mut [f32]) {
        if self.pad.is_some() {
            self.pad_post(l, r);
            return;
        }
        let (Some(delay), Some(room)) = (&mut self.delay, &mut self.room) else { return };
        if self.post_idle.skip(l, r) {
            return;
        }
        delay.process(l, r);
        room.process(l, r);
        self.post_idle.done(l, r);
    }

    fn post_filter(&mut self, l: &mut [f32], r: &mut [f32]) {
        let fmod = if self.filter_mod == 0.0 { 1.0 } else { 2f64.powf(self.filter_mod) };
        let fenv = self.last_voice.map_or(0.0, |k| self.voices[k].fenv * self.voices[k].env_dyn);
        for i in 0..l.len() {
            let due = self.post_counter <= 0;
            self.post_counter -= 1;
            if due {
                self.post_counter = FILTER_UPDATE;
                let fc = self.cutoff * fmod * exp2(self.fenv_amt * 6.0 * fenv);
                self.post_filter_l.setup(fc, self.reso, self.sr);
                self.post_filter_r.setup(fc, self.reso, self.sr);
            }
            self.post_filter_l.process(l[i] as f64);
            l[i] = self.post_filter_l.low as f32;
            self.post_filter_r.process(r[i] as f64);
            r[i] = self.post_filter_r.low as f32;
        }
    }

    fn pad_post(&mut self, l: &mut [f32], r: &mut [f32]) {
        let cut = self.low_cut > LOW_CUT_OFF;
        if !cut && self.mod_mix <= 0.0 && self.verb_mix <= 0.0 {
            return;
        }
        if self.post_idle.skip(l, r) {
            return;
        }
        let n = l.len();
        let fx = self.pad.as_mut().unwrap();
        if cut {
            for i in 0..n {
                fx.hp_l.process(l[i] as f64);
                l[i] = fx.hp_l.high as f32;
                fx.hp_r.process(r[i] as f64);
                r[i] = fx.hp_r.high as f32;
            }
        }
        if self.mod_mix > 0.0 {
            fx.m.render(l, r, &mut fx.wet_l, &mut fx.wet_r, n);
            for i in 0..n {
                js::add_f32(&mut l[i], fx.wet_l[i] as f64 * self.mod_mix);
                js::add_f32(&mut r[i], fx.wet_r[i] as f64 * self.mod_mix);
            }
        }
        if self.verb_mix > 0.0 {
            fx.verb.render(l, r, &mut fx.wet_l, &mut fx.wet_r, n);
            for i in 0..n {
                js::add_f32(&mut l[i], fx.wet_l[i] as f64 * self.verb_mix);
                js::add_f32(&mut r[i], fx.wet_r[i] as f64 * self.verb_mix);
            }
        }
        self.post_idle.done(l, r);
    }

    /// Renders into out_l / out_r[start, end) (the engine's own zeroed track buffer).
    pub fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32], start: usize, end: usize) {
        self.render_voices(out_l, out_r, start, end);
        if self.algo == 2 {
            self.render_dc_block(out_l, out_r, start, end);
        }
        if self.filter_pos == 0 {
            self.render_crush(out_l, out_r, start, end);
        }
        let og = self.o_gain * self.fm_gain;
        if og != 1.0 {
            for i in start..end {
                out_l[i] = (out_l[i] as f64 * og) as f32;
                out_r[i] = (out_r[i] as f64 * og) as f32;
            }
        }
        if self.duck_stage != 0 {
            self.render_duck(out_l, out_r, start, end);
        }
    }

    fn render_duck(&mut self, out_l: &mut [f32], out_r: &mut [f32], start: usize, end: usize) {
        for i in start..end {
            if self.duck_stage == 1 {
                self.duck_x += self.duck_attack_inc;
                if self.duck_x >= 1.0 {
                    self.duck_x = 0.0;
                    self.duck_stage = 2;
                    self.duck_shape = 1.0;
                } else {
                    self.duck_shape = self.duck_from + (1.0 - self.duck_from) * self.duck_x;
                }
            } else if self.duck_stage == 2 {
                self.duck_x += self.duck_rel_inc;
                if self.duck_x >= 1.0 {
                    self.duck_stage = 0;
                    self.duck_shape = 0.0;
                } else {
                    let t = self.duck_x;
                    self.duck_shape = 1.0 - t * t * (3.0 - 2.0 * t);
                }
            }
            let g = 1.0 - self.duck_depth * self.duck_shape;
            out_l[i] = (out_l[i] as f64 * g) as f32;
            out_r[i] = (out_r[i] as f64 * g) as f32;
        }
    }

    fn render_dc_block(&mut self, out_l: &mut [f32], out_r: &mut [f32], start: usize, end: usize) {
        let r = self.dc_r;
        let (mut xl, mut yl, mut xr, mut yr) = (self.dc_xl, self.dc_yl, self.dc_xr, self.dc_yr);
        for i in start..end {
            let (l, rr) = (out_l[i] as f64, out_r[i] as f64);
            yl = l - xl + r * yl;
            xl = l;
            out_l[i] = yl as f32;
            yr = rr - xr + r * yr;
            xr = rr;
            out_r[i] = yr as f32;
        }
        self.dc_xl = xl;
        self.dc_yl = if yl.abs() < 1e-15 { 0.0 } else { yl };
        self.dc_xr = xr;
        self.dc_yr = if yr.abs() < 1e-15 { 0.0 } else { yr };
    }

    fn render_crush(&mut self, out_l: &mut [f32], out_r: &mut [f32], start: usize, end: usize) {
        if self.crush <= 0.0 {
            return;
        }
        let step = crush_step(self.crush);
        let levels = crush_levels(self.crush);
        for i in start..end {
            self.crush_phase += step;
            if self.crush_phase >= 1.0 {
                self.crush_phase -= 1.0;
                self.held = js::round(out_l[i] as f64 * levels) / levels;
            }
            out_l[i] = self.held as f32;
            out_r[i] = self.held as f32;
        }
    }

    fn render_voices(&mut self, out_l: &mut [f32], out_r: &mut [f32], start: usize, end: usize) {
        let det = 2f64.powf(self.detune * 0.35 / 12.0);
        let drive_norm = if self.drive > 1.0 { 1.0 / self.drive.min(3.0).tanh() } else { 1.0 };
        let count = self.voice_count;
        let fmod = if self.filter_mod == 0.0 { 1.0 } else { 2f64.powf(self.filter_mod) };
        let uni = self.unison;
        if uni > 0.0 {
            let cents = 12.0 + 20.0 * self.detune;
            for k in 0..4 {
                self.u_ratio[k] = 2f64.powf(UNISON_SPREAD[k] * cents / 1200.0);
            }
        }
        let cfb_amt = self.c_feedback * MAX_CARRIER_FEEDBACK / (2.0 * PI);
        let w = if self.shape > 3.0 { 3 } else { 2f64.min(self.shape.floor()) as usize };
        let wf = self.shape - w as f64;
        let mut voices = std::mem::take(&mut self.voices);
        let mut from = start;
        while from < end {
            let to = end.min(from + BLOCK);
            for v in voices.iter_mut().take(count) {
                if !v.sounding() {
                    continue;
                }
                let n = to - from;
                self.phases(v, n, det);
                match self.algo {
                    1 => self.osc_carriers(v, n, det, cfb_amt, w, wf),
                    2 => self.osc_stacks(v, n, det, cfb_amt, w, wf),
                    _ => self.osc_pair(v, n, det, w, wf),
                }
                if uni > 0.0 {
                    self.osc_unison(v, n, w, wf);
                }
                self.voice_out(v, out_l, out_r, from, to, fmod, drive_norm);
                if !v.sounding() {
                    v.amp = [0.0; 2];
                    v.filter.reset();
                }
            }
            from += BLOCK;
        }
        self.voices = voices;
    }

    fn phases(&mut self, v: &mut Voice, n: usize, det: f64) {
        let sr = self.sr;
        let (pitch_mod, sub) = (self.pitch_mod, self.sub);
        let fm_attack_inc = self.fm_attack_inc;
        let fm_decay_mul = if v.ring { self.fm_decay_ring_mul } else { self.fm_decay_mul };
        let (mut pm0, mut pm_step) = (1.0, 0.0);
        if self.pitch_fx {
            let ph1 = v.vib_ph + self.vib_rate * n as f64 / sr;
            pm0 = self.note_pitch(v.note_t, v.vib_ph);
            pm_step = (self.note_pitch(v.note_t + n as f64, ph1) - pm0) / n as f64;
            v.vib_ph = ph1 - ph1.floor();
        }
        v.note_t += n as f64;
        let b = &mut self.b;
        for j in 0..n {
            if v.freq != v.target_freq {
                v.freq += (v.target_freq - v.freq) * v.glide;
                if (v.target_freq - v.freq).abs() < 1e-3 {
                    v.freq = v.target_freq;
                }
            }
            let dt1 = if self.pitch_fx { v.freq * pitch_mod * (pm0 + pm_step * j as f64) / sr } else { v.freq * pitch_mod / sr };
            v.p1 += dt1;
            if v.p1 >= 1.0 {
                v.p1 -= 1.0;
            }
            v.p2 += dt1 * det;
            if v.p2 >= 1.0 {
                v.p2 -= 1.0;
            }
            v.p3 += dt1 * 0.5;
            if v.p3 >= 1.0 {
                v.p3 -= 1.0;
            }
            b.dt[j] = dt1;
            b.p1[j] = v.p1;
            b.p2[j] = v.p2;
            b.sub[j] = sin_turn(v.p3) * sub * 2.0;
            b.env[j] = v.fmenv * v.env_dyn;
            if v.fmattacking {
                v.fmenv += fm_attack_inc;
                if v.fmenv >= 1.0 {
                    v.fmenv = 1.0;
                    v.fmattacking = false;
                }
            } else {
                v.fmenv *= fm_decay_mul;
            }
        }
    }

    fn note_pitch(&self, t: f64, ph: f64) -> f64 {
        let s = t / self.sr;
        let swell = if self.vib_delay > 0.0 { (s / self.vib_delay).min(1.0) } else { 1.0 };
        let st = self.bend * (-s / self.bend_time).exp() + self.vib_depth * swell * swell * sin_turn(ph);
        exp2(st / 12.0)
    }

    fn set_intensity(&mut self, value: f64) {
        self.intensity = value.clamp(0.0, 1.0);
        self.cz_bend = if self.cz == 1 { self.intensity } else if self.cz == 2 { (2.0 * self.intensity).min(1.0) } else { 1.0 };
        self.update_phase();
    }

    fn update_phase(&mut self) {
        self.pair_phase = if self.align {
            fundamental_phase(self.shape, if self.cz > 0 && self.cz_bend < 1.0 { self.cz_bend } else { -1.0 }, self.saw_sign)
        } else {
            0.0
        };
    }

    /// SHAPE's waves (OSC 1, OSC 2, UNISON copies), bent by CZ. `phase` / `out` name buffers
    /// in `b` (they may not alias: p1 / p2 / pa / pb in, o1 / o2 / u[k] out).
    #[allow(clippy::too_many_arguments)]
    fn osc_waves(cz: i32, a: f64, ss: f64, w: usize, wf: f64, phase: &[f64], dt: &[f64], scale: f64, out: &mut [f64], top: &mut [f64], n: usize) {
        if cz == 0 || a >= 1.0 {
            waves(w, wf, phase, dt, scale, out, n, ss);
            return;
        }
        let bend = CZ_FLOOR + (1.0 - CZ_FLOOR) * a;
        let dmin = 0.5f64.min(1.5 * dt[0] * scale);
        let edge = 0.5 * (dmin / 0.5).powf(bend);
        let pw = if w == 3 { 0.5 - (0.5 - PULSE_MIN) * wf } else { 0.5 };
        let blend = w < 3 && wf > 0.0;
        for j in 0..n {
            let p = phase[j];
            let mut c = cz_wave(w, p, bend, edge, pw, ss);
            if blend {
                c += (cz_wave(w + 1, p, bend, edge, 0.5, ss) - c) * wf;
            }
            out[j] = c;
        }
        if a > CZ_OPEN {
            let t = (a - CZ_OPEN) / (1.0 - CZ_OPEN);
            waves(w, wf, phase, dt, scale, top, n, ss);
            for j in 0..n {
                out[j] += (top[j] - out[j]) * t;
            }
        }
    }

    fn osc_pair(&mut self, v: &mut Voice, n: usize, det: f64, w: usize, wf: f64) {
        let (cz, a, ss) = (self.cz, self.cz_bend, self.saw_sign);
        let b = &mut *self.b;
        Self::osc_waves(cz, a, ss, w, wf, &b.p1, &b.dt, 1.0, &mut b.o1, &mut b.top, n);
        Self::osc_waves(cz, a, ss, w, wf, &b.p2, &b.dt, det, &mut b.o2, &mut b.top, n);
        let fm = self.fm_eff;
        if fm <= 0.0 {
            return;
        }
        let (fm_ratio, c_ratio, depth) = (self.fm_ratio, self.c_ratio, self.pair_fm);
        let ph = self.pair_phase;
        let c_shift = c_ratio * ph;
        let m_shift = fm_ratio * ph - (fm_ratio * ph).floor();
        let pair_fb = self.c_feedback * MAX_CARRIER_FEEDBACK;
        for j in 0..n {
            let dt1 = b.dt[j];
            v.p4 += dt1 * fm_ratio;
            if v.p4 >= 1.0 {
                v.p4 -= 1.0;
            }
            let index = depth * (0.5 + 4.5 * b.env[j]);
            let mut carrier = b.p1[j];
            if c_ratio != 1.0 {
                v.p5 += dt1 * c_ratio;
                if v.p5 >= 1.0 {
                    v.p5 -= v.p5.floor();
                }
                carrier = v.p5;
            }
            let mut mp = v.p4 + m_shift;
            if mp >= 1.0 {
                mp -= 1.0;
            }
            let fm_out = if pair_fb > 0.0 {
                let c = sin_rad(2.0 * PI * (carrier + c_shift) + index * sin_turn(mp) + (v.cf1 + v.cf2) * 0.5 * pair_fb);
                v.cf2 = v.cf1;
                v.cf1 = c;
                self.pair_sign * c
            } else {
                self.pair_sign * sin_rad(2.0 * PI * (carrier + c_shift) + index * sin_turn(mp))
            };
            b.o1[j] = b.o1[j] * (1.0 - fm) + fm_out * fm;
            b.o2[j] = b.o2[j] * (1.0 - fm) + fm_out * fm;
        }
        if self.body_on {
            let body = fm * BODY;
            for j in 0..n {
                let mut q1 = b.p1[j] + ph;
                if q1 >= 1.0 {
                    q1 -= 1.0;
                } else if q1 < 0.0 {
                    q1 += 1.0;
                }
                let mut q2 = b.p2[j] + ph;
                if q2 >= 1.0 {
                    q2 -= 1.0;
                } else if q2 < 0.0 {
                    q2 += 1.0;
                }
                b.o1[j] += body * sin_turn(q1);
                b.o2[j] += body * sin_turn(q2);
            }
        }
    }

    fn osc_carriers(&mut self, v: &mut Voice, n: usize, det: f64, cfb_amt: f64, w: usize, wf: f64) {
        let (fm_ratio, feedback) = (self.fm_ratio, self.feedback);
        let (fm_index, fm2_index, ratio2, ratio3, c) = (self.fm_index, self.fm2_index, self.ratio2, self.ratio3, self.carriers);
        let ss = self.saw_sign;
        let b = &mut *self.b;
        for j in 0..n {
            let dt1 = b.dt[j];
            v.p4 += dt1 * fm_ratio;
            if v.p4 >= 1.0 {
                v.p4 -= 1.0;
            }
            let fb_in = (v.fb1 + v.fb2) * 0.5 * feedback * MAX_FEEDBACK;
            let m = sin_rad(2.0 * PI * v.p4 + fb_in);
            v.fb2 = v.fb1;
            v.fb1 = m;
            let env = fm_env_gain(b.env[j]) / (2.0 * PI);
            let pm = m * fm_index * env;
            let pm2 = m * fm2_index * env;
            let d5 = dt1 * ratio2 * det;
            let d6 = dt1 * ratio3;
            v.p5 += d5;
            if v.p5 >= 1.0 {
                v.p5 -= 1.0;
            }
            v.p6 += d6;
            if v.p6 >= 1.0 {
                v.p6 -= 1.0;
            }
            b.pa[j] = wrap(v.p6 + pm2);
            b.da[j] = d6;
            b.pb[j] = wrap(v.p5 + pm2);
            b.db[j] = d5;
            let cfb = (v.cf1 + v.cf2) * 0.5 * cfb_amt;
            let c1 = shaped(w, wf, wrap(b.p1[j] + pm + cfb), dt1, ss);
            v.cf2 = v.cf1;
            v.cf1 = c1;
            b.c1[j] = c1;
        }
        waves(w, wf, &b.pa, &b.da, 1.0, &mut b.o1, n, ss);
        waves(w, wf, &b.pb, &b.db, 1.0, &mut b.o2, n, ss);
        for j in 0..n {
            let c1 = b.c1[j];
            b.o1[j] = c1 * (1.0 - 0.4 * c) + b.o1[j] * 0.6 * c;
            b.o2[j] = c1 * (1.0 - c) + b.o2[j] * c;
        }
    }

    fn osc_stacks(&mut self, v: &mut Voice, n: usize, det: f64, cfb_amt: f64, w: usize, wf: f64) {
        let (fm_ratio, feedback) = (self.fm_ratio, self.feedback);
        let (fm_index, fm2_index, ratio2, ratio3, c) = (self.fm_index, self.fm2_index, self.ratio2, self.ratio3, self.carriers);
        let (cz, a, ss) = (self.cz, self.cz_bend, self.saw_sign);
        let b = &mut *self.b;
        let cz_on = cz > 0 && a < 1.0;
        let bend = CZ_FLOOR + (1.0 - CZ_FLOOR) * a;
        let edge = if cz_on { 0.5 * (0.5f64.min(1.5 * b.dt[0]) / 0.5).powf(bend) } else { 0.0 };
        let pw = if w == 3 { 0.5 - (0.5 - PULSE_MIN) * wf } else { 0.5 };
        for j in 0..n {
            let dt1 = b.dt[j];
            v.p4 += dt1 * fm_ratio;
            if v.p4 >= 1.0 {
                v.p4 -= 1.0;
            }
            let fb_in = (v.fb1 + v.fb2) * 0.5 * feedback * MAX_FEEDBACK;
            let m1 = sin_rad(2.0 * PI * v.p4 + fb_in);
            v.fb2 = v.fb1;
            v.fb1 = m1;
            let d5 = dt1 * ratio2 * det;
            v.p5 += d5;
            if v.p5 >= 1.0 {
                v.p5 -= 1.0;
            }
            v.p6 += dt1 * ratio3;
            if v.p6 >= 1.0 {
                v.p6 -= 1.0;
            }
            let m2 = sin_turn(v.p6);
            let env = fm_env_gain(b.env[j]) / (2.0 * PI);
            let idx = fm_index * env;
            let idx2 = fm2_index * env;
            b.pb[j] = wrap(v.p5 + m2 * idx2);
            b.db[j] = d5;
            let cfb = (v.cf1 + v.cf2) * 0.5 * cfb_amt;
            let ph = wrap(b.p1[j] + m1 * idx + cfb);
            let c1 = if cz_on {
                let mut c1 = cz_wave(w, ph, bend, edge, pw, ss);
                if w < 3 && wf > 0.0 {
                    c1 += (cz_wave(w + 1, ph, bend, edge, 0.5, ss) - c1) * wf;
                }
                c1
            } else {
                shaped(w, wf, ph, dt1, ss)
            };
            v.cf2 = v.cf1;
            v.cf1 = c1;
            b.o1[j] = c1;
        }
        Self::osc_waves(cz, a, ss, w, wf, &b.pb, &b.db, 1.0, &mut b.o2, &mut b.top, n);
        for j in 0..n {
            b.o2[j] = b.o1[j] * (1.0 - c) + b.o2[j] * c;
        }
    }

    fn osc_unison(&mut self, v: &mut Voice, n: usize, w: usize, wf: f64) {
        let uni = self.unison;
        let uni_gain = 1.0 / (1.0 + uni);
        let (cz, a, ss) = (self.cz, self.cz_bend, self.saw_sign);
        let b = &mut *self.b;
        for k in 0..4 {
            let r = self.u_ratio[k];
            let mut p = v.u[k];
            for j in 0..n {
                p += b.dt[j] * r;
                if p >= 1.0 {
                    p -= 1.0;
                }
                b.pa[j] = p;
            }
            v.u[k] = p;
            Self::osc_waves(cz, a, ss, w, wf, &b.pa, &b.dt, r, &mut b.u[k], &mut b.top, n);
        }
        for j in 0..n {
            let c1 = b.u[0][j] + b.u[2][j];
            let c2 = b.u[1][j] + b.u[3][j];
            b.o1[j] = (b.o1[j] + c1 * uni * 0.5) * uni_gain * 1.4;
            b.o2[j] = (b.o2[j] + c2 * uni * 0.5) * uni_gain * 1.4;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn voice_out(&mut self, v: &mut Voice, out_l: &mut [f32], out_r: &mut [f32], from: usize, to: usize, fmod: f64, drive_norm: f64) {
        let (sr, vel_k, level, drive, drive_comp) = (self.sr, self.vel_k, self.level, self.drive, self.drive_comp);
        let fx_first = self.filter_pos > 0;
        let filtered = self.filter_pos < 2;
        let crush = fx_first && self.crush > 0.0;
        let c_step = if crush { crush_step(self.crush) } else { 0.0 };
        let c_levels = if crush { crush_levels(self.crush) } else { 1.0 };
        let b = &*self.b;
        for (j, i) in (from..to).enumerate() {
            let o1 = b.o1[j] + b.sub[j];
            let o2 = b.o2[j];
            let mut mix = 0.0;
            for k in 0..2 {
                let mut a = v.amp[k];
                // A slide's notes keep their envelope (it is not restarted): they decay to SUSTAIN as any held note.
                let sus = self.sustain[k];
                match v.stage[k] {
                    ATTACK => {
                        a += self.attack_inc[k];
                        if a >= 1.0 {
                            a = 1.0;
                            v.stage[k] = DECAY;
                        }
                    }
                    DECAY => {
                        a = sus + (a - sus) * if v.ring { self.decay_ring_mul[k] } else { self.decay_mul[k] };
                        if a - sus < 1e-4 {
                            v.stage[k] = SUSTAIN;
                        }
                    }
                    SUSTAIN => a = sus,
                    RELEASE => {
                        a *= self.release_mul[k];
                        if a < 1e-5 {
                            a = 0.0;
                            v.stage[k] = OFF;
                        }
                    }
                    _ => {}
                }
                if v.stage[k] == SUSTAIN && sus < 1e-5 && a < 1e-5 {
                    a = 0.0;
                    v.stage[k] = OFF;
                }
                v.amp[k] = a;
                mix += (if k == 0 { o1 } else { o2 }) * a;
            }
            if v.fattacking {
                v.fenv += self.fattack_inc;
                if v.fenv >= 1.0 {
                    v.fenv = 1.0;
                    v.fattacking = false;
                }
            } else {
                v.fenv *= if v.ring { self.fdecay_ring_mul } else { self.fdecay_mul };
            }
            let mut out;
            if fx_first {
                v.vel += (v.velocity - v.vel) * vel_k;
                out = mix * 0.5 * v.vel * level;
                if drive > 1.0 {
                    out = tanh(out * drive) * drive_norm * drive_comp;
                }
                if crush {
                    v.crush_phase += c_step;
                    if v.crush_phase >= 1.0 {
                        v.crush_phase -= 1.0;
                        v.held = js::round(out * c_levels) / c_levels;
                    }
                    out = v.held;
                }
                if filtered {
                    let due = v.counter <= 0;
                    v.counter -= 1;
                    if due {
                        v.counter = FILTER_UPDATE;
                        v.filter.setup(self.cutoff * fmod * exp2(self.fenv_amt * 6.0 * v.fenv * v.env_dyn), self.reso, sr);
                    }
                    v.filter.process(out);
                    out = v.filter.low;
                }
            } else {
                let due = v.counter <= 0;
                v.counter -= 1;
                if due {
                    v.counter = FILTER_UPDATE;
                    v.filter.setup(self.cutoff * fmod * exp2(self.fenv_amt * 6.0 * v.fenv * v.env_dyn), self.reso, sr);
                }
                v.filter.process(mix * 0.5);
                v.vel += (v.velocity - v.vel) * vel_k;
                out = v.filter.low * v.vel * level;
                if drive > 1.0 {
                    out = tanh(out * drive) * drive_norm * drive_comp;
                }
            }
            if v.cut_left != 0 {
                if v.cut_left > 0 {
                    out *= 0.5 - 0.5 * cos_turn(0.5 * v.cut_left as f64 / self.cut_len as f64);
                    v.cut_left -= 1;
                    if v.cut_left == 0 {
                        v.cut_left = -1;
                        v.stage = [OFF; 2];
                    }
                } else {
                    out = 0.0;
                }
            }
            js::add_f32(&mut out_l[i], out);
            js::add_f32(&mut out_r[i], out);
        }
    }

    fn update_voice_count(&mut self) {
        self.voice_count = if self.mono { 2 } else { self.poly_limit };
        for v in &mut self.voices[self.voice_count..] {
            v.stage = [OFF; 2];
        }
    }

    fn allocate(&self) -> usize {
        let mut oldest = 0;
        for i in 0..self.voice_count {
            let v = &self.voices[i];
            if !v.sounding() {
                return i;
            }
            if v.age < self.voices[oldest].age {
                oldest = i;
            }
        }
        oldest
    }
}
