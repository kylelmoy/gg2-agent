# Open issues

What is known to be wrong or missing in the tooling right now, and what is working well
enough that breaking it would be a regression.

**This file is rewritten, not appended to.** An item leaves when it is fixed; the record
of how it was fixed is the commit that fixed it. Earlier editions of this file carried
every fixed issue forward as a dated writeup and reached 830 lines, at which point the
two genuinely open items were the hardest things in it to find. `git log --follow
docs/OPEN.md` reaches all of it if the history is ever wanted.

See `CLAUDE.md`'s *Where documentation goes* for what belongs here and what does not.

---

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
