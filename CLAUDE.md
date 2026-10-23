# GrooveAccess (repo: groovebox)

Web-first groovebox (techno, DnB, dub, jungle). Full spec: `groovebox-brief.md` (read it first).

## Rules
- Work milestone by milestone (section 12 of the brief); keep the build green; commit after each working step.
- `src/engine`, `src/instruments`, `src/fx` must stay free of DOM and Web Audio code.
- Audio thread: no allocation per block, no console.log, no blocking.
- Keep sound design basic at first; clean interfaces for refining later.
- Must work in desktop Chrome/Edge and Silk on a Fire tablet (touch, multi-touch).
- `main` is the source of truth: every session starts from it. After committing a working step, push it to the session branch and also to `main` (`git push origin HEAD:main`; if `main` moved, merge `origin/main` first, never force-push), so the next session starts with every change.

## Platform plan (agreed; not started)
Goal: the Android / Fire APK becomes the main version; the web build stays as the dev and preview build. Order:
1. **Sound first.** Finish the sound design in the TypeScript engine (current milestones). No port while the sound still changes: every tweak would have to be made twice.
2. **Capacitor shell (can come earlier).** Wrap `dist/` in a Capacitor Android app (served from `https://localhost` so AudioWorklet works; media playback without a gesture, keep screen on, immersive, landscape); a native `ProjectStore` (Capacitor Filesystem / Preferences) instead of localStorage; sideload on the Fire or publish to the Amazon Appstore (no Google Play Services). Measure the Fire with OboeTester (round-trip latency, MMAP support) to see what a native engine would gain.
3. **Native engine.** Port `src/engine`, `src/instruments`, `src/fx` to Rust (a thin C++ Oboe shim for the audio callback: AAudio, LowLatency + Exclusive, buffer = 1-2 bursts, sustained performance mode), behind the existing message protocol, so the UI barely changes. Keep `double` for filter / oscillator state, the same random generators, flush denormals to zero. Port module by module and **null-test** each against the TypeScript engine (render the same project offline, subtract, expect around -100 dB or lower).
4. **After the port:** the APK is the product (releases, latency work, Android-only features behind small interfaces like `ProjectStore`). The same Rust engine compiles to WASM for the web build (same UI, same sound): used for development, tests and the Artifact preview, never maintained or tuned separately. Then update this file's targets to "Android / Fire APK first; web = dev and preview build".

## Keeping these docs right
- This file describes the app **as it is now**. When behaviour changes, edit the section it belongs to (replace the old description, don't append a dated note), and add a one-line entry to `docs/HISTORY.md`.
- Save format changes: bump `PROJECT_VERSION` (`engine/project.ts`), add the load migration in `engine/projectFile.ts` (named after the version it upgrades from, e.g. `...V40`, guarded by the stored `version`), and record it in `docs/HISTORY.md`. Old migrations can be retired by raising `OLDEST_EXACT` (as in October 2026, see HISTORY).
- `ARCHITECTURE.md` = code structure, message protocol, data model. Keep its protocol table in step with `engine/protocol.ts`.
- Never trust a comment over the code: if they disagree, fix the comment in the same commit.

## Current state
Milestone M2 (mixer + FX) mostly done. **Next:** check the new FX buses on the Fire (CPU: all nine effects at once cost ~20 % more than the old buses; default settings about the same as before).

### Naming traps (stored id / code name vs what the panel shows)
| Code | Panel / meaning |
|---|---|
| kind `'pad'` | the PAD track (was called CHORD; some comments still say CHORD) |
| `Step.slide` | SLIDE on synths; **ROLL** on drum tracks |
| param `glide` | SLIDE (time) on synths |
| param `rolldiv` | ROLL RATE (hits per step) |
| mix `gate` / `ChannelState.gateLength` | TRIM |
| mix `cut` / `midCut`, param `midfreq` | MID CUT / MID FREQ |
| mix `dyn` / `dynamics` | ACC/GHOST |
| button `steppage` | BAR |
| button `len` | STEPS |
| buttons `dpage0-2` | page buttons (SOUND / MIX / PROJECT) |
| buttons `fx1-4` | FX 1, 2, 3, LFO |
| `ChannelState.fx1` / `fxSend` | on FX 1 (drums) / which send: 2 = FX 2 (PAD), 3 = FX 3 (LEAD) |
| bus params `mod_vol`, `dly_vol`, `vrb_vol`, `drv_vol` | each effect's VOLUME knob, labelled MOD / DELAY / VERB / DIST |
| bus param `tone_duck` | PUMP on FX 2 (kick-triggered), DUCK on FX 3 (its own input) |
| param `fm` | FM LVL |
| param `ogain` | OUT GAIN (TIMBRE's, no knob) |
| SONG: `ring` / `dyn:accent` buttons | INSERT ROW / DELETE ROW |
| anything named `...V<n>` | a load migration for saves older than v<n>; never use for new behaviour |

### Panel
- Top: modes RECORD / PLAY / DESIGN / SONG; channels 1-8 (select on release) with M (mute) / S (solo, not saved; Alt+1-8) under each; page buttons (3); FX 1 / 2 / 3 / LFO; SAVE (pattern), SAVE/LOAD PROJECT, RESET; PAT A-D.
- 16 knobs in 8 track modules (k1-k8 top row, k9-k16 bottom; module n = k(n) over k(n+8)). Absolute 0-127 over 270°; `encoder` events (mouse wheel, hardware) are relative.
- Function row: RING, SLIDE, ACCENT, GHOST | STEPS, BAR, CLEAR (hold), COPY (hold) | OCT -, OCT + | ◀, ▶, REST. Then the 16-step strip with LEDs; FUNC (Z; hold = second knob layer, tap = latch) and PLAY (Space); master knobs TEMPO and MASTER.
- Keyboard: 1-8 channels (Shift = mute, Alt = solo), QWERTYUI / ASDFGHJK = strip.
- Touch: `main.ts` cancels touch defaults; the panel runs on pointer events; everything lets go on `lostpointercapture`, blur and hidden (`Panel.releaseAll`). Portrait screens rotate the panel (`orientation.ts`).

### Modes
- **RECORD.** Stopped = step entry, playing = live recording (notes, releases and knob locks land where they were heard: `setListenLatency` = output latency + 15 ms touch).
  - Drum lanes (KICK, SNARE, HAT): the strip toggles steps; drag (or press the next step while one is held) to paint a stroke; the first step decides add / erase / flags / rests.
  - Keyboard tracks (PERC and the synths): note at the cursor, then the cursor advances; hold a key + ▶ / ◀ = tie it longer / shorter; REST = rest marker. A key pressed while another is held goes on the next step, except on the polyphonic tracks PAD and PLUCK (`registry.playsChords`) with CHORD OFF (`App.stepChords`), where it joins the same step as a chord (up to 6 notes). With a CHORD on, PAD / PLUCK play one root at a time like BASS / LEAD (`App.isMono`): held keys slide chord to chord (live and recorded), step entry goes on the next step. PAD / PLUCK: every note has its own length (`Step.extraGate`; ▶ / ◀ tie only the note(s) being entered and never clear other steps), so notes overlap freely; a key on a step that already has notes joins it as a note of its own, the same key again takes it out (`App.addChordNote`). At most 6 notes sound at any step: adding (or tying) a seventh replaces the one that started earliest, or among notes that started together the nearest in pitch (`App.makeRoom`). BASS / LEAD (and chord-mode PAD / PLUCK: one note at a time; held keys slide) replace, and their ties clear the steps they cover. PAD / PLUCK strip in step entry: the yellow ring = only the note(s) being entered and the step LEDs show only that note's steps (as over an empty step); the other notes sounding at that step (on it or tied over) light dim teal (`soundingAt`). While playing, every PAD / PLUCK note sounding at the playhead lights dim teal; keys held down show bright teal. Live recording on PAD / PLUCK: keys pressed while one is held join its step if they land on it or come within 80 ms of it (`CHORD_WINDOW`, `Engine.recordChordNote`), each with its own length from its own release (`releaseChordNote`).
  - RING / SLIDE / ACCENT / GHOST (one at a time): tap = placing mode (the strip shows steps; tap a note to toggle the flag; on tied-over steps the flag goes on the note), tap again = back. Drum lanes: the armed flag goes onto painted steps. ACCENT / GHOST never remove a drum note.
- **PLAY.** The strip is a keyboard for every track. Patterns switch at the loop end, and their patches glide in. RING / SLIDE / ACCENT / GHOST = every note on the selected track plays that way (`setForce`; not stored; off when leaving PLAY). Pages: SOUND (live knobs, always opens here) / MIX.
- **DESIGN.** Pages: SOUND (the selected track's sound page; FUNC = its FUNC layer), MIX (global: VOLUME / PAN per track; FUNC = SEND LVL / MID CUT), PROJECT (global: TEMPO, SWING, MASTER, TIME SIG; ACC/GHOST per track; FUNC = TRIM per synth track). A channel tap opens its SOUND page. OCT - / + on a synth = the sound's OCTAVE (-4 ... +4, part of the patch); otherwise the keyboard octave.
- **SONG.** Tracker grid: rows of bars + pattern A-D / OFF per track, switched at bar lines, looping. Knobs: top = each track's pattern in the cursor row, bottom 1 = BARS. ◀ ▶ = column, OCT - / + = row, INSERT / DELETE (the RING / ACCENT buttons), strip = jump to a row (at the next bar while playing), BAR = next page of rows. PLAY here plays the song from the cursor row.
- **In every mode but SONG:** FX 1-3 / LFO tap = that bus's knobs on screen (again, or a page button, = back); FUNC + FX = selected track on / off that bus; with a bus open, FUNC + channel = that track on / off it.

### Patterns and steps
- 8 tracks x 4 patterns A-D, 1-64 steps (STEPS held + ◀ / ▶ = a bar shorter / longer). BAR tap = next bar on the strip, BAR + ◀ / ▶ = previous / next. PLAY / live recording follow the playhead.
- A-D = the selected track's pattern; FUNC + A-D = every track; hold a channel + A-D = that track.
- Speed per pattern: normal / double / half / triplet (FUNC + BAR cycles; screen X2 / /2 / T). One master 16th clock; `Engine.stepChannel` runs each track's own steps.
- TIME SIG (`project.meter`, `METERS`): each 16-step bar has four groups and plays the first n of each; dark steps take no time; changes at the next bar line. STEPS tap = STEPS mode: strip taps flip a step on / off (`Step.flip`).
- Step flags: SLIDE (303-style: held through to the next note and glides into it; legato playing on BASS / LEAD slides too), RING (held until the next hit or REST; drums ring with long decay), ACCENT / GHOST (velocity 1 / 0.45, normal 0.8; ACC/GHOST per track scales the distance), REST, locks (per-step sound params, written by live recording), PAD / PLUCK chord notes (`Step.extra`, each with its own length `Step.extraGate`; the engine holds their notes each by its own length, `holdStart` / `stepHolds`, so a later note no longer cuts an earlier one; RING / SLIDE steps keep the one-note gate; a CHORD other than OFF plays only the step's lowest note, as its root; a SLIDE glides the chord voice by voice: root to root, 3rd to 3rd ..., at the sound's SLIDE time).
- Drum ROLL (the SLIDE flag on drums): consecutive ROLL steps roll as one run at the sound's ROLL RATE (1:1 ... 1:8 hits per step), velocity ramping from the first step's dynamic to the last's; lone ROLL steps don't roll.
- TRIM (per track): the last step of a sequenced note is held this long (0.125-2 steps).
- CLEAR held + step = clear it; + channel = clear that track's pattern. COPY held + channel = this pattern (notes + patch) to the same slot on that track (same type only); + A-D = to that pattern of this track.
- Each pattern has its own patch (`Pattern.patch`; the pattern being edited keeps its patch in the channel's `sounds` / `trims` / `presets`: always use `patchOf` / `setPatchOf` / `editPattern`).

### Sounds
- Track types: 1 KICK, 2 SNARE, 3 HAT, 4 PERC (pitched toms / percussion), 5 BASS, 6 PAD, 7 LEAD, 8 PLUCK (default layout; any track can take any type).
- **Layers**, bottom to top: TIMBRE / INTENSITY macros (`macros.ts`: TIMBRE blends five designed sounds per type; INTENSITY = modulation amount, below 50 % towards a dull floor, above excited; the KICK's sounds instead each have their own INT 0 (soft, slow thump) and INT 100 (extreme) versions, `Anchor.soft` / `hard`) < SOUND page knobs (stored as **trims** on top of the macros, `trims.ts`, so turning TIMBRE keeps them) < LIVE knobs (relative, in the engine via `setOffset`).
- Five TIMBRE sounds per type: KICK 808 BOOM / VINTAGE / PUNCH / TECHNO / PSY DOOF; SNARE RIMSHOT / PICCOLO / TIGHT / BREAK / INDUSTRIAL; HAT RIDE / HAT / SPLASH / CRASH / CHINA; PERC LOW TOM / SYN DRUM / CONGA / COWBELL / CLAVE; BASS SINE SUB / GROWL / ACID / SOLID / FM 2:3; PAD WARM / STRINGS / TINE / GLASS / ETHEREAL; LEAD ODD 2:3 / ORGAN / SAW 1:1 / OCT 1:2 / FIFTH 3:2; PLUCK STEEL / GLASS PLUCK / SAW PLUCK / SQUARE PLUCK / RAGE DONK.
- Loudness: every TIMBRE sound plays equally loud at the default VOLUME (within 1 dB; there's a test). Per-sound `ogain` evens a type's sounds; `InstrumentEntry.gain` sets the type.
- SOUND page layouts live in `registry.ts` (`drumPage`, `synthPage`, FUNC layers) — read them there, not here. Synths follow the sound chain: 1 TIMBRE / INT, 2 amp envelope, 3 FM ATK / FM DEC, 4 FM LVL / RESO, 5 FLT ATK / FLT DEC, 6 FLT ENV / CUTOFF, 7 DRIVE / CRUSH (PAD: DRIVE / UNISON, no CRUSH), 8 BASS SLIDE / SUB, PAD CHORD / SLIDE (DETUNE on its FUNC), LEAD SLIDE / DETUNE, PLUCK DLY TIME / DLY FDBK. Every FUNC layer also holds PRESET (module 1 top), MID FREQ (4 bottom), LIVE 1 / 2 (5), LIVE 3 / 4 (6). Drums have no other FUNC knobs, except the KICK: SWEEP / SWP TIME on FUNC 2 (TIMBRE / INT set the sweep). KICK page: 5 CLK RESO / CLK NOISE, 6 AIR LVL / AIR SIZE, 8 ROLL RATE / BALANCE as on every drum.
- PAD / LEAD: module 2's ATTACK / RELEASE and FUNC DECAY / SUSTAIN move both oscillators, and FM LVL moves FM LVL2 too (`registry.linkedParams`, applied in `App.paramTarget`, in live knobs via `liveTargets`, on load for saves without them); OSC 2's own ATTACK / RELEASE are FUNC module 3, FM LVL2 (the second stack's modulation: PAD stack 2, LEAD carriers 2 / 3) FUNC module 4 top. SLIDE (time): PAD module 8 bottom, PLUCK FUNC module 3 top.
- Live knobs: two per track (+ two with FUNC), defaults in `INSTRUMENTS[kind].live` / `liveFunc`; macros in `LIVE_MACROS`. Relative: centred = the sound as set, ±60 % of the range with a taper; CUTOFF / RESO / CHORD / NOTES and mixer ids are absolute. RESET centres them.
- **Drums** (`Drum.ts`): layers body (tone + sweep; SHELL `t_shell`, SNARE only, adds two drumhead overtones at 1.59 / 2.14 x, 0 = off), click (the SNARE has one too: its crack, on the body's side of BALANCE; no knob, 0 in today's sounds), metal (808-style bank / ring-mod / FM + noise) -> DRIVE -> CRUSH (fractional-rate) -> OUT GAIN -> AIR (KICK, SNARE: a small room on the track, `Drum.post`, its tail through a fixed EQ per type, `DrumVoice.air`: KICK high-pass 350 Hz x2 / low-pass 2.5 kHz, SNARE 400 Hz x2 / 6 kHz; AIR LVL (square law, 0 = off and idle) / AIR SIZE; the SNARE has no AIR knobs yet: where they go is still to decide). No filter per drum (FX 1's FILTER is the kit's). BALANCE between the elements; RING = decays x3 + a fixed 0.6 s extension. A retrigger fades the old hit over 3 ms.
- **Synths** (`Synth.ts`, up to 6 voices): BASS mono (one envelope for both oscillators, own filter envelope, sub, FM ratio ladder 1:2 / 2:3 / 3:2 root-locked, SIDECHAIN DUCK from KICK hits, FUNC under module 7); PAD polyphonic, algorithm 2 (two FM stacks, stack 2 mixed in by CARRIERS (no knob: 0.85 on every TIMBRE sound, INTENSITY fades it out below the middle and up to 1 in the top quarter; INTENSITY leaves FM LVL / FEEDBACK alone); chords via CHORD / NOTES or on-step notes); LEAD 3 voices, algorithm 1 (DX7-style: 3 carriers + 1 feedback modulator; INTENSITY sets CARRIERS: 0 = carrier 1 alone, full in the top quarter); PLUCK polyphonic with onboard delay + room (CHORD / DETUNE and DLY MIX / VERB on FUNC). Every synth has an FM envelope of its own (FM ATK / FM DEC, `fmattack` / `fmdecay`; each TIMBRE sound starts it where its filter envelope is): FM LVL = the settled modulation, each note's FM envelope lifts it (BASS / PLUCK 0.5 -> 5x, PAD / LEAD up to 4x, `fmEnvGain`). INTENSITY never moves FM LVL / FEEDBACK on the synths: the sound design runs TIMBRE > INT > FM > filter. The PLUCK's ARP has no controls for now (the engine still plays `arp` / `arprate` / `arpoct` if a type lists them again). DRIVE is level-compensated per type (`driveComp.ts`).
- PRESET loads factory sounds and USER patches saved by older versions (new USER patches can't be saved).

### Mixer, FX, LFO, master
- Per track: VOLUME, PAN, SEND LVL, MID CUT (`fx/TrackCut.ts`, centre = the sound's MID FREQ), ACC/GHOST, TRIM, mute / solo.
- Three FX buses (`fx/buses.ts` defines them, `fx/FxBus.ts` runs one, `fx/units.ts` holds the effects): four units of two knob modules each, no FUNC layer. An effect unit = VOLUME (return level) over TYPE, then its two controls (MOD RATE / DEPTH, DELAY RATE (tempo-synced) / FDBK, VERB SIZE / LENGTH, DIST DRIVE / TONE). A TYPE change fades over 15 ms; a unit at VOLUME 0 is skipped.
- FX 1 = drums (an insert: the drums stay in the mix through COMP (RATIO / THRESH, ATTACK / RELEASE, 1:1 = off), plus MOD (FLANGER, PHASER), DELAY (TAPE, SWEEP, REVERSE), VERB (ROOM, PLATE, EARLY) returning alongside). Transparent by default.
- FX 2 = PAD send: MOD (CHORUS, ENSEMBLE, PHASER), DELAY (STEREO, PING-PONG, TAPE), VERB (HALL, PLATE, SHIMMER), TONE (LOW CUT / HI CUT on the returns, PUMP / PUMP REL: KICK hits duck the returns).
- FX 3 = LEAD send: DIST (TUBE, FUZZ, BIT), DELAY (PING-PONG, DUB TAPE, SLAPBACK), VERB (ROOM, PLATE, SPRING), TONE (LOW CUT / HI CUT, DUCK / DUCK REL: the bus input ducks its own echoes).
- Each track feeds at most one send (by SEND LVL); FX 1 is separate. A new project routes KICK / SNARE / HAT / PERC to FX 1, PAD to FX 2, LEAD to FX 3; BASS and PLUCK have their own effects.
- One shared tempo-synced LFO (bus button 4): rate, shape + MORPH, phase, smooth, fade in, retrig, vol / pitch / filter / pan / send / FM mod, spread; tracks join it like a send.
- No track is on the LFO in a new project. Master: MASTER (x sqrt2 pan-law make-up) -> look-ahead limiter (`fx/Limiter.ts`, -1 dBFS). No master colouring.

### Saving
- Startup = blank slate (`createDefaultProject`, no project open). The working project is mirrored to the artifact db `projects/current` (`storage/cloud.ts`). `startProject.json` is for tests only.
- Projects (`storage/projects.ts`, `ProjectStore`): 64 slots (4 banks x 16); each has a saved copy and a working copy. Stopped only: SAVE PROJECT = save menu (name entry with knobs 1-4 = A-Z / a-z / 0-9 / symbols, ◀ ▶ cursor, BAR + ◀ ▶ bank, tap a slot; another project's slot = tap twice); FUNC + SAVE PROJECT = load (CLEAR + slot twice = delete; an empty slot = a new project: the default one, nothing open, the open project's edits kept in its slot; a never-saved changed project needs a second tap; SAVE then opens on that slot's bank, `App.newProject`).
- Cloud slots (`storage/slotSync.ts`, claude.ai only): the slots mirror to the db collection `slots`; `planSync` merges on start and when SAVE/LOAD opens.
- SAVE: RECORD = the track's notes, DESIGN = its patch, PLAY = both (FUNC = every track); unsaved edits show *. RESET: patches back to saved (gliding to the next bar line while playing), mix / FX / LFO to the saved project, live knobs centred; a second tap within 3 s = notes too; hold channel buttons to keep those tracks out of it.
- File format: `engine/projectFile.ts` (compact; forgiving: missing / out-of-range values take defaults, notes are never lost). Format v43 (`PROJECT_VERSION`; v42 added a PAD step's note lengths, stored `cg`); it reads v40 on exactly (`OLDEST_EXACT`; v41 load: FM ATK / DEC from FLT ATK / DEC incl. trims and locks (`fmEnvV41`), FX 2 / FX 3 routing swapped, old FX settings replaced by the bus defaults; v43 load (`drumsV43`, also USER patches): a KICK's BD DEC becomes a trim (TIMBRE now sets it, 0.5 s) and its other TIMBRE / INT values are rebuilt under its trims; SWEEP trims rescaled to the 0-120 st range). The migrations for v1-v39 were retired in October 2026. An older save still loads its notes and mix, its sounds as stored; LOAD then shows `OLD SAVE, SOUNDS MAY DIFFER` (`ProjectStore.isOld`).

### Engine safety and performance
- A non-finite engine output mutes the block and starts a fresh engine (ENGINE RESTARTED; main resends the project). The worklet file is re-fetched with `cache: 'reload'`.
- Clicks avoided: hit tone glides 3 ms, held-voice velocity follows over 4 ms, drum retrigger fade 3 ms.
- CPU: FxBus skips units at VOLUME 0 and a send goes idle after 5 s of silence; the reverbs use whole-sample comb delays while SIZE is at rest; PixelScreen redraws only changed frames.

### Tests and tools
- `tests/engine.test.ts` (engine offline in Node), `tests/projects.test.ts` (slots, sync), `tests/app.test.ts` (the App driven by button events through a stand-in panel; `makeApp()`: add UI tests there).
- **Sound lab** (`tools/lab`, Artifact https://claude.ai/artifact/Sqc91DULeGhJthmm8hqbR1; not part of the app): any track type on the real engine, TIMBRE / INT knobs + auto sweep, A = the app now against candidates B, C ... from `tools/lab/candidates.ts` (a candidate's TIMBRE sounds can carry their own INT 0 `soft` / INT 100 `hard` values, `tools/lab/sound.ts`), level-matched, with a table of what TIMBRE / INT set and where each knob is. Plays a copy of `projects/current` (`tools/lab/project.json`: refresh it from the app's db with ArtifactData before each lab build) or a built-in groove. Use it for every sound test: add candidates, `npm run lab:level` (prints the `ogain` values that level them), `npm run build:lab`, republish `dist-lab-artifact/lab.html` with `files: {"lab-worklet.js": "dist-lab-artifact/lab-worklet.js"}` to that URL. A winning candidate moves into `macros.ts` (and out of `candidates.ts`).
- Lab plan: the drum tracks one by one (KICK done: its soft / extreme sounds came from the lab). Under test: SNARE B (BRUSH / RIMSHOT / TIGHT / BREAK / INDUSTRIAL, PICCOLO gone; crack, SHELL and tail lengths per sound; soft / extreme per sound, TIGHT's extreme = piccolo). If B wins: SNARE page 5 MTL TONE / NOISE, 6 AIR, FUNC 2 SWEEP / SWP TIME, FUNC 3 CRACK / CRACK TONE, FUNC 4 top SHELL; v44 load (decays -> trims, TIMBRE remapped by sound name, PICCOLO -> between RIMSHOT and TIGHT). Then HAT, PERC.

## After every build
Run `npm run build:artifact` and republish `dist-artifact/groovebox.html` (with `files: {"groovebox-worklet.js": "dist-artifact/groovebox-worklet.js"}`) to the user's Artifact https://claude.ai/artifact/1gX3NeJdaGnWsLa3szA6q1, then end the reply with a **▶ Launch** link to it.

## Build / deploy
- `npm install` then `npm run dev` (dev server), `npm test` (Vitest, engine offline in Node), `npm run build` (typecheck incl. DOM-free engine check via `tsconfig.engine.json` and the sound lab, then static build to `dist/`), `npm run unused` (knip: no unused files / exports; keep it clean, export only what another file imports).
- The app is the claude.ai Artifact (above). CI: every push to `main` runs the workflow (tests, `npm run unused`, build) and publishes `dist/` to the `gh-pages` branch, but GitHub Pages is not switched on for the repo, so https://eojg1225-cell.github.io/groovebox/ is not live.
- Architecture and message protocol: `ARCHITECTURE.md`.
