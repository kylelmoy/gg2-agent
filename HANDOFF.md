# Open issues and enhancements

Forward-looking backlog for the tooling. The previous edition of this file - written
2026-08-19 alongside milestone 4 part 7 of the bot nav graph - listed five items, all
fixed in that edition. **Five more were added 2026-08-20** from milestone 5 part 3, all
five fixed here - the lint gate's "broad fix" (below) was deferred within the same
session's first pass and picked back up and finished in a second pass the same day, so
it never actually made it into *Still open* for a full edition. What is left after this
edition is at the bottom, under *Still open*.

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

## Still open

### The lint gate's operand-start set does not cover a comma inside a grouping paren

Left over from item 3 above. `y = (1, 2);` still lints clean and does not compile. A
`,` was deliberately left out of the "needs a right operand" set this pass: it is
also legitimate inside call argument lists (`foo(1, 2)`) and multi-declaration `var`
statements (`var i, j;`), both of which put a perfectly good operand right after a
comma, so treating every comma as "needs an operand or it is invalid" is fine on its
own but does not by itself distinguish the one bad case from the two good ones. What
would: track, the same way `parenStack` already tracks `forLoop`, whether each `(` is
a *call* paren (opened immediately after an identifier or `)`/`]`) or a *grouping*
paren, and only flag a `,` as invalid when it is directly inside a grouping one.

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
