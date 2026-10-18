# GrooveAccess

*A Garibaldi Production*

Web-first groovebox for techno, DnB, dub and jungle. Runs in desktop Chrome/Edge and Silk on a Fire tablet; nothing to install.

**Live build:** https://eojg1225-cell.github.io/groovebox/

Spec: [`groovebox-brief.md`](groovebox-brief.md). Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Launcher (home-screen icon)

The app is installable, so it opens full screen in landscape from its own icon and also works offline once it has loaded.

- **Fire tablet (Silk):** open the URL, tap the menu (⋮ / ☰), choose **Add to Home Screen**, confirm.
- **Desktop Chrome/Edge:** click the install icon at the right of the address bar (or menu → *Install GrooveAccess* / *Apps → Install this site as an app*).

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

**Layout (like a hardware front panel):** screen top left; top right MODE (RECORD / PLAY / DESIGN / SONG), channels 1-6 with MUTE, pattern A/B/C with SAVE PATCH / SAVE PROJECT, the DESIGN pages (TRACK / MIX / PROJECT) and the small **FX 1 2 3** buttons. Below: six recessed track modules (two knobs each, track number between), the function row, step lights, the 16-button strip, and bottom right PLAY with the **TEMPO** and **LO-FI** master knobs.

**Knobs** are absolute 0-127 controls with fixed limits and a 270° sweep (TEMPO moves in 0.1 BPM steps). Drag vertically (400 px = full range, Shift = fine), double-tap resets. The control layer also accepts relative **encoder** turns (one detent = one step), as physical rotary encoders on the hardware will send; on screen the mouse wheel uses that path.

**Tracks:** 1 KICK, 2 SNARE, 3 HAT, 4 BASS, 5 PAD (chords), 6 LEAD.

**Modes**

| | RECORD | PLAY | DESIGN |
|---|---|---|---|
| Knobs | Two live knobs per track (FUNC: two more). **Relative**: centred (SET) they leave the sound as set on the SOUND page; turned they push it down / up (±100 % = up to 60 % of each parameter's range, on its own curve, clamped at its limits; a gentle log taper — halfway gives 40 % of the push — keeps the centre fine); RESET glides them back to the centre. Macros move several parameters: KICK DECAY / PUNCH (FUNC VOLUME / TUNE), SNARE DECAY / SNAP (VOLUME / TUNE), HAT DECAY / CUTOFF (VOLUME / BRIGHT), PERC DECAY / CUTOFF (VOLUME / TUNE), BASS CUTOFF / RESO (VOLUME / ENV), PAD CUTOFF / SWELL (VOLUME / WIDTH), LEAD CUTOFF / GRIT (VOLUME / LENGTH), PLUCK LENGTH / CUTOFF (VOLUME / BITE). CUTOFF, RESO, VOLUME (the mixer) and the LFO stay absolute. FX 1-3 show a bus | Same | The selected track's page (FUNC: its second layer) |
| FX 1/2/3 | Open that bus: its controls fill the knobs **and the screen** (the sequencer returns when it is closed); the channel buttons light for the tracks on it — tap one to add / remove it | Same | Put the selected track on / off that bus |
| CLEAR (hold) | + step: clear that step (a note tied over it ends before it); + channel button: clear that track's current pattern. While held the strip shows steps | Same | — |
| COPY (hold) | + channel button: copy the selected track's current pattern (length, notes, flags) into the same pattern slot of that track; + FX 1 / 2 / 3 / LFO: into pattern A / B / C / D of the selected track. Onto KICK, SNARE and HAT the notes don't carry over (their hits play as designed); PERC and the synths keep them. Locks only copy to a track of the same type. |
| RESET | Every parameter returns to the saved project (SAVE PROJECT; if nothing was saved, to how the session started): while playing it glides back and lands on the next bar line (a sweep you can play with); stopped, it jumps. A knob you touch during the glide is yours again. Tempo, master volume, routing, mutes and patterns are left alone | Same | Same |
| Drum strip | Toggle steps (a hit is removed on release). With ACCENT / GHOST / RING / ROLL armed a tap never removes a hit: another dynamic becomes the armed one, the same one goes back to normal, RING and ROLL toggle on their own; new hits take what is armed. While RING or ROLL is armed every hit is dim and the ones carrying it light up fully. **ROLL** (the SLIDE button on drum tracks): the hit repeats at the sound's ROLL DIV (1/32, 1/32T, 1/64, 1/64T, 1/128; turnable live). **Counted rolls:** hold a step + ▶ / ◀ = more / fewer hits inside it (up to 8); hold a step + tap another = a roll between them (double hits rising from ghost to accent) | Keyboard (chromatic drum) | Keyboard (audition) |
| Pitched strip | Stopped: step entry (cursor; ◀ ▶ move it and play the note on the step landed on; **RING / SLIDE / ACCENT / GHOST: tap** and the strip shows the steps — tap a note's step to put the flag on / take it off (ACCENT / GHOST: another dynamic -> this one, the same -> back to normal); tap the button again for the keyboard (one at a time); while RING or SLIDE is on, every note on the strip is dim (like a ghost note) and the ones that carry it light up fully, with the other flags hidden; REST; hold + ▶ ties — a tie can run past the end of the pattern and on from the start, up to a whole loop). **RING / SLIDE / ACCENT / GHOST in PLAY** are performance effects: tap one and every note on the selected track plays as a RING (held until the next hit), SLIDE (drums: ROLL at the sound's ROLL DIV), ACCENT or GHOST note until you tap it again (ACCENT and GHOST exclude each other; keys you play live take the dynamic too); the steps are not changed, and leaving PLAY turns it off. **SLIDE** (303 style): a note marked SLIDE is held until the next note and glides into it (legato, no new attack, its envelopes held up at 75 % or more until it lands; glide time = the sound's SLIDE knob, column 7, left = instant; pad / pluck 60 ms). Only slides glide. Hold a key + press another = the new note goes on the step after the held one and the held note is marked SLIDE. Playing: live recording (legato on bass / lead records slides) | Keyboard (bass / lead slide when played legato) | Keyboard (audition) |
| Recorded? | Yes | Never | No |

**Eight tracks, 16 knobs:** 1 KICK, 2 SNARE, 3 HAT, 4 PERC (toms / percussion, pitched from the sequencer: step entry on the keyboard), 5 BASS, 6 CHORD (chord stabs), 7 LEAD, 8 PLUCK (pluck synth with an ARP) (any track can be any type). Eight knob modules, one per track; four patterns A-D per track (A/B/C buttons for the selected track; **hold a channel button** and FX 1 / 2 / 3 / LFO become its A / B / C / D).

**ARP** (PLUCK): while a note is held, its chord (CHORD knob: MAJOR … MIN11, MAJ11, 5TH, 5TH+OCT) over ARP OCT octaves (1-3) is played in turn: UP, DOWN, UP/DN, CASC UP (overlapping skips: 1 5 3 7 5 9 …), CASC DN (from the top: 11 7 9 5 7 3 …), RANDOM, at 1/4 … 1/32 incl. triplets. Hold sequenced notes longer (tie, or RING) for longer runs; it plays live too.

**SONG mode** (4th mode button): a tracker-style grid. Each row lasts BARS bars and gives every track a pattern (A-D) or OFF (silent); at a row start every track restarts its row pattern, and the song loops from the top after the last row. Knobs: top = each track's pattern in the cursor row, bottom 1 = BARS, 2 = ROW. ◀ ▶ = column, ROW ▲ / ▼ = row, INSERT ROW (a copy of the cursor row, after it) / DELETE ROW, A/B/C (or hold a track + FX 1/2/3/LFO for A-D) set a cell, the strip = rows (tap to move; while the song plays, it jumps there at the next bar). PLAY in SONG mode plays the song from the cursor row, sample-accurately in the engine, and keeps playing when you switch modes to tweak sounds; PLAY elsewhere plays the patterns as before.

**Three layers, each on top of the one below:** live knobs > SOUND page > TIMBRE / INTENSITY. TIMBRE picks the sound (coarse: waveform, FM ratio, layer balance, a designed value for every parameter); INTENSITY sets the amount of modulation / atmosphere — at 50 % the sound as designed, down to 0 its FM, filter envelope, sweep, noise, click, drive and width converge on a dull floor (PERC becomes soft thuds, SAW PLUCK no harsher than GLASS) keeping a 2 % trace of the TIMBRE; above 50 % FM follows a DX7-style taper (75 % = operator level 60, the top quarter runs on to 99 — the bite lives there) while width, drive and brightness only rise a little. Between TIMBRE's sounds FM ratios step through related ratios (1, 4/3, 3/2, 2 …) instead of smearing. SOUND page knobs adjust on top: a change to a parameter TIMBRE / INTENSITY also set is kept as an offset (a trim), so moving TIMBRE or INTENSITY afterwards keeps it (a darker CUTOFF stays darker on the next sound); the knob shows the resulting value. Live knobs push only SOUND page parameters, relative to all that.

**Sound design pages:** SOUND — one page, one column per module. Synths: 1 TIMBRE / INTENSITY, 2 OSC 1 ATTACK / DECAY, 3 OSC 2 ATTACK / DECAY, 4 CUTOFF / RESO (the sound's filter — tracks have no separate mixer filter), 5 FILTER ATTACK / FILTER DECAY, 6 DRIVE / CRUSH, 7 the type's pair (BASS SLIDE time / SUB, LEAD SLIDE / CARRIERS — SLIDE fully left = instant; CHORD CHORD / UNISON; PLUCK CHORD / ARP OCT), 8 FLT ENV / FM LVL (the FM / modulation level — the FM ratio stays part of each sound; PLUCK ARP / ARP RATE). Drums (no filter per drum: FX 1's FILTER is the kit's): 1 TIMBRE / INTENSITY, 2-3 each element's ATTACK / DECAY, 4 both elements' pitch, 5 their colour, 6 DRIVE / CRUSH, 7 ROLL DIV / BALANCE (element 1 ↔ 2, centre = as designed), 8 the type's own pair — KICK: TONE PITCH / CLICK TONE, SWEEP / CLICK RESO, SWEEP TIME / CLICK NOISE; SNARE: TONE PITCH / WIRE PITCH, SWEEP / WIRE TONE, NOISE / SPREAD; HAT: CLICK TONE / METAL PITCH, CLICK RESO / METAL TONE, NOISE / HEAD (how long it stays a closed hat before the tail); PERC (the step's note sets the pitch): DETUNE (metal + click up to ±1 semitone off the tone, which stays on the note) / INTERVAL (the metal's semitones above the tone, default an octave), SWEEP / CLICK TONE (follows the note), METAL level / CLICK NOISE. Elements: KICK tone + click, SNARE tone + metal, HAT click + metal, PERC tone + click, BASS / PAD / LEAD / PLUCK OSC 1 + OSC 2 (OSC 2 = the detuned oscillator), each with its own ATTACK / DECAY / SUSTAIN / RELEASE. Everything else is set by TIMBRE / INTENSITY.

**FUNC** (beside PLAY; keyboard Z): hold it and the knobs show their second layer (the screen says FN); a quick tap latches it on / off (for a mouse). TRACK with FUNC — synths: 1 SHAPE (FM RATIO is part of each sound's character, set only by TIMBRE), 2-3 each oscillator's SUSTAIN / RELEASE, 7 OCTAVE / DETUNE, CHORD 4 CARRIERS, PLUCK 4 UNISON and 8 FLT ENV / FM. Drums: 1 tone WAVE (SNARE WAVE / METAL MODE, HAT METAL MODE / FM, PERC WAVE / SWEEP TIME), 2-3 each layer's LEVEL, SNARE 7 METAL FM, HAT 7 HEAD TONE / HEAD PITCH and 8 HEAD NOISE / SPREAD, PERC 4 CLICK RESO, 5 METAL TONE / SPREAD, 8 METAL MODE / FM. Empty FUNC slots do nothing. **MIX**: one module per track (knob = track number): VOLUME on top, SEND level below; with FUNC, PAN on top and **ACC/GHOST** below (how far accents and ghosts sit from normal hits — 100 % as designed, 0 % every hit the same, 200 % twice the difference, both ways at once). **PROJECT**: TEMPO, SWING, MASTER, LO-FI on top; below, the selected track's PRESET, LIVE 1 / LIVE 2 (LIVE 3 / 4 with FUNC: what its live knobs control while FUNC is held in RECORD / PLAY) and CHORD (synths). **DRIVE** on every track is level-compensated: the track is turned down as DRIVE rises (about +2.5 dB left at full drive), so it adds colour rather than volume; VOLUME itself is untouched. Synth DECAY is aggressive: from 0.45 s down it also cuts the sustain and the release away, so any sound — a held pad chord too — goes to a stab (≈0.12 s) and, at the bottom, a click.

**No safe limits:** ranges go well past sensible (drive to 200×, resonance to self-oscillation, pitch sweeps of 8 octaves, decays to 20 s, LFO pitch to 48 semitones, tempo 40-300). The master runs through a clean look-ahead limiter (−1 dBFS ceiling), so the output never clips and is not coloured below the ceiling.

**Sounds: TIMBRE and INTENSITY.** Every track has two macro knobs at the start of its sound page. TIMBRE travels through four designed sounds, blending every parameter between them; INTENSITY damps (left) or excites (right) the result, changing character rather than loudness. The detail knobs show what the macros set and can fine-tune it until a macro is turned again. Presets are the named TIMBRE points.

| Track | TIMBRE: low → high | Detail knobs |
|---|---|---|
| KICK (tone + click) | 808 BOOM → VINTAGE → PUNCH → TECHNO → PSY DOOF (absurd: ~7-octave zap into a square-driven doof) | tone row / click row |
| SNARE (tone + metal) | RIMSHOT → PICCOLO → TIGHT → BREAK → INDUSTRIAL | tone row / metal row |
| HAT (click + metal; every hit starts as a hat — a ride bell at the far left — and TIMBRE shapes the tail) | RIDE → HAT → SPLASH → CRASH → CHINA |
| PERC (tone + click + metal; pitched per step) | LOW TOM → SYN DRUM → CONGA → COWBELL → CLAVE, all in the same octave (tone layer on the step's note, metal INTERVAL above, an octave by default), so switching TIMBRE never moves a line's pitch (INTENSITY's top quarter turns any of them into a warped clang: the metal layer comes in and goes ring-mod → FM, the sweep runs to 2 octaves, the click resonates, drive to 6×) | click row / metal row |
| BASS (mono) | SINE SUB → SOLID → 303 → GROWL → FM CLANG | oscillators / glide, envelopes, level |
| CHORD (track 6; 6 voices, chords, set up for stabs: fast attack, short decay, no sustain by default; the same 3-carrier engine as the LEAD) | GLASS (1 : 2 : 3) → TINE (1 : 1 : 4, DX7 e-piano) → WARM (1 : 1 : ½, saws) → STRINGS (1 : 3/2 : 2) → ETHEREAL (odd carriers 1 : 3 : 5 on a 7× modulator: a clear, hollow body with a high shimmer as INTENSITY rises). INTENSITY 0 = carrier 1 alone, a plain pad; the stack and the DX7-style FM come in as it rises | oscillators / chord, envelopes, level |
| LEAD (mono; DX7-style: one feedback modulator into three carriers playing simple waves) | ODD 2:3 → ORGAN (drawbar carriers 1 : 2 : 3 — bass or lead) → SAW 1:1 → OCT 1:2 → FIFTH 3:2 (carrier ratios). INTENSITY 0 = carrier 1 alone, one clear note; CARRIERS (FUNC column 7 bottom) brings carriers 2 / 3 in under it — at 50 % still a readable lead — and the top quarter turns it into the full stack with the DX7 bite |
| PLUCK (6 voices; SOUND column 7 CHORD / ARP OCT, column 8 ARP / ARP RATE) | STEEL → GLASS PLUCK → SAW PLUCK → SQUARE PLUCK → RAGE DONK | oscillators / glide, envelopes, level |

CHORD, LEAD and PLUCK sit 14 dB down at the output (sustained synths would swamp the drums otherwise; CHORD 10 % louder and LEAD 20 % quieter than that, so their defaults balance): full VOLUME is a loud lead, half (their default) sits in the mix. FLT DEC has 1 s at the middle of its knob (2 ms … 10 s).

Five sounds per type. **Envelopes are the type's own, not TIMBRE's:** the drums' decays and ring lengths and the synths' whole amp ADSR (ATTACK / DECAY / SUSTAIN / RELEASE of both oscillators) and their width (DETUNE, UNISON) stay as you set them whichever sound is chosen (INTENSITY never changes them either), so sounds can be swapped mid-groove without the envelope going out of whack. TIMBRE still shapes the filter envelope (part of each sound's character).

Chords: MAJOR, MINOR, MIN7, MAJ7, DOM7, MIN9, MAJ9, DOM9, MIN11, SUS4, 5TH, 5TH+OCT, MAJ11.

**LFO:** one LFO, opened with the **LFO** button after FX 1-3 (knobs and screen show it; FUNC + a channel button puts that track on / off it, like a send; a plain tap goes back to the tracks, on that one). Fourteen knobs, two per module: RATE / SHAPE (tempo-synced 4 bars … 1/64 with triplets and odd / dotted ones — 3 BAR, 1.5 BAR, 3/4, 3/8, 5/16, 3/16 — that drift against the loop; sine, square, triangle, saw down, saw up, sample+hold — each starts at its peak so a retriggered LFO hits with the note (made for stabs), except saw up, which rises to end at its peak), MORPH (blends the shape continuously into the next one: base shape + fine-tune) / FM MOD (swings the synths' FM level, ±depth around its set value, like VOL MOD does the level), PHASE / SMOOTH (slew), FADE IN (up to 4 bars, from PLAY or each note) / RETRIG (FREE = locked to the song, NOTE = restarts on each of the track's notes), VOL MOD / PITCH MOD (±48 st), FILTER MOD (±8 octaves on the sound filter) / PAN MOD, SEND MOD (pushes the send level, for dub throws) / SPREAD (offsets each track's phase, so tracks move against each other). Rate and depths can be put on live knobs. Older saves: tracks that used their own LFO join the shared one.

**Buses in RECORD / PLAY:** with FX 1-3 or the LFO open, **FUNC + a channel button** puts that track on / off the bus; a **plain tap** goes back to the tracks with that one selected.

**Bus compressors:** FX 1, FX 2 and FX 3 each end in the same compressor, in series, for an even level: **THRESH / RATIO** (module 7) and **ATTACK / RELEASE** (module 8), with automatic make-up so it holds the level up rather than dropping it. RATIO 1:1 = off. On FX 2 / 3 it holds the summed returns of the five effects (DELAY, DISTORT, MID CUT, CHORUS, REVERB; module 6 is free).

**FX 1 — drum bus:** tracks on it pass *through* it, so the filter really darkens (or thins) them and the reverse sits under the drums themselves. Transparent at its defaults. Three effects, four knobs each (two modules per effect): **REVERSE** (a reverse delay / reverse reverb: the drums are recorded in tempo-synced slices — REV LEN 1/16 … 1 bar — and each is played backwards while the next records, so hits swell in towards where they land; REVERSE = how much, REV FDBK = reverse echoes of the echoes, SMEAR = diffusion into a reverse-reverb wash), **DISTORT** (DRIVE 0-60 dB, TONE, CRUSH, LEVEL), **FILTER** (one DJ-style knob: left of centre a low-pass down to 30 Hz, right a high-pass up to 16 kHz, centre OFF; RESO to self-oscillation, ENV follower ± up to 8 octaves, ENV REL). Chain: reverse → distort → filter.

**FX 2 / FX 3 — sends:** six effects each, WET (labelled with the effect, top row) and INTENSITY (bottom row): DELAY (feedback; tempo-synced, FX 2 = 3/16 dub, FX 3 = 1/4), DISTORT, MID CUT, CHORUS, REVERB, COMP. A track goes to one send (own SEND LVL, taken before the drum bus), and can be on FX 1 at the same time.

**Default routing** (a starting point, freely changed, no hidden rules): drums on FX 1, bass + lead to FX 2 (dub delay), pad to FX 3 (reverb + chorus). Older saves keep their routing (old delay send → FX 2, reverb send → FX 3; drum tracks join FX 1).

**Master:** TEMPO; LO-FI — a tape-style finishing colour, saved with the project: a wide mid dip (~800 Hz → 1 kHz) plus soft, slightly asymmetric saturation that only rounds off peaks (gentle tape compression), level-matched. Subtle through most of the knob (half: −3 dB mids, ~1 dB peak squash); the top end is a deliberate, noticeable degradation (−8 dB mids, heavy peak squash, softened highs).

**Sequencing:** notes last one step by default; hold a key + ▶ to tie in step entry; live-recorded notes keep their held length; while recording the strip follows the playing 16-step block. **RING** (armed like ACCENT): the hit rings until the next hit or rest on its track — pitched notes are held, drums stretch each layer's own decay x3 and add a fixed extension per type (0.6 s; hat 1.5 s), so the DECAY knobs set how long rings last, choked by the next hit. **REST** places a stop marker (drums: arm REST, tap steps; step entry: at the cursor). Keyboard starts on A; dividers mark groups of four.

**Saving:** SAVE PATCH (USER n per track type), SAVE PROJECT (opens next launch), both in this browser's local storage; the working session survives reloads; on claude.ai the project is also mirrored to the artifact's store. The save format is forgiving: notes carry over across format changes.

Keyboard: Space play/stop · Z FUNC (hold) · 1-8 select channel · Shift+1-8 mute · Q-I / A-K the strip.
