# gg2-agent

Tooling for developing
[Gang Garrison 2](https://github.com/Gang-Garrison-2/Gang-Garrison-2) — a 2008
game built in Game Maker 8 — with an AI agent.

Four things live here:

- **a bridge** injected into the game at build time, letting an agent inspect and
  change the running game over MCP — read state, drive input, freeze it and step
  it a frame at a time, and look at the result;
- **a ~2s rebuild** of the whole game straight from its source tree, with no
  Game Maker process, through [gm8-builder](https://github.com/kylelmoy/gm8-builder);
- **sessions**: a dedicated server and its clients, running at once and
  addressable by name, because nothing about the network protocol is observable
  from inside one process;
- **a launcher** that clears the modal dialogs GM8 answers errors with, so a
  game an agent is driving never freezes on one.

Everything is kept out of the game's own repository. The bridge is injected into
its source tree at build time and removed afterwards, so a build can never ship
it, and nothing about this workflow appears in that repo's history. It works on
upstream `Gang-Garrison-2` or any fork of it.

> Agents: read [`CLAUDE.md`](CLAUDE.md) instead — it is the operating guide.

## Install

**Windows only**: the game is a Windows executable, and the launcher clears its
modal dialogs through user32. You need:

- **Node 18+.**
- **A Game Maker 8.0 install.** It is never run - the build copies its runner,
  libraries and extensions, and the linter reads its `fnames` - so a copy of
  those files anywhere will do. Found through `GM8_DIR`, then whatever opens
  `.gmk` files, then the default install paths. Game Maker 8 is no longer sold
  and nothing here ships its files; if you already build Gang Garrison 2 you
  have one, since upstream's own build needs it too.
- **An audio device.** GM8 loads sound resources into DirectSound during engine
  startup; with no endpoint it raises two modal errors and terminates before any
  game code runs. Over RDP: audio redirection while connected,
  `tscon <id> /dest:console`, or a virtual audio driver.
- **A Gang Garrison 2 checkout** - upstream or your fork. Beside `gg2-agent` is
  simplest, but anywhere works (see below).

```powershell
git clone https://github.com/kylelmoy/gg2-agent
git clone https://github.com/Gang-Garrison-2/Gang-Garrison-2   # or your fork
cd gg2-agent
npm install
npm run doctor
```

`npm install` installs koffi (prebuilt — no compiler needed) and fetches
[gm8-builder](https://github.com/kylelmoy/gm8-builder), the build and the GML
linter: the release pinned in `tools/gm8.js`, checked against its SHA-256 and
unpacked into `.deps/`. Set `GM8_BUILDER` to use some other exe instead, such as
a local build. If the download fails - offline, say - the install still
succeeds, and the first build or lint tries again.

`npm run doctor` (`tools/doctor.js`) checks everything above and prints the
command that registers the MCP server. Register it once, at user scope, so it is
available in every project and nothing lands in the game repo:

```powershell
claude mcp add gg2 -s user -- node C:\path\to\gg2-agent\tools\gg2-mcp-server.js
```

Any other MCP client takes the same command as JSON:

```json
{ "mcpServers": { "gg2": { "command": "node", "args": ["C:\path\to\gg2-agent\tools\gg2-mcp-server.js"] } } }
```

### Which checkout it works on

Chosen when the server starts, with nothing to configure for the usual cases:

1. `GG2_REPO`, if set (`claude mcp add gg2 -s user -e GG2_REPO=<path> -- node ...`);
2. otherwise the checkout the session was opened in, or that contains it - so
   opening a session in a fork or a worktree points every tool at it;
3. otherwise a `Gang-Garrison-2` beside `gg2-agent`.

`gg2_checkout` shows which one that was, and switches to another mid-session.
Games belong to the checkout they were built from, so after switching, the
ones started from the old checkout keep running but are not addressable until
you switch back. The command-line scripts choose their default `--repo` the
same way.

## Usage

Open a Claude Code session - in the game checkout is the natural place - and
ask for what you want in plain words. The agent picks the tools; the table
below is what it has to pick from.

**First run.** Ask it to build and launch the game. `gg2_rebuild` lints the
tree, builds `Source/build/Gang Garrison 2.exe` in about two seconds and starts
it with the bridge listening; `gg2_ping` confirms it answers.

**Looking.** "What map is loaded and who is on which team?" is `gg2_state`;
"show me the game" is `gg2_screenshot`; "show me all of ctf_truefort, with what
you can stand on outlined" is `gg2_map_image` or, for the live game,
`gg2_area_shot`. Any value the game holds can be read with `gg2_evalx`.

**Changing code.** The edit loop is: try an idea against the live game with
`gg2_eval` (instant, nothing written), write it into the source - scripts are
plain `.gml`, and `gg2_event` reads and writes the code inside object events -
then `gg2_rebuild`. The running game only changes when it is rebuilt, since
GM8 keeps the code inside the executable. `gg2_find` searches scripts and event
code together.

**Chasing a bug.** `gg2_step` freezes the game and advances an exact number of
frames; `gg2_wait` runs until a condition becomes true; `gg2_watch` records
values every frame into the log. When something goes wrong, `gg2_log` shows the
GML errors the launcher dismissed, located as `file:line`.

**Multiplayer.** "Start a server and two clients on koth_valley" is
`gg2_session`. Each game gets a name - `server`, `client1`, … - and every live
tool takes an `instance` argument to say which one it means.

**Tests.** `gg2_test` runs the game's own unit tests (`Scripts/Unit tests/`)
inside the running game and reports how many assertions passed.

The twenty-three tools, in four groups:

| | |
|---|---|
| **inspect** | `gg2_ping`, `gg2_evalx`, `gg2_state`, `gg2_screenshot`, `gg2_map_image`, `gg2_area_shot`, `gg2_log` |
| **drive** | `gg2_eval`, `gg2_input`, `gg2_step`, `gg2_resume`, `gg2_speed`, `gg2_wait`, `gg2_watch`, `gg2_sprite` |
| **edit** | `gg2_checkout`, `gg2_lint`, `gg2_event`, `gg2_find`, `gg2_rebuild` |
| **run** | `gg2_session`, `gg2_test`, `gg2_profile` |

### From the shell

The same builds and launches are scripts, for CI or for working without an
agent. Each takes `--help` and `--repo <path>`:

```powershell
node build-agent.js            # build into a cleared Source/build (~2s)
node build-agent.js --package  # ...and produce build.zip
node build-fast.js --launch    # build in place, then relaunch (~2s)
node run-agent.js              # launch and wait for the bridge
node tools/session.js start --clients 2   # a dedicated server and two clients
node tools/selftest.js         # check this repo's own modules (~3s, no game running)
```

While iterating on the bridge's own GML, `--keep-injected` leaves it in the tree;
run `node cleanup.js` before committing anything in that checkout.

### When something goes wrong

- **Every call times out, but the game is running.** The game accepts one
  bridge client at a time. Something else - another editor session, a script of
  your own - is holding it.
- **A call fails with a GML error.** GM8 reports errors as modal dialogs; the
  launcher dismisses them and the call comes back with the message and its
  `file:line`. `gg2_log` with `source: "launcher"` has the history.
- **The game dies at startup with two dialogs.** No audio device; see Install.
- **`gg2_input aim` hangs** for about ten seconds and does nothing. It needs the
  game window in the foreground, which a launched game usually is not. `press`
  and `click` work.
- **A reply ends with "this GML was NOT linted".** gm8-builder or the Game
  Maker 8 install could not be found, so nothing is checking code before it
  reaches the game and a typo will raise a dialog. `npm run doctor` says which.
- **Bridge files show up in the game's `git status`.** A build was killed
  before it could clean up, or `--keep-injected` was used: run `node cleanup.js`.

## Layout

```
build-agent.js      inject -> lint and build with gm8-builder -> clean up, into a cleared build dir
build-fast.js       the same build in place, stopping and relaunching the game (~2s)
run-agent.js        launch the game and wait for the bridge
package.js          assemble a release-shaped build.zip
inject.js           add the bridge to a checkout
cleanup.js          remove it, and verify with git status

payload/            copied verbatim into the game's Source/gg2/
  Objects/          AgentBridge and the four AgentSpare objects, with their events
  Scripts/          the GML implementing the bridge, and the debug logging it patches in

docs/               durable reference; see CLAUDE.md, "Where documentation goes"
  OPEN.md           what is known to be wrong right now (rewritten, not appended)
  CLIENTDEBUG.md    getting a client failure into a log instead of a screenshot

tools/
  -- driving a running game --
  gg2-mcp-server.js the MCP server (JSON-RPC over stdio): transport and dispatch
  mcp-schemas.js    the tool table it advertises - declarations only, no behaviour
  launcher.js       runs the game; clears the modal dialogs that freeze it
  win32.js          the slice of user32 the launcher needs, via koffi
  instances.js      the register of running games, so they can be named
  session.js        a dedicated server and its clients, started together

  -- building (the build itself is gm8-builder, a pinned release, see below) --
  gm8.js            fetches gm8-builder, finds Game Maker; the long-running lint server lives here
  events.js         reading, writing and searching the GML inside object events
  gml-lint.js       checks GML before it is sent or built, through `gm8-builder lint`
  gml-extensions.txt  the .gex functions the linter cannot discover on its own
  gmlerror.js       turns a GM8 error dialog back into file:line
  payload.js        what the payload consists of, so inject and cleanup agree

  -- maps, offline --
  walkmask.js       the one decoder for what a map is made of

  -- pictures --
  mapimage.js       one map picture, drawn one way: base layer and scale
  areashot.js       a live screenshot bigger than one window, tiled and stitched
  image.js          turns what screen_save wrote into a PNG

  doctor.js         checks a machine is set up, and prints how to register the server
  selftest.js       exercises all of the above against a fake game
  lib.js            shared helpers (file edits, tool discovery, processes, paths)
```

The six scripts at the root, plus `events.js`, `session.js` and
`walkmask.js`, are CLIs taking `--help` and `--repo <path>`; `--repo` defaults the same way the
MCP server chooses (see Install): `GG2_REPO`, the checkout the working directory is
in, then a `Gang-Garrison-2` beside this one. Every one of them is also a plain module,
which is how the MCP server's `gg2_rebuild` builds in-process instead of spawning a
shell. The rest of `tools/` is modules only, reached through the MCP tools or through
each other.

## The bridge, and why it is injected

The bridge exposes `execute_string` over a socket. That is remote code execution
by design: exactly what makes it useful during development, and exactly what must
never reach a player's build. Injecting it, rather than committing it, is what
guarantees that.

It is practical because the bridge touches the game's tree in few places. Four
are lines *added*:

| File | Change |
|---|---|
| `Objects/_resources.list.xml` | register `AgentBridge` and the four spares (5 lines) |
| `Scripts/_resources.list.xml` | register the script group |
| `Scripts/Game/game_init.gml` | `instance_create(0, 0, AgentBridge);` |
| `Objects/InGameElements/PlayerControl.events/Begin Step.xml` | OR `AgentBridge.heldMask` into `keybyte`, so `gg2_input press left` etc. can hold a direction without a keyboard |

The rest are five existing lines *replaced*, each by a call to a payload script
(`CODE_PATCHES` in `tools/payload.js`). Replacing the whole line rather than
inserting beside it is what leaves the game's control flow alone - several are
the braceless body of an `if`, where an inserted neighbour would change what the
game does - and `cleanup.js` swaps each back and fails if one survives.
`docs/CLIENTDEBUG.md` has the detail:

| File | Lines | For |
|---|---|---|
| `Scripts/Serialization/deserializeState.gml` | 2 | log a player-count desync, with the count the server declared, instead of only showing it |
| `Scripts/Misc/getCharacterSpriteId.gml` | 2 | log its two `show_error` calls, which abort |
| `Scripts/AudioControl/AudioControlPlaySong.gml` | 1 | stop a stock bug raising a dialog at every round end |

Where a fork reshapes one of these lines, the payload lists that shape as an
alternative; a tree matching none is built without that line, with a warning.

Everything else is new files. The object configures itself from the command line
in its own Create event, so the game's startup needs one line and nothing more.
Without `-agent`, the instance stays dormant. The `PlayerControl` line is edited
and restored through `tools/events.js`, the same escape-aware machinery behind
`gg2_event`, rather than a plain-text line insert - it lives inside XML.

The listener accepts one client at a time and drops anything that is not
loopback. One client at a time is why the tools split the way they do: see
*The loop* in `CLAUDE.md` for which of them may be run from a shell while an
agent is holding a game, and which may not.

### Wire protocol

`uint32` little-endian length, then that many bytes. Requests are
`VERB [argument]` — `PING`, `EVAL`, `EVALX`, `STATE`, `SHOT`, `INPUT`, `WATCH`,
`FREEZE`, `RESUME`, `STEP`, `WAIT`, `SPEED`, `CANCEL`, `QUIT` — and replies are
`OK`, `OK <text>` or `ERR <text>`, each prefixed with `#<id> ` echoing the request
it answers. The Node server speaks MCP on one side and this on the other, so the
GML never parses JSON.

Two of those verbs cannot answer in the frame they arrive: `STEP` counts frames
down and `WAIT` re-tests an expression. The dispatcher returns an empty reply for
those, having recorded what it is waiting for, and a per-frame handler sends the
answer once it is due.

The bridge keeps reading while that reply is outstanding. `CANCEL` is answered
immediately — it exists to let a caller that has given up escape a `WAIT` with
most of its frame budget left, which costs one round trip instead of the rest of
the budget. Everything else is held in arrival order and dispatched the moment
the deferred reply goes out, because a deferred `STEP` has the world *running*
and anything executed in that window would change what the `STEP` measures.

**Replies are therefore not in request order**, and matching them by position is
wrong: a `CANCEL` jumps ahead of requests that arrived before it, and the reply
it cancels lands under its own id. That is what the ids are for. A client that
disconnects mid-request clears the state, drops the queue and unfreezes the
world, so the next one does not inherit a game that never advances.

`FREEZE` stops the world by deactivating every instance except the bridge, which
keeps answering while nothing else moves. A deactivated instance is not drawn, so
`SHOT` reactivates, calls `screen_redraw()`, saves, and deactivates again: a
redraw runs no step events, so a screenshot of a frozen game shows the real frame
without advancing it.

## The build

Game Maker 8 has no command-line compile, and upstream's `build.bat` stops at a
manual *File > Create Executable*. This repo does not run Game Maker at all.
Game Maker 8 never compiles GML: a built executable is the runner stub with the
project appended as zlib blobs behind a swap-table cipher, holding every script
and event as **source text**. [gm8-builder](https://github.com/kylelmoy/gm8-builder) writes that format
straight from the split tree, reproducing the IDE's image, collision-mask and
resource quirks, and applies `gm8x_fix`'s runner patches - about two seconds for
the whole game. It knows nothing about this game or the bridge, and has its own
README, tests and history.

`build-agent.js` and `build-fast.js` both inject the bridge, run
`gm8-builder build --lint --gm8x-fix`, and remove the bridge again from a
`finally` block, so an interrupted build still leaves a clean checkout. The whole
tree is linted first, because a syntax error in a built exe is a modal dialog
that hangs the game; `tools/gml-extensions.txt` tells the linter about the
functions this game's `.gex` packages provide. They differ only around the
build: `build-agent.js` clears `Source/build` first and can package;
`build-fast.js` stops the running game, builds in place and can relaunch it.

`gm8-builder roundtrip "<exe>"` reads and rewrites an executable and asserts the
result is byte-identical; `gm8-builder compare a.exe b.exe` lists the content
differences between two.

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

`show_message` is the exception, and a hard one: its form holds exactly one windowed
control, the OK button, and the message is painted onto the form itself, so
`WM_GETTEXT` finds nothing to return. The log says `(dialog had no readable text)` and
**captures the window with `PrintWindow` instead**, naming the `.bmp` beside the log —
the pixels are there even when the text is not, and that picture is often the only
record of what the game said. `gg2_test` still reads the assertion counters rather
than the words, because a counter is exact and a screenshot needs an eye.

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

## Security

The bridge runs any GML it is sent, which on Windows means anything at all.
That is contained three ways, and all three matter:

- it listens only when the game is started with `-agent`;
- it drops every connection that is not from `127.0.0.1` or `::1`;
- it is injected at build time and removed afterwards, so it is never in the
  game's repository and cannot reach a release build made from it.

Do not remove the loopback check, and never distribute an executable built by
this tooling. To report a vulnerability, see [`SECURITY.md`](SECURITY.md).

## License

MIT - see [`LICENSE`](LICENSE). Gang Garrison 2 itself is a separate project
under its own license; nothing from it is included here.
