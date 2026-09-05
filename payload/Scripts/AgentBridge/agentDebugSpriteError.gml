// void agentDebugSpriteError(real which, class, team, animation)
//   which: 0 = the class id was the unknown one, 1 = the team id was
//   class/team: whatever getCharacterSpriteId held at the point it gave up -
//   either may already have been swapped for its sprite-name prefix string
//
// Replaces both show_error() calls in Scripts/Misc/getCharacterSpriteId.gml.
//
// Two reasons this one is the highest-value site in the payload. The stock
// message names only the id that was bad - "unknown team ID: 2" is
// TEAM_SPECTATOR, which is the one part already known - so the class, the
// animation and which slot asked are exactly the missing pieces. And
// show_error(..., true) aborts, so there is no "log it afterwards": logging
// before the call is the only order in which any of it survives.
//
// Raises the identical error with the identical text afterwards, so an injected
// build dies where and how a stock one does.

var message, slot, count;

if (argument0 == 0)
    message = "Attempted to get a sprite for unknown class ID: " + string(argument1);
else
    message = "Attempted to get a sprite for unknown team ID: " + string(argument2);

if (instance_exists(AgentBridge))
{
    // Nothing here may assume it is in a game. getCharacterSpriteId is reached
    // from the menu too - setBasicHeadPoses at startup, gearSpecApply from the
    // class-select preview - and global.players does not exist until a game
    // does. An unguarded read raises a second error inside the handler for the
    // first, which is how this was caught: the very first live provocation of
    // this script died on "Unknown variable players" and logged nothing at all.
    // The linter cannot see that; only running it can.
    //
    // `player` is the same rule one level down. A GM8 script runs in its
    // caller's scope, so it is the Character's own when Character/Create asks
    // (set well before the sprite lookups) and simply absent everywhere else.
    slot = -1;
    count = -1;
    if (variable_global_exists("players"))
    {
        count = ds_list_size(global.players);
        if (variable_local_exists("player"))
            slot = ds_list_find_index(global.players, player);
    }

    agentBridgeLog("FATAL getCharacterSpriteId: " + message
        + " | class=" + string(argument1)
        + " team=" + string(argument2)
        + " animation=" + string(argument3)
        + " slot=" + string(slot)
        + " of " + string(count));
}

show_error(message, true);
