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
- Save format changes: bump `PROJECT_VERSION` (`engine/project.ts`), add the load migration in `engine/projectFile.ts` (named after the version, e.g. `bassFilterV38`), and record it in `docs/HISTORY.md`.
- `ARCHITECTURE.md` = code structure, message protocol, data model. Keep its protocol table in step with `engine/protocol.ts`.
- Never trust a comment over the code: if they disagree, fix the comment in the same commit.

## Current state
Milestone M2 (mixer + FX) mostly done. **Next:** per-send delay time editing.

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
| `sendInt` / control `'int'` | DEPTH (FX 2/3) |
| param `fm` | FM LVL |
| param `ogain` | OUT GAIN (TIMBRE's, no knob) |
| SONG: `ring` / `dyn:accent` buttons | INSERT ROW / DELETE ROW |
| `remap*V18`, `*V38`, `OCTAVE_SHIFT_V33` ... | load migrations only; never use for new behaviour |

### Panel
- Top: modes RECORD / PLAY / DESIGN / SONG; channels 1-8 (select on release) with M (mute) / S (solo, not saved; Alt+1-8) under each; page buttons (3); FX 1 / 2 / 3 / LFO; SAVE (pattern), SAVE/LOAD PROJECT, RESET; PAT A-D.
- 16 knobs in 8 track modules (k1-k8 top row, k9-k16 bottom; module n = k(n) over k(n+8)). Absolute 0-127 over 270°; `encoder` events (mouse wheel, hardware) are relative.
- Function row: RING, SLIDE, ACCENT, GHOST | STEPS, BAR, CLEAR (hold), COPY (hold) | OCT -, OCT + | ◀, ▶, REST. Then the 16-step strip with LEDs; FUNC (Z; hold = second knob layer, tap = latch) and PLAY (Space); master knobs TEMPO and MASTER.
- Keyboard: 1-8 channels (Shift = mute, Alt = solo), QWERTYUI / ASDFGHJK = strip.
- Touch: `main.ts` cancels touch defaults; the panel runs on pointer events; everything lets go on `lostpointercapture`, blur and hidden (`Panel.releaseAll`). Portrait screens rotate the panel (`orientation.ts`).

### Modes
- **RECORD.** Stopped = step entry, playing = live recording (notes, releases and knob locks land where they were heard: `setListenLatency` = output latency + 15 ms touch).
  - Drum lanes (KICK, SNARE, HAT): the strip toggles steps; drag (or press the next step while one is held) to paint a stroke; the first step decides add / erase / flags / rests.
  - Keyboard tracks (PERC and the synths): note at the cursor, then the cursor advances; hold a key + ▶ / ◀ = tie it longer / shorter; REST = rest marker. A key pressed while another is held goes on the next step, except on PAD, where it joins the same step as a chord (up to 6 notes).
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
- Step flags: SLIDE (303-style: held through to the next note and glides into it; legato playing on BASS / LEAD slides too), RING (held until the next hit or REST; drums ring with long decay), ACCENT / GHOST (velocity 1 / 0.45, normal 0.8; ACC/GHOST per track scales the distance), REST, locks (per-step sound params, written by live recording), PAD chord notes (`Step.extra`).
- Drum ROLL (the SLIDE flag on drums): consecutive ROLL steps roll as one run at the sound's ROLL RATE (1:1 ... 1:8 hits per step), velocity ramping from the first step's dynamic to the last's; lone ROLL steps don't roll.
- TRIM (per track): the last step of a sequenced note is held this long (0.125-2 steps).
- CLEAR held + step = clear it; + channel = clear that track's pattern. COPY held + channel = this pattern (notes + patch) to the same slot on that track (same type only); + A-D = to that pattern of this track.
- Each pattern has its own patch (`Pattern.patch`; the pattern being edited keeps its patch in the channel's `sounds` / `trims` / `presets`: always use `patchOf` / `setPatchOf` / `editPattern`).

### Sounds
- Track types: 1 KICK, 2 SNARE, 3 HAT, 4 PERC (pitched toms / percussion), 5 BASS, 6 PAD, 7 LEAD, 8 PLUCK (default layout; any track can take any type).
- **Layers**, bottom to top: TIMBRE / INTENSITY macros (`macros.ts`: TIMBRE blends five designed sounds per type; INTENSITY = modulation amount, below 50 % towards a dull floor, above excited) < SOUND page knobs (stored as **trims** on top of the macros, `trims.ts`, so turning TIMBRE keeps them) < LIVE knobs (relative, in the engine via `setOffset`).
- Five TIMBRE sounds per type: KICK 808 BOOM / VINTAGE / PUNCH / TECHNO / PSY DOOF; SNARE RIMSHOT / PICCOLO / TIGHT / BREAK / INDUSTRIAL; HAT RIDE / HAT / SPLASH / CRASH / CHINA; PERC LOW TOM / SYN DRUM / CONGA / COWBELL / CLAVE; BASS SINE SUB / GROWL / ACID / SOLID / FM 2:3; PAD WARM / STRINGS / TINE / GLASS / ETHEREAL; LEAD ODD 2:3 / ORGAN / SAW 1:1 / OCT 1:2 / FIFTH 3:2; PLUCK STEEL / GLASS PLUCK / SAW PLUCK / SQUARE PLUCK / RAGE DONK.
- Loudness: every TIMBRE sound plays equally loud at the default VOLUME (within 1 dB; there's a test). Per-sound `ogain` evens a type's sounds; `InstrumentEntry.gain` sets the type.
- SOUND page layouts live in `registry.ts` (`drumPage`, `soundPage`, `BASS_PAGE`, `PLUCK_PAGE`, FUNC layers) — read them there, not here. Every FUNC layer also holds PRESET (module 1 top), MID FREQ (4 bottom), LIVE 1 / 2 (5), LIVE 3 / 4 (6). Drums have no other FUNC knobs.
- Live knobs: two per track (+ two with FUNC), defaults in `INSTRUMENTS[kind].live` / `liveFunc`; macros in `LIVE_MACROS`. Relative: centred = the sound as set, ±60 % of the range with a taper; CUTOFF / RESO / CHORD / NOTES and mixer ids are absolute. RESET centres them.
- **Drums** (`Drum.ts`): layers body (tone + sweep), click, metal (808-style bank / ring-mod / FM + noise) -> DRIVE -> CRUSH (fractional-rate) -> OUT GAIN. No filter per drum (FX 1's FILTER is the kit's). BALANCE between the elements; RING = decays x3 + a fixed 0.6 s extension. A retrigger fades the old hit over 3 ms.
- **Synths** (`Synth.ts`, up to 6 voices): BASS mono (one envelope for both oscillators, own filter envelope, sub, FM ratio ladder 1:2 / 2:3 / 3:2 root-locked, SIDECHAIN DUCK from KICK hits); PAD polyphonic, algorithm 2 (two FM stacks; chords via CHORD / NOTES or on-step notes); LEAD 3 voices, algorithm 1 (DX7-style: 3 carriers + 1 feedback modulator); PLUCK polyphonic with ARP (UP / DOWN / UP-DN / CASCADE / RANDOM) and onboard delay + room. DRIVE is level-compensated per type (`driveComp.ts`).
- PRESET loads factory sounds and USER patches saved by older versions (new USER patches can't be saved).

### Mixer, FX, LFO, master
- Per track: VOLUME, PAN, SEND LVL, MID CUT (`fx/TrackCut.ts`, centre = the sound's MID FREQ), ACC/GHOST, TRIM, mute / solo.
- FX 1 = drum bus (tracks pass through it): REVERSE (delay / reverb), DISTORT, DJ FILTER (left LP, right HP, centre off), then a bus compressor (THRESH / RATIO / ATTACK / RELEASE, 1:1 = off).
- FX 2 / FX 3 = sends, each track feeds at most one: DELAY, DISTORT, CHORUS, REVERB (WET on top, DEPTH below), then a bus compressor. Delay time is fixed per send (FX 2 3/16, FX 3 1/4) until per-send editing lands.
- One shared tempo-synced LFO (bus button 4): rate, shape + MORPH, phase, smooth, fade in, retrig, vol / pitch / filter / pan / send / FM mod, spread; tracks join it like a send.
- A new project routes nothing (no FX, no LFO). Master: MASTER (x sqrt2 pan-law make-up) -> look-ahead limiter (`fx/Limiter.ts`, -1 dBFS). No master colouring.

### Saving
- Startup = blank slate (`createDefaultProject`, no project open). The working project is mirrored to the artifact db `projects/current` (`storage/cloud.ts`). `startProject.json` is for tests only.
- Projects (`storage/projects.ts`, `ProjectStore`): 64 slots (4 banks x 16); each has a saved copy and a working copy. Stopped only: SAVE PROJECT = save menu (name entry with knobs 1-4 = A-Z / a-z / 0-9 / symbols, ◀ ▶ cursor, BAR + ◀ ▶ bank, tap a slot; another project's slot = tap twice); FUNC + SAVE PROJECT = load (CLEAR + slot twice = delete).
- Cloud slots (`storage/slotSync.ts`, claude.ai only): the slots mirror to the db collection `slots`; `planSync` merges on start and when SAVE/LOAD opens.
- SAVE: RECORD = the track's notes, DESIGN = its patch, PLAY = both (FUNC = every track); unsaved edits show *. RESET: patches back to saved (gliding to the next bar line while playing), mix / FX / LFO to the saved project, live knobs centred; a second tap within 3 s = notes too; hold channel buttons to keep those tracks out of it.
- File format: `engine/projectFile.ts` (compact; the reader accepts every earlier version and never loses notes).
- Upgrade (phase 3 of the audit, step 1): at startup `localProjects.upgrade()` and `upgradeUserPatches()` rewrite every slot, working copy and USER patch stored in an older format in the current one (savedAt kept; once per format, marker `groovebox.upgraded`); cloud copies are converted as they arrive (`place`). Step 2, once every device has opened this build: delete the load migrations for versions below 40.

### Engine safety and performance
- A non-finite engine output mutes the block and starts a fresh engine (ENGINE RESTARTED; main resends the project). The worklet file is re-fetched with `cache: 'reload'`.
- Clicks avoided: hit tone glides 3 ms, held-voice velocity follows over 4 ms, drum retrigger fade 3 ms.
- CPU: SendBus skips effects at WET 0 and goes idle after 5 s of silence; DrumBus passes through at rest; PixelScreen redraws only changed frames.

### Tests and tools
- `tests/engine.test.ts` (engine offline in Node), `tests/projects.test.ts` (slots, sync). The UI (`App.ts`) has no tests yet.
- `tools/soundtest`, `tools/fmbass`, `tools/basssweep`: standalone sound-comparison pages (each has a README); not part of the app.

## After every build
Run `npm run build:artifact` and republish `dist-artifact/groovebox.html` (with `files: {"groovebox-worklet.js": "dist-artifact/groovebox-worklet.js"}`) to the user's Artifact https://claude.ai/artifact/1gX3NeJdaGnWsLa3szA6q1, then end the reply with a **▶ Launch** link to it.

## Build / deploy
- `npm install` then `npm run dev` (dev server), `npm test` (Vitest, engine offline in Node), `npm run build` (typecheck incl. DOM-free engine check via `tsconfig.engine.json` and the tools/ sound tests, then static build to `dist/`), `npm run unused` (knip: no unused files / exports; keep it clean, export only what another file imports).
- Deploy: push to `main`; the workflow tests, builds and publishes `dist/` to the `gh-pages` branch. Pages source: branch `gh-pages`, folder `/`.
- Live URL: https://eojg1225-cell.github.io/groovebox/
- Architecture and message protocol: `ARCHITECTURE.md`.
