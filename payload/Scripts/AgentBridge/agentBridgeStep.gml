// Services the agent bridge once per step: accepts a local client, then reads
// length prefixed requests and writes length prefixed replies.

// Self-heal: an instance whose Create never ran - the client startup path did
// this at least once, see HANDOFF.md - would otherwise raise "unknown variable
// listener" every step forever. Cheap enough to check unconditionally.
if (not variable_local_exists("listener"))
    agentBridgeCreate();

if (listener < 0)
    exit;

// Sample the watch list first, so a trace records the frame as the game left it
// rather than as this frame's requests have changed it.
agentBridgeWatchTick();

// A deferred reply owns the connection until it is sent. Reading further
// requests before then would answer them out of order.
if (deferKind != 0)
{
    agentBridgeDefer();
    if (deferKind != 0)
        exit;
}

// Accept a connection when we do not already have one.
if (sock < 0)
{
    var incoming;
    incoming = socket_accept(listener);
    if (incoming >= 0)
    {
        // Loopback only. This bridge executes arbitrary GML, so refuse anything
        // that did not originate on this machine, whatever the listener bound to.
        var ip;
        ip = socket_remote_ip(incoming);
        if (ip != "127.0.0.1" and ip != "::1")
        {
            agentBridgeLog("rejected non-local connection from " + string(ip));
            socket_destroy_abortive(incoming);
        }
        else
        {
            sock = incoming;
            set_little_endian(sock, true);
            readState = 0;
            agentBridgeLog("client connected");
        }
    }
    exit;
}

// Drop a broken or closed connection so the next one can be accepted.
if (socket_has_error(sock) or tcp_eof(sock))
{
    agentBridgeLog("client disconnected");
    socket_destroy(sock);
    sock = -1;

    // A client that vanishes mid-request must not leave the world stopped, or
    // the next one finds a game that never advances.
    deferKind = 0;
    if (frozen)
    {
        frozen = false;
        instance_activate_all();
    }
    exit;
}

// Drain whatever complete requests are already buffered. The guard stops one
// very chatty client from starving the rest of the frame.
var guard;
guard = 0;
while (guard < 32)
{
    guard += 1;

    if (readState == 0)
    {
        if (!tcp_receive(sock, 4))
            exit;

        msgLen = read_uint(sock);
        if (msgLen <= 0 or msgLen > 1000000)
        {
            agentBridgeLog("bad frame length " + string(msgLen) + ", dropping client");
            socket_destroy(sock);
            sock = -1;
            exit;
        }
        readState = 1;
    }

    if (readState == 1)
    {
        if (!tcp_receive(sock, msgLen))
            exit;

        var request, reply;
        request = read_string(sock, msgLen);
        readState = 0;

        reply = agentBridgeDispatch(request);
        if (reply == "")
            exit;               // deferred; agentBridgeDefer sends it

        agentBridgeSend(reply);
    }
}
