package com.garibaldi.grooveaccess;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

/**
 * The GrooveAccess app: the web build (assets/public) in Capacitor's WebView, served from
 * https://localhost. Landscape (AndroidManifest), full screen with the system bars hidden
 * (a swipe shows them for a moment), audio allowed to start without a tap, and the
 * KeepAwake plugin for MENU > GLOBAL SETTINGS > KEEP SCREEN ON.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAwakePlugin.class);
        registerPlugin(ProjectFilesPlugin.class);
        super.onCreate(savedInstanceState);
        WebSettings web = getBridge().getWebView().getSettings();
        web.setMediaPlaybackRequiresUserGesture(false);
        // Under a notch / camera cutout too, so the panel gets the whole screen.
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        immersive();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    private void immersive() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.hide(WindowInsetsCompat.Type.systemBars());
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
