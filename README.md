# gg2-agent

Private tooling for developing
[Gang Garrison 2](https://github.com/Gang-Garrison-2/Gang-Garrison-2) — a 2008
game built in Game Maker 8 — with an AI agent.

Three things live here: a ~3s code-only rebuild that skips the 2008 toolchain
entirely, a bridge that lets an agent drive the running game over MCP, and the
scaffolding around the one build step that still needs a person.

**All tooling lives in this repo. The public fork holds only game code.** The
bridge is injected into the game's source tree at build time and removed
afterwards, so the fork can never accidentally ship it, and nothing about this
workflow appears in its history.

> Agents: read [`CLAUDE.md`](CLAUDE.md) instead — it is the operating guide.

## Why it works this way

The bridge exposes `execute_string` over a socket. That is remote code execution
by design: exactly what makes it useful during development, and exactly what
must never reach a player's build.

Injection is practical because the bridge touches the game's tree in only three
places, one line each:

| File | Change |
|---|---|
| `Objects/_resources.list.xml` | register the object |
| `Scripts/_resources.list.xml` | register the script group |
| `Scripts/Game/game_init.gml` | `instance_create(0, 0, AgentBridge);` |

Everything else is new files. The object configures itself from the command line
in its own Create event, so the game's startup needs one line and nothing more.
Without `-agent`, the instance stays dormant.

## Layout

```
build-agent.js      inject -> reassemble -> build in the IDE -> patch -> clean up
build-fast.js       splice changed code straight into the last build (~3s)
run-agent.js        launch the game and wait for the bridge
package.js          assemble a release-shaped build.zip
inject.js           add the bridge to a checkout
cleanup.js          remove it, and verify with git status

payload/            copied verbatim into Source/gg2/
  Objects/          AgentBridge object and its Create/Step/Destroy events
  Scripts/          the GML implementing the bridge
tools/
  launcher.js       runs the game; clears the modal dialogs that freeze it
  win32.js          the slice of user32 the launcher needs, via koffi
  gg2-mcp-server.js the MCP server (JSON-RPC over stdio)
  gamedata.js       reads and rewrites the gamedata inside a built exe
  gml-lint.js       checks GML against the installed Game Maker 8
  lib.js            shared helpers (file edits, tool discovery, processes)
```

## Requirements

- Game Maker 8.0 **Pro** — the Lite edition cannot build a project with extensions
- A JRE, plus `gmksplit.exe` and `gm8x_fix.exe` (in `tools/` or the game's `Source/`)
- Node 18+, then `npm install` (one dependency: koffi, which ships prebuilt — no
  compiler needed)
- **A session with an audio device.** GM8 loads sound resources into DirectSound
  during engine startup; with no endpoint it raises two modal errors and
  terminates before any game code runs. Over RDP: audio redirection while
  connected, `tscon <id> /dest:console`, or a virtual audio driver.

## Use

```powershell
node build-fast.js --launch    # ~3s: code changes only, then relaunch
node run-agent.js              # launch and wait for the bridge
node build-agent.js            # full build; stops for you to use the GM8 IDE
node build-agent.js --package  # ...and produce build.zip
```

Each script takes `--repo <path>` to point at a checkout elsewhere, and `--help`.
They are plain modules as well as CLIs, which is how the MCP server's
`gg2_rebuild` builds in-process instead of spawning a shell.

Register the MCP server once, at user scope, so nothing lands in the game repo:

```powershell
claude mcp add gg2 -s local -- node D:\Code\gg2-agent\tools\gg2-mcp-server.js
```

Tools: `gg2_ping`, `gg2_eval`, `gg2_evalx`, `gg2_state`, `gg2_lint`,
`gg2_rebuild`, `gg2_log`.

While iterating on the bridge's own GML, `--keep-injected` leaves it in the tree;
run `node cleanup.js` before committing to the fork.

## How the build works

Game Maker 8 has no command-line compile — the IDE is the only way to produce an
executable, and upstream's `build.bat` stops at a manual *File > Create
Executable*. `build-agent.js` does everything either side of that step: it
injects the bridge, reassembles the tree, opens the `.gmk` for you, waits for the
executable to appear and settle, then patches it, records the fast-rebuild
template, and removes the bridge again. Cleanup runs from a `finally` block, so
an interrupted build still leaves a clean checkout.

That manual step is only needed to bootstrap a template or after adding,
removing or renaming a resource. Everything else goes through `build-fast.js`.

It used to be automated, by posting `WM_COMMAND` 19 to the IDE's main window —
that lives in the **gm8-build-automation** repo now, and is worth reaching for
if unattended GM8 builds ever matter again.

## The launcher

`tools/launcher.js` starts the game and stays resident, because GM8 answers two
ordinary situations with a modal dialog — no audio device, and any GML runtime
error — and a modal dialog freezes the game along with every pending MCP call.
Nothing inside the game can clear its own modal.

It watches for `TErrorForm`, `TMessageForm` and `#32770` belonging to the game's
process. `TErrorForm` is the one that matters: it offers **Abort** next to
**Ignore**, so the button is chosen by name rather than by position, and the
error text is read out of the dialog's memo and written to `agent_launcher.log`
before it is dismissed. That log is usually the only explanation you will get
for a call that suddenly started timing out.

Everything is posted rather than sent, since `SendMessage` blocks until the
target answers and these windows are by definition the ones that have stopped.

## How the fast rebuild works

Game Maker 8 never compiles GML. A built executable is the runner stub with the
project appended at offset 2,000,000: zlib blobs behind a swap-table cipher,
holding every script and event as **source text**. Nothing in that stream stores
an absolute offset into it, so a piece of code can be swapped for a longer or
shorter one and the rest simply shifts.

`build-fast.js` takes the last executable the IDE produced - kept in
`Source/build/template` alongside a manifest of the code it contains - decrypts
the stream, replaces each changed script and event, and re-encrypts. Everything
it does not recognise, which is most of the file, is copied through byte for
byte. Bytes 0 to 2,000,000 are untouched, so the icon and `gm8x_fix`'s patches
survive without rerunning anything.

It is deliberately narrow. A hash of every non-code file in the tree, taken when
the template was built, means a new sprite, room, object property or setting is
an error telling you to run `build-agent.js` - never a silently stale build.
Changed GML is linted first, because a syntax error in a built exe is a modal
dialog that hangs the game.

`node tools/gamedata.js selftest "<exe>"` unpacks and repacks an executable and
asserts the result is byte-identical.

## Wire protocol

`uint32` little-endian length, then that many bytes. Requests are
`VERB [argument]`; replies are `OK`, `OK <text>` or `ERR <text>`. The Node server
speaks MCP on one side and this on the other, so the GML never parses JSON.