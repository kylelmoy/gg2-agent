// string agentBridgeShot(string path)
// Saves the current frame to an image file and replies with the path it wrote.
//
// While the world is frozen its instances are deactivated, and a deactivated
// instance is not drawn - so a screenshot taken then would show an almost empty
// room. Reactivating and calling screen_redraw() first draws the real frame
// without running a single step event, so the game does not advance.
//
// instance_activate_all() is unconditional - it does not know or care that some of
// those instances (HUD, KillLog, ...) were deliberately deactivated by
// agentBridgeHudVisible(false) for gg2_area_shot's overlay suppression, and reactivates
// them right along with everything else. So that suppression has to be re-applied here,
// every single shot, immediately before the redraw it would otherwise survive past for
// exactly one frame - long enough to appear in the very screenshot it was meant to be
// hidden from.

var fname;
fname = argument0;

if (fname == "")
    return "ERR SHOT needs a file name";

if (frozen)
{
    instance_activate_all();
    if (global.agentHideHud)
        agentBridgeHudVisible(false);
    screen_redraw();
}

screen_save(fname);

if (frozen)
    instance_deactivate_all(true);

if (!file_exists(fname))
    return "ERR the game wrote no file to " + fname;

return "OK " + fname;
