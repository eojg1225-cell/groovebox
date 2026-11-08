package com.garibaldi.grooveaccess;

/**
 * The native audio library (native/, Rust: libgroovebox_native.so, built by CI with cargo-ndk).
 * Needs AAudio (Android 8+); on older systems, or a build without the library, {@link #loaded}
 * is false and nothing here may be called.
 */
final class NativeAudio {
    static final boolean loaded;

    static {
        boolean ok;
        try {
            System.loadLibrary("groovebox_native");
            ok = true;
        } catch (Throwable t) {
            ok = false;
        }
        loaded = ok;
    }

    private NativeAudio() {}

    /** 0, or AAudio's (negative) error code. */
    static native int start();

    static native void stop();

    /** Start the test blip. */
    static native void tap();

    /** Output latency in ms (-1 = not known yet). */
    static native double latencyMs();

    /** The app plays through the native engine (opens the stream if need be): 0, or AAudio's error. */
    static native int engineStart();

    /** The UI's protocol messages (a JSON array) to the engine. */
    static native void send(String json);

    /** What the engine wrote since the last call (a JSON array: status, pong, recorded, engineReset). */
    static native String poll();

    /** 0 sample rate, 1 frames per burst, 2 buffer frames, 3 exclusive, 4 low latency; -1 = no stream. */
    static native int info(int what);
}
