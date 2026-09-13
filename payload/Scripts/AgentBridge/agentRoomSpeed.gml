// void agentRoomSpeed(stockSpeed)
// Replaces both `room_speed = 30;` and `room_speed = 60;` in
// Objects/RateController.events/Begin Step.xml. Applies global.agentRate when
// it is set and the stock value otherwise, so the default build is
// observationally identical to a stock client.
//
// WHY THIS RATHER THAN agentBridgeSpeed. That one deactivates RateController,
// which is the right trade for a quick look and the wrong one for a soak:
//
//   a room change ends it   - a new room means a new RateController, active and
//                             unaware, so the boost dies at every map change.
//                             Patching the line means the new instance runs the
//                             patched line too and the rate simply survives.
//   run_virtual_ticks stops - RateController's *Step* is what maintains it
//                             (`global.run_virtual_ticks = (ticks < 1)`), and a
//                             deactivated instance runs no Step. Harmless in
//                             the 30 fps arm, where ticks_per_virtual is 1 and
//                             the flag is true every frame; NOT harmless in the
//                             60 fps arm, where it alternates and freezing it
//                             breaks the virtual-tick cadence the simulation
//                             advances on.
//
// Per-tick logic is untouched either way: this replaces only the room_speed
// assignment, so global.delta_factor, skip_delta_factor, ticks_per_virtual and
// frameskip keep the values RateController just computed for the arm in force.
// That is what makes an accelerated soak measure the same simulation a
// real-time one does, and agentRateArm() is the assertion for it.

// RateController's Begin Step can run before AgentBridge's Create on the first
// frame, and an unset global here would raise every frame forever - which at a
// boosted rate is a dialog storm that ends the client's connection.
if (!variable_global_exists("agentRate"))
    global.agentRate = 0;

if (global.agentRate > 0)
    room_speed = global.agentRate;
else
    room_speed = argument0;
