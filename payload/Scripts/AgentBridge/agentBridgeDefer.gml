// Finishes the one request that could not be answered in the frame it arrived,
// and sends its reply. Called once per step from agentBridgeStep while
// deferKind is set; clearing deferKind is what lets the next request be read.

if (deferKind == 1)
{
    // STEP: let the world run for exactly this many frames, then stop it again.
    deferFrames -= 1;
    if (deferFrames > 0)
        exit;

    deferKind = 0;
    if (frozen)
        instance_deactivate_all(true);
    agentBridgeSend("OK advanced " + string(deferTotal) + " frame(s)");
    exit;
}

if (deferKind == 2)
{
    // WAIT: re-test the expression until it is true or the frames run out. A
    // failing expression raises a GML error dialog every frame it is tried,
    // which the launcher clears and logs - bounded, because deferFrames is.
    deferFrames -= 1;

    if (execute_string("return (" + deferExpr + ")"))
    {
        deferKind = 0;
        agentBridgeSend("OK true after " + string(deferTotal - deferFrames) + " frame(s)");
        exit;
    }

    if (deferFrames <= 0)
    {
        deferKind = 0;
        agentBridgeSend("ERR still false after " + string(deferTotal) + " frame(s): " + deferExpr);
    }
}
