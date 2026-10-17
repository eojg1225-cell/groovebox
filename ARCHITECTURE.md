# Architecture

```
src/engine       Pure engine: project model, params, smoothing, protocol, Engine (sequencer, mixer, master). No DOM/Web Audio.
src/instruments  Instrument interface, registry (6 track types), Drum (layered), Synth (6-voice), presets, shared DSP. No DOM/Web Audio.
src/fx           Effects (Delay, Distortion, MidCut, Chorus, Reverb, Compressor), SendBus (FX 2/3: six effects, WET + INTENSITY each), DrumBus (FX 1: stutter, distort, low-pass; tracks pass through it), Tape (master lo-fi). No DOM/Web Audio.
src/worklet      processor.ts: AudioWorkletProcessor hosting Engine (audio thread)
                 host.ts: main-thread AudioContext + AudioWorkletNode bridge (the only Web Audio code)
src/controls     ControlSurface event interface (knob/fader/button/joystick, values normalised 0..1)
src/ui           Pixel screen (256x128 canvas + 3x5 font), views, Knob, Panel (on-screen ControlSurface), App controller
src/storage      session.ts (working session, sessionStorage), saved.ts (patches + project, localStorage), cloud.ts (claude.ai artifact db mirror)
tests            Vitest, runs the engine offline in Node
```

The "no DOM / no Web Audio" rule for engine, instruments and fx is enforced: `tsconfig.engine.json` type-checks those folders with only the ES lib, and `npm run build` runs it.

## Data flow

```
Panel (pointer/keyboard) --ControlEvent--> main.ts --maps knob->ParamSpec--> AudioHost.send()
     --postMessage--> processor.ts --> Engine.handleMessage() ... Engine.process() each 128-frame block
processor.ts --status @30 Hz / pong--> AudioHost --> main.ts --> PixelScreen views (requestAnimationFrame)
```

## Message protocol (`src/engine/protocol.ts`)

Main -> worklet:
| type | fields | meaning |
|---|---|---|
| `loadProject` | `project` | Replace all engine state (startup / session restore) |
| `setStep` | `channel`, `pattern`, `index`, `step` | Write one step (incl. its locks) |
| `setInstrument` | `channel`, `kind`, `sound` | Change a track's instrument (clears its locks) and set its full sound |
| `setChord` | `channel`, `chord` | Chord mode index (0 = off) |
| `setRouting` | `channel`, `send` | Route a track to send FX 2 / FX 3 (0 = none) |
| `setDrumBus` | `channel`, `on` | Put a track through FX 1, the drum bus |
| `setDrumBusParam` | `id`, `value` | A drum bus parameter (`DRUM_BUS_PARAMS`, real units) |
| `setSendFx` | `send`, `effect`, `control` (`wet`/`int`), `value` | WET or INTENSITY of one effect inside a send |
| `setLfo` | `id` (an `LfoState` key), `value` | The shared LFO |
| `setLfoTrack` | `channel`, `on` | Put a track on / off the LFO |
| `release` | `channel`, `note` | Release a live note (the played root); ends a live-recorded note's length |
| `setPatternLength` | `channel`, `pattern`, `length` | 1-64 steps |
| `selectPattern` | `channel`, `pattern`, `immediate` | Switch pattern; quantised to the channel's loop end unless `immediate` or stopped |
| `setSound` | `channel`, `id`, `value` | Instrument parameter (real units) |
| `setMix` | `channel`, `id` (`volume`/`pan`/`mute`/`cutoff`/`send`), `value` | Track mixer: level, pan, mute, low-pass cutoff, send level |
| `setGlobal` | `id` (`bpm`/`swing`/`master`/`lofi`), `value` | Project-wide settings |
| `transport` | `playing` | Start (from step 1) / stop |
| `trigger` | `channel`, `note`, `velocity` | Play a note now |
| `recordNote` | `channel`, `note`, `velocity`, `accent` | Motion record: play now, write to the nearest step (answers `recordedNote`) |
| `recordLock` | `channel`, `id`, `value` | Motion record: lock a sound param on the step playing now (answers `recordedLock`) |
| `ping` | `id` | Round-trip probe |

Worklet -> main:
| type | fields | meaning |
|---|---|---|
| `ready` | `sampleRate` | Processor constructed |
| `status` | `peakL`, `peakR`, `frame`, `playing`, `steps[6]`, `patterns[6]`, `barPhase` | ~30 Hz: meters, playhead and playing pattern per channel, position in the bar (RESET lands on the next bar line) |
| `pong` | `id` | Answer to `ping` |
| `recordedNote` | `channel`, `pattern`, `index`, `note`, `velocity`, `accent`, `gate` | A live-recorded note was written (sent again with its length on release) |
| `recordedLock` | `channel`, `pattern`, `index`, `id`, `value` | A motion-recorded lock was written |

The worklet decides where recorded events land because only it knows the exact play position. A note recorded just before a step is written to that step and its trigger there is skipped once, so it doesn't sound twice.

No SharedArrayBuffer (static hosting can't set COOP/COEP headers); everything is `postMessage`.

## Project model (`src/engine/project.ts`)

`Project { version: 8, bpm, swing (50-75 %), master, lofi, fx1 {drum bus param: value}, lfo{rate, shape, vol, pitch, filter, pan, phase, smooth, fade, retrig, send, spread}, sendWet[3][6], sendInt[3][6] (rows 1-2 = FX 2/3; row 0 unused), channels[6] }`; `ChannelState { instrument (type or 'none'), sounds{type: {paramId: value}}, presets{type: index}, live[2] (param id or "mix:volume|pan|cutoff|send"), chord, volume, pan, cutoff, fx1 (on the drum bus), fxSend (0, 2 or 3), sendLevel, lfoOn, mute, patterns[3], activePattern }`; `Pattern { length (1-64), steps[64] }`; `Step { active, note, velocity, gate, slide (legato from a note still held into it), accent, ring?, rest?, roll? (hits per step, 2-8), locks? }`. Every save goes through `src/engine/projectFile.ts`: a compact stored format (only steps with notes) whose reader also accepts full project objects from any earlier version and keeps everything it recognises (notes and pattern lengths first, then mixer, sounds, FX), so format changes never lose notes. On claude.ai the working project is also mirrored to the artifact's `db` (`projects/current`).

## Sequencer

A global 16th-note clock (swing lengthens even steps and shortens odd ones) drives all channels. Each channel keeps its own position and loops at its pattern length (polymeter). `Engine.process` splits each block at step boundaries so notes start on the exact sample. Pending pattern switches apply when the channel's position returns to step 1.

**Parameter locks:** each step can lock up to 8 sound parameters (`Step.locks`, stored in a NaN-filled typed array in the engine). A lock is applied just before its step triggers; a parameter locked on the previous step but not this one reverts to the channel's own value.

**Dynamics:** ghost / normal / accent map to velocity 0.45 / 0.8 / 1.0. Each channel's output passes a 12 dB low-pass whose cutoff is set per hit from the velocity (`hitToneCutoff`: ~20 kHz at accent, ~13 kHz normal, ~5 kHz ghost), so softer hits are also darker.

## Instruments

`src/instruments/registry.ts` maps a track type (`kick`, `snare`, `hat`, `bass`, `pad`, `lead`) to its class, core `ParamSpec[]` (at most 12, in knob order) and presets. Each channel preallocates one instance of every type. `ParamSpec.options` marks discrete choices (stored as an index) and `coarse` marks settings only the sound design mode may change. Shared DSP (noise, ZDF state-variable filter, polyBLEP) is in `dsp.ts`.

- **Drum:** layers TONE (oscillator + exponential pitch sweep), CLICK (filtered transient), METAL (6 oscillators at 808 cymbal ratios scaled by SPREAD: square bank, ring-mod pairs or 2-op FM, blended with noise, then high-pass), summed into tanh DRIVE and CRUSH (sample-and-hold + bit reduction). KICK = tone + click, SNARE = tone + metal, HAT = click + metal: each type only exposes (and sets) its layers. The played note retunes the pitched layers (36 = as designed).
- **Synth:** 6 voices (oldest stolen), two polyBLEP oscillators with detune + sine sub, per-voice SVF low-pass with decay envelope, ADSR, drive; MONO uses one voice with glide.

**Macros** (`src/instruments/macros.ts`): each type defines four anchor sounds (full parameter sets) and INTENSITY scalings. `macroSound(kind, timbre, intensity)` blends the two neighbouring anchors on each parameter's own curve (log for frequencies/times), then scales the excite list (×low^(1-2i) below 0.5, ×high^(2i-1) above). The UI applies the result as ordinary `setSound` messages; `timbre`/`intensity` are stored with the sound and ignored by the DSP. Presets are anchor positions. Synth: continuous SHAPE (sine → triangle → saw → square crossfade) and an FM pair (index follows the filter envelope) blended by FM. Drum METAL: M MODE crossfades square bank → ring-mod → FM, M FM sets the FM index.

BASS (mono), PAD (poly) and LEAD (mono) are the same Synth with different core parameters and fixed values for the rest.

**Drum bus, sends and master:** each track has a low-pass CUTOFF. Tracks on FX 1 are summed into the `DrumBus` instead of the mix; it runs stutter (captures one grid length on the song clock's next grid line into a preallocated buffer, then repeats it with per-repeat fade and cumulative pitch), distortion and a low-pass with envelope follower, and adds the result to the mix. A track also feeds at most one of the sends FX 2 / FX 3 (post-fader, before the drum bus, by its send level). A `SendBus` feeds all six effects in parallel; each has WET (return volume) and INTENSITY (delay feedback, distortion drive, mid-cut depth, chorus depth + rate, reverb size, compressor threshold + ratio). Delay time is fixed per send (FX 2 3/16, FX 3 1/4, tempo-synced). The master runs `Tape` (LO-FI: RBJ peaking mid cut ~800 Hz-1 kHz up to -8 dB, parallel asymmetric tanh saturation normalised to unity small-signal gain with a DC blocker, a one-pole high roll-off only near the top of the knob) before the safety soft-clip. Effect classes: Delay (smoothed tempo-synced time, low-pass + tanh feedback), Distortion (tanh/hard-clip blend + tone), MidCut (RBJ peaking cut), Chorus (two modulated delays), Reverb (Freeverb with pre-delay), Compressor (stereo-linked peak, fast attack).

**LFO** (`src/engine/lfo.ts`): one LFO shared by the tracks with `lfoOn`. The engine keeps an LFO clock in 16th steps (reset on PLAY, advancing with the tempo), so it is phase-locked to the song; each chunk it fills a buffer of LFO values per member track (rate 4 bars … 1/64 incl. triplets, shape, PHASE + SPREAD x track / 6, from the song clock or — RETRIG NOTE — from the track's last note, SMOOTH slew, FADE IN; S+H picks a new random level each cycle). VOL, PAN and SEND MOD act per sample; PITCH MOD and FILTER MOD call `Instrument.setPitchMod(semitones)` / `setFilterMod(octaves)` once per 64-sample chunk.

**RING and REST:** a RING step's note is held (gate open-ended) until the next step on its track that is a hit or a REST marker; drums are told `ring` in `noteOn` and use their long decay (tone/metal decay × 8), and `noteOff` chokes a ringing drum in 12 ms. Stored compactly as `r: 1` on a step and `{ i, x: 1 }` for a rest.

**Chords and gates:** the engine expands each note through the channel's chord (`src/engine/chords.ts`), tagging voices with the root so they release together. A sequenced note releases exactly when the step `gate` steps later starts (counted per channel at each step; 1 = one step); live notes release on the `release` message. A live-recorded note's start is quantised like its step and its end to the nearest step boundary; the difference becomes its gate.

## UI

`Panel` (ControlSurface) emits `mode:record|play|design`, `ch1..6`, `mute1..6`, `patA..C`, `dpage0..3`, `step1..16`, function-row ids, `play`, knobs `k1..k12` (k1-k6 top row, k7-k12 bottom; the panel groups them into six track modules: k(n) above k(n+6), with the track number between), `fx1..3`, master knobs `mtempo`, `mlofi`. Knobs are absolute (0-127, fixed limits, 270°); `ControlEvent` also has `encoder` (relative detents) for hardware encoders, which the mouse wheel uses on screen. `App` maps them onto the project and the engine (each knob resolves to a `KnobTarget` for the current mode) and builds the pixel-screen view-models (`views.ts`: live view and design view). On portrait screens `Panel.fit` rotates the panel 90° and `orientation.ts` keeps knob drags in panel coordinates. Audio starts on the first touch/click/key anywhere (browsers require a gesture); until then the screen footer says TOUCH FOR SOUND.

## Parameters

Each instrument/effect exposes `ParamSpec[]` (`id`, `name`, `min`, `max`, `defaultValue`, `unit`, `curve`). Controls emit normalised 0..1; `toValue`/`toNorm` convert. Engine-side changes go through one-pole `Smoother`s.

## Audio-thread rules

No allocation in `process()` or per block, no logging, no blocking, denormal-prone state snapped to zero, status object reused. The worklet is bundled by Vite (`?worker&url`, IIFE) into one self-contained script.

## Deployment

`.github/workflows/deploy.yml` runs tests, builds, and publishes `dist/` to the `gh-pages` branch, which GitHub Pages serves at https://eojg1225-cell.github.io/groovebox/. Vite uses `base: './'` so the build works from any sub-path.
