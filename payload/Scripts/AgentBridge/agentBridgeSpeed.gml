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
// Not sticky: gg2_step, gg2_wait, gg2_resume and a frozen gg2_screenshot all
// call instance_activate_all(), which reactivates RateController right along
// with everything else and lets it reset room_speed on its next Begin Step -
// see gg2_speed's tool description.

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
