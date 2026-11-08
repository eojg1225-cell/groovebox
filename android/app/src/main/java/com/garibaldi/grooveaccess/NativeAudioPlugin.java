package com.garibaldi.grooveaccess;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** MENU > GLOBAL SETTINGS > NATIVE AUDIO TEST (src/ui/audioTest.ts): the native audio path. */
@CapacitorPlugin(name = "NativeAudio")
public class NativeAudioPlugin extends Plugin {
    private JSObject info() {
        JSObject o = new JSObject();
        o.put("rate", NativeAudio.info(0));
        o.put("burst", NativeAudio.info(1));
        o.put("buffer", NativeAudio.info(2));
        o.put("exclusive", NativeAudio.info(3) == 1);
        o.put("lowLatency", NativeAudio.info(4) == 1);
        return o;
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!NativeAudio.loaded) {
            call.reject("unavailable");
            return;
        }
        int err = NativeAudio.start();
        if (err != 0) {
            call.reject("aaudio " + err);
            return;
        }
        call.resolve(info());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (NativeAudio.loaded) NativeAudio.stop();
        call.resolve();
    }

    /** Fire and forget: the blip starts on the audio thread's next block. */
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void tap(PluginCall call) {
        if (NativeAudio.loaded) NativeAudio.tap();
    }

    @PluginMethod
    public void latency(PluginCall call) {
        JSObject o = info();
        o.put("ms", NativeAudio.loaded ? NativeAudio.latencyMs() : -1);
        call.resolve(o);
    }
}
