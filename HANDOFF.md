# State of the live bridge

Everything in [`CLAUDE.md`](CLAUDE.md) is built and the Node half is tested
(`node tools/selftest.js`, ~3s, no Game Maker; 47 checks as of this pass). The
GML half has run against a real game repeatedly, most recently on 2026-08-19,
and the problems this document used to describe - the client bridge dying,
held movement input having no route into the game, the `AudioControl`/`CTFHUD`
"winners" bug and the `fps:4` death spiral it caused, a stale lint cache after
a full build, `watched()`'s error reports repeating the same dialog dozens of
times, an RDP session's timeout giving no hint why, and a genuinely new script
costing a full IDE build even to try out - are all fixed and verified live.
Nothing here is currently blocked.

Also re-checked this pass: `node tools/session.js start --clients 2` comes up
clean (zero `AgentBridge` errors in either client's log, both bridges answer
`PING` independently), so the client fix holds beyond the one-client case the
original bug report was written against. And `test_ggon`, the one existing GML
unit suite, still reports `31/31` after everything above - the `PlayerControl`
edit didn't regress anything it covers (it doesn't cover movement, so this is
a smoke test more than proof, but it's what exists).

## The client bridge dying - fixed

**Root cause**, found by reading `game_init.gml` rather than guessing: a
`-server`/`-port` launch calls `instance_create(0,0,Client)` partway through
`game_init()`, and `Client`'s Create event (`ClientCreate`) calls
`room_goto_fix(DownloadRoom)` immediately - a real `room_goto()`, just deferred
until `game_init()` returns. Everything `instance_create`d *after* that point
in the same creation-code run comes out with none of its own Create-event
variables set, as if Create had never run. This is a GM8 quirk, not particular
to the bridge: `AudioControl`, created a few lines after `Client`, shows the
identical symptom in `game_errors.log` ("Unknown variable currentSong",
`AudioControlPlaySong`), for code that has nothing to do with agent tooling.
AgentBridge used to be injected after `loadplugins()` - the very end of
`game_init()`, and squarely inside the corrupted window.

**Fix**: `tools/payload.js`'s `INIT_ANCHOR` now points at
`instance_create(0,0,RoomChangeObserver);`, the first line of `game_init()`,
before anything that can trigger a room change. `AgentBridge` is created there
instead. Verified with `node tools/session.js start --clients 1`: the client's
bridge log shows zero `AgentBridge`/`listener` errors, and a raw client to
`127.0.0.1:<client port>` answers `PING`/`EVALX` immediately.

`agentBridgeStep.gml` also self-heals now (`if (not
variable_local_exists("listener")) agentBridgeCreate();` at the top), as
defense in depth in case some other path still manages to skip Create. It was
not needed to fix the client case above - the anchor move alone did that - but
costs one check a frame and turns any future "Create didn't run" into a working
bridge instead of a dialog-per-frame loop.

Related, and now also fixed - see "The `AudioControl`/`CTFHUD` 'winners' bug,
and the `fps:4` mystery" below: `AudioControl`, created a few lines after
`Client` in `game_init.gml`, fell in the exact same corrupted window and
stayed broken for the rest of every session, with consequences well beyond
itself.

## Held movement input - implemented and verified live

The previous version of this document proposed ORing a mask into
`global.myself.object.keyState`. **That was wrong** - `keyState` only exists on
the *server's* copy of a character (`processClientCommands.gml` sets it from
the wire), and `PlayerControl.Begin Step` builds an entirely local `keybyte`
from `keyboard_check` and sends it via `ClientInputstate`/`socket_send` every
frame; nothing about it is stored anywhere a client-side script could reach
from outside that one event.

What's actually implemented:

- `AgentBridge` gets a `heldMask` instance variable (`agentBridgeCreate.gml`).
- `INPUT press left|right|up|jump|down|taunt` sets a bit in it;
  `release`/`clear` clear it. Everything else (`attack`, `special`, arbitrary
  keys) still goes through `keyboard_key_press`/`release` as before - unchanged,
  and still only useful for the `_pressed`/`_released` edge, not holding.
- One line is now injected into the game's own `PlayerControl.Begin Step`
  (`tools/payload.js`'s `KEYSTATE_*` constants, applied by `inject.js` via
  `events.js`'s `readEvent`/`writeEvent`, reversed by `cleanup.js` the same
  way): `if (instance_exists(AgentBridge)) keybyte |= (AgentBridge.heldMask &
  $E3);`, right after the real keyboard checks and still inside
  `if(!menuOpen)`, so simulated input is blocked by an open menu exactly like
  real input is. `$E3` is left|right|up|down|taunt ($40|$20|$80|$02|$01) -
  attack/special ($10/$08) are deliberately not included, since they're also
  gated by `!global.myself.humiliated` a few lines later and getting that
  exactly right needed a second anchor line inside that block. Not done; would
  be the next piece if held attack/special turns out to matter.

This is a *third* thing the payload injects into the existing tree (alongside
the object/script copies and the one `game_init.gml` line), so `inject.js` and
`cleanup.js` both grew a step for it. Confirmed the round trip is exact:
inject, `git status` shows exactly the expected diff in
`PlayerControl.events/Begin Step.xml`, `node tools/gml-lint.js` on it is clean,
cleanup removes it, `git status` goes back to clean.

**Verified against a real game**, server + one client
(`node tools/session.js start --clients 1`), by driving both bridges directly
(no MCP client was configured in the session that did this, so a small
throwaway script spoke the raw length-prefixed protocol instead of going
through `gg2_*` tools):

1. Joined a team and picked Soldier by calling `ClientPlayerChangeteam` /
   `ClientPlayerChangeclass` directly over `global.serverSocket` - faster than
   driving the team/class UI, but leaves `TeamSelectController` behind, which
   holds `PlayerControl.menuOpen` true and blocks all input, real or
   simulated, until it's destroyed. Not a bug - it's the correct behaviour of
   the menu gate the new line respects. Deliberately used as a check that the
   gate applies to simulated input too.
2. `INPUT press left`, waited two real seconds, checked position: the
   server's copy of the character moved left by the expected amount, and its
   `keyState` read back `64` ($40) the whole time. `INPUT press right` moved it
   right by considerably more (the first case had residual friction/decay left
   over from an unrelated manual `hspeed` test moments earlier).
   `INPUT release`/`clear` took `keyState` back to `0`.

One methodology trap worth recording since it cost real time here: **`EVALX`
prepends `return ` to the whole string it's given.** `EVALX stmt1; stmt2` does
not run `stmt1` then evaluate `stmt2` - it becomes `return stmt1; stmt2`, which
returns out of `execute_string` after `stmt1` and never reaches `stmt2` at all.
A "set a variable, then read it back" test written as one `EVALX` call will
misreport the variable as never having changed, which looks exactly like a
real bug in whatever was just set. Use `EVAL` for the write, a separate `EVALX`
for the read.

## Things worth not rediscovering

- **GM8's message box cannot be read from outside.** Verified against the built
  game on 2026-08-19: its `TMessageForm` has exactly one child window, the OK
  button, and `show_message` text is painted onto the form rather than living in
  a control. `TErrorForm` is different - its text is in a `TMemo`, a real window
  that answers `WM_GETTEXT` - so GML errors *are* readable and `E|` lines are
  trustworthy. Anything that needs the words of a `show_message` has to get them
  another way; `gg2_test` reads the assertion counters instead.
- **`keyboard_key_press`/`_release` do not make `keyboard_check` true**, on this
  build, ever - verified with a `gg2_watch` on `keyboard_check(ord("Z"))`,
  which stayed 0 on every frame regardless. They do drive the
  `_pressed`/`_released` edge, which is why discrete actions (`inputTaunt()`
  and friends, called directly) and the old `press`/`release` path for
  unrecognised keys still make sense. Anything read with plain `keyboard_check`
  - i.e. anything that needs to be *held* - needs the `heldMask` route above,
  or a call directly into the game's own input scripts.
- **`gg2_input aim`/`window_views_mouse_set` hangs** when the game window is
  not the foreground window: no reply, no dialog, nothing in any error log,
  and the game carries on normally afterwards. Confirmed this pass that the
  standard fix - the launcher calling `AttachThreadInput` on the currently
  foreground thread, then `SetForegroundWindow` on the game - does not work in
  this environment: `AttachThreadInput` itself fails (`GetLastError()` 5 or
  87, access denied or invalid parameter, inconsistently across runs), even
  though `OpenInputDesktop` confirms the calling process *is* on the
  interactive desktop. Reads as UIPI or a token/integrity-level restriction on
  whatever runs shell commands here, not a sequencing mistake - two different
  Win32 error codes for the identical call across two runs is not what a wrong
  parameter looks like. Not worth another attempt without first understanding
  why this process can't touch another process's input state; adding this to
  `win32.js`/`launcher.js` would not have helped and was not done. If aim ever
  gets fixed, it likely needs a different mechanism entirely (an in-game
  keyboard/mouse simulation the bridge drives directly, rather than anything
  that depends on real OS focus), not another Win32 focus trick.
- **Every built-in the bridge calls exists in GM8.** Checked against
  `D:\GameDev\Game_Maker_8\fnames`: `screen_save`, `screen_save_part`,
  `screen_redraw`, `keyboard_key_press`, `keyboard_key_release`, `io_clear`,
  `window_views_mouse_set`, `instance_deactivate_all`, `instance_activate_all`,
  `sprite_add`, `sprite_replace`. To check another:
  `require('./tools/gml-lint.js').loadFnames('D:/GameDev/Game_Maker_8')`.
- **The splicer cannot place an empty string.** A blank event would appear
  thousands of times in the code blob and the splice would be ambiguous, which
  is why each `AgentSpare` event holds a distinct placeholder comment, and why
  `gg2_event`/`events.js` refuse to write empty code. Do not tidy those to
  empty. This is also why `agentBridgeInput.gml`'s empty-`heldMask`-bit branch
  still falls through to the `keyboard_key_press` path rather than doing
  nothing - every branch has to leave real code behind.
- **`gmlerror` falls back to the quoted source line**, and that is usually what
  actually resolves a real error, because GM8 names the object but not the file.
  An agent's own `EVALX` typo correctly resolves to nothing - the string was
  never in the tree - and reports `object AgentBridge` instead of inventing a
  location.
- **The game's own `Contributing.md` forbids `&&`/`||`, but its code uses them.**
  Match the surrounding file. The linter warns and does not fail.
- **Freezing stops the network.** `FREEZE` deactivates the objects that service
  connections too, so a frozen client or server falls behind and may drop. Fine
  for inspecting one game, needs care inside a session.
- **A frozen instance's own fields cannot be read from outside it - confirmed,
  root-caused and now documented in `CLAUDE.md`.** `FREEZE` calls
  `instance_deactivate_all(true)`, and GM8 makes a deactivated instance's data
  unreachable by any external reference at all, `with()` included - not just
  the built-ins a Create event would have set, but plain built-ins like `.x`
  too. Clean repro: create a throwaway instance, `gg2_step 1`, then
  `gg2_evalx` its `.x` with no `gg2_screenshot` in between - "Unknown variable
  x" every time, for an instance that reads fine a frame later after
  `gg2_resume`. `instance_activate_object(id)` before the read works and does
  not itself advance anything, since nothing steps again until the game is
  actually resumed - the same trick `gg2_screenshot` already uses, just
  aimed at one instance instead of everything.

## The `AudioControl`/`CTFHUD` "winners" bug, and the `fps:4` mystery - fixed (2026-08-19)

This turned out to be one root cause with three visible symptoms, all
previously logged separately in this document and elsewhere as unrelated:
`AudioControl.currentSong` reads as "Unknown variable" forever once a session
hits it, `CTFHUD` (and every other gamemode HUD reading `global.winners`)
throws "Unknown variable winners" every single frame from room start onward,
and a client or server sharing a box with another instance was seen running
at a hard `fps:4` with no obvious cause.

**Root cause**, found by tracing the error chain in `game_errors.log` rather
than treating the three as independent: `game_init.gml` used to create
`AudioControl` and `SSControl` at lines 342-343, well after
`instance_create(0,0,Client)` at line 322 - and `Client`'s Create event queues
a deferred `room_goto_fix`, the exact corrupted-window quirk this document
already diagnosed and fixed for `AgentBridge` (see "The client bridge dying"
above). `AudioControl` came out of that window with `currentSong` never set.
Every room's own creation code (`Scripts/Maps/basicRoomSetup.gml`) calls
`AudioControlPlaySong` near its end, which throws on `AudioControl.currentSong`
- and a runtime error inside a called script aborts the rest of *that* script,
which is why `global.winners = -1;` two lines later in the same
`basicRoomSetup.gml` never ran. `global.winners` stayed permanently unbound,
so every gamemode HUD's `Step` event - `CTFHUD`, `ArenaHUD`, `ControlPointHUD`,
`KothHUD`, ... - threw on every single frame for the rest of the room's life.
Each throw is a real GM8 modal, the game's own loop blocks on it, and
`launcher.js`'s dialog-clearing loop (`tools/launcher.js`) only polls every
`POLL_MS` (250ms): error → modal → block → dismissed on the next tick → one
frame runs → error again. That closed loop is exactly what caps a game at
`~1000/POLL_MS` ≈ 4 fps for as long as the bug is live - the unexplained
`fps:4` this document and others had separately shrugged off as "possibly two
GM8 processes contending for a core."

**Fix**: moved both `instance_create(0, 0, AudioControl);` and
`instance_create(0, 0, SSControl);` to right after
`instance_create(0,0,RoomChangeObserver);`, the first line of `game_init()` -
before `Client` and its deferred room change can exist, mirroring the
`AgentBridge`/`INIT_ANCHOR` fix exactly. Neither object's Create event depends
on anything set up between the old and new positions (both just guard against
a duplicate instance and touch `working_directory`).

**Verified live**, `node build-fast.js --launch` then `gg2_session start
--clients 1 --map ctf_truefort`: `gg2_state` on both `server` and `client1`
stayed clean (no "the game reported an error" from `watched()`) through a
player join, a `gg2_eval`-driven `botAdd` spawning a real Character, and
`gg2_wait`/`gg2_state` polling throughout - `fps:30` the entire time, where
the same sequence used to degrade to `fps:4` and every call after the first
error carried a growing dialog banner. `gg2_test` still reports `test_ggon:
31/31` afterward.

## Smaller fixes verified live this same pass (2026-08-19)

- **The lint gate went stale after a full `build-agent.js` build.**
  `gml-lint.js`'s `context()` cached GM8's fnames and the project's script/
  object list for the life of the process, keyed only on `(trees, gm8Dir)` -
  which never changes across a build, so a script added by a later full build
  kept reporting `"newScript" is not a GM8 built-in, a project script, or a
  known extension function` until the `gg2` MCP server itself was restarted.
  Fixed by folding the mtime of `Source/build/template/gamedata.manifest.json`
  - the file a full build already writes, and the same one `build-fast.js`
  checks a tree hash against - into the cache key: one `stat()` per lint call
  instead of one full tree walk, but no longer stale. Covered by a new
  `tools/selftest.js` case (adding a script alone doesn't invalidate the
  cache; rewriting the manifest does).
- **`watched()`'s error report had no deduplication.** A stuck-in-a-loop error
  (the `winners` bug above, before it was fixed, is exactly this case)
  produced many byte-identical copies of the same dialog block in one
  response. Consecutive identical entries now collapse to one copy plus an
  `(xN)` count - verified live against the real bug before it was fixed
  (`(x3)`/`(x14)`-style collapses in the actual error text) and with a
  `tools/selftest.js` case using a fake bridge that raises the same dialog
  four frames running.
- **`gg2_state` now includes `x`, `y` and `hp`** for any player whose
  `Player.object` currently points at a live Character (omitted between a
  death and a respawn, the same guard the game's own code uses before
  touching `.object`). Verified live: a spectator shows no `x`/`y`/`hp`, a
  `botAdd`-spawned Heavy shows `{x:1632,y:474.47,hp:120,...}`.
- **`gg2_eval`/`gg2_evalx`/`gg2_wait`'s descriptions now say outright** not to
  HTML/XML-escape `<`/`>`/`&` - the opposite of what `gg2_event` wants - since
  a session alternating between the two had twice sent `&gt;`/`&amp;`
  literally instead of `>`/`&`.
- **Checked and found already fixed, not a live bug**: a report that
  `gg2_wait`'s `expr` skips the lint gate `gg2_eval`'s `code` goes through.
  Current code (`gg2-mcp-server.js`, `case 'gg2_wait'`) calls `lintOrThrow`
  before sending `WAIT`, and has since commit `ae31907` - the same day the
  report was written. Most likely explanation: the report came from an MCP
  server process that had been running since before that commit landed, which
  is the same class of staleness as the lint-cache bug above, just for this
  file's own code instead of the game's. Node does not hot-reload a required
  module - a `tools/gg2-mcp-server.js` edit needs the MCP server process
  restarted to take effect, same as a game code edit needs `gg2_rebuild`.
  Worth remembering if a bug report and the code on disk ever disagree again.

## Two more fixed and verified live (2026-08-19, later the same day)

- **RDP sessions now get a real diagnosis instead of a generic timeout.**
  `win32.js` gained `isRemoteSession()` (`GetSystemMetrics(SM_REMOTESESSION)`,
  one Win32 call, no shelling out). `run-agent.js` - the single choke point
  `session.js` and `build-fast.js`'s `--launch` both already funnel through -
  checks it when the bridge fails to come up in time and, if the session is
  remote, adds the actual diagnosis (GM8 hangs on a "no audio device" modal
  with no redirection; `tscon <id> /dest:console` or enabling redirection is
  the fix) to the same warning stream `gg2_session`'s error already surfaces.
  Deliberately not a refuse-up-front check - RDP with audio redirection
  configured works fine, so this only fires once the real symptom (bridge
  never came up) has actually happened. Verified on this (non-remote) desktop
  that `isRemoteSession()` reports `false` and `run-agent.js` launches exactly
  as before; the positive branch is straightforward and low-risk but was not
  exercised live, since doing that needs an actual RDP session.
- **`agentScriptSpare0..5`, the script equivalent of `AgentSpare0..3`.** Six
  pre-registered scripts (`payload/Scripts/AgentBridge/agentScriptSpareN.gml`,
  each a placeholder comment, registered in that folder's
  `_resources.list.xml`) so a genuinely new script no longer costs a full
  `build-agent.js` build while its behaviour is still being worked out - only
  once, when it is finally renamed to something real. No new tooling needed:
  a script is already just a `.gml` file, and `build-fast.js` already splices
  any changed script content, spare or not - the only thing missing was the
  resource existing at all. One `build-agent.js` run registered them (`git
  status clean` afterward, confirming inject/cleanup handled the six new files
  correctly with no changes needed there). **Verified live end to end**:
  wrote `return argument0 + 1;` into `agentScriptSpare0`, `build-fast.js
  --launch` spliced it in 2.5s, `gg2_evalx agentScriptSpare0(41)` returned
  `42`, `gg2_lint` recognised the name as a known script immediately (no MCP
  server restart needed - this is exactly what the manifest-mtime lint fix
  above was for). Reverted to the placeholder and re-spliced clean afterward;
  `gg2_test` still `31/31` and `node tools/gamedata.js selftest` confirms the
  unpack/repack round trip on the rebuilt template is still byte-identical.
