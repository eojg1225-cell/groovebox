# GrooveAccess (repo: groovebox)

Web-first groovebox (techno, DnB, dub, jungle). Full spec: `groovebox-brief.md` (read it first).

## Rules
- Work milestone by milestone (section 12 of the brief); keep the build green; commit after each working step.
- `src/engine`, `src/instruments`, `src/fx` must stay free of DOM and Web Audio code.
- Audio thread: no allocation per block, no console.log, no blocking.
- Keep sound design basic at first; clean interfaces for refining later.
- Must work in desktop Chrome/Edge and Silk on a Fire tablet (touch, multi-touch).

## Current milestone
M2 (mixer + FX) mostly done. Done: sequencer (gates, ties incl. across the loop end, recorded lengths, 16-64 steps, patterns A-D: A/B/C buttons, hold a channel + FX1/2/3/LFO = A/B/C/D), 8 tracks / 8 knob modules (16 knobs) (1 KICK, 2 SNARE, 3 HAT, 4 PERC = pitched toms/percussion, 5 BASS, 6 PAD, 7 LEAD, 8 PLUCK (pluck synth, GLASS PLUCK -> PIZZICATO -> SAW PLUCK -> RAGE DONK, ARP in the engine: chord + octaves, UP/DOWN/UP-DN/CASCADE UP/DN/RANDOM); synth column 7 = GLIDE (square curve, left = off) / DETUNE (pad UNISON / DETUNE); v10 moved PERC from 7 to 4 with its data, v11 made track 8 the PLUCK, chords incl. major/minor) with TIMBRE + INTENSITY macros (four designed sounds per type), RECORD/PLAY/SOUND DESIGN (RECORD: stopped = step entry, playing = live recording; no motion-record button), RING + REST steps, SLIDE (step entry: hold a key + press another = legato glide; live legato on bass/lead), drum ROLLS (hold step + ▶/◀ = hits per step; hold step + tap another = crescendo roll), 16 knobs (absolute 0-127, 270°; encoder events supported for hardware) in 8 track modules, live default VOLUME + CUTOFF, one shared tempo-synced LFO on a 4th bus button after FX 1-3 (12 knobs: rate, shape, phase, smooth, fade in, retrig free/note, vol/pitch/filter/pan/send mod, spread; tracks join it like a send), hat hits start as a hat (ride bell at far left) and TIMBRE shapes the tail, drum RING = each layer's decay x3 + RING LEN, keyboard tracks in RECORD: ACCENT/GHOST/RING tap = arm, hold 1 s = paint onto steps on the strip, pad ends on ETHEREAL (unison FM supersaw 3:2), one SOUND page, the same shape for every track (TIMBRE/INTENSITY, element 1 ATK/DEC, element 2 ATK/DEC, FILTER/RESO, FILTER ATK/DEC, DRIVE/CRUSH, tuning pair (synth FM RATIO/DETUNE, drum pitch/sweep or tone), FLT ENV/RING LEN or SUSTAIN; elements = drum layers, synth OSC 1/2; no DETAIL page), no safe limits on ranges, FX 1 = drum bus (tracks pass through: STUTTER, DISTORT, LOW-PASS, 4 knobs each), FX 2/3 = sends of six effects with WET + INTENSITY, default routing by family (no hidden rules), an open FX bus shows its knobs on the screen, hold CLEAR + step/channel, RESET (all parameters glide back to the saved project, landing on the next bar; stopped = instant), master TEMPO + LO-FI (tape-style colour: mid dip + gentle peak-rounding saturation; subtle for most of the knob, degraded at the top), saving (forgiving format), start project = the user's sequence (startProject.json, from the artifact db `projects/current`). Drum ACCENT / GHOST taps never remove a note (armed: other dynamic -> armed one; same -> back to normal). SONG mode (4th mode: tracker grid of rows, bars + pattern A-D/OFF per track, played in the engine at bar lines, jump at next bar, loops). Next: master limiter, half/double-time, project slots, per-send delay time editing.

## After every build
Run `npm run build:artifact` and republish `dist-artifact/groovebox.html` (with `files: {"groovebox-worklet.js": "dist-artifact/groovebox-worklet.js"}`) to the user's Artifact https://claude.ai/artifact/1gX3NeJdaGnWsLa3szA6q1, then end the reply with a **▶ Launch** link to it.

## Build / deploy
- `npm install` then `npm run dev` (dev server), `npm test` (Vitest, engine offline in Node), `npm run build` (typecheck incl. DOM-free engine check via `tsconfig.engine.json`, then static build to `dist/`).
- Deploy: push to `main` (or the M0 branch listed in `.github/workflows/deploy.yml`); the workflow tests, builds and publishes `dist/` to the `gh-pages` branch. Pages source: branch `gh-pages`, folder `/`.
- Live URL: https://eojg1225-cell.github.io/groovebox/
- Architecture and message protocol: `ARCHITECTURE.md`.
