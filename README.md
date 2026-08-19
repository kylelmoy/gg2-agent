# gg2-agent

Tooling for developing
[Gang Garrison 2](https://github.com/Gang-Garrison-2/Gang-Garrison-2) — a 2008
game built in Game Maker 8 — with an AI agent.

Four things live here:

- **a bridge** injected into the game at build time, letting an agent inspect and
  change the running game over MCP — read state, drive input, freeze it and step
  it a frame at a time, and look at the result;
- **a ~3s code-only rebuild** that splices changed GML straight into the last
  executable, skipping the 2008 toolchain entirely;
- **sessions**: a dedicated server and its clients, running at once and
  addressable by name, because nothing about the network protocol is observable
  from inside one process;
- **the scaffolding** around the one build step Game Maker 8 gives no
  command-line for — driven automatically where possible, manually otherwise.

Everything is kept out of the game's own repository. The bridge is injected into
its source tree at build time and removed afterwards, so the fork can never ship
it, and nothing about this workflow appears in its history.

> Agents: read [`CLAUDE.md`](CLAUDE.md) instead — it is the operating guide.

## Layout

```
build-agent.js      inject -> reassemble -> build in the IDE -> patch -> clean up
build-fast.js       splice changed code straight into the last build (~3s)
run-agent.js        launch the game and wait for the bridge
package.js          assemble a release-shaped build.zip
inject.js           add the bridge to a checkout
cleanup.js          remove it, and verify with git status

payload/            copied verbatim into the game's Source/gg2/
  Objects/          AgentBridge and the four AgentSpare objects, with their events
  Scripts/          the GML implementing the bridge
tools/
  launcher.js       runs the game; clears the modal dialogs that freeze it
  win32.js          the slice of user32 the launcher needs, via koffi
  gm8ide.js         drives the GM8 IDE through File > Create Executable
  gg2-mcp-server.js the MCP server (JSON-RPC over stdio)
  instances.js      the register of running games, so they can be named
  session.js        a dedicated server and its clients, started together
  events.js         reading, writing and searching the GML inside object events
  gamedata.js       reads and rewrites the gamedata inside a built exe
  gml-lint.js       checks GML against the installed Game Maker 8
  gmlerror.js       turns a GM8 error dialog back into file:line
  image.js          turns what screen_save wrote into a PNG
  payload.js        what the payload consists of, so inject and cleanup agree
  selftest.js       exercises all of the above against a fake game
  lib.js            shared helpers (file edits, tool discovery, processes)
```

Every script is a plain module as well as a CLI — which is how the MCP server's
`gg2_rebuild` builds in-process instead of spawning a shell — and every one takes
`--help` and `--repo <path>`. `--repo` defaults to a `Gang-Garrison-2` checkout
beside this one.

## Setup

- Game Maker 8.0 **Pro** — the Lite edition cannot build a project with extensions.
  `build-agent.js` auto-detects a few common install paths; if yours is
  elsewhere, pass `--gm8 <dir>` or set `GM8_DIR`.
- A JRE, plus `gmksplit.exe` and `gm8x_fix.exe`, in `tools/` or the game's `Source/`
- Node 18+, then `npm install` (one dependency: koffi, which ships prebuilt — no
  compiler needed)
- **An audio device.** GM8 loads sound resources into DirectSound during engine
  startup; with no endpoint it raises two modal errors and terminates before any
  game code runs. Over RDP: audio redirection while connected,
  `tscon <id> /dest:console`, or a virtual audio driver.

Register the MCP server once, at user scope, so nothing lands in the game repo:

```powershell
claude mcp add gg2 -s local -- node <path-to>\gg2-agent\tools\gg2-mcp-server.js
```

It exposes eighteen tools, in four groups:

| | |
|---|---|
| **inspect** | `gg2_ping`, `gg2_evalx`, `gg2_state`, `gg2_screenshot`, `gg2_log` |
| **drive** | `gg2_eval`, `gg2_input`, `gg2_step`, `gg2_resume`, `gg2_wait`, `gg2_watch`, `gg2_sprite` |
| **edit** | `gg2_lint`, `gg2_event`, `gg2_find`, `gg2_rebuild` |
| **run** | `gg2_session`, `gg2_test` |

Every tool that talks to a game takes an optional `instance`, so a server and its
clients can be addressed by name; leave it out while only one game is running.

## Use

```powershell
node build-agent.js            # full build; drives the GM8 IDE itself
node build-agent.js --package  # ...and produce build.zip
node build-fast.js --launch    # ~3s: code changes only, then relaunch
node run-agent.js              # launch and wait for the bridge
node tools/session.js start --clients 2   # a dedicated server and two clients
node tools/selftest.js         # check this repo's own modules (~3s, no GM8)
```

A full build is only needed to bootstrap the fast-rebuild template, and after
adding, removing or renaming a resource. Everything else goes through
`build-fast.js`.

While iterating on the bridge's own GML, `--keep-injected` leaves it in the tree;
run `node cleanup.js` before committing to the fork.

## The bridge, and why it is injected

The bridge exposes `execute_string` over a socket. That is remote code execution
by design: exactly what makes it useful during development, and exactly what must
never reach a player's build. Injecting it, rather than committing it, is what
guarantees that.

It is practical because the bridge touches the game's tree in only a handful of
places, one line each:

| File | Change |
|---|---|
| `Objects/_resources.list.xml` | register the object |
| `Scripts/_resources.list.xml` | register the script group |
| `Scripts/Game/game_init.gml` | `instance_create(0, 0, AgentBridge);` |
| `Objects/InGameElements/PlayerControl.events/Begin Step.xml` | OR `AgentBridge.heldMask` into `keybyte`, so `gg2_input press left` etc. can hold a direction without a keyboard |

Everything else is new files. The object configures itself from the command line
in its own Create event, so the game's startup needs one line and nothing more.
Without `-agent`, the instance stays dormant. The `PlayerControl` line is edited
and restored through `tools/events.js`, the same escape-aware machinery behind
`gg2_event`, rather than a plain-text line insert - it lives inside XML.

The listener accepts one client at a time and drops anything that is not
loopback.

### Wire protocol

`uint32` little-endian length, then that many bytes. Requests are
`VERB [argument]` — `PING`, `EVAL`, `EVALX`, `STATE`, `SHOT`, `INPUT`, `WATCH`,
`FREEZE`, `RESUME`, `STEP`, `WAIT`, `QUIT` — and replies are `OK`, `OK <text>` or
`ERR <text>`. The Node server speaks MCP on one side and this on the other, so
the GML never parses JSON.

Two of those verbs cannot answer in the frame they arrive: `STEP` counts frames
down and `WAIT` re-tests an expression. The dispatcher returns an empty reply for
those, having recorded what it is waiting for, and a per-frame handler sends the
answer once it is due. Nothing further is read while one is outstanding, so
replies always come back in the order they were asked for — and a client that
disconnects mid-request clears the state and unfreezes the world, so the next one
does not inherit a game that never advances.

`FREEZE` stops the world by deactivating every instance except the bridge, which
keeps answering while nothing else moves. A deactivated instance is not drawn, so
`SHOT` reactivates, calls `screen_redraw()`, saves, and deactivates again: a
redraw runs no step events, so a screenshot of a frozen game shows the real frame
without advancing it.

## The full build

Game Maker 8 has no command-line compile — the IDE is the only way to produce an
executable, and upstream's `build.bat` stops at a manual *File > Create
Executable*. `build-agent.js` does everything either side of that step: it
injects the bridge, reassembles the tree with `gmksplit`, builds the
executable, patches it with `gm8x_fix`, records the fast-rebuild template, and
removes the bridge again. Cleanup runs from a `finally` block, so an
interrupted build still leaves a clean checkout.

The build step itself — *File > Create Executable* — is driven automatically by
`tools/gm8ide.js`, which drives the GM8 IDE with posted window messages: the
menu command, the save dialog's filename, and the confirmations either side of
it. `PostMessage` rather than `SendMessage` throughout, same as the launcher, so
nothing has to be focused or activated and the desktop is not stolen from
whoever is using it — an interactive desktop session is needed, but not a
person watching it. If Game Maker 8 cannot be found (pass `--gm8 <dir>` or set
`GM8_DIR`), or driving it fails partway through, this falls back to opening the
project and waiting for someone to finish it by hand — the original behaviour,
and what `--manual` forces on purpose. A failed drive leaves the IDE open with
the project loaded, so finishing by hand costs one menu click, not a reload.

## The fast rebuild

Game Maker 8 never compiles GML. A built executable is the runner stub with the
project appended at offset 2,000,000: zlib blobs behind a swap-table cipher,
holding every script and event as **source text**. Nothing in that stream stores
an absolute offset into it, so a piece of code can be swapped for a longer or
shorter one and the rest simply shifts.

`build-fast.js` takes the last executable the IDE produced — kept alongside a
manifest of the code it contains — decrypts the stream, replaces each changed
script and event, and re-encrypts. Everything it does not recognise, which is
most of the file, is copied through byte for byte. Bytes 0 to 2,000,000 are
untouched, so the icon and `gm8x_fix`'s patches survive without rerunning
anything.

It is deliberately narrow. A hash of every non-code file in the tree, taken when
the template was built, means a new sprite, room, object property or setting is
an error telling you to run `build-agent.js` — never a silently stale build.
Changed GML is linted first, because a syntax error in a built exe is a modal
dialog that hangs the game.

`node tools/gamedata.js selftest "<exe>"` unpacks and repacks an executable and
asserts the result is byte-identical.

## The launcher

`tools/launcher.js` starts the game and stays resident, because GM8 answers three
ordinary situations with a modal dialog — no audio device, any GML runtime error,
and every call to `show_message` — and a modal dialog freezes the game along with
every pending MCP call. Nothing inside the game can clear its own modal.

It watches for `TErrorForm`, `TMessageForm` and `#32770` belonging to the game's
process. `TErrorForm` is the one that matters most: it offers **Abort** next to
**Ignore**, so the button is chosen by name rather than by position, and its
error text lives in a `TMemo`, which is a real window and answers `WM_GETTEXT`.
Every dialog's text is read out of its controls and written to
`agent_launcher_<port>.log` before it is dismissed, marked `E|` for an error and
`M|` for a message — a distinction the tooling depends on, since the game's unit
tests report through `show_message` and a failed assertion must not be reported
as a crash. That log — `gg2_log` with `source: "launcher"` — is usually the only
explanation you will get for a call that suddenly started timing out, and
`tools/gmlerror.js` turns its errors back into `file:line`.

`show_message` is the exception, and a hard one: its form holds exactly one
windowed control, the OK button, and the message is painted onto the form
itself. Nothing outside the process can read it, which is why `gg2_test` reads
the assertion counters rather than the words.

It also owns the game as a child process, which is what lets it register the
instance on start and take the entry out again when the game exits.

Everything is posted rather than sent, since `SendMessage` blocks until the
target answers and these windows are by definition the ones that have stopped.

## Sessions

A dedicated server and its clients, started together and addressable by name:

```powershell
node tools/session.js start --clients 2 --map ctf_truefort
node tools/session.js list
node tools/session.js stop --name client2
```

Each game gets its own bridge port, its own logs and an entry in
`agent_instances.json` beside the executable. The register holds no locks — a
stale entry is pruned on the next read by asking the operating system whether the
pid is still there.

Three settings decide whether a local session works, and none of them has a
command-line flag: `UseLobby` must be 0 or a dedicated server announces itself to
the public lobby, `HostingPort` is where the server listens and therefore where
clients must be pointed, and `MultiClientLimit` caps connections from one
address — which every local client shares. `session.js` sets the first, reads the
second and refuses politely against the third.
