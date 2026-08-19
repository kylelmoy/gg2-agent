// Closes the agent bridge cleanly.

// Never leave the game deactivated: an agent that froze the world and then
// crashed out would otherwise leave a window that draws nothing.
if (frozen)
{
    instance_activate_all();
    frozen = false;
}

if (sock >= 0)
{
    socket_destroy(sock);
    sock = -1;
}

if (listener >= 0)
{
    socket_destroy(listener);
    listener = -1;
}

ds_list_destroy(watchExpr);
ds_list_destroy(watchLast);

agentBridgeLog("bridge closed");
