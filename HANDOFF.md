# Open issues and enhancements

Forward-looking backlog for the tooling. The previous edition of this file - written
2026-08-19 alongside milestone 4 part 7 of the bot nav graph - listed five items;
four of them are now fixed here rather than worked around again next session, and
what is left is recorded below with what was done.

The GML-dialect lessons live in `GML.md`, not here - this file is about what the
*tooling* does, not what the language does.

---

## Fixed since the last edition

### 1. A `request()` timeout no longer discards the launcher log (was: high)

`watched()` brackets a command with the launcher and engine log sizes and turns
anything that appeared into a real diagnosis. It only ever ran when the call
*resolved*, so `Bridge.request()`'s own timeout - which rejects - threw all of it
away and guessed instead. The same underlying failure therefore produced either a
full report with `file:line` and a repeat count, or a bare `did not reply within
60000ms`, depending only on whether the socket reply beat the clock.

`Bridge.request()` now takes `logMarks()` before it writes to the socket, and its
timeout builds the same report from the same evidence - the launcher writes to disk
independently of the socket, so it was always there to be read. The machinery
`watched()` had inline is now shared: `troublesSince`, `collapse`, `renderTroubles`,
`hints`.

Three things came out of doing it:

- **A timeout with no dialogs now says so.** "The launcher dismissed no dialog while
  the call was in flight" is a genuinely different diagnosis from "it is stuck on a
  modal" - it means a long loop, a stopped game, or a dead one - and it used to be
  reported as the latter.
- **Message boxes are included on this path** (`{ messages: true }`), because a box
  the launcher has not reached yet is exactly what a frozen game looks like from
  here. `watched()` still leaves them out: a failed assertion is a result, not a
  crash.
- **An error that repeats every frame now names its own cure.** Three or more
  identical dialogs in one call means something the game runs on its own schedule is
  raising it, not the call - so the message says to restart the instance rather than
  leaving the reader to discover that no later call will work either. That is issue
  3 below, reported at the moment it happens.

### 2. `gg2_test` names the suite it stopped in (was: high)

The suite loop computed `logSince` only after `await command(...)` returned, so a
timeout skipped it. It is now wrapped: any failure is rethrown naming the suite and
its file. The launcher-log detail comes free from the fix above, on both paths.

### 3. The shared-global hazard is documented and diagnosed (was: medium)

Not a gg2-agent bug: a `gg2_eval`/`gg2_test` call that touches a global a live
server object also uses every tick can destroy it mid-use, after which the server's
*own* per-tick code raises the same error every frame forever, with nothing to do
with the call that caused it. Only `gg2_session stop` + `start` clears it.

`CLAUDE.md`'s "Things that will waste your time" now names the pattern generically,
points at `navEdgesBegin`'s docstring as the example of the warning to look for, and
says to `gg2_wait` on the relevant idle condition before the first risky call. The
repeat hint above catches the cases where nobody read the docs first.

Freezing background ticks around such a call was considered and **not** done:
`FREEZE` drops network clients, which trades one hazard for another.

### 4. `show_message` is readable more often than the docs claimed (was: low)

`tools/launcher.js` has watched `TMessageForm` (mark `M`) from the start and
`dialogText()` reads its child controls the same way it reads `TErrorForm`'s. The
real caveat is narrower than "unreadable from outside": Delphi paints some captions
with no window handle, so it is best effort - `(dialog had no readable text)`
sometimes, the assertion in full other times.

Reconciled in four places that each said something stronger: this repo's
`CLAUDE.md`, `GML.md` (which contradicted itself between its intro and its
Miscellaneous section), the header comment above `gg2_test`'s implementation, and
the plan file in `~/.claude/plans/`. `summarise()` now prints whatever text *was*
read when it cannot find an `Assertion N failed:` line, and points at `gg2_log
source: "launcher"` rather than telling the reader to go run the suite by hand.

### 5. A late reply is no longer handed to the next caller (found on the way)

Not in the previous edition; found while testing the timeout path. `request()`'s
timeout used to splice its slot out of `pending`, but the game answers in order, one
reply per request - so a call that timed out and *then* got an answer gave that
answer to whoever asked next, and every reply after it belonged to the call before.
A wrong answer that looks right is the worst thing this bridge can produce.

The slot now stays and is marked `abandoned`; its late reply is swallowed, which
keeps the two sides lined up. The visible consequence is that calls queue behind a
request the game never answers at all - so a timeout also reports how many earlier
calls never answered, since in that state nothing about the current call is at
fault.

`tools/selftest.js` covers all of this: a wedged game, a quiet one, a slow one, and
a suite that fails mid-run - in milliseconds, against the fake bridge, with no Game
Maker anywhere.

---

## Still open

### A truly wedged bridge needs a manual reconnect

With the fix in 5, requests behind one the game never answers all time out in turn.
That is honest - the game is not servicing the bridge, and only a restart helps -
but the tooling could notice a bridge with abandoned slots and reconnect on the next
call rather than making the caller work it out. A fresh connection is cheap and the
game handles a dropped client cleanly (`agentBridgeStep` detects EOF, destroys the
socket, clears `deferKind` and unfreezes).

Not done because the unfreeze is the catch: dropping the connection silently resumes
a game the caller may have deliberately frozen with `gg2_step`. Worth doing with
that thought through, not as a reflex.

### The wire protocol has no request ids

Everything above is ordering discipline compensating for a protocol where replies
are matched to requests by position alone. A one-byte sequence number in the frame
would make the whole class of problem impossible instead of merely handled. It
touches `payload/Scripts/AgentBridge/` and every caller, so it is a deliberate
change, not a cleanup - but it is the real fix.

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
