// Closes the agent bridge cleanly.

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

agentBridgeLog("bridge closed");
