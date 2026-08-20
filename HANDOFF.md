# Open issues and enhancements

Forward-looking backlog for the tooling. The previous edition of this file - written
2026-08-19 alongside milestone 4 part 7 of the bot nav graph - listed five items, all
fixed in that edition. **Five more were added 2026-08-20** from milestone 5 part 3;
all five are now fixed here, four of them completely and one (the lint gate) partially,
with the remainder recorded below rather than silently dropped. What is left after
this edition is at the bottom, under *Still open*.

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

### 3. The lint gate now rejects HTML-escaped operators, and lints the wrapped form (was: high, partially fixed)

Two changes, both narrow, matching the two "candidate fixes" the previous edition
called complementary:

- `tools/gml-lint.js`'s `lintSource` now scans for `&lt;`, `&gt;` and `&amp;` as a
  plain substring pass before tokenizing, and refuses them outright (rule
  `html-entity`) - they cannot be intentional in GML, and by the time they are tokens
  the fact that they were ever one escaped entity is gone. This is exactly the case
  that surfaced the bug: `global.x or y &gt; 3` now lints as an error instead of clean.
- `gg2_evalx` and `gg2_wait` now lint `"return (" + expr + ")"` rather than the bare
  `expr` - the wrapped form is what the game actually has to compile, and an operator
  or `;` in operand position can be a plausible statement sequence on its own while
  being invalid inside `return (...)`.

**Not done**, and left for the next person to pick up if it costs real time again: the
"broad" fix, teaching `lintSource` enough expression grammar to reject an operator or
`;` in operand position generally. `gg2_lint`'s own two other repro cases from the
previous edition - `return (1 ; 2);` and `a = (1 + );` - still lint clean, because
neither contains a banned entity and both are full statements passed to `gg2_eval`,
outside what the wrapped-form fix touches. Verified via `node -e` against
`tools/gml-lint.js` directly (the running MCP server had the old code loaded in memory
and needs a restart to pick up either fix - same as the launcher, this is Node
tooling, not GML, so nothing in the built game needed rebuilding for it).

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

## Still open

### The broad lint fix: `lintSource` does not parse expression grammar

Left over from item 3 above. `return (1 ; 2);` and `a = (1 + );` still lint clean and
do not compile. The narrow entity-based fix and the wrapped-form fix together cover the
case that actually cost time this session; teaching the linter enough grammar to catch
an operator or `;` in operand position generally is a bigger, separate piece of work.

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
