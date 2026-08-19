// string agentBridgeInput(string commands)
// Applies simulated input to the running game. Commands are separated by ";",
// and each one is a verb with its arguments separated by spaces:
//
//   press <key>     hold a key down            release <key>   let it up
//   clear           drop all simulated input
//   aim <x> <y>     move the mouse, in room coordinates
//   click <0|1>     hold or release the left mouse button
//
// Keys are action names resolved through the game's bindings - see
// agentBridgeKey - so this drives the game the way a player does, through
// PlayerControl, rather than by writing to its variables behind its back.

var cmds, cmd, sp, tok, ntok, verb, code;
cmds = argument0;

if (cmds == "")
    return "ERR INPUT needs at least one command";

while (string_length(cmds) > 0)
{
    sp = string_pos(";", cmds);
    if (sp == 0)
    {
        cmd = cmds;
        cmds = "";
    }
    else
    {
        cmd = string_copy(cmds, 1, sp - 1);
        cmds = string_copy(cmds, sp + 1, string_length(cmds) - sp);
    }

    ntok = 0;
    while (string_length(cmd) > 0 and ntok < 4)
    {
        while (string_char_at(cmd, 1) == " ")
            cmd = string_copy(cmd, 2, string_length(cmd) - 1);
        if (cmd == "")
            break;

        sp = string_pos(" ", cmd);
        if (sp == 0)
        {
            tok[ntok] = cmd;
            cmd = "";
        }
        else
        {
            tok[ntok] = string_copy(cmd, 1, sp - 1);
            cmd = string_copy(cmd, sp + 1, string_length(cmd) - sp);
        }
        ntok += 1;
    }

    if (ntok == 0)
        continue;

    verb = string_lower(tok[0]);

    if (verb == "clear")
    {
        io_clear();
    }
    else if (verb == "press" or verb == "release")
    {
        if (ntok < 2)
            return "ERR " + verb + " needs a key";

        code = agentBridgeKey(tok[1]);
        if (code < 0)
            return "ERR " + tok[1] + " is not a key or a bound action";

        if (verb == "press")
            keyboard_key_press(code);
        else
            keyboard_key_release(code);
    }
    else if (verb == "aim")
    {
        if (ntok < 3)
            return "ERR aim needs an x and a y";
        window_views_mouse_set(real(tok[1]), real(tok[2]));
    }
    else if (verb == "click")
    {
        if (ntok >= 2 and tok[1] == "1")
            mouse_button = mb_left;
        else
            mouse_button = mb_none;
    }
    else
    {
        return "ERR unknown input command: " + verb;
    }
}

return "OK";
