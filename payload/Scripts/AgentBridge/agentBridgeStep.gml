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
// Ahead of the deferred reply below, and that ordering is what makes a bridge
// recoverable by a client that cannot reach it any other way. Dropping the
// connection used to be the ONLY thing that reached a bridge with a STEP or
// WAIT outstanding, because nothing else was read until that reply went out;
// CANCEL is the ordinary way now, and this stays as the fallback that works
// even against a client that has stopped talking altogether.
if (socket_has_error(sock) or tcp_eof(sock))
{
    agentBridgeLog("client disconnected");
    socket_destroy(sock);
    sock = -1;

    // A client that vanishes mid-request must not leave the world stopped, or
    // the next one finds a game that never advances. Its queued requests go
    // with it: they were asked by a connection that no longer exists, and
    // answering them into the next client's socket would be worse than
    // dropping them.
    deferKind = 0;
    deferPrefix = "";
    ds_list_clear(queuedPrefix);
    ds_list_clear(queuedBody);
    if (frozen)
    {
        frozen = false;
        instance_activate_all();
        instancesDeactivated = false;
    }
    exit;
}

// Advance the deferred reply, if there is one. This may clear deferKind and
// send its answer, which is what releases the queue below.
if (deferKind != 0)
    agentBridgeDefer();

// Run whatever arrived while that reply was outstanding, in arrival order.
//
// In the same frame the defer finished, deliberately: a request held behind a
// STEP has already waited for it, and making it wait another frame for no
// reason would be a latency nobody asked for. Stops the moment one of them
// defers in its turn - a queued STEP is perfectly legal - leaving the rest
// queued behind that one.
var guard, request, reply, queuedReply, idEnd, idText, isCancel;

while (deferKind == 0 and ds_list_size(queuedBody) > 0)
{
    replyPrefix = ds_list_find_value(queuedPrefix, 0);
    request = ds_list_find_value(queuedBody, 0);
    ds_list_delete(queuedPrefix, 0);
    ds_list_delete(queuedBody, 0);

    queuedReply = agentBridgeDispatch(request);
    if (queuedReply == "")
        deferPrefix = replyPrefix;
    else
        agentBridgeSend(queuedReply);
}

// Drain whatever complete requests are already buffered. The guard stops one
// very chatty client from starving the rest of the frame.
//
// This runs whether or not a reply is deferred, which is the change that made
// CANCEL possible: a bridge that reads nothing while deferred cannot be told
// anything, so the only way to reach one was to drop the connection and let it
// notice the EOF. Reading always means a request can arrive and be answered -
// or, for anything that would touch the game, held until the defer is done.
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

        request = read_string(sock, msgLen);
        readState = 0;

        // Optional request id: "#<digits> <request>". Whatever a client puts
        // there is echoed on the front of the reply, which is what lets it
        // match replies to requests by name rather than by position - see
        // HANDOFF.md. Nothing is required to send one: without it replyPrefix
        // stays empty and the reply is bare, exactly as before, so a client
        // built against the older protocol keeps working against a game that
        // has been rebuilt with this.
        //
        // ⚠️ Ids stopped being a convenience the moment this loop began running
        // during a defer. Replies are no longer in arrival order - CANCEL jumps
        // the queue, and a deferred reply lands after requests that arrived
        // later - so a client matching by position would now be wrong. This
        // client refuses a bridge that answers without an id for that reason.
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

        // CANCEL is answered immediately even mid-defer; everything else waits.
        isCancel = (request == "CANCEL" or string_copy(request, 1, 7) == "CANCEL ");

        if (deferKind != 0 and !isCancel)
        {
            // Held, not run: see queuedPrefix in agentBridgeCreate for why. The
            // cap is a backstop against a client that never stops asking - it
            // answers rather than dropping the connection, because with ids an
            // out-of-order error is unambiguous and losing the connection is
            // not.
            if (ds_list_size(queuedBody) >= 32)
            {
                agentBridgeSend("ERR bridge queue is full (32 requests held behind a deferred reply) - " +
                    "send CANCEL to abandon it");
            }
            else
            {
                ds_list_add(queuedPrefix, replyPrefix);
                ds_list_add(queuedBody, request);
            }
            continue;
        }

        reply = agentBridgeDispatch(request);
        if (reply == "")
        {
            // Deferred. Keep its id: replyPrefix will have moved on by the
            // time agentBridgeDefer answers, because this loop keeps reading -
            // and it keeps reading rather than stopping here, so anything else
            // already buffered is queued now instead of waiting a frame to be
            // noticed.
            deferPrefix = replyPrefix;
            continue;
        }

        agentBridgeSend(reply);
    }
}
