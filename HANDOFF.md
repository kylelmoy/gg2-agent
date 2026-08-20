# Open issues and enhancements

Forward-looking backlog for the tooling, written 2026-08-19 across the session
that built milestone 4 of the bot nav graph in the game repo - the solidity and
clearance grids, surface extraction, walk/fall/jump/drop-through edges, A*, the
chunked build and its disk cache.

The previous edition of this file was a record of bugs that had already been
**fixed** - the client bridge dying, held movement input, the
`AudioControl`/`CTFHUD` "winners" bug and the `fps:4` spiral, the stale lint
cache, `watched()` dialog spam, RDP diagnosis, and the spare scripts. All of
that is done and verified; read it at commit `efedf8b` if you need the history.
This file is deliberately the other thing: **what is still wrong, and what would
pay for itself next.**

Nothing here blocks work. Everything here cost real time in one session and will
cost it again.

---

## 1. The linter does not catch an identifier that is already taken

**Severity: high.** Hit twice in one session, in two different disguises. The
first cost about 25 minutes; the second would have too, without the diagnostic
in issue 2.

`var solid, x, y;` - the natural first line of any grid or geometry routine - is
a **compilation error** in GM8, because `solid`, `x` and `y` are built-in
instance variables. `gg2_lint` reports it clean, `gg2_eval` accepts it, and
`build-fast.js` / `build-agent.js` will happily splice it into an executable.

The failure mode is what makes it expensive. GM8 compiles every script at load,
so the error fires during startup, **before `AgentBridge`'s Create event runs**.
What you observe is:

- `run-agent.js` prints `bridge did not come up within 60s`;
- `agent_launcher_<port>.log` has only its two launch lines - no `E|`, because
  the launcher's dialog loop had not started polling yet;
- **no `agent_bridge_<port>.log` exists at all**, because `agentBridgeCreate`
  never ran to write one;
- the game process is alive, has a window titled `Gang Garrison 2`, and
  `Responding` is `True`.

Every signal says "the tooling is broken". Nothing says "your GML is broken".

**Fix:** teach `tools/gml-lint.js` the built-in *instance variable* list (it
already reads GM8's `fnames` for functions) and raise an error - not a style
warning - on any `var` declaration that shadows one. The evidence that this is a
hard rule and not taste: across all ~20,000 lines of GG2, **zero** `var`
declarations shadow `x`, `y` or `solid`. The only four that ever existed were
written this session, and each one stopped the game booting.

Names to reject at minimum: `x`, `y`, `xprevious`, `yprevious`, `xstart`,
`ystart`, `hspeed`, `vspeed`, `speed`, `direction`, `friction`, `gravity`,
`gravity_direction`, `solid`, `persistent`, `depth`, `visible`, `id`,
`object_index`, `sprite_index`, `mask_index`, `image_index`, `image_speed`,
`image_xscale`, `image_yscale`, `image_angle`, `image_alpha`, `image_blend`,
`alarm`, plus the `bbox_*` family.

### The same failure, second flavour: assigning to a resource name

Hit later in the same session, and it presents identically - game boots, window
opens, `Responding: True`, no bridge, no bridge log:

```gml
// there is a script called navNodeGrid
global.navNodeGrid = -1;   // COMPILATION ERROR
```

Script, object, sprite, room and constant names are read-only constants at
compile time, so this is not an assignment at all. The linter already knows
every one of those names - it builds `syms.scripts`, `syms.objects` and friends
in `loadProject` - so flagging an assignment whose target is in `syms.all` is
close to free, and catches the whole family at once.

Both flavours are worth erroring rather than warning: neither is a style
question, and both stop the entire game loading.

### What the linter already gets right - do not regress these

It correctly refused `ds_grid_sort`, `ds_exists` and `ds_type_grid` when they
were reached for out of GameMaker Studio habit. That is exactly the check
earning its keep: all three are Studio-only, all three would have compiled
nowhere, and all three were caught before a build was spent on them.

## 2. `run-agent.js` should read the error dialog when the bridge times out

**Severity: high.** This is what turns issue 1 - and every future startup GML
error - from a five-second answer into a hunt.

When the bridge fails to come up, `run-agent.js` already has one diagnosis path,
`isRemoteSession()` for RDP. Add a second one at the same choke point: **if the
game process has a `TErrorForm` window, read it and print it.**

Everything needed is already in `tools/win32.js`:

    const w = require('./tools/win32.js');
    const errs = w.windows({ pid }).filter((e) => e.cls === 'TErrorForm');
    for (const e of errs)
      for (const k of w.descendants(e.hwnd)) {
        const t = w.controlText(k.hwnd || k);
        if (t && t.trim()) console.log(t);
      }

`TErrorForm`'s text lives in a real `TMemo` that answers `WM_GETTEXT`, so unlike
`show_message` it **is** readable - already documented, just not wired into the
launch path. It names the failing script and line outright
(`COMPILATION ERROR in Script: test_navgraph` / `Error in code at line 14:`),
which is the entire answer.

One caveat for whoever implements it: the memo's text comes back with the
offending line's newlines flattened, so a long script reads as one wall of text.
The header lines above it carry the signal - consider printing only the first
few by default.

**This has now paid for itself twice, by hand.** Both times the bridge failed to
come up, running the snippet above against the live pid named the failing script
and line immediately - once for a `var` shadowing a built-in, once for an
assignment to a script name. Each took seconds to identify with it, against
roughly 25 minutes the first time without it. Wiring it into `run-agent.js` is
perhaps twenty lines and removes the single most misleading failure mode this
tooling has.

Note also that `w.windows()` returns `hwnd` as a BigInt, so `JSON.stringify` on
the result throws. Use `String(x.hwnd)` when logging.

## 3. Stale lint context in the long-lived MCP server - reproduced, not root-caused

**Severity: medium.** Reproduced this session **despite** the manifest-mtime fix
in `context()`.

After `build-agent.js` registered four new scripts, `gg2_test` refused the suite
with `"navClearanceBuild" is not a GM8 built-in, a project script, or a known
extension function` - once per call site, for every new name. Restarting the MCP
server cleared it completely, and the same suite then ran 21/21.

What is established:

- **Discovery is fine.** In a fresh process,
  `require('./tools/gml-lint.js').check('navClearanceBuild(0,1,1);', { trees: [gameTree] })`
  returns `ok=true` with no errors. The resource lists and `loadProject` are
  correct - `loadProject` has no cache of its own and re-reads every time.
- **So this is cache invalidation, not lookup.**
- `context()`'s key - `[trees, gm8Dir, manifestMtime(trees)]` - looks right on
  inspection, and `build-agent.js` does rewrite the manifest, so the key should
  have changed.

What is **not** established: why it did not. Do not assume the mtime fix is
simply missing - it is present and reads correctly. Candidates worth checking
before rewriting anything:

- `ctxCache` holds exactly **one** entry. If different tools pass different
  `trees` arrays (game tree alone vs. game tree plus payload), calls thrash the
  single slot; that is a performance bug on its own and may interact with the
  key.
- Whether the MCP server lints through a path that caches above `context()`.
- Whether `manifestMtime` returns the tree the caller actually meant, given it
  returns on the *first* tree that happens to have a manifest.

Worth a `tools/selftest.js` case that adds a script, rewrites the manifest, and
asserts the same in-process context then resolves the new name.

## 4. `gg2_test` has no `skip_lint`

**Severity: medium.** `gg2_eval`, `gg2_evalx` and `gg2_wait` all take
`skip_lint`. `gg2_test` does not, so when the linter is stale or wrong (issue 3)
there is **no way to run a suite at all** - the one tool whose whole job is to
tell you whether your code works becomes unavailable exactly when you most need
it.

The workaround used this session, worth knowing regardless. Have the game read
the suite off disk with `gg2_eval`:

    var f, s, ln;
    f = file_text_open_read("D:\code\Gang-Garrison-2\Source\gg2\Scripts\Unit tests\navgraph\test_navgraph.gml");
    s = "";
    while(!file_text_eof(f))
    {
        ln = file_text_read_string(f);
        file_text_readln(f);
        if(string_pos("test_unit_end", ln) == 0)
            s += ln + chr(13) + chr(10);
    }
    file_text_close(f);
    global.navTestSrc = s;

then `gg2_eval` with `skip_lint: true` on `execute_string(global.navTestSrc);`,
then read `global.testAssertionsSucceeded` and `global.testAssertions` with
`gg2_evalx`. That reproduces what `gg2_test` does, including stripping
`test_unit_end` so the counters survive to be read.

Backslashes need no escaping in GML string literals, so a Windows path pastes in
as-is.

## 5. Enhancement: let `gg2_test` load the suite from disk in-game

The workaround in issue 4 is arguably **better than the current mechanism**, not
merely a fallback. Having the game `file_text_open_read` the suite means no lint
gate, nothing crossing the wire, no payload ceiling and no escaping concerns -
and the tooling already knows the absolute path of every suite it discovers.

Worth considering as the primary path, keeping the send-the-source route for the
case where the game and the source tree are not on the same machine.

## 6. Enhancement: a timing helper for the nav build

Milestone 4 has to measure a cold nav-graph build on `cp_dirtbowl` (560k mask
cells) with a client connected, and GM8 has no profiler, no `get_timer` and no
`delta_time`. The documented methods are `fps` via `gg2_state` and `gg2_watch`
on `current_time`; both work but are fiddly to drive repeatedly.

A small `gg2_profile` - run an expression `repeat(N)` between two `current_time`
reads and report total, mean, and the frame-delta distribution - would remove a
lot of hand-rolling. `current_time` has 1-16ms Windows granularity, so
amortising over N is mandatory rather than optional.

Concretely, what went wrong without it: timing a chunked build from outside, by
setting a marker with `gg2_eval` and waiting on a condition, **races the state
machine**. It reported the build finishing in 22 frames for work that cannot take
fewer than about 161 ticks, because the wait condition was already true from the
*previous* build when it was first evaluated. The fix was to instrument inside
the game - record `current_time` at build start and again at completion, and read
the difference back afterwards. Any tool that times in-game work needs to do the
same; a stopwatch on this side of the wire measures the wrong thing.

## 7. Minor: `build-fast` refusals could name the culprit

`build-fast.js` correctly refuses when a non-code file changed, and says "a
sprite, room, object property, setting or included file differs from the template
build". Editing `Constants.xml` lands in "setting", which is accurate but not
obvious - adding a constant feels like editing code, and it is the most common
reason a fast rebuild turns into a full one during feature work.

Naming the file it actually noticed would turn a moment of confusion into none.
It already has the tree hash machinery to know.

## 8. Still open, unchanged from the previous edition

- **`gg2_input aim` hangs** (~10s, no effect) when the game window is not
  foreground. `AttachThreadInput` / `SetForegroundWindow` was tried and fails
  with access-denied / invalid-parameter in this environment. Not retried this
  session. If it is ever fixed it needs a different mechanism entirely - in-game
  input simulation the bridge drives directly, not another Win32 focus trick.
- **`EVALX` prepends `return `** to the whole string, so `gg2_evalx "a = 1; a"`
  never reaches the read. Write with `gg2_eval`, read with a separate
  `gg2_evalx`. This bit again this session; the tool description could say so
  inline.
- **Freezing stops the network**, so a frozen server drops its clients.
- **A frozen instance's own fields are unreadable** until
  `instance_activate_object(id)` or `gg2_resume`.
