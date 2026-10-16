# Groovebox

Web-first groovebox (techno, DnB, dub, jungle). Full spec: `groovebox-brief.md` (read it first).

## Rules
- Work milestone by milestone (section 12 of the brief); keep the build green; commit after each working step.
- `src/engine`, `src/instruments`, `src/fx` must stay free of DOM and Web Audio code.
- Audio thread: no allocation per block, no console.log, no blocking.
- Keep sound design basic at first; clean interfaces for refining later.
- Must work in desktop Chrome/Edge and Silk on a Fire tablet (touch, multi-touch).

## Current milestone
M2 (mixer + FX) mostly done. Done: sequencer (gates, ties, recorded lengths, 16-64 steps, A/B/C), 6 tracks (layered KICK/SNARE/HAT, BASS/PAD/LEAD, chords incl. major/minor) with TIMBRE + INTENSITY macros (four designed sounds per type), RECORD/PLAY/SOUND DESIGN (RECORD: stopped = step entry, playing = live recording; no motion-record button), RING + REST steps, SLIDE (step entry: hold a key + press another = legato glide; live legato on bass/lead), drum ROLLS (hold step + ▶/◀ = hits per step; hold step + tap another = crescendo roll), 12 knobs (absolute 0-127, 270°; encoder events supported for hardware) in 6 track modules, live default VOLUME + CUTOFF, per-track tempo-synced LFO (rate, shape, vol/pitch mod), SOUND page identical for every track (TIMBRE/INTENSITY, ATTACK/DECAY, FILTER/RESO, LFO x2, DRIVE/CRUSH) + DETAIL page, no safe limits on ranges, FX 1 = drum bus (tracks pass through: STUTTER, DISTORT, LOW-PASS, 4 knobs each), FX 2/3 = sends of six effects with WET + INTENSITY, default routing by family (no hidden rules), an open FX bus shows its knobs on the screen, hold CLEAR + step/channel, master TEMPO + LO-FI, saving (forgiving format), start project = the user's sequence (startProject.json, from the artifact db `projects/current`). **Do at the next build (user request):** drum ACCENT / GHOST taps never remove a note: with ACCENT (or GHOST) armed, tapping a hit of another dynamic overwrites it with the armed one; tapping a hit that already has the armed dynamic takes it back to normal and keeps the note. (Unarmed tap = remove, unchanged.) Next: master limiter, half/double-time, project slots, per-send delay time editing.

## After every build
Run `npm run build:artifact` and republish `dist-artifact/groovebox.html` (with `files: {"groovebox-worklet.js": "dist-artifact/groovebox-worklet.js"}`) to the user's Artifact https://claude.ai/artifact/1gX3NeJdaGnWsLa3szA6q1, then end the reply with a **▶ Launch** link to it.

## Build / deploy
- `npm install` then `npm run dev` (dev server), `npm test` (Vitest, engine offline in Node), `npm run build` (typecheck incl. DOM-free engine check via `tsconfig.engine.json`, then static build to `dist/`).
- Deploy: push to `main` (or the M0 branch listed in `.github/workflows/deploy.yml`); the workflow tests, builds and publishes `dist/` to the `gh-pages` branch. Pages source: branch `gh-pages`, folder `/`.
- Live URL: https://eojg1225-cell.github.io/groovebox/
- Architecture and message protocol: `ARCHITECTURE.md`.
