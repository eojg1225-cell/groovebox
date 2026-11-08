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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

const STATUS_HZ: f64 = 30.0;
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

fn recorded_json(r: &Recorded) -> String {
    let v = match r {
        Recorded::Note { channel, pattern, index, note, velocity, accent, gate, slide, start } => {
            let mut v = serde_json::json!({ "type": "recordedNote", "channel": channel, "pattern": pattern, "index": index, "note": note, "velocity": velocity, "accent": accent, "gate": gate, "slide": slide });
            if *start {
                v["start"] = Value::Bool(true);
            }
            v
        }
        Recorded::Lock { channel, pattern, index, id, value } => {
            serde_json::json!({ "type": "recordedLock", "channel": channel, "pattern": pattern, "index": index, "id": id, "value": value })
        }
        Recorded::Chord { channel, pattern, index, note, gate } => {
            serde_json::json!({ "type": "recordedChord", "channel": channel, "pattern": pattern, "index": index, "note": note, "gate": gate })
        }
    };
    v.to_string()
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

    fn handle(&mut self, msg: &Value) {
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
            _ => {}
        }
        self.engine.handle_message(msg);
    }

    /// Render `frames` stereo frames, added into `out` (interleaved L R).
    pub fn render(&mut self, out: &mut [f32], frames: usize) {
        let started = Instant::now();
        if let Ok(mut q) = INBOX.try_lock() {
            std::mem::swap(&mut *q, &mut self.msgs);
        }
        let stop = STOP_GEN.load(Ordering::Relaxed) as f64;
        if stop > self.transport_gen {
            self.transport_gen = stop;
            let m = std::mem::take(&mut self.stop_msg);
            self.engine.handle_message(&m);
            self.stop_msg = m;
        }
        let mut msgs = std::mem::take(&mut self.msgs);
        for m in &msgs {
            self.handle(m);
        }
        if !msgs.is_empty() {
            match TRASH.try_lock() {
                Ok(mut t) => t.append(&mut msgs),
                Err(_) => msgs.clear(),
            }
        }
        self.msgs = msgs;
        for r in self.engine.recorded.drain(..).collect::<Vec<_>>() {
            let s = recorded_json(&r);
            self.put(&s);
        }
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
        self.since_status += frames;
        self.busy += started.elapsed().as_secs_f64();
        if self.since_status >= self.status_every {
            self.status();
        }
        self.flush();
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
        s.push_str("]}");
        self.pending = s;
        self.engine.reset_peaks();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plays_reports_and_answers() {
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
}
