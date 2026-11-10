//! The engine in the browser: WebAssembly exports for the web build's AudioWorklet
//! (src/worklet/processor.ts), the same `Host` as the Android app's (host.rs): messages in as
//! the protocol's JSON, the engine rendered a block at a time, status / pongs / recorded notes
//! out as JSON. No bindings generator: the worklet writes UTF-8 into `in_buf`, reads the
//! output from `out_buf` and the audio from `audio_buf`, all owned here and reused.
//!
//! One thread (the worklet's), so the host's locks never wait.

use crate::host::{self, Host};
use std::cell::RefCell;

#[link(wasm_import_module = "env")]
extern "C" {
    /// The worklet's clock, ms (Date.now()).
    #[link_name = "now_ms"]
    fn js_now_ms() -> f64;
}

pub fn now_ms() -> f64 {
    // SAFETY: a plain import with no arguments.
    unsafe { js_now_ms() }
}

/// The largest block `render` takes (a render quantum is 128 frames).
const MAX_FRAMES: usize = 1024;

struct State {
    host: Option<Host>,
    input: Vec<u8>,
    output: String,
    audio: Vec<f32>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State {
        host: None,
        input: Vec::new(),
        output: String::with_capacity(8192),
        audio: vec![0.0; MAX_FRAMES * 2],
    });
}

/// A fresh engine at this sample rate (also after a non-finite output: the page resends).
#[no_mangle]
pub extern "C" fn engine_new(sample_rate: f64) {
    host::reset_queues();
    STATE.with(|s| s.borrow_mut().host = Some(Host::new(sample_rate)));
}

/// Room for `len` bytes of input; the worklet writes the JSON there and calls `send`.
#[no_mangle]
pub extern "C" fn in_buf(len: usize) -> *mut u8 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.input.clear();
        s.input.resize(len, 0);
        s.input.as_mut_ptr()
    })
}

/// Queue the `len` bytes written to `in_buf` (a JSON array of messages, or one). 0 = not JSON.
#[no_mangle]
pub extern "C" fn send(len: usize) -> u32 {
    STATE.with(|s| {
        let s = s.borrow();
        let text = std::str::from_utf8(&s.input[..len.min(s.input.len())]).unwrap_or("");
        u32::from(host::send(text).is_ok())
    })
}

/// Render `frames` (at most MAX_FRAMES): the audio, interleaved L R, at `audio_buf`. The
/// messages queued since are handled first; what the engine wrote goes to `out_buf` /
/// `out_len` (comma-separated JSON objects, empty = nothing).
#[no_mangle]
pub extern "C" fn render(frames: usize) {
    STATE.with(|s| {
        let s = &mut *s.borrow_mut();
        let n = frames.min(MAX_FRAMES);
        let out = &mut s.audio[..n * 2];
        out.fill(0.0);
        if let Some(h) = s.host.as_mut() {
            h.render(out, n);
        }
        host::poll_into(&mut s.output);
    })
}

#[no_mangle]
pub extern "C" fn audio_buf() -> *const f32 {
    STATE.with(|s| s.borrow().audio.as_ptr())
}

#[no_mangle]
pub extern "C" fn out_buf() -> *const u8 {
    STATE.with(|s| s.borrow().output.as_ptr())
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    STATE.with(|s| s.borrow().output.len())
}
