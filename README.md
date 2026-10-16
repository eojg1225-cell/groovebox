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

**Layout (like a hardware front panel):** screen top left; top right MODE (RECORD / PLAY / SOUND DESIGN, set apart at the top), channels 1-6 with MUTE, pattern A/B/C, sound design page buttons. Below: six recessed knob modules separated by grooves, one per track, each with two knobs and the track number printed between them. Then the function row, step lights, the 16-button strip and PLAY.

**Tracks:** 1 KICK, 2 SNARE, 3 HAT, 4 BASS, 5 PAD (chord MIN9), 6 LEAD. A track's type can be changed on its TRACK page.

**Modes**

| | RECORD | PLAY | SOUND DESIGN |
|---|---|---|---|
| Knobs | Live knobs: two per track | Live knobs | The selected track's page |
| Drum strip | Toggle steps | Keyboard (drum tuned chromatically) | Keyboard (audition) |
| Pitched strip | Step entry (cursor; ◀ ▶ REST); with MOTION REC while playing, live notes are recorded | Keyboard | Keyboard (audition) |
| Recorded? | Yes | **Never** | No |
| Pattern A/B/C | Switch immediately | Switch at loop end | Switch immediately |

**Sound design pages:** SOUND (the type's core parameters, one page of up to 12), TRACK (type, preset, volume, pan, LIVE 1 / LIVE 2, delay / distortion / mid-cut sends, chord on pitched tracks), FX (all 12 effect controls) and GLOBAL (BPM, swing, master). Coarse settings (waveforms, modes, type, preset, chord) only live here.

**Sounds**
- **KICK** = TONE + CLICK; **SNARE** = TONE + METAL; **HAT** = CLICK + METAL. TONE: level, pitch, sweep, sweep time, decay, wave. CLICK: level, tone, length. METAL: level, pitch, spread, noise blend, tone, decay, mode (square bank / ring / FM). Every drum also has DRIVE and CRUSH. Presets include industrial ones (IND).
- **BASS** (mono, glide), **PAD** (6-voice, chords: MIN7 … MIN11, SUS4), **LEAD** (mono, glide).

**FX sends:** DELAY (tempo-synced 1/16 to 1 bar, feedback up to 1.1 that runs away gracefully, tone in the feedback path), DISTORTION (drive, tone, soft/hard character), MID-CUT (frequency, width, depth). Each track has three send levels; each effect has a return level. Sends can be put on live knobs.

**Function row:** MOTION REC (RECORD mode only), ACCENT / GHOST, STEPS 16-64, VIEW, OCT − / +, ◀ ▶ REST, CLEAR MOTION. **Step lights** show the playing step (red while recording) and the step-entry cursor (orange).

Knobs: drag vertically (400 px for the full range; Shift = fine), mouse wheel, double-tap to reset. Keyboard: Space play/stop · 1-6 select channel · Shift+1-6 mute · Q-I / A-K the strip.
