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
    // WAIT: re-test the expression until it is true or the frames run out.
    //
    // GM8 has no try/catch, so a raising expression cannot be caught directly -
    // but Ignore aborts the nested execute_string() call that raised rather than
    // completing it, it does not coerce the erroring part to 0 and carry on. A
    // sentinel poisoned immediately before the call and read immediately after
    // tells the two apart (verified 2026-08-20 against a running exe, both for a
    // compile error and a runtime one: the assignment inside never lands). Without
    // this, one bad expression cost 344 dismissed dialogs and a 95s timeout before
    // this fix - now it costs exactly one.
    deferFrames -= 1;

    var q;
    q = chr(34);
    deferWaitOutcome = "raised";
    execute_string(
        "if (" + deferExpr + ") deferWaitOutcome = " + q + "true" + q +
        "; else deferWaitOutcome = " + q + "false" + q + ";"
    );

    if (deferWaitOutcome == "raised")
    {
        deferKind = 0;
        agentBridgeSend("ERR WAIT expression raised an error, abandoned after " +
            string(deferTotal - deferFrames) + " frame(s) - see gg2_log source: launcher: " + deferExpr);
        exit;
    }

    if (deferWaitOutcome == "true")
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
