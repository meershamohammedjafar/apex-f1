# From browser demo to shipped game

Two things this document covers: what is actually happening in the blown-out frame, and
what it would genuinely take to build this the way GTA, Assassin's Creed and Watch Dogs
are built. Written to be read by someone who is not a graphics programmer.

---

## Part 1 — There is no ray tracing here

Worth saying plainly, because it changes how you read everything else:

**This project contains zero ray tracing.** A grep for it returns nothing. What you are
looking at in that frame is four completely different techniques, all of which are
*fakes* — 2D tricks applied to the flat image after the 3D scene has been drawn.

| What you see | What it actually is | How it works |
|---|---|---|
| Light shafts through the frame | **Screen-space godrays** | Radial blur of bright pixels, smeared outward from the sun's 2D screen position |
| Everything glowing | **Bloom** | Bright pixels blurred and added back on top |
| Soft darkening in corners/creases | **GTAO** (screen-space ambient occlusion) | Samples the depth buffer to guess where light is blocked |
| Shadows on the track | **Cascaded shadow maps** | The scene re-rendered from the sun's viewpoint into a depth texture |

None of these know anything about the 3D world. They work on the finished 2D picture.

### Why the frame blew out

The godray pass builds a mask of "bright sky pixels", then marches each pixel toward the
sun accumulating that mask, multiplying by a decay each step. The shader's own defaults
(`uDensity` 0.6, `uDecay` 0.955, `uWeight` 0.28) are not what runs: the pipeline
overrides them and chains three passes, each one marching over the previous pass's
result:

```
           uDensity  uWeight  uDecay
pass 1:    0.55      0.38     0.962
pass 2:    0.22      0.55     0.975
pass 3:    0.09      0.62     0.985

uDensity         how far the march reaches
uWeight          scale on each pass's output
uDecay           how fast contribution falls off per sample
GODRAY_SAMPLES   16 per pass (high tier)
```

The mask itself is `step(depthCutoff, depth) * smoothstep(threshold, threshold*2.6, luminance)`
— in plain terms: *"is this pixel far away (sky), and is it bright?"*

With the sun in frame on a bright day, that mask covers a huge portion of the screen. And
the decays barely bite over 16 samples: `0.962^16 ≈ 0.54`, `0.975^16 ≈ 0.67`,
`0.985^16 ≈ 0.79`. After the full march, **more than half of the contribution is still
there in every pass.** It barely falls off at all. So a very large bright region gets
smeared across the entire frame, three times over, and added on top. Bloom then blooms
*that*.

Meanwhile auto-exposure meters the (now enormously bright) image and stops down, which
darkens the actual car and track while the glare stays. That is exactly the frame you
sent: white haze everywhere, real geometry sinking into it.

### The deeper problem, and why it matters for Part 2

The godray mask has **no idea what is actually between the camera and the sun in 3D.**
It cannot tell that a grandstand, a car, or the halo is blocking the light — it only knows
"these 2D pixels are bright". So light shafts leak through solid objects, and the effect
has no physical anchor to make it stop.

That single limitation — *screen-space effects only know about the flat image* — is the
defining constraint of this entire rendering approach, and it is precisely what real
engines spend enormous effort escaping. Which is Part 2.

---

## Part 2 — How AAA games are actually built

### The scale, first, because it reframes everything

| Game | Studio | Team | Time | Budget |
|---|---|---|---|---|
| GTA V | Rockstar | ~1,000 across studios | ~5 years | ~$265M |
| Assassin's Creed (mainline) | Ubisoft, 5-10 studios | 1,000-2,000 | 3-4 years | $100M+ |
| Watch Dogs 2 | Ubisoft Montreal + support | several hundred | ~3 years | $100M+ |

These are 3,000-10,000 person-year efforts. Not because the code is a thousand times
harder, but because **the content is**. Which is the first real lesson.

### The engine is not the renderer

This project has a renderer. An engine is much more:

```
Engine
├─ Platform layer      window, input, filesystem, threading, memory allocators
├─ Job system          work-stealing scheduler across all CPU cores
├─ Memory              custom allocators, pools, arenas — no garbage collector
├─ Renderer            graphics API abstraction (D3D12 / Vulkan / console APIs)
├─ Physics             usually licensed: PhysX, Havok, Chaos
├─ Animation           skeletal, blend trees, IK, motion matching
├─ Audio               Wwise or FMOD, DSP graph, spatialisation, occlusion
├─ Streaming           load/unload the world by distance and prediction
├─ Entity system       usually ECS — data-oriented, cache-friendly
├─ Scripting           Lua / C# / visual scripting for designers
├─ Networking          replication, prediction, rollback
└─ Tools               the editor, the asset pipeline, the build farm
```

Rockstar's is **RAGE**, Ubisoft's are **AnvilNext** (Assassin's Creed) and **Disrupt**
(Watch Dogs). Each is decades of accumulated work maintained by dedicated engine teams
who never touch gameplay.

### World streaming — the thing that makes open worlds possible

You cannot load Los Santos into memory. It does not fit. So the world is cut into cells,
and the engine keeps a moving window of them resident:

- The world is a grid (or an octree) of **cells**, each with its own geometry, textures, entities.
- As you move, cells ahead are loaded and cells behind are evicted, on background threads.
- Loading is **predictive** — it uses your velocity and heading, not just your position,
  because a car at 200 km/h outruns a naive loader.
- Every asset exists at multiple **LODs** (levels of detail); distant cells load only the
  crudest version. Distant city blocks are often a single baked "imposter" mesh.
- Nothing may ever block the main thread. A stall is a visible hitch.

GTA V famously streams so aggressively that the game is essentially always loading. The
loading screen at the start is mostly building caches, not loading the world.

**Your project does none of this** — Spa is built once at startup and lives in memory
forever. That is completely correct for a 7 km circuit and completely impossible for a
city.

### The asset pipeline — where the real work lives

This is the part outsiders consistently underestimate. For every asset:

```
DCC tool (Maya/Blender/ZBrush/Houdini/Substance)
    ↓  export
Intermediate format (FBX/USD/glTF) in source control (Perforce)
    ↓  automated import + validation
Cooking: mesh optimisation, LOD generation, texture compression (BC7/ASTC),
         shader permutation compilation, lightmap baking, audio encoding
    ↓
Platform-specific packed archives (.pak / .rpf / .forge)
    ↓
Runtime loads these directly — no parsing, often memory-mapped
```

Key points:

- **Artists never touch code.** They work in tools and hit a button.
- **The pipeline runs on a build farm**, continuously, overnight. A full cook of a AAA
  title takes hours across dozens of machines.
- **Validation is automated**: polycount budgets, texture sizes, naming conventions,
  missing LODs — all rejected at import.
- **Perforce, not Git.** Git handles source code; it does not handle 500 GB of binary
  art with file locking. Every major studio uses Perforce.

A AAA game ships maybe 1-2 million lines of code and **several hundred thousand
individual art assets**. The asset count is the real scale.

### Rendering: how it actually differs from what you have

| | This project | Modern AAA |
|---|---|---|
| Pipeline | Forward-ish + post FX | Deferred or visibility-buffer, clustered lighting |
| Global illumination | None (ambient constant) | Lumen (UE5), or baked lightmaps + probes |
| Shadows | Cascaded shadow maps | CSM + ray-traced or virtual shadow maps |
| Ambient occlusion | Screen-space (GTAO) | Ray-traced AO, or baked + screen-space |
| Reflections | Environment map | Screen-space + ray-traced fallback |
| Light shafts | **Screen-space radial blur** | Volumetric froxel raymarching through real depth |
| Anti-aliasing | SMAA / TAA | TSR / DLSS / FSR with motion vectors |
| Geometry | Manual LODs | Nanite (virtualised micropolygons) |
| API | WebGL2 | D3D12 / Vulkan, explicit control, bindless resources |

Note the light shafts row. Real volumetrics march through a 3D grid ("froxels") that
contains actual depth and density information, so shafts genuinely stop at solid objects.
That is the fix for what you are seeing — and it is not achievable properly in the
screen-space approach this project uses.

**Ray tracing**, when a modern game says it, means casting real rays against a hardware
acceleration structure (a BVH) on the GPU, for shadows, reflections and GI. It requires
API support (DXR/Vulkan RT) that WebGL2 does not have.

### Tooling — the editor is the product, internally

Studios spend enormous effort on tools nobody outside ever sees:

- **World editor** — designers place and paint the world visually, with live preview.
- **Hot reload** — change a texture, script or asset and see it in the running game.
- **Live debug views** — overdraw, shader complexity, light counts, memory, streaming cells.
- **Automated test farms** — bots drive the world overnight looking for crashes and holes.
- **Telemetry** — playtest sessions upload heatmaps of deaths, stalls, framerate dips.

Rule of thumb inside big studios: **roughly a third of engineering effort goes into tools**,
because a hundred content creators being 20% faster dwarfs any single feature.

### Team structure

```
Creative Director ─── Game Director ─── Producers
   │
   ├─ Engine        rendering, core, physics, audio, tools, pipeline
   ├─ Gameplay      systems, AI, combat/driving, missions, UI
   ├─ Art           environment, character, VFX, technical art, lighting
   ├─ Design        level, systems, mission, economy, UX
   ├─ Audio         sound design, music, implementation
   ├─ QA            functional, compliance, certification, automation
   └─ Production    scheduling, outsourcing, publishing, localisation
```

**Technical artists** are the crucial glue role — part artist, part programmer, they build
shaders and tools so artists never need an engineer. If you ever grow this project, that is
the first specialist role that pays for itself.

---

## Part 3 — Getting from here to a standalone game

### You are already standalone, technically

`npm run dist:win` produces a portable `.exe` today. Electron bundles Chromium, so it
installs and runs like a normal Windows app with no browser visible.

But be clear about what that is: **a browser in a costume**. You still get WebGL2, a
JavaScript garbage collector that can cause frame hitches, no real thread control, and
roughly a 150 MB baseline from shipping a whole browser engine. It is a real distribution
path — plenty of shipped games do it — but it does not raise the technical ceiling.

### The four honest options

**Option A — Stay on web tech, polish and ship.**
Keep everything. Ship via Electron or Tauri (Tauri uses the OS webview, so ~10 MB instead
of ~150 MB). Optionally migrate rendering to **WebGPU**, which gives compute shaders and
much better draw-call handling than WebGL2 — a genuine step up, and Three.js has a WebGPU
renderer now.
*Cost:* weeks. *Ceiling:* good-looking indie. Not AAA lighting.

**Option B — Godot 4.**
Free, open source, no royalties, exports native binaries for every platform. 3D has become
genuinely capable (SDFGI for global illumination, real volumetric fog). GDScript is close
enough to Python to be quick; C# available.
*Cost:* months, full rewrite of the rendering and engine layers. *Ceiling:* strong indie
to AA. Best effort-to-result ratio for a solo developer.

**Option C — Unity.**
Enormous ecosystem and asset store, C#, HDRP for high fidelity. Lots of racing-specific
middleware exists.
*Cost:* months. *Ceiling:* AA, and AAA with serious effort.

**Option D — Unreal Engine 5.**
Everything failing in your current build is solved out of the box: **Lumen** (real
dynamic GI and reflections), **Nanite** (no manual LODs), **TSR** (excellent
anti-aliasing), real volumetric fog with proper light shafts, and hardware ray tracing.
Chaos Vehicles for physics, or bring your own. Free until $1M revenue, then 5%.
*Cost:* the steepest learning curve, C++ or Blueprints, big installs and build times.
*Ceiling:* actual AAA. This is what a photoreal racing game would realistically be built in.

### What survives a rewrite — and it is more than you think

This is the important part. If you move engines, you do **not** start from zero.

**Transfers completely** (it is maths and data, not framework code):
- The entire tyre model — Pacejka coefficients, load sensitivity, thermal model
- Powertrain: torque curve, gear ratios, turbo lag, ERS, the shift-blend fix
- Aerodynamics: downforce/drag coefficients, ground effect, DRS, dirty air
- Suspension rates, anti-roll bars, damper curves, the driveline compliance model
- The Spa circuit geometry — the spline, elevation, banking, corner data
- Racing line generation and the AI speed-profile solver
- Race rules, timing, sector logic, flags
- HUD design and layout
- **Everything in `docs/JOURNAL.md` and `docs/TECHNICAL-NOTES.md`** — the hard-won
  knowledge, including every bug that took four rounds to understand

**Does not transfer:**
- All Three.js rendering code, every shader, the material library, the post chain
- The procedural texture generation
- The capture/review harness (though the *idea* is worth rebuilding)

Roughly: **the simulation survives, the rendering does not.** And the simulation is the
part that is genuinely hard to get right — you have measured lap times, speeds and shift
stability that prove it works.

### A realistic path from here

1. **Decide what this project is for.** A portfolio piece, a game you want strangers to
   play, or a way to learn? The answer changes everything below.
2. **Finish the current build as a vertical slice.** Fix the outstanding bugs, get it
   stable and shippable via Electron. A finished small thing beats an abandoned big thing,
   and it proves the simulation.
3. **Extract the simulation into engine-agnostic form.** Pure functions and data: no
   Three.js imports in physics, tyres, powertrain, AI or circuit data. Worth doing even if
   you never port — it is just better architecture.
4. **Prototype one corner in the target engine.** Not the whole game. Load the Spa spline
   into Unreal or Godot, wire your physics, drive one corner. You will learn more in that
   week than from any amount of reading.
5. **Then decide,** with real information, whether to port.

### The honest summary

Your project is roughly 38,000 lines built in weeks (about 35,000 of them JavaScript
under `src/`). GTA V was ~1,000 people for five
years, and the gap is overwhelmingly **content and tooling**, not cleverness. No amount of
rendering work in WebGL closes it.

But "AAA-looking racing game built by one person" is a real category, and it is reachable
— in an engine that hands you global illumination, virtualised geometry and proper
volumetrics for free, so your effort goes into the car, the track and the feel rather than
into re-deriving lighting from scratch.

The simulation you have built is the hard, valuable, portable part. The rendering is the
replaceable part.
