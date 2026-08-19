# Handoff: agent capability tooling

Branch: `agent-tooling`. Written 2026-08-18, mid-way through implementing eight
proposals for making an AI agent more capable in this codebase. Roughly half is
built; this says what is done, what is not, and everything learned along the way
that is not obvious from the code.

Read [`CLAUDE.md`](CLAUDE.md) first for how the repo works. This document only
covers the work in flight.

## Nothing here has been run against a live game

The bridge GML lints clean against the installed Game Maker 8, and every
built-in it calls was checked against GM8's own `fnames` table. The Node modules
have been unit-tested. But **no part of the new bridge has executed inside the
game**, because the new scripts and objects change the resource set, and that
needs a full IDE build first:

```powershell
node build-agent.js      # bootstraps a new template; needs a person at the desktop
```

Until that runs, `build-fast.js` will refuse — correctly — with "code was
removed since the template was built" or a tree-hash mismatch. Do that before
trusting anything below.

## Do this first: three loose ends from the rename

The bridge log is now per-port (`agent_bridge_17777.log`, from
`agentBridgeCreate.gml`), so two games in one directory cannot interleave their
output. Two callers still look for the old name and will silently find nothing:

- `tools/gg2-mcp-server.js` — `BRIDGE_LOG` / `LAUNCHER_LOG` constants near the
  top. They should come from `tools/instances.js` (`bridgeLog(dir, port)`,
  `launcherLog(dir, port)`) once instance routing lands.
- `run-agent.js` — the failure path prints the tails of `agent_launcher.log`
  and `agent_bridge.log` by name.

`tools/launcher.js` still writes `agent_launcher.log` unconditioned by port; it
is changed as part of the session work below.

## What is built

| Piece | State |
|---|---|
| README rewrite | done |
| Bridge: `SHOT`, `STEP`, `FREEZE`, `RESUME`, `INPUT`, `WAIT`, `WATCH` | written, lints clean, never run |
| Deferred replies (a request that spans frames) | written, never run |
| `AgentSpare0..3` objects | written, needs a full build to exist |
| `tools/payload.js`, generalised inject/cleanup | done, round-tripped through inject → lint → cleanup |
| `tools/image.js` (BMP → PNG) | done, validated against System.Drawing |
| `tools/gmlerror.js` (GM8 dialog → `file:line`) | done, validated against the real tree |
| `tools/instances.js` (instance registry) | done, unit-tested |

### How the new bridge verbs fit together

Everything hangs off two ideas.

**Deferred replies.** `STEP` and `WAIT` cannot answer in the frame they arrive.
`agentBridgeDispatch` returns `""` for those, having set `deferKind` on the
instance; `agentBridgeStep` treats `""` as "do not send, and read nothing more";
`agentBridgeDefer` runs once per frame until the frames are up or the condition
is true, and sends the reply itself. Nothing further is read while one is
outstanding, so replies stay in order. A client that disconnects mid-request
clears `deferKind` and unfreezes, so the next client does not inherit a game
that never advances.

**Freezing by deactivation.** `FREEZE` calls `instance_deactivate_all(true)` —
everything except the bridge, which keeps answering while nothing else moves.
The catch is that a deactivated instance is not drawn, so a screenshot taken
while frozen would show an almost empty room. `agentBridgeShot` handles this:
reactivate, `screen_redraw()`, save, deactivate again. A redraw runs no step
events, so the game does not advance. That is the whole trick, and it is worth
not breaking.

Known consequence: freezing stops the objects that service the network, so a
connected client or a hosting server will fall behind and may drop. Fine for
single-player inspection, needs care in a session.

## What is left

### 1. Launcher, per instance

`tools/launcher.js` needs:

- **Per-port logs.** Derive the port from its own `-agentport` argument and
  write `agent_launcher_<port>.log` (`instances.launcherLog`).
- **Registry entries.** `instances.register(dir, {name, port, pid, role, args})`
  on start, `instances.unregister(dir, port)` when the game exits. Add a
  `--name <label>` argument for the caller to pass a name.
- **Capture message-box text, not just errors.** The unit-test helpers in the
  game report through `show_message`, so the test runner below reads its results
  out of dialogs the launcher dismissed. Read the text of every child control
  that is not a button, and prefix it by dialog kind:
  - `E| ` for `TErrorForm` (a GML error)
  - `M| ` for `TMessageForm` and `#32770` (a `show_message`)

  `gameErrorsSince()` in the MCP server currently filters on `' | '` and must
  move to `' E| '`, or every test result will be reported as a crash.

`run-agent.js` gains `--name` and passes it through, and stops hardcoding log
file names.

### 2. `tools/session.js` — a server and its clients

`gg2_session start` should:

1. Set `UseLobby=0` in the build directory's `gg2.ini` **before** starting
   anything. It defaults to `1`, and a dedicated server announces itself to the
   public lobby. Do not skip this.
2. Start the server: `-dedicated -map <name> -agent -agentport 17777`,
   named `server`.
3. Start each client: `-server 127.0.0.1 -port 8190 -agent -agentport 1777N`,
   named `client1`, `client2`, …

Facts that matter here:

- The game's hosting port comes from `gg2.ini` (`HostingPort=8190`) and has **no
  command-line flag**. Clients need `-server` *and* `-port` together — the
  parser in `game_init.gml` counts both and ignores either alone.
- `MultiClientLimit=3` in `gg2.ini` caps connections from one address. Default
  to at most 3 clients, or raise the setting deliberately.
- `lib.stopProcess(GAME_IMAGE)` kills *every* instance by image name. Correct
  for `build-fast.js`, wrong for stopping one member of a session — stop those
  by pid from the registry.
- Both instances share one working directory and one `gg2.ini`. Logs are now
  separated by port; settings are not.

### 3. MCP server: the new tools

Add to `TOOLS` and `callTool` in `tools/gg2-mcp-server.js`:

| Tool | Wire | Notes |
|---|---|---|
| `gg2_screenshot` | `SHOT <path>` | write to a temp file, read it, `image.toPng()`, return an MCP `image` content block (`{type:'image', data: base64, mimeType:'image/png'}`). GM8 writes a BMP on some builds and a PNG on others; `image.js` takes either. |
| `gg2_step` | `FREEZE` then `STEP <n>` | freeze if not already, advance exactly n, stay frozen |
| `gg2_resume` | `RESUME` | |
| `gg2_input` | `INPUT <cmds>` | `press`/`release`/`clear`/`aim x y`/`click 0\|1`, joined by `;`. Takes action names (`jump`, `attack`) resolved through the game's bindings by `agentBridgeKey`. |
| `gg2_wait` | `WAIT <frames> <expr>` | lint the expression first; a bad one raises a dialog every frame until the budget runs out |
| `gg2_watch` | `WATCH add\|clear\|list` | changes land in the bridge log, so `gg2_log` is how you read a trace |
| `gg2_sprite` | `EVAL sprite_replace(...)` | no new verb needed; `sprite_replace` and `sprite_add` load from disk at runtime, so sprite art can be iterated without the IDE |

Also:

- **Instance routing.** Every live tool gets an optional `instance` (name or
  port). Keep one bridge connection per port rather than the single module-level
  `sock`, and resolve with `instances.resolve(BUILD_DIR, args.instance)`.
- **`request()` needs a timeout override.** `CALL_TIMEOUT_MS` is 10s; a test run
  that pops forty dialogs at 250ms of launcher polling each will exceed it.
- **Annotate errors.** Run every captured `E| ` block through
  `gmlerror.describe(text, tree)` so a failed call reports
  `Scripts/Foo/bar.gml:49: Unknown variable x` instead of raw dialog text.
  Same for `gg2_log`.

### 4. `tools/events.js` — `gg2_event` and `gg2_find`

Object event code lives in XML, XML-escaped, which is both a footgun (a bare
`<` or `&` invalidates the tree and GmkSplitter rejects all of it) and the
reason `grep` misses half the game's logic.

- `gg2_event` with `list` / `read` / `write`, taking an object name, an event
  name and an action index. Read returns unescaped GML; write escapes it,
  preserves the rest of the file byte for byte (`lib.readText`/`writeText`,
  latin1), and lints first.
- `gg2_find`: regex across `Scripts/**/*.gml` *and* the unescaped text of every
  event, reporting `file:line`.

`gamedata.js` already has the pieces to copy: `collectCode` for the keying
scheme (`Objects/…/Step.xml#0`), and `gmlerror.stringArguments` returns each
STRING argument's offset and starting line, which is what maps an action-relative
line to a file line. `gml-lint.js` exports `lintEventXml`.

Resolve object names against the payload directory as well as the game tree, so
`AgentSpare0` is editable the same way.

### 5. `gg2_test`

The game has assertion helpers in `Scripts/Unit tests/` and a real suite in
`Scripts/Unit tests/ggon/test_ggon.gml`, but no entry point an agent can reach,
so nothing is checked after a rebuild.

The helpers report through `show_message`, and **the game's code must not be
changed to accommodate the agent**. So: mark the launcher log, `EVAL` the suite,
let the launcher dismiss and record each dialog, then read the `M| ` lines back.
`test_unit_end` prints `Unit test PASSED, 45/45 assertions succeeded`, and each
failure prints `Assertion N failed: …` — enough to report properly.

Discover suites as `Scripts/Unit tests/**/test_*.gml` that call
`test_unit_begin`, excluding the `test_assert_*` and `test_unit_*` helpers.

### 6. Documentation

`CLAUDE.md` is the operating guide and still describes seven tools. It needs the
new ones, the freeze/step model, the `AgentSpare` objects, and a note that
freezing stops the network. The README needs the same tool list.

## Things learned that are easy to lose

- **Every built-in the new code needs exists in GM8.** Checked against
  `D:\GameDev\Game_Maker_8\fnames`: `screen_save`, `screen_save_part`,
  `screen_redraw`, `keyboard_key_press`, `keyboard_key_release`, `io_clear`,
  `window_views_mouse_set`, `instance_deactivate_all`, `instance_activate_all`,
  `sprite_add`, `sprite_replace`. To check another:
  `require('./tools/gml-lint.js').loadFnames('D:/GameDev/Game_Maker_8')`.
- **Two runtime assumptions are unverified.** That `keyboard_key_press` makes
  `keyboard_check` true until released — which is what `PlayerControl` reads —
  and that `mouse_button` is assignable. If the second one turns out to be
  read-only, drop `click` from `INPUT`: `PlayerControl` also maps the bound
  `attack` key to the same fire bit, so `press attack` covers it.
- **The splicer cannot place an empty string.** A blank event would appear
  thousands of times in the blob and the splice would be ambiguous, which is why
  each `AgentSpare` event holds a distinct placeholder comment. Do not "tidy"
  those to empty.
- **`gmlerror` falls back to the quoted source line**, and that is usually what
  actually resolves a real error, because GM8 names the object but not the file.
  An agent's own `EVALX` typo correctly resolves to nothing — the string was
  never in the tree — and reports `object AgentBridge` instead of inventing a
  location.
- **The game's own `Contributing.md` forbids `&&`/`||`, but its code uses them.**
  Match the surrounding file. The linter warns and does not fail.
