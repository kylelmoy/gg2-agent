# Everything in this file is fixed

All eight issues this file used to describe - written 2026-08-19 after the
session that built milestone 4 of the bot nav graph - are done and verified.
Read the history at `bc709a4` (where it was written) through `b6e70f6` (the
last of the fixes) if you need it; `node tools/selftest.js` covers all of it
and is up to 65 checks, all passing, as of this pass.

1. **The linter now catches both silent-startup compile errors.** `var solid,
   x, y;` (shadowing a built-in instance variable) and `global.navNodeGrid =
   -1;` (assigning to a script/object/sprite/room/constant name) are both
   errors in `gml-lint.js` now, not clean passes that only show up as
   `run-agent.js` timing out with no bridge log at all.
2. **`run-agent.js` reads the error dialog when the bridge times out.** It
   already had one diagnosis path for the RDP/no-audio-device case; it now
   has a second for `TErrorForm`, reading the failing script and line straight
   out of the dialog's `TMemo` instead of leaving a bare timeout to explain.
3. **The lint context cache no longer thrashes on tree order.** `events.js`
   and the MCP server pass the same two trees in opposite order, which
   defeated the single-slot cache on every interleaved call - always correct,
   since the manifest-mtime key still carried real state, but paying for a
   full tree walk and fnames read on every lint instead of caching anything.
   `context()` now sorts trees before use and before keying, and the cache
   holds eight entries instead of one. This is a confirmed, real fix for one
   of the candidates this file named - whether it was *the* cause of the
   original repro (four new scripts staying unknown until a server restart)
   was never proven; an isolated repro of the manifest-mtime path alone did
   not reproduce staleness. If the exact symptom recurs, it needs a live
   repro against a real `build-agent.js` run to take further.
4. **`gg2_test` has `skip_lint`**, matching `gg2_eval`/`gg2_evalx`/`gg2_wait`/
   `gg2_watch`.
5. **`gg2_test` reads its suite off disk in-game by default** now, the same
   trick worked around by hand in the session that wrote this file -
   `file_text_open_read` plus `execute_string`, no lint gate on the suite
   body, no wire-size ceiling, no escaping concerns. `send_source: true`
   keeps the old wire-send behaviour for the one case that still needs it -
   game and tooling not on the same machine.
6. **`gg2_profile` exists** - `mode: "expr"` runs code `repeat(n)` between two
   `current_time` reads for a pure CPU cost; `mode: "frames"` freezes the game
   and steps it one frame at a time for a frame-time distribution of whatever
   is already running.
7. **`build-fast` refusals name the file.** `gamedata.js` keeps a per-file
   hash alongside the aggregate `treeHash` now, so a mismatch says which
   sprite/room/setting/included file changed instead of just that one did.
8. **The `EVALX` `return`-wrapping gotcha is in the tool's own description**,
   not just in a file an agent has to already know to check.

The other few items this file listed as "still open, unchanged from the
previous edition" - `gg2_input aim` hanging with no OS focus, freezing
stopping the network, a frozen instance's fields being unreadable until
reactivated - are documented, known engine/tooling limitations rather than
open bugs, and are covered in `CLAUDE.md` and `GML.md` instead of here.
