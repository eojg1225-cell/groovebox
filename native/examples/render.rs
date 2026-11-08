//! Renders null-test scenarios with the native engine (tools/native/null.test.ts writes them
//! and compares the output with the TypeScript engine's): `render <scenarios.json> <out.f32>`.
//! Each scenario: { kind, sampleRate, frames, events: [[frame, op, ...args]] }, rendered in
//! 128-frame blocks (as the engine: the track buffer cleared, render between events, then
//! post). Output: every scenario's frames, L R interleaved, little-endian f32, one after another.

use groovebox_native::instruments::click::Click;
use groovebox_native::instruments::drum::Drum;
use groovebox_native::kind::SoundKind;
use serde_json::Value;
use std::io::Write;

const BLOCK: usize = 128;

enum Source {
    Drum(Box<Drum>),
    Click(Click),
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
        let mut src = if kind == "click" { Source::Click(Click::new(sr)) } else { Source::Drum(Box::new(Drum::new(sr, kind_of(kind)))) };
        let frames = sc["frames"].as_u64().unwrap() as usize;
        let events = sc["events"].as_array().unwrap();
        let mut next = 0;
        let (mut l, mut r) = (vec![0f32; BLOCK], vec![0f32; BLOCK]);
        let mut block = 0;
        while block < frames {
            let n = BLOCK.min(frames - block);
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
                        Source::Click(c) => {
                            c.render(&mut l[..n], at, until - at);
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
                Source::Click(_) => r[..n].copy_from_slice(&l[..n]),
            }
            for i in 0..n {
                out.write_all(&l[i].to_le_bytes()).unwrap();
                out.write_all(&r[i].to_le_bytes()).unwrap();
            }
            block += n;
        }
    }
}
