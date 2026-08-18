// void agentBridgeSend(string payload)
// Writes one length prefixed frame to the connected agent client.

if (sock < 0)
    exit;

write_uint(sock, string_length(argument0));
write_string(sock, argument0);
socket_send(sock);
