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

A title screen fades into the panel. The first touch anywhere switches sound on (browsers require a gesture).

- **Channels 1-4** (top right): kick, snare, hat, bass. Tap a number to select it; MUTE under each. Channels 5-6 are reserved.
- **Pattern A/B/C** for the selected channel.
- **Knob pages:** SOUND (the selected channel's voice), MIX (volume, pan), GLOBAL (BPM, swing, master). The pixel screen lists what each knob does.
- **Strip:** 16 step buttons on drum tracks, a 16-key keyboard on pitched tracks (bass). **PLAY/STOP** on the right.
- **Function row:**
  - **RECORD / PLAY mode** (see below).
  - **MOTION REC:** while playing, knob moves on the SOUND page are recorded into the step playing at that moment (orange dot on the screen), and live keyboard notes land on the nearest step.
  - **ACCENT / GHOST:** the dynamic for new hits. Accent = loudest and fully bright; ghost = quiet and darker (a gentle per-hit low-pass); neither = normal. On drum tracks, tapping an existing hit with ACCENT or GHOST armed re-paints it.
  - **STEPS:** pattern length 16 → 32 → 48 → 64 → 16. **VIEW** pages through long patterns.
  - **OCT − / OCT +:** keyboard octave. **◀ ▶ REST:** step-entry cursor and rest (record mode, pitched tracks).

| | RECORD mode (building) | PLAY mode (performing) |
|---|---|---|
| Drum tracks | Strip toggles steps; VIEW chooses the 16-step page | Strip toggles steps live; view follows the playhead |
| Pitched tracks | Keyboard writes the note at the cursor and moves on; ◀ ▶ move, REST clears | Keyboard plays live (recorded with MOTION REC) |
| Pattern A/B/C | Switches immediately | Switches at the end of the loop |

On the screen, hit height shows the dynamic (tall accent, medium normal, short ghost); the bass lane shows note names and the cursor.

Patterns and settings are kept for the browser session (survive a reload, not closing the tab).

Keyboard: Space play/stop · 1-6 select channel · Shift+1-6 mute · Q-I / A-K the 16 strip buttons. Knobs: drag vertically (Shift = fine), mouse wheel, double-tap to reset.
