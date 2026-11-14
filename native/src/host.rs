//! The engine's host on the native audio path, as src/worklet/processor.ts is in the browser:
//! messages in (the UI's protocol, as JSON), the engine rendered on the audio thread, status
//! reports / recorded notes / pongs out (as JSON). Platform-free, so it runs in host tests;
//! audio.rs calls `render` from AAudio's callback, jni.rs `send` / `poll` from Java.
//!
//! Audio-thread rules: the callback only ever try-locks (never waits); messages are parsed on
//! the sender's thread, and once handled they go back to it to be freed there; status reports
//! are written into a reused buffer.

use crate::engine::{Engine, Recorded};
use serde_json::Value;
use std::fmt::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const STATUS_HZ: f64 = 30.0;

/// Seconds on a steady clock, for the DSP load (the browser's worklet has no `Instant`: the
/// page's WebAssembly import `now_ms`, whole ms, which evens out over the blocks of a report).
#[cfg(not(target_arch = "wasm32"))]
fn clock() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

#[cfg(target_arch = "wasm32")]
fn clock() -> f64 {
    crate::wasm::now_ms() / 1000.0
}
const MAX_BLOCK: usize = 1024;

/// Messages parsed and waiting for the audio thread.
static INBOX: Mutex<Vec<Value>> = Mutex::new(Vec::new());
/// Messages the audio thread has handled: freed by the next `send`.
static TRASH: Mutex<Vec<Value>> = Mutex::new(Vec::new());
/// What the audio thread wrote for the UI: JSON objects, comma-separated.
static OUTBOX: Mutex<String> = Mutex::new(String::new());
/// The newest STOP's transport count: it overtakes messages waiting behind a busy audio
/// thread (the worklet's `stop` parameter).
static STOP_GEN: AtomicU64 = AtomicU64::new(0);

/// Queue the UI's messages (a JSON array of protocol messages, or one). Err = not JSON.
pub fn send(json: &str) -> Result<(), String> {
    let v: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let msgs = match v {
        Value::Array(a) => a,
        one => vec![one],
    };
    for m in &msgs {
        if m.get("type").and_then(Value::as_str) == Some("transport") && m.get("playing") == Some(&Value::Bool(false)) {
            if let Some(g) = m.get("gen").and_then(Value::as_f64) {
                STOP_GEN.fetch_max(g as u64, Ordering::Relaxed);
            }
        }
    }
    INBOX.lock().unwrap_or_else(|e| e.into_inner()).extend(msgs);
    TRASH.lock().unwrap_or_else(|e| e.into_inner()).clear();
    Ok(())
}

/// Everything the audio thread wrote since the last poll, as JSON objects, comma-separated,
/// into `into` (reused: the browser's worklet polls after every block).
pub fn poll_into(into: &mut String) {
    let mut out = OUTBOX.lock().unwrap_or_else(|e| e.into_inner());
    into.clear();
    into.push_str(&out);
    out.clear();
}

/// Everything the audio thread wrote since the last poll, as a JSON array.
pub fn poll() -> String {
    let mut out = OUTBOX.lock().unwrap_or_else(|e| e.into_inner());
    let s = format!("[{}]", out);
    out.clear();
    s
}

/// Tell the UI the engine is a fresh one (send it everything again).
pub fn notify_reset() {
    let mut out = OUTBOX.lock().unwrap_or_else(|e| e.into_inner());
    if !out.is_empty() {
        out.push(',');
    }
    out.push_str("{\"type\":\"engineReset\"}");
}

/// Forget what is waiting (a fresh start).
pub fn reset_queues() {
    INBOX.lock().unwrap_or_else(|e| e.into_inner()).clear();
    OUTBOX.lock().unwrap_or_else(|e| e.into_inner()).clear();
    STOP_GEN.store(0, Ordering::Relaxed);
}

fn num(x: f64) -> f64 {
    if x.is_finite() { x } else { 0.0 }
}

/// A recorded note / lock as a JSON object, written into `into` (the audio thread's reused
/// buffer: nothing allocated while it has room).
fn write_recorded(into: &mut String, r: &Recorded) {
    if !into.is_empty() {
        into.push(',');
    }
    let _ = match r {
        Recorded::Note { channel, pattern, index, note, velocity, accent, gate, slide, start } => write!(
            into,
            "{{\"type\":\"recordedNote\",\"channel\":{channel},\"pattern\":{pattern},\"index\":{index},\"note\":{},\"velocity\":{},\"accent\":{accent},\"gate\":{},\"slide\":{slide}{}}}",
            num(*note),
            num(*velocity),
            num(*gate),
            if *start { ",\"start\":true" } else { "" }
        ),
        Recorded::Lock { channel, pattern, index, id, value } => {
            let _ = write!(into, "{{\"type\":\"recordedLock\",\"channel\":{channel},\"pattern\":{pattern},\"index\":{index},\"id\":\"");
            // Parameter ids are plain ASCII; escape anyway so the JSON always parses.
            for c in id.chars() {
                match c {
                    '"' | '\\' => {
                        into.push('\\');
                        into.push(c);
                    }
                    c if (c as u32) < 0x20 => {}
                    c => into.push(c),
                }
            }
            write!(into, "\",\"value\":{}}}", num(*value))
        }
        Recorded::Chord { channel, pattern, index, note, gate } => write!(
            into,
            "{{\"type\":\"recordedChord\",\"channel\":{channel},\"pattern\":{pattern},\"index\":{index},\"note\":{},\"gate\":{}}}",
            num(*note),
            num(*gate)
        ),
    };
}

pub struct Host {
    engine: Box<Engine>,
    sample_rate: f64,
    l: Vec<f32>,
    r: Vec<f32>,
    msgs: Vec<Value>,
    transport_gen: f64,
    since_reset: usize,
    status_every: usize,
    since_status: usize,
    busy: f64,
    /// Written for the UI and not yet handed over (the outbox was busy).
    pending: String,
    stop_msg: Value,
}

impl Host {
    pub fn new(sample_rate: f64) -> Host {
        Host {
            engine: Box::new(Engine::new(sample_rate)),
            sample_rate,
            l: vec![0.0; MAX_BLOCK],
            r: vec![0.0; MAX_BLOCK],
            msgs: Vec::with_capacity(256),
            transport_gen: 0.0,
            since_reset: sample_rate as usize,
            status_every: (sample_rate / STATUS_HZ).round() as usize,
            since_status: 0,
            busy: 0.0,
            pending: String::with_capacity(4096),
            stop_msg: serde_json::json!({ "type": "transport", "playing": false }),
        }
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    fn put(&mut self, s: &str) {
        if !self.pending.is_empty() {
            self.pending.push(',');
        }
        self.pending.push_str(s);
    }

    /// Hand what was written to the UI's outbox (unless it is busy: next time).
    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        if let Ok(mut out) = OUTBOX.try_lock() {
            // A UI that stopped polling must not grow it for ever: keep the newest.
            if out.len() > 1 << 20 {
                out.clear();
            }
            if !out.is_empty() {
                out.push(',');
            }
            out.push_str(&self.pending);
            self.pending.clear();
        }
    }

    fn handle(&mut self, msg: &mut Value) {
        match msg.get("type").and_then(Value::as_str) {
            Some("ping") => {
                let id = msg.get("id").and_then(Value::as_f64).unwrap_or(0.0);
                let mut s = std::mem::take(&mut self.pending);
                if !s.is_empty() {
                    s.push(',');
                }
                let _ = write!(s, "{{\"type\":\"pong\",\"id\":{}}}", num(id));
                self.pending = s;
                return;
            }
            Some("transport") => {
                if let Some(g) = msg.get("gen").and_then(Value::as_f64) {
                    if g < self.transport_gen {
                        return;
                    }
                    self.transport_gen = g;
                }
            }
            #[cfg(test)]
            Some("panicForTest") => panic!("a panic in the engine (test)"),
            _ => {}
        }
        self.engine.handle_message(msg);
    }

    /// What the engine recorded (live recording) into the outgoing buffer; the list keeps
    /// its room for the next ones.
    fn take_recorded(&mut self) {
        let mut rec = std::mem::take(&mut self.engine.recorded);
        for r in &rec {
            write_recorded(&mut self.pending, r);
        }
        rec.clear();
        self.engine.recorded = rec;
    }

    /// The engine panicked (a bug: it must never happen, but must never stop the music for
    /// good): a fresh engine, and the UI is told to send everything again, at most once a
    /// second (a project that panics again on load leaves a silent engine, not a loop).
    fn recover(&mut self) {
        self.msgs.clear();
        *self.engine = Engine::new(self.sample_rate);
        if self.since_reset >= self.sample_rate as usize {
            self.put("{\"type\":\"engineReset\"}");
        }
        self.since_reset = 0;
        self.flush();
    }

    /// Handle what was sent at once, without rendering (the tests read the state right after).
    pub fn apply(&mut self) {
        let ok = catch_unwind(AssertUnwindSafe(|| {
            self.take_messages();
            self.take_recorded();
        }))
        .is_ok();
        if !ok {
            self.recover();
        }
        self.flush();
    }

    /// The engine's state as one JSON object (for the tests: what a status report carries,
    /// read at any moment, plus the limiter's look-ahead).
    pub fn state_json(&self, into: &mut String) {
        let e = &self.engine;
        into.clear();
        let _ = write!(
            into,
            "{{\"playing\":{},\"frame\":{},\"latency\":{},\"peakL\":{},\"peakR\":{},\"songRow\":{},\"songBar\":{},\"barPhase\":{},\"barSteps\":{},\"countBeats\":{},\"currentStep\":[",
            e.playing,
            num(e.frame),
            num(e.latency()),
            num(e.peak_l),
            num(e.peak_r),
            e.song_row,
            e.song_bar,
            num(e.bar_phase()),
            e.bar_steps(),
            e.count_beats()
        );
        for (ch, st) in e.current_step.iter().enumerate() {
            let _ = write!(into, "{}{}", if ch > 0 { "," } else { "" }, st);
        }
        into.push_str("],\"heardPattern\":[");
        for ch in 0..e.current_step.len() {
            let _ = write!(into, "{}{}", if ch > 0 { "," } else { "" }, e.heard_pattern(ch));
        }
        into.push_str("]}");
    }

    /// The engine itself (the web build's tests).
    pub fn engine_mut(&mut self) -> &mut Engine {
        &mut self.engine
    }

    /// A sound parameter's base value on a track (Engine::base_value).
    pub fn base_value(&self, ch: usize, slot: usize) -> f64 {
        self.engine.base_value(ch, slot)
    }

    /// Take the messages waiting and handle them, in order.
    fn take_messages(&mut self) {
        if let Ok(mut q) = INBOX.try_lock() {
            std::mem::swap(&mut *q, &mut self.msgs);
        }
        let stop = STOP_GEN.load(Ordering::Relaxed) as f64;
        if stop > self.transport_gen {
            self.transport_gen = stop;
            let mut m = std::mem::take(&mut self.stop_msg);
            self.engine.handle_message(&mut m);
            self.stop_msg = m;
        }
        let mut msgs = std::mem::take(&mut self.msgs);
        for m in &mut msgs {
            self.handle(m);
        }
        if !msgs.is_empty() {
            match TRASH.try_lock() {
                Ok(mut t) => t.append(&mut msgs),
                Err(_) => msgs.clear(),
            }
        }
        self.msgs = msgs;
    }

    /// Render `frames` stereo frames, added into `out` (interleaved L R). A panic in the
    /// engine is caught here (on Android; the web build's panics abort and the worklet
    /// starts a fresh module): the block is silent and a fresh engine takes over (`recover`).
    pub fn render(&mut self, out: &mut [f32], frames: usize) {
        let started = clock();
        let ok = catch_unwind(AssertUnwindSafe(|| self.render_engine(out, frames))).is_ok();
        if !ok {
            self.recover();
        }
        self.since_status += frames;
        self.busy += clock() - started;
        if self.since_status >= self.status_every {
            self.status();
        }
        self.flush();
    }

    fn render_engine(&mut self, out: &mut [f32], frames: usize) {
        self.take_messages();
        self.take_recorded();
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(MAX_BLOCK);
            self.engine.process(&mut self.l, &mut self.r, n);
            let mut sum = 0.0f32;
            for i in 0..n {
                sum += self.l[i] + self.r[i];
            }
            self.since_reset += n;
            if !sum.is_finite() {
                // A NaN / infinity: mute and start a fresh engine (the UI resends the project).
                self.l[..n].fill(0.0);
                self.r[..n].fill(0.0);
                if self.since_reset >= self.sample_rate as usize {
                    self.since_reset = 0;
                    *self.engine = Engine::new(self.sample_rate);
                    self.put("{\"type\":\"engineReset\"}");
                }
            }
            for i in 0..n {
                out[(done + i) * 2] += self.l[i];
                out[(done + i) * 2 + 1] += self.r[i];
            }
            done += n;
        }
    }

    fn status(&mut self) {
        let e = &self.engine;
        let load = self.busy / (self.since_status as f64 / self.sample_rate);
        self.busy = 0.0;
        self.since_status = 0;
        let mut s = std::mem::take(&mut self.pending);
        if !s.is_empty() {
            s.push(',');
        }
        let _ = write!(
            s,
            "{{\"type\":\"status\",\"peakL\":{},\"peakR\":{},\"frame\":{},\"playing\":{},\"barPhase\":{},\"barSteps\":{},\"songRow\":{},\"songBar\":{},\"load\":{},\"countIn\":{},\"steps\":[",
            num(e.peak_l),
            num(e.peak_r),
            num(e.frame),
            e.playing,
            num(e.bar_phase()),
            e.bar_steps(),
            e.song_row,
            e.song_bar,
            num(load),
            e.count_beats()
        );
        for (ch, st) in e.current_step.iter().enumerate() {
            let _ = write!(s, "{}{}", if ch > 0 { "," } else { "" }, st);
        }
        s.push_str("],\"patterns\":[");
        for ch in 0..e.current_step.len() {
            let _ = write!(s, "{}{}", if ch > 0 { "," } else { "" }, e.heard_pattern(ch));
        }
        s.push_str("],\"next\":[");
        for ch in 0..e.current_step.len() {
            let _ = write!(s, "{}{}", if ch > 0 { "," } else { "" }, e.next_step(ch));
        }
        s.push_str("],\"nextMs\":[");
        for ch in 0..e.current_step.len() {
            let _ = write!(s, "{}{:.2}", if ch > 0 { "," } else { "" }, num(e.ms_to_next(ch)));
        }
        s.push_str("]}");
        self.pending = s;
        self.engine.reset_peaks();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The queues are global: the tests that use them take turns.
    static QUEUES: Mutex<()> = Mutex::new(());

    #[test]
    fn plays_reports_and_answers() {
        let _guard = QUEUES.lock().unwrap_or_else(|e| e.into_inner());
        reset_queues();
        let mut h = Host::new(48000.0);
        send(r#"[{"type":"setInstrument","channel":0,"kind":"kick","sound":{}},
                 {"type":"setStep","channel":0,"pattern":0,"index":0,"step":{"active":true,"note":33,"velocity":1,"gate":1}},
                 {"type":"transport","playing":true,"gen":1},{"type":"ping","id":7}]"#)
        .unwrap();
        let mut out = vec![0f32; 2 * 192];
        let mut peak = 0f32;
        for _ in 0..100 {
            out.fill(0.0);
            h.render(&mut out, 192);
            peak = out.iter().fold(peak, |p, x| p.max(x.abs()));
        }
        assert!(peak > 0.05, "the kick sounds ({peak})");
        let msgs: Vec<Value> = serde_json::from_str(&poll()).unwrap();
        assert!(msgs.iter().any(|m| m["type"] == "pong" && m["id"] == 7));
        let st = msgs.iter().find(|m| m["type"] == "status").expect("a status report");
        assert_eq!(st["playing"], true);
        assert_eq!(st["steps"].as_array().unwrap().len(), 8);
        // STOP by its count stops at once; an older transport message is dropped.
        send(r#"[{"type":"transport","playing":false,"gen":2},{"type":"transport","playing":true,"gen":1}]"#).unwrap();
        h.render(&mut out, 192);
        assert!(!h.engine.playing);
        assert_eq!(poll().chars().next(), Some('['));
    }

    #[test]
    fn a_panic_restarts_the_engine() {
        let _guard = QUEUES.lock().unwrap_or_else(|e| e.into_inner());
        reset_queues();
        let mut h = Host::new(48000.0);
        let mut out = vec![0f32; 2 * 192];
        // A second of audio first, so the reset is reported (at most once a second).
        for _ in 0..250 {
            h.render(&mut out, 192);
        }
        poll();
        send(r#"[{"type":"transport","playing":true,"gen":1},{"type":"panicForTest"}]"#).unwrap();
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        h.render(&mut out, 192);
        std::panic::set_hook(hook);
        assert!(!h.engine.playing, "a fresh engine");
        let msgs: Vec<Value> = serde_json::from_str(&poll()).unwrap();
        assert!(msgs.iter().any(|m| m["type"] == "engineReset"));
        // It plays on.
        h.render(&mut out, 192);
    }

    #[test]
    fn recorded_notes_are_json() {
        let mut s = String::new();
        write_recorded(&mut s, &Recorded::Note { channel: 1, pattern: 2, index: 3, note: 60.5, velocity: 0.8, accent: true, gate: 1.0, slide: false, start: true });
        write_recorded(&mut s, &Recorded::Lock { channel: 0, pattern: 0, index: 5, id: "cut\"off", value: f64::NAN });
        write_recorded(&mut s, &Recorded::Chord { channel: 5, pattern: 1, index: 0, note: 64.0, gate: 2.0 });
        let v: Vec<Value> = serde_json::from_str(&format!("[{s}]")).unwrap();
        assert_eq!(v[0]["type"], "recordedNote");
        assert_eq!(v[0]["note"], 60.5);
        assert_eq!(v[0]["start"], true);
        assert_eq!(v[1]["id"], "cut\"off");
        assert_eq!(v[1]["value"], 0.0);
        assert_eq!(v[2]["gate"], 2.0);
    }

    /// Every message type with indices out of range (and odd values) is handled without a
    /// panic: the engine checks what it is sent.
    #[test]
    fn out_of_range_messages_are_harmless() {
        let mut e = Engine::new(48000.0);
        let bad = [-3.0, 1e9, 4.0, 128.0, 999.0];
        let types = [
            "setStep", "setPatternLength", "setPatternSpeed", "selectPattern", "switchPatterns", "setSound", "setPatch",
            "swapNotes", "setOffset", "setMix", "setGlobal", "setRouting", "setDrumBus", "setBus", "setLfo", "setLfoTrack",
            "setArp", "holdRoll", "transport", "setChain", "setGlideCurve", "setAutoFill", "setClick", "songJump", "trigger",
            "release", "setInstrument", "setChord", "setRoot", "setNotes", "setForce", "recordNote", "recordLock",
        ];
        for &x in &bad {
            for kind in ["kick", "pad"] {
                let mut m = serde_json::json!({ "type": "setInstrument", "channel": 0, "kind": kind, "sound": {} });
                e.handle_message(&mut m);
                for t in types {
                    let mut m = serde_json::json!({
                        "type": t, "channel": x, "pattern": x, "index": x, "bus": x, "row": x, "length": x, "note": x,
                        "value": x, "id": "cutoff", "speed": "double", "channels": [x, 0, 0, -1], "steps": [{ "active": true, "note": 60 }],
                        "step": { "active": true, "note": 60, "gate": x }, "playing": true, "song": true, "fromRow": x,
                        "fromBar": x, "fromStep": x, "fromChannel": x, "send": x, "orders": [x], "tracks": [true],
                        "chord": x, "root": x, "notes": x, "kind": kind, "sound": { "cutoff": x }
                    });
                    e.handle_message(&mut m);
                    let (mut l, mut r) = (vec![0f32; 128], vec![0f32; 128]);
                    e.process(&mut l, &mut r, 128);
                }
            }
        }
    }
}
