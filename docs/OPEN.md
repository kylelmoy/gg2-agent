# Open issues

What is known to be wrong or missing in the tooling right now, and what is working well
enough that breaking it would be a regression.

**This file is rewritten, not appended to.** An item leaves when it is fixed; the record
of how it was fixed is the commit that fixed it. Earlier editions of this file carried
every fixed issue forward as a dated writeup and reached 830 lines, at which point the
two genuinely open items were the hardest things in it to find. That archive is in git as
`HANDOFF.md`, removed in 6b21eb0: `git show 6b21eb0^:HANDOFF.md` if it is ever wanted.

See `CLAUDE.md`'s *Where documentation goes* for what belongs here and what does not.

---

## Still open

### Endpoint tracking, now that it is reachable

The in-flight tracker enforces `needVx * airTicks` - a constant-velocity schedule a real
character cannot produce - so a bot that is *ahead* of it early gets braked. Measured
non-monotonic on the koth_gallery n56 -> n44 arc: v0 3.50 clears it, 3.75 and 4.00 do not,
4.25 does. Tracking the endpoint instead of the ramp fixes that band.

This was measured as **worth nothing on its own** (3310 -> 3310 unflyable edges) and
correctly left alone: most failing edges had no run-up at all, so the bot was never ahead
of the schedule and both trackers behaved identically. **That reasoning stopped holding on
2026-08-23**, when the takeoff gate and the run-up were fixed and bots started arriving at
takeoffs carrying speed.

⚠️ **The residual this item used to point at is gone, and the item is now about something
else.** It read "253 of 62069 jump edges unflyable by a Heavy"; re-measured 2026-08-23 that
is **0 on all 24 graphs**, for the default class and for `--class heavy` alike - the
generator's own veto (`gg2-nav-gen/src/follow.js`) removed the arcs rather than the
follower learning to fly them. `navfollow` is a regression check now, not a survey.

What is left is the population the veto deliberately does not judge: **5,473 jump edges
across the 24 graphs are flyable only WITH a run-up** (`only from a standstill` in
navfollow's output). The generator guarantees an arc against the run-up the *source node*
offers; a bot that has just landed on the takeoff column and jumps again gets less. That is
a follower-timing question, and the non-monotonic band above is exactly the shape of one -
which makes endpoint tracking the candidate fix and those 5,473 the population to measure
it against. `navsoak.js` is the way to see them fail without picking them by hand.

⚠️ Model it in `navfollow` first. `flyJump` is the tracker; a candidate is about twenty
lines beside it, and that is how the *previous* endpoint-tracking idea was killed in two
minutes without a build. `botJumpReach` in the game and `flyJump` here are the same law
written twice - change one and the takeoff gate starts answering about a flight the
follower does not make.

### ~~Bots wedge in their own spawn room~~ — FIXED 2026-08-23

**Fix:** `botInputUpdate.gml` clears `player.botStuckTicks` on the same line that strips
LEFT/RIGHT for the hold. Measured on koth_gallery, 3000 frames, 12 bots, three runs each way:

| | stuck fires | total blacklists | spawn wedge sites |
|---|---|---|---|
| before | 32, 25, 24 | 46, 43, 40 | n11 and n16 top every run, 4-6 exits each |
| after | **3, 0, 0** | 23, 25, 9 | **gone from the ranking** |

`off` was unchanged (10, 11, 6 -> 6, 10, 6), which is the right shape: this fix has nothing
to do with the off-route class and did not pretend to.

Regression gates: the GML suite is 4/4 (469 assertions) and the scenario suite is 13/14.
The one failure is `gallery-pit-climb`, and it is **not** this change: `botscenario` sets
`botRegroupUntil = 0`, so `holding` is always false in every scenario and the new line
cannot execute there - `stuck 0` in all of them confirms it. Re-run n=5 on the patched
build it reads 1/5, inside the band this file already documents for that leg ("2/5 and then
1/6"). This is the leg that once got a good change reverted; do not read it at n=1.

The diagnosis follows, because the *reasoning* is the reusable part:

**The bot is not wedged. It is being held still on purpose, and the stuck detector does
not know.** `botPathKeys` runs its stuck detector on the keys it *intends* to press
(`if(!moved and keys != 0)`), and returns them. `botInputUpdate.gml:116` then strips them:

```gml
if(holding and char.onground and !player.botFlyingEdge)
    navKeys = navKeys & ~(KEY_LEFT | KEY_RIGHT);
```

`holding` is the spawn regroup hold — a freshly spawned bot waiting up to 90 ticks for a
team-mate. So for those 90 ticks the detector believes the bot is pressing a direction and
going nowhere, and **every 12 ticks (`BOT_STUCK_TICKS`) it blacklists one of its own spawn
room's exits.** 90 ticks is seven of those windows, which is the burst.

Six independent things agree:

1. Every worst site in the rotation is a spawn room - koth_gallery n11/n16, koth_corinth
   n192, cp_dirtbowl_a2 n446, ctf_truefort n167.
2. Burst spacing measured at *exactly* 12 ticks: `stk:11>22@2791, 11>63@2803, 11>23@2815,
   11>18@2827`.
3. The position trace during a stuck window decays 0.49, 0.42, 0.37, 0.32, 0.27, 0.24,
   0.20 px/tick - ratio 0.86, no zero-crossing. That is **pure friction with no input**,
   not a bot pressing against something. And every tick of it is under the detector's
   0.5px threshold, so `moved` is false while the bot is genuinely still moving.
4. Traced live, `botStuckTicks` climbs only while `botRegroupUntil - frame > 0` and resets
   on the tick the hold ends.
5. Negative control: `gg2_scenario` places one bot and zeroes `botRegroupUntil`. That leg
   reads **stuck 0, blacklisted 0** over 467 ticks on the same node.
6. `navfollow` calls every one of those edges flyable, and it is right.

⚠️ **This is not just noisy counters.** The bot leaves spawn having banned five or six of
its own exits for `BOT_BLACKLIST_TICKS`, so its first route out is not the cheapest one.

**The fix belongs where the suppression is.** The same override already carries a
`!player.botFlyingEdge` guard added for exactly this class of bug - see its own WARNING
comment about "bot seems to stop trying to move left mid-jump". The grounded case needs the
same treatment: the code that decides not to move the bot should clear
`player.botStuckTicks`. Not yet built, not yet A/B'd - and per this repo's own rule, take
n>=5 on any leg before believing the difference.

⚠️ **Scope honestly.** This explains the spawn-room `stk` bursts, which are the top of the
ranking. It does not account for all 619 `stk` events, and says nothing about the 556
`off` ones. The min-band retreat strip at `botInputUpdate.gml:153` also clears LEFT/RIGHT
but *substitutes* a direction, so it should still move - unverified.

### (original note) Bots wedge in their own spawn room, and it is not an edge problem

`navcensus` on koth_gallery puts n11 and n16 near the top by `stk` bursts - four to six
exits blacklisted in a few dozen ticks, by several bots. Both are spawn rooms whose every
exit but one is gated to the owning team. `navfollow` says every one of those edges is
fine, and the `stk` tag says the bot never left the ground, so this is a wedge (a door, a
player wall, or twelve bots colliding in one doorway) rather than a bad arc. Nobody has
looked at which.

**It is not a koth_gallery curiosity. It is the dominant live failure class.** A full
`navsoak.js` rotation on 2026-08-23 - 22 maps, 6000 frames each, 12 bots, nobody aiming at
anything - produced 209 wedge sites, and **twelve of them show this exact signature (four
or more exits tried, all `stk`) across eight different maps**:

| map | node | bursts | exits |
|---|---|---|---|
| koth_gallery | n11 | 12 | 6 |
| koth_corinth | n192 | 9 | 5 |
| koth_gallery | n16 | 8 | 6 |
| cp_dirtbowl_a2 | n446 | 7 | 5 |
| ctf_truefort | n167 | 7 | 4 |
| ctf_conflict | n245 | 5 | 7 |

⚠️ **And in the same rotation, ZERO edges failed live and were refused by the offline model.**
813 edge findings, not one confirmed by `navfollow`. That is the strongest evidence yet that
the generator's veto really did close the lying-edge class, and that what is left is a
different bug in a different place: **bots that never leave the ground**, not arcs that
cannot be flown. Stop looking at edges for this one.

The next step is unchanged but now much better aimed: find out *which* of a door, a player
wall, or twelve bots in one doorway it is. Pick n11 - most bursts, six exits, and it
reproduces in a 1200-frame window.


### Twin nodes: 163 pairs A* cannot tell apart (and the thrash detector is FINE)

⚠️ **An earlier edition of this file claimed the stuck-detector fix had pushed the problem
into the thrash detector. That was wrong twice over, and the correction is the useful part.**

- **The mechanism runs the other way.** Before the fix, a stuck fire called `botPathPlan`
  every 12 ticks during a hold, and each of those re-plans bumps `botReplanNear` because the
  held bot has not moved. So a hold used to generate `thr` *as well as* `stk`. After the fix
  a hold re-plans only on the 45-tick timer - at most twice in a 90-tick hold. The fix can
  only ever *reduce* hold-driven thrash.
- **And `thr` did not rise.** 4, 7, 10 before (mean 7.0) against 14, 15, 3, 9, 8, 2, 6 after
  (mean 8.1, n=7). The 14 and 15 were the high tail of a noisy distribution, read at n=3.
  **`thr` at a spawn node was 0 in all four of the added runs.** The one-line
  `botReplanNear` fix that item proposed should not be written; there is nothing to fix.

**What `thr` is actually reporting is a real bug, and the detector is doing its job.** The
events come in reciprocal pairs - `n129->n134` and `n134->n129`, over and over. Those two
are adjacent **one-column** nodes 6px apart, joined by walk edges in both directions, with
*identical* jump exit sets (n89, n98, n106, n113, n99, n107, n114, n121, n162). A* has no
reason to prefer either, so the bot walks across, re-plans, is handed the route back, and
oscillates. "Going round in circles at one spot" is exactly what the detector says it
catches.

⚠️ **Two framings of that were measured and thrown away before the right one, and both
matter as warnings.** "One-column nodes" is not the population: **8776 of 11257 nodes (78%)
are one column** - it is the normal shape of a node, not an anomaly, and an item pointing
there sends the next session after three quarters of the graph. "Identical exit sets"
including falls is not it either: exactly **2 such pairs exist across all 24 graphs and
koth_gallery has none** - n129 falls to n134 while n134 falls to n141, so the *fall* edges
differ and only the jumps match.

**The measured population is: adjacent nodes joined by walk edges in both directions whose
JUMP successor sets are identical. 163 pairs across the 24 graphs**, worst koth_harvest 23,
dkoth_sixties 18, koth_gallery 10. On koth_gallery they are not scattered - they are two
staircases of one-column nodes, every step sharing the same nine jump exits:

    n124 <-> n128 <-> n133 <-> n140 <-> n147     x 1842, 1836, 1830, 1824, 1818
    n125 <-> n129 <-> n134 <-> n141 <-> n148     x 1998, 2004, 2010, 2016, 2022

Along a run like that A* is indifferent about which step it launches from, and **every
thrash edge measured over seven runs lands on those two staircases** - n129<->n134,
n133<->n128, n148->n155, n125->n120.

⚠️ **But the thrash detector is not the bug, and a third framing had to be thrown away to
establish that.** Traced live over 3600 frames, re-plan-to-re-plan displacement is normally
100-300px; the small ones cluster at exactly these x-ranges, and `botReplanNear` reaches 1
there repeatedly - but it **never reached 2**, so no `thr` fired. What fires it is the bot
standing near-stationary across three re-plans, which is approximately the right answer.

The margin is much thinner than it looks, and this is the number worth keeping:

    twin-pair step: 117 of 163 pairs are 8.49px apart   (a diagonal cell, sqrt(6^2+6^2))
    BOT_THRASH_DIST                                  =  8
    pairs whose single step is UNDER the threshold    =  0 of 163

**One staircase step clears the thrash test by 0.49px.** It is diagonal that saves it - a
purely horizontal twin pair would be `NAV_CELL_SIZE` = 6px apart and *under* the threshold,
and ordinary one-step progress would read as thrashing. None exist in the 24 shipped graphs
today, which is a property of the generator rather than a guarantee. Anything that changes
`NAV_CELL_SIZE`, `BOT_THRASH_DIST`, or lets the generator emit a flat twin run walks into it.

Also latent, and the same shape as the regroup-hold bug: **`BOT_TAKEOFF_PATIENCE` (60) is
longer than `BOT_REPLAN_TICKS` (45)**, so a bot waiting out a full jump window always spans
a re-plan and always contributes one `near`. Two such waits in one place fire `thr` on the
edge the bot was correctly waiting to fly.

**The residual `stk` is a different member of the same family.** One run in seven produced a
real wedge burst - `n99`, eight exits banned - and n99 is `world x 2100-2106`, a one-column
perch carrying twelve outgoing edges with nowhere to back up to. That is the `only from a
standstill` population navfollow prints and declines to judge, and the same shape as
ctf_oldfort n41.

Whether the answer is merging a twin run into one node, costing the walk along it, or
letting the follower commit to a step is a generator question. 163 pairs is small enough to
predict a delta before spending a build - which is what §6 of NAVMETHOD asks for anyway.

### The bridge reads nothing while a reply is deferred

Reconnecting now clears a `STEP`/`WAIT` that outlived its caller, and does it in 70ms, but
the mechanism is still "tear the connection down and build another". A bridge that drained
buffered frames into a queue while deferred - dispatching them after, which request ids
now make safe - could take an explicit `CANCEL` instead, and would make `tcp_eof` reachable
without the RST. It is a bigger change to `agentBridgeStep` than this edition wanted to
make while another session was building from the same tree.

### Nothing yet uses the walkmask except pictures

`navaudit`/`navsuspects` report a suspect node as coordinates and a ratio. The mask is now
decodable in Node, so a suspect could come with a cropped picture of the geometry around
it, or - more interestingly - the audit could compare the graph against the mask directly
and name a surface with no node on it at all.

### `navsuspects` wants the full graph key, `navimage` does not

`node tools/navsuspects.js koth_valley` fails with a raw ENOENT; `koth_valley_a1` works.
`navimage.js` already resolves a bare map name to `<map>_a1` (and then to any key whose
map matches), so the resolution exists - it is just not shared. Worth lifting into
`navgraph.js` next to `listKeys`, where every CLI can reach it.

## What already works well - do not regress these

- **The `E`/`M` mark split and the repeat-collapsing in `watched()`** are exactly
  right, and did their job every time a call actually completed. The `(x47)`-style
  count is a genuinely useful proxy for "how stuck was this" without needing to keep
  the full repeated text. Both are now shared with the timeout path.
- **The linter's coverage of GM8 vs. GameMaker Studio functions** (`ds_grid_sort`,
  `ds_exists`, etc.) continues to catch the class of mistake it was built for.
- **`gg2_lint` catching a `var` that shadows a built-in instance variable**
  (`var boxInst` avoided, `var id` correctly refused mid-session) is doing real work -
  the fnames-derived built-in list is holding up.
- **The `M!` force-close fallback and the WAIT sentinel (items 1 and 2 above)** are
  both verified against a running exe, not just reasoned about - keep that habit for
  whatever replaces them if the protocol ever grows request ids.
- **`gg2_map_image` with `overlay: true` earned its keep again on 2026-08-20**, and
  faster than the session that built it. One call showed a `koth_valley` nav graph green
  only in a strip by the spawn and red everywhere else, which located the failure to a
  single frontier and turned an open-ended "why is the graph disconnected" into a
  question about one node. The answer was a real generator bug (jump takeoffs pinned to
  the end of a run), and reachability went 13/270 to 150/270. The overlay is the right
  first move on any nav question - reach for it before summing edges by hand.

---
