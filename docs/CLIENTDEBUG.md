# Reading a client failure out of a log, instead of a screenshot

Game Maker 8 reports a failure by putting a modal dialog on the screen and
stopping. `tools/launcher.js` dismisses those dialogs and records them, but
Delphi paints some captions with no window handle at all, so a great many of
them reach `agent_launcher_<port>.log` as `(dialog had no readable text)`. The
recovery is to screenshot the dialog and read the picture — which works, and
costs a round trip and a human eye every single time.

The payload closes that gap for the failures that have actually bitten. It does
not do it by branching the game.

## The mechanism: `CODE_PATCHES`

`tools/payload.js` carries a small table of call sites in the game's own code.
`inject.js` rewrites each one; `cleanup.js` puts it back. They are the same kind
of edit `INIT_ANCHOR` and `KEYSTATE_ANCHOR` already were — the payload has always
patched the game's code, this is just more of it — and they come and go with the
bridge, so nothing reaches the game's repository.

Each replacement calls a payload script that logs through `agentBridgeLog` and
then does exactly what the stock line did.

## The rule this cost a design to learn

**Several of these call sites are the braceless body of an `if`. You cannot
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
and a build that behaves differently from what players run answers a different
question. A build that aborts at the count mismatch is a better debugger and a
worse reproduction.

So each replacement script re-raises the identical stock message, with the
identical text, and fail-fast is opt-in: `global.agentFailFast`, initialised
`false` in `agentBridgeCreate` (before the `-agent` check, so a build with no
bridge still logs), flipped live with `gg2_eval` when the mismatch is the thing
being hunted.

## The sites, and why each earns its place

### The desync report — `deserializeState.gml`

```
163276375  DESYNC deserializeState: server declared 6 players, client holds 0, updateType=0
```

The stock client warns about a player-count mismatch and then **carries on
deserialising a stream it knows is misaligned**, so the fatal that eventually
gets reported names a symptom two steps downstream (see `getCharacterSpriteId`
below). Two patches: `agentDebugStateCount` wraps the `read_ubyte` inside the
`if` — the declared count is consumed in the condition, so by the next line it is
gone — and hands the byte straight back; `agentDebugDesync` replaces the
`show_message` body, logs both counts and the update type, and then shows the
identical message.

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
3. Add the `{ file, from, to }` entry to `CODE_PATCHES` — or, if versions of
   the game disagree about the line, a `{ site, variants }` entry with upstream's
   shape first. `resolvePatches` picks the first variant a tree matches before
   `inject.js` touches anything; a tree that matches none is built without the
   site and says so, and `cleanup.js` looks for every variant's replacement.
4. `node tools/selftest.js` — the *payload call-site patches* section checks the
   anchor is still exactly one line of the real tree, that every `agent*` call in
   a replacement is a registered script, and that inject/cleanup round-trips byte
   for byte.
5. `node build-fast.js` (or `gg2_rebuild`). A new script builds like any
   other change.

## The audio site, which is not debug logging

`AudioControlPlaySong.gml`'s first line is replaced by `agentAudioStopSong`,
always on and observationally identical to stock.

`WinBanner`'s Create reaches `AudioControlPlaySong` unguarded, so a round ending
raises `Unknown variable currentSong` where that variable is absent — including
with `Music=3`, which only guards `basicRoomSetup.gml:79`. The launcher dismisses
it, but one modal per round end still stalls the game while it waits, and a
client sped up with `gg2_speed` can fall far enough behind to be dropped by its
server.

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
| `cleanup.js` | checkout back to only its own unrelated changes |

One thing that read oddly and is worth knowing: a count planted with `gg2_eval`
was **already overwritten** by the time the next `gg2_eval` called the logger, so
both logged lines read `declared 2, holds 2` rather than the planted numbers. The
game runs between two calls. That is the wrapper working — the value is
re-sourced from the live stream on every state update — but it means the desync
line cannot be faked from outside in two calls; plant and log in one `gg2_eval`
if you ever need to.

Re-checked 2026-09-28 on an upstream build (`ea8d6951`): planting a count and
calling `agentDebugDesync()` in one `gg2_eval` logged the line quoted above and
the game stayed up.

## Not done

A **message ring buffer** — the last N message types and lengths the client read,
dumped from the desync site. A desync is a framing failure and the bytes leading
into it are the evidence; nothing recovers them after the fact. It is the one
addition with a real cost on a per-message path, and the bridge's own per-frame
cost was measured at zero, so it should be held to the same bar. The desync
cannot be provoked on demand, which is what would make it worth building: it
says what happened from a real occurrence, where anything else has to guess the
path first.
