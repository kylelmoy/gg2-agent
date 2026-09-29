// void agentDebugDesync()
// Replaces the bare show_message() in Scripts/Serialization/deserializeState.gml
// when the payload is injected: writes to the bridge log what a screenshot of
// that dialog could never say, then shows the same dialog with the same text a
// stock client shows.
//
// Worth the patch because this warning is the CAUSE and it does not stop
// anything. The client compares the update's declared player count against its
// own list, says so, and carries on deserialising a stream it now knows is
// misaligned - until some later read lands somewhere absurd (a character bit on
// a slot the client holds as a spectator) and kills the game there instead. The
// fatal that gets reported therefore names a symptom two steps downstream, and
// neither string ever reached a file. See agentDebugSpriteError for the other
// half.
//
// global.agentFailFast (agentBridgeCreate; settable live over gg2_eval) turns
// the warning into an abort. It is off by default on purpose: a patched build
// has to behave exactly like a stock client, and a build that dies at the
// mismatch is a better debugger and a worse reproduction of what players see.

if (instance_exists(AgentBridge))
{
    agentBridgeLog("DESYNC deserializeState: server declared " + string(global.agentDeclaredPlayers)
        + " players, client holds " + string(ds_list_size(global.players))
        + ", updateType=" + string(global.updateType));
}

if (global.agentFailFast)
    show_error("Wrong number of players while deserializing state", true);

show_message("Wrong number of players while deserializing state");
