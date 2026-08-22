// void agentBridgeSend(string payload)
// Writes one length prefixed frame to the connected agent client, carrying the
// id of the request it answers when that request had one.
//
// Every reply goes out through here - the immediate ones agentBridgeStep sends
// and the deferred ones agentBridgeDefer sends frames later - so tagging the
// frame here is what makes the id unconditional without every caller
// remembering it. replyPrefix is set once per request by agentBridgeStep and
// stays put across a defer, because nothing new is read while one is
// outstanding.

var frame;

if (sock < 0)
    exit;

frame = replyPrefix + argument0;
write_uint(sock, string_length(frame));
write_string(sock, frame);
socket_send(sock);
