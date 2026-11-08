//! GrooveAccess native audio. Step 1 of the native engine (CLAUDE.md, platform plan): the
//! Android low-latency audio path (AAudio: LowLatency + Exclusive, buffer = 2 bursts) playing
//! a test blip on a tap, with its measured output latency, so the gain over the WebView can be
//! heard and read on the device. The engine itself moves here module by module later.

pub mod blip;

#[cfg(target_os = "android")]
mod audio;
#[cfg(target_os = "android")]
mod jni;
