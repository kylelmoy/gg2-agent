# Reading a client failure out of a log, instead of a screenshot

Game Maker 8 reports a failure by putting a modal dialog on the screen and
stopping. `tools/launcher.js` dismisses those dialogs and records them, but
Delphi paints some captions with no window handle at all, so a great many of
them reach `agent_launcher_<port>.log` as `(dialog had no readable text)`. The
recovery is to screenshot the dialog and read the picture — which works, and
which is how two real bugs were cracked on 2026-09-05, and which costs a round
trip and a human eye every single time.

The payload closes that gap for the failures that have actually bitten. It does
not do it by branching the game.

## The mechanism: `CODE_PATCHES`

`tools/payload.js` carries a small table of call sites in the game's own code.
`inject.js` rewrites each one; `cleanup.js` puts it back. They are the same kind
of edit `INIT_ANCHOR` and `KEYSTATE_ANCHOR` already were — the payload has always
patched the game's code, this is just more of it — and they come and go with the
bridge, so nothing reaches the public fork.

Each replacement calls a payload script that logs through `agentBridgeLog` and
then does exactly what the stock line did.

## The rule this cost a design to learn

**Both interesting call sites are the braceless body of an `if`. You cannot
insert a line next to one of those.** An inserted neighbour does not join the
branch — it displaces the original out of it:

```gml
if(read_ubyte(global.tempBuffer) != ds_list_size(global.players))
    show_message("Wrong number of players while deserializing state");
```

Insert *after* the `show_message` and the inserted line becomes the statement
following the `if`, so it fires on every state update — thirty times a second,
for a condition that was false. Insert *before* it and the inserted line becomes
the body and `show_message` becomes unconditional. In `getCharacterSpriteId` the
same mistake is worse in the same way: the line is the body of an `else` whose
call is `show_error(..., true)`, so hoisting it out aborts the game on *every*
sprite lookup.

So the edit is a **line replacement**, `lib.replaceLine(file, from, to)` — one
line for one line, the original indentation kept. That is its own inverse:
`replaceLine(file, to, from)` restores the file byte for byte, which is what
`cleanup.js` does and what `selftest.js` asserts.

`insertLine` remains right for a line that stands on its own, like
`instance_create(0, 0, AgentBridge);`. The distinction is not style. Check what
the anchor line is the body *of* before choosing.

## The rule that must not bend

**The default build is observationally identical to a stock client.**

Logging is additive. "Fail loudly" is not — it changes *when* the client dies,
and the entire value of driving a real client against another implementation is
asking whether a **stock** client survives what the server writes. A build that
aborts at the count mismatch is a better debugger and a worse oracle.

So each replacement script re-raises the identical stock message, with the
identical text, and fail-fast is opt-in: `global.agentFailFast`, initialised
`false` in `agentBridgeCreate` (before the `-agent` check, so a build with no
bridge still logs), flipped live with `gg2_eval` when the mismatch is the thing
being hunted.

## The sites, and why each earns its place

### `clientProtocolError.gml` — every desync the client detects

```
666593312  DESYNC live test of the log patch |  | Last messages received from the server, oldest first: | 6, 6, 6, 6, 9, 6, 6, 6, 6, 6, 6, 9, 6, 6, 6, 6
```

This site used to be two patches in `deserializeState.gml`, which warned about
a player-count mismatch and then **carried on deserialising a stream it knew was
misaligned**, so the fatal that eventually got reported named a symptom two
steps downstream. The game's `desync-fixes` branch (kylelmoy/Gang-Garrison-2)
changed the stock client: that mismatch, a character
record for an unknown class, and a message id with no handler all go through
`Scripts/Client/clientProtocolError.gml`, which stops parsing
(`global.serverStreamBroken`) and shows a Restart/Quit prompt whose text already
names both counts, the class, or the last 16 message ids. The only thing left to
add is getting that text into a file, so this is one patch on the
`promptRestartOrQuit(text);` line; `agentDebugProtocolError` logs the text with
`#` turned into ` | ` and then shows the identical prompt.

That branch changes the stock behaviour this tooling is an oracle for: a stock
client now stops at the first detected desync instead of reading on. With the
launcher dismissing the prompt it neither restarts nor quits, it just stops
reading from the server.

### `getCharacterSpriteId.gml` — the fatal, which names only what was already known

```
778761734  FATAL getCharacterSpriteId: Attempted to get a sprite for unknown team ID: 2 | class=Scout team=2 animation=Stand slot=-1 of -1
```

The stock message names only the id that was bad. `2` is `TEAM_SPECTATOR`, which
is the one part of it nobody needed telling. The class, the animation and which
slot asked are the missing pieces — and `show_error(..., true)` aborts, so
logging *before* the call is the only order in which any of them survive.

`class=Scout` rather than `0` because `getCharacterSpriteId` swaps the class id
for its sprite-name prefix before it reaches the team check. `slot=-1 of -1`
because that provocation was fired at the menu, where there is no game.

### Nothing in a handler may assume it is in a game

That last part is the one rule here that a linter cannot enforce, and the very
first live run of this payload broke it. `agentDebugSpriteError` read
`ds_list_size(global.players)` unguarded — and `getCharacterSpriteId` is reached
from the menu too, via `setBasicHeadPoses` at startup and `gearSpecApply` from
the class-select preview, where `global.players` does not exist yet. The result
was `Unknown variable players`: **a second error raised inside the handler for
the first, and nothing at all in the log.** `gml-lint` passed it, because
whether a global exists is a runtime fact.

So every read of game state in one of these scripts is guarded —
`variable_global_exists("players")` before the list, `variable_local_exists("player")`
before the caller's own (a GM8 script runs in its caller's scope, so `player` is
the Character's when `Character/Create` asks and simply absent everywhere else).
A handler that can fail is worse than no handler: it replaces a bad message with
no message.

## Adding a site

`show_message`/`show_error` appear about 93 times across `Scripts/` and in nine
object event files. **Do not try to cover them all.** Every anchor is a brittle
exact-match string, and almost all of those sites are menu and hosting paths no
automated run ever reaches. Patch what has bitten; add a site when one bites.

To add one:

1. Read the call site and decide whether the line is the body of something.
2. Add a script to `payload/Scripts/AgentBridge/` **and register it** in that
   directory's `_resources.list.xml`. It must end by doing what the stock line
   did.
3. Add the `{ file, from, to }` entry to `CODE_PATCHES`.
4. `node tools/selftest.js` — the *payload call-site patches* section checks the
   anchor is still exactly one line of the real tree, that every `agent*` call in
   a replacement is a registered script, and that inject/cleanup round-trips byte
   for byte.
5. `node build-fast.js` (or `gg2_rebuild`). A new script builds like any
   other change.

## The soak sites, which are not debug logging

Four of the patched sites exist to make an unattended, accelerated, hours-long
run against another server implementation possible rather than to route a failure
into the log. Same rules: one line for one line, and each replacement is a no-op
unless its global has been turned on.

| Site | Script | Global |
|---|---|---|
| `RateController.events/Begin Step.xml`, both `room_speed =` lines | `agentRoomSpeed` | `agentRate`, 0 = off |
| `Character.events/User Event 13.xml`, the position block's first and last read | `agentSnapBegin` / `agentSnapEnd` | `agentSnap`, false = off |
| `AudioControlPlaySong.gml`, its first line | `agentAudioStopSong` | always on, and observationally identical |

`agentSoakTick` is called from `agentBridgeStep` and needs no site.

### Why `agentRoomSpeed` rather than `agentBridgeSpeed`

`agentBridgeSpeed` deactivates `RateController` so a different `room_speed`
sticks. That is the right trade for a look at something and the wrong one for a
soak, in two ways its own header already names one of:

- **A room change ends the boost.** A new room means a new `RateController`,
  active and unaware, resetting `room_speed` on its next Begin Step. A soak
  crosses a map change every few minutes, so the boost is gone almost
  immediately. Patching the assignment means the new instance runs the patched
  line too and the rate simply survives.
- **`run_virtual_ticks` stops being maintained.** `RateController`'s *Step* is
  what sets it, and a deactivated instance runs no Step. Harmless in the 30 fps
  arm, where `ticks_per_virtual` is 1 and the flag is true every frame. Not
  harmless in the 60 fps arm, where it alternates: freezing it breaks the
  virtual-tick cadence the simulation advances on.

Patching the line keeps the instance active, so `delta_factor`,
`skip_delta_factor`, `ticks_per_virtual` and `frameskip` all keep the values
`RateController` just computed. `agentRateArm()` reads them back, and a soak
should assert they did not move: that invariant is the whole reason an
accelerated run measures the same simulation a real-time one does. Verified in
both arms under boost.

### The snap probe

The two sites in `User Event 13` bracket the authoritative position block a
client hard-assigns every seventh tick, so the predicted and the authoritative
values are both in hand in the same frame. That is the only way to measure the
correction at all — between updates a client's state *is* its prediction.

The block's last statement is `moveStatus = (temp >> 1) & $07;`, and the event
XML stores that line escaped (`&gt;&gt;`, `&amp;`), so an anchor for it would
have to carry the escaping. `hp = read_ubyte(...)` is the last line that assigns
anything the probe reads and it is plain text, so it is the anchor instead. Both
anchors are plain statements inside a braced `if`, so neither is the body of
anything.

`agentSnapReport()` prints count, mean, max and three threshold counts per
field. The numbers themselves, and what they establish about the 60 fps arm,
live in `gg2-server`'s `docs/TRAPS-LIVEGAME.md` — measurements belong with the
implementation they measure.

### The audio site

`WinBanner`'s Create reaches `AudioControlPlaySong` unguarded, so a round ending
raises `Unknown variable currentSong` where that variable is absent — including
with `Music=3`, which only guards `basicRoomSetup.gml:79`. One modal per round
end is survivable by hand and not by an unattended run: at a boosted rate,
dismissing it stalled a client until the server dropped the connection.

`agentAudioStopSong` makes the stock script safe and then does what the stock
line did. **Why the variable goes missing is not established**, and the
misplaced parenthesis in `AudioControl.events/Create.xml` is not it — GM8 parses
`if(instance_number(X)) > 1 { ... }` as intended, measured against an object with
exactly one instance.

## What was measured, 2026-09-05

Built with `build-agent.js`, run against a `gg2_session` server and one client:

| Check | Result |
|---|---|
| `getCharacterSpriteId(0, 2, "Stand")` through the patched call site | `FATAL ...` in `agent_bridge_17777.log`, then the identical stock `show_error` |
| `global.agentDeclaredPlayers` on a connected client | `-1` at startup, `2` once state updates arrive — the wrapped `read_ubyte` is live |
| the same client's own `ds_list_size(global.players)` | `2`, so the counts agree and `agentDebugDesync` correctly never fired |
| `gg2_state` on that client | two players, `CustomMapRoom`, playing normally |
| `agentDebugDesync()` with `agentFailFast` off | `DESYNC ... updateType=6` logged, client **still alive** afterwards |
| `agentDebugDesync()` with `agentFailFast` on | aborts with the stock text, `Wrong number of players while deserializing state` |
| `cleanup.js` | fork back to only its own unrelated changes; `selftest` 191/191 |

One thing that read oddly and is worth knowing: a count planted with `gg2_eval`
was **already overwritten** by the time the next `gg2_eval` called the logger, so
both logged lines read `declared 2, holds 2` rather than the planted numbers. The
game runs between two calls. That is the wrapper working — the value is
re-sourced from the live stream on every state update — but it means the desync
line cannot be faked from outside in two calls; plant and log in one `gg2_eval`
if you ever need to.

The `agentDebugDesync` and `agentDeclaredPlayers` rows describe the two
`deserializeState` patches that `agentDebugProtocolError` replaced. The new site,
measured 2026-09-23 against the game's `desync-fixes` branch with a server and
two clients: calling `clientProtocolError("live test of the log patch")` on a
client logged the line quoted above (message 6 is `INPUTSTATE`, 9 is
`QUICK_UPDATE`), the launcher force-closed the prompt, and the client stayed up
with `global.serverStreamBroken` set.

## Not done

A **message ring buffer** — the last N message types and lengths the client read,
dumped from these two sites. (The game's `desync-fixes` branch now keeps the last
16 message *ids* itself and puts them in the `clientProtocolError` text; lengths
are still not recorded.) A desync is a framing failure and the bytes leading
into it are the evidence; nothing recovers them after the fact. It is the one
addition with a real cost on a per-message path, and the bridge's own per-frame
cost was measured at zero, so it should be held to the same bar.

**What decides whether it is worth building.** The desync cannot be provoked on
demand, and as of 2026-09-05 an in-process harness against the C# port cannot
provoke it either — but the negative is now specific rather than general, which
is what makes the ring buffer the next move rather than more harness work. A
client joined in the same tick as a bot fill change, across six fills forcing
both adds and removals, with a player-count check armed on the mirror, **stays
clean**; and the tick order explains why, since the population service runs well
ahead of the accept and join-servicing calls, so the join burst already sees the
post-removal roster. What that does not cover is the population manager
*auto-displacing* a bot to seat an arriving human — the exact line pair the live
failure showed (`bot [BOT] 5 removed from player 5` immediately followed by
`Player joined as player 6`). So the manual path is clean and the automatic one
is untested, and the two are not obviously the same code. A ring buffer says
which side the truth is on from a real occurrence, where the harness has to guess
the path first.
