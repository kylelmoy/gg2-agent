# Open issues and enhancements

Forward-looking backlog for the tooling. The previous edition of this file - written
2026-08-19 alongside milestone 4 part 7 of the bot nav graph - listed five items, all
fixed in that edition. **Five more were added 2026-08-20** from milestone 5 part 3, all
five fixed here - the lint gate's "broad fix" (below) was deferred within the same
session's first pass and picked back up and finished in a second pass the same day, so
it never actually made it into *Still open* for a full edition. What is left after this
edition is at the bottom, under *Still open*.

**Three more were added later on 2026-08-20**, from the bot aim solver and the
`koth_valley` nav reachability work. All three are about *observing* a running game rather
than driving it, which is where that session spent its time and lost most of it: a watch
that raises every frame once the game is frozen, no way to set state and start waiting on
the same frame, and traces that are hard to read. The GML-dialect findings from the same
work went to `GML.md` - notably that `-1` is `self` rather than "no instance", which is
the sentinel GG2 uses everywhere.

**All three, plus the comma-in-grouping-paren gap left over from the lint gate's item 3,
are fixed in the second pass below** - see *Fixed 2026-08-20 (second pass)*. That pass
left two: a wedged bridge needing a manual reconnect, and the wire protocol having no
request ids. Both were deliberately left alone rather than fixed as a reflex - see their
own entries for why.

**Both are fixed on 2026-08-22** - see *Fixed 2026-08-22*. Doing the second one properly
turned up three more bugs that no amount of reading would have found: the bridge checked
for a departed client on the one code path that could not reach the check, `tcp_eof` stays
false while anything is unread so an ordinary close was invisible, and the client opened
one socket per concurrent call against a game that accepts exactly one. The same session
added walkmask rendering, which is a different kind of entry and has its own section.

The GML-dialect lessons live in `GML.md`, not here - this file is about what the
*tooling* does, not what the language does.

---

## Fixed 2026-08-20 (the five from milestone 5 part 3)

### 1. The launcher can now dismiss a `TMessageForm` that has no child windows (was: high)

`tools/launcher.js`'s dismissal loop filtered by class and pid, found the window, then
did `kids.filter(k => k.cls === spec.button)` and `if (!target) continue`. GM8's
startup dialogs carry a real `TButton` child and are dismissed exactly as documented,
but `test_assert_equals`'s box has an empty title and zero child windows - its "OK" is
painted, not a control - so `target` was always `undefined` and the loop skipped it
forever, freezing the game with nothing in any log saying so.

The loop now falls back to `win32.closeWindow` (posts `WM_CLOSE`) when no matching
button child exists, logged distinctly as `M!` since a box that had to be force-closed
is one whose text was probably unreadable too. Verified live: calling
`test_assert_equals(1, 2)` through `gg2_eval` (with `global.testAssertions` seeded by
hand, outside of a real suite run) used to hang; it now returns `ok` immediately, and
the launcher log shows `M!| forced closed (no TButton child to click)` followed by a
`pong` a moment later. `CLAUDE.md` and `GML.md` are reconciled to describe this instead
of contradicting each other.

### 2. A `WAIT` whose expression raises no longer re-raises it every frame of the budget (was: high)

`agentBridgeDefer.gml`'s `deferKind == 2` branch called
`execute_string("return (" + deferExpr + ")")` and tested its return value for
truthiness every frame. GM8 has no exceptions, so a raising expression and a merely
false one were indistinguishable that way - both produced a falsy result - and the wait
just kept retrying, raising a fresh modal every frame until the budget ran out (900
frames' worth of dialogs, observed).

Fixed with a sentinel: `deferWaitOutcome` is poisoned to `"raised"` immediately before
a nested `execute_string` that sets it to `"true"` or `"false"`, and read immediately
after. Verified live against the running game, twice, before writing the fix into the
committed script - a compile error and a runtime error (`(123456789).x`) both leave the
sentinel exactly as poisoned, because `execute_string`'s Ignore-continuation aborts
*that call* rather than completing the interrupted assignment with a default value.
With the fix in, `gg2_wait` on a raising expression comes back in one frame instead of
the full budget (`"WAIT expression raised an error, abandoned after 1 frame(s)"`), and
a genuinely true/false expression is unaffected - both re-verified live. GM8 has no
ternary either (`CLAUDE.md`'s dialect table already says so); the fix uses `if/else`,
not `?:`.

### 3. The lint gate now parses enough expression grammar to catch all three repro cases (was: high)

Three changes, the first two narrow and the third the "broad" fix the first pass of
this edition deferred:

- `tools/gml-lint.js`'s `lintSource` now scans for `&lt;`, `&gt;` and `&amp;` as a
  plain substring pass before tokenizing, and refuses them outright (rule
  `html-entity`) - they cannot be intentional in GML, and by the time they are tokens
  the fact that they were ever one escaped entity is gone. This is exactly the case
  that surfaced the bug: `global.x or y &gt; 3` now lints as an error instead of clean.
- `gg2_evalx` and `gg2_wait` now lint `"return (" + expr + ")"` rather than the bare
  `expr` - the wrapped form is what the game actually has to compile, and an operator
  or `;` in operand position can be a plausible statement sequence on its own while
  being invalid inside `return (...)`.
- `lintSource` now also checks, without a full expression parser: (a) that every
  operator needing a right operand (all binary operators, plus the unary ones) is
  immediately followed by a token that can start one - not a closing bracket, a
  separator, or another operand-hungry operator - and (b) that a bare `;` never
  appears inside a `(...)` that a `for` did not open, since that is the one place GM8
  allows one there. Both are local checks - "what comes right after this token" - not
  a model of the whole grammar, which is what keeps them conservative enough to trust.
  This is enough to catch `gg2_lint`'s two previously-still-clean repro cases from the
  earlier edition: `return (1 ; 2);` (semicolon-in-expression) and `a = (1 + );`
  (dangling-operator).

**Verified two ways before trusting it**: `node -e` against a dozen deliberately-bad
snippets (a dangling operator after `+`, `*`, `or`; a bare `;` in a non-for paren) all
caught, and sixteen legitimate-but-similar-looking idioms (`for` with its three
clauses, 2D array indexing `a[i, j]`, unary chains like `1 - -1`, `not`, `switch`/`case`,
`do`/`until`, `with`, `a = b == c`, and GM8's `if (a = b)` equality-via-assignment
quirk) all still accepted - now locked in as `tools/selftest.js`'s "expression
grammar" section. Then the whole real tree: `node tools/gml-lint.js --tree
Source/gg2 Source/gg2` and the same against `payload/` (which includes this
edition's own new GML) both still report **clean** - zero new findings across the
~20,000 lines the linter already had to stay quiet on. **Not done**: a `,` in a
grouping paren, e.g. `y = (1, 2);`, still lints clean - deliberately left out of the
operand-start set this pass since call arguments and `var i, j;` legitimately put an
operand right after a comma too, and distinguishing "grouping comma" from
"argument-list comma" needs the call/group distinction the parenStack does not track
yet. Left for whoever hits it.

### 4. A launch failure in a disconnected Windows session is now diagnosed correctly (was: high)

`run-agent.js` blamed a Remote Desktop audio modal for every "bridge did not come up"
timeout, but a disconnected session (state `Disc`) never gets that far - GM8 dies on
`Failed to retrieve display mode.` and exits almost immediately, which looks nothing
like a hung audio modal by the hint's own description.

`tools/win32.js` gains `sessionState()`, which shells out to `query session` and
matches the current process's session id (via `ProcessIdToSessionId`) against the
`STATE` column rather than by position - `SESSIONNAME` is blank for a disconnected RDP
session and shifts every later column left, so matching by id is what makes this
reliable. `run-agent.js` checks it before the existing audio hint and prints the
disconnected-session diagnosis instead when it applies, naming both fixes (reconnect
the client, or `tscon <id> /dest:console`, which is the user's call since it unlocks
the console desktop). Verified `sessionState()` returns `"Active"` correctly against
this session; the `Disc` branch itself is code-reviewed rather than live-tested, since
forcing a real disconnect would have cut off this session's own tools mid-task.

Also added: `win32.captureWindow(hwnd)` renders a window with `PrintWindow` and reads
it back with `GetDIBits` into a BMP buffer, for dialogs `controlText` cannot read.
`tools/launcher.js` now saves one next to the launcher log whenever a dialog's text
comes back empty, and names the file in the log line. Verified live twice: once
against an arbitrary visible window (captured its real content, confirmed by
converting to PNG and viewing it), and once against `test_assert_equals`'s own
unreadable box while testing fix 1 above - the saved screenshot showed
"Assertion 1 failed: 1 should be equal to 2" in full, despite `WM_GETTEXT` reporting
nothing for that dialog.

### 5. `build-agent.js` no longer empties `Source/build` before failing to remove it (was: medium)

The retry loop's recursive `rmSync` deletes contents before the directory itself, so a
locked directory failed after being emptied - the next build then had to be a full one
(template, exe, `gg2.ini`, nav cache all gone) whether or not that was wanted, and the
error blamed "is the game still running?" specifically, when a locked cwd can belong to
anything.

Now: after the retry loop, an `existsSync` directory that is also empty
(`readdirSync().length === 0`) is treated as a clean build target and the run
continues, instead of throwing. Only a directory that still has something in it after
five retries is a real failure, and the error now lists what is left and says
"something holds this directory as its working directory (the game, a shell, a file
search)" rather than pointing at the game specifically. Syntax-checked
(`node -c build-agent.js`); not exercised against a real locked directory, since
reliably producing one on demand from this session would have meant leaving something
else running or open, and this fix touches only the outcome after the retries already
gave up.

---

## Fixed 2026-08-20 (second pass)

### 1. `gg2_watch` no longer raises every frame while instances are unreachable (was: medium)

`agentBridgeWatchTick` sampled unconditionally, every frame, regardless of `frozen`. A
watch expression that touches an instance field — which is most of them — started
raising the moment anything deactivated instances, and kept re-raising once per frame for
as long as that lasted, because a deactivated instance's fields are unreachable from
anywhere (see `CLAUDE.md`). `gg2_step` freezes first and reactivates instances only for
the frames it actually steps, so a watch across a `gg2_step` call raised during the
`FREEZE`-then-`STEP` gap and again after the step deactivated everything at the end —
and whichever call happened to be in flight when the launcher noticed the dialog came
back as an *error*, even though it had done its job.

Fix: `frozen` alone was the wrong signal to gate on - it stays true for the whole span of
a `STEP`, even while `STEP` has reactivated every instance for the frames it is actually
running, and gating on it would have suppressed sampling during exactly the frames worth
watching. A new instance var, `instancesDeactivated`, is set precisely where
`instance_deactivate_all(true)`/`instance_activate_all()` are actually called (`FREEZE`,
`RESUME`, `STEP`'s arm and its completion, and the client-disconnect cleanup path) and is
what `agentBridgeWatchTick` gates on instead. Sampling is skipped while it is true, with
one log line on the way in (`watch sampling suspended (instances unreachable while
frozen)`) and one on the way out (`watch sampling resumed`), not a repeat per frame.

Verified live against the running game: `gg2_watch add room_speed`, then a manual `FREEZE`
followed by `gg2_step frames: 60` followed by `gg2_resume` — the bridge log shows exactly
one suspend line (during the gap between the manual `FREEZE` and `STEP` actually arming),
one resume line (once `STEP` reactivated instances), and no `Unknown variable` anywhere;
all three calls came back clean, not as errors. `node tools/selftest.js` also covers the
lint side unaffected by this (98 pre-existing cases untouched) and the wire format below.

### 2. `gg2_wait` gained an atomic `setup` (was: medium)

The game keeps running between MCP calls, so `gg2_eval` to place a bot and then
`gg2_wait` to time it left an unknown amount of real game time in between — during which
the bot could walk off, re-plan, or finish before the wait ever armed. `gg2_wait` gained
an optional `setup`: GML run once, synchronously, inside the same `WAIT` request that
arms the wait, immediately before `expr` is first tested.

Wire format: `WAIT <frames> <setupLen>:<setup><expr>` — `setup` is length-prefixed, not
delimited, so it can contain anything (a semicolon, a colon, a space) without ambiguity
against `expr`; `setupLen` is `0` and `setup` empty when no setup is given, so the format
is unconditional rather than two formats the game has to tell apart. `setup` is linted
the same way `gg2_eval`'s `code` is — raw GML, checked before it is ever sent.

Verified live: `gg2_wait` with `setup: "global.agentSelfTestMarker = 1;"` and
`expr: "global.agentSelfTestMarker == 1"` came back `true after 1 frame(s)` — the
smallest possible gap between the setup running and the condition being seen true, not
the seconds of drift a separate `gg2_eval` call would have left. The failure path was
checked too: the same setup with an `expr` that stays false came back `still false after
10 frame(s): global.agentSelfTestMarker == 1` — naming only `expr`, confirming the
length-prefixed split lands in the right place — and a `setup` that would not compile
(`array_length(x);`, a GameMaker Studio function) was refused by the lint gate before
ever reaching the game, with `global.agentSelfTestMarker` read back afterward to confirm
that refused call had no effect at all.

### 3. Watch trace lines can carry a short label instead of the whole expression (was: low)

`gg2_watch` wrote the full source of the expression on every logged change, so a trace of
several fields ran mostly-repeated text and a stale trace was hard to tell from a fresh
one. `gg2_watch add` now accepts an optional `label`; the trace logs `label = value`
instead of the expression, falling back to a truncated copy of the expression (24
characters plus `...`) when none is given. `gg2_watch list` shows `label (expr) = last`
when a label is set. Wire format mirrors `WAIT`'s setup: `WATCH add
<labelLen>:<label><expr>`, unconditionally length-prefixed.

Verified live: `gg2_watch add room_speed label: "RS"` then `gg2_watch list` returned
`RS (room_speed) = 30`.

### 4. The lint gate now catches a comma inside a grouping paren (was: low)

Left over from the previous edition's item 3. `y = (1, 2);` lints clean and does not
compile in GM8, which has no comma operator; a `,` was deliberately left out of the
"needs a right operand" set at the time because it is also legitimate right after a
call's own `(` (`foo(1, 2)`) and after `var` in a multi-declaration (`var i, j;`).

Fix: the same paren-tracking stack that already tells a `for`-loop's parens apart from
every other `(` now also tags each `(` as a *call* (opened immediately after an
identifier that is not a keyword, or after a closing `)`/`]`) or a bare *grouping*, and
now tracks `[`/`{` too, purely so nesting stays correct — in `(a[i, j])` the comma
belongs to the 2D array index, not the outer grouping paren, and only the top of the
stack at the comma's own position says which. A `,` is flagged only when its nearest
enclosing bracket is a grouping `(`.

Verified two ways: `node -e` against the three repro shapes (`y = (1, 2);`,
`x = (a, b, c);`, `if (a, b) { exit; }`, all now refused) and seven legitimate-looking
neighbors that must stay clean (a real call with two args, a call whose args include a
2D index, a 2D index nested inside a grouping paren, plus the sixteen from the previous
edition) — now locked into `tools/selftest.js`'s "expression grammar" section. Then the
whole real tree again: `node tools/gml-lint.js --tree ../Gang-Garrison-2/Source/gg2
../Gang-Garrison-2/Source/gg2` and the same against `payload/` both still report
**clean**.

---

## Fixed 2026-08-22 (the two that were left open)

Both of the previous edition's *Still open* items, and three bugs that only turned up
because fixing them properly meant running them against a real game. Verified against a
live exe throughout - an isolated copy of the build on port 17790, so a session already
driving the shared one on 17777 was never touched.

### 1. The wire protocol now has request ids (was: the real fix)

The frame body is `#<id> <request>`, and the reply comes back `#<id> <reply>`.
`agentBridgeStep` strips the prefix into `replyPrefix`; `agentBridgeSend` puts it back on
every reply, which covers the deferred ones `agentBridgeDefer` sends frames later without
either of them having to remember. Client-side, `pending` became a Map keyed by id, so a
reply is a lookup rather than a `shift()`.

**The id is optional to the game and mandatory to the client**, deliberately and not
symmetrically: a game rebuilt with this still answers a client that predates it (the
prefix is simply absent, `replyPrefix` stays `""`), which mattered because the shared
build was rebuilt mid-session by another session while its client kept running. The other
direction is refused outright with a message naming `gg2_rebuild`, because a reply with no
id cannot be matched to anything and guessing is exactly how a wrong answer that looks
right gets produced.

What this buys, concretely: the ordering discipline that the whole "abandoned slot" dance
existed to protect is now a property of the format. A late reply is dropped as the call it
belongs to; a reply to something already forgotten is logged and ignored.

Verified live: ping/evalx/state/step/resume/wait/wait-with-setup all round-trip with ids,
including both deferred paths. Plus 133 selftest assertions, which now include a fake
bridge that echoes the id exactly as the real one does.

### 2. A wedged bridge reconnects itself (was: needs a manual reconnect)

A call that finds *every* outstanding request abandoned drops the connection and opens a
new one before sending. The catch the previous edition flagged - that this silently
resumes a game the caller froze - is handled rather than avoided: the client tracks
whether it was the one that froze the game, re-applies the freeze after reconnecting, and
then **fails the call that triggered the recovery** instead of answering it. The world
moved by a few uncounted frames; saying so is worth more than a number measured after it.
Retrying is a clean call against a game in the state it was left in.

**The premise turned out to be worth measuring, and the first attempt did not work.**
While a deferred `STEP` or `WAIT` is outstanding the bridge reads nothing else, so a
`WAIT 3600` whose caller gave up after 10s blocks every later call for the remaining ~110
seconds. Measured: a `PING` sent behind one came back only as a timeout with "1 earlier
call(s) never answered". Reconnecting is the only thing that can clear that, because
nothing sent down the old connection is being read. Two separate bugs stood in the way:

- **`agentBridgeStep` checked for a dropped client *after* the deferred-reply branch**,
  which `exit`s while the reply is still pending - so a client that dropped mid-`WAIT` was
  not noticed until the whole budget expired, and the reconnecting client sat in the accept
  backlog the entire time. The EOF check now runs before the defer branch. This is
  load-bearing ordering, not tidying, and it is commented as such in the script.
- **`tcp_eof` is false while anything is still unread**, buffered request included. A
  client that gave up with two requests in flight leaves the second one sitting there, so
  an ordinary FIN is invisible to the game for exactly as long as it is not reading.
  Proved with a raw socket both ways: FIN, and the game held the dead connection for the
  full 120s; RST, and the next client was served 95ms later. `Bridge.disconnect` now uses
  `resetAndDestroy()`. Nothing in flight is worth delivering to a client that has stopped
  waiting for all of it.

Then a third, which was the actual reason the fix appeared not to work at all:
**`connect()` had no in-flight guard**, so two calls starting together opened a socket
each. The game accepts one client, so the loser's requests went into the accept backlog
and were never read - and a reconnect only ever tore down whichever socket happened to be
`this.sock`, leaving the game's real connection alive and owned by nobody. One shared
promise fixes it. This bug predates this edition and would have looked like "the game
randomly ignores a call".

Diagnosis is also better when reconnecting does *not* help: a call that times out on a
freshly recovered connection says so specifically ("already reconnected once ... the game
is not servicing the bridge at all"), because a game that ignores a client it has just
accepted has stopped stepping, which is a different problem with a different cure.

Measured, end to end: an abandoned `WAIT 3600` used to block the next call for ~114s; it
now answers in **70ms**. The frozen variant re-freezes (confirmed by reading `frozen` back
from the game) and fails the triggering call with the explanation.

### 3. `gamedata.patch` now lints against the tree it is building

Found while building the isolated exe. The lint gate spawns `gml-lint.js --stdin`, which
had nothing to go on and autodetected a checkout beside this repo - so a build of any
*other* tree was checked against a different tree's scripts, reported every script the
build has and that tree does not as an unknown function, and refused the build. It now
passes `--tree`. No behaviour change for the ordinary `build-fast.js` path, where the two
are the same directory.

---

## Walkmask rendering (2026-08-22)

`tools/walkmask.js` is new: it decodes a map's collision mask straight out of the map
PNG's own `zTXt` "Gang Garrison 2 Level Data" chunk - the same data the game reads
(`Scripts/Maps/CustomMaps`), six bits per character, one continuous row-major bitstream.
No game, no bridge, exact.

The other session of the same day found the same chunk independently and put a reader in
`navgraph.js`. **They are one decoder now** - `walkmask.js` owns it, `navgraph.js`
re-exports `levelData` and `walkmask` from it, and a selftest case asserts both names
return the same bits. See *The tools this needed* below for the detail.

The point is that **the nav graph is built against the mask and nothing else**, so the map
art agrees with a nav overlay only by coincidence: it paints scenery nothing collides with
and draws real geometry as background. Rendering the same `koth_valley` overlay both ways
settles it - on the art the node bars float over a dark night scene; on the mask every bar
is visibly sitting on the surface it belongs to, and the two vertical shafts that cost this
project a bug are plain.

- `gg2_map_image` gained `base: art|mask|both`, defaulting to **mask when `overlay` is on**
  and art when it is not, because those are different questions.
- `navimage.js` gained `--base`, defaulting to mask - it exists only to answer nav
  questions.
- `gg2_area_shot` gained `walkmask: true`, which traces the solid/open boundary in magenta
  over the live shot. Composited on the Node side: one mask cell is exactly
  `NAV_CELL_SIZE` (6) world px and tiles are captured at 1:1, so it lands on the collision's
  own pixels with no resample and no GML. **A fill was tried first and rejected on the
  evidence** - over a map painted this dark it either vanishes into the art or hides what
  the shot was taken for. The outline costs one world pixel per boundary and covers nothing.

## Still open

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

