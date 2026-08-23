# Finding broken navigation without watching a bot

How the 2026-08-22 nav passes were run, written so the next one can be run the same way.
It is a loop, and every step of it exists because the step before it produced an answer
that could not be trusted on its own.

The short version:

```
  sweep offline   ->  read the picture  ->  read the mask  ->  run it live  ->  fix  ->  A/B
  navsuspects         navsuspects           navaudit           gg2_scenario           navaudit
                      --route               --mask                                    + suite
```

Nothing before "run it live" needs a game running at all. That is the point: the first
three steps cost seconds, and they are what turn "the bots feel bad on this map" into a
node number and a claim you can falsify.

---

## 0. What each tool actually answers

Reach for them in this order. Skipping down the list is how you end up theorising about
geometry you have not looked at.

| question | tool | needs a game? |
|---|---|---|
| can a bot reach the objective at all | `navaudit.js` | no |
| which routes are far longer than they should be | `navsuspects.js` | no |
| *why* is this route long - where does it go | `navsuspects.js --route <n>` | no |
| **which promised arcs can the follower not fly** | **`navfollow.js`** | **no** |
| **why can it not fly this one** | **`navfollow.js --edge a,b`** | **no** |
| what is the terrain actually like here | `navaudit.js --mask x0,y0,x1,y1` | no |
| what edges does this node have | `navaudit.js --node <n>` | no |
| **where are bots failing on maps nobody aimed at** | **`navcensus.js`** | yes, any server |
| can the bot actually walk it | `gg2_scenario` | yes |
| which edge did it fail on | the scenario's `blacklistLog` | yes |
| can a *human* make this move | a server and your own hands | yes |

⚠️ **A graph only exists on disk once a server has loaded that map.** Warm the cache
before trusting a sweep to be complete - see *Warming the cache* at the bottom.

---

## 0b. If the complaint is "the bot cannot do that jump", start at navfollow

Steps 1-3 below all ask questions about the GRAPH, and by 2026-08-23 the graph was mostly
right. The failures left over are the other half: the graph describes an arc and the
follower cannot fly it. Nothing in the offline sweep sees that, because the edge is right
there in the graph with a perfectly ordinary cost.

    node tools/navfollow.js koth_gallery_a1              # every jump edge, worst first
    node tools/navfollow.js koth_gallery_a1 --edge 56,44 # tick by tick

**The disagreement it measures is one line of arithmetic.** `navJumpTakeoff` proves an arc
as a *constant* horizontal velocity `vx` applied from the takeoff column at tick 0, and
records it on the edge as `NAV_EDGE_BUCKET`. A GG2 character has no constant velocity -
`hspeed = (hspeed + runPower * controlFactor) / baseFriction` - so it accelerates
geometrically toward `basemaxspeed` and starts at zero. `botPathKeys`' in-air tracker
catches up out of the surplus between the arc's `vx` and the class's ceiling, and an arc
that asks for most of that ceiling has no surplus at all.

Two things follow, and both are worth knowing before reading any output:

- **The run-up is the source node.** Backing up is clamped into that node's own columns,
  so a ONE-COLUMN node offers none and every arc off it starts from a standstill. That is
  why the tool prints `best` (full run-up) and `worst` (standstill) - an edge that fails at
  `best` is a lie for everyone; one that only fails at `worst` is the intermittent kind,
  flown by a bot with room to run and missed by a bot that has just landed there. And even
  `best` is short: `BOT_RUNUP_CELLS` is 36px, which buys a Heavy 86% of its cap, not its cap.
- **The graph is class-blind and the classes are not the same bot.**
  `basemaxspeed = baseRunPower * baseControl / (baseFriction - 1)`, so Heavy tops out at
  4.53 px/tick and Scout at 7.93. `NAV_JUMP_VX` is 4.53 - it *is* Heavy's ceiling - and the
  generator uses it to budget wall contact, never to reject an arc. Model the slowest class
  that will be asked to fly it.

⚠️ **Reachability is the wrong metric here, and it was tried first.** Deleting all 105
unflyable edges from `koth_gallery` changes red's reachable count by exactly nothing: the
graph is redundant enough that every node keeps some other way in. What actually happens is
worse and invisible to a BFS - A* hands back the CHEAPEST route, which crosses the unflyable
arc; the bot flies it, lands elsewhere, blacklists it, and `BOT_BLACKLIST_TICKS` later gets
handed the identical route again. So the number `navfollow` prints is *how many nodes have a
cheapest route across an arc this class cannot fly*, which is the population that will thrash.

Measured 2026-08-23:

| map | class | unflyable jump edges | routes crossing one |
|---|---|---|---|
| ctf_truefort | heavy | 216 / 3769 | **39%** |
| ctf_truefort | scout | 2 / 3769 | 0% |
| koth_gallery | heavy | 105 / 1618 | 23% |
| koth_gallery | soldier | 62 / 1618 | 0% |
| koth_gallery | scout | 0 / 1618 | 0% |

The live check on the same leg (`koth_gallery`, 1102,906 -> 1228,738): Scout 101 ticks and
nothing blacklisted; Heavy and Soldier never arrive inside 1200, blacklisting exactly the
edges the model named.

## 0c. Let the server that is already running do the searching

`botscenario.js` walks the three legs somebody thought of. A twelve-bot dedicated server
walks the whole map thousands of times an hour and has been recording every failure the
entire time - `botBlacklistFires`, `botStuckFires`, `botOffRouteFires` and the endpoints in
`botBlacklistLog`. Nobody was reading them.

    node tools/navcensus.js --reset      # zero every bot's counters, note the frame
    ... let it play, or gg2_speed it ...
    node tools/navcensus.js --since <frame>

It aggregates by edge and by node and joins the result against `navfollow`'s offline
verdict, so a row that says `UNFLYABLE, lands 21px short` has been confirmed twice by two
methods that share no code. On a 5100-frame `koth_gallery` window it put six such edges at
the top, including the two a human had reported by hand the day before, with nobody aiming
at that part of the map.

**Read the `why` tag - it names which half of the code to look in:**

- `off` - a finished move ended off the route. **A lying edge.** Every edge `navfollow`
  flagged on truefort was reported this way and never as `stk`.
- `stk` - pressed a key and did not move. **A wedge, and it is about the node, not the
  edge**: the log shows one `from` with four or five different `to` values twelve ticks
  apart, which is a bot working through every exit it has because it never left the ground.
  Collapse those into one finding; `navcensus`' node view does it for you.
- `thr` - re-planned twice without covering ground.

⚠️ **Three ways the census lies, all seen in its first two runs:**

1. `botBlacklistLog` is capped at 240 characters, so a bot with 92 fires reports its first
   ~14. The counters are exact; the log is a biased early sample. Places, not rates.
2. Immobility that has nothing to do with navigation still reads as `stk`. Six of twelve
   bots fired at frame 3512 exactly, on unrelated nodes across the whole map - a round
   transition, where nothing can move. A cluster of unrelated nodes at one frame is the
   signature; `--since` past it.
3. **The log is not cleared on a map change**, and node numbers from the previous map
   resolve perfectly well against the current graph - to the wrong surfaces. Events naming a
   pair that is not an edge in the loaded graph are held out and counted, but `--reset` then
   `--since` is the way to be sure.

---

## 1. Sweep offline, and rank on travel

    node tools/navsuspects.js                 # every cached graph
    node tools/navsuspects.js koth_valley_a1  # one

For every node it reports the route to the objective and the straight-line distance in
cells, and ranks by the ratio between them. A high ratio is the signature of a missing
rung: the koth_valley shaft ranked 7.9 before its missing rung was found, and ctf_avanti's
block ranked 7.1.

**It ranks on `travel`, not on the graph's own cost, and the difference matters.** The
graph charges a same-row step a flat 1 cell, so crossing the run you land on is free - on
cp_egypt a route charged 112 cells walks 344. Ranking on the charge hid it completely.
Both numbers are printed and **the two disagreeing is itself a finding**: it means A* is
choosing that route for a reason the ground does not support.

Two cautions that are in the tool's own header and are worth repeating:

- **It ranks suspicion, not breakage.** A map with one legitimate bridge between its
  halves ranks high forever.
- **Adjacent nodes in one pocket all score alike.** Treat a run of near-identical rows as
  one candidate.

---

## 2. Read the route before forming any theory

    node tools/navsuspects.js koth_corinth_a1 --route 277

Hop by hop, with the edge kind, the world position and the cumulative cost. This is where
the shape of the problem appears, and it appears immediately:

- a route that **doubles back** to a point it started near is a missing rung
- a route that **descends to climb** is a pocket with one exit
- a route that is simply **long** is a long map

On ctf_avanti the 101-hop dump showed the route sliding down a ramp, crossing the whole
map, and returning to a point 260px above where it started. That is what named the node
the missing jump had to land on.

---

## 3. Read the mask, because the art lies and so does your memory

    node tools/navaudit.js ctf_avanti_a1 --mask 252,120,285,146

`#` is solid, `.` is open, `=` is a node's floor drawn across its anchor span, and the
nodes in view are listed underneath with their world coordinates. It reads the `{WALKMASK}`
block out of the map's own PNG, so it needs no game.

This is the step that gets skipped and should not be. Every "why is there no edge here"
ends up being a question about what the mask says, and the answer is usually visible at a
glance: on ctf_avanti a 10x8 solid block sitting flush against a one-column node; on
koth_corinth a 32-row void under the control point.

⚠️ **`=` overwrites the mask character underneath it.** When the exact solidity of a
node's own row matters, read the raw bits instead:

```js
const wm = require('./tools/walkmask.js').decode('koth_corinth');
wm.solid(x, y)   // mask cells: one map pixel, six world px
```

⚠️ **Anchor columns are not world columns.** A node's span is in *anchor* columns - the
LEFT edge of the body box - so `worldSpan()` and the printed world x already include the
half-box offset, and hand-converting is how a two-cell ledge gets missed.

---

## 4. Run it live, and let the counters say which kind of failure it is

```
gg2_scenario  { scenario: { name: "probe", map: "koth_corinth",
                            from: [1590, 991], to: [1758, 727], budget: 1600 } }
```

An inline scenario is throwaway - nothing is written to disk, so nudging a coordinate is
not a file edit. Promote it into `tools/bot-scenarios.js` only once it is worth keeping.

**The number that decides everything is ticks / travel**, not ticks / graph cost. Measured
over seventeen legs on every shipped map it sits between **1.25 and 2.2**:

- inside the band - the route is long, the bot is fine, the map is the map
- above it - the follower cannot execute what the graph promised

That band is the whole diagnostic. cp_egypt reads 3.9 against the graph's price and 1.26
against travel; the graph was wrong, not the bot.

`blacklisted` naming an edge is the strongest signal there is - it means the follower tried
that edge and could not fly it. The log is `reason:from>to@frame`:

```
blacklisted 2 (off:248>221@135015, off:244>221@135084)
```

`off` = finished the move off its route, `stk` = the stuck detector, `thr` = re-planned
twice in the same spot. Take the endpoints straight to `--node` and `--mask`.

⚠️ **Two ways a live run lies, both found the hard way:**

1. **A round starts in setup and the setup gates are SHUT.** ctf_avanti has 63 setup-gated
   edges, so the first run after a map change is routed the long way round, entirely
   correctly, and reads 897 ticks where every later run reads 266. It looks exactly like
   flake. `ensureMap` now waits the gates out; if you drive the game by hand, wait for
   `not areSetupGatesClosed()` yourself.
2. **The MCP server caches its modules.** Editing `bot-scenarios.js` or `botscenario.js`
   has no effect until the connection is restarted.

---

## 5. When the answer is "can a human do this?", go and find out

Three of the four bugs found this month came down to one question the tools cannot answer:
*is this move makeable in the actual game?* The graph is a model, and where the model is
more conservative than the engine, it refuses climbs that a player makes without thinking.

Set up a hands-on test with:

    node tools/session.js start --clients 1 --map koth_corinth

Bots off (`[Bots] Enabled=0` in `Source/build/gg2.ini`), one client window, alt-tab in.

**Aim the test.** Do not wander the map.

    node tools/navsuspects.js koth_corinth_a1 --shortcuts 277

lists where a climb would actually change the route: pairs of points that are physically
within jump reach of each other but far apart along it, with the rise, the horizontal gap,
how many rungs the climb needs and how many hops it would remove. Each row is a claim with
a number attached - "if this 108px climb is makeable, the graph is missing an edge worth 45
hops" - and a claim like that is settled in half a minute in-game, where "this map feels
wrong" is not.

⚠️ **And check the constants the geometry is measured against before blaming the geometry.**
The corinth test was aimed at a 108px climb and the answer turned out to be somewhere else
entirely: the body box was a cell taller than any character in the game, so an 84px stretch
of ordinary floor read as wall. The shortcut list is a way to look closely at one place -
it is not a guarantee the bug is a jump.

Then measure what you did: stand where the graph says you cannot, read your position back
with `gg2_state` or `gg2_evalx`, and compare it against what the generator assumed.

---

## 6. Fix, then A/B against rebuilt graphs - never against the suite alone

This is the rule that has caught the most damage, and it was learned by breaking
ctf_orange:

> **A permissive change upstream of a fixed-size filter is a destructive change downstream
> of it.** `NAV_JUMP_MAX_PER_SIDE` keeps a fixed number of jump edges per node per side, so
> a larger candidate pool means a DIFFERENT set kept, not a superset. Reporting more
> headroom lost ctf_orange 117 jump edges and with them the only ungated route to the
> enemy intel.

The scenario suite covers three maps. It cannot see that. So:

1. **Model it in Node first.** ~150 lines against the real mask and the real node list
   reproduced the shipped jump-edge count *exactly on all 21 maps*, which made it
   trustworthy enough to predict a change's delta before spending a build on it. Two
   proposed changes were killed this way in minutes rather than in an hour of builds.
   (GM8's `round` is half-to-even where JS's is half-up; that decides marginal arcs.)
2. **Snapshot before.** `for f in .../botnav/*.txt; do navaudit "$f" | head -12; done`
3. Change the generator, `gg2_rebuild`, delete every cache, re-warm all 21.
4. **Diff the snapshots.** Node counts, edge counts by type, reachability per team, and the
   objective checks. Nothing may fall.
5. Run the full scenario suite.

Bump `NAV_CACHE_VERSION` whenever the change alters what a cached graph *means*. A stale
cache does not fail - the game just loads it and your new code never runs, which looks
exactly like the edit doing nothing.

---

## Warming the cache

Every A/B needs all 21 graphs rebuilt. That is now one command:

```powershell
node ..\gg2-nav-gen\bin\gg2navgen.js build --all
```

About 0.4 seconds for all 24 graphs, every stage of every map, straight from the map
PNGs with no game running.

This section used to read: *one call per map, cycling a dedicated server through the
rotation, budget four minutes, and it wants to be a tool*. It became one. The generator
was ported out of the game into `gg2-nav-gen` and then removed from the game, so there is
no longer any way to build a graph from inside a running server, and no longer any reason
to want one.

What that changes for the A/B loop above: the "edit the GML, rebuild, re-warm, compare"
cycle is now "edit `gg2-nav-gen/src/`, `build --all`, compare" - no Game Maker build at
all unless the *follower* changed. `gg2navgen verify --all` does the comparison itself,
map by map, and names every graph that moved.

A full `build-agent.js` still wipes `Source/build`, cache included; just run `build --all`
again afterwards rather than copying it somewhere first.

---

## The failure classes this has found, as a checklist

Every one of them was a model that was more conservative, or more optimistic, than the
engine. When something looks refused-but-makeable, suspect these first.

| what was wrong | how it showed up |
|---|---|
| ceiling scanned straight up, not along the arc | koth_valley shaft: 54px rung refused, one-way drop |
| jump takeoff pinned to the end of a run | koth_valley: green only near spawn, 13/270 reachable |
| feet row floored instead of rounded | bot on a staircase believed it stood a step behind |
| walk cost in ground covered, not time | bots hopped down every staircase they met |
| fall edges did not record which end they leave from | wedged against a block, 231 edges affected on 21 maps |
| a fall flown with no in-air plan at all | overshot any landing narrower than the drift |
| lateral wall contact treated as fatal | avanti: 538 cells charged for a 76-cell straight line |
| ...and then wall-slide catch-up made free | invented two edges the follower could not fly |

| body box a cell taller than any character | 370 floor cells walled off; 84px of floor priced at 187 cells |
| arc costed as a constant velocity, flown by an accelerating character | koth_gallery pit: 4.10px/tick over 23.4 ticks is 96px of plan and 75px of Heavy |
| one graph handed to ten classes with a 75% speed spread | the same leg: Scout 101 ticks, Heavy and Soldier never arrive |
| ...and then six rows used for arcs too | a landing lead bought by headroom that is not there |

**The pattern is the whole checklist.** Every one of them is a model that disagreed with
the engine, and in every case the engine was reachable: the sprite mask is on disk, the
jump constants are in `Constants.xml`, and a human can be asked to try the move. When a
constant is justified by a comment rather than by a measurement, measure it. `NAV_BOX_H`
said "covers Heavy" for its whole life and covered Heavy with a whole cell to spare -
`Source/gg2/Sprites/Characters/<Class>/<Class>RedHS.xml` carries the real mask rectangle,
and Heavy is 19 x 36px.

**And watch for a constant that means two things.** The body box is used both for standing
and for flight, and it is not the same box: a standing character rests row-aligned and
occupies exactly six rows, one in the air is unaligned and touches seven. Six everywhere
made arcs optimistic and cost a scenario; six for standing and seven for airborne reads is
the honest split.
