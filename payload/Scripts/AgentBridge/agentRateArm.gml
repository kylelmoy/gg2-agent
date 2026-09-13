// string agentRateArm()
// The frame-rate arm as the game currently has it, for a soak runner to assert
// that boosting the rate did not change what a tick does.
//
// An accelerated soak is only comparable to a real-time one while delta_factor
// and ticks_per_virtual are the ones RateController computes for global.game_fps
// - 1 and 1 at 30 fps, 1/2 and 2 at 60. Read this at the start and end of a run
// and fail the run if it moved.

return "game_fps=" + string(global.game_fps)
    + " room_speed=" + string(room_speed)
    + " delta_factor=" + string(global.delta_factor)
    + " skip_delta_factor=" + string(global.skip_delta_factor)
    + " ticks_per_virtual=" + string(global.ticks_per_virtual)
    + " frameskip=" + string(global.frameskip)
    + " run_virtual_ticks=" + string(global.run_virtual_ticks)
    + " agentRate=" + string(global.agentRate);
