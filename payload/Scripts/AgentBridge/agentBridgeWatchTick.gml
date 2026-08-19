// Samples every watched expression once, and logs the ones that changed.
// Called at the top of every step, before any request is read.

if (ds_list_size(watchExpr) == 0)
    exit;

var i, value, last;
for (i = 0; i < ds_list_size(watchExpr); i += 1)
{
    value = string(execute_string("return (" + ds_list_find_value(watchExpr, i) + ")"));
    last = ds_list_find_value(watchLast, i);
    if (value == last)
        continue;

    ds_list_replace(watchLast, i, value);
    agentBridgeLog("watch " + ds_list_find_value(watchExpr, i) + " = " + value);
}
