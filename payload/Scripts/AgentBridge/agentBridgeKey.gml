// real agentBridgeKey(string name)
// Resolves an input name to a key code. Action names come from the game's own
// key bindings, so "jump" is whatever the player has bound rather than a
// hardcoded guess. A number is taken as a raw code, and a single character as
// itself. Returns -1 for anything else.

var name;
name = argument0;

if (name == "")
    return -1;

if (string_digits(name) == name)
    return real(name);

name = string_lower(name);

// The bindings PlayerControl reads each step.
if (name == "left" and variable_global_exists("left"))
    return global.left;
if (name == "right" and variable_global_exists("right"))
    return global.right;
if (name == "jump" and variable_global_exists("jump"))
    return global.jump;
if (name == "up" and variable_global_exists("jump"))
    return global.jump;
if (name == "down" and variable_global_exists("down"))
    return global.down;
if (name == "attack" and variable_global_exists("attack"))
    return global.attack;
if (name == "special" and variable_global_exists("special"))
    return global.special;
if (name == "taunt" and variable_global_exists("taunt"))
    return global.taunt;
if (name == "drop" and variable_global_exists("drop"))
    return global.drop;
if (name == "medic" and variable_global_exists("medic"))
    return global.medic;
if (name == "changeteam" and variable_global_exists("changeTeam"))
    return global.changeTeam;
if (name == "changeclass" and variable_global_exists("changeClass"))
    return global.changeClass;
if (name == "chat1" and variable_global_exists("chat1"))
    return global.chat1;
if (name == "chat2" and variable_global_exists("chat2"))
    return global.chat2;
if (name == "chat3" and variable_global_exists("chat3"))
    return global.chat3;

// Keys with no binding to look up.
if (name == "enter")
    return vk_enter;
if (name == "escape")
    return vk_escape;
if (name == "space")
    return vk_space;
if (name == "tab")
    return vk_tab;
if (name == "shift")
    return vk_shift;
if (name == "control" or name == "ctrl")
    return vk_control;
if (name == "backspace")
    return vk_backspace;

if (string_length(argument0) == 1)
    return ord(string_upper(argument0));

return -1;
