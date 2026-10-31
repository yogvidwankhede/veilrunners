# VEILRUNNERS — The Cradle of Silt

A third-person challenge tomb for the browser. One complete level in seven chambers, playable alone or with one partner. Recover the Sun Disc of Ixchel and get back out before the tomb floods.

Runs in Chrome, Edge, Firefox and Safari on desktop, and on phones and tablets with touch controls. It also supports gamepads. There is nothing to install.

## Play

```bash
npm install
npm start
```

Open http://localhost:8080. `npm start` rebuilds the page from `src/` and then serves it.

Pick **Solo**, **Same screen** or **Online** on the title, then press **Enter the Tomb**. The first run teaches each move in the chamber where you first need it, from the first step to the flood, and the boost when you play with a partner. You can turn this guidance off in Settings.

### With a partner

**Same screen.** Pick *Same screen*. The view splits: runner one on the left (keyboard and mouse, or pad 1), runner two on the right (arrow keys, Enter to jump, Right Shift to run, `/` to use, `.` to crouch, `,` to roll, `'` to strike, `;` to guard, or a pad). With one pad plugged in, it goes to runner two. Each half has its own camera, prompts and objective marker, and each runner has a name card and a colour: teal for one, coral for two. **Playing Together** on the title and pause menus explains all of it.

**Online.** Pick *Online*. Both players open the same address and type the **same room code**, or both open `http://<host>:8080/?room=NAME`. The first player in hosts the world. If the host leaves, the partner takes over and keeps the run. If the connection drops, the run carries on solo.

With two runners the tomb **needs both of you**. The solo time windows switch off:

- **The counterweight**: both levers must be held together, within 0.6 s of each other.
- **The crane is a relay**: the arm is out only while someone holds a crane lever. One holds while the other crosses; then the runner who crossed holds the **far lever on the tower** to bring the arm back for the other.
- **The counted floor**: one partner winds the winch to lock the slabs while the other crosses.
- **Boost**: crouch beside a wall and your partner can jump off your back, about a metre higher than they can jump alone.
- **The way out**: the tomb ends when **both** runners are at the front door.

If a partner leaves mid-run, every gate goes back to its solo rule.

A phone on the same Wi-Fi can join at `http://<this-computer>:8080/?room=NAME`.

## Controls

| Action | Keyboard & mouse | Gamepad | Touch |
| --- | --- | --- | --- |
| Move | W A S D | Left stick | Left stick |
| Look | Mouse (click the view to capture it) | Right stick | Drag on the right half |
| Run | Shift | LB / L3 | Push the stick fully |
| Jump · grab · climb | Space (hold for the full arc) | A / Cross | JUMP |
| Boost a partner (co-op) | Crouch beside them; they jump | Y, then A | CROUCH / JUMP |
| Crouch · lower into a hang | C | Y / Triangle | CROUCH |
| Use · hold a lever | E | X / Square | USE |
| Roll | Q | B / Circle | ROLL |
| Guard | F | LT | GUARD |
| Strike | Click / J | RT | STRIKE |
| On a ledge | W climb · A/D shimmy · S drop | Left stick | Left stick |
| Pause | Esc | Start | ‖ button |
| Mute | M | — | — |

Run, Use and Guard can each be set to **hold** or **toggle** in Settings.

## The tomb

The tomb is built around a chasm with the **Cradle** hanging in it: a colossal basin of glowing silt on four chains, visible from most of the route. Every chamber stands on masonry founded in the lava below.

1. **The door that was shut.** You wake in the crypt, under the collapse, between its columns. The front door, kept by two obelisks, does not open yet. Go through the doorway in the screen wall and up the stair hall.
2. **The north gallery.** The stairs end. Jump at a lip to catch it, then climb.
3. **The counterweight.** A great stone gear on the chamber's north wall turns when the bridge drops. There are two levers, one on each side of the chamber. With a partner, hold both at the same moment. Alone, throw one and reach the other before its ring empties (about 8 s). This wakes the statues. Clear them to open the way east.
4. **The counted floor.** Under two arches over the lava, three slabs drop in turn. Watch one full pass, then run. A partner can hold the winch to lock them.
5. **The crane.** Hold a lever and cross the arm. Alone, the arm stays out for about 10 s after you let go. With a partner, it is a relay across the near and far levers.
6. **Three fires.** Read the glyphs, then light the braziers in the order they give. A wrong fire only resets the order. Take the disc.
7. **The tomb closes.** The water rises and the front door opens. Run west across the ruins under the old aqueduct, back through the crypt, and out.

If you die, you return to the start of the chamber you reached. The results board grades the run (S–C), records your personal best, and awards honours. The title screen and the Records panel keep track of these across sessions.

## Settings

All settings are saved in the browser (`localStorage`). If storage is blocked, everything still works for the session.

- Master volume, look sensitivity, invert Y, field of view
- Camera shake (also scales the landing dip and speed FOV, for motion comfort)
- Graphics quality: **Auto** measures frame time and steps down when it misses budget. Low, Medium and High are fixed.
- Tutorial guidance, objective marker, captions, controls strip, frame-rate readout
- Hold or toggle for Run, Use and Guard

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Build, then serve on `:8080` (dev mode) |
| `npm run build` | Build `index.html`, the offline builds, and `dist/` |
| `npm run serve` | Serve without rebuilding |
| `npm run prod` | Serve in production mode |
| `npm test` | All headless rule suites (see below) |
| `npm run e2e` | End-to-end in Chromium, Firefox and WebKit |

## Movement

- **Body.** A 0.36 m capsule. Walls, ledges and stand-offs all derive from `PHYS.bodyRadius`.
- **Collision.** Matches the visible stone. The architecture uses its own boxes. Carved props and masonry are **baked from their triangles** into a 10 cm height grid (`src/collisionmap.js`, generated). Node and the browser collide against the same data. Against rounded stone the body slides around rather than stopping, and a body found inside stone walks itself out.
- **Ledges.** A jump catches a lip only when the **hands** reach it: the lip 1.15–2.05 m above the feet, at the face, and facing or moving into it. A waist-high ledge is climbed straight up. A lip above standing reach needs the jump. A climb finishes 0.7 m in from the edge.
- **Hang and climb.** The hang pivots about the hands so the chest clears the stone and the feet brace on the face. The climb plays the Mixamo climb-to-top clip, locked to the climb's progress, with its root motion warped onto the simulated path.
- **Edge assist.** Walking stops at a drop of more than 2.6 m. Running, jumping, or crouching into a hang still go over.

## Testing

```bash
npm test        # tombtest, runthrough, feeltest, climbcover, propcheck, cooptest, cooprules, tutorialtest
npm run e2e     # or: node tools/e2e.mjs chromium
```

These need `npm start` running, and use this machine's GPU through headless Chromium:

```bash
node tools/perf.mjs              # frame time per quality tier, also with the CPU throttled 4x
node tools/collisionaudit.mjs    # invisible walls: collision with no visible stone nearby
node tools/posefilm.mjs climb    # film a traversal move frame by frame: snaps/film-climb.jpg
node tools/camwall.mjs           # the runner against every wall face, camera turned all the way round: the lens never inside stone
node tools/bakecollision.mjs     # re-bake the collision map after changing placements, level.js or world.js
VEIL_FILM=/tmp/film.json node tools/runthrough.mjs && FILM=/tmp/film.json node tools/playfilm.mjs
                                 # replay the full playthrough in the real renderer: snaps/playfilm-N.jpg
node tools/spotcheck.mjs "x,y,z,yaw,pitch"   # a close-up of one spot, with what mesh is under the screen centre
FILM=/tmp/film.json node tools/glitchhunt.mjs   # sprint, strafe and jump all over the route; log every frame the
                                 # body, its mesh or the camera moved further than a body can
```

| Suite | Guards |
| --- | --- |
| `tombtest` | Geometry, reachability, placements, lamps, seams, and that no beat can be skipped |
| `runthrough` | A full solo playthrough with real physics, from the entrance to the door |
| `feeltest` | Jump, grab, mantle and shimmy against their target timings |
| `propcheck` | Nothing solid can be walked through |
| `cooptest` | Two in-process clients on the real relay: a partner moves and both ends agree, including over a 120 ms link with 5% loss; a vanished relay degrades to solo |
| `climbcover` | Every climbable face in the tomb, tried standing and from a running jump: each has to end with the runner on top |
| `cooprules` | With two runners every gate needs both, and each is still solvable together; alone, the solo rules still hold |
| `tutorialtest` | Every tutorial note clears when its move is performed, and stale lessons are skipped |
| `e2e` | The real page in three engines: title, settings, controls, start, movement, pause/resume/restart, results, records, quit, a phone touch layout, and same-screen two-player (the guide, the split, runner two's own keys). Also two-browser co-op: a shared lever puzzle synced across the wire, and host migration. Fails on any page error. Screenshots go to `snaps/e2e-*.png` |

`e2e` needs Playwright's browser builds. If they are missing, run `npx playwright-core install chromium firefox webkit`. Headless engines rasterise in software, so the frame times they report are a floor, not a target.

## Architecture

- **three.js r160**, bundled by **esbuild** into a single IIFE inlined into `index.html`. No framework and no CDN at runtime; fonts load from Google Fonts and fall back to system fonts.
- **Fixed-timestep simulation** at 60 Hz (`constants.TICK`) with an accumulator and render interpolation. Input edges are cleared by the tick that consumes them, which gives input buffering at any refresh rate.
- **Simulation** (`game.js`, `move.js`, `traversal.js`, `mech.js`, `interact.js`, `story.js`, `rooms.js`): pure functions of state and `game.t`, with no DOM and no rendering. This is why the Node suites can run the whole tomb.
- **Presentation** (`main.js`, `world.js`, `water.js`, `fbxrunner.js`): lights, camera spring arm, animation, particles, and procedural WebAudio (`audio.js`, no sample files).
- **Front end** (`hud.js`, `ui.js`, `prefs.js`, `tutorial.js`): menus, panels, settings, records, achievements, and the tutorial. None of it writes to the simulation, so it cannot desync co-op.
- **Input**: keyboard and mouse with pointer lock, touch (`touch.js`), and standard-mapping gamepads (`gamepad.js`, with a radial deadzone). All look devices go through one path, so sensitivity and invert apply to every one.
- **Quality** (`quality.js`): three tiers with a millisecond budget each. The auto-tuner measures P95 frame time and only ever steps down. A fixed pool of 8 point lights serves 45 emitters.
- **Co-op** (`net.js`, `serve.mjs`): host-authoritative with guest prediction and reconciliation, with 20 Hz snapshots and 60 Hz input. The server is a relay and never simulates.

### Co-op trust model

Co-op is cooperative PvE, so the host's browser is the authority. The relay enforces:

- two sockets per room
- a 16 KB payload cap and 150 messages/s per socket
- direction: only a host can send world snapshots, and only a guest can send input
- a 15 s heartbeat, so a vanished phone frees its slot

The host clamps and renormalises every guest input before using it, so a crafted packet cannot speed-hack. Names from the wire are sanitised, and the event feed renders them with `textContent`.

## Deployment

The game needs one Node process: the page plus the WebSocket relay on the same origin.

```bash
npm ci
npm run build            # writes dist/: index.html, ~16 MB of assets, serve.mjs, package.json
cd dist && npm install --omit=dev && npm start   # NODE_ENV=production, PORT defaults to 8080
```

Or with Docker:

```bash
docker build -t veilrunners .
docker run -p 8080:8080 veilrunners
```

Production mode serves only the page and `assets/`. Source files, tools and the dev `/__snap` endpoint return 404. It sends gzip, `no-cache` for the page, a day of caching for models, security headers, and exposes `GET /healthz` for load balancers. Put TLS in front of it (any reverse proxy, or a platform such as Fly.io, Render or Railway). The client switches to `wss://` automatically on `https`.

**Render:** `render.yaml` is a blueprint for one free Docker web service. Open https://render.com/deploy?repo=https://github.com/yogvidwankhede/veilrunners and apply it. The free tier sleeps when idle, so the first visit after a while takes about 30 s.

**Static-only hosting** (Netlify, Vercel, S3, GitHub Pages) works for solo play: upload `dist/` without `serve.mjs`. Co-op needs the Node relay.

**Offline builds**: `index-embedded.html` (~20 MB, every model and the rig inlined) can be opened from disk with a double-click. `index-artifact.html` stays under 10 MB and uses the static runner.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `NODE_ENV` | — | `production` locks the server to the public allowlist |

## Known limitations

- **Performance on phones and tablets is unmeasured.** On the development Mac (M4 Max, real GPU through `tools/perf.mjs`) every tier holds 60 fps, and still does with the CPU throttled 4×. No physical phone or tablet has been profiled; the Auto tier steps down on device.
- **Gamepad input** follows the W3C standard mapping and is covered by code review only. No physical pad was tested in this pass.
- **Co-op over a real WAN** (latency and packet loss) has not been tested. Two-browser co-op is tested on one machine.
- **Solo co-op gates** keep timed fallbacks rather than an AI companion: alone, KESTREL stays at the entrance.
- **The Docker image** is written but was not built in this environment (no Docker available).
- **Meshy assets**: the generation key used for the 30 GLBs has been revoked, so no new models were generated in this pass.

`HANDOFF.md` is the full design and engineering log: every decision, every rejected approach, and why.
