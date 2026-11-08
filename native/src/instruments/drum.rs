//! The drum voice, as src/instruments/Drum.ts (the design notes are there): layers TONE
//! (+ the SNARE's SHELL), METAL (+ the HAT's BELL / RATTLE / head morph) and CLICK, the LFO's
//! low-pass, DRIVE, CRUSH, OUT GAIN, and AIR (FX ROUTING: SPACE > FX or FX > SPACE).
//! Allocation-free once built. Kept line for line with the TypeScript so the null tests
//! (native/tools/render, tools/native/null.mjs) find the same samples.

use super::air_room::AirRoom;
use crate::drive_comp::{drive_comp_gain, drive_rise};
use crate::dsp::{crush_levels, crush_step, decay_mul, poly_blep, IdleGate, Noise, Svf};
use crate::js;
use crate::kind::SoundKind;
use crate::math::{exp2, sin_rad, sin_turn, tanh};

/// A REST (or a drum retrigger) fades what it cuts off over this long, s.
pub const CUT_FADE: f64 = 0.003;
/// The note KICK / SNARE / HAT play as designed (A1); PERC is tuned by name from C2.
pub const DRUM_ROOT: f64 = 33.0;
const PERC_ROOT: f64 = 36.0;
const OCTAVE_ZERO: f64 = 4.0;

const BELL_RATIOS: [f64; 8] = [1.0, 1.483, 1.932, 2.546, 2.63, 3.159, 3.799, 4.556];
const BELL_LEVELS: [f64; 8] = [1.0, 0.7, 0.55, 0.5, 0.45, 0.35, 0.3, 0.25];
const BELL_FADES: [f64; 8] = [1.0, 1.2, 1.4, 1.6, 1.6, 2.0, 2.4, 2.8];
const BELL_GAIN: f64 = 0.12;
const FOCUS_SPREAD: f64 = 0.85;
const FOCUS_NOISE: f64 = 0.8;
const FOCUS_BELL: f64 = 0.6;
const SHELL_RATIO: f64 = 1.59;
const WIRE_SPAN: f64 = 3.0;
const WIRE_LP_MIN: f64 = 5000.0;
const WIRE_LP_MAX: f64 = 12000.0;
const TONE_TOP: f64 = 18000.0;
const RATTLE_HITS: i32 = 4;
const RATTLE_GAP: f64 = 0.011;
const RATTLE_PULSE: f64 = 0.004;
const RATTLE_RELEASE: f64 = 0.03;
const METAL_RATIOS: [f64; 6] = [1.0, 1.4471, 1.617, 1.9265, 2.5028, 2.6637];
const TWO_PI: f64 = std::f64::consts::PI * 2.0;
const RING_STRETCH: f64 = 2.0;
const CHOKE_SECONDS: f64 = 0.012;
const FILTER_UPDATE: i32 = 16;
const AIR_GAIN: f64 = 0.8;
const AIR_SMOOTH: f64 = 0.02;
const AIR_IDLE_SECONDS: f64 = 4.0;
pub const AIR_CHUNK: usize = 128;

#[derive(Copy, Clone, PartialEq, Eq)]
enum Stage {
    Off,
    Attacking,
    Decaying,
}

/// Per type voice settings (Drum.ts DrumVoice).
struct Voice {
    balance: (&'static str, &'static str),
    ring_extra: f64,
    relative: bool,
    rise: Option<&'static [f64; 12]>,
    air: Option<(f64, f64, f64, bool)>,
    hat: bool,
    snare: bool,
}

fn voice(kind: SoundKind) -> Voice {
    let base = Voice { balance: ("t", "c"), ring_extra: 0.6, relative: false, rise: Some(drive_rise(kind)), air: None, hat: false, snare: false };
    match kind {
        SoundKind::Kick => Voice { air: Some((300.0, 1400.0, 3.45, false)), ..base },
        SoundKind::Snare => Voice { balance: ("t", "m"), snare: true, air: Some((600.0, 5000.0, 2.0, false)), ..base },
        SoundKind::Hat => Voice { balance: ("c", "m"), hat: true, air: Some((3000.0, 14000.0, 1.0, true)), ..base },
        SoundKind::Perc => Voice { balance: ("t", "cm"), relative: true, ..base },
        _ => panic!("not a drum"),
    }
}

/// Every drum parameter with its default, in Drum.ts ALL's order (the constructor sets them
/// all, in this order, before the type's own).
const ALL: [(&str, f64); 47] = [
    ("timbre", 0.33), ("intensity", 0.5), ("t_level", 0.0), ("t_pitch", 50.0), ("t_sweep", 24.0), ("t_stime", 0.04),
    ("t_attack", 0.0005), ("t_decay", 0.45), ("t_wave", 0.0), ("c_level", 0.0), ("c_tone", 4000.0), ("c_attack", 0.0005),
    ("c_len", 0.004), ("c_reso", 0.3), ("c_noise", 0.6), ("m_level", 0.0), ("m_pitch", 400.0), ("m_spread", 1.0),
    ("m_noise", 0.3), ("m_tone", 6000.0), ("m_attack", 0.0005), ("m_decay", 0.2), ("m_mode", 0.0), ("m_fm", 0.5),
    ("m_bell", 0.0), ("h_rattle", 0.0), ("h_time", 0.0), ("h_pitch", 420.0), ("t_shell", 0.0), ("m_pref", 420.0),
    ("h_focus", 0.0), ("h_tone", 8500.0), ("h_noise", 0.3), ("h_mode", 0.0), ("h_spread", 1.0), ("m_interval", 12.0),
    ("detune", 0.0), ("balance", 0.5), ("drive", 1.0), ("crush", 0.0), ("ogain", 1.0), ("rolldiv", 3.0), ("air", 0.0),
    ("airsize", 0.4), ("hairsize", 0.6), ("midfreq", 1000.0), ("octave", 4.0),
];

const WHOLE: [&str; 7] = ["balance", "drive", "crush", "ogain", "rolldiv", "midfreq", "octave"];

/// Each type's parameters (knob order) and their own defaults (Drum.ts KICK_PARAMS ...).
pub fn type_params(kind: SoundKind) -> Vec<(&'static str, f64)> {
    let (ids, own): (Vec<&'static str>, &[(&str, f64)]) = match kind {
        SoundKind::Kick => (
            [&["timbre", "intensity", "t_level", "t_pitch", "t_sweep", "t_stime", "t_attack", "t_decay", "t_wave", "c_level", "c_tone", "c_attack", "c_len", "c_reso", "c_noise"][..], &WHOLE, &["air", "airsize"]].concat(),
            &[("t_level", 0.95), ("t_pitch", 48.0), ("t_sweep", 30.0), ("t_stime", 0.035), ("t_decay", 0.5), ("c_level", 0.25), ("c_tone", 3500.0), ("c_len", 0.003), ("midfreq", 350.0)],
        ),
        SoundKind::Snare => (
            [&["timbre", "intensity", "t_level", "t_pitch", "t_sweep", "t_stime", "t_attack", "t_decay", "t_wave", "t_shell", "c_level", "c_tone", "c_attack", "c_len", "c_reso", "c_noise", "m_level", "m_pitch", "m_noise", "m_tone", "m_attack", "m_decay", "m_spread", "m_mode", "m_fm"][..], &WHOLE, &["air", "airsize"]].concat(),
            &[("t_level", 0.55), ("t_pitch", 190.0), ("t_sweep", 7.0), ("t_decay", 0.14), ("m_level", 0.8), ("m_noise", 0.85), ("m_pitch", 330.0), ("m_tone", 1800.0), ("m_decay", 0.2), ("midfreq", 500.0)],
        ),
        SoundKind::Hat => (
            [&["timbre", "intensity", "c_level", "c_tone", "c_attack", "c_len", "c_reso", "c_noise", "m_level", "m_pitch", "m_spread", "m_noise", "m_tone", "m_attack", "m_decay", "m_mode", "m_fm", "h_time", "h_pitch", "h_tone", "h_noise", "h_mode", "h_spread", "m_bell", "h_rattle", "m_pref", "h_focus"][..], &WHOLE, &["air", "hairsize"]].concat(),
            &[("c_level", 0.2), ("c_tone", 9000.0), ("c_len", 0.002), ("m_level", 0.6), ("m_pitch", 420.0), ("m_spread", 1.0), ("m_noise", 0.3), ("m_tone", 8500.0), ("m_decay", 0.1), ("h_time", 0.03), ("midfreq", 2000.0)],
        ),
        SoundKind::Perc => (
            [&["timbre", "intensity", "t_level", "t_pitch", "t_sweep", "t_stime", "t_attack", "t_decay", "t_wave", "c_level", "c_tone", "c_attack", "c_len", "c_reso", "c_noise", "m_level", "m_interval", "detune", "m_spread", "m_noise", "m_tone", "m_mode", "m_fm"][..], &WHOLE].concat(),
            &[("t_level", 0.95), ("t_pitch", 95.0), ("t_sweep", 9.0), ("t_stime", 0.08), ("t_decay", 0.3), ("c_level", 0.3), ("c_tone", 2200.0), ("c_len", 0.004), ("midfreq", 450.0)],
        ),
        _ => panic!("not a drum"),
    };
    ids.into_iter()
        .map(|id| {
            let d = own.iter().find(|(o, _)| *o == id).map(|p| p.1).unwrap_or_else(|| ALL.iter().find(|(a, _)| *a == id).unwrap().1);
            (id, d)
        })
        .collect()
}

fn attack_inc(seconds: f64, sr: f64) -> f64 {
    if seconds <= 0.0006 { 0.0 } else { 1.0 / (seconds * sr) }
}

#[inline]
fn blep_square(p: f64, dt: f64) -> f64 {
    if dt >= 0.5 {
        return if p < 0.5 { 1.0 } else { -1.0 };
    }
    let mut p2 = p + 0.5;
    if p2 >= 1.0 {
        p2 -= 1.0;
    }
    (if p < 0.5 { 1.0 } else { -1.0 }) + poly_blep(p, dt) - poly_blep(p2, dt)
}

#[inline]
fn sq(p: f64) -> f64 {
    if p < 0.5 { 1.0 } else { -1.0 }
}

pub struct Drum {
    sr: f64,
    voice: Voice,
    noise: Noise,
    m_filter: Svf,
    c_filter: Svf,
    filter: Svf,
    t_level: f64, t_pitch: f64, t_sweep: f64, t_wave: i32,
    c_level: f64, c_tone: f64, c_reso: f64, c_noise: f64,
    drive: f64, crush: f64, drive_comp: f64,
    m_level: f64, m_pitch: f64, m_spread: f64, m_noise: f64, m_mode: f64, m_fm: f64,
    fm_c: f64, fm_m: f64,
    m_bell: f64, m_pref: f64, focus: f64, bell_eff: f64, tone_at: f64,
    t_shell: f64, shell_phase: f64,
    wire_lp: Svf,
    m_inc: [f64; 6],
    b_phase: [f64; 8], b_env: [f64; 8], b_mul: [f64; 8],
    rattle: f64, r_left: i32, r_next: f64, r_pulse: f64, r_depth: f64,
    r_gap: f64, r_pulse_mul: f64, r_release: f64,
    t_decay_mul: f64, sweep_mul: f64, m_decay_mul: f64, c_decay_mul: f64,
    t_ring_mul: f64, m_ring_mul: f64, c_ring_mul: f64,
    t_decay: f64, m_decay: f64, c_len: f64,
    g_t: f64, g_c: f64, g_m: f64,
    interval_mul: f64, detune_mul: f64,
    h_time: f64, h_mul: f64, h_pitch: f64, h_tone: f64, h_noise: f64, h_mode: f64, h_spread: f64, m_tone: f64,
    h_env: f64, h_counter: i32,
    t_atk: f64, c_atk: f64, m_atk: f64,
    t_atk_s: f64, c_atk_s: f64,
    filter_on: bool, filter_mod: f64,
    choke_mul: f64,
    sweep_top: f64,
    room: Option<AirRoom>,
    air_mono: [f32; AIR_CHUNK],
    air_target: f64, air_gain: f64, air_idle: bool,
    air_gate: IdleGate,
    air_k: f64,
    t_mul: f64, m_mul: f64, c_mul: f64,
    ringing: bool,
    ring_scale: f64,
    tune: f64,
    octave: f64,
    pitch_mod: f64,
    t_phase: f64, sweep_env: f64, sweep_flat: bool,
    m_phase: [f64; 6],
    t_env: f64, t_stage: Stage,
    m_env: f64, m_stage: Stage,
    c_env: f64, c_stage: Stage,
    impulse: bool,
    f_counter: i32,
    velocity: f64,
    crush_phase: f64, held: f64,
    space_first: bool,
    post_phase: f64, post_held: f64,
    dry: [f32; AIR_CHUNK],
    last_out: f64,
    o_gain: f64,
    fade_from: f64,
    fade_left: i32,
    fade_len: i32,
}

impl Drum {
    pub fn new(sample_rate: f64, kind: SoundKind) -> Self {
        let voice = voice(kind);
        let sr = sample_rate;
        let room = voice.air.map(|(hp, lp, _, natural)| AirRoom::new(sr, hp, lp, natural));
        let mut d = Drum {
            sr,
            noise: Noise::new(0x5eed),
            m_filter: Svf::default(),
            c_filter: Svf::default(),
            filter: Svf::default(),
            t_level: 0.0, t_pitch: 50.0, t_sweep: 24.0, t_wave: 0,
            c_level: 0.0, c_tone: 4000.0, c_reso: 0.3, c_noise: 0.6,
            drive: 1.0, crush: 0.0, drive_comp: 1.0,
            m_level: 0.0, m_pitch: 400.0, m_spread: 1.0, m_noise: 0.3, m_mode: 0.0, m_fm: 0.5,
            fm_c: 0.0, fm_m: 0.0,
            m_bell: 0.0, m_pref: 0.0, focus: 0.0, bell_eff: 0.0, tone_at: 1.0,
            t_shell: 0.0, shell_phase: 0.0,
            wire_lp: Svf::default(),
            m_inc: [0.0; 6],
            b_phase: [0.0; 8], b_env: [0.0; 8], b_mul: [0.0; 8],
            rattle: 0.0, r_left: 0, r_next: 0.0, r_pulse: 0.0, r_depth: 0.0,
            r_gap: RATTLE_GAP * sr,
            r_pulse_mul: (-1.0 / (RATTLE_PULSE * sr)).exp(),
            r_release: (-1.0 / (RATTLE_RELEASE * sr)).exp(),
            t_decay_mul: 0.0, sweep_mul: 0.0, m_decay_mul: 0.0, c_decay_mul: 0.0,
            t_ring_mul: 0.0, m_ring_mul: 0.0, c_ring_mul: 0.0,
            t_decay: 0.45, m_decay: 0.2, c_len: 0.004,
            g_t: 1.0, g_c: 1.0, g_m: 1.0,
            interval_mul: 2.0, detune_mul: 1.0,
            h_time: 0.0, h_mul: 0.0, h_pitch: 420.0, h_tone: 8500.0, h_noise: 0.3, h_mode: 0.0, h_spread: 1.0, m_tone: 6000.0,
            h_env: 0.0, h_counter: 0,
            t_atk: 0.0, c_atk: 0.0, m_atk: 0.0,
            t_atk_s: 0.0005, c_atk_s: 0.0005,
            filter_on: false, filter_mod: 0.0,
            choke_mul: decay_mul(CHOKE_SECONDS, sr),
            sweep_top: 18000f64.min(0.4 * sr),
            room,
            air_mono: [0.0; AIR_CHUNK],
            air_target: 0.0, air_gain: 0.0, air_idle: true,
            air_gate: IdleGate::new(AIR_IDLE_SECONDS, sr),
            air_k: 1.0 - (-1.0 / (AIR_SMOOTH * sr)).exp(),
            t_mul: 0.0, m_mul: 0.0, c_mul: 0.0,
            ringing: false,
            ring_scale: 1.0,
            tune: 1.0,
            octave: 0.0,
            pitch_mod: 1.0,
            t_phase: 0.0, sweep_env: 0.0, sweep_flat: false,
            m_phase: [0.0; 6],
            t_env: 0.0, t_stage: Stage::Off,
            m_env: 0.0, m_stage: Stage::Off,
            c_env: 0.0, c_stage: Stage::Off,
            impulse: false,
            f_counter: 0,
            velocity: 1.0,
            crush_phase: 1.0, held: 0.0,
            space_first: false,
            post_phase: 1.0, post_held: 0.0,
            dry: [0.0; AIR_CHUNK],
            last_out: 0.0,
            o_gain: 1.0,
            fade_from: 0.0,
            fade_left: 0,
            fade_len: (js::round(CUT_FADE * sr) as i32).max(1),
            voice,
        };
        if d.voice.snare {
            d.wire_lp.setup(WIRE_LP_MAX, 0.1, sr);
        }
        for (id, v) in ALL {
            d.set_param(id, v);
        }
        d.t_level = 0.0;
        d.c_level = 0.0;
        d.m_level = 0.0;
        for (id, v) in type_params(kind) {
            d.set_param(id, v);
        }
        d
    }

    fn update_focus(&mut self) {
        self.bell_eff = self.m_bell + (FOCUS_BELL - self.m_bell).max(0.0) * self.focus;
    }

    pub fn note_on(&mut self, note: f64, velocity: f64, ring: bool) {
        let sounding = self.t_stage != Stage::Off || self.m_stage != Stage::Off || self.c_stage != Stage::Off;
        self.fade_from = if sounding { self.last_out } else { 0.0 };
        self.fade_left = if sounding { self.fade_len } else { 0 };
        self.ringing = ring;
        self.t_mul = if ring { self.t_ring_mul } else { self.t_decay_mul };
        self.m_mul = if ring { self.m_ring_mul } else { self.m_decay_mul };
        self.c_mul = if ring { self.c_ring_mul } else { self.c_decay_mul };
        let root = if self.voice.relative { PERC_ROOT } else { DRUM_ROOT };
        self.tune = 2f64.powf((note - root) / 12.0 + self.octave);
        if self.voice.relative {
            self.setup_click();
        }
        self.velocity = velocity;
        self.t_phase = 0.0;
        self.shell_phase = 0.0;
        self.sweep_env = 1.0;
        self.sweep_flat = false;
        self.impulse = true;
        let start = |inc: f64| if inc > 0.0 { (0.0, Stage::Attacking) } else { (1.0, Stage::Decaying) };
        (self.t_env, self.t_stage) = start(self.t_atk);
        (self.m_env, self.m_stage) = start(self.m_atk);
        (self.c_env, self.c_stage) = start(self.c_atk);
        self.f_counter = 0;
        self.h_env = if self.h_time > 0.0 { 1.0 } else { 0.0 };
        self.h_counter = 0;
        if self.bell_eff > 0.0 {
            for k in 0..8 {
                self.b_phase[k] = 0.0;
                self.b_env[k] = 1.0;
                self.b_mul[k] = self.m_mul.powf(BELL_FADES[k] - 1.0);
            }
        }
        self.r_depth = if self.rattle > 0.0 { 1.0 } else { 0.0 };
        self.r_left = RATTLE_HITS;
        self.r_next = js::round(self.r_gap);
        self.r_pulse = 1.0;
        if let Some(room) = &mut self.room {
            room.trigger();
        }
    }

    /// Only a ringing hit responds: it is choked.
    pub fn note_off(&mut self) {
        if !self.ringing {
            return;
        }
        self.ringing = false;
        self.t_mul = self.choke_mul;
        self.m_mul = self.choke_mul;
        self.c_mul = self.choke_mul;
        for s in [&mut self.t_stage, &mut self.m_stage, &mut self.c_stage] {
            if *s == Stage::Attacking {
                *s = Stage::Decaying;
            }
        }
    }

    pub fn set_pitch_mod(&mut self, semitones: f64) {
        self.pitch_mod = if semitones == 0.0 { 1.0 } else { 2f64.powf(semitones / 12.0) };
    }

    pub fn set_filter_mod(&mut self, octaves: f64) {
        self.filter_mod = octaves;
        self.filter_on = octaves != 0.0;
        self.f_counter = 0;
    }

    pub fn set_param(&mut self, id: &str, v: f64) {
        let sr = self.sr;
        match id {
            "t_level" => self.t_level = v,
            "t_pitch" => { self.t_pitch = v; self.update_metal(); }
            "t_sweep" => { self.t_sweep = v; self.sweep_flat = false; }
            "t_stime" => self.sweep_mul = decay_mul(v, sr),
            "t_attack" => { self.t_atk_s = v; self.t_atk = attack_inc(v, sr); self.update_metal_env(); }
            "t_decay" => { self.t_decay = v; self.update_metal_env(); self.update_decays(); }
            "t_wave" => self.t_wave = js::round(v) as i32,
            "c_level" => self.c_level = v,
            "c_tone" => { self.c_tone = v; self.setup_click(); }
            "c_reso" => { self.c_reso = v; self.setup_click(); }
            "c_noise" => self.c_noise = v,
            "c_attack" => { self.c_atk_s = v; self.c_atk = attack_inc(v, sr); self.update_metal_env(); }
            "c_len" => { self.c_len = v; self.update_metal_env(); self.update_decays(); }
            "m_level" => self.m_level = v,
            "m_pitch" => if !self.voice.relative { self.m_pitch = v; self.tone_at = f64::NAN; },
            "m_interval" => { self.interval_mul = 2f64.powf(js::round(v) / 12.0); self.update_metal(); }
            "detune" => { self.detune_mul = 2f64.powf(v / 12.0); self.update_metal(); self.setup_click(); }
            "m_spread" => self.m_spread = v,
            "m_noise" => self.m_noise = v,
            "m_tone" => {
                self.m_tone = v;
                self.m_filter.setup(v, 0.3, sr);
                self.tone_at = f64::NAN;
                if self.voice.snare {
                    self.wire_lp.setup(WIRE_LP_MAX.min(WIRE_LP_MIN.max(v * WIRE_SPAN)), 0.1, sr);
                }
            }
            "t_shell" => self.t_shell = v,
            "m_attack" => if !self.voice.relative { self.m_atk = attack_inc(v, sr); },
            "m_decay" => if !self.voice.relative { self.m_decay = v; self.update_decays(); },
            "m_bell" => { self.m_bell = v; self.update_focus(); }
            "m_pref" => { self.m_pref = v; self.tone_at = f64::NAN; }
            "h_focus" => { self.focus = v; self.update_focus(); }
            "h_rattle" => self.rattle = v,
            "h_time" => { self.h_time = v; self.h_mul = if v > 0.0 { (-1.0 / (v * sr)).exp() } else { 0.0 }; }
            "h_pitch" => self.h_pitch = v,
            "h_tone" => self.h_tone = v,
            "h_noise" => self.h_noise = v,
            "h_mode" => self.h_mode = v,
            "h_spread" => self.h_spread = v,
            "m_mode" => self.m_mode = v.clamp(0.0, 2.0),
            "m_fm" => self.m_fm = v,
            "balance" => {
                let g1 = (2.0 * (1.0 - v)).min(1.0);
                let g2 = (2.0 * v).min(1.0);
                let (l1, l2) = self.voice.balance;
                let gain = |layer: &str| if l1.contains(layer) { g1 } else if l2.contains(layer) { g2 } else { 1.0 };
                self.g_t = gain("t");
                self.g_c = gain("c");
                self.g_m = gain("m");
            }
            "drive" => { self.drive = v; self.drive_comp = self.voice.rise.map_or(1.0, |r| drive_comp_gain(r, v)); }
            "crush" => self.crush = v,
            "ogain" => self.o_gain = v,
            "air" => self.air_target = v * v * AIR_GAIN * self.voice.air.map_or(0.0, |a| a.2),
            "airsize" | "hairsize" => if let Some(room) = &mut self.room { room.set_tail(v); },
            "octave" => self.octave = js::round(v) - OCTAVE_ZERO,
            _ => {}
        }
    }

    fn update_metal_env(&mut self) {
        if !self.voice.relative {
            return;
        }
        self.m_atk = attack_inc((self.t_atk_s + self.c_atk_s) / 2.0, self.sr);
        self.m_decay = (self.t_decay + self.c_len) / 2.0;
    }

    fn update_metal(&mut self) {
        if self.voice.relative {
            self.m_pitch = self.t_pitch * self.interval_mul * self.detune_mul;
        }
    }

    fn setup_click(&mut self) {
        let f = if self.voice.relative { self.c_tone * self.tune * self.detune_mul } else { self.c_tone };
        self.c_filter.setup(f, self.c_reso, self.sr);
    }

    pub fn set_ring_length(&mut self, scale: f64) {
        if scale == self.ring_scale {
            return;
        }
        self.ring_scale = scale;
        self.update_decays();
    }

    fn update_decays(&mut self) {
        let sr = self.sr;
        let extra = self.voice.ring_extra;
        let k = self.ring_scale;
        self.t_decay_mul = decay_mul(self.t_decay, sr);
        self.m_decay_mul = decay_mul(self.m_decay, sr);
        self.c_decay_mul = decay_mul(self.c_len, sr);
        self.t_ring_mul = decay_mul((self.t_decay * RING_STRETCH + extra) * k, sr);
        self.m_ring_mul = decay_mul((self.m_decay * RING_STRETCH + extra) * k, sr);
        self.c_ring_mul = decay_mul(self.c_len * RING_STRETCH * k, sr);
    }

    /// AIR on the track's output (in place), unless SPACE > FX ran it in render.
    pub fn post(&mut self, l: &mut [f32], r: &mut [f32]) {
        if !self.space_first {
            self.air(l, r);
        }
    }

    /// FX ROUTING: 0 = SPACE > FX, 1 = FX > SPACE.
    pub fn set_chain(&mut self, order: f64) {
        let first = self.room.is_some() && js::round(order) == 0.0;
        if first == self.space_first {
            return;
        }
        self.space_first = first;
        self.post_phase = 1.0;
        self.post_held = 0.0;
    }

    /// SPACE > FX: DRIVE then CRUSH on the chunk (OUT GAIN taken out and put back), added in.
    fn fx_into(&mut self, m: usize, out_l: &mut [f32], out_r: &mut [f32], off: usize) {
        let og = self.o_gain;
        let (drive, crush) = (self.drive > 1.0, self.crush > 0.0);
        if og <= 0.0 || (!drive && !crush) {
            for i in 0..m {
                js::add_f32(&mut out_l[off + i], self.dry[i] as f64);
                js::add_f32(&mut out_r[off + i], self.dry[i] as f64);
            }
            return;
        }
        let any = self.post_held != 0.0 || self.dry[..m].iter().any(|&x| x != 0.0);
        if !any {
            return;
        }
        let drive_norm = if drive { 1.0 / self.drive.min(3.0).tanh() } else { 1.0 };
        let k = 0.8 * self.drive_comp * drive_norm;
        let (step, levels) = (crush_step(self.crush), crush_levels(self.crush));
        let inv = 1.0 / og;
        for i in 0..m {
            let mut x = self.dry[i] as f64 * inv;
            if drive {
                x = tanh(x * self.drive) * k;
            }
            if crush {
                self.post_phase += step;
                if self.post_phase >= 1.0 {
                    self.post_phase -= 1.0;
                    self.post_held = js::round(x * levels) / levels;
                }
                x = self.post_held;
            }
            let y = x * og;
            js::add_f32(&mut out_l[off + i], y);
            js::add_f32(&mut out_r[off + i], y);
        }
    }

    /// The idle / off checks AIR makes before running: false = skip it.
    fn air_wanted(&mut self) -> bool {
        let Some(room) = &mut self.room else { return false };
        if self.air_target == 0.0 && self.air_gain < 1e-5 {
            if !self.air_idle {
                room.reset();
                self.air_gain = 0.0;
                self.air_idle = true;
            }
            return false;
        }
        self.air_idle = false;
        true
    }

    /// SPACE > FX: AIR on the mono chunk in `dry`, in place.
    fn air_on(&mut self, m: usize) {
        if !self.air_wanted() {
            return;
        }
        let d = &mut self.dry[..m];
        if self.air_gate.skip(d, d) {
            return;
        }
        let mono = &mut self.air_mono[..m];
        mono.copy_from_slice(d);
        self.room.as_mut().unwrap().process(mono);
        for i in 0..m {
            self.air_gain += (self.air_target - self.air_gain) * self.air_k;
            js::add_f32(&mut d[i], mono[i] as f64 * self.air_gain);
        }
        self.air_gate.done(d, d);
    }

    /// AIR: the room on the hit (in place).
    fn air(&mut self, l: &mut [f32], r: &mut [f32]) {
        if !self.air_wanted() {
            return;
        }
        if self.air_gate.skip(l, r) {
            return;
        }
        let n = l.len();
        let mut off = 0;
        while off < n {
            let m = AIR_CHUNK.min(n - off);
            for i in 0..m {
                self.air_mono[i] = ((l[off + i] as f64 + r[off + i] as f64) * 0.5) as f32;
            }
            self.room.as_mut().unwrap().process(&mut self.air_mono[..m]);
            for i in 0..m {
                self.air_gain += (self.air_target - self.air_gain) * self.air_k;
                let w = self.air_mono[i] as f64 * self.air_gain;
                js::add_f32(&mut l[off + i], w);
                js::add_f32(&mut r[off + i], w);
            }
            off += AIR_CHUNK;
        }
        self.air_gate.done(l, r);
    }

    /// REST: everything stops over the retrigger fade.
    pub fn cut(&mut self) {
        if self.t_stage == Stage::Off && self.m_stage == Stage::Off && self.c_stage == Stage::Off {
            return;
        }
        self.fade_from = self.last_out;
        self.fade_left = self.fade_len;
        self.t_stage = Stage::Off;
        self.m_stage = Stage::Off;
        self.c_stage = Stage::Off;
        self.t_env = 0.0;
        self.m_env = 0.0;
        self.c_env = 0.0;
        self.ringing = false;
    }

    /// ADD frames [start, end) into out_l / out_r.
    pub fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32], start: usize, end: usize) {
        if !self.space_first {
            self.hit(out_l, Some(out_r), start, end, true);
            return;
        }
        let mut off = start;
        while off < end {
            let m = AIR_CHUNK.min(end - off);
            let mut d = std::mem::replace(&mut self.dry, [0.0; AIR_CHUNK]);
            d[..m].fill(0.0);
            self.hit(&mut d, None, 0, m, false);
            self.dry = d;
            self.air_on(m);
            self.fx_into(m, out_l, out_r, off);
            off += AIR_CHUNK;
        }
    }

    /// The hit, added into out_l (and out_r when given) at OUT GAIN; `fx` = DRIVE / CRUSH here.
    fn hit(&mut self, out_l: &mut [f32], mut out_r: Option<&mut [f32]>, start: usize, end: usize, fx: bool) {
        if self.t_stage == Stage::Off && self.m_stage == Stage::Off && self.c_stage == Stage::Off && self.fade_left == 0 {
            self.last_out = 0.0;
            return;
        }
        let dt_base = 1.0 / self.sr;
        let step = crush_step(self.crush);
        let levels = crush_levels(self.crush);
        let drive_norm = if self.drive > 1.0 { 1.0 / self.drive.min(3.0).tanh() } else { 1.0 };
        let t_pitch = self.t_pitch * self.tune * self.pitch_mod;
        let tune = self.tune * self.pitch_mod;
        let track = self.voice.hat && self.m_pref > 0.0;
        let pr = if track { self.m_pitch / self.m_pref } else { 1.0 };
        let tone_r = if track { pr * tune } else { 1.0 };
        let head_pitch = self.h_pitch * pr;
        let f_spread = 1.0 - FOCUS_SPREAD * self.focus;
        let f_noise = 1.0 - FOCUS_NOISE * self.focus;
        let mut m_pitch = self.m_pitch * tune;
        let mut m_noise = self.m_noise * f_noise;
        let mut m_mode = self.m_mode;
        let mut m_spread = self.m_spread * f_spread;
        if track && self.h_env == 0.0 && tone_r != self.tone_at {
            self.tone_at = tone_r;
            self.m_filter.setup(TONE_TOP.min(self.m_tone * tone_r), 0.3, self.sr);
        }
        self.h_counter = 0;

        for i in start..end {
            let mut sum = 0.0;

            // TONE
            if self.t_stage != Stage::Off {
                let mut sweep = 1.0;
                if !self.sweep_flat {
                    sweep = exp2(self.t_sweep * self.sweep_env / 12.0);
                    if sweep == 1.0 {
                        self.sweep_flat = true;
                    }
                }
                let f = (t_pitch * sweep).min(self.sweep_top);
                let dt = f * dt_base;
                self.t_phase += dt;
                if self.t_phase >= 1.0 {
                    self.t_phase -= 1.0;
                }
                let ph = self.t_phase;
                let osc = match self.t_wave {
                    1 => 4.0 * (ph - 0.5).abs() - 1.0,
                    2 => 2.0 * ph - 1.0 - poly_blep(ph, dt),
                    3 => {
                        let mut p2 = ph + 0.5;
                        if p2 >= 1.0 {
                            p2 -= 1.0;
                        }
                        sq(ph) + poly_blep(ph, dt) - poly_blep(p2, dt)
                    }
                    _ => sin_turn(ph),
                };
                sum += osc * self.t_env * self.t_level * self.g_t;
                if self.t_shell > 0.0 {
                    self.shell_phase += dt * SHELL_RATIO;
                    if self.shell_phase >= 1.0 {
                        self.shell_phase -= 1.0;
                    }
                    sum += sin_turn(self.shell_phase) * self.t_env * self.t_env * self.t_shell * self.t_level * self.g_t;
                }
                self.sweep_env *= self.sweep_mul;
                if self.t_stage == Stage::Attacking {
                    self.t_env += self.t_atk;
                    if self.t_env >= 1.0 {
                        self.t_env = 1.0;
                        self.t_stage = Stage::Decaying;
                    }
                } else {
                    self.t_env *= self.t_mul;
                    if self.t_env < 1e-5 {
                        self.t_env = 0.0;
                        self.t_stage = Stage::Off;
                    }
                }
            }

            // METAL
            if self.m_stage != Stage::Off {
                if self.h_env > 0.0 {
                    self.h_env *= self.h_mul;
                    if self.h_env < 1e-3 {
                        self.h_env = 0.0;
                        m_pitch = self.m_pitch * tune;
                        m_noise = self.m_noise * f_noise;
                        m_mode = self.m_mode;
                        m_spread = self.m_spread * f_spread;
                        self.m_filter.setup(TONE_TOP.min(self.m_tone * tone_r), 0.3, self.sr);
                        self.tone_at = tone_r;
                    } else {
                        let due = self.h_counter <= 0;
                        self.h_counter -= 1;
                        if due {
                            self.h_counter = FILTER_UPDATE;
                            let h = self.h_env;
                            m_pitch = self.m_pitch * (head_pitch / self.m_pitch).powf(h) * tune;
                            m_noise = (self.m_noise + (self.h_noise - self.m_noise) * h) * f_noise;
                            m_mode = self.m_mode + (self.h_mode - self.m_mode) * h;
                            m_spread = (self.m_spread + (self.h_spread - self.m_spread) * h) * f_spread;
                            self.m_filter.setup(TONE_TOP.min(self.m_tone * tone_r * (self.h_tone / self.m_tone).powf(h)), 0.3, self.sr);
                        }
                    }
                }
                let spread = m_spread * 2.0;
                let mode = m_mode;
                let w_sq = (1.0 - mode).max(0.0);
                let w_ring = (1.0 - (mode - 1.0).abs()).max(0.0);
                let w_fm = (mode - 1.0).max(0.0);
                let mut m = 0.0;
                if w_sq > 0.0 || w_ring > 0.0 {
                    for k in 0..6 {
                        self.m_inc[k] = m_pitch * (1.0 + (METAL_RATIOS[k] - 1.0) * spread) * dt_base;
                        self.m_phase[k] += self.m_inc[k];
                        if self.m_phase[k] >= 1.0 {
                            self.m_phase[k] -= 1.0;
                        }
                    }
                    let (ph, inc) = (&self.m_phase, &self.m_inc);
                    let s: [f64; 6] = if self.voice.hat {
                        std::array::from_fn(|k| blep_square(ph[k], inc[k]))
                    } else {
                        std::array::from_fn(|k| sq(ph[k]))
                    };
                    if w_sq > 0.0 {
                        m += w_sq * (s[0] + s[1] + s[2] + s[3] + s[4] + s[5]) / 6.0;
                    }
                    if w_ring > 0.0 {
                        m += w_ring * (s[0] * s[1] + s[2] * s[3] + s[4] * s[5]) / 3.0;
                    }
                }
                if w_fm > 0.0 {
                    self.fm_c += m_pitch * dt_base;
                    if self.fm_c >= 1.0 {
                        self.fm_c -= 1.0;
                    }
                    self.fm_m += m_pitch * (1.0 + (METAL_RATIOS[3] - 1.0) * spread) * dt_base;
                    if self.fm_m >= 1.0 {
                        self.fm_m -= 1.0;
                    }
                    let index = (0.5 + 9.0 * self.m_fm) * (0.3 + 0.7 * self.m_env);
                    m += w_fm * sin_rad(TWO_PI * self.fm_c + index * sin_turn(self.fm_m));
                }
                m = m * (1.0 - m_noise) + self.noise.next() * m_noise;
                self.m_filter.process(m);
                let mut metal = if self.voice.snare {
                    self.wire_lp.process(self.m_filter.high);
                    self.wire_lp.low * self.m_level
                } else {
                    self.m_filter.high * self.m_level
                };
                if self.bell_eff > 0.0 {
                    let mut b = 0.0;
                    for k in 0..8 {
                        self.b_phase[k] += m_pitch * BELL_RATIOS[k] * dt_base;
                        if self.b_phase[k] >= 1.0 {
                            self.b_phase[k] -= 1.0;
                        }
                        b += sin_turn(self.b_phase[k]) * BELL_LEVELS[k] * self.b_env[k];
                        self.b_env[k] *= self.b_mul[k];
                    }
                    metal += b * self.bell_eff * BELL_GAIN;
                }
                if self.r_depth > 0.0 {
                    self.r_next -= 1.0;
                    if self.r_next <= 0.0 && self.r_left > 0 {
                        self.r_left -= 1;
                        self.r_pulse = 1.0;
                        self.r_next = js::round(self.r_gap * (0.7 + 0.6 * self.noise.next().abs()));
                    }
                    if self.r_left == 0 {
                        self.r_depth *= self.r_release;
                    }
                    metal *= 1.0 - self.rattle * self.r_depth * (1.0 - self.r_pulse);
                    self.r_pulse *= self.r_pulse_mul;
                }
                sum += metal * self.m_env * self.g_m;
                if self.m_stage == Stage::Attacking {
                    self.m_env += self.m_atk;
                    if self.m_env >= 1.0 {
                        self.m_env = 1.0;
                        self.m_stage = Stage::Decaying;
                    }
                } else {
                    self.m_env *= self.m_mul;
                    if self.m_env < 1e-5 {
                        self.m_env = 0.0;
                        self.m_stage = Stage::Off;
                    }
                }
            }

            // CLICK
            if self.c_stage != Stage::Off {
                let kick = if self.impulse { 4.0 * (1.0 - self.c_noise * 0.5) } else { 0.0 };
                self.c_filter.process(self.noise.next() * self.c_noise + kick);
                self.impulse = false;
                sum += self.c_filter.band * self.c_env * self.c_level * 2.0 * self.g_c;
                if self.c_stage == Stage::Attacking {
                    self.c_env += self.c_atk;
                    if self.c_env >= 1.0 {
                        self.c_env = 1.0;
                        self.c_stage = Stage::Decaying;
                    }
                } else {
                    self.c_env *= self.c_mul;
                    if self.c_env < 1e-5 {
                        self.c_env = 0.0;
                        self.c_stage = Stage::Off;
                    }
                }
            }

            // LFO FILTER, DRIVE, CRUSH
            let mut out = sum * self.velocity;
            if self.filter_on {
                let due = self.f_counter <= 0;
                self.f_counter -= 1;
                if due {
                    self.f_counter = FILTER_UPDATE;
                    let fc = 20000.0 * 2f64.powf(self.filter_mod);
                    self.filter.setup(if fc < 20.0 { 20.0 } else { fc }, 0.0, self.sr);
                }
                self.filter.process(out);
                out = self.filter.low;
            }
            if fx && self.drive > 1.0 {
                out = tanh(out * self.drive) * drive_norm * 0.8 * self.drive_comp;
            }
            if fx && self.crush > 0.0 {
                self.crush_phase += step;
                if self.crush_phase >= 1.0 {
                    self.crush_phase -= 1.0;
                    self.held = js::round(out * levels) / levels;
                }
                out = self.held;
            }
            if self.fade_left > 0 {
                out += self.fade_from * (0.5 - 0.5 * (std::f64::consts::PI * self.fade_left as f64 / self.fade_len as f64).cos());
                self.fade_left -= 1;
            }
            self.last_out = out;
            js::add_f32(&mut out_l[i], out * self.o_gain);
            if let Some(r) = out_r.as_deref_mut() {
                js::add_f32(&mut r[i], out * self.o_gain);
            }
        }
    }
}
