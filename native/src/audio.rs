//! The AAudio output stream (Android 8+): LowLatency, Exclusive where the device allows it
//! (else AAudio shares it), 32-bit float stereo, its buffer cut to two bursts. The data
//! callback runs on AAudio's real-time thread: it only reads an atomic and renders the blip.

use crate::blip::Blip;
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
pub fn start() -> Result<Info, i32> {
    let mut held = STREAM.lock().unwrap_or_else(|e| e.into_inner());
    *held = None; // closes an old one
    LOST.store(false, Ordering::Relaxed);
    let s = open().map_err(i32::from)?;
    let i = info(&s);
    *held = Some(Held(s));
    Ok(i)
}

pub fn stop() {
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
    if LOST.load(Ordering::Relaxed) {
        start().ok()?;
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
