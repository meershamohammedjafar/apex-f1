# APEX — a first-person Formula 1 racing game

A browser-and-desktop F1 racing game built in Three.js: 120 Hz physics, a full race
weekend against ten AI-driven teams at Spa-Francorchamps, and a AAA-style render
pipeline (temporal anti-aliasing, motion blur, bloom, heat haze, dynamic weather,
night racing) — developed in review loops against real shipped titles.

<img src="media/apex-cockpit.gif" width="760" alt="APEX in motion: the cockpit view flat out down the pit straight towards La Source at 310 km/h in eighth gear with DRS open, a personal-best lap banner appearing on the HUD">

## Play it

Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install
```

**As a desktop app** (its own window, no browser):

```bash
npm run app
```

**In the browser** (development server with live reload):

```bash
npm run dev
```

then open http://localhost:5173.

**Build a portable Windows .exe** (lands in `release/`):

```bash
npm run dist:win
```

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / brake | W / S (or ↑ / ↓) | triggers |
| Steer | A / D (or ← / →) | left stick |
| Shift up / down | Shift or E / Ctrl or Q | RB / LB |
| DRS | Space | A / cross |
| ERS deploy | F | X / square |
| Pit limiter | L | — |
| Cycle camera | C | Y / triangle |
| Look left / right / back | Z / X / M | — |
| Toggle HUD | H | — |
| Reset car | R | B / circle |
| Pause | Esc | back |

The main menu covers session type (Practice / Qualifying / Race), race distance, team
and driver selection, four AI difficulty levels, and a settings screen (quality tier,
field of view, motion blur, film grain) that writes through to the live game. The
controls page in the menu reads the real key bindings from the input code, so it never
drifts out of date.

If the game lags on a dual-GPU laptop, make sure the browser (or the app) is allowed
to use the high-performance GPU: Windows Settings → Display → Graphics.

## For developers

Everything simulates on a fixed 120 Hz step (physics substeps to 240 Hz) with
interpolated presentation, so the feel is identical at any display rate. Systems live
under `src/` (car physics, track, sky, render pipeline, effects, AI, audio, UI) and
communicate through a shared `ctx` object; the interface contract is `CONTRACT.md`.

The project's development story — every round, bug hunt and lesson — is in
[docs/JOURNAL.md](docs/JOURNAL.md).

### Tools

All verification happens headlessly, because the original build machine had no GPU:

```bash
node tools/screenshot.mjs --all --fast
```

boots the built game in headless Chromium (SwiftShader), drives it to deterministic
scenarios (grid start, 310 km/h straight, wet weather, night race…) and writes PNGs,
failing on console errors or blank frames. Also:

- `tools/verify-gameplay.mjs` — runs a whole race with no graphics and checks lap
  times, speeds, and that nothing explodes into NaN.
- `tools/analyse.mjs` — brightness/contrast statistics for a screenshot.
- `tools/speckle-oracle.mjs` — regression check for the engine-cover speckle bug
  (measures the heat-haze effect's pixel damage with the effect on, off, and neutered).
- `tools/probe-shift.mjs` — measures yaw disturbance through gear shifts.
- `tools/make-gif.mjs` — renders a deterministic clip and encodes it as a GIF
  (`--shot straight|chase|apex|pack|grid`); the README clip came from this.

Screenshot scenarios and quality tiers are pinned so that captures are reproducible;
compare metrics on/off on the same machine and build, never across machines.
