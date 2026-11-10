//! GrooveAccess's engine: the sequencer, instruments, effects and master (engine/, instruments/,
//! fx/), its host (host.rs), in two builds: the Android app's (AAudio through the ndk crate,
//! audio.rs, JNI in jni.rs; NATIVE AUDIO TEST's blip, blip.rs) and the web build's
//! (WebAssembly, wasm.rs; parts.rs for the tests). Checked by tests/blocks.rs (the building
//! blocks) and the app's `npm run engine:golden` (whole projects, both builds).

// Index loops stay as they were ported from the TypeScript engine, line for line.
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
mod parts;
#[cfg(target_arch = "wasm32")]
mod wasm;
#[cfg(target_os = "android")]
mod audio;
#[cfg(target_os = "android")]
mod jni;
