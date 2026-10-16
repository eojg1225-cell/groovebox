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

A title screen fades into the panel; the first touch switches sound on (browsers require a gesture). The instrument is always landscape (full screen + orientation lock on touch devices where allowed; rotated layout on portrait screens). With no session or saved project it opens the **start project** (the sequence in progress, `src/engine/startProject.json`).

**Layout (like a hardware front panel):** screen top left; top right MODE (RECORD / PLAY / SOUND DESIGN), channels 1-6 with MUTE, pattern A/B/C with SAVE PATCH / SAVE PROJECT, the sound design pages (SOUND / TRACK / GLOBAL) and the small **FX 1 2 3** buttons. Below: six recessed track modules (two knobs each, track number between), the function row, step lights, the 16-button strip, and bottom right PLAY with the **TEMPO** and **LO-FI** master knobs.

**Knobs are endless encoders** (as on the planned hardware): they turn without end stops and change values relatively; values are shown on the screen. Drag vertically (400 px = full range, Shift = fine), mouse wheel, double-tap resets.

**Tracks:** 1 KICK, 2 SNARE, 3 HAT, 4 BASS, 5 PAD (chords), 6 LEAD.

**Modes**

| | RECORD | PLAY | SOUND DESIGN |
|---|---|---|---|
| Knobs | Two live knobs per track (default VOLUME + CUTOFF); FX 1-3 show a send | Same | The selected track's page |
| FX 1/2/3 | Open that send on the knobs | Same | Route the selected track to that send (again = no send) |
| Drum strip | Toggle steps | Keyboard (chromatic drum) | Keyboard (audition) |
| Pitched strip | Step entry (cursor; ◀ ▶ REST; hold + ▶ ties); MOTION REC records live | Keyboard | Keyboard (audition) |
| Recorded? | Yes | Never | No |

**Sound design pages:** SOUND (12 knobs; drums: row 1 = first layer + DRIVE, row 2 = second layer + CRUSH), TRACK (type, preset, volume, pan, LIVE 1 / LIVE 2 = what the two live knobs control, cutoff, send level, chord on pitched tracks), GLOBAL (tempo, swing, master, lo-fi). Coarse settings only live here.

**Sounds:** KICK = TONE + CLICK, SNARE = TONE + METAL, HAT = CLICK + METAL. TONE: level, pitch, sweep, sweep time, decay (+ wave on the snare). CLICK: level, tone, resonance, length, noise. METAL: level, pitch, spread/noise, tone, decay. Every drum: DRIVE and CRUSH. BASS (mono, glide), PAD (6-voice, chords MIN7 … MIN11, SUS4), LEAD (mono, glide).

**FX sends:** three sends, each holding six effects with one AMOUNT knob each: DELAY (tempo-synced: send 1 = 3/16, 2 = 1/4, 3 = 1/8; more amount = more feedback), DISTORT, MID CUT (carves the signal feeding the send's other effects), CHORUS, REVERB, COMP (parallel compression). Each track goes to one send with its own SEND LVL. Start: FX 1 dub delay, FX 2 reverb, FX 3 dirt.

**Master:** TEMPO; LO-FI (tape: low-end bump, progressive saturation, high roll-off), saved with the project.

**Sequencing:** notes last one step by default; hold a key + ▶ to tie in step entry; live-recorded notes keep their held length; while live recording the strip follows the playing 16-step block. Keyboard starts on A; dividers mark groups of four.

**Saving:** SAVE PATCH (USER n per track type), SAVE PROJECT (opens next launch), both in this browser's local storage; the working session survives reloads; on claude.ai the project is also mirrored to the artifact's store. The save format is forgiving: notes carry over across format changes.

Keyboard: Space play/stop · 1-6 select channel · Shift+1-6 mute · Q-I / A-K the strip.
