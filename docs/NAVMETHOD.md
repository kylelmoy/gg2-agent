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
| what is the terrain actually like here | `navaudit.js --mask x0,y0,x1,y1` | no |
| what edges does this node have | `navaudit.js --node <n>` | no |
| can the bot actually walk it | `gg2_scenario` | yes |
| which edge did it fail on | the scenario's `blacklistLog` | yes |
| can a *human* make this move | a server and your own hands | yes |

⚠️ **A graph only exists on disk once a server has loaded that map.** Warm the cache
before trusting a sweep to be complete - see *Warming the cache* at the bottom.

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

Every A/B needs all 21 graphs rebuilt, and that is one call per map, cycling a dedicated
server through the rotation:

```
gg2_wait  setup: 'global.currentMapArea = 1; serverGotoMap("<map>");'
          expr:  'global.navKey == "<map>_a1" and global.navBuildState == 9'
          frames: 3600
```

`cp_dirtbowl` needs `currentMapArea = 2` for its second stage. Waiting on `navBuildState`
alone races - it is still 9 from the previous map for a frame or two.

It is the most mechanical part of the loop and the thing most likely to tempt you into
skipping an A/B. **It wants to be a tool** (an MCP one - the bridge serves one client and
an editor session holds it). Until it is, budget four minutes.

A full `build-agent.js` wipes `Source/build`, cache included. Copy `build/botnav`
somewhere first if you have just spent four minutes warming it.

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
