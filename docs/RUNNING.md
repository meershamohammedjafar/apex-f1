# Running APEX

## First time only

```
npm install
```

Requires Node.js 20.19+ or 22.12+, the versions Vite 7 supports (https://nodejs.org,
LTS installer).

## In VS Code

Open the `formula-one` folder in VS Code, then pick whichever suits you:

**Press F5.** Choose "Play APEX (Chrome)" from the dropdown at the top. VS Code starts
the dev server and opens the game automatically. Breakpoints in `src/` work, and the
Debug Console shows any errors.

**Or Ctrl+Shift+P, "Run Task", "APEX: dev server".** Starts the server and prints a
`http://localhost:5173` link in the terminal. Ctrl+click it to open in your normal browser.

**Or just the terminal.** Ctrl+` opens it, then `npm run dev`.

All three run the same thing. F5 is best when you want to debug, the terminal is best when
you just want to play in your normal browser with your normal GPU settings.

## As a desktop app (no browser)

```
npm run app
```

Builds and opens APEX in its own window via Electron. In VS Code this is also the
"Play APEX (Desktop window)" launch config.

## Building a standalone Windows .exe

```
npm run dist:win
```

Produces a portable executable in `release/`. The `--win` flag targets Windows whatever
machine runs it, but building a Windows app from Linux or macOS needs extra tooling such
as Wine, so run this on Windows.

## Live reload

`npm run dev` hot-reloads: save a file in `src/` and the browser updates without a
restart. The desktop app does not hot-reload; re-run `npm run app` after changes.

## Controls

W/S throttle and brake, A/D steer, Shift or E shift up, Ctrl or Q shift down,
Space DRS, F ERS, C camera, H toggle HUD, R reset to track, Esc pause,
backquote (`) toggles the FPS counter.

A gamepad is detected automatically (the first one connected): left stick steers, right
trigger is throttle, left trigger is brake. Steering wheels are only partly supported. A
wheel steers, but pedals that report as axes rather than trigger buttons give no
throttle or brake.

## If it runs slowly

1. Press backquote in game to see fps, frame time and draw calls.
2. On a laptop with two GPUs, browsers often default to the power-saving one. Open
   `chrome://gpu` to see which is in use. In Windows Settings → System → Display →
   Graphics, add your browser and set it to "High performance".
3. Lower Graphics Quality in the menu's Settings screen.

## Other commands

| Command | What it does |
|---|---|
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build on port 4173 |
| `node tools/verify-gameplay.mjs 120` | Simulates 120 s of racing with no graphics and prints a JSON report (speeds, gears, off-track time, NaN samples, standings). It has no pass/fail checks, so read the report. Needs `npm run build` first and `npm run preview` running in another terminal; it does not start a server. The VS Code task "APEX: verify gameplay" runs this same command and needs the same server |
| `node tools/screenshot.mjs --scenario cockpit-grid --fast` | Capture a single frame |
| `node tools/analyse.mjs stats shots/cockpit-grid.png` | Brightness statistics for a captured frame (list several files to compare them) |
