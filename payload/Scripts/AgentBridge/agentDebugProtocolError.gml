// void agentDebugProtocolError(string text)
// Replaces the promptRestartOrQuit() in the game's Scripts/Client/clientProtocolError.gml
// when the payload is injected: writes the text to the bridge log, then shows the
// same Restart/Quit prompt a stock client shows.
//
// clientProtocolError is where every stream desync the client can detect ends up:
// a state update declaring a different player count than the client holds, a
// character record for a class the client does not know, and a message id with
// no handler. Its text already carries the diagnosis (both counts, the class, the
// last 16 message ids received), but only ever as a dialog, and GM8 paints that
// text with no window handle - so without this it never reaches a file.
//
// The stock client stops parsing at that point (global.serverStreamBroken) rather
// than reading on at the wrong offset, so there is no downstream fatal to chase
// any more. global.agentFailFast (agentBridgeCreate) turns the prompt into an
// abort, for a run that should end at the first desync.

if (instance_exists(AgentBridge))
    agentBridgeLog("DESYNC " + string_replace_all(argument0, "#", " | "));

if (global.agentFailFast)
    show_error(argument0, true);

promptRestartOrQuit(argument0);
