package com.garibaldi.grooveaccess;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
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
 *
 * The app holds Android's audio focus while it plays (`focus`, sent as PLAY starts): a call
 * or another app taking the audio sends a "focus" event and the page stops (App.stopPlaying).
 * In the background with nothing playing the page calls `suspend` (the stream closed, the
 * focus given back) and again on coming back.
 */
@CapacitorPlugin(name = "NativeAudio")
public class NativeAudioPlugin extends Plugin {
    private static final long POLL_MS = 8;
    private HandlerThread pollThread;
    private Handler poller;
    private AudioFocusRequest focusRequest;

    private final AudioManager.OnAudioFocusChangeListener onFocus = change -> {
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            JSObject o = new JSObject();
            o.put("lost", true);
            notifyListeners("focus", o);
        }
    };

    private AudioManager audioManager() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    /** Take the audio focus (Android 8+, as the native engine needs). */
    private void requestFocus() {
        if (Build.VERSION.SDK_INT < 26) return;
        AudioManager am = audioManager();
        if (am == null) return;
        if (focusRequest == null) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build();
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(onFocus)
                .build();
        }
        am.requestAudioFocus(focusRequest);
    }

    private void abandonFocus() {
        if (Build.VERSION.SDK_INT < 26 || focusRequest == null) return;
        AudioManager am = audioManager();
        if (am != null) am.abandonAudioFocusRequest(focusRequest);
    }

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

    /** PLAY started: hold the audio focus (a call or another app taking it stops the music). */
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void focus(PluginCall call) {
        requestFocus();
    }

    /** {on: true}: in the background with nothing playing (the stream closed, the focus given back); false: back. */
    @PluginMethod
    public void suspend(PluginCall call) {
        if (!NativeAudio.loaded) {
            call.reject("unavailable");
            return;
        }
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        if (on) abandonFocus();
        int err = NativeAudio.suspend(on);
        if (err != 0) {
            call.reject("aaudio " + err);
            return;
        }
        call.resolve();
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
