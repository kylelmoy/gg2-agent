# Open issues

What is known to be wrong or missing in the tooling right now, and what is working well
enough that breaking it would be a regression.

**This file is rewritten, not appended to.** An item leaves when it is fixed; the record
of how it was fixed is the commit that fixed it. See `CLAUDE.md`'s *Where documentation
goes* for what belongs here and what does not.

---

## Still open

### `gg2_input aim` hangs, and the obvious fix does not work

`window_views_mouse_set` never returns while the game window is not the foreground window,
which a game this tooling launched normally is not. There is no reply, no dialog and
nothing in any error log, and the game carries on normally afterwards. `press`/`click` do
not depend on focus and are unaffected.

The standard fix - the launcher calling `AttachThreadInput` on the foreground thread, then
`SetForegroundWindow` on the game - was tried and does not work here. `AttachThreadInput`
itself fails, with `GetLastError()` 5 or 87 (access denied, invalid parameter)
inconsistently across runs, even though `OpenInputDesktop` confirms the calling process is
on the interactive desktop. Two error codes for one identical call reads as UIPI or an
integrity-level restriction rather than a sequencing mistake. A fix most likely needs a
different mechanism - aim driven inside the game by the bridge, the way held movement
already is through `heldMask` - rather than another Win32 focus trick.

### Nothing uses the walkmask except pictures

`tools/walkmask.js` decodes a map's collision mask with no game running, and the only
consumers are `gg2_map_image`'s mask base layer and `gg2_area_shot`'s outline. It is the
one place this repo can answer a geometry question offline, and it is worth remembering it
exists before reaching for a running game.

---

## What already works well - do not regress these

- **The `E`/`M` mark split and the repeat-collapsing in `watched()`** are exactly
  right. The `(x47)`-style count is a genuinely useful proxy for "how stuck was this"
  without needing to keep the full repeated text. Both are shared with the timeout path.
- **The linter's coverage of GM8 vs. GameMaker Studio functions** (`ds_grid_sort`,
  `ds_exists`, etc.) continues to catch the class of mistake it was built for.
- **`gg2_lint` catching a `var` that shadows a built-in instance variable**
  (`var id` correctly refused) - the fnames-derived built-in list is holding up.
- **The `M!` force-close fallback and the WAIT sentinel** are both verified against a
  running exe, not just reasoned about - keep that habit for whatever replaces them.
- **`CANCEL`, and reading while a reply is deferred.** The bridge answers a
  `CANCEL` on the spot and holds everything else until the deferred reply goes
  out. Do not "simplify" this back into answering queued requests immediately: a
  deferred `STEP` has the world running, so anything run in that window changes
  what the `STEP` measures. And `deferPrefix` is not redundant with
  `replyPrefix` — the deferred reply must carry its own id, which used to happen
  by accident only because nothing was read in between.
- **`CODE_PATCHES` and its selftest round-trip.** The patches rewrite lines of the game's
  own logic rather than adding lines beside them, and several sites are the braceless body
  of an `if`, where an insertion silently changes what the game does. The selftest checks
  each anchor is still exactly one line of the real tree and that inject/cleanup restores
  the file byte for byte. `git status` cannot catch a half-restored patch - a
  subtly-modified client still looks stock - so that check is the only thing standing
  between a botched cleanup and a quietly different game.
