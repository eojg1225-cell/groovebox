# TIMBRE Sound Test (separate tool, not part of the app)

Plays a GrooveAccess project (`project.json`, a copy of the artifact db `projects/current`) with
the BASS or PLUCK sound driven only by TIMBRE and INT, under a choice of rules for how TIMBRE
moves between the five designed sounds (morph now, morph everything incl. envelopes / width,
crossfade, hold-then-morph, snap). Uses the real engine (two engines in one worklet for the
crossfade).

    npx vite build --config tools/soundtest/vite.config.ts && node tools/soundtest/pack.mjs

Publish `dist-soundtest-artifact/soundtest.html` with
`files: {"soundtest-worklet.js": "dist-soundtest-artifact/soundtest-worklet.js"}`.
