# APEX — Development Journal

The running story of how this game got built: what was attempted, what broke, and what
was learned along the way. Written as a working diary, not a formal document. The deep
technical reference (constants, workarounds, module APIs) lives in
`docs/TECHNICAL-NOTES.md`; this file is the narrative.

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
contrast) and later `tools/verify-gameplay.mjs` (simulates minutes of racing with no
graphics in seconds and reports lap times, speeds and any NaN, for a person to read).

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

## Aug 30 — Round 9: five wins, one own goal, and a scoring trap

The biggest round yet: five fix passes, then a repo-wide comment strip, then capture
and review. The review score came back at **45/100 — the lowest since round 1** — and
that number is misleading in an instructive way. Three separate things got tangled:

**The real wins, all verified:**
- **Performance:** the capture wall-clock for the reference shot dropped ~30% with the
  image provably unchanged (brightness statistics within a quarter of a percent). The
  brightness meter now samples every 4th frame, the cockpit mirrors refresh
  alternately, and a redundant sun-visibility measurement stopped running five times
  more often than anyone read it. Press backquote (`` ` ``) in game for the new FPS
  counter.
- **Pause flow:** Escape now opens a proper pause menu — resume, restart, settings,
  quit to menu — tested through three full quit-and-restart cycles without leaks.
- **Audio:** a code review found and fixed unramped volume changes (the classic source
  of clicks and pops) and aligned the gearshift sound with the new smooth-shift
  physics. Nothing in the review loop can hear, so my own ears are the test bench here.
- **The comment strip:** all code comments removed, with their knowledge extracted
  first into `docs/TECHNICAL-NOTES.md`. Build, gameplay and captures verified unbroken
  after.

**The own goal:** aiming the sunset scenario at the newly visible sun revealed that the
auto-exposure had a floor — a limit on how far it may darken — set for normal scenes.
Point the camera at the sun and it hits that floor and the whole frame blows out to
white. The review marked the whiteout down hard, in every dimension. Fixed the same
day: the floor was lowered (0.28 to 0.06), and an A/B test proved the change is
invisible on every normal frame (0.7% difference) while the sunset recovered from a
234/255 whiteout to a readable 123.

**The scoring trap:** this round's screenshots were captured at 720p while every
earlier scored round was 1080p — so the review also punished ten "mushier" frames
that were actually rendering identically. Lesson for the process: every review must
compare like-for-like, and the capture resolution is now part of the gate.

**The engine cover, seen from this round.** Round 9 ran alongside the white-whale hunt
in the entry above, on a copy of the game without the heat-haze fix, so the rainbow was
still in its chase frames. Its own attack on the bug — a disciplined oracle-table
round — didn't kill it either, which made four attempts that failed; the haze fix
above is the one that holds.

---

## Oct 12 — A moving picture for the README, and a public home for the game

The README was a wall of text, and a racing game sells itself in three seconds of
motion. So the top of the README (and my GitHub profile) now shows a short looping
clip: the cockpit view flat out down the pit straight towards La Source — 310 km/h,
eighth gear, 13,400 rpm, DRS open — with a personal-best banner landing mid-clip.

**How the clip is made.** `tools/make-gif.mjs` opens the game in a headless browser,
skips the menu, places the car with one of the test scenarios, and then *drives the
clock itself*: every GIF frame advances the simulation by exactly seven 1/120 s ticks,
renders once, and takes a screenshot. Because the clock is stepped rather than timed,
the clip's speed does not depend on the machine rendering it, which has no graphics card
and needed about 6 seconds per frame. It is close to true speed, not exact: at 18 fps a
frame lasts 55.6 ms but carries 58.3 ms of simulation (120/18 rounds to 7 ticks), so the
clip runs about 5% fast. Only a frame rate that divides 120 evenly, such as 20 fps
(6 ticks), plays back exactly. The frames are then turned into a GIF in
two passes — first build the best 256-colour palette for the whole clip, then map
every frame onto it — which is what keeps a dark cockpit and a bright sky from
banding.

The numbers: 54 frames at 18 fps (three seconds), 760 px wide, 5.9 MB. GitHub shows
README images up to about 10 MB, so width and length were trimmed until it fit with
room to spare.

**Snags along the way.**
- The browser bundled with the test library didn't match the one installed on the
  render machine, so the tool now looks for an installed Chromium first (and accepts
  an `APEX_CHROME` path to point it somewhere else).
- Asking for the GIF at a full path quietly wrote it *inside the project* instead,
  because the path was glued onto the project folder. Full paths are now used as given.
- Frames are written to `.gifframes/`, which git ignores, and deleted afterwards unless
  `--keep` is passed.

Re-make it any time with:

```bash
node tools/make-gif.mjs --shot straight --frames 54 --fps 18 --width 1280 --height 720 --quality medium --gif-width 760 --out media/apex-cockpit.gif
```

Other shots are available: `chase`, `apex`, `pack` and `grid`.

**Why the public copy is a separate repository.** A GIF on a public profile can only
link to a repository people can open, and this one is private. Making it public as-is
wasn't safe: older branches and two closed pull requests carry a work email address in
their commit details, and GitHub keeps pull-request history permanently — it can't be
rewritten or deleted from this side. So the public version, `apex-f1`, gets only clean
history — the squashed main line plus the Aug 30 – Sep 4 work (round 9 and the new
docs) merged in as one commit, all under my GitHub no-reply address — and this
repository stays private as the full working record.

---

## Oct 12 — Two lines of work, merged back into one

Getting the game ready to go public turned up a surprise: my `main` had been rebuilt
from a copy taken on Aug 30, so it was missing everything from Aug 30 to Sep 4. That
meant round 9, the sunset exposure fix, the pause menu, the comment clean-up, the
VS Code setup and three docs (`RUNNING.md`, `TECHNICAL-NOTES.md`, `GOING-NATIVE.md`).
Meanwhile `main` had work the September line didn't have: the engine-cover haze fix,
the README and this journal's rewrite. GitHub still had the September commit, so the
two could be brought back together.

**How the merge went.** Both lines started from the same Aug 30 state, so it was a
proper three-way merge. Most files only changed on one side and came across untouched.
Seven files clashed:
- Two only clashed because one side reworded comments the other side had deleted, so
  September's version won.
- The real one was the heat-haze fix (`HeatHaze.js`, `Weather.js`, `RenderPipeline.js`):
  `main`'s fix had to be re-applied on top of September's reformatted files.
- `tools/screenshot.mjs` needed `main`'s Windows fixes carried over.
- This journal and the README were combined by hand.
- `tools/sync.sh` was dropped, as on `main`.

Each resolution was then checked by a separate reviewer whose only job was to find
something that had been lost.

**Finishing the comment clean-up.** The September strip had removed JavaScript
comments but left the ones inside shader code: 388 of them, plus some bundler markers.
They are all gone now, and what they explained has moved into `docs/TECHNICAL-NOTES.md`.
To prove the strip changed nothing the graphics card sees, I captured every shader the
game compiles in five scenes (day, wet, night, sunset chase, low quality), before and
after. The sets are identical.

**Proving the merged game still works.**
- **Race:** a full headless race gives exactly the same results as the old `main`.
  Top speed is 320.4 km/h, median field speed 221.4 km/h and the best lap 1:51.42,
  with no NaN values and no console errors.
- **Engine cover:** the speckle check passes on the merged build. Haze on gives
  4.75% speckle against 5.06% with it off (it was 15.16% before the fix).
- **Visuals:** side-by-side renders against the old `main` (chase, wet visor, sunset,
  night) show no regressions. The sunset now faces the sun and stays a readable golden
  hour rather than blowing out to white.
- **GIF:** the README clip was re-rendered from the merged build.

One small tooling quirk turned up along the way: on Linux, `tools/speckle-oracle.mjs`
printed its results but didn't exit, because the preview server it starts outlived it.
That one is fixed now (next entry).

---

## Oct 12 — Two follow-up fixes: light shafts and mirrors

Two effects got a proper second look: the light shafts that stream from a low sun, and
the heat haze. Both had a real bug, and the tool that measures the haze had one of its
own.

**The light shafts multiplied the sky by hundreds.** The shafts are made by smearing
the bright sky around the sun along lines that point at the sun, in three passes. Each
pass adds its samples up instead of averaging them, so by the end a patch of sky came
out about 300 times brighter at high quality and about 760 times on ultra. The step
that lays the shafts over the picture then took 85% of that sum, which meant adding
roughly 256 times the sky's own brightness on top of the frame (648 times on ultra).
It went unnoticed because, until the sunset scenario was aimed at the sun, no stock
scenario had the sun in frame: it was always behind the camera or below the horizon, so
the shaft pass never ran. With the sun on screen (high quality, looking down the
descent to Bruxelles) the frame turned into a white veil: auto-exposure dropped from
2.0 to 0.3 trying to hold it, and the median brightness still went from 130 to 232.

**The fix.** The shaft step now divides that build-up back out, so a shaft is a fixed
share of the sky it is cut from (a quarter) whatever number of samples the quality
tier takes. I tried three strengths on the sunset frame, against a median of 130 with
shafts off: a quarter gave 138 and clear beams through the cloud and round the halo,
a half gave 143 and the sun's disc started to glow, and full strength gave 149 and
hazed the road. A quarter it is. The lens flare still reads the raw shaft buffer to
judge how much of the sun is visible, so it behaves exactly as before. Ultra had a
second problem: at 24 samples the sum at the sun's disc overflowed the half-precision
buffer, and that infinity knocked out the bloom and lens ghosts round the disc. Each
pass is now capped just under the format's limit, which changes nothing anywhere the
sum fits.

**Measured** (sunset frame looking at the sun, 1280×720, median brightness via
`tools/analyse.mjs`):
- before, shafts on: **231.6** (exposure 0.30)
- before, shafts off: **130.3** (exposure 2.00)
- after, high quality: **137.9** (exposure 1.82), with directional beams
- after, ultra: **136.2**, with no infinite or NaN pixels left

**The haze showed up in the mirrors.** The haze works out what to bend from the
pixel's position on the main screen. The cockpit mirrors draw the whole scene again
from their own cameras into a small 512-pixel picture, and there that same position
points at an unrelated patch of the main view. My own car's exhaust plume sits right in
the left mirror, so the old engine-cover confetti came back there in miniature (up to
83 levels of difference). The haze now lives on its own layer, which only the main
camera draws. Difference in the mirror after the fix: 0.

**The wet visor could refract a frozen frame.** The raindrops on the visor bend a copy
of the previous frame that the haze takes. Drop to the low quality tier mid-race and
the haze switches off and stops refreshing that copy, but it kept handing the visor its
last one, so in the wet the drops would have shown a picture frozen at the moment of
the switch. With the haze off it now hands over nothing, and the drops just darken and
show their rims.

**The speckle check compared two different camera angles.** `tools/speckle-oracle.mjs`
measures the engine cover with the haze on, off, and at zero strength. The "on" run was
the only one with no setup step, so it reached the scenario one browser round-trip
sooner, and the game keeps running in real time until the tool stops it. The camera's
field of view eases toward its target and survives the scenario reset, so "on" was shot
at 32.573° and the other two at 32.563°. That tiny zoom showed up as a difference
across the whole frame, with colour fringes growing toward the corners, which looked
like haze. The tool now stops the game before doing anything else, so every run sees
the same camera. It also exits properly on Linux now (it used to leave its preview
server running and hang after printing), and `APEX_CHROMIUM` can point it at a
particular browser.

**Measured** (round-8 protocol, 1280×720/medium, SwiftShader, matching cameras): haze
**on 4.68%**, **off 5.04%**, zero strength 5.05%. Haze on still sits below haze off, and
the only real differences between the two pictures are in the exhaust plume and the
horizon band. (The earlier 4.50% / 4.88% and the merge's 4.75% / 5.06% were taken with
the mismatched cameras.) The 3.25% "off" figure from round 8 doesn't reproduce: off is
about 5% here, the same as the Aug 30 entry's 4.88%. So getting the number below 2%
isn't the haze's job. What's left is jagged edges in a quality tier that has no
temporal anti-aliasing.

**Re-checked on the merged build** (the numbers above were measured before the merge):
- The stock sunset scenario now faces the sun, so at high quality it showed the white
  veil out of the box: median brightness 234.6. With the fix it is **140.7**, a
  readable golden-hour frame with beams through the cloud. With motion blur switched
  off, the shafts still draw (141.2) and nothing washes out.
- Speckle check with matching cameras: haze **on 3.86%**, **off 4.16%**, zero strength
  4.16%. The tool now exits by itself on Linux.
- All shaders still compile on the high and ultra tiers, and a full headless race gives
  exactly the same results as before (top speed 320.4 km/h, best lap 1:51.42, no
  errors).
- While porting the shaft fix I found one more problem in it: once the shaft strength
  was normalised, it fell below the old "is it on?" threshold of 0.001, so with motion
  blur off the shafts would have stopped drawing altogether. The check is now "above
  zero", the same test the shader itself uses.

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
| 8 | — | Feel, menu, performance — and the white whale falls |
| 9 | 45* | Real perf + pause + audio wins; sunset whiteout (fixed same day); *scored at 720p vs prior 1080p |

The honest read: screenshot scores plateaued near 50 because each round fixed about as
much as it broke — and the fix for *that* was process, not code: one owner per
property, pinned numbers instead of adjectives, measurements instead of eyeballs, and
re-verifying old wins every round. Meanwhile the things screenshots can't see — the
physics, the gearbox, the menu, the feel — only started improving with real time in
the car. That is the most important lesson in this file.
