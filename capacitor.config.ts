import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android / Fire app: `dist/` (the web build) in a Capacitor shell. Served from
 * https://localhost, a secure context, so AudioWorklet works. Native settings (landscape,
 * immersive, media without a gesture, keep screen on) are in android/app/src/main.
 */
const config: CapacitorConfig = {
  appId: 'com.garibaldi.grooveaccess',
  appName: 'GrooveAccess',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  android: { backgroundColor: '#000000' },
};

export default config;
