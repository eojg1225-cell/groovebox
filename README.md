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

**Knobs** are absolute 0-127 controls with fixed limits and a 270° sweep (TEMPO moves in 0.1 BPM steps). Drag vertically (400 px = full range, Shift = fine), double-tap resets. The control layer also accepts relative **encoder** turns (one detent = one step), as physical rotary encoders on the hardware will send; on screen the mouse wheel uses that path.

**Tracks:** 1 KICK, 2 SNARE, 3 HAT, 4 BASS, 5 PAD (chords), 6 LEAD.

**Modes**

| | RECORD | PLAY | SOUND DESIGN |
|---|---|---|---|
| Knobs | Two live knobs per track (default VOLUME + CUTOFF); FX 1-3 show a send | Same | The selected track's page |
| FX 1/2/3 | Open that send on the knobs; the channel buttons then light for the tracks feeding it — tap one to add / remove it | Same | Route the selected track to that send (again = no send) |
| Drum strip | Toggle steps | Keyboard (chromatic drum) | Keyboard (audition) |
| Pitched strip | Stopped: step entry (cursor; ◀ ▶ REST; hold + ▶ ties). Playing: live recording | Keyboard | Keyboard (audition) |
| Recorded? | Yes | Never | No |

**Sound design pages:** SOUND (per row: four sound knobs, then the track LFO in modules 5-6 — top RATE / SHAPE, bottom VOL MOD / PITCH MOD; drums: layer 1 ×3 + DRIVE, layer 2 ×3 + CRUSH; the PAD page has CHORD), TRACK (type, preset, volume, pan, LIVE 1 / LIVE 2, cutoff, send level, chord on pitched tracks), GLOBAL (tempo, swing, master, lo-fi). Settings without a knob come from the presets, which keeps each sound's character.

**Sounds: TIMBRE and INTENSITY.** Every track has two macro knobs at the start of its sound page. TIMBRE travels through four designed sounds, blending every parameter between them; INTENSITY damps (left) or excites (right) the result, changing character rather than loudness. The detail knobs show what the macros set and can fine-tune it until a macro is turned again. Presets are the named TIMBRE points.

| Track | TIMBRE: low → high | Detail knobs |
|---|---|---|
| KICK (tone + click) | VINTAGE → PUNCH → TECHNO → PSY DOOF | pitch, decay / click, sweep, DRIVE, CRUSH |
| SNARE (tone + metal) | RIMSHOT → TIGHT → BREAK → INDUSTRIAL | pitch, decay / metal, metal decay, DRIVE, CRUSH |
| HAT (click + metal) | RIDE → HAT → CRASH → CHINA | metal pitch, decay / click, metal tone, DRIVE, CRUSH |
| BASS (mono) | SINE SUB → SOLID → GROWL → FM CLANG | glide, octave / filter, reso, decay, sub |
| PAD (6 voices) | WARM → STRINGS → GLASS → DARK | chord, octave / filter, attack, release, detune |
| LEAD (mono) | SINE → SQUARE → SCREAM → BELL | glide, octave / filter, reso, decay, detune |

Chords: MAJOR, MINOR, MIN7, MAJ7, DOM7, MIN9, MAJ9, DOM9, MIN11, SUS4.

**Track LFO:** RATE tempo-synced (4 bars … 1/32, with triplets), SHAPE (sine, square, triangle, saw down, saw up, sample+hold), VOL MOD (tremolo depth) and PITCH MOD (up to ±12 semitones). Phase-locked to the song; restarts with PLAY. Rate and depths can be put on live knobs.

**FX sends:** three sends, each holding six effects with two knobs each: WET (return volume, top row) and INTENSITY (bottom row): DELAY (feedback; tempo-synced, send 1 = 3/16, 2 = 1/4, 3 = 1/8), DISTORT (drive), MID CUT (depth), CHORUS (depth + rate), REVERB (size), COMP (squash). Each track goes to one send with its own SEND LVL. Start: FX 1 dub delay, FX 2 reverb, FX 3 dirt.

**Master:** TEMPO; LO-FI (tape: low-end bump, progressive saturation, high roll-off), saved with the project.

**Sequencing:** notes last one step by default; hold a key + ▶ to tie in step entry; live-recorded notes keep their held length; while recording the strip follows the playing 16-step block. **RING** (armed like ACCENT): the hit rings until the next hit or rest on its track — pitched notes are held, drums get a long decay that the next hit chokes (a closed hat becomes an open hat). **REST** places a stop marker (drums: arm REST, tap steps; step entry: at the cursor). Keyboard starts on A; dividers mark groups of four.

**Saving:** SAVE PATCH (USER n per track type), SAVE PROJECT (opens next launch), both in this browser's local storage; the working session survives reloads; on claude.ai the project is also mirrored to the artifact's store. The save format is forgiving: notes carry over across format changes.

Keyboard: Space play/stop · 1-6 select channel · Shift+1-6 mute · Q-I / A-K the strip.
