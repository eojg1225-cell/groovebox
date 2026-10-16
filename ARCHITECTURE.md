# Architecture

```
src/engine       Pure engine: project model, params, smoothing, protocol, Engine (sequencer, mixer, master). No DOM/Web Audio.
src/instruments  Instrument interface, registry (6 track types), Drum (layered), Synth (6-voice), presets, shared DSP. No DOM/Web Audio.
src/fx           Send effects: Delay, Distortion, MidCut (Effect interface). No DOM/Web Audio.
src/worklet      processor.ts: AudioWorkletProcessor hosting Engine (audio thread)
                 host.ts: main-thread AudioContext + AudioWorkletNode bridge (the only Web Audio code)
src/controls     ControlSurface event interface (knob/fader/button/joystick, values normalised 0..1)
src/ui           Pixel screen (256x128 canvas + 3x5 font), views, Knob, Panel (on-screen ControlSurface), App controller
src/storage      Session persistence (sessionStorage); real storage in M8
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
| `setFx` | `id`, `value` | Send effect parameter (`dly_*`, `dst_*`, `mid_*`) |
| `release` | `channel`, `note` | Release a live note (the played root) |
| `setPatternLength` | `channel`, `pattern`, `length` | 1-64 steps |
| `selectPattern` | `channel`, `pattern`, `immediate` | Switch pattern; quantised to the channel's loop end unless `immediate` or stopped |
| `setSound` | `channel`, `id`, `value` | Instrument parameter (real units) |
| `setMix` | `channel`, `id` (`volume`/`pan`/`mute`/`send0..2`), `value` | Channel mixer and send levels |
| `setGlobal` | `id` (`bpm`/`swing`/`master`), `value` | Project-wide settings |
| `transport` | `playing` | Start (from step 1) / stop |
| `trigger` | `channel`, `note`, `velocity` | Play a note now |
| `recordNote` | `channel`, `note`, `velocity`, `accent` | Motion record: play now, write to the nearest step (answers `recordedNote`) |
| `recordLock` | `channel`, `id`, `value` | Motion record: lock a sound param on the step playing now (answers `recordedLock`) |
| `ping` | `id` | Round-trip probe |

Worklet -> main:
| type | fields | meaning |
|---|---|---|
| `ready` | `sampleRate` | Processor constructed |
| `status` | `peakL`, `peakR`, `frame`, `playing`, `steps[6]`, `patterns[6]` | ~30 Hz: meters, playhead and playing pattern per channel |
| `pong` | `id` | Answer to `ping` |
| `recordedNote` | `channel`, `pattern`, `index`, `note`, `velocity`, `accent` | A motion-recorded note was written |
| `recordedLock` | `channel`, `pattern`, `index`, `id`, `value` | A motion-recorded lock was written |

The worklet decides where recorded events land because only it knows the exact play position. A note recorded just before a step is written to that step and its trigger there is skipped once, so it doesn't sound twice.

No SharedArrayBuffer (static hosting can't set COOP/COEP headers); everything is `postMessage`.

## Project model (`src/engine/project.ts`)

`Project { version: 3, bpm, swing (50-75 %), master, fx{id: value}, channels[6] }`; `ChannelState { instrument (type or 'none'), sounds{type: {paramId: value}}, presets{type: index}, live[2] (param id or "mix:volume|pan|send0..2"), chord, volume, pan, sends[3], mute, patterns[3], activePattern }`; `Pattern { length (1-64), steps[64] }`; `Step { active, note, velocity, gate, slide, accent }`. Kept in `sessionStorage` for now (`src/storage/session.ts`).

## Sequencer

A global 16th-note clock (swing lengthens even steps and shortens odd ones) drives all channels. Each channel keeps its own position and loops at its pattern length (polymeter). `Engine.process` splits each block at step boundaries so notes start on the exact sample. Pending pattern switches apply when the channel's position returns to step 1.

**Parameter locks:** each step can lock up to 8 sound parameters (`Step.locks`, stored in a NaN-filled typed array in the engine). A lock is applied just before its step triggers; a parameter locked on the previous step but not this one reverts to the channel's own value.

**Dynamics:** ghost / normal / accent map to velocity 0.45 / 0.8 / 1.0. Each channel's output passes a 12 dB low-pass whose cutoff is set per hit from the velocity (`hitToneCutoff`: ~20 kHz at accent, ~13 kHz normal, ~5 kHz ghost), so softer hits are also darker.

## Instruments

`src/instruments/registry.ts` maps a track type (`kick`, `snare`, `hat`, `bass`, `pad`, `lead`) to its class, core `ParamSpec[]` (at most 12, in knob order) and presets. Each channel preallocates one instance of every type. `ParamSpec.options` marks discrete choices (stored as an index) and `coarse` marks settings only the sound design mode may change. Shared DSP (noise, ZDF state-variable filter, polyBLEP) is in `dsp.ts`.

- **Drum:** layers TONE (oscillator + exponential pitch sweep), CLICK (filtered transient), METAL (6 oscillators at 808 cymbal ratios scaled by SPREAD: square bank, ring-mod pairs or 2-op FM, blended with noise, then high-pass), summed into tanh DRIVE and CRUSH (sample-and-hold + bit reduction). KICK = tone + click, SNARE = tone + metal, HAT = click + metal: each type only exposes (and sets) its layers. The played note retunes the pitched layers (36 = as designed).
- **Synth:** 6 voices (oldest stolen), two polyBLEP oscillators with detune + sine sub, per-voice SVF low-pass with decay envelope, ADSR, drive; MONO uses one voice with glide.

BASS (mono), PAD (poly) and LEAD (mono) are the same Synth with different core parameters and fixed values for the rest.

**Send effects:** each channel's post-fader signal feeds three buses by its send levels; each bus runs one effect whose wet output (times its return) is added to the mix. No routing between effects yet. Delay: time from tempo and division, smoothed (glides, never clicks), low-pass + tanh in the feedback path. Distortion: tanh/hard-clip blend and a one-pole tone filter. Mid-cut: RBJ peaking biquad with negative gain, coefficients refreshed every 32 samples from smoothed parameters.

**Chords and gates:** the engine expands each note through the channel's chord (`src/engine/chords.ts`), tagging voices with the root so they release together. Sequenced notes release after `gate` steps × 0.8; live notes release on the `release` message.

## UI

`Panel` (ControlSurface) emits `mode:record|play|design`, `ch1..6`, `mute1..6`, `patA..C`, `dpage0..3`, `step1..16`, function-row ids, `play`, knobs `k1..k12` (k1-k6 top row, k7-k12 bottom; the panel groups them into six track modules: k(n) above k(n+6), with the track number between). `App` maps them onto the project and the engine (each knob resolves to a `KnobTarget` for the current mode) and builds the pixel-screen view-models (`views.ts`: live view and design view). On portrait screens `Panel.fit` rotates the panel 90° and `orientation.ts` keeps knob drags in panel coordinates. Audio starts on the first touch/click/key anywhere (browsers require a gesture); until then the screen footer says TOUCH FOR SOUND.

## Parameters

Each instrument/effect exposes `ParamSpec[]` (`id`, `name`, `min`, `max`, `defaultValue`, `unit`, `curve`). Controls emit normalised 0..1; `toValue`/`toNorm` convert. Engine-side changes go through one-pole `Smoother`s.

## Audio-thread rules

No allocation in `process()` or per block, no logging, no blocking, denormal-prone state snapped to zero, status object reused. The worklet is bundled by Vite (`?worker&url`, IIFE) into one self-contained script.

## Deployment

`.github/workflows/deploy.yml` runs tests, builds, and publishes `dist/` to the `gh-pages` branch, which GitHub Pages serves at https://eojg1225-cell.github.io/groovebox/. Vite uses `base: './'` so the build works from any sub-path.
