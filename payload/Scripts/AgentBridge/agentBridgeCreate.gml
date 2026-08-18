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

global.agentEnabled = false;
global.agentPort = 17777;
global.agentLogFile = working_directory + "\agent_bridge.log";

var i;
for (i = 1; i <= parameter_count(); i += 1)
{
    if (parameter_string(i) == "-agent")
        global.agentEnabled = true;
    else if (parameter_string(i) == "-agentport")
        global.agentPort = real(parameter_string(i+1));
}

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
