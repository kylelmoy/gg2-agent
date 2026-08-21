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
are fixed in the second pass below** - see *Fixed 2026-08-20 (second pass)*. What is left
after that pass is at the bottom, under *Still open*: a wedged bridge needing a manual
reconnect, and the wire protocol having no request ids. Both were deliberately left alone
rather than fixed as a reflex - see their own entries for why.

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

## Still open

### A truly wedged bridge needs a manual reconnect

With the ordering-discipline fix from two editions ago, requests behind one the game
never answers all time out in turn. That is honest - the game is not servicing the
bridge, and only a restart helps - but the tooling could notice a bridge with abandoned
slots and reconnect on the next call rather than making the caller work it out. A fresh
connection is cheap and the game handles a dropped client cleanly (`agentBridgeStep`
detects EOF, destroys the socket, clears `deferKind` and unfreezes).

Not done because the unfreeze is the catch: dropping the connection silently resumes a
game the caller may have deliberately frozen with `gg2_step`. Worth doing with that
thought through, not as a reflex.

### The wire protocol has no request ids

Everything about ordering discipline in this file is compensating for a protocol where
replies are matched to requests by position alone. A one-byte sequence number in the
frame would make the whole class of problem impossible instead of merely handled. It
touches `payload/Scripts/AgentBridge/` and every caller, so it is a deliberate change,
not a cleanup - but it is the real fix.

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
