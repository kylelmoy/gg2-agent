// Everything AgentBridge paints into the world, from its Draw event: each Character's
// name and world position, drawn above its head so a person playing can read a position
// straight off the screen and quote it back. F11 toggles it (agentBridgeStep).
//
// AgentBridge's Draw event only fires because agentBridgeCreate sets visible = true for
// exactly this - it has no sprite, so that costs nothing while the labels are off - and
// its depth of -1000000 puts them over everything else in the room, the HUD included.

// agentBridgeCreate sets every global read below, and Draw cannot run before Create -
// except that the client startup path has been seen at least once to produce an
// AgentBridge whose Create never ran, which is what agentBridgeStep's self-heal is for.
// Draw has no equivalent hook, and GM8 answers a missing global with a modal dialog, so
// this would be one dialog per frame forever on the very instance a person is playing.
if(!variable_global_exists("agentLabels"))
    exit;

if(!global.agentLabels)
    exit;

// --- diagnostic labels ----------------------------------------------------------------
//
// Name over position, in the team's colour. The position is the point of the whole thing:
// "the red Medics are stuck" costs a round trip to find out where, and "Player is stuck
// at 2102, 522" does not.
//
// Every line is drawn twice, black one pixel down and right before the coloured pass, so
// it stays readable over terrain of any brightness. A real outline would be four extra
// passes for legibility this already has.

var lineH, labelName, labelPos, tx, ty;

draw_set_font(global.gg2Font);
draw_set_halign(fa_center);
draw_set_valign(fa_bottom);
draw_set_alpha(1);
lineH = string_height("0");

with(Character)
{
    tx = round(x);

    // 42px clears the tallest class's head. The game's own hover-name badge sits at
    // y - 35 (Character's Draw event), so this stacks just above it rather than fighting
    // it when a person points the cursor at someone.
    //
    // Then a per-character stagger, because the case that most needs reading is the one
    // where it is least readable: players pile up on a spawn point four deep, and centred
    // labels at one height render as a single unreadable smear - measured on the first
    // build of this, two overlapping labels in red spawn came out as "408,53Bp6606".
    // Three tiers a full two-line label apart, keyed off the instance id so a given
    // character keeps its tier for its whole life rather than flickering between them.
    ty = round(y) - 42 - (id mod 3) * lineH * 2;

    // -1 is GM8's `self`, not "no instance", so an unguarded player.name here would
    // silently read the Character's own fields rather than failing.
    labelName = "";
    if(player != -1)
        labelName = sanitiseNewlines(player.name);
    labelPos = string(round(x)) + ", " + string(round(y));

    draw_set_color(c_black);
    draw_text(tx + 1, ty + 1, labelPos);
    if(team == TEAM_RED)
        draw_set_color(c_red);
    else
        draw_set_color(c_blue);
    draw_text(tx, ty, labelPos);
    ty -= lineH;

    if(labelName != "")
    {
        draw_set_color(c_black);
        draw_text(tx + 1, ty + 1, labelName);
        draw_set_color(c_white);
        draw_text(tx, ty, labelName);
    }
}

// Back to what the rest of the game's drawing assumes, since nothing else here sets
// these before it draws.
draw_set_color(c_white);
draw_set_halign(fa_left);
draw_set_valign(fa_top);
