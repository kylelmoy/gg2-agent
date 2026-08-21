// string agentBridgeWatch(string rest)
// Manages the watch list: expressions sampled once a frame, whose changes are
// written to the bridge log. Polling a value over MCP samples it whenever the
// agent gets round to asking; a watch samples it every frame, which is the only
// way to see something that is true for three frames and then gone.
//
//   WATCH add <labelLen>:<label><expression>    WATCH clear    WATCH list
//
// <label> is length-prefixed, not delimited, so it can be empty or contain
// anything without ambiguity - agentBridgeWatchTick falls back to a truncated
// copy of the expression itself when it is empty.

var rest, sp, verb, tail, i, out, label;
rest = argument0;

sp = string_pos(" ", rest);
if (sp == 0)
{
    verb = string_lower(rest);
    tail = "";
}
else
{
    verb = string_lower(string_copy(rest, 1, sp - 1));
    tail = string_copy(rest, sp + 1, string_length(rest) - sp);
}

if (verb == "add")
{
    if (tail == "")
        return "ERR WATCH add needs an expression";

    var cp, labelLen, expr;
    cp = string_pos(":", tail);
    if (cp == 0 or string_digits(string_copy(tail, 1, cp - 1)) != string_copy(tail, 1, cp - 1))
        return "ERR WATCH add's label length prefix is malformed";
    labelLen = real(string_copy(tail, 1, cp - 1));

    label = string_copy(tail, cp + 1, labelLen);
    expr = string_copy(tail, cp + 1 + labelLen, string_length(tail) - (cp + labelLen));
    if (expr == "")
        return "ERR WATCH add needs an expression";

    // Every entry costs an execute_string per frame, so the list stays short.
    if (ds_list_size(watchExpr) >= 8)
        return "ERR the watch list is full (8) - WATCH clear first";

    ds_list_add(watchExpr, expr);
    ds_list_add(watchLast, "<unread>");
    ds_list_add(watchLabel, label);
    agentBridgeLog("watch added: " + expr);
    return "OK watching " + string(ds_list_size(watchExpr)) + " expression(s)";
}

if (verb == "clear")
{
    ds_list_clear(watchExpr);
    ds_list_clear(watchLast);
    ds_list_clear(watchLabel);
    agentBridgeLog("watch cleared");
    return "OK cleared";
}

if (verb == "list")
{
    if (ds_list_size(watchExpr) == 0)
        return "OK nothing is being watched";

    out = "";
    for (i = 0; i < ds_list_size(watchExpr); i += 1)
    {
        if (i > 0)
            out += chr(10);
        label = ds_list_find_value(watchLabel, i);
        if (label == "")
            out += ds_list_find_value(watchExpr, i) + " = " + string(ds_list_find_value(watchLast, i));
        else
            out += label + " (" + ds_list_find_value(watchExpr, i) + ") = " + string(ds_list_find_value(watchLast, i));
    }
    return "OK " + out;
}

return "ERR WATCH takes add, clear or list";
