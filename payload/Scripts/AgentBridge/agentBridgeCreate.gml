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

// No sprite, so this costs nothing - it is what lets AgentBridge's own Draw event fire
// at all (GM8 skips Draw for an invisible instance regardless of what code is in it).
// Currently only agentBridgeDraw's (unused) in-game overlay path needs this; kept
// enabled since it costs nothing idle and nothing else assumes it is off.
visible = true;
depth = -1000000;

// No BFS result to draw until agentNavReach has been called at least once.
global.agentNavOverlay = false;
global.agentNavReachValid = false;

// gg2_area_shot's HUD-suppression state: off until an EVAL turns it on. See
// agentBridgeHudVisible and agentBridgeShot.
global.agentHideHud = false;

// gg2_speed's boost factor: 1 = normal. See agentBridgeSpeed.
global.agentSpeedFactor = 1;

// A request that cannot be answered in the frame it arrives - STEP counts frames
// down, WAIT re-tests an expression - leaves deferKind set, and agentBridgeDefer
// sends the reply later. Nothing new is read while one is outstanding, so
// replies always come back in the order they were asked for.
deferKind = 0;      // 0 = nothing pending, 1 = stepping, 2 = waiting
deferExpr = "";
deferFrames = 0;
deferTotal = 0;
deferWaitOutcome = "";  // sentinel agentBridgeDefer uses to tell a raised WAIT
                        // expression apart from one that merely evaluated false

// The world is frozen by deactivating every instance except this one, so the
// game stops advancing between agent calls while the bridge keeps answering.
frozen = false;

// True exactly while instance_deactivate_all(true) is in effect - unlike
// "frozen", which stays true for the whole span of a STEP even though STEP
// reactivates every instance for the frames it is actually running. A
// deactivated instance's fields are unreachable (see CLAUDE.md), so this is
// what agentBridgeWatchTick gates sampling on, not "frozen" itself - sampling
// during a STEP's own active frames is exactly the combination worth having.
instancesDeactivated = false;

// Held movement input for INPUT press/release, PlayerControl.Begin Step OR's
// this into its own keybyte - see agentBridgeInput. keyboard_key_press does
// not make keyboard_check true (verified on 2026-08-19: it only affects the
// _pressed/_released edge, not the held state), so a key that must be held
// rather than tapped cannot be driven through the keyboard at all.
heldMask = 0;

// Expressions sampled once a frame; a changed value is written to the log.
watchExpr = ds_list_create();
watchLast = ds_list_create();
watchLabel = ds_list_create();

// True from the frame sampling is skipped for lack of readable instances to
// the frame it resumes - logged exactly on those two edges (see
// agentBridgeWatchTick), not every frame in between.
watchSuspended = false;

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
