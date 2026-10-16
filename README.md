# Groovebox

Web-first groovebox for techno, DnB, dub and jungle. Runs in desktop Chrome/Edge and Silk on a Fire tablet; nothing to install.

**Live build:** https://eojg1225-cell.github.io/groovebox/

Spec: [`groovebox-brief.md`](groovebox-brief.md). Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Develop

```sh
npm install
npm run dev        # dev server (also on your LAN, for testing on the tablet)
npm test           # offline engine tests in Node (Vitest)
npm run build      # typecheck (incl. DOM-free engine check) + static build into dist/
npm run preview    # serve dist/ locally
```

Note: AudioWorklet needs a secure context, so on another device use the HTTPS Pages URL (plain `http://<lan-ip>` will not start audio).

## Current state (M0)

Tap to start, then: PLAY toggles a test-tone drone; TAP fires a short blip (use it to judge touch-to-sound latency by ear); knobs set frequency, level, drive, blip decay and master volume. The pixel screen shows the last-touched control, output meters and measured latency (`BASE` = context processing latency, `OUT` = output latency to the device, `MSG RTT` = UI-to-worklet message round trip).

Keyboard: Space = play, T or Enter = tap. Knobs: drag vertically (Shift = fine), mouse wheel, double-tap/double-click to reset.
