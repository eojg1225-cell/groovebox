# Groovebox

Web-first groovebox (techno, DnB, dub, jungle). Full spec: `groovebox-brief.md` (read it first).

## Rules
- Work milestone by milestone (section 12 of the brief); keep the build green; commit after each working step.
- `src/engine`, `src/instruments`, `src/fx` must stay free of DOM and Web Audio code.
- Audio thread: no allocation per block, no console.log, no blocking.
- Keep sound design basic at first; clean interfaces for refining later.
- Must work in desktop Chrome/Edge and Silk on a Fire tablet (touch, multi-touch).

## Current milestone
M1: Sequencer + drums (in progress). Done: worklet sequencer (sample-accurate, swing, polymeter, quantised A/B/C switching, lengths 16-64, note gates), 6 channels, layered DRUM instrument (tone/metal/noise/click + drive/crush, 8 presets), 6-voice SYNTH with chord mode, RECORD/PLAY/SOUND DESIGN modes, 12 knobs (live: 2 per track; design: full parameter pages + TRACK + GLOBAL), coarse params design-only, motion record + clear, accent/ghost, step LEDs, landscape lock/rotation, empty patterns at startup, session persistence. Next: half/double-time, per-step note/gate editing, M2 mixer/FX.

## After every build
Run `npm run build:artifact` and republish `dist-artifact/groovebox.html` (with `files: {"groovebox-worklet.js": "dist-artifact/groovebox-worklet.js"}`) to the user's Artifact https://claude.ai/artifact/1gX3NeJdaGnWsLa3szA6q1, then end the reply with a **▶ Launch** link to it.

## Build / deploy
- `npm install` then `npm run dev` (dev server), `npm test` (Vitest, engine offline in Node), `npm run build` (typecheck incl. DOM-free engine check via `tsconfig.engine.json`, then static build to `dist/`).
- Deploy: push to `main` (or the M0 branch listed in `.github/workflows/deploy.yml`); the workflow tests, builds and publishes `dist/` to the `gh-pages` branch. Pages source: branch `gh-pages`, folder `/`.
- Live URL: https://eojg1225-cell.github.io/groovebox/
- Architecture and message protocol: `ARCHITECTURE.md`.
