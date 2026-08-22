# Working on Gang Garrison 2 with this tooling

Operating guide for an AI agent. Read this before touching either repo.

## The two repositories

| Repo | Contains | Rule |
|---|---|---|
| `gg2-agent` (this one, private) | all tooling: build scripts, the agent bridge payload, the MCP server, the launcher | tooling only |
| `Gang-Garrison-2` (public fork) | the game itself | **feature code only** — never commit tooling, build scripts, or the bridge here |

The bridge is **injected** into the game's source tree at build time and removed
again afterwards. If you find `AgentBridge` files, an `instance_create(0, 0,
AgentBridge);` line, or an `AgentBridge.heldMask` reference inside
`PlayerControl` committed in the fork, that is a mistake — run `cleanup.js`.

## The loop

```powershell
node build-fast.js      # splice code changes into the last build         (~3s)
node run-agent.js       # launch the game, wait for the bridge
node build-agent.js     # full build - drives GM8 headlessly            (~1min)
node tools/selftest.js  # check the tooling itself, against a fake game   (~3s)
node tools/navaudit.js  # can bots path to the objective on each map?     (~1s)
node tools/botscenario.js # do bots still WALK those routes?              (~1min)
```

`build-agent.js` used to be the one step that needed a person: Game Maker 8 has
no command-line compile. It no longer does in the common case -
`tools/gm8directbuild.js` runs Game Maker on a desktop that is never displayed
and calls straight into the compiled routine behind *File > Create Executable*,
so there is no menu, no Save dialog, no window and no desktop session involved.
It only falls back to opening the project and waiting for someone if Game Maker
8 cannot be found, or is not the exact build the call address was
reverse-engineered against (checked by sha256) - `--manual` forces that
fallback. Either way it is much slower than `build-fast.js` and only needed to
bootstrap the fast-rebuild template or after adding/removing/renaming a
resource.

Every script takes `--repo <path>` and `--help`, and each is a module as well as
a CLI - which is how `gg2_rebuild` builds in-process rather than shelling out.

Then drive the running game with the MCP tools:

| Tool | Use it for |
|---|---|
| `gg2_ping` | confirm the game is reachable; try this first when anything fails |
| `gg2_evalx` | read live state — `room_speed`, `instance_number(Player)`, `global.currentMap` |
| `gg2_eval` | change live state, call scripts, create instances |
| `gg2_state` | structured snapshot: room, fps, host flag, players with team and class |
| `gg2_screenshot` | look at the game; works while it is frozen |
| `gg2_map_image` | full-resolution map, no camera involved; `base` picks walkmask/art/both, `overlay: true` adds bot nav-graph reachability |
| `gg2_area_shot` | full-resolution **live** screenshot of an area bigger than one window, tiled and stitched; `walkmask: true` traces the collision boundary over it |
| `gg2_step` | freeze, then advance an exact number of frames |
| `gg2_resume` | let a frozen game run again |
| `gg2_speed` | run the live game faster (or slower) than real time, for burning through a slow stretch |
| `gg2_input` | press, release and click; `aim` is currently broken, see below |
| `gg2_wait` | run until a GML expression is true, or give up after N frames |
| `gg2_watch` | sample expressions every frame; changes land in the bridge log |
| `gg2_sprite` | replace a sprite from a PNG at runtime, without a rebuild |
| `gg2_lint` | check GML compiles **before** writing it to a file or evaluating it |
| `gg2_event` | read and write the GML inside object events, escaping handled |
| `gg2_find` | search scripts *and* event code together — grep cannot see events |
| `gg2_test` | run the game's own unit tests and read the results back |
| `gg2_scenario` | run live bot behaviour scenarios; can a bot still walk A to B? |
| `gg2_session` | start, stop and list games: a dedicated server and its clients |
| `gg2_rebuild` | apply edited `.gml` and event code to the game, then relaunch (~3s) |
| `gg2_log` | read the game's logs, including GML errors the launcher dismissed |

### Seeing what happens, rather than guessing

The game runs at 30 frames a second and an MCP call takes ~40ms, so polling
`gg2_evalx` samples whenever you get round to asking. Three tools exist to close
that gap, and between them they cover almost every "why did it do that":

- **`gg2_step`** freezes the world and advances it by an exact number of frames.
  Freezing works by deactivating every instance except the bridge, so nothing
  moves while you inspect it. `gg2_screenshot` reactivates, redraws and freezes
  again, which runs no step events — a frozen screenshot shows the real frame.
- **`gg2_wait`** tests a condition inside the game once a frame, so a state that
  lasts two frames is not missed.
- **`gg2_watch`** samples up to eight expressions every frame and writes changes
  to the bridge log; `gg2_log` is how you read the trace back.

**`gg2_map_image` and `gg2_area_shot` answer two different questions that look similar.**
The first is "what does the map look like" (or "why is the nav graph disconnected here");
the second is "what is actually happening on the map right now."

- **`gg2_map_image`** doesn't touch the camera at all — it reads the map's own
  `Included Files/<name>.png` directly off disk (every built-in map ships as exactly this
  art, at native map-pixel resolution, e.g. `koth_valley` is 804×170 - checked against all
  22) and, if asked, plots the bot nav graph on top: a directed BFS from a start point
  (a bot's own position by default), green if reached and red if not, one bar per node.
  A nav cell is exactly one map pixel (F10's ×6 world-scale constant is the same
  `NAV_CELL_SIZE`), so the overlay needs no coordinate conversion. This is what
  root-caused a real `navJumpFlight` bug (2026-08-20 — a steep jump-up was being
  rejected; see `Gang-Garrison-2`'s bot plan for the detail): a screenshot answered in
  one look what used to take a dozen `gg2_eval` round-trips summing edges by hand, and
  because it never goes through the game's own renderer there is no camera distortion,
  no window-resolution cap, and nothing to stitch. This replaced an earlier `gg2_nav_map`
  that *did* screenshot the live camera, and had exactly those problems - most visibly,
  a wide map squashed to fit an ~4:3 window (GM8 scales each view axis independently, so
  a rectangle whose aspect ratio doesn't already match the window comes out warped) -
  worth knowing if `gg2_nav_map` shows up in an old transcript. It only knows built-in
  maps; a custom (player-uploaded) one has no fixed path on disk and gets a clear error
  rather than a wrong image.
  **The base layer is the walkmask, not the art, whenever the overlay is on** (`base:
  "mask" | "art" | "both"` overrides; it defaults to `art` with the overlay off, since
  that is a different question). The same PNG carries the map's collision mask in its own
  `zTXt` "Gang Garrison 2 Level Data" chunk - the game reads it the same way, see
  `Scripts/Maps/CustomMaps` - and `tools/walkmask.js` decodes it with no game running.
  This matters because **the nav graph is built against the mask and nothing else**, so
  the art agrees with an overlay only by coincidence: it paints scenery nothing collides
  with, and draws real geometry as though it were background. `koth_valley` is the plain
  case - a dark night scene whose underground is nearly black, in which the two vertical
  shafts that cost this project a bug are invisible, and where the mask shows every
  standable surface the node bars are sitting on. `node tools/walkmask.js <map> out.png`
  renders one on its own; `navimage.js --base` is the same switch.
- **`gg2_area_shot`** is for when the *live* game is what needs seeing at more than one
  window's worth at a time - players, projectiles, capture progress, an actual running
  match - which `gg2_map_image` fundamentally cannot show, since it never asks the game
  anything beyond its current map name. It freezes the game (a camera-follow Step event
  would otherwise reset the view before every tile's redraw - confirmed live: two tiles
  taken without freezing came back pixel-identical), tiles the requested area into
  window-sized shots at exact 1:1 zoom so nothing warps, and stitches them into one
  image before resuming. Verified live: two adjacent tiles of `koth_valley` stitched with
  a seamless terrain boundary at the tile edge. `hide_hud` (default true) deactivates
  every HUD-drawing object this tooling knows about - team/class select, the gamemode's
  own status bar (score, timer, capture-point lock icon), kill log, ammo/health/uber/
  sentry/nuts-and-bolts HUD, respawn timer, win banner, medic radar, notices, the
  spectator overlay - and blanks the cursor sprite, so a full-map capture isn't tiled
  with a repeating scoreboard and crosshair.
  **⚠️ `visible = false` does not hide most of these**, and this cost a whole extra
  round before landing on what does: `KothHUD`'s own Draw event (like its siblings)
  draws through custom GML, not GM8's automatic sprite draw, and that code runs
  regardless of `visible` - confirmed live, a capture-point lock icon and the score/timer
  bar both survived `with(HUD) visible = false` completely unchanged, even though `HUD`
  is their common parent and the same parent-inclusive `with()` reliably works elsewhere
  in this codebase. `instance_deactivate_object(HUD)` (`agentBridgeHudVisible.gml`) does
  work, because deactivating stops the Draw event itself from firing. That, in turn,
  collided with `agentBridgeShot`'s existing `instance_activate_all()` - needed so a
  *frozen* game draws its real content instead of an empty room - which reactivates
  everything unconditionally, silently undoing the suppression one frame before it would
  otherwise have mattered. Fixed by having `agentBridgeShot` re-apply
  `agentBridgeHudVisible(false)` itself, every single redraw, whenever
  `global.agentHideHud` is set - confirmed live across two separate tile captures in a
  row, not just one. `TeamSelectController`/`ClassSelectController` are the one exception
  that *does* need only `visible`, since neither has a custom Draw event of its own.
  **`walkmask: true` traces the collision boundary over the shot in magenta**, so what the
  geometry is and what everyone is doing in it can be read off one picture. It is
  composited on the Node side, not drawn in the game: one mask cell is exactly
  `NAV_CELL_SIZE` (6) world pixels and the tiles are captured at 1:1, so it lands on the
  pixels the collision actually uses - no resample, no GML, and nothing that can disturb a
  running server. It is an *outline* because a fill was tried first and lost: over a map
  painted this dark, tinting solid ground either disappears into the art or hides whatever
  the shot was taken for.

The underlying pieces (`agentNavReach`, `agentNavDump`, `agentBridgeDraw`,
`agentBridgeHudVisible`) live permanently in the bridge payload, not a spare, since this
is meant to be reached for again rather than rebuilt from scratch each time.

`press left|right|up|jump|down|taunt` actually holds - the bridge ORs a mask
into `PlayerControl`'s own `keybyte` every step - so `gg2_input` plus
`gg2_step` is "hold right for twelve frames" exactly, for those six. Every
other action (`attack`, `special`, arbitrary keys) still goes through
`keyboard_key_press`, which does not make `keyboard_check` true on this build -
only the `_pressed`/`_released` edge, which is enough for one-shot actions
(`drop`, `medic`, `changeteam`, ...) but not for holding down fire. For that,
call the game's own `Scripts/Input/input*.gml` directly with `gg2_eval`.

**Freezing stops the objects that service the network.** A connected client or a
hosting server falls behind while frozen and may drop. Freely on a single game;
carefully inside a session.

### Running faster than real time

`gg2_speed` scales how many game ticks happen per real second - `factor: 10` for
ten times normal, `factor: 0.5` for half-speed slow motion, no `factor` (or `0`)
to reset. It exists because `gg2_step`/`gg2_wait` are for *inspecting* a handful
of frames closely, not for skipping past a slow stretch of bot behaviour in real
time before you get to the part worth looking at.

GM8 paces its own step loop to hit `room_speed` steps a real second, and
`RateController.Begin Step` resets `room_speed` back to 30 or 60 every single
frame - confirmed live, 2026-08-20: setting `room_speed` directly with `gg2_eval`
was already back to 30 by the very next `gg2_evalx` read. `gg2_speed` works by
deactivating `RateController` first, which is what makes a different value
stick. This does not touch per-tick game logic: `RateController` only
recalculates `global.delta_factor`/`frameskip`/`ticks_per_virtual` for its own
two supported rates, and deactivating it leaves those exactly as they were - so
a boosted game does the same thing per tick, just more ticks per real second.
Measured live at `factor: 10`: 296.7 sim-fps against a 30.0 sim-fps baseline,
with an exact restore to 30.0 on reset.

**It is not sticky.** `gg2_step`, `gg2_wait`, `gg2_resume` and a frozen
`gg2_screenshot` all call `instance_activate_all()`, which reactivates
`RateController` right along with everything else and lets it reset
`room_speed` on its next `Begin Step` - confirmed live, the same call sequence
above. So the boost silently drops back to normal the moment any of those run.
Usually that is convenient (nothing can leave the game stuck at 10x by
accident), but call `gg2_speed` again afterwards to keep fast-forwarding. And
because it speeds up whatever services the network each frame too, it carries
the same caution as freezing: fine solo, careful inside a `gg2_session`.

### More than one game at once

Nothing about the network protocol is observable from inside one process, so
`gg2_session start` brings up a dedicated server and its clients, each named
(`server`, `client1`, …) and separately addressable through the `instance`
argument that every live tool takes. Leave `instance` out while only one game is
running. `tools/instances.js` is the register the launcher writes and everything
else reads; a dead entry is pruned on the next read.

Things that bite here: the hosting port lives in `gg2.ini` (`HostingPort=8190`)
and has no command-line flag, so clients need `-server` *and* `-port` together;
`MultiClientLimit=3` caps connections from one address, and every local client
is the same address; and `UseLobby` must be 0 or a dedicated server announces
itself to the public lobby. `gg2_session` handles all three. Both games share one
`gg2.ini` and one working directory — only the logs are separated, by port.

### The spare objects, and the spare scripts

`AgentSpare0..3` are blank objects built into the executable. `build-fast.js` can
only replace code that already exists in the template, so a genuinely new object
costs a full IDE build; a spare costs a ~3s splice. Write to one with
`gg2_event`, `gg2_rebuild`, then `instance_create(x, y, AgentSpare0)`. Their
events hold placeholder comments rather than nothing, because the splicer cannot
place an empty string — do not tidy them to empty.

`agentScriptSpare0..5` are the same idea for standalone scripts, since
`gg2_rebuild` refuses a brand new script name exactly like it refuses a brand
new object. Each is a real registered resource already, with a placeholder
comment as its body (payload/Scripts/AgentBridge/agentScriptSpareN.gml) — edit
the file directly (there is no `gg2_event`-equivalent for a plain script; it is
just a `.gml` file) and `gg2_rebuild`/`build-fast.js` splices it in ~3s, the
same as any other script edit. Once behaviour proven in a spare is worth
keeping, giving it its real name still needs one full `build-agent.js` build —
the spares buy iteration speed while a script is being written, not a way to
skip ever renaming it.

Editing the game's `.gml` does **not** affect the running game: the code lives
inside the executable. Three ways to close that gap, cheapest first:

| Cost | Use | For |
|---|---|---|
| ~40ms | `gg2_eval` | trying an idea out against live state |
| ~3s | `gg2_rebuild` / `build-fast.js` | code you have written into the tree |
| ~1min | `build-agent.js` | new objects, sprites, rooms, settings, or the bridge |

So: experiment with `gg2_eval`, write the result into the source, and
`gg2_rebuild`. Reach for the full build only when the fast one refuses.

### Investigating bad bot navigation

`NAVMETHOD.md` is the loop, written to be repeated: sweep offline with `navsuspects`, read
the route, read the mask, then run it live and let `ticks / travel` say whether the route
is long or the bot is broken. It also carries the two rules that have saved the most
damage - model a generator change in Node before building it, and A/B it against rebuilt
graphs on every map rather than against the scenario suite, which only covers three.

### Auditing the bot nav graph without a running game

Every map a server has loaded leaves its whole nav graph on disk at
`Source/build/botnav/<map>_a<area>.txt`. That is enough to answer "can a bot
path from its spawn to the objective on this map" with no game, no bridge and no
map rotation - seconds for all 22 shipped maps, against roughly a minute each to
watch one live.

```powershell
node tools/navaudit.js                      # every cached graph, failures only
node tools/navaudit.js koth_corinth         # one map, in detail
node tools/navaudit.js koth_corinth --gaps  # near-miss pairs across a boundary
node tools/navaudit.js koth_corinth --node 64
node tools/navimage.js koth_corinth out.png --crop 228,100,300,145 --scale 14
```

`tools/navgraph.js` is the reader and the model (cache decoding, world<->node
conversion, the gate rules); `navaudit.js` is the checks; `navimage.js` draws the
graph over the map's own collision mask. Run the audit **before** playtesting a
map - a bot with no route stands perfectly still, which is indistinguishable
from a dozen other bugs when you are watching it happen.

**`tools/walkmask.js` is the one decoder for what a map is made of** - the zTXt
level-data chunk, the `{WALKMASK}` bitstream inside it, and the three ways of
drawing it (`toRgba`, `tint`, `outline`). `navgraph.js` re-exports `levelData`
and `walkmask` from it rather than keeping a second copy, so `nav.entities`,
`navaudit --mask`, `navimage --base` and `gg2_map_image`/`gg2_area_shot` all
read one implementation. `decode()` hands back `{ width, height, bits,
solid(x, y) }`: the buffer for whole-image work, the bounds-checked accessor for
asking about a handful of cells. Solidity only - **gates, player walls and
drop-through platforms are instances, not mask**, stamped into the graph by
`navMarkInstances`, so a cell the mask calls open can still be closed to a bot.

### Behaviour scenarios (`tools/botscenario.js`)

The third tier, and the only one that can see whether a bot can *execute* the
route the graph promised. That gap is the whole point: every one of this
project's three jump-edge bugs was a graph describing an arc the follower could
not fly, and `navaudit` passes all of them, because the edge is right there in
the graph. On its first run this found `ctf_truefort` red -> blue intel stalling
740px short with a valid 19-node path in hand.

```powershell
node tools/botscenario.js                   # every scenario
node tools/botscenario.js valley-floor-to-point
node tools/botscenario.js --list
node tools/botscenario.js --speed 10 --keep # slower, and leave the bot in place
```

**To test a behaviour you are working on right now, do not edit the file** -
pass `gg2_scenario` an inline `scenario` object (same shape as a file entry) and
it runs that and nothing else. Nothing is written to disk, so trying a
coordinate and trying again costs nothing and no throwaway probe ends up in the
committed suite. Promote it into `tools/bot-scenarios.js` once it earns a place;
that is an edit to that file and nothing else, no GML and no rebuild, which is
the reason the runner is in Node rather than in the game's own test suite. (The other reason is that a GML
script runs to completion inside one step, so the existing `test_*.gml` suites
fundamentally cannot express "run 600 frames and then check".)

Three things it needs from the game, all of them because they cannot be
recovered from outside: `botGoalLocked` (suspends the objective layer, which
would otherwise rewrite the goal every 30 ticks), `botArrivedAt` (the exact tick
of arrival - polling can only bracket it), and the four diagnostics counters. It
asserts on those counters, not on final position: a bot that arrives clears its
goal and is then free to walk away, so a position sampled at the end is
meaningless. **Never cap `replans`** - planning is on a 45-90 tick timer, so that
number measures how long the leg took, not whether anything went wrong.

⚠️ **The bridge serves one client at a time**, so from an editor session use the
`gg2_scenario` tool, not this CLI: the CLI's connection would be accepted into
the backlog and never serviced, hanging every call while the game is plainly
alive and answering the MCP server. The CLI is for CI and for a game nothing else
is talking to; it pings first and explains itself rather than timing out
anonymously.

The full set takes about 11 seconds. `gg2_wait` keeps a `gg2_speed` boost - it
never touches instances - so a scenario fast-forwards and waits for its own
finish condition in one call, with the tick count coming back exact instead of
bracketed by a poll interval. A **map change** does reset the boost (new room,
new `RateController`), which is why the factor is applied per scenario rather
than once.

Three things it does that a naive reachability BFS does not, each added after a
human playtest found a map the previous version had passed:

- **Gates are per-query, not baked into the graph.** `navGatePassable` answers by
  the caller's team *and* whether it is carrying intel. A gate-blind traversal
  asks "can a body get there" and passed a `ctf_conflict` where blue cannot reach
  the red intel at all.
- **The CTF return leg is a different query.** Carrying the intel closes your
  *own* team gate. `ctf_conflict` passes outbound for red and fails the return -
  the bot fetches the flag, cannot carry it home, and stands on it forever.
- **"A region whose only entrance is a gated node"** localises a missing edge to
  one chokepoint, which no percentage ever does.

The cache format is not the obvious one - `ds_grid_write` is column-major with
sixteen-byte cells and the double four bytes in, not packed doubles. `navgraph.js`
documents it; do not re-derive it by hand.

⚠️ **A full `build-agent.js` wipes `Source/build/`, and the nav cache with it.**
Re-warm it by cycling a dedicated server through the rotation:

```
gg2_wait  setup: 'global.currentMapArea = N; serverGotoMap("<name>");'
          expr:  'global.navKey == "<name>_a<N>" and global.navBuildState == 9'
```

Waiting on `navBuildState` alone races - it is still 9 from the previous map for
a frame or two before `navServerTick` notices the key changed. Multi-stage maps
(`cp_dirtbowl`) need one pass per `currentMapArea`.

⚠️ **Do not `botRemove` and `botAdd` in the same call as a map change.** It leaves
a dangling entry in `global.players`, and since `-1` is GM8's `self`, every later
`player.team` read errors against whatever object asked. The server then raises
the same error every frame forever and the instance has to be restarted.

⚠️ **The overlay image tells you *where* to look and lies about *why*.** A picture
of `koth_corinth` suggested an unreachable island needing an exotic jump; the
edge lists showed an ordinary ramp with every edge present except one, running
one-way downhill. An asymmetric edge list - outgoing edges to a neighbour with
none coming back - is one line of `--node` output and is invisible at any zoom.
Find the region with `navimage.js`, then diagnose with `--node` and `--gaps`.

## Why the fast rebuild works, and when it refuses

Game Maker 8 does not compile GML. "Create Executable" copies the runner stub,
appends the project as zlib blobs behind a swap-table cipher, and stores every
script and event as **source text**. Nothing in that stream holds an absolute
offset, so a piece of code can be replaced in place and everything after it
just shifts.

`build-fast.js` does exactly that: it takes the last executable the IDE built
(kept in `Source/build/template` with a manifest of the code inside it), splices
in every script and event that has changed, and re-encrypts. Anything it does
not recognise is copied through byte for byte.

It refuses, rather than guessing, when:

- a non-code file changed - sprite, room, object property, setting, included
  file - which it detects with a hash of the tree taken when the template built;
- a script or event was added or removed;
- the changed code is not the code the manifest recorded, meaning the template
  is stale;
- the same code string appears twice in one asset, so the splice is ambiguous;
- the GML does not lint, since bad code in a built exe is a modal dialog with no
  way back.

Every one of those says to run `build-agent.js`. It will not hand you a stale
executable.

`node tools/gamedata.js selftest "<exe>"` proves the unpack/repack round-trip is
byte-identical; run it if you suspect the splicer.

## Writing GML for this game

This is Game Maker 8 (2008), not modern GameMaker. Your training data is mostly
GameMaker Studio, and that dialect will not compile here.

`GML.md` at the repo root is a running list of GM8/GG2-engine gotchas that cost
real debugging time — things that lint clean but do the wrong thing at runtime
(`Obstacle.solid` only being true inside its own step, `ds_grid_read` being a
procedure, `var` shadowing a built-in silently killing startup, and more). Read
it before writing GML here; it covers ground `gg2_lint` cannot.

**Not available:** ternary `?:`, `try`/`catch`, structs, `var` block scoping,
arrays beyond 2D, `#region`, function literals, `static`, string escapes
(`"\n"` is a literal backslash-n; use `chr(10)`).

**Required by house style** (see the game's `Contributing.md`) — and the first
one is a compatibility rule, not taste:

- `and` / `or` / `not` rather than `&&` / `||` / `!`. This is style, not a hard
  rule: `Contributing.md` says the symbol forms break GmkSplitter, but the game's
  own code uses `&&` and compiles and round-trips fine. Match the surrounding code.
- Semicolons always. Parentheses around every conditional.
- Braces on their own line, four-space indent.
- `lowerCamelCase` variables, `UpperCamelCase` objects, `lowercaseCamel` scripts,
  `ALL_CAPS` constants.

**Reserved-word hazard:** GM8 accepts identifiers that later GameMaker versions
reserved. The project has already had to fix uses of `new`. Avoid `new`, `delete`,
`function`, `static`, `constructor` as identifiers.

## Editing object events

Script files under `Scripts/` are plain `.gml`. Object event code is different:
it lives inside XML, in a `<argument kind="STRING">` element, and it is
**XML-escaped**:

```xml
<argument kind="STRING">if (dist &lt; closestDist or closestDist == -1)</argument>
```

Writing a bare `<`, `>` or `&` into one of those files produces invalid XML and
GmkSplitter will refuse the whole tree.

Use **`gg2_event`** rather than editing the XML by hand: `list` shows an object's
events, `read` hands back real GML, and `write` escapes it, lints it and leaves
every other byte of the file exactly as it was. It resolves objects against the
bridge payload too, so `AgentSpare0` is editable like anything else — and an edit
to a payload object lands in `payload/`, where it survives `cleanup.js`.

The same escaping is why `grep` misses a large part of the game's logic. Use
**`gg2_find`**, which searches the scripts and the unescaped text of every event
together and reports `file:line`.

## Testing a change

`gg2_test` runs the game's own suites — `Scripts/Unit tests/**` — inside the
running game and reports how many assertions passed. The game's code is not
modified to accommodate it, and must not be.

Getting an answer out takes one trick, because the obvious route is unreliable.
**GM8's message box is only sometimes readable.** The launcher watches
`TMessageForm` alongside the error dialog and reads its child controls the same
way, so an assertion's text often does come through and lands in the launcher
log — but Delphi paints some captions with no window handle at all, and those
come back as `(dialog had no readable text)`. Good enough to report against,
never enough to depend on; if a failure is not named, look at `gg2_log` with
`source: "launcher"` before assuming the text was lost. The assertion
*counters* behind those messages are exact, though:
`test_unit_begin` zeroes them, every assertion moves them, and `test_unit_end`
is the only thing that resets them — after it has shown its message. So the tool
evaluates the suite's own source with its `test_unit_end()` call removed, then
reads `global.testAssertions` and `global.testAssertionsSucceeded` directly.
Same code, minus the one line whose only job is to report and forget.

A failed assertion still shows a box; the launcher dismisses it, so a failing
suite does not hang the game, and the counters say how many failed even when the
text of a particular box did not survive. That box's "OK" is painted rather than
a real button, unlike the startup dialogs, so the launcher force-closes it with
`WM_CLOSE` instead of clicking - logged distinctly as `M!` - which is also why
its text is worth trying to read as a screenshot when `WM_GETTEXT` comes back
empty (`gg2_log` names the saved file). A suite that stops mid-run — an error,
or a call that never comes back — fails by name, since a whole-run call cannot
otherwise say which suite it stopped in.

`node tools/selftest.js` is the other half: it exercises this repo's own Node
modules against a fake bridge and a scratch copy of the tree, in about three
seconds and with no Game Maker anywhere. Run it after changing anything under
`tools/`.

## Error handling has no safety net

GM8 has no exceptions. A GML error raises a **modal dialog** that freezes the
game and every pending MCP call. If a tool call times out, that is almost
certainly what happened — and the timeout says so itself: the launcher writes
every dialog it dismisses to disk while a call is in flight, so a call that
never gets a reply is explained from the same evidence as one that fails
normally, repeat counts and `file:line` included. A timeout that reports *no*
dialog is a different animal — a long loop, a stopped game, or a dead one — and
says that instead of guessing.

`gg2_eval` guards against this: it lints your code against the installed Game
Maker 8 first and refuses anything that would not compile, so the freeze mostly
cannot happen any more. What the linter cannot catch - a variable that does not
exist at runtime, say - raises the dialog anyway, and the launcher clears it;
the call then fails with the game's own error text rather than returning a
number that means nothing. The linter is authoritative rather than heuristic - it
reads GM8's own `fnames` table for built-in names and signatures, plus this
project's scripts and extension functions - and it reports nothing on the game's
existing ~20,000 lines.

Run `gg2_lint` yourself before writing GML into a source file; the linter costs
nothing and a build costs seconds or a minute. `gg2_rebuild` runs it too and
refuses to splice code that would not compile, but finding out at edit time
beats finding out at build time. If it flags a function that really does exist,
it came from a `.gex` - add it to `tools/gml-extensions.txt`.

Still prefer several small evals over one large one, so a failure tells you
exactly what broke.

## Things that will waste your time if you do not know them

- **An audio device is required.** GM8 loads the game's sound resources into
  DirectSound during engine startup, before any game code runs. With no audio
  endpoint it shows two modal errors and terminates. Over RDP that means audio
  redirection, or `tscon <id> /dest:console`. No code change can avoid this.
- **A full build does not need a desktop session any more**, but it does need
  the exact Game Maker build it was reverse-engineered against.
  `tools/gm8directbuild.js` makes its own desktop, which nothing ever displays,
  so no window appears and nothing steals focus; against a different
  `Game_Maker.exe` it refuses (rather than calling an address that means
  something else there) and `build-agent.js` drops to asking a person. Do not
  leave a thread on that hidden desktop: while switched to it, `win32.js` can
  see no window on the machine at all, and `CloseDesktop` refuses with
  `ERROR_BUSY`. `build-fast.js` needs none of this, which is the point of it.
- **`gg2_input aim` hangs** rather than erroring: `window_views_mouse_set` never
  returns when the game window is not the foreground window, which a game
  launched by this tooling normally is not. The obvious fix - the launcher
  forcing focus with `AttachThreadInput`/`SetForegroundWindow` - was tried and
  failed with access-denied/invalid-parameter errors (see the HANDOFF.md at
  commit `efedf8b` for the detail, before trying it again). Expect a ~10s
  timeout and no effect. `press`/`click` do not depend on focus and work fine.
- **A frozen game's own instances cannot be read by field while they stay
  frozen.** `gg2_step` (and `FREEZE` generally) works by calling
  `instance_deactivate_all(true)`, and GM8 makes a deactivated instance's data
  unreachable from anywhere else at all - not just a `with()`, even a plain
  dot-access read of a built-in like `.x` on an instance id held in a
  `global.` comes back "Unknown variable x" while frozen, for exactly the
  instance that reads fine a moment after `gg2_resume`. `gg2_screenshot`
  dodges this by reactivating before it draws and freezing again afterwards;
  a `gg2_evalx` that needs one instance's own fields can do the same thing by
  hand - `instance_activate_object(id)` before the read (verified: it does not
  itself run any code or advance anything, since nothing steps again until the
  game is actually resumed) - or just `gg2_resume` first if the whole game's
  state is wanted anyway.
- **A GML error does not kill the game any more, and it is not silent either.**
  `tools/launcher.js` presses Ignore on GM8's `TErrorForm` and logs the message;
  any call that runs while the game raises one comes back as an error carrying
  that text, instead of the `0` the bridge would otherwise report, and located as
  `file:line` by `tools/gmlerror.js`. `gg2_log` with `source: "launcher"` shows
  the same history.
- **A live server runs its own code every tick, and an out-of-band call that
  touches the same global corrupts it.** `gg2_eval`/`gg2_test` run inside the
  same process as whatever the game is doing on its own schedule — a Step event,
  a server's per-frame service, a chunked background build. Anything they share
  (a `global.` accumulator, a data structure id) can be destroyed out from under
  the server mid-use, and from then on the server's *own* per-tick code raises
  the same error every frame, forever, with nothing to do with the call that
  caused it. No amount of waiting fixes it: `gg2_session stop` then `start` is
  the only cure, and the tooling now says so when it sees an error repeating
  frame after frame. Before the first risky call of a session, check the
  relevant script's docstring for a warning like `navEdgesBegin`'s, and
  `gg2_wait` on whatever says that background job is idle. Freezing instead
  would trade this hazard for another — `FREEZE` drops network clients.
- **`E|` is an error, `M|` is a message.** The launcher marks the two kinds of
  dialog differently in its log, because the game's unit tests report through
  `show_message` and a failed assertion is a result, not a crash. Anything
  reading that log must keep them apart.
- **Logs and the register are per port.** `agent_bridge_<port>.log`,
  `agent_launcher_<port>.log` and `agent_instances.json`, all beside the exe, so
  two games in one directory never interleave.
- **Only one bridge client at a time.** The game accepts a single connection;
  a second one waits. A second one also waits *forever* while a deferred `STEP`
  or `WAIT` is outstanding, because the bridge reads nothing else until that
  reply goes out — so the only thing that reaches a game in that state is
  dropping the connection, and the client does exactly that (see below).
- **Every request carries an id, and a wedged bridge reconnects itself.** The
  frame body is `#<id> <request>` and the reply comes back `#<id> <reply>`, so a
  reply belongs to the call that asked for it by name rather than by position —
  a late reply to a call that already gave up is dropped as that call's, not
  handed to whoever asked next. The game treats the id as optional and echoes
  whatever it is given, so rebuilding a game does not break an older client;
  this client always sends one, and refuses (with instructions) to talk to a
  bridge that answers without one. On top of that, a call that finds *every*
  outstanding request abandoned reconnects first: the game notices the dropped
  client, cancels what it was deferring, and accepts the new connection, which
  turns a two-minute `WAIT` nobody is waiting for into a 70ms recovery. If the
  game was frozen at this client's request it is frozen again afterwards, and
  the call that triggered the recovery *fails* rather than answering — the world
  ran on for a few frames in between, and a value measured after that is worth
  less than being told it happened. Retry and the answer is honest.
  ⚠️ **The client's disconnect is abortive (RST) on purpose.** `tcp_eof` only
  goes true once the read buffer is *also* exhausted, so with a second request
  still sitting unread behind the deferred one, an ordinary FIN is invisible to
  the game for the whole frame budget. Measured live both ways.
- **The listener binds all interfaces**, because that is what Faucet's
  `tcp_listen` does. The accept path drops anything that is not loopback. Do not
  remove that check — the bridge runs arbitrary GML.
- **Never let the bridge reach a release build.** It is remote code execution by
  design. That is the entire reason it lives in this repo and is injected.

## Useful entry points in the game

| Where | What |
|---|---|
| `Scripts/Game/game_init.gml` | startup; reads `gg2.ini`, parses command-line flags |
| `Scripts/GameServer/` | server side: accepting players, per-frame service |
| `Scripts/Client/ClientBeginStep.gml` | client side: the main network receive loop |
| `Scripts/Input/input*.gml` | player actions as callable scripts — no key simulation needed |
| `Scripts/ggon/` | GGON, the game's JSON-equivalent encoder |
| `Scripts/Unit tests/` | assertion helpers (`test_assert_equals`, …) and the suites `gg2_test` runs |
| `Documentation/GGON.md` | the GGON format |

Command-line flags the game already understands: `-dedicated`, `-server <ip>`,
`-port <n>`, `-map <name>`, `-restart`, plus `-agent` and `-agentport <n>` added
by the bridge. `-server` and `-port` only count together — the parser ignores
either on its own.
