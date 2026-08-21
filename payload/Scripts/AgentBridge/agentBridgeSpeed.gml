// number agentBridgeSpeed(factor)
// Sets how many real seconds one game tick takes: factor times normal (30 or
// 60, whichever global.game_fps currently means). factor <= 0 restores
// normal speed. Returns the room_speed now in effect.
//
// RateController.Begin Step (Objects/RateController.events/Begin Step.xml)
// resets room_speed back to 30 or 60 every single frame, so a plain
// `room_speed = ...` gets stomped within one frame - deactivating
// RateController first is what makes a different value stick.
//
// Per-tick game logic is untouched: RateController only recalculates
// global.delta_factor/frameskip/ticks_per_virtual for its own two supported
// rates, and deactivating it leaves those exactly as they were - so this
// changes how many real seconds a tick takes, not what a tick does. Verified
// live 2026-08-20: factor 10 measured 296.7 sim-fps against a 30.0 sim-fps
// baseline, with an exact restore to 30.0 on reset.
//
// WHAT ACTUALLY ENDS THE BOOST - measured 2026-08-21, because the list that
// used to be here was wrong and cost a harness a polling loop it did not need.
//
//   a room change      ends it. A new room means a new RateController, active
//                      and unaware, resetting room_speed on its next Begin
//                      Step. Measured: 600 before serverGotoMap, 30 after.
//                      This is the one that actually bites.
//   un-freezing        ends it, because instance_activate_all() brings
//                      RateController back with everything else: RESUME, a
//                      frozen gg2_screenshot, and STEP *when the game was
//                      already frozen*.
//   WAIT               does NOT end it, and neither does EVAL. WAIT never
//                      touches instances - it re-tests its expression from
//                      agentBridgeDefer and nothing else. Measured: 600 frames
//                      waited in 1022ms (~587 fps), room_speed still 600
//                      afterwards. "Fast-forward and wait for a condition" is
//                      therefore one call, and needs no polling loop.
//   STEP while running does not end it either - STEP only reactivates if it
//                      found the game frozen.

var factor, base;
factor = argument0;

if (global.game_fps == 60)
    base = 60;
else
    base = 30;

if (factor <= 0)
{
    instance_activate_object(RateController);
    room_speed = base;
    global.agentSpeedFactor = 1;
}
else
{
    instance_deactivate_object(RateController);
    room_speed = round(base * factor);
    if (room_speed < 1)
        room_speed = 1;
    global.agentSpeedFactor = factor;
}

return room_speed;
