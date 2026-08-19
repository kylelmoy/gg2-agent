# State of the live bridge

Everything in [`CLAUDE.md`](CLAUDE.md) is built and the Node half is tested
(`node tools/selftest.js`, ~3s, no Game Maker). The GML half has run against a
real game repeatedly, most recently on 2026-08-19, and the two problems this
document used to describe - the client bridge dying, and held movement input
having no route into the game - are both fixed and verified live. Nothing here
is currently blocked.

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

Related, not fixed (out of scope - pre-existing game code, unrelated to the
bridge): `CTFHUD` raised "Unknown variable winners" for a few frames early in
the same client session. Never chased down; possibly the same
create-during-a-pending-room-change pattern showing up somewhere else in the
game's own flow (a `Menu` -> map transition, say), possibly unrelated. Worth
keeping in mind if something else is ever found "created but uninitialized."

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
- **A dedicated server + one client on the same box runs noticeably slower
  than 30fps** under some conditions seen this pass (`STATE` reported `fps:4`
  briefly on the client). Not chased down - possibly two GM8 processes
  contending for the same core, possibly unrelated. If a `gg2_wait`/`STEP` call
  seems to be taking far longer in wall-clock time than its frame count should,
  check `STATE`'s `fps` before assuming something is stuck.
