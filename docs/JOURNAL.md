# APEX — Development Journal

The running story of how this game got built: what was attempted, what broke, and what
was learned along the way. Written as a working diary, not a formal document. The deep
technical reference (constants, workarounds, module APIs) lives in the code comments;
this file is the narrative.

Newest entries are at the bottom.

---

## Aug 27 — Kickoff: a first-person F1 game at AAA level

The brief I set myself: a first-person Formula 1 racing game in Three.js, judged
harshly against real shipped titles, improved in loops until it genuinely holds up.

**The plan.** Rather than one giant effort, the project was split into eleven
subsystems (circuit, physics, car and cockpit, materials, sky and shadows,
post-processing, cameras and race logic, HUD, particles, audio, AI drivers), each built
against a contract document (`CONTRACT.md`) written first, pinning every interface:
units are metric, the car's local "forward" is -Z, wheels are always numbered FL, FR,
RL, RR, and nobody allocates memory inside a per-frame update. The contract is why the
pieces snapped together at all.

**Also built on day one:** a screenshot harness that boots the game invisibly, drives
it to a repeatable moment (grid start, 310 km/h straight, wet weather, night...) and
saves a PNG. Every quality judgement in this project happens on those PNGs, because the
original build machine had **no graphics card** — every frame was drawn by the CPU at
roughly 13 minutes per screenshot. That single fact shaped the whole development
process.

**Result:** ~35,000 lines landed. The first screenshot showed a recognisable F1
cockpit at Spa-Francorchamps — and a long list of problems.

---

## Aug 27–28 — Rounds 1–2: the review process starts swinging

Each round, ten screenshots get scored against real games like F1 24 and Gran
Turismo 7, across four dimensions (lighting, geometry, photography, UI), on the blunt
question: "shown these side by side, unlabelled, which is the real game?"

**Round 1: 41/100.** Standout disasters:
- The halo (the safety hoop over the driver's head) rendered as a giant black girder
  eating a third of the screen.
- **No shadows anywhere.** Root cause, found by probing the live scene: the shadow
  system used four "cascade" lights, and the shader patch that blends them never
  reached a single one of the 498 materials. So four suns lit everything at quadruple
  brightness, and any shadow one cascade drew was filled straight back in by the other
  three. One bug, two symptoms: washed-out lighting and missing shadows.
- The timing tower showed fabricated gaps — a perfect +0.120s arithmetic ladder that
  no real race would ever produce.

**Round 2: 50/100.** Halo fixed to a slim tube, night race went from broken to the
best frame in the set, timing became real. But a new lesson arrived: the same
over-brightness bug got corrected **twice in one round**, so the fix landed double and
the whole game came out roughly four times too dark. Lesson learned and applied ever
after: any single visual property (like exposure) gets exactly one owner per round.

---

## Aug 28 — Rounds 3–4: oscillation, and the measuring tools

**Round 3: 47/100 — it went backwards.** The signature of this phase: every note like
"make the halo thicker" or "brighten the image" got overshot. Girder → wire → chrome
ribbon. Too bright → too dark → blown-out white skies. Worse, a new bug made the whole
cockpit **translucent** — you could see the track through the steering wheel. Root
cause: the motion-blur system computed movement from the camera only, and the cockpit
moves *with* the camera, so at 270 km/h the blur smeared the background straight
through it.

**The fix for the process, not just the code:** stop working from adjectives. From
round 4 on, every change brief pins exact numbers ("halo cross-section 20×32mm",
"mid-brightness between 88 and 112", "clip no more than 1.2% of pixels") and every
claim must come with a measurement. Two small tools were built for this:
`tools/analyse.mjs` (reads a screenshot and reports brightness statistics and shadow
contrast) and later `tools/verify-gameplay.mjs` (runs a whole race with no graphics in
seconds and checks lap times, speeds and that nothing explodes into NaN).

**Round 4 was never scored** — its changes doubled render cost and every screenshot
timed out. The velocity-buffer fix (per-object motion tracking) was correct and cured
the transparent cockpit, but the round taught another lesson: performance is a feature
the review loop depends on.

Fun find from the gameplay tool: a car once "reached 583 km/h in first gear" — which
turned out to be a respawn teleport being read as one frame of impossible speed.
Measurements now use percentiles, not maximums.

---

## Aug 28–29 — Rounds 5–7: real progress, hard-won

**Round 5: 53/100 — the high-water mark of pure iteration.** Exposure finally
calibrated (all ten frames inside the brightness targets), real sponsor hoardings,
catch-fence mesh, carbon-fibre wheel detail. The reviews also levelled up: instead of
adjectives, cropping, zooming, sampling pixels and naming file-and-line causes. The
best single find of the project came this way: **`Wheels.js` line 407 set
`receiveShadow=false` on every wheel** — a one-line reason no tyre ever had a contact
shadow.

**Round 6: 49/100 — better game, worse score, and the reason matters.** Contact
shadows finally landed (measured: the ground under a tyre is 10× darker than open
tarmac — that's a real shadow). The wet-weather scenario finally looked wet. But the
score *dropped*, because a legitimately better chase camera moved an old unfixed bug
(a corrupted patch of rainbow noise on the engine cover) into the dead centre of the
hero shot, and the new timing tower stopped showing the race leader. Lesson: in a big
system, one improvement can amplify another area's bug. Rounds after this always
re-verify previous wins.

**Round 7: 52/100.** Leader restored to the tower in all frames, driver gloves rebuilt
with actual individual fingers, all round-6 wins held. The rainbow engine-cover bug
survived its **third** fix attempt (UV rewrite, geometry dedupe, and a bisection round
all failed) — it became the project's white whale.

---

## Aug 29–30 — Playing it for real. Everything changes.

Until now, every judgement came from still screenshots. Then I actually drove the car
on real hardware. Two findings, both things no screenshot could ever show:

**1. The car wobbled on every gear shift, like it was losing balance.**
Diagnosis: on every gear change the clutch disengaged, and when it re-engaged the
engine speed *snapped* to the new gear in a single physics step — a hammer blow of
torque into the rear axle. A real F1 seamless-shift box transfers torque continuously
and the driver feels nothing. The fix: torque now fades out and back in over the shift
with a smooth curve, the engine speed converges instead of snapping, and a driveline
"spring" (torsional compliance, like a real driveshaft) filters any remaining step.
**Measured result:** peak yaw disturbance during a straight-line shift dropped to
0.001–0.017 rad/s — at or below the car's normal wander. The wobble is gone.

**2. There was no starting menu.**
True — the game booted straight onto the grid. A full front end was built: session
type (Practice / Qualifying / Race), race distance, team and driver selection across
all ten teams, four difficulty levels wired to real AI skill, a settings screen that
writes through to the live game, and a controls page that reads the *actual* key
bindings from the input code so it can never drift out of date. The screenshot harness
bypasses the menu automatically so the review loop still works.

---

## Aug 30 — Play-session feedback: the menu bug, the lag, the desktop app

Three items from another session in the car.

**1. Difficulty and graphics could be raised but not lowered.**
A genuine bug, invisible to screenshots because no screenshot uses a mouse. Clicking a
menu row always *incremented* the value; the little ‹ › arrows were painted text, not
buttons. Keyboard left-arrow worked, but nothing said so. Fixed: the arrows are now
real clickable buttons (with hover and press states), verified with an automated
browser clicking them: Pro → Expert → Legend → Expert → Pro.

**2. Lag on a highly capable laptop — why?**
Three answers, honestly ranked:
- **The game's fault, fixed today:** the renderer ran with `preserveDrawingBuffer` on —
  a mode that forces the browser to keep a copy of every frame, needed only by the
  screenshot tool. It now switches on only in capture mode. Real games never run with
  this.
- **Probably the laptop's GPU choice:** on dual-GPU laptops, browsers often run on the
  power-saving integrated GPU instead of the real one. Check `chrome://gpu`, and in
  Windows Settings → Display → Graphics, add your browser and set it to
  "High performance". This alone is often the difference between 25 and 90 fps.
- **The pipeline is heavy and had never been profiled on a real GPU** — motion blur
  with a velocity pass, ambient occlusion, bloom, temporal anti-aliasing, real-time
  mirrors.

**3. A proper desktop build.**
The project now ships an Electron desktop wrapper: `npm run app` builds the game and
opens it as its own window (no browser), and `npm run dist:win` produces a portable
Windows .exe in the `release/` folder.

---

## Aug 30 — The white whale: the engine-cover rainbow was never on the car

The "rainbow corruption" on the engine cover — the bug that survived a UV rewrite, a
geometry dedupe and a full bisection round, and that round 6's better chase camera
dragged into the middle of the hero shot — is fixed. The reason three car-side fix
attempts failed is simple: **it was never on the car.**

**How it was found.** A page-side bisection oracle measured the speckle (fraction of
engine-cover pixels deviating hard from their 3×3 neighbourhood) while toggling one
suspect at a time in the live scene. Every car material and geometry variant left the
number unchanged. Turning off the **heat-haze effect** collapsed it from 15.16% to
3.25% — and setting a single uniform (`uGain`) to zero collapsed it identically. The
exhaust-plume shimmer quad billboarded at the car's tail sits, from the chase camera,
exactly over the "SCUDERIA CORSA" lettering.

**The mechanism.** The haze effect refracts a copy of the previous frame — but it
copied the *presented* frame (after tonemapping, 0–1 display-referred) and added the
difference into the *linear HDR* scene buffer. A difference computed in one colour
space and applied in another is off by the inverse-tonemap slope, so over white-on-dark
lettering the added delta was full-range: saturated per-channel confetti, black speckle
where sums went negative. Worse, the copy relied on `preserveDrawingBuffer`, which the
performance round had just gated to capture mode — on player hardware the source of the
copy is undefined.

**The fix** (`src/fx/HeatHaze.js`, `src/render/RenderPipeline.js`):
- The capture now blits the pipeline's own scene target — linear HDR, the same space
  the haze composites into — so `scene + (warped − flat)` genuinely reconstructs a
  displaced image. No `preserveDrawingBuffer` needed, so live play is correct too.
- A soft limiter bounds the residual relative to the local brightness: hot air bends
  light, it never contributes colour of its own.
- The visor rain film shares the captured texture; it reads it as a dimensionless
  contrast ratio, so it is correct against either source (verified on cockpit-wet).

**Measured** (round-8 protocol, chase-hero 1280×720/medium, same machine/build):
speckle with haze **on** 4.50% vs haze **off** 4.88% — the effect now contributes
*zero* speckle, while a diff against a gain-zero control confirms a gentle, visible
shimmer over the exhaust and the horizon mirage. The oracle is kept as
`tools/speckle-oracle.mjs` so any future round can re-verify this win.

Also fixed in passing: `tools/screenshot.mjs` silently did nothing on Windows (its
"am I the CLI?" check compared a `/D:/…` URL path against a `D:\…` filesystem path),
which mattered for the first time now that verification runs on a Windows machine.

---

## The scoreboard so far

| Round | Review score | Headline |
|---|---|---|
| 1 | 41 | No shadows anywhere; halo is a girder |
| 2 | 50 | Halo fixed; exposure double-corrected too dark |
| 3 | 47 | Regression round; transparent cockpit |
| 4 | — | Unscored; captures timed out |
| 5 | 53 | Exposure calibrated; Wheels.js:407 found |
| 6 | 49 | Contact shadows land; camera amplifies old bug |
| 7 | 52 | Tower leader back; gloves get fingers |
| 8+ | in progress | Feel, menu, performance — and the white whale falls |

The honest read: screenshot scores plateaued near 50 because each round fixed about as
much as it broke — and the fix for *that* was process, not code: one owner per
property, pinned numbers instead of adjectives, measurements instead of eyeballs, and
re-verifying old wins every round. Meanwhile the things screenshots can't see — the
physics, the gearbox, the menu, the feel — only started improving with real time in
the car. That is the most important lesson in this file.
