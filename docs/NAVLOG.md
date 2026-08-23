# The nav generator: what changed, and what each change measured

A dated log of the bot navigation passes - the ones that changed the edge generator and
could therefore make every map better or worse at once. Kept because each entry carries a
**measurement**, and the next pass needs something to A/B against: "reachability went
13/270 to 150/270" and "the measured band" are the reason these entries are here rather
than in a commit message.

`docs/NAVMETHOD.md` is how to run a pass. This is what the passes found.

---

## navfollow.js / navcensus.js: searching for a broken FOLLOWER (2026-08-23)

Everything before this entry searches the graph. By 2026-08-23 the graph was mostly right
and the bots still could not walk it, so the two tools added here search the other side of
the gap: `tools/navfollow.js` models what `botPathKeys` can actually make a character do,
and `tools/navcensus.js` reads what the bots on a running server have already failed at.

### The disagreement navfollow measures

`navJumpTakeoff` proves an arc as a **constant** horizontal velocity, applied from the
takeoff column at tick 0, and stores it as `NAV_EDGE_BUCKET`. A GG2 character accelerates:

    hspeed = (hspeed + baseRunPower * baseControl) / baseFriction

which converges geometrically on `basemaxspeed = baseRunPower * 0.85 / 0.15` and starts at
zero. The in-flight tracker catches up out of the surplus between the arc's vx and the
class's ceiling, so an arc asking for most of that ceiling never catches up at all.

**`NAV_JUMP_VX` (4.53) is exactly Heavy's `basemaxspeed`** - `0.8 * 0.85 / 0.15` - and the
generator uses it only to budget wall contact while sweeping, never to reject an arc. So
arcs at 4.0-4.5 px/tick are generated freely and exactly one class could ever fly one, and
only from a full run-up it is rarely given.

Two more numbers that decide it, both from the follower rather than the generator:

- **The run-up is the source node.** `targetCol = takeoff - dir * BOT_RUNUP_CELLS` is
  clamped into `[x0, x1]`, so a one-column node offers none: every arc off it starts from
  a standstill.
- **`BOT_RUNUP_CELLS` is 36px, and 36px buys a Heavy 3.89 px/tick - 86% of its 4.53 cap.**
  Even the best case the model allows is short of what the arc assumed.

### Measured, 2026-08-23

| map | class | unflyable jump edges | nodes whose cheapest route crosses one |
|---|---|---|---|
| ctf_truefort | heavy | 216 / 3769 | 250/641 (**39%**) |
| ctf_truefort | scout | 2 / 3769 | 0 |
| koth_gallery | heavy | 105 / 1618 | 62/266 (23%) |
| koth_gallery | soldier | 62 / 1618 | 0 |
| koth_gallery | scout | 0 / 1618 | 0 |

Confirmed live on the leg a human reported by hand (`koth_gallery`, 1102,906 ->
1228,738 - the V-shaped pit below the gallery floor):

| class | result |
|---|---|
| scout | 101 ticks, 0 blacklisted, arrives |
| soldier | never arrives in 1200, blacklists 58>44 three times |
| heavy | never arrives in 1200, 177px short, blacklists 58>44, 56>44, 54>44 twice each |

Every edge named in those logs is one `navfollow` flags offline. The pit's six crossings
(n46/n48/n51/n54/n56/n58 -> n44) all ask 4.04-4.46 px/tick off one-column nodes, and they
are the only way out toward the right-hand side.

### Reachability is the wrong metric for this class of bug

Tried first, and it reports nothing: deleting all 105 unflyable edges from koth_gallery
leaves red's reachable count unchanged, because the graph is redundant enough that every
node keeps another way in. The bot still never gets there - A* hands back the CHEAPEST
route, which crosses the unflyable arc, the bot flies it, lands elsewhere, blacklists it,
and `BOT_BLACKLIST_TICKS` later is handed the identical route again. So what `navfollow`
reports is the fraction of nodes whose *cheapest* route crosses a lie. That is the same
lesson `navsuspects` was built on: a bug can leave the graph perfectly connected and still
make it unwalkable.

### What the census found that the model does not explain

A 5100-frame koth_gallery window, 12 bots, nobody aiming: six of the top edges were ones
`navfollow` calls unflyable, including the two from the hand report. Underneath them sat a
second family the model says nothing about - `stk` bursts at n11 and n16, four to six exits
each, which are the two spawn rooms, and every exit but one is gated to the team that owns
it. That is a wedge, not a lying edge, and the `why` tag is what separates them: **every
edge navfollow flagged was logged `off` and never `stk`.**

Numbers worth keeping for the next pass: an untouched 52k-frame ctf_truefort server had 12
bots carrying 749 blacklists, 5546 stuck fires and 8307 off-route fires between them, of
which 12 of the 123 distinct edges logged were independently flagged unflyable, and 14 of
the 49 `off` events landed on one.

### What fixing it measured (2026-08-23, same day)

The fix is in `botPathKeys`, not the generator, so no graph changed and
`NAV_CACHE_VERSION` stayed at 13. Two halves, and neither works alone:

- the takeoff gate stopped accepting a standstill and started asking `botJumpReach`
  whether *this* arc reaches from the speed the bot has;
- the run-up stopped being clamped into the source node and started following walk edges
  (`botRunupCol`).

Modelled in `navfollow` first, over all 23 cached graphs as Heavy:

| | unflyable jump edges | nodes whose cheapest route crosses one |
|---|---|---|
| before | 3310 of 62069 | 4546 / 15887 = **28.6%** |
| after | **253** | 264 / 15887 = **1.7%** |

koth_gallery went 105 -> **0** and its thrash figure 96% -> 0%; koth_corinth 146 -> 2 and
96% -> 1%.

**⚠️ The run-up distance is not what mattered.** Capping it at 6, 10, 14, 20, 30 or an
unbounded number of cells all give exactly 253, because the gate refuses to leave faster
than `needVx + BOT_JUMP_VTOL` and six cells already reaches that cap on almost every arc.
Being allowed to leave the node at all is the entire fix, and `BOT_RUNUP_CELLS` is
unchanged. Anyone tempted to tune that constant for a residual should read this line first.

**Why demanding the arc's full speed lost, and asking what it needs did not.** The earlier
experiment (647 -> 868 and 674 -> 997 ticks on the valley scenarios, no more arrivals) is
explained by a number worth keeping: **91.9% of all 62069 jump edges need no takeoff speed
at all** - the tracker flies them from rest with room to spare. Only 8.5% need any, and
`vNeeded/needVx` over those has a median of 0.35 and a maximum of 0.85. Demanding full
speed therefore forces a run-up on every jump in the game to fix one in twelve.

**The part no model would have caught.** The first live build refused *every* jump, silently
- nothing blacklisted, nothing off route, because the bot was doing exactly what it was
told. `jumpNeed` was being measured from `char.x` rather than from the takeoff column, and
the tracker clamps at `needVx * flightTicks`, so on an arc costed with no margin
(koth_gallery n86 -> n58 is exactly 12px of arc for exactly a 12px gap) a gate standing one
cell out asks for 22px that the arc can never deliver. The gate's question is about the arc
and the gap; where the bot is standing this tick is not part of it.

Live, `gallery-pit-climb`, now promoted into `tools/bot-scenarios.js`: heavy never arrived
-> **271 ticks**, soldier never arrived -> 135, scout 101 -> 125 (the run-ups cost a
little, as expected). Full suite 11/11, with `valley-spawn-to-point` 606 -> 549 and
`valley-shaft-floor-to-point` 184 -> 154.

**What is left.** The 253 residual, and endpoint tracking - which measured worth nothing on
its own (3310 -> 3310) because most failing edges had no run-up, so the bot was never ahead
of the ramp and both trackers behaved identically. That reasoning no longer holds now that
bots do arrive carrying speed, so it is reachable for the first time. The non-monotonic
band it explains is still there: on the gallery arc v0 3.50 clears, 3.75 and 4.00 fail,
4.25 clears.

---

## navsuspects.js: finding tricky routes without watching a bot (2026-08-22)

`tools/navsuspects.js` is new. It exists because the `koth_valley` shaft bug was found
by a human happening to watch a bot fall into a hole, and that does not scale to twenty
maps.

`navaudit` asks a boolean question - can a bot reach the objective - and that question
was green for the entire life of that bug, honestly: every node in the shaft *was*
reachable from spawn. What was wrong was the price. So `navsuspects` asks a metric one:
Dijkstra cost to the objective over the real edge costs, against straight-line distance
in cells (which is `navFindPath`'s own heuristic and therefore a guaranteed lower
bound). Rank by the ratio.

**It was validated against the bug it was designed for**, using the pre-fix graph:

| | pre-fix | post-fix |
|---|---|---|
| n261 / n262 (the two crates) | **ratio 7.9, top of the list** | below threshold, off the list |
| n264 | 7.9, cost 262 | 2.7, cost 90 |
| n263 / n265 | 5.3, cost 235 | 2.2, cost 98 |

That is the whole argument for the tool: it puts the answer at the top of the list
before anyone plays the map.

### What the first full sweep found

All 20 shipped maps were cached (`gg2_wait` + `serverGotoMap`, ~100-300 frames each) and
swept. Ranked by ratio, the shipped maps that look like `koth_valley` did:

| map | node | ratio | graph cost | shape |
|---|---|---|---|---|
| **ctf_avanti** | n251 | **7.1** | 538 | pocket, fall-in |
| koth_corinth | n277 | 6.5 | 362 | pocket, fall-in |
| arena_montane | n350 | 5.8 | 402 | fall-in |
| cp_dirtbowl (both areas) | n232 | 5.4 | 91 | pocket, fall-in |
| dkoth_sixties | n185 | 4.5 | 95 | fall-in |

All five were then run live. Four arrive and are just long - candidates for a recorded
baseline, not bugs. **`ctf_avanti` n251 is a real failure** and is now a `known` entry in
`bot-scenarios.js`: four runs at 1032-1211 ticks against a predicted 545, 1-2 edges
blacklisted *every* run, stuck in three of four. Blacklisting means the follower tried an
edge and could not fly it, so avanti has a follower/geometry problem on top of a long
route. n251 is one anchor column wide (x 1626-1626, floor y 840) with five outgoing jump
edges - the stepped-terrain shape `navNodeFromWorld`'s `round()` fix was about. Nobody
has instrumented which edge gets blacklisted; that is the next step there.

`cp_dirtbowl` is worth a second look for a different reason: predicted 90 cells, actual
368 ticks. A prediction miss that large is the "graph promised an arc the follower cannot
fly" signature rather than a missing edge, which is the other half of what this tool is
for.

### Using it

    node tools/navsuspects.js                    # every cached graph
    node tools/navsuspects.js koth_valley_a1     # one
    node tools/navsuspects.js <key> --scenarios  # emit gg2_scenario definitions

⚠️ It ranks **suspicion, not breakage**. A map with one legitimate bridge between its
halves ranks high forever and is working as designed. Adjacent nodes in one pocket all
score alike, so treat a run of near-identical rows as one candidate - the sweep above
collapsed clusters of four by hand. And a graph only exists on disk once a server has
loaded that map, so warm the cache before trusting a sweep to be complete.

### The regression this sweep caught, which is the real argument for it

The first version of the navJumpCeiling fix widened the ceiling scan into a corridor
unconditionally. Every scenario passed, koth_valley was fixed, and `navaudit` on the
three maps that happened to be cached said nothing was wrong. Sweeping all twenty found
that **ctf_orange had lost the only ungated route to the enemy intel**: 117 jump edges
fewer, and n379 sitting in a 106-node pocket behind a blueteam gate.

The mechanism is worth remembering because it is counter-intuitive. Reporting MORE
headroom can only ever let more arcs be costed - it cannot refuse one that used to
work. But `NAV_JUMP_MAX_PER_SIDE` keeps a fixed number of jump edges per node per side,
so a larger candidate pool means a DIFFERENT set kept, not a superset. A permissive
change upstream of a fixed-size filter is a destructive change downstream of it.

The fix was to gate the corridor on `needRise`: consult it only when the straight-up
scan does not already give the jump the climb it asked for. Every jump the strict scan
allowed keeps its exact capHeight, its arc, its cost and its place in the pruning order,
so only jumps that were being refused outright can appear. That version is strictly
better than pre-fix everywhere measured:

| ctf_orange | reachable | jump edges | intel |
|---|---|---|---|
| pre-fix | 335/670 | 3618 | OK |
| corridor, ungated | 387/670 | 3501 | **FAIL** |
| corridor, gated on needRise | **389/670** | **3710** | OK |

Two lessons for whoever touches the jump generator next. **A/B any generator change
against a rebuilt graph, not against the scenario suite** - the suite covers three maps
and this regression was on a fourth. And **`git checkout` of the two generator scripts
plus a 3s `gg2_rebuild` plus a cache delete is a complete A/B**, which makes it cheap
enough that there is no excuse for skipping it.

---

## What the suspects list was actually pointing at (2026-08-22, second pass)

`navsuspects` put `ctf_avanti` n251 at the top of the whole sweep and the previous pass
left it as a `known` failure with a note saying "nobody has instrumented which edge is
being blacklisted". Doing that turned out to answer a much bigger question than the one
it was asked, because n251 was **two** bugs stacked on one leg, and both of them are
general - every shipped map has instances of the first, and the second is a whole class
of climb the generator could not describe.

The leg: **538 graph cells -> 171, and 1032-1288 measured ticks -> 263-272.**

### 1. Falls now carry the end they leave from (the instrumentation found this in one run)

`botBlacklistEdge` gained a `why` tag and `botBlacklistLog` - a bounded, space-free
string of `reason:from>to@frame` on the Player, printed by the scenario runner next to
the blacklist count. One instrumented run said `off:94>138@1396,stk:92>104@1489`, and
both of those are fall edges.

`navFallEdges` drops from the cell just past one end of a run and knows which end.
`botPathKeys` did not: it re-derived the end with "is the column just past the run
inside the landing node", which is true of **both** ends wherever the landing surface
reaches under the whole run - a platform standing on a wider ledge - and the test then
always picked the right-hand one. n92 has a solid block against its right end, so the
bot walked into the block and stood there pressing until the stuck detector took the
edge away.

Falls now store their takeoff column in `NAV_EDGE_TAKEOFF`, exactly the way jumps
already did (the F41 lesson in `navEdgeAdd`'s header), and the follower reads it, with
the old guess kept as a fallback for a pre-v12 cache. **Measured over all 21 cached
graphs: 231 of 10,307 fall edges (2.2%) had the takeoff at the end the old rule did not
pick - and every single shipped map has some**, from 3 on gen_destroy to 29 on
cp_dirtbowl. Rebuilding every graph after the change produced byte-identical node
counts, edge counts and per-team reachability, because it only fills in a field.

### 2. A jump may now slide up a wall, which is what a player does

n251 stands one anchor column from a 54px block whose top is n229, the way out of the
pocket. GG2's apex is 57.4px, so the climb needs 94% of it - which means the character
cannot have moved sideways *at all* before its feet are over the top. `navJumpTakeoff`
walked the arc at constant vx and treated the first sample that overlapped the block as
fatal, so every lead was refused and n251 had no upward edge.

That is not what the engine does. GG2 does not move a character into terrain, it stops
it against it and keeps the vertical motion, and a bot pressing toward its landing does
exactly that - the follower's steering is bang-bang toward `jumpWantX`, not a constant
velocity. So the clearance walk now tracks the column the character is *actually* in,
stepping it one column at a time toward where the arc wants to be and stopping against
terrain, and requires it to have reached the landing column by the end - otherwise the
wall held it back and the edge would be a fiction.

⚠️ **This is a permissive change upstream of `NAV_JUMP_MAX_PER_SIDE`**, which is the
exact shape that cost ctf_orange its intel route last time. It was A/B'd properly:

| | before | after |
|---|---|---|
| jump edges (21 graphs) | 55,288 | 61,190 (+11%) |
| maps whose reachability fell | - | **none** |
| maps whose reachability rose | - | 5 (dirtbowl a1 208->221, avanti 225->230, classicwell 613->617, mantic blue 244->247) |
| ctf_orange intel, both teams | OK, 389/670 | OK, 389/670 |
| objective failures | 2 (dkoth_atalia, gen_destroy) | the same 2, unchanged |
| scenario suite | 7/7 + 2 shaft legs | 7/7 + 2 shaft legs |

The suspects list moved down across the board afterwards: avanti's worst went 7.1 ->
3.7 (n251 off the list entirely), dirtbowl 5.4 -> 5.3, and dkoth_atalia and gen_destroy
now have nothing above threshold at all. **The new top of the whole sweep is
`koth_corinth` n277 at 6.2** (348 cells against a floor of 56, pocket, one fall in),
with `arena_montane` n350 at 5.8 behind it. That is where the next pass should start.

`NAV_CACHE_VERSION` is **12**. Both changes alter what a cached graph means, so a v11
cache silently keeps the old behaviour - it does not fail, which is worse.

### The tools this needed, which are the durable part

- ✅ **`navgraph.walkmask(map)` and `tools/walkmask.js` were the same discovery made
  twice, in parallel sessions on 2026-08-22. Collapsed the same day**, the way this
  entry asked for: `tools/walkmask.js` owns the one decoder and the zTXt reader under
  it, and `navgraph.js` re-exports both (`nav.levelData` for the entity list,
  `nav.walkmask` for the mask) so every existing caller kept working. `decode()` returns
  `{ width, height, bits, solid(x, y) }` - the Buffer for whole-image work, the
  bounds-checked accessor for cell queries - which is both original shapes in one
  object; `navaudit --mask` moved from `wm.w`/`wm.h` to `wm.width`/`wm.height` and is
  otherwise untouched. A selftest case now asserts the two names return the same bits,
  so they cannot quietly fork again.
- **`navgraph.walkmask(map)` reads the terrain off disk.** The map PNG's `zTXt` chunk
  carries the map builder's own `{WALKMASK}` block - one bit per mask cell, six to a
  character - so "what does the mask actually say here" needs no game, no map load and
  no bridge. Verified against the running game: a 35x30 window came back identical,
  cell for cell, to `collision_point` against the live `CollisionDummy`.
- **`navaudit --mask x0,y0,x1,y1`** prints that as text with node floors drawn on it as
  `=`. This is what turned "why is there no edge here" into a picture in one call, and
  the answer was visible in it immediately: a 10x8 block sitting flush against a
  one-column node. Reach for it earlier than feels necessary.
- **`navsuspects --route <n>`** prints the cheapest route hop by hop with cumulative
  cost. The ranked list says a route is seven times its geometry; only the hops say
  whether that is a missing rung, a legitimate one-way drop, or a long map. Reading
  avanti's 101 hops showed it descending a ramp, crossing the map and coming back to a
  point 260px above where it started, which is what named n229.
- **The Node model of the clearance walk is worth rebuilding if you touch the
  generator again.** ~150 lines against the real mask and the real node list reproduced
  the shipped jump-edge count **exactly on all 21 maps** (1679 on avanti, 3710 on
  orange, ...), which is what made it trustworthy enough to predict the delta before
  spending a build on it. It is a scratch file, not committed - but the recipe is:
  freeGrid from `walkmask` dilated by NAV_BOX_W/H, nodeGrid from the cached node list,
  and GM8's `round` is half-to-even where JS's is half-up, which decides marginal arcs.

### A scenario run during setup measures a different map (found chasing a "flake")

The avanti leg read 897 ticks once and 266-289 on the three runs after it, with every
counter clean in all four. That is not variance. **A round starts in setup, the setup
gates are shut for it, and ctf_avanti has 63 setup-gated edges** - so the first run after
a map change was routed the long way round, entirely correctly, against a graph where
the short way did not exist. Verified directly: `areSetupGatesClosed()` returns 1
immediately after `serverGotoMap("ctf_avanti")` and 0 about 160 frames later, and the
first run after waiting for it came in at 268 ticks like all the others.

`ensureMap` now waits for the gates to open before anything is placed (`pastSetup`).
Two consequences worth knowing:

- **Any measurement taken as the first run after a map change, before this, is suspect** -
  including `cp_dirtbowl`'s "predicted 90 cells, actual 368 ticks" from the first sweep,
  which is a cp map with its own setup gates. Re-measure it before treating it as the
  "graph promised an arc the follower cannot fly" case it was filed as.
- The harness now cannot measure setup-phase behaviour at all. That wants an explicit
  scenario field rather than being had by accident of ordering.

### Still worth doing here

- **`gg2_scenario`'s runner is cached in the MCP server process.** Editing
  `tools/bot-scenarios.js` or `tools/botscenario.js` has no effect until the MCP
  connection is restarted - a scenario added in a previous session was simply not in
  the list, and a new field added to the report did not appear. Either re-`require` on
  each call or stat the files and drop the cache; until then, an inline `scenario:`
  plus a `gg2_evalx` for anything new is the way round it.
- **A cache-warming tool.** Every A/B in this session cost 21 hand-written `gg2_wait`
  calls cycling a dedicated server through the rotation. It is the single most
  mechanical part of the loop and it is what makes "A/B against a rebuilt graph"
  expensive enough to be tempted to skip. It cannot be a CLI (the bridge serves one
  client and the MCP session holds it), so it wants to be an MCP tool next to
  `gg2_scenario`.

---

## Sweeping the whole worklist, and what the sweep itself got wrong (2026-08-22, third pass)

Every shipped map's top suspect has now been run live. **None of them is a bot bug.**
The two chased in detail are honest map geometry, and the mask view says so in one call:
`koth_corinth` n277 sits under a 264px void with the control point on a platform above
it, and `dkoth_sixties` n185 sits under an eight-row slab with the point on top. A high
ratio on those is permanent and correct.

What the pass did find is three things about the tooling and one regression of its own.

### 1. The wall-slide let a held-back jump catch up for free, and that invented edges

The blacklist log earned its keep on the first run that used it: `cp_dirtbowl`'s suspect
leg came back `blacklisted 2 (off:248>221, off:244>221)`, and both of those turned out to
be edges the wall-slide had just created. A character in the air moves at most
NAV_JUMP_VX, so a tick spent against a wall is a tick of travel that is gone; the first
version let `cx` walk toward the plan a column per sample regardless, so an arc already
flying at 96% of the speed cap could be stopped by a tread and then magically make it up.
avanti's climb needs the slide and has slack to spare (0.35px/tick against a 4.53 cap);
dirtbowl's near-flat crossing has none and must still be refused.

Fixed with a per-sample budget - move toward the plan by at most `NAV_JUMP_VX * dt`,
never past the plan. Both dirtbowl edges are gone, avanti's climb is kept, and the change
is strictly more conservative than the unbounded version everywhere: **+3,200 jump edges
over the whole set instead of +5,900, and 0-49 displaced per map instead of 0-84.**
Re-A/B'd over all 21 rebuilt graphs: no reachability fell, classicwell +4, mantic +3,
avanti +1, ctf_orange still 389/670 with its intel OK, the same two pre-existing
objective failures, and the scenario suite 10/10.

**`NAV_CACHE_VERSION` 12 means fall-takeoff plus the speed-capped slide.** There was
briefly a v12 built with the unbounded one; it existed only in this working tree.

### 2. A fall is now flown as the drop the generator actually modelled

The same leg then blacklisted `off:186>193` - a *fall*, not a jump, and a 12px step down
onto a two-column ledge. `navFallEdges` sweeps straight down from the takeoff column and
credits whatever it hits, but the follower had no in-air plan for a fall at all: it walked
off at whatever speed it had, GG2 bleeds hspeed slowly, and it sailed two columns past
anything narrower than the drift. Falls were the one edge kind flown blind.

`botPathKeys` now tracks the fall the same way it tracks a jump - hold `navColWorldX(takeoffCol)`
while airborne, and set `botFlyingEdge` so evasion cannot add a hop mid-drop. This is
only writable because falls now carry that column (previous pass); `c1 + BOT_ENTRY_LEAD`
is a walk-off hint deliberately past the edge, and holding *that* would aim the drop a
cell wide of the sweep that proved it.

| | before | after |
|---|---|---|
| cp_dirtbowl suspect leg | 292 ticks, 2 blacklists | **130-192 ticks, 0** |
| ctf_truefort spawn->intel, offRoute | 12-15 | **4** |
| suite | 10/10 | 10/10 |

### 3. navsuspects was ranking on a number the bot does not pay

`cp_egypt` n248 measured 432 ticks against a graph price of 112 - a 3.9 ratio where every
other leg sits at 1.4-2.7, which reads exactly like a follower problem. It is not. The
route is charged 112 and **walks 344**: `navWalkEdges` charges a same-row touch a flat 1
cell, so crossing the run you step onto is free, and cp_egypt's route crosses a 378px
platform for one cell.

⚠️ **Do not fix that in the generator.** Tested offline against every node of every
cached map: charging same-row walks by midpoint distance changes the real travel of the
routes actually chosen by **0.0%** - 61 nodes better on ctf_conflict, a handful worse
elsewhere, nothing else moves. The cheap crossing is available to every candidate route
equally, so it under-prices without misrouting. (A per-step cost floor for staircases was
tried the same way and made the prediction *worse* at every value from 1.5 to 5.)

So the fix belonged in the tool. `navsuspects` still runs Dijkstra on the graph's own
costs - that is the route A* will pick - but now measures and ranks on the **travel** of
that route, printing both. The two disagreeing is itself a finding. The worklist reorders
accordingly and promotes routes the graph was hiding: cp_egypt 2.0 -> 6.4, ctf_orange's
top goes from n524 (3.3) to n510 (5.8), ctf_2dfort 3.0 -> 4.3.

### The measured band, which is the thing to compare against next time

Every top suspect, run live after all of the above. **ticks / travel** is the honest
efficiency number, and it lands in a narrow band - which is what says the follower is
healthy and these routes are simply long:

| leg | travel | ticks | ticks/travel |
|---|---|---|---|
| ctf_eiger n422 | 107 | 134 | 1.25 |
| cp_egypt n248 | 344 | 432 | 1.26 |
| cp_dirtbowl n232 | 91 | 130 | 1.43 |
| ctf_orange n510 | 229 | 342 | 1.49 |
| ctf_truefort spawn->intel | 1205 | 1810 | 1.50 |
| ctf_avanti n209 | 106 | 171 | 1.61 |
| ctf_avanti n251 | 208 | 352 | 1.69 |
| koth_harvest n459 | 152 | 266 | 1.75 |
| dkoth_sixties n185 | 95 | 169 | 1.78 |
| koth_corinth n277 | 501 | 918 | 1.83 |
| arena_montane n350 | 579 | 774 | 1.34 |
| koth_valley floor->point | 118 | 261 | 2.21 |

**Anything much above ~2.2 is worth opening.** Anything inside it is a long route, not a
broken one - and the five in this table with a ratio over 4 on the ranked list
(corinth 9.0, montane 8.4, egypt 6.4, sixties 6.3, orange 5.8) are all confirmed honest,
so a future sweep should not spend the map load on them again.

---

## The body box was a cell too tall (2026-08-22, fourth pass)

Reported from play as "the bots go a stupid way round on koth_corinth and arena_montane",
and it was one constant.

`NAV_BOX_H` was 7 cells = **42px**, on the stated grounds that it "covers Heavy". It
over-covered Heavy by a whole cell. The class sprites carry MANUAL rectangle masks and the
tallest of them is **Heavy at 19 x 36px** (Scout 13x34, Soldier 13x32, Pyro 15x30). Six
rows is 36px - exactly Heavy - so the graph modelled a character taller than any that
exists, and **every passage between 36 and 41px high read as solid rock**: 370 floor cells
across the 21 shipped maps.

What that cost on the two maps that were reported:

| | two floor nodes at the same height | apart in the world | apart in the graph |
|---|---|---|---|
| koth_corinth | n267 / n268 | **84px of continuous floor** | **187 cells** |
| arena_montane | n350 / n351 | **36px** | **639 cells** |

Both are one node now. `NAV_BOX_W` stays at 4: 19px unaligned really does span four 6px
cells.

### The half of it that took a second pass

Six rows is right for STANDING and wrong for FLIGHT, and the difference is exactly one
row. GG2 rests a character with its feet on a surface, so a standing body is row-aligned
and occupies precisely six rows; a body in the air is at an arbitrary y and touches seven.
Sizing the whole clearance grid to six made every arc test optimistic by a row, and
`valley-shaft-crate-to-point` caught it immediately - **707 ticks against its 300 bound,
offRoute 11**, where the trace showed the bot landing on the two-column ledge and sliding
straight back off it. The extra headroom had let `navJumpCeiling` report a taller rise,
which bought a bigger landing lead, which is a faster arc, which overshoots a 12px ledge.

So the airborne reads - `navJumpCeiling`'s two scans and `navJumpTakeoff`'s sampler and
wall-slide - now test row `r` **and** row `r - 1`, which is the seven-row union, with above
the mask counting as sky. Standing keeps six. The shaft went straight back to 113 ticks and
0 offRoute.

⚠️ **That second pass gives back gains the first pass appeared to make, and it is right to.**
With the optimistic six-row arcs, ctf_orange read 601/672 reachable and dkoth_atalia's
objective passed; with honest seven-row arcs they are back to 389/672 and failing. Those
were arcs no body can fly - the shaft is the proof - so they were fictions, and losing them
is the correct outcome, not a regression. Neither map is worse than it was before this
pass. Do not "recover" them by loosening the airborne test.

### Net, against the 42px box

| | before | after |
|---|---|---|
| koth_corinth worst ratio | 9.0 (travel 501) | **5.0 (travel 378)** |
| arena_montane worst ratio | 8.4 (travel 579) | **5.7 (travel 171)** |
| ctf_avanti reachable | 226/322 | 232/324 |
| ctf_conflict reachable | 554/750 | 568/762 |
| maps whose reachability fell | - | **none** |
| objective checks | 19/21 | 19/21, same two |
| scenario suite | 10/10 | 10/10 |

`NAV_CACHE_VERSION` is **13**.

### The lesson worth keeping

Every generator constant is a claim about the engine, and this one had never been checked
against it. The comment said "covers Heavy" and it did - with a cell to spare, which is a
50% error on the thing that decides what a bot can walk through. **Measure the sprite.**
`Source/gg2/Sprites/Characters/<Class>/<Class>RedHS.xml` carries the mask rectangle; the
tallest and widest across all nine classes is what the box should be, and nothing more.
