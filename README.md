# Groovebox

Web-first groovebox for techno, DnB, dub and jungle. Runs in desktop Chrome/Edge and Silk on a Fire tablet; nothing to install.

**Live build:** https://eojg1225-cell.github.io/groovebox/

Spec: [`groovebox-brief.md`](groovebox-brief.md). Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Launcher (home-screen icon)

The app is installable, so it opens full screen in landscape from its own icon and also works offline once it has loaded.

- **Fire tablet (Silk):** open the URL, tap the menu (⋮ / ☰), choose **Add to Home Screen**, confirm.
- **Desktop Chrome/Edge:** click the install icon at the right of the address bar (or menu → *Install Groovebox* / *Apps → Install this site as an app*).

In a normal touch-browser tab, "Tap to start" also switches to full screen.

## Develop

```sh
npm install
npm run dev        # dev server (also on your LAN, for testing on the tablet)
npm test           # offline engine tests in Node (Vitest)
npm run build      # typecheck (incl. DOM-free engine check) + static build into dist/
npm run preview    # serve dist/ locally
npm run build:artifact  # also pack a single-page copy into dist-artifact/ for publishing as a claude.ai Artifact
```

Note: AudioWorklet needs a secure context, so on another device use the HTTPS Pages URL (plain `http://<lan-ip>` will not start audio).

## Current state

A title screen fades into the panel; the first touch switches sound on (browsers require a gesture). The instrument is always landscape: on touch devices it goes full screen and locks landscape where the browser allows; on any portrait screen the panel is drawn rotated. Every pattern starts empty.

**Top right:** MODE (RECORD / PLAY / SOUND DESIGN, kept apart at the top), channels 1-6 with MUTE, pattern A/B/C, and the sound design page buttons.

**Modes**

| | RECORD (building) | PLAY (performing) | SOUND DESIGN |
|---|---|---|---|
| 12 knobs | Live knobs: one column per track, 2 each | Live knobs | Every parameter of the selected track, by page |
| Drum strip | Toggle steps; VIEW pages long patterns | Toggle steps live; view follows the playhead | Toggle steps |
| Pitched strip | Step-entry keyboard (cursor; ◀ ▶ REST) | Live keyboard (recorded with MOTION REC) | Audition keyboard |
| Pattern A/B/C | Switch immediately | Switch at loop end | Switch immediately |

Sound design pages: the instrument's pages, then **TRACK** (type DRUM/SYNTH, preset, volume, pan, LIVE 1 / LIVE 2 assignment, chord mode for synths) and **GLOBAL** (BPM, swing, master). Coarse settings (waveforms, layer modes, filter types, type, preset, chord) only live here; the live knobs can only be given the subtler parameters. The screen draws the 12 knobs with their values.

**Instruments**
- **DRUM**, built from layers: TONE (pitch, sweep, sweep time, decay, drive, wave), CLICK (level, tone, length), METAL (six-oscillator square bank, ring-mod or FM; pitch, spread, tone, decay), NOISE (LP/BP/HP, cutoff, resonance, decay, clap bursts), and a master DRIVE and CRUSH (bit and sample-rate reduction). Presets: KICK, SNARE, HAT, OPEN HAT, CLAP, METAL, IND KICK, IND HIT.
- **SYNTH**, 6-voice: saw/square/triangle/sine with detune (reese), sub, octave, poly/mono with glide, resonant low-pass with envelope, drive, ADSR. Presets: BASS, REESE, SUB, STAB, PAD. **Chord mode:** MIN7, MAJ7, DOM7, MIN9, MAJ9, DOM9, MIN11, SUS4.

Default tracks: 1 KICK, 2 SNARE, 3 HAT, 4 METAL, 5 BASS, 6 STAB (chord MIN9).

**Function row:** MOTION REC (live-knob moves become per-step locks on that track; live notes land on the nearest step), ACCENT / GHOST (louder and brighter / quieter and darker), STEPS 16-64, VIEW, OCT − / +, ◀ ▶ REST (step entry), CLEAR MOTION (removes the selected pattern's recorded knob motion).

**Step lights** above the strip show the step being played (red while motion recording) and the step-entry cursor (orange).

Patterns and settings are kept for the browser session.

Keyboard: Space play/stop · 1-6 select channel · Shift+1-6 mute · Q-I / A-K the 16 strip buttons. Knobs: drag vertically (Shift = fine), mouse wheel, double-tap to reset.
