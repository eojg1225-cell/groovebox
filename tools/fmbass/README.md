# FM Bass Ratios (separate tool, not part of the app)

A dance bass line on the real engine with the BASS FM modulator at 3 : 2 (x1.5) or 2 : 3 (x0.67),
same settings otherwise (FM LEVEL, FLT ENV, CUTOFF, DECAY, OCTAVE), plus today's FM CLANG.

    npx vite build --config tools/fmbass/vite.config.ts && node tools/fmbass/pack.mjs

Publish `dist-fmbass-artifact/fmbass.html` with
`files: {"fmbass-worklet.js": "dist-fmbass-artifact/fmbass-worklet.js"}` to
https://claude.ai/artifact/MyCaf3EEozZrMLGthRXSha.
