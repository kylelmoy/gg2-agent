// string agentNavDump()
// Every nav node as "anchorY,X0,X1,R;" - one entry per node, semicolon separated.
// anchorY/X0/X1 are in nav-cell units, and a nav cell is exactly one map pixel
// (NAV_CELL_SIZE is the same 6 the game scales map pixels to world pixels by, F10), so
// gg2_map_image can plot these straight onto the map's own Included Files PNG with no
// unit conversion at all. anchorY is the row a node's *floor* is on (Y + NAV_BOX_H, the
// same "where the feet are" row botSetGoal's own callers already use) rather than the
// node's own Y, so the caller does not need to know NAV_BOX_H at all. R is 1 if the last
// agentNavReach call reached this node, 0 if it did not, or 2 if agentNavReach has never
// been called (drawn as a third colour rather than silently guessing green or red).
//
// Returns "-1" if the nav graph is not built yet, matching agentNavReach's convention.
//
// This is debugging infrastructure for the bot nav graph, not game logic.

var i, n, s, r;

if(!global.navReady)
    return "-1";

n = global.navNodeCount;
s = "";
for(i = 0; i < n; i += 1)
{
    if(global.agentNavReachValid)
    {
        if(ds_list_find_value(global.agentNavReachList, i) == 1)
            r = 1;
        else
            r = 0;
    }
    else
        r = 2;

    s += string(ds_grid_get(global.navNodes, NAV_NODE_Y, i) + NAV_BOX_H) + "," +
         string(ds_grid_get(global.navNodes, NAV_NODE_X0, i)) + "," +
         string(ds_grid_get(global.navNodes, NAV_NODE_X1, i)) + "," +
         string(r) + ";";
}

return s;
