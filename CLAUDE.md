# Working on Gang Garrison 2 with this tooling

Operating guide for an AI agent. Read this before touching either repo.

## The two repositories

| Repo | Contains | Rule |
|---|---|---|
| `gg2-agent` (this one, private) | all tooling: build scripts, the agent bridge payload, the MCP server, the launcher | tooling only |
| `Gang-Garrison-2` (public fork) | the game itself | **feature code only** — never commit tooling, build scripts, or the bridge here |

The bridge is **injected** into the game's source tree at build time and removed
again afterwards. If you find `AgentBridge` files, an `instance_create(0, 0,
AgentBridge);` line, or an `AgentBridge.heldMask` reference inside
`PlayerControl` committed in the fork, that is a mistake — run `cleanup.js`.

## The loop

```powershell
node build-fast.js      # splice code changes into the last build         (~3s)
node run-agent.js       # launch the game, wait for the bridge
node build-agent.js     # full build - drives the GM8 IDE itself         (~1min)
node tools/selftest.js  # check the tooling itself, against a fake game   (~3s)
```

`build-agent.js` used to be the one step that needed a person: Game Maker 8 has
no command-line compile. It no longer does in the common case - `tools/gm8ide.js`
drives the IDE itself with posted window messages (*File > Create Executable*,
the save dialog, the confirmations either side of it), which needs an
interactive desktop session but not a person at it. It only falls back to
opening the project and waiting for someone if Game Maker 8 cannot be found, or
driving it fails partway through - `--manual` forces that fallback. Either way
it is much slower than `build-fast.js` and only needed to bootstrap the
fast-rebuild template or after adding/removing/renaming a resource.

Every script takes `--repo <path>` and `--help`, and each is a module as well as
a CLI - which is how `gg2_rebuild` builds in-process rather than shelling out.

Then drive the running game with the MCP tools:

| Tool | Use it for |
|---|---|
| `gg2_ping` | confirm the game is reachable; try this first when anything fails |
| `gg2_evalx` | read live state — `room_speed`, `instance_number(Player)`, `global.currentMap` |
| `gg2_eval` | change live state, call scripts, create instances |
| `gg2_state` | structured snapshot: room, fps, host flag, players with team and class |
| `gg2_screenshot` | look at the game; works while it is frozen |
| `gg2_step` | freeze, then advance an exact number of frames |
| `gg2_resume` | let a frozen game run again |
| `gg2_input` | press, release and click; `aim` is currently broken, see below |
| `gg2_wait` | run until a GML expression is true, or give up after N frames |
| `gg2_watch` | sample expressions every frame; changes land in the bridge log |
| `gg2_sprite` | replace a sprite from a PNG at runtime, without a rebuild |
| `gg2_lint` | check GML compiles **before** writing it to a file or evaluating it |
| `gg2_event` | read and write the GML inside object events, escaping handled |
| `gg2_find` | search scripts *and* event code together — grep cannot see events |
| `gg2_test` | run the game's own unit tests and read the results back |
| `gg2_session` | start, stop and list games: a dedicated server and its clients |
| `gg2_rebuild` | apply edited `.gml` and event code to the game, then relaunch (~3s) |
| `gg2_log` | read the game's logs, including GML errors the launcher dismissed |

### Seeing what happens, rather than guessing

The game runs at 30 frames a second and an MCP call takes ~40ms, so polling
`gg2_evalx` samples whenever you get round to asking. Three tools exist to close
that gap, and between them they cover almost every "why did it do that":

- **`gg2_step`** freezes the world and advances it by an exact number of frames.
  Freezing works by deactivating every instance except the bridge, so nothing
  moves while you inspect it. `gg2_screenshot` reactivates, redraws and freezes
  again, which runs no step events — a frozen screenshot shows the real frame.
- **`gg2_wait`** tests a condition inside the game once a frame, so a state that
  lasts two frames is not missed.
- **`gg2_watch`** samples up to eight expressions every frame and writes changes
  to the bridge log; `gg2_log` is how you read the trace back.

`press left|right|up|jump|down|taunt` actually holds - the bridge ORs a mask
into `PlayerControl`'s own `keybyte` every step - so `gg2_input` plus
`gg2_step` is "hold right for twelve frames" exactly, for those six. Every
other action (`attack`, `special`, arbitrary keys) still goes through
`keyboard_key_press`, which does not make `keyboard_check` true on this build -
only the `_pressed`/`_released` edge, which is enough for one-shot actions
(`drop`, `medic`, `changeteam`, ...) but not for holding down fire. For that,
call the game's own `Scripts/Input/input*.gml` directly with `gg2_eval`.

**Freezing stops the objects that service the network.** A connected client or a
hosting server falls behind while frozen and may drop. Freely on a single game;
carefully inside a session.

### More than one game at once

Nothing about the network protocol is observable from inside one process, so
`gg2_session start` brings up a dedicated server and its clients, each named
(`server`, `client1`, …) and separately addressable through the `instance`
argument that every live tool takes. Leave `instance` out while only one game is
running. `tools/instances.js` is the register the launcher writes and everything
else reads; a dead entry is pruned on the next read.

Things that bite here: the hosting port lives in `gg2.ini` (`HostingPort=8190`)
and has no command-line flag, so clients need `-server` *and* `-port` together;
`MultiClientLimit=3` caps connections from one address, and every local client
is the same address; and `UseLobby` must be 0 or a dedicated server announces
itself to the public lobby. `gg2_session` handles all three. Both games share one
`gg2.ini` and one working directory — only the logs are separated, by port.

### The spare objects, and the spare scripts

`AgentSpare0..3` are blank objects built into the executable. `build-fast.js` can
only replace code that already exists in the template, so a genuinely new object
costs a full IDE build; a spare costs a ~3s splice. Write to one with
`gg2_event`, `gg2_rebuild`, then `instance_create(x, y, AgentSpare0)`. Their
events hold placeholder comments rather than nothing, because the splicer cannot
place an empty string — do not tidy them to empty.

`agentScriptSpare0..5` are the same idea for standalone scripts, since
`gg2_rebuild` refuses a brand new script name exactly like it refuses a brand
new object. Each is a real registered resource already, with a placeholder
comment as its body (payload/Scripts/AgentBridge/agentScriptSpareN.gml) — edit
the file directly (there is no `gg2_event`-equivalent for a plain script; it is
just a `.gml` file) and `gg2_rebuild`/`build-fast.js` splices it in ~3s, the
same as any other script edit. Once behaviour proven in a spare is worth
keeping, giving it its real name still needs one full `build-agent.js` build —
the spares buy iteration speed while a script is being written, not a way to
skip ever renaming it.

Editing the game's `.gml` does **not** affect the running game: the code lives
inside the executable. Three ways to close that gap, cheapest first:

| Cost | Use | For |
|---|---|---|
| ~40ms | `gg2_eval` | trying an idea out against live state |
| ~3s | `gg2_rebuild` / `build-fast.js` | code you have written into the tree |
| ~1min | `build-agent.js` | new objects, sprites, rooms, settings, or the bridge |

So: experiment with `gg2_eval`, write the result into the source, and
`gg2_rebuild`. Reach for the full build only when the fast one refuses.

## Why the fast rebuild works, and when it refuses

Game Maker 8 does not compile GML. "Create Executable" copies the runner stub,
appends the project as zlib blobs behind a swap-table cipher, and stores every
script and event as **source text**. Nothing in that stream holds an absolute
offset, so a piece of code can be replaced in place and everything after it
just shifts.

`build-fast.js` does exactly that: it takes the last executable the IDE built
(kept in `Source/build/template` with a manifest of the code inside it), splices
in every script and event that has changed, and re-encrypts. Anything it does
not recognise is copied through byte for byte.

It refuses, rather than guessing, when:

- a non-code file changed - sprite, room, object property, setting, included
  file - which it detects with a hash of the tree taken when the template built;
- a script or event was added or removed;
- the changed code is not the code the manifest recorded, meaning the template
  is stale;
- the same code string appears twice in one asset, so the splice is ambiguous;
- the GML does not lint, since bad code in a built exe is a modal dialog with no
  way back.

Every one of those says to run `build-agent.js`. It will not hand you a stale
executable.

`node tools/gamedata.js selftest "<exe>"` proves the unpack/repack round-trip is
byte-identical; run it if you suspect the splicer.

## Writing GML for this game

This is Game Maker 8 (2008), not modern GameMaker. Your training data is mostly
GameMaker Studio, and that dialect will not compile here.

`GML.md` at the repo root is a running list of GM8/GG2-engine gotchas that cost
real debugging time — things that lint clean but do the wrong thing at runtime
(`Obstacle.solid` only being true inside its own step, `ds_grid_read` being a
procedure, `var` shadowing a built-in silently killing startup, and more). Read
it before writing GML here; it covers ground `gg2_lint` cannot.

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
GmkSplitter will refuse the whole tree.

Use **`gg2_event`** rather than editing the XML by hand: `list` shows an object's
events, `read` hands back real GML, and `write` escapes it, lints it and leaves
every other byte of the file exactly as it was. It resolves objects against the
bridge payload too, so `AgentSpare0` is editable like anything else — and an edit
to a payload object lands in `payload/`, where it survives `cleanup.js`.

The same escaping is why `grep` misses a large part of the game's logic. Use
**`gg2_find`**, which searches the scripts and the unescaped text of every event
together and reports `file:line`.

## Testing a change

`gg2_test` runs the game's own suites — `Scripts/Unit tests/**` — inside the
running game and reports how many assertions passed. The game's code is not
modified to accommodate it, and must not be.

Getting an answer out takes one trick, because the obvious route is closed.
**GM8's message box cannot be read.** Its form holds exactly one windowed
control, the OK button; the text is drawn straight onto the form, so no Win32
call will produce it — the launcher can count the boxes and nothing more. The
assertion *counters* behind those messages are readable, though:
`test_unit_begin` zeroes them, every assertion moves them, and `test_unit_end`
is the only thing that resets them — after it has shown its message. So the tool
evaluates the suite's own source with its `test_unit_end()` call removed, then
reads `global.testAssertions` and `global.testAssertionsSucceeded` directly.
Same code, minus the one line whose only job is to report and forget.

A failed assertion still shows a box; the launcher dismisses it, so a failing
suite does not hang the game, and the count of boxes says how many failed even
though their text does not survive.

`node tools/selftest.js` is the other half: it exercises this repo's own Node
modules against a fake bridge and a scratch copy of the tree, in about three
seconds and with no Game Maker anywhere. Run it after changing anything under
`tools/`.

## Error handling has no safety net

GM8 has no exceptions. A GML error raises a **modal dialog** that freezes the
game and every pending MCP call. If a tool call times out, that is almost
certainly what happened — check `gg2_log`, then look at the game window.

`gg2_eval` guards against this: it lints your code against the installed Game
Maker 8 first and refuses anything that would not compile, so the freeze mostly
cannot happen any more. What the linter cannot catch - a variable that does not
exist at runtime, say - raises the dialog anyway, and the launcher clears it;
the call then fails with the game's own error text rather than returning a
number that means nothing. The linter is authoritative rather than heuristic - it
reads GM8's own `fnames` table for built-in names and signatures, plus this
project's scripts and extension functions - and it reports nothing on the game's
existing ~20,000 lines.

Run `gg2_lint` yourself before writing GML into a source file; the linter costs
nothing and a build costs seconds or a minute. `gg2_rebuild` runs it too and
refuses to splice code that would not compile, but finding out at edit time
beats finding out at build time. If it flags a function that really does exist,
it came from a `.gex` - add it to `tools/gml-extensions.txt`.

Still prefer several small evals over one large one, so a failure tells you
exactly what broke.

## Things that will waste your time if you do not know them

- **An audio device is required.** GM8 loads the game's sound resources into
  DirectSound during engine startup, before any game code runs. With no audio
  endpoint it shows two modal errors and terminates. Over RDP that means audio
  redirection, or `tscon <id> /dest:console`. No code change can avoid this.
- **A full build needs an interactive desktop session**, because Game Maker 8
  has no command-line compile - `tools/gm8ide.js` drives the IDE for you with
  posted window messages, so it needs a real desktop to open windows on but not
  a person watching it. `build-fast.js` needs neither, which is the point of it.
- **`gg2_input aim` hangs** rather than erroring: `window_views_mouse_set` never
  returns when the game window is not the foreground window, which a game
  launched by this tooling normally is not. The obvious fix - the launcher
  forcing focus with `AttachThreadInput`/`SetForegroundWindow` - was tried and
  failed with access-denied/invalid-parameter errors; see `HANDOFF.md` before
  trying it again. Expect a ~10s timeout and no effect. `press`/`click` do not
  depend on focus and work fine.
- **A frozen game's own instances cannot be read by field while they stay
  frozen.** `gg2_step` (and `FREEZE` generally) works by calling
  `instance_deactivate_all(true)`, and GM8 makes a deactivated instance's data
  unreachable from anywhere else at all - not just a `with()`, even a plain
  dot-access read of a built-in like `.x` on an instance id held in a
  `global.` comes back "Unknown variable x" while frozen, for exactly the
  instance that reads fine a moment after `gg2_resume`. `gg2_screenshot`
  dodges this by reactivating before it draws and freezing again afterwards;
  a `gg2_evalx` that needs one instance's own fields can do the same thing by
  hand - `instance_activate_object(id)` before the read (verified: it does not
  itself run any code or advance anything, since nothing steps again until the
  game is actually resumed) - or just `gg2_resume` first if the whole game's
  state is wanted anyway.
- **A GML error does not kill the game any more, and it is not silent either.**
  `tools/launcher.js` presses Ignore on GM8's `TErrorForm` and logs the message;
  any call that runs while the game raises one comes back as an error carrying
  that text, instead of the `0` the bridge would otherwise report, and located as
  `file:line` by `tools/gmlerror.js`. `gg2_log` with `source: "launcher"` shows
  the same history.
- **`E|` is an error, `M|` is a message.** The launcher marks the two kinds of
  dialog differently in its log, because the game's unit tests report through
  `show_message` and a failed assertion is a result, not a crash. Anything
  reading that log must keep them apart.
- **Logs and the register are per port.** `agent_bridge_<port>.log`,
  `agent_launcher_<port>.log` and `agent_instances.json`, all beside the exe, so
  two games in one directory never interleave.
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
| `Scripts/Unit tests/` | assertion helpers (`test_assert_equals`, …) and the suites `gg2_test` runs |
| `Documentation/GGON.md` | the GGON format |

Command-line flags the game already understands: `-dedicated`, `-server <ip>`,
`-port <n>`, `-map <name>`, `-restart`, plus `-agent` and `-agentport <n>` added
by the bridge. `-server` and `-port` only count together — the parser ignores
either on its own.
