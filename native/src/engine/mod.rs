//! The engine: sequencer, instruments, mixer, master, as src/engine/Engine.ts, line for line.
//! Messages arrive as the protocol's plain data (serde_json values, engine/protocol.ts);
//! `process` renders. JavaScript's typed arrays are kept as the same element types (a
//! Float32Array field is an f32 here), so every value rounds as it does there.
//!
//! The code is split by subject: this file holds the state, messages, loading and
//! transport; seq.rs the sequencer; sound.rs patches, glides, automation, mixing and the LFO.

// Clamps stay as min / max chains: Math.min / Math.max order, not clamp's panics.
#![allow(clippy::manual_clamp)]

mod json;
mod seq;
mod sound;
pub mod tables;

use std::collections::HashMap;

use serde_json::Value;

use crate::dsp::{Noise, Svf};
use crate::fx::bus::FxBus;
use crate::fx::limiter::Limiter;
use crate::fx::track_cut::TrackCut;
use crate::instruments::click::Click;
use crate::instruments::drum::Drum;
use crate::instruments::synth::Synth;
use crate::kind::SoundKind;
use crate::params::Spec;
use crate::smoother::Smoother;
use crate::specs;
use json::*;
use tables::*;

const HOLDS: usize = 12;
const CHORD_WINDOW: f64 = 0.08;
pub const CHUNK: usize = 64;
pub const LOCK_SLOTS: usize = 48;
const STEP_SLOTS: usize = NUM_CHANNELS * NUM_PATTERNS * MAX_STEPS;
const PAT_SLOTS: usize = NUM_CHANNELS * NUM_PATTERNS;
const MIN_PATCH_GLIDE: f64 = 0.05;
const SONG_GLIDE_MAX: f64 = 128.0;
const CANCEL_PATCH_GLIDE: f64 = 0.2;
const TONE_SMOOTH: f64 = 0.003;
const NC: usize = NUM_CHANNELS;

fn crossed_cell(pos: i32, prev: f64, cur: f64, total: i32) -> bool {
    let p = (((pos % total) + total) % total) as f64;
    if prev <= cur {
        p > prev && p <= cur
    } else {
        p > prev || p <= cur
    }
}

pub fn hit_tone_cutoff(velocity: f64) -> f64 {
    20000.0 * 2f64.powf(-(1.0 - velocity.max(0.0).min(1.0)) * 3.2)
}

fn slots_per_bar(rate: f64) -> f64 {
    if rate < 1.0 {
        32.0
    } else if rate >= 2.0 {
        8.0
    } else {
        16.0
    }
}

/// JavaScript's ToUint8 / ToUint16 / ToInt16 (what a typed array stores).
fn u8w(x: f64) -> u8 {
    if x.is_finite() { (x.trunc() as i64) as u8 } else { 0 }
}
fn u16w(x: f64) -> u16 {
    if x.is_finite() { (x.trunc() as i64) as u16 } else { 0 }
}
fn i16w(x: f64) -> i16 {
    if x.is_finite() { (x.trunc() as i64) as i16 } else { 0 }
}
fn i8w(x: f64) -> i8 {
    if x.is_finite() { (x.trunc() as i64) as i8 } else { 0 }
}

/// What live recording wrote (Engine.onRecorded): the host sends it on to the UI.
#[derive(Clone, Debug, PartialEq)]
pub enum Recorded {
    Note { channel: usize, pattern: usize, index: usize, note: f64, velocity: f64, accent: bool, gate: f64, slide: bool, start: bool },
    Lock { channel: usize, pattern: usize, index: usize, id: String, value: f64 },
    Chord { channel: usize, pattern: usize, index: usize, note: f64, gate: f64 },
}

/// One automation lane (song or pattern locks), as the TypeScript Lane.
pub(crate) struct Lane {
    key: String,
    kind: AutoKind,
    index: usize,
    id: String,
    pos: Vec<f64>,
    val: Vec<f64>,
    spec: Option<&'static Spec>,
    active: bool,
    last: f64,
    /// The instrument (type) the slot was looked up on.
    inst: Option<SoundKind>,
    slot: i32,
    links: Vec<usize>,
}

/// A track's instrument of one type.
pub(crate) enum Inst {
    Drum(Box<Drum>),
    Synth(Box<Synth>),
}

impl Inst {
    fn new(sr: f64, kind: SoundKind) -> Inst {
        match kind {
            SoundKind::Kick | SoundKind::Snare | SoundKind::Hat | SoundKind::Perc => Inst::Drum(Box::new(Drum::new(sr, kind))),
            _ => Inst::Synth(Box::new(Synth::new(sr, kind))),
        }
    }
    fn set_param(&mut self, id: &str, v: f64) {
        match self {
            Inst::Drum(d) => d.set_param(id, v),
            Inst::Synth(s) => s.set_param(id, v),
        }
    }
    fn note_on(&mut self, note: f64, vel: f64, group: f64, ring: bool, slide_from: f64, slide: bool) {
        match self {
            Inst::Drum(d) => d.note_on(note, vel, ring),
            Inst::Synth(s) => s.note_on(note, vel, group as i32, ring, slide_from as i32, slide),
        }
    }
    fn note_off(&mut self, group: f64) {
        match self {
            Inst::Drum(d) => d.note_off(),
            Inst::Synth(s) => s.note_off(group as i32),
        }
    }
    fn cut(&mut self) {
        match self {
            Inst::Drum(d) => d.cut(),
            Inst::Synth(s) => s.cut(),
        }
    }
    fn set_pitch_mod(&mut self, v: f64) {
        match self {
            Inst::Drum(d) => d.set_pitch_mod(v),
            Inst::Synth(s) => s.set_pitch_mod(v),
        }
    }
    fn set_filter_mod(&mut self, v: f64) {
        match self {
            Inst::Drum(d) => d.set_filter_mod(v),
            Inst::Synth(s) => s.set_filter_mod(v),
        }
    }
    fn set_fm_mod(&mut self, v: f64) {
        if let Inst::Synth(s) = self {
            s.set_fm_mod(v)
        }
    }
    fn set_chain(&mut self, o: f64) {
        match self {
            Inst::Drum(d) => d.set_chain(o),
            Inst::Synth(s) => s.set_chain(o),
        }
    }
    fn set_tempo(&mut self, bpm: f64) {
        if let Inst::Synth(s) = self {
            s.set_tempo(bpm)
        }
    }
    fn duck(&mut self) {
        if let Inst::Synth(s) = self {
            s.duck()
        }
    }
    fn set_ring_length(&mut self, v: f64) {
        if let Inst::Drum(d) = self {
            d.set_ring_length(v)
        }
    }
    fn render(&mut self, l: &mut [f32], r: &mut [f32], n: usize) {
        match self {
            Inst::Drum(d) => d.render(l, r, 0, n),
            Inst::Synth(s) => s.render(l, r, 0, n),
        }
    }
    fn post(&mut self, l: &mut [f32], r: &mut [f32]) {
        match self {
            Inst::Drum(d) => d.post(l, r),
            Inst::Synth(s) => s.post(l, r),
        }
    }
}

fn kind_index(k: SoundKind) -> usize {
    SoundKind::ALL.iter().position(|&x| x == k).unwrap_or(0)
}

pub fn kind_of(id: &str) -> Option<SoundKind> {
    SoundKind::ALL.iter().copied().find(|k| k.id() == id)
}

fn plays_chords(k: Option<SoundKind>) -> bool {
    matches!(k, Some(SoundKind::Pad) | Some(SoundKind::Pluck))
}

fn chain_default(k: Option<SoundKind>) -> f64 {
    match k {
        Some(SoundKind::Kick) | Some(SoundKind::Snare) | Some(SoundKind::Hat) => 0.0,
        _ => 1.0,
    }
}

fn params_of(k: Option<SoundKind>) -> &'static [Spec] {
    match k {
        Some(k) => specs::kind_params(k),
        None => &[],
    }
}

/// slotOf.
fn slot_of(k: Option<SoundKind>, id: &str) -> i32 {
    let p = params_of(k);
    let n = p.len().min(LOCK_SLOTS);
    for (i, s) in p.iter().take(n).enumerate() {
        if s.id == id {
            return i as i32;
        }
    }
    -1
}

fn find_spec(list: &'static [Spec], id: &str) -> Option<&'static Spec> {
    list.iter().find(|s| s.id == id)
}

/// A pending RESET-with-notes swap.
struct PendingNotes {
    length: f64,
    steps: Vec<Value>,
    speed: Option<String>,
}

pub struct Engine {
    pub sample_rate: f64,
    pub playing: bool,
    pub frame: f64,
    pub peak_l: f64,
    pub peak_r: f64,
    pub current_step: [i16; NC],
    pub active_pattern: [u8; NC],
    pub song_row: i32,
    pub song_bar: i32,
    /// Live recording's writes since the host last drained them.
    pub recorded: Vec<Recorded>,

    bpm: f64,
    swing: f64,
    master: Smoother,
    limiter: Limiter,
    lanes: Vec<Lane>,
    row_start: [i32; SONG_MAX_ROWS + 1],
    cell_of: [u8; 16],
    auto_base: HashMap<String, f64>,
    auto_applying: bool,
    auto_snap: bool,
    auto_stale: [u8; NC],
    click: Click,
    click_buf: Vec<f32>,
    clicked: bool,
    click_level: f64,
    click_on: bool,
    count_left: f64,
    count_total: f64,
    lfo_start_clock: f64,
    beat_at: [u8; 16],
    listen_frames: f64,

    step_active: Vec<u8>,
    step_note: Vec<f32>,
    step_vel: Vec<f32>,
    step_accent: Vec<u8>,
    step_ring: Vec<u8>,
    step_rest: Vec<u8>,
    step_slide: Vec<u8>,
    step_gate: Vec<u8>,
    step_extra: Vec<f32>,
    step_extra_n: Vec<u8>,
    step_extra_gate: Vec<i16>,
    step_lock_src: Vec<Option<Vec<(String, f64)>>>,
    pat_lanes: Vec<Vec<Lane>>,
    pat_lanes_dirty: [u8; PAT_SLOTS],
    pat_dirty: bool,
    lane_pat: [i8; NC],
    chan_elapsed: [f64; NC],
    chan_len: [f64; NC],
    song_lane_by_key: HashMap<String, usize>,
    step_flip: Vec<u8>,
    step_on: Vec<u8>,
    pattern_length: [u8; PAT_SLOTS],
    pattern_rate: [f32; PAT_SLOTS],
    chan_at: [f64; NC],
    chan_rate: [f64; NC],
    chan_count: [f64; NC],
    sub_at: [f64; NC],
    sub_len: [f64; NC],
    sub_left: [u8; NC],
    sub_pos: [f64; NC],
    sub_step: [f64; NC],
    loop_start: [u8; NC],
    off_grid: [u8; NC],
    meter: usize,
    bar_len: usize,
    bar_origin: f64,
    pending_meter: i32,

    pending_pattern: [i8; NC],
    land_at: [f64; NC],
    position: [u8; NC],
    skip_step: [i16; NC],
    global_step: f64,
    frames_to_step: f64,
    last_step_frames: f64,

    insts: Vec<Vec<Inst>>,
    current: [Option<SoundKind>; NC],
    base_value: Vec<f32>,
    patch_value: Vec<f32>,
    glide_pattern: [i8; NC],
    glide_from: Vec<f32>,
    glide_to: Vec<f32>,
    glide_done: [f64; NC],
    glide_total: [f64; NC],
    glide_wait: [u8; NC],
    glide_curve: i32,
    fill_pat: [i8; NC],
    fill_at: [f64; NC],
    auto_fill_steps: f64,
    auto_fill_on: [u8; NC],
    held_entry: [u8; NC],
    pending_notes: Vec<Option<PendingNotes>>,
    notes_pending: bool,
    pending_rate: [f64; PAT_SLOTS],
    rate_pending: bool,
    lock_applied: Vec<u8>,
    live_offsets: Vec<Vec<(String, f64)>>,
    offset_norm: Vec<f32>,
    prev_offset: [f32; LOCK_SLOTS],
    volume: Vec<Smoother>,
    pan: Vec<Smoother>,
    tone_l: Vec<Svf>,
    tone_r: Vec<Svf>,
    tone_now: [f32; NC],
    tone_target: [f32; NC],
    volume_value: [f32; NC],
    type_gain: [f32; NC],
    chord: [u8; NC],
    scale_root: [u8; NC],
    notes: [u8; NC],
    chords: Chords,
    hold_note: [i16; NC * HOLDS],
    hold_steps: [i16; NC * HOLDS],
    hold_at: [f64; NC * HOLDS],
    gate_steps: [i16; NC],
    gate_length: [f64; NC],
    gate_at: [f64; NC],
    cuts: Vec<TrackCut>,
    gate_group: [i16; NC],
    ringing: [u8; NC],
    rec_note: [i16; NC],
    rec_frame: [f64; NC],
    rec_start: [f64; NC],
    rec_index: [i16; NC],
    rec_pattern: [i8; NC],
    rec_vel: [f32; NC],
    rec_accent: [u8; NC],
    chord_note: [i16; NC * STEP_NOTES],
    chord_slot: [i32; NC * STEP_NOTES],
    chord_start: [f64; NC * STEP_NOTES],
    rec_slide: [u8; NC],
    sliding: [u8; NC],
    roll_div: [f64; NC],
    hold_roll_count: [u32; NC],
    hit_step: [f64; NC],
    hit_note: [u8; NC],
    muted: [u8; NC],
    edge_on: Vec<u8>,
    edge_glide_start: Vec<i16>,
    edge_glide_end: Vec<i16>,
    edge_fill: Vec<i8>,
    edge_fill_start: Vec<i16>,
    song_cell: f64,
    played_before: [u8; 17],
    song_bars: [u8; SONG_MAX_ROWS],
    song_patterns: Vec<i8>,
    song_keep: Vec<u8>,
    chase_back: [i32; NC],
    song_length: usize,
    song_on: bool,
    song_jump_to: i32,
    song_off: [u8; NC],
    roll_left: [u8; NC],
    roll_at: [f64; NC],
    roll_every: [f64; NC],
    roll_note: [f32; NC],
    roll_vel: [f32; NC],
    roll_vel_end: [f32; NC],
    roll_ramp: [u16; NC],
    roll_index: [u16; NC],
    run_left: [u16; NC],
    tie_left: [u16; NC],
    tie_note: [i16; NC],
    tie_vel: [f64; NC],
    tie_ring: [u8; NC],
    chain_order: [i8; NC],
    hold_roll: [u8; NC],
    hold_roll_note: [f32; NC],
    arp_on: [u8; NC],
    arp_set: [u8; NC],
    arp_mode: [u8; NC],
    arp_steps: [f32; NC],
    arp_oct: [u8; NC],
    arp_held: [u8; NC],
    arp_root: [f32; NC],
    arp_vel: [f32; NC],
    arp_index: [i32; NC],
    arp_at: [f64; NC],
    arp_note: [f32; NC],
    arp_noise: Noise,
    scratch_l: [f32; CHUNK],
    scratch_r: [f32; CHUNK],

    buses: Vec<FxBus>,
    in_drum_bus: [u8; NC],
    route: [i8; NC],
    send_level: Vec<Smoother>,
    dyn_depth: [f32; NC],
    force_ring: [u8; NC],
    force_slide: [u8; NC],
    force_vel: [f32; NC],
    bus_l: [[f32; CHUNK]; NUM_BUSES],
    bus_r: [[f32; CHUNK]; NUM_BUSES],

    lfo_clock: f64,
    lfo_steps: f64,
    lfo_rate: i32,
    lfo_shape: i32,
    lfo_morph: f64,
    lfo_fm: f64,
    lfo_vol: f64,
    lfo_pitch: f64,
    lfo_filter: f64,
    lfo_pan: f64,
    lfo_phase: f64,
    lfo_smooth: f64,
    lfo_fade: f64,
    lfo_retrig: bool,
    lfo_send: f64,
    lfo_spread: f64,
    lfo_buf: [f32; NC * CHUNK],
    lfo_y: [f32; NC],
    lfo_held: [f32; NC],
    lfo_cycle: [f64; NC],
    lfo_trig: [f64; NC],
    lfo_on: [u8; NC],
    pitch_mod_on: [u8; NC],
    filter_mod_on: [u8; NC],
    fm_mod_on: [u8; NC],
    lfo_noise: Noise,
}

impl Engine {
    pub fn new(sample_rate: f64) -> Engine {
        let sr = sample_rate;
        let mut beat_at = [0u8; 16];
        beat_at[0] = 1;
        beat_at[4] = 1;
        beat_at[8] = 1;
        beat_at[12] = 1;
        let mut tone_l = Vec::new();
        let mut tone_r = Vec::new();
        for _ in 0..NC {
            let mut l = Svf::default();
            let mut r = Svf::default();
            l.setup(hit_tone_cutoff(1.0), 0.0, sr);
            r.setup(hit_tone_cutoff(1.0), 0.0, sr);
            tone_l.push(l);
            tone_r.push(r);
        }
        let tone1 = hit_tone_cutoff(1.0) as f32;
        Engine {
            sample_rate: sr,
            playing: false,
            frame: 0.0,
            peak_l: 0.0,
            peak_r: 0.0,
            current_step: [-1; NC],
            active_pattern: [0; NC],
            song_row: -1,
            song_bar: 0,
            recorded: Vec::new(),
            bpm: 128.0,
            swing: 0.0,
            master: Smoother::new(0.8, 0.02, sr),
            limiter: Limiter::new(sr),
            lanes: Vec::new(),
            row_start: [0; SONG_MAX_ROWS + 1],
            cell_of: [0; 16],
            auto_base: HashMap::new(),
            auto_applying: false,
            auto_snap: false,
            auto_stale: [0; NC],
            click: Click::new(sr),
            click_buf: vec![0.0; 1024],
            clicked: false,
            click_level: 0.0,
            click_on: false,
            count_left: 0.0,
            count_total: 0.0,
            lfo_start_clock: 0.0,
            beat_at,
            listen_frames: 0.0,
            step_active: vec![0; STEP_SLOTS],
            step_note: vec![0.0; STEP_SLOTS],
            step_vel: vec![0.0; STEP_SLOTS],
            step_accent: vec![0; STEP_SLOTS],
            step_ring: vec![0; STEP_SLOTS],
            step_rest: vec![0; STEP_SLOTS],
            step_slide: vec![0; STEP_SLOTS],
            step_gate: vec![1; STEP_SLOTS],
            step_extra: vec![0.0; STEP_SLOTS * (STEP_NOTES - 1)],
            step_extra_n: vec![0; STEP_SLOTS],
            step_extra_gate: vec![0; STEP_SLOTS * (STEP_NOTES - 1)],
            step_lock_src: (0..STEP_SLOTS).map(|_| None).collect(),
            pat_lanes: (0..PAT_SLOTS).map(|_| Vec::new()).collect(),
            pat_lanes_dirty: [0; PAT_SLOTS],
            pat_dirty: false,
            lane_pat: [-1; NC],
            chan_elapsed: [0.0; NC],
            chan_len: [1.0; NC],
            song_lane_by_key: HashMap::new(),
            step_flip: vec![0; STEP_SLOTS],
            step_on: vec![1; STEP_SLOTS],
            pattern_length: [16; PAT_SLOTS],
            pattern_rate: [1.0; PAT_SLOTS],
            chan_at: [0.0; NC],
            chan_rate: [1.0; NC],
            chan_count: [-1.0; NC],
            sub_at: [-1.0; NC],
            sub_len: [0.0; NC],
            sub_left: [0; NC],
            sub_pos: [0.0; NC],
            sub_step: [0.0; NC],
            loop_start: [1; NC],
            off_grid: [0; NC],
            meter: 0,
            bar_len: 16,
            bar_origin: 0.0,
            pending_meter: -1,
            pending_pattern: [-1; NC],
            land_at: [-1.0; NC],
            position: [0; NC],
            skip_step: [-1; NC],
            global_step: 0.0,
            frames_to_step: 0.0,
            last_step_frames: 1.0,
            insts: (0..NC).map(|_| SoundKind::ALL.iter().map(|&k| Inst::new(sr, k)).collect()).collect(),
            current: [None; NC],
            base_value: vec![0.0; NC * LOCK_SLOTS],
            patch_value: vec![0.0; NC * NUM_PATTERNS * LOCK_SLOTS],
            glide_pattern: [-1; NC],
            glide_from: vec![0.0; NC * LOCK_SLOTS],
            glide_to: vec![0.0; NC * LOCK_SLOTS],
            glide_done: [0.0; NC],
            glide_total: [0.0; NC],
            glide_wait: [0; NC],
            glide_curve: 0,
            fill_pat: [-1; NC],
            fill_at: [-1.0; NC],
            auto_fill_steps: 0.0,
            auto_fill_on: [0; NC],
            held_entry: [0; NC],
            pending_notes: (0..PAT_SLOTS).map(|_| None).collect(),
            notes_pending: false,
            pending_rate: [0.0; PAT_SLOTS],
            rate_pending: false,
            lock_applied: vec![0; NC * LOCK_SLOTS],
            live_offsets: (0..NC).map(|_| Vec::new()).collect(),
            offset_norm: vec![0.0; NC * LOCK_SLOTS],
            prev_offset: [0.0; LOCK_SLOTS],
            volume: (0..NC).map(|_| Smoother::new(0.8, 0.02, sr)).collect(),
            pan: (0..NC).map(|_| Smoother::new(0.0, 0.02, sr)).collect(),
            tone_l,
            tone_r,
            tone_now: [tone1; NC],
            tone_target: [tone1; NC],
            volume_value: [0.8; NC],
            type_gain: [1.0; NC],
            chord: [0; NC],
            scale_root: [9; NC],
            notes: [MAX_CHORD_NOTES as u8; NC],
            chords: Chords::new(),
            hold_note: [-1; NC * HOLDS],
            hold_steps: [0; NC * HOLDS],
            hold_at: [-1.0; NC * HOLDS],
            gate_steps: [0; NC],
            gate_length: [1.0; NC],
            gate_at: [-1.0; NC],
            cuts: (0..NC).map(|_| TrackCut::new(sr)).collect(),
            gate_group: [0; NC],
            ringing: [0; NC],
            rec_note: [-1; NC],
            rec_frame: [0.0; NC],
            rec_start: [0.0; NC],
            rec_index: [0; NC],
            rec_pattern: [0; NC],
            rec_vel: [0.0; NC],
            rec_accent: [0; NC],
            chord_note: [-1; NC * STEP_NOTES],
            chord_slot: [0; NC * STEP_NOTES],
            chord_start: [0.0; NC * STEP_NOTES],
            rec_slide: [0; NC],
            sliding: [0; NC],
            roll_div: [0.0; NC],
            hold_roll_count: [0; NC],
            hit_step: [-1.0; NC],
            hit_note: [0; NC],
            muted: [0; NC],
            edge_on: vec![0; SONG_MAX_ROWS * NC],
            edge_glide_start: vec![0; SONG_MAX_ROWS * NC],
            edge_glide_end: vec![0; SONG_MAX_ROWS * NC],
            edge_fill: vec![0; SONG_MAX_ROWS * NC],
            edge_fill_start: vec![0; SONG_MAX_ROWS * NC],
            song_cell: f64::NAN,
            played_before: [0; 17],
            song_bars: [0; SONG_MAX_ROWS],
            song_patterns: vec![0; SONG_MAX_ROWS * NC],
            song_keep: vec![0; SONG_MAX_ROWS * NC],
            chase_back: [0; NC],
            song_length: 0,
            song_on: false,
            song_jump_to: -1,
            song_off: [0; NC],
            roll_left: [0; NC],
            roll_at: [0.0; NC],
            roll_every: [0.0; NC],
            roll_note: [0.0; NC],
            roll_vel: [0.0; NC],
            roll_vel_end: [0.0; NC],
            roll_ramp: [0; NC],
            roll_index: [0; NC],
            run_left: [0; NC],
            tie_left: [0; NC],
            tie_note: [0; NC],
            tie_vel: [0.0; NC],
            tie_ring: [0; NC],
            chain_order: [-1; NC],
            hold_roll: [0; NC],
            hold_roll_note: [DRUM_ROOT as f32; NC],
            arp_on: [0; NC],
            arp_set: [0; NC],
            arp_mode: [0; NC],
            arp_steps: [1.0; NC],
            arp_oct: [1; NC],
            arp_held: [0; NC],
            arp_root: [0.0; NC],
            arp_vel: [0.0; NC],
            arp_index: [0; NC],
            arp_at: [0.0; NC],
            arp_note: [-1.0; NC],
            arp_noise: Noise::new(0xa29),
            scratch_l: [0.0; CHUNK],
            scratch_r: [0.0; CHUNK],
            buses: (0..NUM_BUSES).map(|k| FxBus::new(sr, k)).collect(),
            in_drum_bus: [0; NC],
            route: [-1; NC],
            send_level: (0..NC).map(|_| Smoother::new(0.5, 0.02, sr)).collect(),
            dyn_depth: [1.0; NC],
            force_ring: [0; NC],
            force_slide: [0; NC],
            force_vel: [0.0; NC],
            bus_l: [[0.0; CHUNK]; NUM_BUSES],
            bus_r: [[0.0; CHUNK]; NUM_BUSES],
            lfo_clock: 0.0,
            lfo_steps: 4.0,
            lfo_rate: 0,
            lfo_shape: 0,
            lfo_morph: 0.0,
            lfo_fm: 0.0,
            lfo_vol: 0.0,
            lfo_pitch: 0.0,
            lfo_filter: 0.0,
            lfo_pan: 0.0,
            lfo_phase: 0.0,
            lfo_smooth: 0.0,
            lfo_fade: 0.0,
            lfo_retrig: false,
            lfo_send: 0.0,
            lfo_spread: 0.0,
            lfo_buf: [0.0; NC * CHUNK],
            lfo_y: [0.0; NC],
            lfo_held: [0.0; NC],
            lfo_cycle: [-1.0; NC],
            lfo_trig: [0.0; NC],
            lfo_on: [0; NC],
            pitch_mod_on: [0; NC],
            filter_mod_on: [0; NC],
            fm_mod_on: [0; NC],
            lfo_noise: Noise::new(0x1f0),
        }
    }

    /// Output latency in frames (the master limiter's look-ahead).
    pub fn latency(&self) -> f64 {
        self.limiter.len as f64
    }

    /// The current instrument of track ch.
    fn inst(&mut self, ch: usize) -> Option<&mut Inst> {
        let k = self.current[ch]?;
        Some(&mut self.insts[ch][kind_index(k)])
    }

    /// A message from the UI (engine/protocol.ts MainToWorklet).
    pub fn handle_message(&mut self, msg: &Value) {
        let ty = str_of(msg, "type").unwrap_or("");
        let ch = num_or(msg, "channel", 0.0) as usize;
        let chv = ch.min(NC - 1);
        match ty {
            "loadProject" => {
                if let Some(p) = msg.get("project") {
                    self.load_project(p)
                }
            }
            "setStep" => {
                let pat = num_or(msg, "pattern", 0.0) as usize;
                let index = num_or(msg, "index", 0.0) as usize;
                if let Some(step) = msg.get("step") {
                    self.write_step(chv, pat, index, step);
                }
            }
            "setPatternLength" => {
                let pat = num_or(msg, "pattern", 0.0) as usize;
                self.pattern_length[chv * NUM_PATTERNS + pat] = u8w(num_or(msg, "length", 16.0).min(MAX_STEPS as f64).max(1.0));
            }
            "setPatternSpeed" => {
                let k = chv * NUM_PATTERNS + num_or(msg, "pattern", 0.0) as usize;
                self.pending_rate[k] = speed_steps(str_of(msg, "speed"));
                self.rate_pending = true;
                if !self.playing {
                    self.apply_pending_rates(false);
                }
            }
            "selectPattern" => self.select_pattern(chv, num_or(msg, "pattern", 0.0) as usize, is_true(msg, "immediate")),
            "switchPatterns" => {
                let chans: Vec<usize> = arr(msg.get("channels")).iter().filter_map(Value::as_f64).map(|c| c as usize).collect();
                self.switch_patterns(&chans, num_or(msg, "pattern", 0.0) as usize, is_true(msg, "quick"));
            }
            "setSound" => {
                let pat = match num(msg, "pattern") {
                    Some(p) => p as usize,
                    None => self.edited_pattern(chv),
                };
                let id = str_of(msg, "id").unwrap_or("");
                self.set_patch_sound(chv, pat, id, num_or(msg, "value", 0.0));
            }
            "setPatch" => {
                let sound = record(msg.get("sound"));
                self.set_patch(chv, num_or(msg, "pattern", 0.0) as usize, &sound, is_true(msg, "glide"));
            }
            "swapNotes" => {
                let k = chv * NUM_PATTERNS + num_or(msg, "pattern", 0.0) as usize;
                self.pending_notes[k] = Some(PendingNotes {
                    length: num_or(msg, "length", 16.0),
                    steps: arr(msg.get("steps")).to_vec(),
                    speed: str_of(msg, "speed").map(str::to_string),
                });
                self.notes_pending = true;
                if !self.playing {
                    self.apply_pending_notes();
                }
            }
            "setOffset" => {
                let id = str_of(msg, "id").unwrap_or("").to_string();
                self.set_offset(chv, &id, num_or(msg, "value", 0.0));
            }
            "setMix" => {
                let id = str_of(msg, "id").unwrap_or("").to_string();
                self.set_mix(chv, &id, num_or(msg, "value", 0.0));
            }
            "setListenLatency" => self.listen_frames = num_or(msg, "ms", 0.0).max(0.0) * 0.001 * self.sample_rate,
            "setGlobal" => {
                let v = num_or(msg, "value", 0.0);
                match str_of(msg, "id") {
                    Some("bpm") => {
                        self.bpm = v;
                        for b in &mut self.buses {
                            b.set_tempo(v);
                        }
                        self.instrument_tempo();
                    }
                    Some("swing") => self.swing = (v - 50.0) / 50.0,
                    Some("master") => self.master.set_target(v),
                    Some("meter") => self.set_meter(v),
                    _ => {}
                }
            }
            "setRouting" => self.route[chv] = self.bus_index(num_or(msg, "send", 0.0)),
            "setDrumBus" => self.in_drum_bus[chv] = is_true(msg, "on") as u8,
            "setBus" => {
                let id = str_of(msg, "id").unwrap_or("").to_string();
                self.set_bus_param(num_or(msg, "bus", 0.0) as usize, &id, num_or(msg, "value", 0.0));
            }
            "setLfo" => {
                let id = str_of(msg, "id").unwrap_or("").to_string();
                self.set_lfo(&id, num_or(msg, "value", 0.0));
            }
            "setLfoTrack" => self.lfo_on[chv] = is_true(msg, "on") as u8,
            "setArp" => {
                let id = str_of(msg, "id").unwrap_or("").to_string();
                self.set_arp(chv, &id, num_or(msg, "value", 0.0));
            }
            "holdRoll" => self.set_hold_roll(chv, is_true(msg, "on"), num_or(msg, "note", DRUM_ROOT)),
            "transport" => {
                let playing = is_true(msg, "playing");
                if playing && !self.playing {
                    self.song_on = is_true(msg, "song") && self.song_length > 0;
                    self.song_row = if self.song_on {
                        (num_or(msg, "fromRow", 0.0).min(self.song_length as f64 - 1.0)).max(0.0) as i32
                    } else {
                        -1
                    };
                    self.song_bar = -1;
                    self.set_playing(true);
                    if !self.song_on && truthy(msg, "fromStep") {
                        self.start_at(num_or(msg, "fromChannel", 0.0) as usize, num_or(msg, "fromStep", 0.0) as usize);
                    }
                    if self.song_on {
                        let bars = self.song_bars[self.song_row as usize] as f64;
                        let bar = (js::round(num_or(msg, "fromBar", 0.0)).min(bars - 1.0)).max(0.0);
                        self.start_song_at(bar as i32);
                    }
                    self.count_left = js::round(num_or(msg, "countIn", 0.0)).max(0.0) * self.bar_len as f64;
                    self.count_total = self.count_left;
                    self.auto_snap = self.song_on;
                    self.lfo_start_clock = self.lfo_clock;
                }
                self.set_playing(playing);
            }
            "setSong" => {
                if let Some(s) = msg.get("song") {
                    self.set_song(s)
                }
            }
            "setChain" => {
                let orders = arr(msg.get("orders"));
                for c in 0..NC {
                    self.chain_order[c] = i8w(js::round(orders.get(c).and_then(Value::as_f64).unwrap_or(-1.0)));
                    self.apply_chain(c);
                }
            }
            "setGlideCurve" => self.glide_curve = js::round(num_or(msg, "curve", 0.0)).min(3.0).max(0.0) as i32,
            "setAutoFill" => {
                self.auto_fill_steps = js::round(num_or(msg, "steps", 0.0)).max(0.0);
                let tracks = arr(msg.get("tracks"));
                for c in 0..NC {
                    self.auto_fill_on[c] = tracks.get(c).is_some_and(|t| t.as_bool().unwrap_or(t.as_f64().is_some_and(|x| x != 0.0))) as u8;
                }
            }
            "setClick" => {
                self.click_on = is_true(msg, "on");
                self.click_level = num_or(msg, "level", 0.0).min(1.0).max(0.0);
            }
            "songJump" => {
                if self.song_on {
                    self.song_jump_to = (num_or(msg, "row", 0.0).min(self.song_length as f64 - 1.0)).max(0.0) as i32;
                    let steps = (self.bar_len as f64 - self.bar_pos(self.global_step)) % self.bar_len as f64;
                    let frames = self.frames_ahead(steps);
                    self.glide_to_row(self.song_jump_to as usize, frames);
                }
            }
            "trigger" => self.note_on(chv, num_or(msg, "note", 60.0), num_or(msg, "velocity", 0.8), false, num_or(msg, "slideFrom", -1.0), false),
            "release" => self.release(chv, num_or(msg, "note", 60.0)),
            "setInstrument" => {
                let kind = str_of(msg, "kind").and_then(kind_of);
                let sound = record(msg.get("sound"));
                self.set_instrument(chv, kind, &sound);
            }
            "setChord" => self.chord[chv] = u8w(num_or(msg, "chord", 0.0)),
            "setRoot" => self.scale_root[chv] = u8w(num_or(msg, "root", 9.0)),
            "setNotes" => self.notes[chv] = u8w(num_or(msg, "notes", MAX_CHORD_NOTES as f64)),
            "setForce" => {
                self.force_ring[chv] = is_true(msg, "ring") as u8;
                self.force_slide[chv] = is_true(msg, "slide") as u8;
                self.force_vel[chv] = num_or(msg, "velocity", 0.0) as f32;
            }
            "recordNote" => {
                let note = num_or(msg, "note", 60.0);
                let vel = num_or(msg, "velocity", 0.8);
                if !(is_true(msg, "chord") && self.record_chord_note(chv, note, vel)) {
                    self.record_note(chv, note, vel, is_true(msg, "accent"), is_true(msg, "slide"));
                }
            }
            "recordLock" => {
                let id = str_of(msg, "id").unwrap_or("").to_string();
                self.record_lock(chv, &id, num_or(msg, "value", 0.0));
            }
            _ => {}
        }
        let _ = ch;
        if self.pat_dirty {
            self.flush_pat_lanes();
        }
    }

    /// Tempo-synced onboard effects (PLUCK's delay) follow the tempo.
    fn instrument_tempo(&mut self) {
        let bpm = self.bpm;
        for set in &mut self.insts {
            for i in set.iter_mut() {
                i.set_tempo(bpm);
            }
        }
    }

    fn kick_hit(&mut self, ch: usize) {
        if self.current[ch] != Some(SoundKind::Kick) {
            return;
        }
        for c in 0..NC {
            if c != ch {
                if let Some(i) = self.inst(c) {
                    i.duck();
                }
            }
        }
        for b in &mut self.buses {
            b.kick();
        }
    }

    pub fn load_project(&mut self, p: &Value) {
        self.pending_rate = [0.0; PAT_SLOTS];
        self.rate_pending = false;
        self.auto_base.clear();
        self.bpm = num_or(p, "bpm", 128.0);
        self.instrument_tempo();
        let buses = arr(p.get("buses"));
        for k in 0..NUM_BUSES {
            let bpm = self.bpm;
            self.buses[k].set_tempo(bpm);
            let list: &'static [Spec] = if k == 0 { &specs::BUS0_PARAMS } else { &specs::BUS1_PARAMS };
            for spec in list {
                let v = buses.get(k).and_then(|b| num(b, spec.id)).unwrap_or(spec.default);
                self.set_bus_param(k, spec.id, v);
            }
            self.buses[k].settle();
        }
        let empty = serde_json::json!({ "rows": [] });
        let song = p.get("song").filter(|s| !s.is_null()).unwrap_or(&empty);
        self.set_song(song);
        let channels = arr(p.get("channels"));
        for (c, cs) in channels.iter().enumerate().take(NC) {
            self.scale_root[c] = u8w(num_or(cs, "root", 9.0));
        }
        self.pending_meter = -1;
        let m = js::round(num_or(p, "meter", 0.0)).min(METERS.len() as f64 - 1.0).max(0.0) as usize;
        self.apply_meter(m);
        if let Some(Value::Object(lfo)) = p.get("lfo") {
            for (id, v) in lfo {
                if let Some(x) = v.as_f64() {
                    self.set_lfo(id, x);
                }
            }
        }
        self.swing = (num_or(p, "swing", 50.0) - 50.0) / 50.0;
        self.master.set_immediate(num_or(p, "master", 0.8));
        for ch in 0..NC {
            let Some(c) = channels.get(ch) else { continue };
            let kind = str_of(c, "instrument").and_then(kind_of);
            let sound = match kind {
                Some(k) => record(c.get("sounds").and_then(|s| s.get(k.id()))),
                None => Vec::new(),
            };
            self.set_instrument(ch, kind, &sound);
            self.pending_pattern[ch] = -1;
            let active = num_or(c, "activePattern", 0.0) as usize;
            self.active_pattern[ch] = active as u8;
            let patterns = arr(c.get("patterns"));
            for pat in 0..NUM_PATTERNS {
                self.pending_notes[ch * NUM_PATTERNS + pat] = None;
                if kind.is_some() {
                    // patchOf: the edited pattern's patch is the channel's own sound.
                    let patch = if pat == active { None } else { patterns.get(pat).and_then(|x| x.get("patch")).filter(|x| !x.is_null()) };
                    let ps = match patch {
                        Some(pp) => record(pp.get("sound")),
                        None => sound.clone(),
                    };
                    self.store_patch(ch, pat, &ps);
                }
            }
            self.enter_pattern(ch, active, true);
            for (id, v) in record(c.get("liveOffset")) {
                self.set_offset(ch, &id, v);
            }
            self.chord[ch] = u8w(num_or(c, "chord", 0.0));
            self.notes[ch] = u8w(num_or(c, "notes", MAX_CHORD_NOTES as f64));
            self.lfo_on[ch] = truthy(c, "lfoOn") as u8;
            let arp = c.get("arp").filter(|a| !a.is_null());
            let (on, mode, rate, oct) = match arp {
                Some(a) => (truthy(a, "on"), num_or(a, "mode", 0.0), num_or(a, "rate", 3.0), num_or(a, "oct", 0.0)),
                None => (false, 0.0, 3.0, 0.0),
            };
            self.set_arp(ch, "on", on as u8 as f64);
            self.set_arp(ch, "mode", mode);
            self.set_arp(ch, "rate", rate);
            self.set_arp(ch, "oct", oct);
            let volume = num_or(c, "volume", 0.8);
            let pan = num_or(c, "pan", 0.0);
            self.set_mix(ch, "volume", volume);
            self.set_mix(ch, "mute", truthy(c, "mute") as u8 as f64);
            self.set_mix(ch, "pan", pan);
            self.set_mix(ch, "dyn", num_or(c, "dynamics", 100.0));
            self.set_mix(ch, "gate", num_or(c, "gateLength", 1.0));
            self.set_mix(ch, "ring", num_or(c, "ringLength", 1.0));
            self.set_mix(ch, "cut", num_or(c, "midCut", 0.0));
            self.route[ch] = self.bus_index(num_or(c, "fxSend", 0.0));
            self.in_drum_bus[ch] = truthy(c, "fx1") as u8;
            let send = num_or(c, "sendLevel", 0.5);
            self.send_level[ch].set_immediate(send);
            self.auto_base.insert(format!("m:{ch}:send"), send);
            self.volume[ch].set_immediate(volume);
            self.pan[ch].set_immediate(pan);
            self.cuts[ch].settle();
            for pat in 0..NUM_PATTERNS {
                let k = ch * NUM_PATTERNS + pat;
                let pt = patterns.get(pat);
                self.pattern_length[k] = u8w(pt.map_or(16.0, |x| num_or(x, "length", 16.0)));
                self.pattern_rate[k] = speed_steps(pt.and_then(|x| str_of(x, "speed"))) as f32;
                let steps = arr(pt.and_then(|x| x.get("steps")));
                for i in 0..MAX_STEPS {
                    match steps.get(i) {
                        Some(s) => self.write_step(ch, pat, i, s),
                        None => self.write_step(ch, pat, i, &Value::Null),
                    }
                }
                self.refresh_on(k);
            }
        }
    }

    pub fn set_playing(&mut self, playing: bool) {
        if playing == self.playing {
            return;
        }
        self.playing = playing;
        if !playing {
            self.release_lanes();
            self.song_on = false;
            self.song_row = -1;
            self.song_jump_to = -1;
            self.song_off = [0; NC];
        }
        self.global_step = 0.0;
        self.count_left = 0.0;
        if self.pending_meter >= 0 {
            self.apply_meter(self.pending_meter as usize);
        }
        self.bar_origin = 0.0;
        self.frames_to_step = 0.0;
        self.lfo_clock = 0.0;
        self.lfo_trig = [0.0; NC];
        self.position = [0; NC];
        self.current_step = [-1; NC];
        self.skip_step = [-1; NC];
        self.roll_left = [0; NC];
        self.hit_step = [-1.0; NC];
        self.run_left = [0; NC];
        self.tie_left = [0; NC];
        self.sub_at = [-1.0; NC];
        self.sub_left = [0; NC];
        self.loop_start = [1; NC];
        self.off_grid = [0; NC];
        self.chan_count = [-1.0; NC];
        self.fill_pat = [-1; NC];
        self.fill_at = [-1.0; NC];
        self.held_entry = [0; NC];
        self.song_cell = f64::NAN;
        self.apply_pending_notes();
        self.apply_pending_rates(false);
        for ch in 0..NC {
            self.land_at[ch] = -1.0;
            if self.pending_pattern[ch] >= 0 {
                self.land_pattern(ch);
            }
            if self.glide_pattern[ch] >= 0 {
                self.finish_glide(ch);
            }
            if !playing {
                if self.arp_held[ch] != 0 {
                    self.stop_arp(ch);
                }
                if let Some(i) = self.inst(ch) {
                    i.note_off(-1.0);
                }
                self.clear_holds(ch);
                self.gate_steps[ch] = 0;
                self.gate_at[ch] = -1.0;
                self.rec_note[ch] = -1;
                for k in ch * STEP_NOTES..(ch + 1) * STEP_NOTES {
                    self.chord_note[k] = -1;
                }
                self.release_pat_lanes(ch);
            }
        }
    }

    // ------------------------------------------------------------------ status

    /// Position in the current bar, 0..1 (0 when stopped).
    pub fn bar_phase(&self) -> f64 {
        if !self.playing || self.global_step == 0.0 {
            return 0.0;
        }
        let in_step = ((self.last_step_frames - self.frames_to_step) / self.last_step_frames).max(0.0).min(1.0);
        let pos = (self.global_step - 1.0 + in_step - self.bar_origin) / self.bar_len as f64;
        pos - pos.floor()
    }

    pub fn bar_steps(&self) -> usize {
        self.bar_len
    }

    pub fn reset_peaks(&mut self) {
        self.peak_l = 0.0;
        self.peak_r = 0.0;
    }

    /// COUNT-IN: beats still to go.
    pub fn count_beats(&self) -> u32 {
        let mut n = 0;
        let mut k = self.count_total - self.count_left;
        while k < self.count_total {
            n += self.beat_at[(k as usize) % self.bar_len] as u32;
            k += 1.0;
        }
        n
    }

    /// The pattern whose steps track ch plays now.
    pub fn heard_pattern(&self, ch: usize) -> usize {
        self.seq_pattern(ch)
    }

    fn bus_index(&self, send: f64) -> i8 {
        if send >= 2.0 && send <= NUM_SENDS as f64 {
            (send - 1.0) as i8
        } else {
            -1
        }
    }
}

use crate::js;
