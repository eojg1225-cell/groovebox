//! Renders null-test scenarios with the native engine (tools/native/null.test.ts writes them
//! and compares the output with the TypeScript engine's): `render <scenarios.json> <out.f32>`.
//! Each scenario: { kind, sampleRate, frames, events: [[frame, op, ...args]] }, rendered in
//! blocks of `block` frames (the engine's chunk: 64; the track buffer cleared, render between
//! events, then post). Output: every scenario's frames, L R interleaved, little-endian f32, one after another.

use groovebox_native::fx::bus::FxBus;
use groovebox_native::fx::limiter::Limiter;
use groovebox_native::fx::track_cut::TrackCut;
use groovebox_native::instruments::click::Click;
use groovebox_native::instruments::drum::Drum;
use groovebox_native::instruments::synth::Synth;
use groovebox_native::kind::SoundKind;
use serde_json::Value;
use std::io::Write;


enum Source {
    Drum(Box<Drum>),
    Synth(Box<Synth>),
    Click(Click),
    Bus(Box<FxBus>),
    Limiter(Box<Limiter>),
    Cut(Box<TrackCut>),
}

fn kind_of(id: &str) -> SoundKind {
    *SoundKind::ALL.iter().find(|k| k.id() == id).unwrap_or_else(|| panic!("kind {id}"))
}

fn apply(src: &mut Source, ev: &[Value]) {
    let op = ev[1].as_str().unwrap();
    let f = |i: usize| ev[i].as_f64().unwrap();
    match src {
        Source::Drum(d) => match op {
            "param" => d.set_param(ev[2].as_str().unwrap(), f(3)),
            "on" => d.note_on(f(2), f(3), ev[4].as_bool().unwrap()),
            "off" => d.note_off(),
            "cut" => d.cut(),
            "ringLength" => d.set_ring_length(f(2)),
            "pitchMod" => d.set_pitch_mod(f(2)),
            "filterMod" => d.set_filter_mod(f(2)),
            "chain" => d.set_chain(f(2)),
            _ => panic!("op {op}"),
        },
        Source::Synth(s) => match op {
            "param" => s.set_param(ev[2].as_str().unwrap(), f(3)),
            "on" => s.note_on(f(2), f(3), f(4) as i32, ev[5].as_bool().unwrap(), f(6) as i32, ev[7].as_bool().unwrap()),
            "off" => s.note_off(f(2) as i32),
            "cut" => s.cut(),
            "pitchMod" => s.set_pitch_mod(f(2)),
            "filterMod" => s.set_filter_mod(f(2)),
            "fmMod" => s.set_fm_mod(f(2)),
            "chain" => s.set_chain(f(2)),
            "tempo" => s.set_tempo(f(2)),
            "duck" => s.duck(),
            _ => panic!("op {op}"),
        },
        Source::Bus(b) => match op {
            "param" => b.set_param(ev[2].as_str().unwrap(), f(3)),
            "tempo" => b.set_tempo(f(2)),
            "settle" => b.settle(),
            "kick" => b.kick(),
            _ => panic!("op {op}"),
        },
        Source::Limiter(_) => panic!("op {op}"),
        Source::Cut(c) => match op {
            "freq" => c.set_freq(f(2)),
            "amount" => c.set_amount(f(2)),
            "settle" => c.settle(),
            _ => panic!("op {op}"),
        },
        Source::Click(c) => match op {
            "tick" => c.trigger(ev[2].as_bool().unwrap()),
            _ => panic!("op {op}"),
        },
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let scenarios: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let mut out = std::io::BufWriter::new(std::fs::File::create(&args[2]).unwrap());
    for sc in &scenarios {
        let sr = sc["sampleRate"].as_f64().unwrap();
        let kind = sc["kind"].as_str().unwrap();
        let mut src = match kind {
            "click" => Source::Click(Click::new(sr)),
            "fx1" => Source::Bus(Box::new(FxBus::new(sr, 0))),
            "fx2" => Source::Bus(Box::new(FxBus::new(sr, 1))),
            "limiter" => Source::Limiter(Box::new(Limiter::new(sr))),
            "trackcut" => Source::Cut(Box::new(TrackCut::new(sr))),
            "bass" | "pad" | "lead" | "pluck" => Source::Synth(Box::new(Synth::new(sr, kind_of(kind)))),
            _ => Source::Drum(Box::new(Drum::new(sr, kind_of(kind)))),
        };
        let block_len = sc["block"].as_u64().unwrap() as usize;
        // Effects: their input (L R interleaved f32), written by the test.
        let input: Vec<f32> = sc["input"].as_str().map_or(vec![], |path| {
            std::fs::read(path).unwrap().chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
        });
        let (mut il, mut ir) = (vec![0f32; block_len], vec![0f32; block_len]);
        let frames = sc["frames"].as_u64().unwrap() as usize;
        let events = sc["events"].as_array().unwrap();
        let mut next = 0;
        let (mut l, mut r) = (vec![0f32; block_len], vec![0f32; block_len]);
        let mut block = 0;
        while block < frames {
            let n = block_len.min(frames - block);
            l[..n].fill(0.0);
            r[..n].fill(0.0);
            let mut at = 0;
            loop {
                // Events due in this block, in order, each at its frame.
                let due = events.get(next).map(|e| e.as_array().unwrap()).filter(|e| (e[0].as_u64().unwrap() as usize) < block + n);
                let until = due.map_or(n, |e| e[0].as_u64().unwrap() as usize - block);
                if until > at {
                    match &mut src {
                        Source::Drum(d) => d.render(&mut l[..n], &mut r[..n], at, until),
                        Source::Synth(s) => s.render(&mut l[..n], &mut r[..n], at, until),
                        Source::Click(c) => {
                            c.render(&mut l[..n], at, until - at);
                        }
                        Source::Bus(b) => {
                            for i in at..until {
                                il[i] = input[(block + i) * 2];
                                ir[i] = input[(block + i) * 2 + 1];
                            }
                            b.process(&mut il[at..until], &mut ir[at..until], &mut l[at..until], &mut r[at..until]);
                        }
                        Source::Limiter(lim) => {
                            for i in at..until {
                                l[i] = input[(block + i) * 2];
                                r[i] = input[(block + i) * 2 + 1];
                            }
                            lim.process(&mut l[at..until], &mut r[at..until]);
                        }
                        Source::Cut(c) => {
                            for i in at..until {
                                l[i] = input[(block + i) * 2];
                                r[i] = input[(block + i) * 2 + 1];
                            }
                            c.process(&mut l[at..until], &mut r[at..until]);
                        }
                    }
                    at = until;
                }
                match due {
                    Some(e) => {
                        apply(&mut src, e);
                        next += 1;
                    }
                    None => break,
                }
            }
            match &mut src {
                Source::Drum(d) => d.post(&mut l[..n], &mut r[..n]),
                Source::Synth(s) => s.post(&mut l[..n], &mut r[..n]),
                Source::Click(_) => r[..n].copy_from_slice(&l[..n]),
                _ => {}
            }
            for i in 0..n {
                out.write_all(&l[i].to_le_bytes()).unwrap();
                out.write_all(&r[i].to_le_bytes()).unwrap();
            }
            block += n;
        }
    }
}
