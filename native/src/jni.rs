//! The Java side (android/.../NativeAudio.java): static native methods, plain JNI types only.
//! The JNIEnv / class pointers are not used, but by the string calls (the jni crate).

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

/// The app plays through the native engine (the stream opened if need be): 0, or AAudio's error.
#[no_mangle]
pub extern "system" fn Java_com_garibaldi_grooveaccess_NativeAudio_engineStart(_: Env, _: Class) -> i32 {
    match audio::engine_start() {
        Ok(_) => 0,
        Err(code) => code,
    }
}

/// The app in the background with nothing playing (1): the stream closed; back (0): opened
/// again. 0, or AAudio's error.
#[no_mangle]
pub extern "system" fn Java_com_garibaldi_grooveaccess_NativeAudio_suspend(_: Env, _: Class, on: u8) -> i32 {
    match audio::suspend(on != 0) {
        Ok(()) => 0,
        Err(code) => code,
    }
}

/// The UI's messages (a JSON array of protocol messages) to the engine.
#[no_mangle]
pub extern "system" fn Java_com_garibaldi_grooveaccess_NativeAudio_send(mut env: jni::JNIEnv, _: jni::objects::JClass, json: jni::objects::JString) {
    let text: String = match env.get_string(&json) {
        Ok(s) => s.into(),
        Err(_) => return,
    };
    let _ = crate::host::send(&text);
}

/// What the engine wrote since the last poll (a JSON array: status, pong, recorded, engineReset).
#[no_mangle]
pub extern "system" fn Java_com_garibaldi_grooveaccess_NativeAudio_poll<'a>(env: jni::JNIEnv<'a>, _: jni::objects::JClass<'a>) -> jni::sys::jstring {
    match env.new_string(crate::host::poll()) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}
