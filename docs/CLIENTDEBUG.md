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

### `deserializeState.gml` — the desync, which is the cause and only warns

```
DESYNC deserializeState: server declared 6 players, client holds 5, updateType=1
```

The client compares the state update's declared player count against its own
list, says so, and **carries on deserialising a stream it now knows is
misaligned**. Everything after that point is read at the wrong offset, until
some later read lands somewhere absurd — a character bit on a slot the client
holds as a spectator — and kills the game *there*. So the fatal that gets
reported names a symptom two steps downstream, and neither string ever reached a
file.

Two patches, not one, because **the declared count is consumed inside the `if`
condition** and is gone by the next line:

```gml
if(agentDebugStateCount(read_ubyte(global.tempBuffer)) != ds_list_size(global.players))
    agentDebugDesync();
```

`agentDebugStateCount` stores the byte in `global.agentDeclaredPlayers` and
returns it unchanged, so the comparison is the stock comparison. It costs one
script call per state update — the same order as the dozens the receive loop
already makes each frame. "The server said 6, we hold 5" is the diagnosis; "we
hold 5" on its own is not, which is why this was worth a second patch rather
than a whole replaced file.

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
5. `node build-agent.js`. A genuinely new script cannot be spliced by
   `build-fast.js`; that is what `agentScriptSpare0..5` are for while a script is
   still being written.

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

## Not done

A **message ring buffer** — the last N message types and lengths the client read,
dumped from these two sites. A desync is a framing failure and the bytes leading
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
