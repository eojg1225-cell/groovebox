# Bass TIMBRE Sweep (separate tool, not part of the app)

The BASS track's TIMBRE / INTENSITY on the real engine: NOW (the app) against PROPOSED (GROWL and
SOLID swapped, each sound on its own root-locked carrier : modulator 1:2, 1:3, 2:3, 3:4, 3:2,
switching halfway between neighbours). Auto sweep: the whole knob, 16 bars each way.

    npx vite build --config tools/basssweep/vite.config.ts && node tools/basssweep/pack.mjs

Publish `dist-basssweep-artifact/basssweep.html` with
`files: {"basssweep-worklet.js": "dist-basssweep-artifact/basssweep-worklet.js"}` to
https://claude.ai/artifact/F8XS1MtibTva9apcXuFjdY.
