# gg2-agent

Private tooling for developing
[Gang Garrison 2](https://github.com/Gang-Garrison-2/Gang-Garrison-2) — a 2008
game built in Game Maker 8 — with an AI agent.

Two things live here: an automated build for a toolchain that has no
command-line compiler, and a bridge that lets an agent drive the running game
over MCP.

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
build-agent.ps1     inject -> reassemble -> compile -> patch -> clean up
run-agent.ps1       launch the game and wait for the bridge
package.ps1         assemble a release-shaped build.zip
inject.ps1          add the bridge to a checkout
cleanup.ps1         remove it, and verify with git status
lib.ps1             shared helpers (file edits, tool discovery, native calls)

payload/            copied verbatim into Source/gg2/
  Objects/          AgentBridge object and its Create/Step/Destroy events
  Scripts/          the GML implementing the bridge
tools/
  gm8_build.ahk     drives the Game Maker 8 IDE to compile a .gmk
  gg2_agent.ahk     launcher; dismisses GM8 message boxes
  gg2-mcp-server.js the MCP server (JSON-RPC over stdio, no dependencies)
upstream-patches/   changes worth offering to the upstream project
```

## Requirements

- Game Maker 8.0 **Pro** — the Lite edition cannot build a project with extensions
- A JRE, plus `gmksplit.exe` and `gm8x_fix.exe` (in `tools/` or the game's `Source/`)
- AutoHotkey v2
- Node 18+
- **A session with an audio device.** GM8 loads sound resources into DirectSound
  during engine startup; with no endpoint it raises two modal errors and
  terminates before any game code runs. Over RDP: audio redirection while
  connected, `tscon <id> /dest:console`, or a virtual audio driver.

## Use

```powershell
.\build-agent.ps1            # ~50s: 5s reassemble, ~35s Game Maker, rest patching
.\run-agent.ps1              # launch and wait for the bridge
.\build-agent.ps1 -Package   # also produce build.zip
```

Register the MCP server once, at user scope, so nothing lands in the game repo:

```powershell
claude mcp add gg2 -s local -- node D:\Code\gg2-agent\tools\gg2-mcp-server.js
```

Tools: `gg2_ping`, `gg2_eval`, `gg2_evalx`, `gg2_state`, `gg2_log`.

While iterating on the bridge's own GML, `-KeepInjected` leaves it in the tree;
run `.\cleanup.ps1` before committing to the fork.

## How the build works

Game Maker 8 has no command-line compile — the IDE is the only way to produce an
executable, and upstream's `build.bat` stops at a manual *File > Create
Executable*. `gm8_build.ahk` closes that gap without simulating keystrokes: GM8
is a Delphi app that owner-draws its menus, so `GetMenuString` returns nothing,
but `GetMenuItemInfo` still exposes the command IDs. Posting `WM_COMMAND` 19 to
the main window invokes Create Executable directly, and the script asserts the
resulting dialog is titled *"File name for stand alone game"* before continuing.

`build-agent.ps1` runs the pipeline itself rather than calling `build.bat`, so
the fork's copy stays exactly as upstream wrote it. Cleanup runs from a `finally`
block, so an interrupted build still leaves a clean checkout.

## Wire protocol

`uint32` little-endian length, then that many bytes. Requests are
`VERB [argument]`; replies are `OK`, `OK <text>` or `ERR <text>`. The Node server
speaks MCP on one side and this on the other, so the GML never parses JSON.

## upstream-patches/

`0001-automate-gm8-build-step.patch` adds `gm8_build.ahk` to the game repo and
replaces `build.bat`'s manual step with a call to it, falling back to the manual
flow when AutoHotkey is absent. It is a genuine improvement to the project and
is kept here ready to send. Before offering it, replace the hardcoded `GM8_EXE`
default with auto-detection.
