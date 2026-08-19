// string agentBridgeShot(string path)
// Saves the current frame to an image file and replies with the path it wrote.
//
// While the world is frozen its instances are deactivated, and a deactivated
// instance is not drawn - so a screenshot taken then would show an almost empty
// room. Reactivating and calling screen_redraw() first draws the real frame
// without running a single step event, so the game does not advance.

var fname;
fname = argument0;

if (fname == "")
    return "ERR SHOT needs a file name";

if (frozen)
{
    instance_activate_all();
    screen_redraw();
}

screen_save(fname);

if (frozen)
    instance_deactivate_all(true);

if (!file_exists(fname))
    return "ERR the game wrote no file to " + fname;

return "OK " + fname;
