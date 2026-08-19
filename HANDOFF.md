# State of the live bridge

Everything in [`CLAUDE.md`](CLAUDE.md) is built and the Node half is tested
(`node tools/selftest.js`, ~3s, no Game Maker). The GML half **has** now run:
`node build-agent.js` builds unattended, and the checklist below records what
each piece actually did against a real game on 2026-08-19.

**One thing is broken and blocks the network work: the bridge does not survive
whatever a client does on startup.** See "The client bridge dies" below. A
single game and a dedicated server are both fine.

## What was checked, and what it did

In order, because each one is cheap and the later ones assume the earlier ones:

1. `gg2_ping`, `gg2_evalx room_speed` — the bridge is up at all.
2. `gg2_screenshot` — an image comes back, right way up and the right colours.
   `image.js` handles both a BMP and a PNG, but only one of them is what this
   build of GM8 actually writes.
3. `gg2_step` then `gg2_screenshot` — the screenshot of a **frozen** game shows
   the real frame rather than an empty room. This is the reactivate-redraw-
   deactivate trick in `agentBridgeShot`, and it is the one piece of the design
   most likely to disappoint.
4. ~~`gg2_input press right`~~ — **this does not work, and the assumption behind
   it was wrong.** `keyboard_key_press` does not make `keyboard_check` true: not
   in the same frame, not in the next one, not ever (proved with a `gg2_watch`
   on `keyboard_check(ord("Z"))`, which stayed 0 on every frame). Since
   `PlayerControl` builds its `keybyte` from `keyboard_check`, `press` and
   `release` currently drive nothing. See "What input needs next" below.
5. ~~`gg2_input aim`~~ — **hangs.** `window_views_mouse_set` and
   `window_mouse_set` never return when the game window is not the foreground
   window: no reply, no dialog, nothing in any error log, and the game carries
   on normally afterwards. Focus could not be granted to test the other case
   (Windows refuses `SetForegroundWindow` from a background process). Until this
   is understood, `aim` costs a ten-second timeout and does nothing.
6. `gg2_input click 1` — **works.** `mouse_button` is assignable and the value
   sticks across frames.
7. `gg2_wait`, `gg2_watch` — **both work.** (`agentBridgeWatch` read its
   argument as `rest` rather than `argument0` and raised an error every call;
   fixed and verified.)
8. `gg2_test` — a suite reports a count like `45/45 assertions succeeded`. It
   works by evaluating the suite's source with `test_unit_end()` removed and
   reading the counters, because GM8's message box turned out to be unreadable
   from outside (see below). If the count comes back `-1`, the suite never
   reached `test_unit_begin` and something earlier went wrong.
9. `gg2_session start --clients 1` — **the server comes up; the client does
   not.** `session.js` itself did its job: `UseLobby=0`, the server registered
   and opened its bridge, the client launched against `127.0.0.1:8190` on the
   next port. The client's *bridge* is what failed. See below.

## The client bridge dies

Starting the game with `-server <ip> -port <n>` leaves an `AgentBridge` instance
whose Create event has not run: every step raises

    In script agentBridgeStep:
    at position 5: Unknown variable listener

and repeats, 213 dismissed dialogs in one run, so the bridge never listens and
`run-agent.js` times out waiting for the port. `listener` is the first thing
`agentBridgeCreate` assigns, so the instance is stepping without having been
created — most likely the client startup path restarts or re-enters the game in
a way that leaves the persistent instance behind without re-running Create.

Two things to do, in this order:

1. **Make the bridge self-heal.** At the top of `agentBridgeStep`:

   ```gml
   if (not variable_local_exists("listener"))
       agentBridgeCreate();
   ```

   which costs one check a frame and turns a fatal loop into a working bridge
   whatever the room transition did. `agentBridgeCreate` already exits quietly
   without `-agent`, and re-listening on a port it already holds logs FATAL
   rather than raising.
2. **Then find out why**, because a Create event that does not run may be doing
   the same to something else. `game_restart` and the client's room change into
   the game are the two suspects; `global.agentEnabled` surviving while
   `listener` does not would distinguish them.

Neither has been done. Everything else in the checklist above is verified.

## What input needs next

`press`/`release` need a different mechanism. `PlayerControl.Begin Step` builds
a `keybyte` from `keyboard_check` and assigns it to the character's `keyState`,
and that byte is what gets sent to the server - so the promising route is for
the bridge to hold a mask and OR it into `global.myself.object.keyState` from
its own Step, which runs after every Begin Step. That drives the game through
its own representation of held input rather than through the keyboard it cannot
reach. Discrete actions already have a clean route today: the game's own
`Scripts/Input/input*.gml` are callable, so `gg2_eval inputTaunt();` works now.

## Things worth not rediscovering

- **GM8's message box cannot be read from outside.** Verified against the built
  game on 2026-08-19: its `TMessageForm` has exactly one child window, the OK
  button, and `show_message` text is painted onto the form rather than living in
  a control. `TErrorForm` is different — its text is in a `TMemo`, a real window
  that answers `WM_GETTEXT` — so GML errors *are* readable and `E|` lines are
  trustworthy. Anything that needs the words of a `show_message` has to get them
  another way; `gg2_test` reads the assertion counters instead.
- **This machine had no audio endpoint when that check was run.** The game put
  up two unreadable message boxes and terminated before the bridge ever
  listened, which is the documented DirectSound failure and not a bug in the
  tooling. Fix the audio device before concluding anything about the bridge.

- **Every built-in the bridge calls exists in GM8.** Checked against
  `D:\GameDev\Game_Maker_8\fnames`: `screen_save`, `screen_save_part`,
  `screen_redraw`, `keyboard_key_press`, `keyboard_key_release`, `io_clear`,
  `window_views_mouse_set`, `instance_deactivate_all`, `instance_activate_all`,
  `sprite_add`, `sprite_replace`. To check another:
  `require('./tools/gml-lint.js').loadFnames('D:/GameDev/Game_Maker_8')`.
- **The splicer cannot place an empty string.** A blank event would appear
  thousands of times in the code blob and the splice would be ambiguous, which
  is why each `AgentSpare` event holds a distinct placeholder comment, and why
  `gg2_event` refuses to write empty code. Do not tidy those to empty.
- **`gmlerror` falls back to the quoted source line**, and that is usually what
  actually resolves a real error, because GM8 names the object but not the file.
  An agent's own `EVALX` typo correctly resolves to nothing — the string was
  never in the tree — and reports `object AgentBridge` instead of inventing a
  location.
- **The game's own `Contributing.md` forbids `&&`/`||`, but its code uses them.**
  Match the surrounding file. The linter warns and does not fail.
- **Freezing stops the network.** `FREEZE` deactivates the objects that service
  connections too, so a frozen client or server falls behind and may drop. Fine
  for inspecting one game, needs care inside a session.
