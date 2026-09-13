// void agentSoakTick()
// Called once a frame from agentBridgeStep. Does nothing unless global.agentSoak
// is on, so the default build is unchanged.
//
// Keeps an unattended soak alive. Both timers below end a run silently rather
// than loudly, which is the worst way for a long measurement to fail:
//
//   PlayerControl.afktimer   forces the team-select screen after 60 s without a
//                            real keypress, which sends PLAYER_CHANGETEAM
//                            (spectator) and destroys the character. The
//                            bridge's synthetic mask does not reset it, and once
//                            it has expired every later join dies on its first
//                            frame - so it looks like the server refusing to
//                            spawn anyone.
//   Spectator.afktimeout     disconnects a spectating client after exactly five
//                            minutes. It does that to a stock server too, so it
//                            is not a port bug, but it ends a soak.
//
// Pinned every frame rather than set once because a map change creates new
// instances of both, and a soak crosses many map changes.

if (!variable_global_exists("agentSoak"))
    global.agentSoak = false;

if (!global.agentSoak)
    exit;

if (instance_exists(PlayerControl))
{
    with (PlayerControl)
    {
        afktimeout = 999999;
        afktimer = 999999;
    }
}

// ⚠️ BOTH variables, on both objects. afktimeout is only the value the timer is
// RESET to; afktimer is the live countdown that actually reaches zero
// (Spectator.events/End Step.xml:110-117, `afktimer -= 1 * global.delta_factor`
// then disconnect at <= 0). Pinning the timeout alone leaves the countdown
// running and the client still drops - measured, and at a boosted rate it drops
// fast: 9000 frames is five minutes at 30 fps and thirty-eight seconds at 240.
//
// That proportionality is the general hazard of an accelerated soak. Every timer
// the game counts in FRAMES arrives sooner in wall-clock time by exactly the
// boost factor, so a run long enough to be interesting in game time trips clocks
// a real session never reaches.
if (instance_exists(Spectator))
{
    with (Spectator)
    {
        afktimeout = 999999;
        afktimer = 999999;
    }
}
