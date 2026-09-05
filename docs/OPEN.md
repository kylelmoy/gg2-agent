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

### The bridge reads nothing while a reply is deferred

Reconnecting now clears a `STEP`/`WAIT` that outlived its caller, and does it in 70ms, but
the mechanism is still "tear the connection down and build another". A bridge that drained
buffered frames into a queue while deferred - dispatching them after, which request ids
now make safe - could take an explicit `CANCEL` instead, and would make `tcp_eof` reachable
without the RST. It is a bigger change to `agentBridgeStep` than any edition so far has
wanted to make while another session was building from the same tree.

### `gg2_input aim` hangs, and the obvious fix does not work

`window_views_mouse_set` never returns while the game window is not the foreground window,
which a game this tooling launched normally is not. Forcing focus from the launcher with
`AttachThreadInput`/`SetForegroundWindow` was tried and failed with access-denied and
invalid-parameter errors; `git show efedf8b:HANDOFF.md` has the detail before anyone tries
it again. `press`/`click` do not depend on focus and are unaffected.

### A full build has no `gmksplit.exe`

`gmksplit.exe` and `gm8x_fix.exe` lived in the old fork's `Source/` and went with it when
`Gang-Garrison-2` was replaced by the upstream checkout on 2026-09-05; upstream ships
`Source/GitToGmk.bat`, which calls `gmksplit.exe`, but not the binary. `build-agent.js`
therefore stops at *"gmksplit.exe not found. Looked in: gg2-agent/tools; Source and PATH"*
before it reaches Game Maker at all, and `Source/build/` is gone with the same checkout -
so there is no exe, no fast-rebuild template and no instance register either.

The sources are on this machine: `D:/code/Gmk-Splitter` (Java, `build-release.sh` plus
launch4j) and `D:/code/gm8x_fix` (C). Building either, or restoring the binaries from a
backup, unblocks every build path; nothing else about the tooling needs it.

### Nothing uses the walkmask except pictures

`tools/walkmask.js` decodes a map's collision mask with no game running, and the only
consumers are `gg2_map_image`'s mask base layer and `gg2_area_shot`'s outline. It is the
one place this repo can answer a geometry question offline, and it is worth remembering it
exists before reaching for a running game.

---

## What already works well - do not regress these

- **The `E`/`M` mark split and the repeat-collapsing in `watched()`** are exactly
  right, and did their job every time a call actually completed. The `(x47)`-style
  count is a genuinely useful proxy for "how stuck was this" without needing to keep
  the full repeated text. Both are shared with the timeout path.
- **The linter's coverage of GM8 vs. GameMaker Studio functions** (`ds_grid_sort`,
  `ds_exists`, etc.) continues to catch the class of mistake it was built for.
- **`gg2_lint` catching a `var` that shadows a built-in instance variable**
  (`var boxInst` avoided, `var id` correctly refused mid-session) is doing real work -
  the fnames-derived built-in list is holding up.
- **The `M!` force-close fallback and the WAIT sentinel** are both verified against a
  running exe, not just reasoned about - keep that habit for whatever replaces them.
- **`CODE_PATCHES` and its selftest round-trip.** The patches rewrite lines of the game's
  own logic rather than adding lines beside them, and both sites are the braceless body of
  an `if`, where an insertion silently changes what the game does. The selftest checks each
  anchor is still exactly one line of the real tree and that inject/cleanup restores the
  file byte for byte. `git status` cannot catch a half-restored patch - a subtly-modified
  client still looks stock - so that check is the only thing standing between a botched
  cleanup and every later comparison against a real client being quietly wrong.

---

## Retired, 2026-09-05

The bot-nav layer - `navgraph`, `navaudit`, `navimage`, `navfollow`, `navsuspects`,
`navcensus`, `navsoak`, `botscenario`, `bot-scenarios`, the payload's `agentNavReach` and
`agentNavDump`, `gg2_scenario`, `gg2_map_image`'s reachability overlay, and
`docs/NAVMETHOD.md`, `docs/NAVLOG.md` and `docs/ROUTEVARIETY.md` - was removed when
`Gang-Garrison-2` was replaced by the upstream reference checkout, which has no bot layer
for any of it to read. `git show d346b8a` is the last commit that has them.

Bot navigation lives in `gg2-server` now, generated by its own C# port of `gg2-nav-gen`
(`src/Gg2.Nav`, `docs/NAVGEN.md`), which unlike its predecessor has an oracle: a test that
rebuilds every shipped graph from the map PNGs and compares character for character. The
open items that used to be in this file - endpoint tracking, twin nodes, the run-up
population - belong there, against that generator, not here.
