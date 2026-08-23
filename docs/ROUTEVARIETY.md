# Route variety: what was there, why it was removed, and what a replacement must do

Written 2026-08-22, after the per-bot cost jitter (M7 1.4) was deleted from
`navFindPath.gml`. This is the handoff for putting route variety back. Read it before
writing the replacement, because the constraint the old one broke is not obvious and the
failure it produced looked nothing like a pathfinding bug.

---

## What route variety was for

A team of bots given the same objective plans the same route to it, walks it in single
file, and dies to the same rocket. Route variety is the cheap fix for that: make each bot
value edges slightly differently, and they fan out across whatever alternatives the map
offers without anyone having to model lanes, roles or map control.

The version that shipped was a **per-bot cost jitter**. `navFindPath` took a sixth
argument, `jitterSeed`, and multiplied every edge cost it read by a deterministic factor:

```gml
hash = ((i + 1) * 2654435761 + jitterSeed * 40503) mod 4294967296;
hash = (hash div 65536) mod 256;
cost = cost * (1 + NAV_PATH_JITTER * hash / 255);      // NAV_PATH_JITTER was 0.35
```

Keyed on `(edge row, seed)` rather than on an RNG, so the same bot asking the same
question twice got the same answer - a jitter that moved between calls would re-route a
bot mid-walk every `BOT_REPLAN_TICKS`. `botRouteSeed` was set to the bot's `Player`
instance id in `botRoleAssign`, and 0 meant "no jitter", which is what every non-bot
caller and the whole unit suite passed.

That much was all sound. The defect is one level down.

## Why it was removed

`navFindPath` is A* with a closed set that it never re-opens:

```gml
if(ds_grid_get(closed, 0, nb) == 1)
    continue;                       // <- the line that made this unsound
```

Skipping an already-closed neighbour is only correct when the heuristic is **consistent**
(monotone): `h(n) <= c(n, n') + h(n')` for every edge. The header argued for the weaker
property instead, and the argument is worth quoting because it is the exact shape of the
mistake:

> The jitter only ever *raises* a cost, never lowers one, and that is deliberate rather
> than incidental: the heuristic is a straight-line lower bound on the unjittered cost, so
> costs that only grow keep it admissible and A* keeps returning an optimal path.

The first clause is true: raising costs preserves **admissibility**. The second does not
follow. Admissibility alone guarantees optimality only for an A* that is willing to re-open
closed nodes. Scaling each edge by its own factor breaks the triangle inequality above, so
nodes get closed holding a non-optimal `g` and are never corrected.

The header even predicted the symptom without connecting it: *"a broken heuristic does not
look like a bug, it looks like a bot occasionally taking a stupid route."*

### What it actually cost, measured

On `ctf_truefort`, leaving blue spawn westward - the route every blue bot takes every life:

| seed | route returned | cost |
|---|---|---|
| 0 (no jitter) | `178 > 177` (direct jump) | 33.67 |
| 1 through 10 | `178 > 196 > 195 > 177` | 54.67 |

Jitter is capped at +35%, so `33.67 * 1.35 = 45.4` is still well under the 54.67 the
three-hop route costs at its cheapest. The search relaxed the good edge - seed 0 proves it
is visible to the search - and returned the bad route anyway.

The consequence was not cosmetic. `n196` and `n195` are **single-column nodes**, six pixels
wide, and they sit over `n310`, a pit whose only exit is `walk->n311 [blueteam]`.
`navGatePassable` closes a team gate to a carrier (`team == TEAM_BLUE and !hasIntel`), so
`n310` can be left **only by a blue bot not carrying intel**: a red bot that falls in, or a
blue bot carrying the flag, is stuck there until something kills it. The pit is ~90px deep
against a ~57px peak jump, so there is no jumping out - it is real map geometry, not a
missing edge. Reproduced live: a bot given `n178 -> n177` ended in `n310` with 1484 stuck
fires and 724 off-route fires.

And because `botRouteSeed = player` is an instance id, it is **never 0**. Every bot in
every real game took the bad route. Only the unit suite, which passes 0, ever saw the good
one - which is exactly why no test caught this.

## What was changed

1. **The jitter is gone entirely.** `navFindPath` now takes five arguments, not six.
   `NAV_PATH_JITTER` and `botRouteSeed` are deleted, along with the `botRouteSeed`
   assertion in `test_botskill.gml` and the jitter tests in `test_navgraph.gml`.
2. **The search re-opens closed nodes.** The `closed` test on a neighbour is gone, and a
   node whose `g` improves has `closed` cleared so the re-push is honoured. With costs
   unjittered the heuristic is consistent again and this never fires - it is there so the
   next thing to perturb a cost cannot silently reintroduce the bug.

With honest edge costs the heuristic is consistent by construction: walk cost is measured
in mask cells and the heuristic is straight-line distance in mask cells, so for a walk edge
`cost == Δh` exactly, and every other edge type is charged at least the distance it covers.

## What the change measured

Verified live on a dedicated server, build of 2026-08-22:

- `navFindPath(178, 177, TEAM_BLUE, 0, -1)` now returns `178 > 177`, the direct jump.
- The full blue-spawn-to-red-intel leg dropped from 68 nodes to 60. Both were computed with
  no jitter, so the re-open is finding improvements the closed-set search was missing even
  on honest costs - worth knowing, and a reason not to assume the heuristic was consistent
  before.
- Behaviour suite **10/10**, matching the baseline in commit 8e30e213.
- New saved scenario `truefort-blue-spawn-exit-west`: **58 ticks, 0 stuck, 0 blacklisted,
  0 off-route**. The same leg before the fix never arrived - 1484 stuck fires, 724
  off-route events, bot at the bottom of n310.
- The two other legs from the playtest reports both pass: the stacked jump
  `(1115,504) -> (1046,456)` in 33 ticks clean, and the staircase
  `(3511,936) -> (3732,744)` in 145 ticks with 5 off-route events - completing, but still
  stumbling on the single-column treads (`n674` is one column wide). That is a follower
  precision problem, not a routing one, and it is not addressed here.

Note that `test_navgraph` fails 54 of 192 assertions and has since `NAV_BOX_H` went 7 -> 6
in 8e30e213, which did not update the suite's hand-computed geometry. It is not a
regression signal for any of this; the behaviour suite and `navaudit` are.

## What a replacement has to do

Any new variety mechanism must satisfy **one** of these. Pick deliberately.

- **Keep the heuristic consistent.** If costs are perturbed, the heuristic has to be
  perturbed to match, or perturbed by a factor that applies uniformly along every path so
  the ordering cannot flip. A uniform per-bot multiplier on *all* edges is safe and also
  useless - it changes no ordering at all - which is a good hint that per-edge noise is the
  wrong lever.
- **Rely on the re-open.** It is in place and correct, so an inconsistent heuristic now
  yields optimal paths rather than bad ones. The cost is search time: how much depends on
  how often nodes re-open, and that is worth measuring on `cp_dirtbowl` (the slowest graph,
  ~2.9ms a query before the adjacency index went in) before shipping.

Approaches that avoid the problem entirely, roughly in order of how much they cost:

- **Vary the goal, not the route.** `botSpreadX` already does this and is untouched by any
  of the above. Widening it, or giving bots per-bot *waypoints* to route through, produces
  genuinely different paths out of an unmodified optimal search.
- **k-shortest paths**, then pick by bot id. Honest, deterministic, no heuristic games; the
  expense is running the search more than once.
- **Penalise edges other bots are currently using** - a shared occupancy map, decayed over
  time. This is the one that actually models the problem (bots bunching up) rather than
  approximating it with noise, and it composes with the re-open because the penalty is the
  same for everyone at the moment of the query.

Anything that wants a stable per-bot number again can derive it from `player` exactly as
`botSpreadX` does; it needs no stored field.

## Outstanding

A regression test for search **optimality** does not exist. The old jitter tests checked
that a seeded search returned *a* path and returned *the same* path twice - both true
throughout the bug's life. What is wanted is a purpose-built fixture with a cheap direct
edge and a longer multi-hop alternative, under a deliberately inconsistent heuristic, that
fails if the re-open is removed. Constructing one needs a hand-built node/edge grid rather
than the generated stepped-platform fixture `test_navgraph.gml` uses, which is why it is
not in this pass.

Related reading: `NAVMETHOD.md` for how to run a nav investigation offline, `NAVLOG.md`
for what each generator change measured, `../GML.md` for the GM8 traps, `OPEN.md` for
tooling gaps.
