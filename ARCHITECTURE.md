# Architecture

```
src/engine       Pure engine: params, smoothing, protocol types, Engine (mix/master/meters). No DOM/Web Audio.
src/instruments  Instrument interface + instruments (M0: TestTone). No DOM/Web Audio.
src/fx           Send effects (from M2). No DOM/Web Audio.
src/worklet      processor.ts: AudioWorkletProcessor hosting Engine (audio thread)
                 host.ts: main-thread AudioContext + AudioWorkletNode bridge (the only Web Audio code)
src/controls     ControlSurface event interface (knob/fader/button/joystick, values normalised 0..1)
src/ui           Pixel screen (256x128 canvas + 3x5 font), views, Knob widget, Panel (on-screen ControlSurface)
src/storage      Persistence (from M8)
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
| `setParam` | `id`, `value` | Set `"<target>.<param>"` (e.g. `tone.freq`, `master.volume`) in real units |
| `transport` | `playing` | Start/stop (M0: gates the drone) |
| `trigger` | `note`, `velocity` | One-shot note (M0: test blip) |
| `ping` | `id` | Round-trip probe |

Worklet -> main:
| type | fields | meaning |
|---|---|---|
| `ready` | `sampleRate` | Processor constructed |
| `status` | `peakL`, `peakR`, `frame`, `playing` | ~30 Hz meters and audio-clock position |
| `pong` | `id` | Answer to `ping` |

No SharedArrayBuffer (static hosting can't set COOP/COEP headers); everything is `postMessage`.

## Parameters

Each instrument/effect exposes `ParamSpec[]` (`id`, `name`, `min`, `max`, `defaultValue`, `unit`, `curve`). Controls emit normalised 0..1; `toValue`/`toNorm` convert. Engine-side changes go through one-pole `Smoother`s.

## Audio-thread rules

No allocation in `process()` or per block, no logging, no blocking, denormal-prone state snapped to zero, status object reused. The worklet is bundled by Vite (`?worker&url`, IIFE) into one self-contained script.

## Deployment

`.github/workflows/deploy.yml` runs tests, builds, and publishes `dist/` to the `gh-pages` branch, which GitHub Pages serves at https://eojg1225-cell.github.io/groovebox/. Vite uses `base: './'` so the build works from any sub-path.
