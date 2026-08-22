# Handoff: the koth_valley shafts

Written 2026-08-21. One open bot-navigation problem on `koth_valley`, plus one report
from the same play session that has since been fixed and wants confirming by eye.

**The short version.** The two shafts either side of the control point are one-way
drops. A bot can fall in and cannot climb out, because exactly one rung of the climb is
missing from the nav graph: the step from the crate at the bottom of the shaft up to the
first wall ledge. It is a 54px rise against GG2's hard maximum jump apex of 57.4px, so
the arc generator is either right to refuse it or three pixels too conservative - and
the one measurement that settles which is a human standing on that crate and trying the
jump. That is what this document is for.

---

## 1. Start a server to look at it yourself

From `D:\Code\gg2-agent`:

```
node tools/session.js start --clients 1 --map koth_valley
```

That brings up a dedicated server plus one client window already connected to it.
Alt-tab into the client, pick a team, and you are in. Stop it later with
`node tools/session.js stop`.

Three things worth knowing first:

- **Check `[Bots] Enabled` in `Source/build/gg2.ini` if no bots turn up.** The
  behaviour-scenario harness deliberately switches the population manager off while it
  runs (otherwise it refills the roster mid-test and moves the role assignment under the
  test), and `game_init` writes that global back out to the ini on shutdown. `runAll`
  restores it now, but an older run may have left `Enabled=0` behind. A full game wants
  `Enabled=1`, `FillToPlayers=8`, `MinHumans=0`, `Difficulty=5`.
- **Do not run the CLI harness while an editor MCP session is attached to the same
  game.** AgentBridge serves one connection at a time; the second one hangs with no
  error at all. Use the `gg2_scenario` MCP tool from the session instead.
- `build-fast.js` **kills every running game**, so re-launch after any rebuild.

### Where to stand

Both shafts are symmetric about the control point at world x 2331.

| | left shaft | right shaft |
|---|---|---|
| underground floor | n263, x 2088-2220, floor y 828 | n265, x 2448-2580, floor y 828 |
| **crate top** | **n261, x 2226-2274, floor y 792** | **n262, x 2394-2442, floor y 792** |
| lower wall ledge | n242, x 2196-2208, floor y 738 | n243, x 2460-2472, floor y 738 |
| upper wall ledge | n216, x 2220-2232, floor y 684 | n217, mirror |
| surface | n177, x 2148-2190, floor y 630 | n179, mirror |

Drop into the left shaft, land on the crate, and try to jump up-and-left onto the ledge
at x 2196-2208. On the right shaft the ledge is up-and-right. A character's feet sit on
the quoted floor y and its origin (`char.y`) is 23px above that, so standing on the
crate puts you at roughly (2250, 769).

---

## 2. What is actually broken

The climb out of the shaft is four rungs. Three exist in the graph and one does not:

```
n263  underground floor  y 828
  |   jump         EXISTS
n261  crate top          y 792
  |   ????         MISSING        <-- the whole problem
n242  lower ledge        y 738
  |   jump         EXISTS
n216  upper ledge        y 684
  |   jump         EXISTS   (and n216 -> n178 lands straight on the point)
n177  surface            y 630
```

Read it straight off the cached graph, no game needed:

```
node tools/navaudit.js koth_valley --node 261

  n261 [row 125, world x 2226-2274, floor y 792]
    out: fall->n263, fall->n264, jump->n263, jump->n264
    in:  jump->n165, jump->n169, jump->n263, jump->n264
```

Every edge out of the crate goes back *down*. `n262` on the right shaft is identical in
shape. Meanwhile `n242`'s only in-edges are `fall->n177`, `jump->n177` and `jump->n216`
- all from above.

So the shaft is enterable from the surface (`n177 fall->n242`, `n216 fall->n263`,
`n242 fall->n263`) and has no way back up. A bot that drops in, or that spawns into the
underground, walks a ~45-node detour out through the rest of the map.

### The numbers on the missing rung

| quantity | value |
|---|---|
| rise, n261 -> n242 | 792 - 738 = **54px** |
| horizontal gap (n242 right edge 2208 to n261 left edge 2226) | **18px** |
| GG2 max jump apex, `v0^2 / 2g`, v0 8.3, g 0.6 | **57.4px** |
| rise as a fraction of maximum | **94%** |
| ticks to rise 54px | ~10.5 |
| horizontal speed that implies | ~1.7px/tick (the cap `NAV_JUMP_VX` is 4.53) |
| landing surface width | n242 is **2 anchor columns**, and `NAV_JUMP_LAND_LEAD` is 2 |

Kinematically the arc fits - comfortably inside the horizontal budget and just inside
the vertical one. It is being refused by one of the generator's safety checks rather
than by physics, and with 3.4px of headroom it does not take much conservatism to refuse
it.

### Why nothing else caught this

- **`navaudit` passes the map.** 236/270 nodes reachable, capture zone resolves, no gate
  problems. Reachability is a directed BFS *from spawn*, and every one of these nodes is
  reachable that way. The break is directional, and a directional break in the middle of
  a map reads as "the bot took the long way", not as a failure.
- **No diagnostic counter fires.** The reproduction below reports `stuck 0,
  blacklisted 0, offRoute 4`. The bot is not thrashing, not wedged, and not falling off
  its route - it is walking a legitimate route that happens to be enormous.

### Reproduce it in one call

```
gg2_scenario  { scenario: { name: "valley-underground-to-point",
                            map:  "koth_valley",
                            from: [2300, 810], to: [2331, 546], budget: 1200 } }
```

Currently: **never arrives, 299px short after 1200 ticks**, 23 replans, 0 stuck,
0 blacklisted, 4 off-route.

⚠️ `from: [2280, 828]` looks like the same place and comes back VOID - there is no node
under it. `botNodeSnap` searches *downward*, so give it a point above the surface you
mean, not on it.

---

## 3. The question that decides the fix

**Can a human player make the crate to ledge climb?** Everything forks on it.

**If yes** - the generator is too conservative and the edge should exist. Four suspects,
in the order I would check them:

1. **`navJumpTakeoff`'s column search.** It hunts for a takeoff column and gives up
   after `NAV_JUMP_TAKEOFF_TRIES` (4). The crate's left edge is flush against the shaft
   wall; if the columns it wants to leave from are inside that wall, every try is
   rejected and no arc is ever costed at all.
2. **`navJumpFlight` clearance.** The body box is `NAV_BOX_W` = 4 cells = 24px wide and
   the shaft is narrow. An arc that clips the wall by one cell near the apex is refused,
   even though a real character sliding up a wall face is perfectly happy.
3. **`NAV_JUMP_LAND_LEAD` = 2 against a 2-column landing.** The lead wants clear columns
   past the landing point and n242 does not have two to give.
4. **`navJumpCeiling`.** Cheap to rule out - look up from the crate in-game. If the
   shaft is open above, the height cap is not the reason.

**If no** - the graph is telling the truth and the bug is a different one: the shaft is
a *trap*, and the fix is to stop bots falling into it. `n177 fall->n242` and
`n242/n216 fall->n263` are the edges that drop a bot in there with a long walk as its
only way out. A fall edge into a pocket you can only leave the long way round is worth
costing far higher than a fall onto open ground, or refusing outright.

Either way, it is worth deciding whether the map's author meant the shafts as one-way
drops. If they did, bots declining to enter them is correct behaviour rather than a
workaround.

---

## 4. Rebuild notes for whoever picks this up

All four suspects live in the **graph build**, not in the follower, and that changes the
loop:

- **The cache will hide your change.** Edge costs, node extraction and jump generation
  are all baked into `Source/build/botnav/<map>_a1.txt`, and a game that finds a cache
  simply loads it - your new code never runs, and it looks exactly like the edit doing
  nothing. Bump `NAV_CACHE_VERSION` in `Constants.xml` to invalidate every cache on
  disk.
- **A constant change costs a full build.** `build-fast.js` refuses anything but code
  splices; `node build-agent.js` (~1 min, headless) is the one that takes a changed
  `Constants.xml`.
- **A graph already in memory survives deleting the cache file.** Switch to another map
  and back (`serverGotoMap`) to force the rebuild, or restart the game.
- Read the result back offline with `node tools/navaudit.js koth_valley --node 261` - no
  game required, and it is the fastest way to see whether your edge now exists.

---

## 5. The other koth_valley report: staircase hopping

From the same session: *"left side spawn room bots always jumping at the spawn gate, the
first and second downhill staircase - 512,606 / 764,624 / 995,648"*.

**This was real and is now fixed** (2026-08-21), but it is worth confirming by eye,
because the fix was measured on one route.

The cause was that jump edges were priced in ground covered rather than in time:
`max(1, dCells) + NAV_JUMP_PENALTY`. A walk step onto a wide run is charged to that
run's *midpoint*, so stepping from n203 (one column) onto n205 (786-990, midpoint 888)
cost 18 cells - while a single jump edge straight down the whole staircase cost 11. A*
correctly preferred the jump, for every bot leaving that spawn, every time. Jump edges
are now `max(1, dCells, tHit) + NAV_JUMP_PENALTY`: a 20-tick hop is charged as 20, and a
cell of walking is charged as roughly the tick it takes.

Measured on the spawn to point route, same bot, same route seed:

| | before | after |
|---|---|---|
| jump presses over the leg | 11 | 6 |
| jumps at the staircases (x 768, x 984) | yes | **none** |
| first jump on the route | x 768 | x 1218 (the valley climb, which needs one) |
| ticks to walk it | 769 | 547 |

⚠️ **Do not "fix" this further by making walk steps cheap** (near-edge distance instead
of midpoint). I tried exactly that: `navFindPath`'s heuristic is straight-line distance
in cells, and it is admissible only while walk costs are also in cells. Cheap walks make
it inadmissible, A* degenerates into greedy best-first, and it returns *more* jump-heavy
routes than before.

**The spawn gate at x 512 specifically was never reproduced**, before or after - in both
probe runs the first jump on the route was well past it. If you still see hopping right
at the gate, it is a separate thing and worth a trace: watch
`(bot.object.keyState & KEY_JUMP) > 0` alongside the bot's x, walk it past the gate, and
read the positions back out of the bridge log with `gg2_log`.

---

## 6. Related fix worth knowing about

While chasing the truefort version of this, `navNodeFromWorld` turned out to be
**flooring** the feet row: `floor((y + 23) / 6)`. A node's feet sit exactly on a mask row
boundary, but the engine rests a character a pixel *above* the surface it stands on - so
a stationary bot resolved to the row **above** the one it was standing in. Invisible on
a wide floor, because that node wins on horizontal distance anyway. On stepped terrain -
staircases, 45-degree ramps, anything the mask turns into a chain of one-column nodes -
the node one row up is also one column across, so it won the tie-break and the bot
believed it was standing a step behind where it actually was. The follower therefore ran
the *previous* edge, walked a cell too far before its route index advanced, and fired
its jumps from a cell 6px lower down the ramp, which is exactly the margin its arcs then
missed by.

It is `round()` now. If you are looking at anything on stepped terrain, this is recent
and directly relevant: it changed which node a bot believes it is standing on,
everywhere.
