//! GrooveAccess native audio. Step 1 of the native engine (CLAUDE.md, platform plan): the
//! Android low-latency audio path (AAudio: LowLatency + Exclusive, buffer = 2 bursts) playing
//! a test blip on a tap, with its measured output latency, so the gain over the WebView can be
//! heard and read on the device. The engine moves here module by module, each null-tested
//! against the TypeScript engine (tests/blocks.rs: the building blocks).

// Index loops stay as in the TypeScript, line for line, so the port can be read against it.
#![allow(clippy::needless_range_loop)]

pub mod blip;
pub mod drive_comp;
pub mod engine;
pub mod fx;
pub mod host;
pub mod dsp;
pub mod instruments;
pub mod js;
pub mod kind;
pub mod math;
pub mod params;
pub mod smoother;
pub mod specs;

#[cfg(target_arch = "wasm32")]
mod wasm;
#[cfg(target_os = "android")]
mod audio;
#[cfg(target_os = "android")]
mod jni;
