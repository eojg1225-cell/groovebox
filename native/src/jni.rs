//! The Java side (android/.../NativeAudio.java): static native methods, plain JNI types only.
//! The JNIEnv / class pointers are not used.

use crate::audio;
use std::ffi::c_void;

type Env = *mut c_void;
type Class = *mut c_void;

/// Open and start the stream: 0, or AAudio's (negative) error code.
#[no_mangle]
pub extern "system" fn Java_com_garibaldi_grooveaccess_NativeAudio_start(_: Env, _: Class) -> i32 {
    match audio::start() {
        Ok(_) => 0,
        Err(code) => code,
    }
}

#[no_mangle]
pub extern "system" fn Java_com_garibaldi_grooveaccess_NativeAudio_stop(_: Env, _: Class) {
    audio::stop();
}

#[no_mangle]
pub extern "system" fn Java_com_garibaldi_grooveaccess_NativeAudio_tap(_: Env, _: Class) {
    audio::tap();
}

/// Output latency in ms (-1 = not known yet).
#[no_mangle]
pub extern "system" fn Java_com_garibaldi_grooveaccess_NativeAudio_latencyMs(_: Env, _: Class) -> f64 {
    audio::latency_ms().unwrap_or(-1.0)
}

/// The open stream: 0 sample rate, 1 frames per burst, 2 buffer frames, 3 exclusive (1 / 0),
/// 4 low latency (1 / 0). -1 = no stream.
#[no_mangle]
pub extern "system" fn Java_com_garibaldi_grooveaccess_NativeAudio_info(_: Env, _: Class, what: i32) -> i32 {
    match audio::current() {
        None => -1,
        Some(i) => match what {
            0 => i.rate,
            1 => i.burst,
            2 => i.buffer,
            3 => i.exclusive as i32,
            4 => i.low_latency as i32,
            _ => -1,
        },
    }
}
