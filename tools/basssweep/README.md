# Bass TIMBRE Sweep (separate tool, not part of the app)

The BASS track's TIMBRE / INTENSITY on the real engine (INTENSITY starts at 0). 1 and 2: the
proposed BASS (SINE SUB, GROWL, ACID, SOLID, FM 2:3; FM ratio 1:2 -> 2:3 -> 3:2 in three even
stretches of the knob; INTENSITY no longer moves FM LVL). 1 keeps the first four sounds FM-free,
2 gives them a little FM (0.12-0.15). 3: the app now. Auto sweep: the whole knob, 16 bars each way.

    npx vite build --config tools/basssweep/vite.config.ts && node tools/basssweep/pack.mjs

Publish `dist-basssweep-artifact/basssweep.html` with
`files: {"basssweep-worklet.js": "dist-basssweep-artifact/basssweep-worklet.js"}` to
https://claude.ai/artifact/F8XS1MtibTva9apcXuFjdY.
