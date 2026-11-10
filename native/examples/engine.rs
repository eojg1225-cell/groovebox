//! Renders the engine golden test's scenarios (tools/native/golden.test.ts) with the native
//! build: each scenario's protocol messages applied at the start of the 128-frame block they
//! fall in (as the worklet does), the engine's output written as interleaved f32, then what
//! live recording wrote, one line of JSON per scenario.
//! Usage: engine <scenarios.json> <out.f32> <recorded.json>

use std::io::Write;

use groovebox_native::engine::{Engine, Recorded};
use serde_json::{json, Value};

fn recorded(r: &Recorded) -> Value {
    match r {
        Recorded::Note { channel, pattern, index, note, velocity, accent, gate, slide, start } => {
            json!({ "type": "recordedNote", "channel": channel, "pattern": pattern, "index": index, "note": note, "velocity": velocity, "accent": accent, "gate": gate, "slide": slide, "start": start })
        }
        Recorded::Lock { channel, pattern, index, id, value } => {
            json!({ "type": "recordedLock", "channel": channel, "pattern": pattern, "index": index, "id": id, "value": value })
        }
        Recorded::Chord { channel, pattern, index, note, gate } => {
            json!({ "type": "recordedChord", "channel": channel, "pattern": pattern, "index": index, "note": note, "gate": gate })
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let scenarios: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let mut out = std::io::BufWriter::new(std::fs::File::create(&args[2]).unwrap());
    let mut rec_out = std::io::BufWriter::new(std::fs::File::create(&args[3]).unwrap());
    for sc in &scenarios {
        let sr = sc["sampleRate"].as_f64().unwrap();
        let frames = sc["frames"].as_u64().unwrap() as usize;
        let block = sc["block"].as_u64().unwrap() as usize;
        let msgs = sc["msgs"].as_array().unwrap();
        let mut engine = Engine::new(sr);
        let (mut l, mut r) = (vec![0f32; block], vec![0f32; block]);
        let mut next = 0;
        let mut pos = 0;
        let mut rec = Vec::new();
        while pos < frames {
            let n = block.min(frames - pos);
            while next < msgs.len() && (msgs[next][0].as_u64().unwrap() as usize) < pos + n {
                engine.handle_message(&msgs[next][1]);
                next += 1;
            }
            engine.process(&mut l, &mut r, n);
            for i in 0..n {
                out.write_all(&l[i].to_le_bytes()).unwrap();
                out.write_all(&r[i].to_le_bytes()).unwrap();
            }
            rec.extend(engine.recorded.drain(..).map(|x| recorded(&x)));
            pos += n;
        }
        writeln!(rec_out, "{}", Value::Array(rec)).unwrap();
    }
}
