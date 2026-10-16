# Architecture

```
src/engine       Pure engine: project model, params, smoothing, protocol, Engine (sequencer, mixer, master). No DOM/Web Audio.
src/instruments  Instrument interface, registry, Kick/Snare/Hat/Bass, shared DSP. No DOM/Web Audio.
src/fx           Send effects (from M2). No DOM/Web Audio.
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
| `setStep` | `channel`, `pattern`, `index`, `step` | Write one step |
| `selectPattern` | `channel`, `pattern`, `immediate` | Switch pattern; quantised to the channel's loop end unless `immediate` or stopped |
| `setSound` | `channel`, `id`, `value` | Instrument parameter (real units) |
| `setMix` | `channel`, `id` (`volume`/`pan`/`mute`), `value` | Channel mixer |
| `setGlobal` | `id` (`bpm`/`swing`/`master`), `value` | Project-wide settings |
| `transport` | `playing` | Start (from step 1) / stop |
| `trigger` | `channel`, `note`, `velocity` | Audition a note |
| `ping` | `id` | Round-trip probe |

Worklet -> main:
| type | fields | meaning |
|---|---|---|
| `ready` | `sampleRate` | Processor constructed |
| `status` | `peakL`, `peakR`, `frame`, `playing`, `steps[6]`, `patterns[6]` | ~30 Hz: meters, playhead and playing pattern per channel |
| `pong` | `id` | Answer to `ping` |

No SharedArrayBuffer (static hosting can't set COOP/COEP headers); everything is `postMessage`.

## Project model (`src/engine/project.ts`)

`Project { version, bpm, swing (50-75 %), master, channels[6] }`; `ChannelState { instrument, sound{paramId: value}, volume, pan, mute, patterns[3], activePattern }`; `Pattern { length (1-64), steps[64] }`; `Step { active, note, velocity, gate, slide, accent }`. Kept in `sessionStorage` for now (`src/storage/session.ts`).

## Sequencer

A global 16th-note clock (swing lengthens even steps and shortens odd ones) drives all channels. Each channel keeps its own position and loops at its pattern length (polymeter). `Engine.process` splits each block at step boundaries so notes start on the exact sample. Pending pattern switches apply when the channel's position returns to step 1.

## Instruments

`src/instruments/registry.ts` maps a kind (`kick`, `snare`, `hat`, `bass`) to its class and `ParamSpec[]`. Each channel preallocates one instance of every kind. Shared DSP (noise, ZDF state-variable filter, polyBLEP) is in `dsp.ts`.

## UI

`Panel` (ControlSurface) emits `ch1..6`, `mute1..6`, `patA..C`, `page:sound|mix|global`, `step1..16`, `play`, knobs `k1..k8`. `App` maps them onto the project and the engine, and builds the pixel-screen view-model (`views.ts`). Audio starts on the first touch/click/key anywhere (browsers require a gesture); until then the screen footer says TOUCH FOR SOUND.

## Parameters

Each instrument/effect exposes `ParamSpec[]` (`id`, `name`, `min`, `max`, `defaultValue`, `unit`, `curve`). Controls emit normalised 0..1; `toValue`/`toNorm` convert. Engine-side changes go through one-pole `Smoother`s.

## Audio-thread rules

No allocation in `process()` or per block, no logging, no blocking, denormal-prone state snapped to zero, status object reused. The worklet is bundled by Vite (`?worker&url`, IIFE) into one self-contained script.

## Deployment

`.github/workflows/deploy.yml` runs tests, builds, and publishes `dist/` to the `gh-pages` branch, which GitHub Pages serves at https://eojg1225-cell.github.io/groovebox/. Vite uses `base: './'` so the build works from any sub-path.
