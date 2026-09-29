// Samples every watched expression once, and logs the ones that changed.
// Called at the top of every step, before any request is read.

if (ds_list_size(watchExpr) == 0)
    exit;

// A deactivated instance's fields are unreachable from anywhere, including a
// plain dot-access read on an id held in a global - see CLAUDE.md. Sampling
// through that raises the same error every frame for as long as it lasts,
// which used to make FREEZE and STEP look broken instead of the game just
// being frozen. Gated on instancesDeactivated rather than "frozen" itself, so
// sampling keeps working across a STEP's own active frames, which is exactly
// the combination worth having.
if (instancesDeactivated)
{
    if (!watchSuspended)
    {
        watchSuspended = true;
        agentBridgeLog("watch sampling suspended (instances unreachable while frozen)");
    }
    exit;
}

if (watchSuspended)
{
    watchSuspended = false;
    agentBridgeLog("watch sampling resumed");
}

var i, value, last, expr, label;
for (i = 0; i < ds_list_size(watchExpr); i += 1)
{
    expr = ds_list_find_value(watchExpr, i);
    value = string(execute_string("return (" + expr + ")"));
    last = ds_list_find_value(watchLast, i);
    if (value == last)
        continue;

    ds_list_replace(watchLast, i, value);

    label = ds_list_find_value(watchLabel, i);
    if (label == "")
    {
        if (string_length(expr) > 24)
            label = string_copy(expr, 1, 24) + "...";
        else
            label = expr;
    }
    agentBridgeLog("watch " + label + " = " + value);
}
