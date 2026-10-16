# Groovebox: Initial Software Brief (v3, web-first)

## 1. Vision

A groovebox where making music feels immediate: open it, tap start, press play, tweak a knob, hear the change. No deep menus, no file dialogs before sound.

- **Phase 1 (this brief):** a **web app** that runs in any modern browser with nothing to install: a Windows PC browser and an Amazon Fire tablet (Silk browser) are the main targets. Every hardware element (pixel screen, knobs, faders, buttons, joystick) is drawn on screen and works with mouse, keyboard and **touch**.
- **Phase 2 (later):** a rewrite for dedicated hardware (Raspberry Pi class) with real knobs, faders and a pixel display. The rewrite is accepted up front, so Phase 1 should favour speed of development and clear, portable DSP over hardware-specific tricks.

## 2. Guiding principles

1. **Immediacy first.** Sound within seconds of launch (a default pattern loaded; one tap to start audio). Every important parameter is one knob away, never more than one page deep.
2. **Engine separate from interface.** The DSP, sequencer, mixer, FX and project data model are pure code with no DOM or browser-audio dependencies, so they can be tested in Node and later ported.
3. **Controls are an abstraction.** The UI emits events like "knob 3 changed", not "mouse moved". Later, real hardware produces the same events.
4. **Real-time safe audio.** Inside the audio thread: no memory allocation, no object creation per sample or per block, no logging, no blocking.
5. **Start simple, stay expandable.** Drum voices, instrument modes, FX and wavetable slots must be easy to add later.
6. **Basic sound first, refine later.** The sound design must be simple but pointed in the right direction (section 3). Get every instrument making a usable, genre-appropriate sound with clean, minimal DSP; resist polishing.

## 3. Sound design direction

The target genres are **techno, drum and bass, dub and jungle**. For the initial build this means choosing sensible defaults, ranges and starting sounds, not building complex DSP.

**Tempo and feel**
- Tempo range **60 to 200 BPM**, in 0.1 BPM steps (techno ~125-140, jungle ~160-170, DnB ~170-175, dub often ~70 half-time or ~140).
- **Swing/shuffle** is a first-class control (important for jungle and dub groove).
- A **half-time / double-time** switch on the transport.
- Polymeter (per-channel step lengths) suits techno and dub; keep it clean.

**Instrument voicing goals (basic first)**

| Instrument | Genre intent for v1 |
|---|---|
| Drum machine | Punchy kick with pitch sweep and long-ish sub decay; snappy snare with tone/noise balance; closed/open hats. Default kit leans techno / breakbeat. |
| Sampler | Built to load and play **drum breaks and one-shots** (amens, hits, stabs, dub FX). Start/end points and loop so a break can be played back; slicing is a later feature. |
| Virtual analog | Reese-style bass (detuned saws plus filter) and sub bass should be easy to dial in; detune control and a sub oscillator are in scope. |
| 303 | Classic acid for techno; accent and slide are essential. |
| FM | Metallic stabs, bells, clangs and punchy basses; per-operator envelopes make the percussive hits work. |
| Wavetable | Evolving pads, stabs and textures through the vector joystick, programmable per hit. |

**Defaults:** ship a demo project and per-instrument starting presets in this style (e.g. a 4-on-the-floor techno loop, or a 170 BPM break pattern with a reese bass and a dub-delay send). A handful of presets per instrument is enough.

## 4. Recommended tech stack (open to challenge)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | Safer large codebase; compiles to plain JS |
| Build | Vite, output as static files | Fast dev loop; deployable to any static host |
| Audio | **Web Audio API + one AudioWorklet** hosting the whole engine | Sample-accurate sequencing and DSP on the audio thread |
| Pixel screen | `<canvas>` at a fixed low resolution (default 256 x 128), scaled up with `image-rendering: pixelated` | Crisp pixels, cheap to draw |
| On-screen panel | DOM/SVG or canvas widgets using **Pointer Events** (multi-touch) | Works with mouse and touch; several knobs/faders can move at once |
| Storage | `localStorage` for the project JSON, **IndexedDB** for samples; export/import project files | No server needed |
| Samples | File picker and drag-and-drop; `decodeAudioData`, then transfer the `Float32Array` to the worklet | Handles WAV/MP3/OGG decoding for free |
| Tests | Vitest, running the engine directly in Node (offline rendering) | DSP tests without a browser |
| Hosting | Static host (GitHub Pages, Netlify, Cloudflare Pages) | Open the URL on PC or Fire tablet; optionally make it an installable PWA that works offline |

**Notes**
- **No SharedArrayBuffer.** Static hosts often can't set the required cross-origin-isolation headers, so use `port.postMessage` (with transferables) between the UI and the worklet.
- **Audio start gesture.** Browsers block audio until a user tap/click, so show a clear "tap to start" screen.
- **Plain, allocation-free DSP.** If JS performance proves insufficient on the Fire tablet, hot loops can later move to WebAssembly (Rust or C++), which also eases the Pi port. Do not start there.
- **Browser targets:** current Chrome and Edge on desktop, Silk on Fire tablet. Test on the tablet from the first milestone.

## 5. Architecture

```
/src/engine       Pure engine: sequencer, mixer, project data model, parameter system (no DOM, no Web Audio calls)
/src/instruments  FM, Sampler, VirtualAnalog, Acid303, DrumMachine, Wavetable
/src/fx           Delay, Distortion, MidCut
/src/worklet      AudioWorkletProcessor that hosts the engine + message protocol
/src/controls     ControlSurface interface and its on-screen implementation
/src/ui           Pixel screen renderer + on-screen hardware panel (responsive, touch-first)
/src/storage      Project save/load, sample storage, import/export
/tests            Offline DSP and sequencer tests (run in Node)
```

Key interfaces:

- **`Instrument`**: `noteOn(note, vel, stepData)`, `noteOff()`, `setParam(id, value)`, `render(outL, outR, start, end)`. Every instrument exposes its parameters through a parameter list (id, name, range, default, unit) so the UI and future hardware can map controls generically.
- **`Effect`**: `setParam(id, value)`, `process(inL, inR, outL, outR, start, end)`; same parameter-list mechanism.
- **`ControlSurface`**: emits events such as `KnobChanged(id, value 0..1)`, `FaderChanged(id, value)`, `ButtonPressed(id)`, `JoystickMoved(x, y)`. The on-screen panel is the first implementation; real hardware will be another later.
- **Main thread to worklet:** a small, documented message protocol (set parameter, set step, switch pattern, transport, load sample, load project). **Worklet to main thread:** playhead positions and meter levels at around 30 Hz.
- **The sequencer runs inside the worklet**, driven by the audio clock, so timing is sample-accurate and independent of UI or tab timers.

## 6. Sequencer spec

### Structure
- **6 channels.** Each has exactly one instrument mode selected at a time.
- **3 patterns per channel** (A, B, C). Each channel switches pattern independently.
- **Up to 64 steps per pattern; step count is customisable per channel (1 to 64).** Each channel has its own playhead and loops at its own length (polymeter). Default 16.
- Pattern switching is **quantised to the end of that channel's loop** by default, with an option to switch immediately.

### Step data
Each step stores:
- active (on/off)
- note (pitch)
- velocity
- gate length
- flags: **slide** and **accent** (needed by the 303; usable elsewhere)
- **optional per-step parameter values ("per-hit" values):** initially the **wavetable vector position (x, y)**; each step either has its own vector value or "inherits" the channel's current joystick position.

Design per-step values as a general mechanism (a small set of optional parameter locks) so other parameters can be added later; only the wavetable vector is wired up in the initial build.

### Transport
- Play / stop, tempo (see section 3), swing, half-time / double-time.
- Internal clock at 24 PPQN or higher; steps are 16th notes by default.
- Sample-accurate triggering (steps fire at the correct sample inside the audio block, not at block boundaries).

### Mixer
- Per channel: volume fader, mute, pan, and **three send levels** (to the delay, distortion and mid-cut sends).
- Master volume with a simple output limiter to prevent clipping.
- Instrument parameters are remembered **per mode**, so switching a channel from FM to sampler and back restores the FM sound.

## 7. Instruments

All instruments are polyphonic unless stated, with a sensible fixed voice count (default 4 per channel; fewer for drums/303) and voice stealing. Voice counts must be configurable so they can be reduced on slower devices. Parameter ranges below are guidance; pick musical defaults.

### 7.1 FM synth
- **4 operators.** Each: waveform (sine, square, sawtooth), frequency ratio (coarse + fine), output level, **its own ADSR envelope** (controls that operator's level, so modulation depth evolves over a note).
- **Fully customisable algorithms:** a 4x4 modulation matrix (operator i modulates operator j, including self-feedback) plus a per-operator "to output" level. Any routing must work, including loops; resolve loops with a one-sample delay and avoid unstable blow-ups (clamp/soft-limit).
- Ship a handful of **preset algorithms** (serial stack, 2x2 parallel, all-carriers, etc.) as starting points.
- **Virtual analog filter** after the operators: low-pass with cutoff and resonance (zero-delay-feedback state-variable or ladder design).
- **Master ADSR** volume envelope applied after the filter, in addition to the per-operator envelopes.

### 7.2 Sampler
- Load samples from disk (WAV at minimum; mono or stereo, any sample rate; resample as needed).
- **Pitch control** (semitones plus fine tune), keyboard-tracked from the step note.
- **Playback rate** control.
- **Low-pass and high-pass filters** with cutoff and resonance.
- Basic extras: start/end point, loop on/off, simple amp envelope to avoid clicks. Aimed at breaks and one-shots (section 3).
- Loaded samples are stored in IndexedDB so they persist between sessions.

### 7.3 Drum machine
- Starts with **kick, snare, hi-hat** synthesised (no samples needed).
- Each voice has its own tune, decay, level and a couple of voice-specific controls (e.g. kick: pitch sweep/punch and click; snare: tone/noise mix; hat: closed/open decay).
- Steps map note to voice (e.g. C = kick, D = snare, E = hat) via a lookup table, so adding voices later is one table entry and one class. In the UI, drum mode shows **one lane per voice**.
- Design this to be expandable (clap, toms, rim, cymbal, etc.).

### 7.4 Virtual analog
- **VCO:** saw, square (with pulse width), triangle, sine; detune (supports reese-style detuned saws); optional sub oscillator.
- **VCF:** resonant low-pass (cutoff, resonance, envelope amount).
- **VCA:** output level.
- **Each of VCO (pitch), VCF and VCA gets its own ADSR envelope.**

### 7.5 303 (acid bass)
- **Monophonic**, single saw/square oscillator.
- Resonant low-pass filter modelled on the classic 18 dB/oct diode-ladder character.
- Controls: cutoff, resonance, env mod, decay, accent amount, tuning, waveform.
- **Slide** (portamento between slid steps) and **accent** (louder plus brighter filter envelope) driven by the per-step flags.

### 7.6 Wavetable
- Load samples as **wavetable slots**; the vector-synthesis layout uses **4 slots at the corners (A, B, C, D) of a square**.
- A **joystick (XY pad)** moves a position inside the square and crossfades between the four waves (bilinear mix). This is the **vector** control.
- **Per-hit programming:** each step can store its own vector position. When a step triggers, the vector jumps to that step's value (or inherits the live joystick position if none is stored). To program it: select/hold a step and move the joystick; the value is written to that step and shown on the pixel screen.
- Optional (only if cheap): a smoothing/glide time so the vector moves between hit values rather than jumping, and a visual showing each step's vector dot.
- Single-cycle waveforms are the primary use case; if a long sample is loaded, slice/resample it to a single cycle or treat it as a scanned table (decide and document).
- Shared with other synths: amp ADSR and a filter.

## 8. FX sends

Three **send effects**, available to all channels via each channel's send levels (section 6, Mixer). In the initial build the three FX are **fully independent**: each is fed in parallel from the channel sends, each returns to the master mix with its own return level, and there is **no routing between FX** (no chaining, no feedback between them). Keep the structure open so routing options can be added later.

Each effect has **3 adjustable parameters** (plus the return level at the mixer):

| FX | Param 1 | Param 2 | Param 3 |
|---|---|---|---|
| **Delay** | Time (tempo-synced divisions with a free/ms mode) | Feedback (allow high values for dub self-oscillation, safely limited) | Tone (low-pass/high-cut in the feedback path so repeats darken) |
| **Distortion** | Drive | Tone (post-distortion filter) | Output level / character (e.g. soft-clip vs hard-clip blend) |
| **Mid-frequency cut** | Centre frequency | Width (Q) | Depth (cut amount) |

Notes:
- The delay must be musical for dub: tempo-synced, feedback that can run away gracefully, and no clicks when time changes.
- Distortion should be simple (waveshaper; add alias control as CPU budget allows).
- Mid-cut is a parametric cut (peaking filter with negative gain) used to carve space in the mix.
- All FX parameters smoothed to avoid zipper noise. Parameters appear on their own FX page of the panel.

## 9. Interface

### Pixel screen
- Fixed low-resolution canvas, scaled up with crisp pixel edges. Default **256 x 128** (a single constant so it can be changed later).
- Shows: current channel and instrument, pattern letter, step grid with playhead, BPM, and the name and value of whichever control was last touched.
- Instrument-specific views: FM algorithm matrix/diagram, wavetable vector square with joystick dot (and per-step vector values), ADSR curve display, sampler waveform.
- An FX view showing the three sends and their parameters.

### On-screen hardware panel
- **Transport:** play/stop, tempo knob, swing, half/double-time.
- **Channel select:** 6 buttons. **Pattern select:** 3 buttons (A/B/C) for the selected channel.
- **Instrument mode select** for the selected channel.
- **Step buttons:** a row of 16 buttons plus **page buttons** to reach steps 17 to 64.
- **Per-channel faders:** 6 volume faders, with per-channel send knobs (3 per channel) or a send page.
- **Parameter knobs:** a bank of 8 knobs that **map to the selected instrument's parameters**, with pages where needed (prefer well-grouped pages over deep menus). FX parameters use the same bank on an FX page.
- **Joystick** (XY pad) for the wavetable vector.

### Input and layout
- **Touch-first:** Pointer Events, multi-touch (adjust two controls at once), large hit targets, no page scrolling or zooming while playing, no accidental text selection or long-press menus.
- Knobs respond to vertical drag (and scroll wheel on desktop); double-tap/double-click resets to default.
- **Responsive layout:** the whole panel scales to fit the screen in landscape, including a Fire tablet display and a desktop window.
- **Keyboard shortcuts** on desktop for play, step toggling and channel switching.

This panel stays a clean layer over the `ControlSurface` interface.

## 10. Project persistence

- Autosave the project to the browser (`localStorage` for settings and patterns, IndexedDB for samples) so the app reopens exactly as left.
- **Export/import** a project as a file (JSON; include samples either inline or as a bundle) so work can be backed up and moved between devices.
- Project JSON covers: tempo, swing, all channels, modes, per-mode parameters, patterns, step lengths, per-step values, mixer and FX settings, sample references. Include a **format version number**, and document the format (it also helps the later Pi rewrite).
- Ship a **default demo project** in the target genres so the first launch makes sound.

## 11. Non-functional requirements

- Use the AudioContext's own sample rate (do not assume 44.1 or 48 kHz); `latencyHint: "interactive"`. Report measured output latency in a debug view. Target under ~20 ms on desktop; on the Fire tablet it is best effort, but measure and record it.
- No audible clicks on pattern switch, mode switch, or parameter changes (smooth parameters).
- **CPU budget:** all 6 channels at maximum voices plus all 3 FX should run without glitches on a mid-range PC, and with reduced voice counts on the Fire tablet if needed. Include a CPU/underrun indicator in the debug view.
- Worklet rules: preallocated buffers, no per-block allocation, no `console.log`, denormals flushed, no blocking calls.
- Handle browser quirks: audio suspended until a tap, resume after tab backgrounding, screen wake lock while playing where supported.
- Code and comments in clear English; small modules; a README and a short `ARCHITECTURE.md` kept up to date.

## 12. Milestones

1. **M0: Skeleton.** Vite + TypeScript project, deployable as a static site, "tap to start" screen, AudioWorklet playing a test tone, message protocol, pixel-screen canvas, responsive touch-capable panel layout with a few working knobs. **Deploy it and open it on the Fire tablet immediately** to confirm audio works and measure latency.
2. **M1: Sequencer + drums.** Clock in the worklet, 6 channels, per-channel step counts, 3 patterns, quantised switching, swing, drum machine voices, step grid and playhead. *First playable groove.*
3. **M2: Mixer + FX sends.** Channel volume/pan/mute/sends, master limiter, delay, distortion and mid-cut with their parameter pages.
4. **M3: Virtual analog** with its three ADSRs, parameter-to-knob mapping and pages.
5. **M4: Sampler** with sample loading, filters, start/end and loop.
6. **M5: FM synth** with per-operator envelopes and the modulation-matrix algorithms.
7. **M6: 303** with slide and accent.
8. **M7: Wavetable** with the vector joystick and per-step vector values.
9. **M8: Persistence, export/import, genre presets and demo project, polish,** performance pass on the Fire tablet, tests, docs.

Each milestone should be runnable and demoable on its own.

## 13. Testing and definition of done

- Offline render tests (Node): render N seconds of each instrument and each FX and check for silence, NaNs, clipping and expected pitch/frequency response.
- Sequencer tests: step timing accuracy, polymeter loop lengths, pattern-switch quantisation, per-step vector value recall.
- Project save/load round-trip test, including export/import.
- Manual checks on **desktop browser and Fire tablet**: open the URL, tap start, hear a groove, change every instrument mode on every channel, push the FX hard, with no crashes, runaway feedback or clicks; touch controls work with two fingers at once.

## 14. Out of scope for now

MIDI (including Web MIDI), additional effects (reverb, compressor, master FX), FX routing/chaining, song mode / pattern chaining, sample slicing, recording audio out, general parameter automation beyond the per-step values above, user accounts or cloud sync. All are plausible future additions; do not build them yet, but do not design them out.

## 15. Phase 2 notes (Raspberry Pi)

Not part of this build, but shape decisions now:
- The Pi version will be a **rewrite**, most likely in C++ (or Rust) with a hardware control layer for knobs, faders, buttons and a pixel display. (A bare Arduino cannot run this; a Teensy 4.x might with a leaner engine.)
- Keep the **DSP and sequencer in pure, allocation-free, framework-free modules**, document the algorithms, and keep the **project JSON format stable and documented**, so the port is a translation, not a redesign.
- The `ControlSurface` event model carries straight over to hardware controls.

## 16. Assumptions to confirm (please flag if any are wrong)

- **Platform:** browser-based app for a Windows PC browser and a Fire tablet (Silk); hosted as a static site.
- **Pi version:** a later rewrite, not a port of the web code.
- **VA synth "each with an ADSR":** interpreted as separate ADSRs for VCO (pitch), VCF and VCA.
- **Sampler "pitch" vs "playback rate":** v1 treats both as resampling-based and they combine. Changing speed without changing pitch needs time-stretching and is a later feature.
- **Wavetable:** 4-corner vector layout with a bilinear crossfade; per-hit vector stored per step.
- **FM envelopes:** each operator has its own ADSR, with a master ADSR kept on top.
- **Mid-frequency cut:** a parametric (peaking) cut with frequency, width and depth.
- **FX parameter choices** (section 8) are suggested defaults; swap any you prefer.
- **Screen:** 256 x 128 pixel canvas to start; colour or monochrome TBD.

## 17. How to work (instructions for Claude Code)

- Start by reading this brief, then propose a short plan and the file layout before writing code. Ask about anything in section 16 that blocks you.
- Work milestone by milestone; keep the build green and commit after each working step.
- Keep `/src/engine`, `/src/instruments` and `/src/fx` free of DOM and Web Audio code.
- Keep the sound design basic at first (section 3): correct, musical, minimal DSP, with clean interfaces for refining later.
- Create a `CLAUDE.md` in the repo recording the build and deploy commands, architecture rules (especially the audio-thread rules) and the current milestone.
