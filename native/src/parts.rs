//! Single parts of the engine on their own, for the web build's tests (tests/rustParts.ts)
//! and the sound lab: one instrument, an FX bus, the master limiter, a track's MID CUT, each
//! by a handle, driven as the engine drives it. WebAssembly exports only; the worklet never
//! calls them.

use crate::fx::bus::FxBus;
use crate::fx::limiter::Limiter;
use crate::fx::track_cut::TrackCut;
use crate::instruments::drum::Drum;
use crate::instruments::synth::Synth;
use crate::kind::SoundKind;
use std::cell::RefCell;

enum Part {
    Drum(Box<Drum>),
    Synth(Box<Synth>),
    Bus(Box<FxBus>),
    Limiter(Box<Limiter>),
    Cut(Box<TrackCut>),
}

struct Parts {
    list: Vec<Option<Part>>,
    /// in L, in R, out L, out R (a part renders / processes them in place).
    bufs: [Vec<f32>; 4],
    id: Vec<u8>,
}

thread_local! {
    static PARTS: RefCell<Parts> = RefCell::new(Parts { list: Vec::new(), bufs: Default::default(), id: Vec::new() });
}

fn with<R>(h: usize, f: impl FnOnce(&mut Part, &mut [Vec<f32>; 4]) -> R) -> Option<R> {
    PARTS.with(|p| {
        let p = &mut *p.borrow_mut();
        let Parts { list, bufs, .. } = p;
        list.get_mut(h).and_then(Option::as_mut).map(|part| f(part, bufs))
    })
}

/// A new part: 0-7 = SoundKind::ALL's instruments, 8 / 9 = FX 1 / FX 2, 10 = the limiter,
/// 11 = MID CUT. Returns its handle.
#[no_mangle]
pub extern "C" fn part_new(what: u32, sample_rate: f64) -> usize {
    let part = match what {
        0..=7 => {
            let kind = SoundKind::ALL[what as usize];
            if matches!(kind, SoundKind::Bass | SoundKind::Pad | SoundKind::Lead | SoundKind::Pluck) {
                Part::Synth(Box::new(Synth::new(sample_rate, kind)))
            } else {
                Part::Drum(Box::new(Drum::new(sample_rate, kind)))
            }
        }
        8 | 9 => Part::Bus(Box::new(FxBus::new(sample_rate, (what - 8) as usize))),
        10 => Part::Limiter(Box::new(Limiter::new(sample_rate))),
        _ => Part::Cut(Box::new(TrackCut::new(sample_rate))),
    };
    PARTS.with(|p| {
        let mut p = p.borrow_mut();
        p.list.push(Some(part));
        p.list.len() - 1
    })
}

#[no_mangle]
pub extern "C" fn part_free(h: usize) {
    PARTS.with(|p| {
        if let Some(slot) = p.borrow_mut().list.get_mut(h) {
            *slot = None;
        }
    });
}

/// Room for a parameter id of `len` bytes (then `part_param`).
#[no_mangle]
pub extern "C" fn part_id_buf(len: usize) -> *mut u8 {
    PARTS.with(|p| {
        let mut p = p.borrow_mut();
        p.id.clear();
        p.id.resize(len, 0);
        p.id.as_mut_ptr()
    })
}

/// The four buffers (in L, in R, out L, out R), each at least `n` frames: their addresses
/// one after another from `part_buf(k)`.
#[no_mangle]
pub extern "C" fn part_bufs(n: usize) {
    PARTS.with(|p| {
        for b in p.borrow_mut().bufs.iter_mut() {
            if b.len() < n {
                b.resize(n, 0.0);
            }
        }
    });
}

#[no_mangle]
pub extern "C" fn part_buf(k: usize) -> *mut f32 {
    PARTS.with(|p| p.borrow_mut().bufs[k].as_mut_ptr())
}

/// Set the parameter whose id was written to `part_id_buf`.
#[no_mangle]
pub extern "C" fn part_param(h: usize, value: f64) {
    let id = PARTS.with(|p| String::from_utf8_lossy(&p.borrow().id).into_owned());
    with(h, |part, _| match part {
        Part::Drum(d) => d.set_param(&id, value),
        Part::Synth(s) => s.set_param(&id, value),
        Part::Bus(b) => b.set_param(&id, value),
        Part::Cut(c) => match id.as_str() {
            "freq" => c.set_freq(value),
            _ => c.set_amount(value),
        },
        Part::Limiter(_) => {}
    });
}

#[no_mangle]
pub extern "C" fn part_note_on(h: usize, note: f64, velocity: f64, group: i32, ring: u32, slide_from: i32, slide: u32) {
    with(h, |part, _| match part {
        Part::Drum(d) => d.note_on(note, velocity, ring != 0),
        Part::Synth(s) => s.note_on(note, velocity, group, ring != 0, slide_from, slide != 0),
        _ => {}
    });
}

#[no_mangle]
pub extern "C" fn part_note_off(h: usize, group: i32) {
    with(h, |part, _| match part {
        Part::Drum(d) => d.note_off(),
        Part::Synth(s) => s.note_off(group),
        _ => {}
    });
}

/// 0 cut, 1 settle, 2 kick (a bus's duck), 3 duck (a synth's sidechain).
#[no_mangle]
pub extern "C" fn part_do(h: usize, what: u32) {
    with(h, |part, _| match (part, what) {
        (Part::Drum(d), 0) => d.cut(),
        (Part::Synth(s), 0) => s.cut(),
        (Part::Synth(s), 3) => s.duck(),
        (Part::Bus(b), 1) => b.settle(),
        (Part::Bus(b), 2) => b.kick(),
        (Part::Cut(c), 1) => c.settle(),
        _ => {}
    });
}

/// 0 tempo, 1 RING length, 2 pitch mod, 3 filter mod, 4 FM mod, 5 FX ROUTING.
#[no_mangle]
pub extern "C" fn part_set(h: usize, what: u32, v: f64) {
    with(h, |part, _| match (part, what) {
        (Part::Synth(s), 0) => s.set_tempo(v),
        (Part::Bus(b), 0) => b.set_tempo(v),
        (Part::Drum(d), 1) => d.set_ring_length(v),
        (Part::Drum(d), 2) => d.set_pitch_mod(v),
        (Part::Synth(s), 2) => s.set_pitch_mod(v),
        (Part::Drum(d), 3) => d.set_filter_mod(v),
        (Part::Synth(s), 3) => s.set_filter_mod(v),
        (Part::Synth(s), 4) => s.set_fm_mod(v),
        (Part::Drum(d), 5) => d.set_chain(v),
        (Part::Synth(s), 5) => s.set_chain(v),
        _ => {}
    });
}

/// An instrument: frames [0, n) added into out L / R. An effect: in L / R through it into
/// out L / R (the limiter and MID CUT in place on out L / R).
#[no_mangle]
pub extern "C" fn part_run(h: usize, n: usize) {
    with(h, |part, bufs| {
        let [il, ir, ol, or] = bufs;
        match part {
            Part::Drum(d) => d.render(&mut ol[..n], &mut or[..n], 0, n),
            Part::Synth(s) => s.render(&mut ol[..n], &mut or[..n], 0, n),
            Part::Bus(b) => b.process(&mut il[..n], &mut ir[..n], &mut ol[..n], &mut or[..n]),
            Part::Limiter(l) => l.process(&mut ol[..n], &mut or[..n]),
            Part::Cut(c) => c.process(&mut ol[..n], &mut or[..n]),
        }
    });
}

/// An instrument's onboard effects (PLUCK delay / room, PAD LOW CUT / MOD / VERB, drums' AIR)
/// on out L / R [0, n), in place.
#[no_mangle]
pub extern "C" fn part_post(h: usize, n: usize) {
    with(h, |part, bufs| {
        let [_, _, ol, or] = bufs;
        match part {
            Part::Drum(d) => d.post(&mut ol[..n], &mut or[..n]),
            Part::Synth(s) => s.post(&mut ol[..n], &mut or[..n]),
            _ => {}
        }
    });
}

/// 0 = the limiter's look-ahead (frames), 1 = its gain reduction now (1 = none).
#[no_mangle]
pub extern "C" fn part_info(h: usize, what: u32) -> f64 {
    with(h, |part, _| match (part, what) {
        (Part::Limiter(l), 0) => l.len as f64,
        (Part::Limiter(l), 1) => l.reduction,
        _ => 0.0,
    })
    .unwrap_or(0.0)
}
