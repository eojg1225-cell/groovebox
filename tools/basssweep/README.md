# Bass TIMBRE Sweep (separate tool, not part of the app)

The BASS track's TIMBRE / INTENSITY on the real engine: NOW (the app) against PROPOSED (GROWL and
SOLID swapped: SINE SUB, GROWL, ACID, SOLID, FM 2:3; the FM ratio steps 1:2 -> 2:3 -> 3:2 in three
even stretches of the knob). Auto sweep: the whole knob, 16 bars each way.

    npx vite build --config tools/basssweep/vite.config.ts && node tools/basssweep/pack.mjs

Publish `dist-basssweep-artifact/basssweep.html` with
`files: {"basssweep-worklet.js": "dist-basssweep-artifact/basssweep-worklet.js"}` to
https://claude.ai/artifact/F8XS1MtibTva9apcXuFjdY.
