# The first live run

Everything described in [`CLAUDE.md`](CLAUDE.md) is built, and the Node half of
it is tested — `node tools/selftest.js` exercises the wire protocol, instance
routing, the error gate, event editing, the screenshot conversion and the test
reader against a fake game, in about three seconds.

**The GML half has still never executed inside the game.** The new bridge
scripts and the `AgentSpare` objects change the resource set, which no amount of
splicing can express, so they only exist once someone has run:

```powershell
node build-agent.js      # opens the IDE and waits for File > Create Executable
```

Until that happens `build-fast.js` refuses — correctly, and it does so today —
with a tree-hash mismatch. It will not hand anyone a stale executable.

## What to check once it is built

In order, because each one is cheap and the later ones assume the earlier ones:

1. `gg2_ping`, `gg2_evalx room_speed` — the bridge is up at all.
2. `gg2_screenshot` — an image comes back, right way up and the right colours.
   `image.js` handles both a BMP and a PNG, but only one of them is what this
   build of GM8 actually writes.
3. `gg2_step` then `gg2_screenshot` — the screenshot of a **frozen** game shows
   the real frame rather than an empty room. This is the reactivate-redraw-
   deactivate trick in `agentBridgeShot`, and it is the one piece of the design
   most likely to disappoint.
4. `gg2_input press right` plus `gg2_step 10` — the player moves.
   `keyboard_key_press` is assumed to make `keyboard_check` true until released,
   which is what `PlayerControl` reads. If it turns out to be a one-frame pulse,
   `agentBridgeInput` needs to hold the key itself.
5. `gg2_input click 1` — `mouse_button` is assumed to be assignable. If it is
   read-only, drop `click` from `agentBridgeInput`: `PlayerControl` maps the
   bound `attack` key to the same fire bit, so `press attack` already covers it.
6. `gg2_wait`, `gg2_watch` — deferred replies come back in order, and a watch
   trace appears in `gg2_log`.
7. `gg2_test` — a suite reports a count like `45/45 assertions succeeded`. It
   works by evaluating the suite's source with `test_unit_end()` removed and
   reading the counters, because GM8's message box turned out to be unreadable
   from outside (see below). If the count comes back `-1`, the suite never
   reached `test_unit_begin` and something earlier went wrong.
8. `gg2_session start --clients 1` — a server and a client come up on separate
   ports, `gg2_state` differs between them, and stopping one leaves the other
   alone.

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
