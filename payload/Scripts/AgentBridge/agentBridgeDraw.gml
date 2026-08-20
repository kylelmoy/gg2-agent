// Renders the nav-reachability overlay when gg2_nav_map has turned it on. Called from
// AgentBridge's Draw event, which only fires because AgentBridge sets visible = true in
// agentBridgeCreate for exactly this - it has no sprite, so that costs nothing when the
// overlay is off.
//
// Bars, not points: a node's own anchor is one row, easy to miss at a full-map zoom, but
// a node's full column span drawn a few pixels tall reads clearly even zoomed out to the
// whole map in one screenshot. Green means agentNavReach's BFS reached this node from
// the start point; red means it did not.

if(!global.agentNavOverlay or !global.agentNavReachValid)
    exit;

var i, n, x0w, x1w, yw;
n = global.navNodeCount;
for(i = 0; i < n; i += 1)
{
    if(ds_list_find_value(global.agentNavReachList, i) == 1)
        draw_set_color(c_lime);
    else
        draw_set_color(c_red);
    x0w = ds_grid_get(global.navNodes, NAV_NODE_X0, i) * NAV_CELL_SIZE;
    x1w = (ds_grid_get(global.navNodes, NAV_NODE_X1, i) + 1) * NAV_CELL_SIZE;
    yw = (ds_grid_get(global.navNodes, NAV_NODE_Y, i) + NAV_BOX_H) * NAV_CELL_SIZE;
    draw_rectangle(x0w, yw - 10, x1w, yw + 10, false);
}

draw_set_color(c_yellow);
draw_circle(global.agentNavReachStartX, global.agentNavReachStartY, 24, false);
draw_set_color(c_white);
