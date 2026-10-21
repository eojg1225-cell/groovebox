# Bass TIMBRE Sweep (separate tool, not part of the app)

The BASS track's TIMBRE / INTENSITY on the real engine, comparing how the FM ratios move between
GROWL and FM 2:3: NOW (the carrier switches 1 -> 3 halfway, as in the app) or STEPPED
(carrier : modulator 1:2 -> 2:3 -> 3:2, each root-locked). Auto sweep: 8 bars each way.

    npx vite build --config tools/basssweep/vite.config.ts && node tools/basssweep/pack.mjs

Publish `dist-basssweep-artifact/basssweep.html` with
`files: {"basssweep-worklet.js": "dist-basssweep-artifact/basssweep-worklet.js"}` to
https://claude.ai/artifact/F8XS1MtibTva9apcXuFjdY.
