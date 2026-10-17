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
| Knobs | Two live knobs per track (default VOLUME + CUTOFF); FX 1-3 show a bus | Same | The selected track's page |
| FX 1/2/3 | Open that bus: its controls fill the knobs **and the screen** (the sequencer returns when it is closed); the channel buttons light for the tracks on it — tap one to add / remove it | Same | Put the selected track on / off that bus |
| CLEAR (hold) | + step: clear that step (a note tied over it ends before it); + channel button: clear that track's current pattern. While held the strip shows steps | Same | — |
| Drum strip | Toggle steps (a hit is removed on release). With ACCENT / GHOST armed a tap never removes a hit: another dynamic becomes the armed one, the same one goes back to normal. **Rolls:** hold a step + ▶ / ◀ = more / fewer hits inside it (up to 8); hold a step + tap another = a roll between them (double hits rising from ghost to accent) | Keyboard (chromatic drum) | Keyboard (audition) |
| Pitched strip | Stopped: step entry (cursor; ◀ ▶ move it and play the note on the step landed on; REST; hold + ▶ ties). **Slide:** hold a key + press another = the new note goes on the step after the held one and the held note glides into it (legato, no new attack; the sound's GLIDE or 60 ms). Playing: live recording (legato on bass / lead records slides) | Keyboard (bass / lead slide when played legato) | Keyboard (audition) |
| Recorded? | Yes | Never | No |

**Sound design pages:** SOUND — the same shape on every track, one column per module: 1 TIMBRE / INTENSITY, 2 element 1 ATTACK / DECAY, 3 element 2 ATTACK / DECAY, 4 FILTER / RESO, 5 FILTER ATTACK / FILTER DECAY, 6 DRIVE / CRUSH. Elements: KICK tone + click, SNARE tone + metal, HAT click + metal, BASS / PAD / LEAD OSC 1 + OSC 2 (OSC 2 = the detuned oscillator; sustain / release shared). Press SOUND again for **DETAIL** (the type's layers, the filter ENV amount, synth glide or chord / sustain / release / level). TRACK (type, preset, volume, pan, LIVE 1 / LIVE 2, cutoff, send level, chord on pitched tracks), GLOBAL (tempo, swing, master, lo-fi). Synth DECAY is aggressive: from 0.45 s down it also cuts the sustain and the release away, so any sound — a held pad chord too — goes to a stab (≈0.12 s) and, at the bottom, a click. The element and filter envelopes sit on top of the macros (TIMBRE sets synth envelopes; drum attacks and the filter are yours).

**No safe limits:** ranges go well past sensible (drive to 200×, resonance to self-oscillation, pitch sweeps of 8 octaves, decays to 20 s, LFO pitch to 48 semitones, tempo 40-300). Only the master soft-clip stays, so the output can't hard-clip.

**Sounds: TIMBRE and INTENSITY.** Every track has two macro knobs at the start of its sound page. TIMBRE travels through four designed sounds, blending every parameter between them; INTENSITY damps (left) or excites (right) the result, changing character rather than loudness. The detail knobs show what the macros set and can fine-tune it until a macro is turned again. Presets are the named TIMBRE points.

| Track | TIMBRE: low → high | Detail knobs |
|---|---|---|
| KICK (tone + click) | VINTAGE → PUNCH → TECHNO → PSY DOOF (absurd: ~7-octave zap into a square-driven doof) | tone row / click row |
| SNARE (tone + metal) | RIMSHOT → TIGHT → BREAK → INDUSTRIAL | tone row / metal row |
| HAT (click + metal; every hit starts as a hat — a ride bell at the far left — and TIMBRE shapes the tail) | RIDE → HAT → CRASH → CHINA | click row / metal row |
| BASS (mono) | SINE SUB → SOLID → GROWL → FM CLANG | oscillators / glide, envelopes, level |
| PAD (6 voices) | GLASS → WARM → STRINGS → ETHEREAL (FM supersaw: unison saws, FM at 3:2, swelling) | oscillators / chord, envelopes, level |
| LEAD (mono) | SINE → SQUARE → SCREAM → BELL | oscillators / glide, envelopes, level |

Chords: MAJOR, MINOR, MIN7, MAJ7, DOM7, MIN9, MAJ9, DOM9, MIN11, SUS4.

**LFO:** one LFO, opened with the **LFO** button after FX 1-3 (knobs and screen show it; the channel buttons put tracks on / off it, like a send). Twelve knobs, one module each: RATE / SHAPE (tempo-synced 4 bars … 1/64 with triplets; sine, square, triangle, saw down, saw up, sample+hold), PHASE / SMOOTH (slew), FADE IN (up to 4 bars, from PLAY or each note) / RETRIG (FREE = locked to the song, NOTE = restarts on each of the track's notes), VOL MOD / PITCH MOD (±48 st), FILTER MOD (±8 octaves on the sound filter) / PAN MOD, SEND MOD (pushes the send level, for dub throws) / SPREAD (offsets each track's phase, so tracks move against each other). Rate and depths can be put on live knobs. Older saves: tracks that used their own LFO join the shared one.

**FX 1 — drum bus:** tracks on it pass *through* it (100% wet), so it replaces rather than adds. Transparent at its defaults. Three effects, four knobs each (two modules per effect): **STUTTER** (amount — turning it up captures one GRID length on the next grid line and repeats it; GRID 1/2 … 1/64 with triplets, turning it while running rolls; FADE per repeat; PITCH per repeat, cumulative), **DISTORT** (DRIVE 0-60 dB, TONE, CRUSH, LEVEL), **LOW-PASS** (CUTOFF, RESO to self-oscillation, ENV follower ± up to 8 octaves, its REL). Chain: stutter → distort → low-pass.

**FX 2 / FX 3 — sends:** six effects each, WET (labelled with the effect, top row) and INTENSITY (bottom row): DELAY (feedback; tempo-synced, FX 2 = 3/16 dub, FX 3 = 1/4), DISTORT, MID CUT, CHORUS, REVERB, COMP. A track goes to one send (own SEND LVL, taken before the drum bus), and can be on FX 1 at the same time.

**Default routing** (a starting point, freely changed, no hidden rules): drums on FX 1, bass + lead to FX 2 (dub delay), pad to FX 3 (reverb + chorus). Older saves keep their routing (old delay send → FX 2, reverb send → FX 3; drum tracks join FX 1).

**Master:** TEMPO; LO-FI (tape: low-end bump, progressive saturation, high roll-off), saved with the project.

**Sequencing:** notes last one step by default; hold a key + ▶ to tie in step entry; live-recorded notes keep their held length; while recording the strip follows the playing 16-step block. **RING** (armed like ACCENT): the hit rings until the next hit or rest on its track — pitched notes are held, drums add the sound's RING LEN to their decay (a natural length per sound: open hat ~0.5 s, crash ~2 s; on DETAIL), choked by the next hit. **REST** places a stop marker (drums: arm REST, tap steps; step entry: at the cursor). Keyboard starts on A; dividers mark groups of four.

**Saving:** SAVE PATCH (USER n per track type), SAVE PROJECT (opens next launch), both in this browser's local storage; the working session survives reloads; on claude.ai the project is also mirrored to the artifact's store. The save format is forgiving: notes carry over across format changes.

Keyboard: Space play/stop · 1-6 select channel · Shift+1-6 mute · Q-I / A-K the strip.
