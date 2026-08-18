# Working on Gang Garrison 2 with this tooling

Operating guide for an AI agent. Read this before touching either repo.

## The two repositories

| Repo | Contains | Rule |
|---|---|---|
| `gg2-agent` (this one, private) | all tooling: build scripts, the agent bridge payload, the MCP server, the launcher | tooling only |
| `Gang-Garrison-2` (public fork) | the game itself | **feature code only** — never commit tooling, build scripts, or the bridge here |

The bridge is **injected** into the game's source tree at build time and removed
again afterwards. If you find `AgentBridge` files or an `instance_create(0, 0,
AgentBridge);` line committed in the fork, that is a mistake — run `cleanup.ps1`.

## The loop

```powershell
.\build-agent.ps1     # inject, reassemble, compile, patch, clean up   (~50s)
.\run-agent.ps1       # launch the game, wait for the bridge
```

Then drive the running game with the MCP tools:

| Tool | Use it for |
|---|---|
| `gg2_ping` | confirm the game is reachable; try this first when anything fails |
| `gg2_evalx` | read live state — `room_speed`, `instance_number(Player)`, `global.currentMap` |
| `gg2_eval` | change live state, call scripts, create instances |
| `gg2_state` | structured snapshot: room, fps, host flag, players with team and class |
| `gg2_lint` | check GML compiles **before** writing it to a file or evaluating it |
| `gg2_log` | tail the bridge log when a call times out |

**Prefer `gg2_eval` over rebuilding.** A rebuild costs ~50 seconds; an eval costs
~40ms. Only rebuild when you have changed something the evaluator cannot reach:
new objects, sprites, rooms, or the bridge itself.

Editing the game's `.gml` does **not** affect the running game. Those files are
compiled into the executable. Test an idea with `gg2_eval` first, then write it
into the source and rebuild once.

## Writing GML for this game

This is Game Maker 8 (2008), not modern GameMaker. Your training data is mostly
GameMaker Studio, and that dialect will not compile here.

**Not available:** ternary `?:`, `try`/`catch`, structs, `var` block scoping,
arrays beyond 2D, `#region`, function literals, `static`, string escapes
(`"\n"` is a literal backslash-n; use `chr(10)`).

**Required by house style** (see the game's `Contributing.md`) — and the first
one is a compatibility rule, not taste:

- `and` / `or` / `not` rather than `&&` / `||` / `!`. This is style, not a hard
  rule: `Contributing.md` says the symbol forms break GmkSplitter, but the game's
  own code uses `&&` and compiles and round-trips fine. Match the surrounding code.
- Semicolons always. Parentheses around every conditional.
- Braces on their own line, four-space indent.
- `lowerCamelCase` variables, `UpperCamelCase` objects, `lowercaseCamel` scripts,
  `ALL_CAPS` constants.

**Reserved-word hazard:** GM8 accepts identifiers that later GameMaker versions
reserved. The project has already had to fix uses of `new`. Avoid `new`, `delete`,
`function`, `static`, `constructor` as identifiers.

## Editing object events

Script files under `Scripts/` are plain `.gml`. Object event code is different:
it lives inside XML, in a `<argument kind="STRING">` element, and it is
**XML-escaped**:

```xml
<argument kind="STRING">if (dist &lt; closestDist or closestDist == -1)</argument>
```

Writing a bare `<`, `>` or `&` into one of those files produces invalid XML and
GmkSplitter will refuse the whole tree. Escape them, or keep the logic in a
script and call it from the event.

## Error handling has no safety net

GM8 has no exceptions. A GML error raises a **modal dialog** that freezes the
game and every pending MCP call. If a tool call times out, that is almost
certainly what happened — check `gg2_log`, then look at the game window.

`gg2_eval` guards against this: it lints your code against the installed Game
Maker 8 first and refuses anything that would not compile, so the freeze mostly
cannot happen any more. The linter is authoritative rather than heuristic - it
reads GM8's own `fnames` table for built-in names and signatures, plus this
project's scripts and extension functions - and it reports nothing on the game's
existing ~20,000 lines.

Run `gg2_lint` yourself before writing GML into a source file: a rebuild costs
~50s, and the linter costs nothing. If it flags a function that really does
exist, it came from a `.gex` - add it to `tools/gml-extensions.txt`.

Still prefer several small evals over one large one, so a failure tells you
exactly what broke.

## Things that will waste your time if you do not know them

- **An audio device is required.** GM8 loads the game's sound resources into
  DirectSound during engine startup, before any game code runs. With no audio
  endpoint it shows two modal errors and terminates. Over RDP that means audio
  redirection, or `tscon <id> /dest:console`. No code change can avoid this.
- **The build needs an interactive desktop.** Compiling drives the Game Maker
  IDE's window. Message-based automation works in a disconnected RDP session,
  but a locked or absent session does not.
- **Only one bridge client at a time.** The game accepts a single connection;
  a second one waits.
- **The listener binds all interfaces**, because that is what Faucet's
  `tcp_listen` does. The accept path drops anything that is not loopback. Do not
  remove that check — the bridge runs arbitrary GML.
- **Never let the bridge reach a release build.** It is remote code execution by
  design. That is the entire reason it lives in this repo and is injected.

## Useful entry points in the game

| Where | What |
|---|---|
| `Scripts/Game/game_init.gml` | startup; reads `gg2.ini`, parses command-line flags |
| `Scripts/GameServer/` | server side: accepting players, per-frame service |
| `Scripts/Client/ClientBeginStep.gml` | client side: the main network receive loop |
| `Scripts/Input/input*.gml` | player actions as callable scripts — no key simulation needed |
| `Scripts/ggon/` | GGON, the game's JSON-equivalent encoder |
| `Scripts/Unit tests/` | assertion helpers (`test_assert_equals`, …) |
| `Documentation/GGON.md` | the GGON format |

Command-line flags the game already understands: `-dedicated`, `-server <ip>`,
`-port <n>`, `-map <name>`, `-restart`, plus `-agent` and `-agentport <n>` added
by the bridge.
