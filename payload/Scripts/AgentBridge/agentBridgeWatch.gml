// string agentBridgeWatch(string rest)
// Manages the watch list: expressions sampled once a frame, whose changes are
// written to the bridge log. Polling a value over MCP samples it whenever the
// agent gets round to asking; a watch samples it every frame, which is the only
// way to see something that is true for three frames and then gone.
//
//   WATCH add <expression>    WATCH clear    WATCH list

var rest, sp, verb, expr, i, out;
rest = argument0;

sp = string_pos(" ", rest);
if (sp == 0)
{
    verb = string_lower(rest);
    expr = "";
}
else
{
    verb = string_lower(string_copy(rest, 1, sp - 1));
    expr = string_copy(rest, sp + 1, string_length(rest) - sp);
}

if (verb == "add")
{
    if (expr == "")
        return "ERR WATCH add needs an expression";

    // Every entry costs an execute_string per frame, so the list stays short.
    if (ds_list_size(watchExpr) >= 8)
        return "ERR the watch list is full (8) - WATCH clear first";

    ds_list_add(watchExpr, expr);
    ds_list_add(watchLast, "<unread>");
    agentBridgeLog("watch added: " + expr);
    return "OK watching " + string(ds_list_size(watchExpr)) + " expression(s)";
}

if (verb == "clear")
{
    ds_list_clear(watchExpr);
    ds_list_clear(watchLast);
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
        out += ds_list_find_value(watchExpr, i) + " = " + string(ds_list_find_value(watchLast, i));
    }
    return "OK " + out;
}

return "ERR WATCH takes add, clear or list";
