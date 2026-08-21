// string agentBridgeDispatch(string request)
// Runs one agent request and returns the reply payload.
// Replies are "OK", "OK <text>", or "ERR <text>".
//
// An empty return means the reply is deferred: the request set deferKind, and
// agentBridgeDefer will send it once the frames or the condition it is waiting
// on are done with.

var request, verb, rest, sp, n;
request = argument0;

sp = string_pos(" ", request);
if (sp == 0)
{
    verb = request;
    rest = "";
}
else
{
    verb = string_copy(request, 1, sp - 1);
    rest = string_copy(request, sp + 1, string_length(request) - sp);
}

switch (verb)
{
case "PING":
    return "OK pong";

case "EVAL":
    // Runs GML for its side effects.
    execute_string(rest);
    return "OK";

case "EVALX":
    // Evaluates a GML expression and returns the result. Same trick
    // asset_get_index() already uses in this codebase.
    return "OK " + string(execute_string("return " + rest));

case "STATE":
    return "OK " + agentBridgeState();

case "SHOT":
    return agentBridgeShot(rest);

case "INPUT":
    return agentBridgeInput(rest);

case "WATCH":
    return agentBridgeWatch(rest);

case "FREEZE":
    // Stop the world. Deactivating every instance but this one leaves the
    // bridge answering while nothing else in the game advances.
    if (!frozen)
    {
        frozen = true;
        instance_deactivate_all(true);
        instancesDeactivated = true;
    }
    return "OK frozen";

case "RESUME":
    if (frozen)
    {
        frozen = false;
        instance_activate_all();
        instancesDeactivated = false;
    }
    return "OK running";

case "STEP":
    // Advance a fixed number of frames, then reply. Deferred, because the
    // frames have not happened yet.
    n = 1;
    if (string_digits(rest) == rest and rest != "")
        n = real(rest);
    if (n < 1)
        n = 1;
    if (n > 3600)
        n = 3600;
    if (frozen)
    {
        instance_activate_all();
        instancesDeactivated = false;
    }
    deferKind = 1;
    deferFrames = n;
    deferTotal = n;
    return "";

case "WAIT":
    // WAIT <frames> <setupLen>:<setup><expression>: run <setup> (if any) once,
    // immediately, then reply once <expression> is true, or give up after that
    // many frames. <setup> is length-prefixed rather than delimited, so it can
    // contain anything - including a colon - without ambiguity.
    //
    // Running <setup> here, synchronously inside the same request that arms the
    // wait, is what makes "place a bot, then wait for it to arrive" a single
    // measurement instead of two calls with an unknown amount of real game time
    // between them - see HANDOFF.md.
    sp = string_pos(" ", rest);
    if (sp == 0)
        return "ERR WAIT needs a frame budget and an expression";
    n = 0;
    if (string_digits(string_copy(rest, 1, sp - 1)) == string_copy(rest, 1, sp - 1))
        n = real(string_copy(rest, 1, sp - 1));
    if (n < 1)
        n = 1;
    if (n > 3600)
        n = 3600;

    var tail, cp, setupLen, setup;
    tail = string_copy(rest, sp + 1, string_length(rest) - sp);
    cp = string_pos(":", tail);
    if (cp == 0 or string_digits(string_copy(tail, 1, cp - 1)) != string_copy(tail, 1, cp - 1))
        return "ERR WAIT's setup length prefix is malformed";
    setupLen = real(string_copy(tail, 1, cp - 1));

    setup = string_copy(tail, cp + 1, setupLen);
    deferExpr = string_copy(tail, cp + 1 + setupLen, string_length(tail) - (cp + setupLen));

    if (setup != "")
        execute_string(setup);

    deferKind = 2;
    deferFrames = n;
    deferTotal = n;
    return "";

case "SPEED":
    // SPEED <factor> - real, 0 or below restores normal speed. See
    // agentBridgeSpeed for why deactivating RateController is required.
    if (rest == "")
        return "ERR SPEED needs a factor";
    n = agentBridgeSpeed(real(rest));
    return "OK room_speed " + string(n) + " (factor " + string(global.agentSpeedFactor) + ")";

case "QUIT":
    return "OK bye";
}

return "ERR unknown verb " + verb;
