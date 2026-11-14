//! The AAudio output stream (Android 8+): LowLatency, Exclusive where the device allows it
//! (else AAudio shares it), 32-bit float stereo, its buffer cut to two bursts. The data
//! callback runs on AAudio's real-time thread: it renders the test blip and, once the app has
//! switched it on (`engine_start`), the engine (host.rs), which it only ever try-locks.

use crate::blip::Blip;
use crate::host::Host;
use ndk::audio::{
    AudioCallbackResult, AudioDirection, AudioError, AudioFormat, AudioPerformanceMode, AudioSharingMode,
    AudioStream, AudioStreamBuilder, Clockid,
};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

static TAPS: AtomicU32 = AtomicU32::new(0);
/// The device went away (headphones in / out): the stream is opened again on the next poll.
static LOST: AtomicBool = AtomicBool::new(false);

struct Held(AudioStream);
// The stream is only touched from these functions, under the mutex; AAudio's own thread uses
// the callback alone.
unsafe impl Send for Held {}

static STREAM: Mutex<Option<Held>> = Mutex::new(None);
/// The engine, at the open stream's sample rate (None until the app starts it).
static HOST: Mutex<Option<Host>> = Mutex::new(None);
/// The app plays through the native engine: the stream stays open.
static ENGINE: AtomicBool = AtomicBool::new(false);
/// The app is in the background with nothing playing: the stream is closed (no CPU, no
/// battery, the device free for other apps) until it comes back (`suspend(false)`).
static SUSPENDED: AtomicBool = AtomicBool::new(false);

/// What the device gave us.
pub struct Info {
    pub rate: i32,
    pub burst: i32,
    pub buffer: i32,
    pub exclusive: bool,
    pub low_latency: bool,
}

fn open() -> Result<AudioStream, AudioError> {
    let mut blip: Option<Blip> = None;
    let stream = AudioStreamBuilder::new()?
        .direction(AudioDirection::Output)
        .performance_mode(AudioPerformanceMode::LowLatency)
        .sharing_mode(AudioSharingMode::Exclusive)
        .format(AudioFormat::PCM_Float)
        .channel_count(2)
        .data_callback(Box::new(move |s, data, frames| {
            let b = blip.get_or_insert_with(|| Blip::new(s.sample_rate() as f64));
            let out = unsafe { std::slice::from_raw_parts_mut(data as *mut f32, frames as usize * 2) };
            b.render(out, TAPS.load(Ordering::Relaxed));
            if ENGINE.load(Ordering::Relaxed) {
                if let Ok(mut h) = HOST.try_lock() {
                    if let Some(h) = h.as_mut() {
                        h.render(out, frames as usize);
                    }
                }
            }
            AudioCallbackResult::Continue
        }))
        .error_callback(Box::new(|_, _| LOST.store(true, Ordering::Relaxed)))
        .open_stream()?;
    // Two bursts: the usual low-latency setting (one is apt to glitch).
    let _ = stream.set_buffer_size_in_frames(stream.frames_per_burst() * 2);
    stream.request_start()?;
    Ok(stream)
}

fn info(s: &AudioStream) -> Info {
    Info {
        rate: s.sample_rate(),
        burst: s.frames_per_burst(),
        buffer: s.buffer_size_in_frames(),
        exclusive: s.sharing_mode() == AudioSharingMode::Exclusive,
        low_latency: s.performance_mode() == AudioPerformanceMode::LowLatency,
    }
}

/// Open and start the stream (again if it is already open). Err = AAudio's error code.
fn reopen() -> Result<Info, i32> {
    let mut held = STREAM.lock().unwrap_or_else(|e| e.into_inner());
    *held = None; // closes an old one
    LOST.store(false, Ordering::Relaxed);
    let s = open().map_err(i32::from)?;
    let i = info(&s);
    *held = Some(Held(s));
    drop(held);
    if ENGINE.load(Ordering::Relaxed) {
        ensure_host(i.rate as f64);
    }
    Ok(i)
}

/// The engine at this sample rate (a fresh one, which the UI is told to fill, if it changed).
fn ensure_host(rate: f64) {
    let same = HOST.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|h| h.sample_rate() == rate);
    if same == Some(true) {
        return;
    }
    let fresh = Host::new(rate);
    *HOST.lock().unwrap_or_else(|e| e.into_inner()) = Some(fresh);
    if same == Some(false) {
        crate::host::notify_reset();
    }
}

/// The app went to the background with nothing playing (true): close the stream, keeping the
/// engine and everything it was sent; back (false): open it again. Err = AAudio's error.
pub fn suspend(on: bool) -> Result<(), i32> {
    SUSPENDED.store(on, Ordering::Relaxed);
    if on {
        let mut held = STREAM.lock().unwrap_or_else(|e| e.into_inner());
        *held = None; // closes it
        return Ok(());
    }
    if !ENGINE.load(Ordering::Relaxed) {
        return Ok(());
    }
    start().map(|_| ())
}

/// The stream, open and started (opened if it is not, or was lost).
pub fn start() -> Result<Info, i32> {
    SUSPENDED.store(false, Ordering::Relaxed);
    if !LOST.load(Ordering::Relaxed) {
        if let Some(i) = current() {
            return Ok(i);
        }
    }
    reopen()
}

/// The app plays through the native engine from now on (the stream opened, the engine made).
pub fn engine_start() -> Result<Info, i32> {
    ENGINE.store(true, Ordering::Relaxed);
    let i = start()?;
    ensure_host(i.rate as f64);
    Ok(i)
}

/// Close the stream (not while the engine plays through it).
pub fn stop() {
    if ENGINE.load(Ordering::Relaxed) {
        return;
    }
    let mut held = STREAM.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(h) = held.take() {
        let _ = h.0.request_stop();
    }
}

pub fn tap() {
    TAPS.fetch_add(1, Ordering::Relaxed);
}

#[allow(clippy::unnecessary_cast)] // i32 fields on 32-bit ARM (older Fire tablets)
fn now_ns() -> i64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as i64 * 1_000_000_000 + ts.tv_nsec as i64
}

/// The output latency now (ms): how long a sample written next takes to reach the speaker,
/// from the stream's own timestamps (as Oboe's calculateLatencyMillis). None = not known yet.
pub fn latency_ms() -> Option<f64> {
    if SUSPENDED.load(Ordering::Relaxed) {
        return None;
    }
    if LOST.load(Ordering::Relaxed) {
        reopen().ok()?;
    }
    let held = STREAM.lock().unwrap_or_else(|e| e.into_inner());
    let s = &held.as_ref()?.0;
    let ts = s.timestamp(Clockid::Monotonic).ok()?;
    let written = s.frames_written();
    let rate = s.sample_rate() as f64;
    let next = ts.time_nanoseconds as f64 + (written - ts.frame_position) as f64 * 1e9 / rate;
    Some((next - now_ns() as f64) / 1e6)
}

/// Whether a stream is open now, and what it is.
pub fn current() -> Option<Info> {
    let held = STREAM.lock().unwrap_or_else(|e| e.into_inner());
    held.as_ref().map(|h| info(&h.0))
}
