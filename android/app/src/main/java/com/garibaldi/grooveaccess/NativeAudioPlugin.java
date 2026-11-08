package com.garibaldi.grooveaccess;

import android.os.Handler;
import android.os.HandlerThread;
import android.webkit.JavascriptInterface;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The native audio path: the engine and MENU > GLOBAL SETTINGS > NATIVE AUDIO TEST
 * (src/ui/audioTest.ts). src/worklet/nativeHost.ts talks to the engine straight through the
 * page's `GrooveNative` object (a JavaScript interface: send / poll, called on the WebView's
 * own thread, no trip through the main thread, so status reports reach the panel on time);
 * without it, through `send` here and "engine" events polled every few ms.
 */
@CapacitorPlugin(name = "NativeAudio")
public class NativeAudioPlugin extends Plugin {
    private static final long POLL_MS = 8;
    private HandlerThread pollThread;
    private Handler poller;

    /** The page's direct line to the engine (window.GrooveNative). */
    public static final class Direct {
        @JavascriptInterface
        public void send(String json) {
            if (NativeAudio.loaded && json != null) NativeAudio.send(json);
        }

        @JavascriptInterface
        public String poll() {
            return NativeAudio.loaded ? NativeAudio.poll() : "[]";
        }
    }

    @Override
    public void load() {
        // Before the page loads (plugins load first), so the page has it from the start.
        if (NativeAudio.loaded) getBridge().getWebView().addJavascriptInterface(new Direct(), "GrooveNative");
    }

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            String msgs = NativeAudio.poll();
            if (msgs != null && msgs.length() > 2) {
                JSObject o = new JSObject();
                o.put("msgs", msgs);
                notifyListeners("engine", o);
            }
            poller.postDelayed(this, POLL_MS);
        }
    };

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

    /** Play through the native engine from now on; resolves with the stream's settings. */
    @PluginMethod
    public void engineStart(PluginCall call) {
        if (!NativeAudio.loaded) {
            call.reject("unavailable");
            return;
        }
        int err = NativeAudio.engineStart();
        if (err != 0) {
            call.reject("aaudio " + err);
            return;
        }
        if (call.getBoolean("events", true) && pollThread == null) {
            pollThread = new HandlerThread("EnginePoll");
            pollThread.start();
            poller = new Handler(pollThread.getLooper());
            poller.post(poll);
        }
        call.resolve(info());
    }

    /** Fire and forget: the messages (msgs, a JSON array) go to the engine in order. */
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void send(PluginCall call) {
        String msgs = call.getString("msgs");
        if (NativeAudio.loaded && msgs != null) NativeAudio.send(msgs);
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
