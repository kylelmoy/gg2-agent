// Services the agent bridge once per step: accepts a local client, then reads
// length prefixed requests and writes length prefixed replies.

// Self-heal: an instance whose Create never ran - the client startup path did
// this at least once, see HANDOFF.md - would otherwise raise "unknown variable
// listener" every step forever. Cheap enough to check unconditionally.
if (not variable_local_exists("listener"))
    agentBridgeCreate();

// F11 toggles the diagnostic labels agentBridgeDraw paints over every Character. A real
// key press is enough: keyboard_check is only unreliable for the *synthetic* presses
// gg2_input sends (CLAUDE.md), and a person's own keyboard reaches the _pressed edge
// normally. Ahead of the listener check on purpose - the labels are for whoever is
// looking at the window, whether or not an agent is connected to this instance.
if (keyboard_check_pressed(vk_f11))
    global.agentLabels = !global.agentLabels;

if (listener < 0)
    exit;

// Sample the watch list first, so a trace records the frame as the game left it
// rather than as this frame's requests have changed it.
agentBridgeWatchTick();

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
//
// Ahead of the deferred reply below, and that ordering is the whole of what
// makes a wedged bridge recoverable: while a STEP or a WAIT is outstanding this
// script answers nothing else, so a client that gave up on one and reconnected
// used to sit in the accept backlog for the rest of its frame budget - up to
// two minutes - with the game plainly alive and every call timing out. Checked
// live on 2026-08-22, before and after. Dropping the connection is all a client
// can do to reach a bridge that has stopped reading, so it has to be enough.
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
        instancesDeactivated = false;
    }
    exit;
}

// A deferred reply owns the connection until it is sent. Reading further
// requests before then would answer them out of order.
if (deferKind != 0)
{
    agentBridgeDefer();
    if (deferKind != 0)
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

        var request, reply, idEnd, idText;
        request = read_string(sock, msgLen);
        readState = 0;

        // Optional request id: "#<digits> <request>". Whatever a client puts
        // there is echoed on the front of the reply, which is what lets it
        // match replies to requests by name rather than by position - see
        // HANDOFF.md. Nothing is required to send one: without it replyPrefix
        // stays empty and the reply is bare, exactly as before, so a client
        // built against the older protocol keeps working against a game that
        // has been rebuilt with this.
        replyPrefix = "";
        if (string_char_at(request, 1) == "#")
        {
            idEnd = string_pos(" ", request);
            if (idEnd > 2)
            {
                idText = string_copy(request, 2, idEnd - 2);
                if (string_digits(idText) == idText)
                {
                    replyPrefix = "#" + idText + " ";
                    request = string_copy(request, idEnd + 1, string_length(request) - idEnd);
                }
            }
        }

        reply = agentBridgeDispatch(request);
        if (reply == "")
            exit;               // deferred; agentBridgeDefer sends it

        agentBridgeSend(reply);
    }
}
