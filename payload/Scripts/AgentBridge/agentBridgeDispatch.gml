// string agentBridgeDispatch(string request)
// Runs one agent request and returns the reply payload.
// Replies are "OK", "OK <text>", or "ERR <text>".

var request, verb, rest, sp;
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

case "QUIT":
    return "OK bye";
}

return "ERR unknown verb " + verb;
