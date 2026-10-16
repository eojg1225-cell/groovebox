# Groovebox

Web-first groovebox (techno, DnB, dub, jungle). Full spec: `groovebox-brief.md` (read it first).

## Rules
- Work milestone by milestone (section 12 of the brief); keep the build green; commit after each working step.
- `src/engine`, `src/instruments`, `src/fx` must stay free of DOM and Web Audio code.
- Audio thread: no allocation per block, no console.log, no blocking.
- Keep sound design basic at first; clean interfaces for refining later.
- Must work in desktop Chrome/Edge and Silk on a Fire tablet (touch, multi-touch).

## Current milestone
M1 done, M2 (mixer + FX sends) in progress. Done: sequencer (sample-accurate, swing, polymeter, A/B/C, 16-64 steps, gates), 6 tracks (KICK/SNARE/HAT layered drums, BASS/PAD/LEAD synths, chord mode), RECORD/PLAY/SOUND DESIGN (PLAY never records), 12 knobs in 6 track modules, motion record (RECORD only), accent/ghost, step LEDs, send FX (delay, distortion, mid-cut) with per-track sends and FX page, landscape lock/rotation, session persistence. Next: master limiter, half/double-time, per-step note/gate editing.

## After every build
Run `npm run build:artifact` and republish `dist-artifact/groovebox.html` (with `files: {"groovebox-worklet.js": "dist-artifact/groovebox-worklet.js"}`) to the user's Artifact https://claude.ai/artifact/1gX3NeJdaGnWsLa3szA6q1, then end the reply with a **▶ Launch** link to it.

## Build / deploy
- `npm install` then `npm run dev` (dev server), `npm test` (Vitest, engine offline in Node), `npm run build` (typecheck incl. DOM-free engine check via `tsconfig.engine.json`, then static build to `dist/`).
- Deploy: push to `main` (or the M0 branch listed in `.github/workflows/deploy.yml`); the workflow tests, builds and publishes `dist/` to the `gh-pages` branch. Pages source: branch `gh-pages`, folder `/`.
- Live URL: https://eojg1225-cell.github.io/groovebox/
- Architecture and message protocol: `ARCHITECTURE.md`.
