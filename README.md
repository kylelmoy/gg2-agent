# gg2-agent

Private tooling that lets an AI agent drive a running copy of
[Gang Garrison 2](https://github.com/Gang-Garrison-2/Gang-Garrison-2) — a 2008
game built in Game Maker 8 — over MCP.

Nothing here lives in the public GG2 fork. The bridge is **injected** into a
clean checkout at build time and **removed** afterwards, so the fork stays
publishable and `build.bat` stays clean enough to send upstream as a PR.

## Why injection rather than a branch

The bridge exposes `execute_string` over a socket. That is remote code
execution by design: exactly what makes it useful for development, and exactly
what should never sit in a public game repo or reach a player's build. Keeping
it here means the public fork can never accidentally ship it.

It touches the split source tree in only three places, which is what makes
injection practical:

| File | Change |
|---|---|
| `Objects/_resources.list.xml` | one line registering the object |
| `Scripts/_resources.list.xml` | one line registering the script group |
| `Scripts/Game/game_init.gml` | one line creating the instance |

Everything else is new files. The object configures itself from the command
line in its own Create event, so `game_init.gml` needs a single line and
nothing more. Without `-agent` the instance stays dormant.

## Layout

```
payload/            what gets copied into Source/gg2/
  Objects/          AgentBridge object and its Create/Step/Destroy events
  Scripts/          the GML that implements the bridge
tools/
  gg2_agent.ahk     launcher; dismisses GM8 message boxes
  gg2-mcp-server.js the MCP server (JSON-RPC over stdio, no dependencies)
lib.ps1             shared file-editing helpers
inject.ps1          add the bridge to a checkout
cleanup.ps1         remove it again, and verify with git status
build-agent.ps1     inject -> build.bat -> cleanup
run-agent.ps1       launch the game and wait for the bridge
```

## Requirements

- Game Maker 8.0 **Pro** (the Lite edition can't build a project with extensions)
- A JRE, plus `gmksplit.exe` and `gm8x_fix.exe` in the GG2 `Source/` directory
- AutoHotkey v2
- Node 18+
- **A session with an audio device.** GM8 loads the game's sound resources into
  DirectSound during engine startup; with no audio endpoint it raises two modal
  errors and then terminates, before any game code runs. Over RDP that means
  either audio redirection while connected, `tscon <id> /dest:console` to hand
  the session to the physical console, or a virtual audio driver.

## Use

```powershell
.\build-agent.ps1          # inject, build, clean up  (~45s)
.\run-agent.ps1            # launch and wait for the bridge
```

Register the MCP server once, at user scope, so nothing lands in the GG2 repo:

```powershell
claude mcp add gg2 -s local -- node D:\Code\gg2-agent\tools\gg2-mcp-server.js
```

Then, from Claude Code:

| Tool | Purpose |
|---|---|
| `gg2_ping` | check the game is reachable |
| `gg2_eval` | run GML for its side effects |
| `gg2_evalx` | evaluate a GML expression and get its value |
| `gg2_state` | structured snapshot: room, fps, players, teams, classes |
| `gg2_log` | tail the bridge log |

While iterating on the bridge's own GML, `.\build-agent.ps1 -KeepInjected`
leaves it in the tree. Run `.\cleanup.ps1` before committing anything to the
fork.

## Wire protocol

`uint32` little-endian length, then that many bytes. Requests are
`VERB [argument]`; replies are `OK`, `OK <text>` or `ERR <text>`. The Node
server speaks MCP on one side and this on the other, so the GML never has to
parse JSON.

The listener binds all interfaces because that is what Faucet's `tcp_listen`
does, so the accept path checks `socket_remote_ip` and drops anything that
isn't loopback.

## Writing GML for this game

GM8-era GML, not modern GameMaker: no ternary, no `try`/`catch`, no structs,
1D and 2D arrays only, and `and`/`or` rather than `&&`/`||` — the symbol forms
break GmkSplitter. A syntax error inside `gg2_eval` raises a modal dialog that
blocks the game and every pending tool call, so keep evaluated statements
simple and check `gg2_log` when a call times out.
