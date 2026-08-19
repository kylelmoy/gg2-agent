// Sets up the agent bridge. Called from AgentBridge's Create event.
//
// The bridge configures itself here rather than in game_init, so injecting it
// into a clean checkout only has to add a single line to the game's startup.
// Without -agent the instance simply stays dormant: listener is left at -1 and
// agentBridgeStep exits on its first line.

listener = -1;
sock = -1;
readState = 0;  // 0 = waiting for the 4 byte length header, 1 = waiting for the payload
msgLen = 0;

// A request that cannot be answered in the frame it arrives - STEP counts frames
// down, WAIT re-tests an expression - leaves deferKind set, and agentBridgeDefer
// sends the reply later. Nothing new is read while one is outstanding, so
// replies always come back in the order they were asked for.
deferKind = 0;      // 0 = nothing pending, 1 = stepping, 2 = waiting
deferExpr = "";
deferFrames = 0;
deferTotal = 0;

// The world is frozen by deactivating every instance except this one, so the
// game stops advancing between agent calls while the bridge keeps answering.
frozen = false;

// Expressions sampled once a frame; a changed value is written to the log.
watchExpr = ds_list_create();
watchLast = ds_list_create();

global.agentEnabled = false;
global.agentPort = 17777;

var i;
for (i = 1; i <= parameter_count(); i += 1)
{
    if (parameter_string(i) == "-agent")
        global.agentEnabled = true;
    else if (parameter_string(i) == "-agentport")
        global.agentPort = real(parameter_string(i+1));
}

// One log per port, so two instances of the game in one directory - a dedicated
// server and its clients - do not interleave their logs into one file.
global.agentLogFile = working_directory + "\agent_bridge_" + string(global.agentPort) + ".log";

if (!global.agentEnabled)
    exit;

listener = tcp_listen(global.agentPort);
if (socket_has_error(listener))
{
    agentBridgeLog("FATAL could not listen on port " + string(global.agentPort) + ": " + socket_error(listener));
    socket_destroy(listener);
    listener = -1;
    exit;
}

agentBridgeLog("listening on port " + string(global.agentPort));
