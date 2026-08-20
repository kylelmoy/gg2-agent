# GM8 GML and GG2 engine notes

Things that cost real debugging time in this codebase, written down so they cost it
once. `Contributing.md` covers house style; this covers the language dialect and the
engine's own behaviour.

Game Maker 8 is from 2008. Most GML material online — and most of what an LLM has
absorbed — is GameMaker Studio, and that dialect will not compile here.

---

## Compilation errors that look like anything but

GM8 compiles every script when the game loads, **before any object's Create event
runs**. A compilation error in one script therefore takes down the whole startup,
and it does it *before* anything that would normally report a problem exists yet.

What you observe is a game that launches, opens a window, paints, and answers
`Responding: True` — while doing nothing. If there is tooling that attaches at
startup, it never initialises and produces no log at all, so every signal points at
the tooling rather than at your GML.

The error itself is real and readable: GM8 raises a `TErrorForm` whose text lives in
a `TMemo`, which answers `WM_GETTEXT`. It names the script and the line. (A
`show_message` box is a `TMessageForm`, which the launcher reads too, but only on a
best-effort basis — see Miscellaneous below.)

Two ways to write code that triggers this, both of which lint clean:

### `var` must not shadow a built-in instance variable

```gml
var solid, x, y;   // COMPILATION ERROR — the whole script fails to load
```

`x`, `y` and `solid` are built-in instance variables. So are `xprevious`,
`yprevious`, `xstart`, `ystart`, `hspeed`, `vspeed`, `speed`, `direction`,
`friction`, `gravity`, `gravity_direction`, `persistent`, `depth`, `visible`, `id`,
`object_index`, `sprite_index`, `mask_index`, `image_index`, `image_speed`,
`image_xscale`, `image_yscale`, `image_angle`, `image_alpha`, `image_blend`,
`alarm`, and the `bbox_*` family.

This is a hard rule, not a style preference: across the ~20,000 lines in this repo
there is not one `var` declaration that shadows any of them. Name grid locals
`cx`/`cy`/`solidGrid` and the problem disappears.

### A variable must not share a name with a resource

```gml
// there is a script called navNodeGrid
global.navNodeGrid = -1;   // COMPILATION ERROR
```

Script, object, sprite, room and constant names are read-only constants at compile
time, so assigning to one is not an assignment at all. The failure mode is identical
to the above: the game boots and does nothing.

Worth a grep before adding a global whose name echoes a script you just wrote.

---

## `and`/`or` do not short-circuit

This is worse than the compilation errors above, because it compiles clean, lints
clean, and only fails at runtime — and only on the input that exercises the branch
you thought you were skipping.

```gml
// grid may legitimately be -1 ("caller has none of this")
while(cond1 and (grid < 0 or ds_grid_get(grid, cx, cy) == target))
```

Read as short-circuiting (every mainstream language a developer's instincts come
from), this looks safe: `grid < 0` being true should make GM8 never evaluate the
right side. **GM8 evaluates both sides of `and`/`or` unconditionally.** So
`ds_grid_get(grid, cx, cy)` runs even when `grid` is `-1` — calling a `ds_grid`
function on a handle that was never a real grid — and throws
`Data structure with index does not exist`, on *every* caller that legitimately
passes `-1` for that argument.

The failure is a runtime data-structure error, not a syntax error, so nothing at
edit time catches it, and see below for how unhelpful the runtime message itself is.

**Fix: never fold a "this might not exist" guard into the same boolean expression as
the access it's guarding.** Compute the dependent part into its own variable with an
explicit `if` first:

```gml
sameKind = true;
if(grid >= 0)
    sameKind = (ds_grid_get(grid, cx, cy) == target);
while(cond1 and sameKind)
```

This is exactly the pattern the rest of this codebase already uses for optional grid
arguments (`if(platformGrid >= 0) psupport += ds_grid_get(platformGrid, ...)`) — the
bug only happens when that pattern gets compressed into one `or`. Grep new code for
`< 0 or ds_grid_get` / `>= 0 and ds_grid_get` (and the mirror-image forms guarding a
valid handle before a `-1` fallback) before trusting it.

---

## Absent in GM8, present in GameMaker Studio

Reach for any of these and the linter will reject them — believe it, it is reading
GM8's own `fnames` table.

| Missing | Use instead |
|---|---|
| `ds_grid_sort` | sort yourself; a counting sort if the key is a small dense integer |
| `ds_exists`, `ds_type_grid` | track liveness with a `-1` sentinel and be disciplined about resetting it |
| `get_timer`, `delta_time`, `fps_real` | `current_time` (1–16 ms granularity) |
| ternary `?:`, `try`/`catch`, structs | `if`/`else`; there is no exception handling at all |
| `var` block scoping, `static`, `#region` | `var` is script-scoped |
| string escapes — `"\n"` is a literal backslash-n | `chr(10)`, `chr(13)`, `chr(9)` |

Consequences of no escapes worth knowing: a Windows path pastes into a string
literal exactly as-is, backslashes and all.

---

## `ds_*` behaviour that is easy to assume wrong

- **`ds_grid_read` is a procedure.** It returns nothing meaningful, so
  `if (!ds_grid_read(g, str))` reads *every* load as a failure. Validate by checking
  the dimensions it leaves behind instead — it resizes the target to match the data.
- **There is no garbage collection.** Every `ds_*_create` needs a matching destroy,
  including on paths that abandon work half-done. A per-map structure that is not
  freed leaks once per map change.
- **`ds_grid_set_grid_region` exists** and copies a region natively — much cheaper
  than a cell loop when moving rows between grids.
- **No `ds_set`.** Use a `ds_map` with dummy values, or a `ds_grid` as a bitmap.
- `ds_priority` has no handle per queued item, so there is no real decrease-key
  available for A\*. Push duplicates and skip already-closed entries when popping;
  lazy deletion is what the structure actually supports.

---

## Performance: the interpreter is the cost, not the engine

The single most useful thing to internalise is that **native calls are cheap and
interpreted loops are not**, and the ratio is large enough to invert intuitions.

Measured on this codebase, per mask cell:

| work | cost per cell |
|---|---|
| `collision_point` against a precise-mask instance | ~0.48 µs |
| a few `ds_grid_get`/`ds_grid_set` calls | ~1.8 µs |

So a pass of pure grid arithmetic cost roughly **four times** a pass of real
collision queries. Anywhere a whole row or column can be settled by one
`ds_grid_get_sum` or `ds_grid_set_region` instead of a loop, it is worth doing —
that alone was a 21% saving on one hot pass here.

Timing anything needs care: `current_time` is the only clock and has 1–16 ms
granularity on Windows, so never trust a single un-repeated call. Wrap the candidate
in `repeat(n)` and divide.

`fps` read from the game is a lagging average. A single very expensive frame shows up
as a depressed `fps` for a while afterwards, which is a useful smoke signal but tells
you nothing about *which* frame was expensive.

---

## Never block the server

`GameServerBeginStep` services every connected socket. Anything that blocks inside a
frame stops that servicing, and clients lag out or drop.

The threshold is lower than it looks. A one-off ~845 ms of work in a single tick —
which is nothing in a batch program — is a 25-frame stall that visibly breaks a live
server. Long jobs have to be split into per-tick slices with their state kept across
frames.

Two things that are easy to get wrong here:

- **Slice by the expensive stage, not by a uniform unit.** Stages with different
  per-item costs need different budgets, or one starves while another overruns.
- **Remember the stages you did not think of.** It is easy to chunk the obvious bulk
  pass and leave a "cheap finishing step" doing hundreds of milliseconds in one tick.

---

## Engine specifics that bite

### Collision solidity is toggled every frame

`Obstacle.solid` is set true by `charSetSolids()` and back to false by
`charUnsetSolids()`, and `Obstacle`'s Step event is *just* `charUnsetSolids()`. So
`place_free()` and `collision_point_solid()` only mean anything inside that bracket.
Called from anywhere else they report open space everywhere — which looks exactly
like working code that found an empty map.

Outside a character's movement step, use object-typed queries:

```gml
collision_point(px, py, CustomMapO, false, true)
collision_line(x1, y1, x2, y2, CustomMapO, false, true)
```

`collision_line_bulletblocking` is safe from anywhere — it is object-typed, not
`solid`-typed.

### The walkmask is not the map

`global.CustomMapCollisionSprite` is terrain only. These are ordinary instances and
are invisible to anything reading just the walkmask:

- `PlayerWall` / `PlayerWallHorizontal` — always blocking.
- `DropdownPlatform` / `MovingPlatform` — solid **from above only**; a character
  jumps up through one freely, so it must never be treated as terrain.
- `KillBox`, `PitFall`, `FragBox` — set `hp = 0` on contact.
- `MoveBoxUp/Down/Left/Right` — apply `pushPower`.
- `TeamGate`, `IntelGate`, `ControlPointSetupGate` — **per-frame conditional**
  solids. Your own team's gate is passable; an `IntelGate` blocks only a carrier.
  Anything static derived from them bakes in one team's view of the map.

To rasterise instances cheaply, walk the instances and use their `bbox_*` with
`ds_grid_set_region`, rather than testing every cell against every object.

### `global.currentMapMD5` is empty for every built-in map

`serverGotoMap.gml` sets it to `""` for internal maps, and `CustomMapGetMapMD5`
also returns `""` when the PNG is missing. So the MD5 is **not** a map identity — key
anything per-map on the map *name*, with the MD5 appended only when non-empty (that
still catches a custom map republished under an existing name).

### Geometry constants worth not re-deriving

- 1 walkmask pixel = 6×6 world pixels, always. `CollisionMapO` hard-codes
  `image_xscale = image_yscale = 6`.
- Character origin is at the chest; the feet are about 23 px below it.
- Jump: `baseJumpStrength` 8.3 against gravity 0.6/tick gives height above takeoff
  `p(t) = 8.3t − 0.3t²` — an apex of **57.4 px** at t ≈ 13.8, and ≈ 27.7 ticks of
  airtime returning to the same height. Both match the empirically measured figures.
- Free 6 px (exactly one mask cell) step-up *and* step-down, both directions.

---

## Miscellaneous

- **`show_debug_message` is a no-op in a built exe.** It only surfaces under the IDE
  debugger, and this project only ever ships built exes. Anything you need to read
  back has to go to a file.
- **A compile error inside `execute_string` raises no dialog at all** and appears
  only in the engine's own `game_errors.log`.
- **`show_message` freezes the game but writes nothing to `game_errors.log`** —
  that log is the *engine's* own error trail, and `show_message` is not an error,
  just a blocking modal. Checking only `gg2_log source: engine` after a timeout
  finds nothing (a caller may even see "no log file"), which reads exactly like a
  silent infinite loop. The text is usually captured, just on the *launcher's* side —
  `tools/launcher.js` watches for `TMessageForm` too and logs what it can read,
  marked `M|` (`source: launcher`, or `both`). Best effort, though: Delphi paints
  some captions with no window handle, and those are logged as `(dialog had no
  readable text)`. A call that never comes back reports these too, so a timeout no
  longer hides them. This includes the project's own `test_assert_equals`, which calls
  `show_message` immediately on a failed assertion rather than only at the end — so
  one wrong expected value in a test can freeze the whole game.
- **`var` locals are visible inside `with()` blocks** in the same script, which is
  what makes the `with(SomeObject) { ... other.field ... }` idiom work.
- **Line endings are mixed in this tree** and GM8 accepts both LF and CRLF. When
  editing an existing file programmatically, match what that file already uses or
  your anchors will not match.
- **Recursion works**, but prefer an explicit `ds_stack` for anything that could go
  deep.
- Scripts and `execute_string` take at most 16 arguments (`argument0`…`argument15`).
- Arrays are 2 dimensions maximum, and are dense — writing `a[500]` zero-fills
  everything below it.
