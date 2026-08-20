// int agentNavReach(wx, wy)
// Computes which nav nodes are reachable from the node nearest world (wx, wy) by a
// directed BFS over global.navEdges - independent of team, gates and intel-carriage, so
// it answers "can anything at all reach this" rather than "can this one bot reach this".
// Fills global.agentNavReachList (a ds_list, one entry per node, 1 or 0) and
// global.agentNavReachStartX/Y (for drawing a marker at the start), and returns the
// count of nodes reached, or -1 if the nav graph is not built yet or (wx, wy) does not
// resolve to a node at all.
//
// This is debugging infrastructure for the bot nav graph (Gang-Garrison-2's
// Scripts/BotNav/), not game logic - it exists so gg2_nav_map can visualise reachability
// without every investigation re-deriving the same BFS by hand in a gg2_eval string.
// agentBridgeDraw is what renders the result; this only computes it.

var wx, wy, startNode, q, cur, i, n, from, to, cnt;
wx = argument0;
wy = argument1;

if(!global.navReady)
    return -1;

startNode = navNodeFromWorld(wx, wy);
if(startNode < 0)
    return -1;

if(global.agentNavReachValid)
    ds_list_destroy(global.agentNavReachList);

global.agentNavReachList = ds_list_create();
global.agentNavReachValid = true;
global.agentNavReachStartX = wx;
global.agentNavReachStartY = wy;

for(i = 0; i < global.navNodeCount; i += 1)
    ds_list_add(global.agentNavReachList, 0);
ds_list_replace(global.agentNavReachList, startNode, 1);

q = ds_queue_create();
ds_queue_enqueue(q, startNode);
n = ds_grid_height(global.navEdges);
while(!ds_queue_empty(q))
{
    cur = ds_queue_dequeue(q);
    for(i = 0; i < n; i += 1)
    {
        from = ds_grid_get(global.navEdges, NAV_EDGE_FROM, i);
        if(from == cur)
        {
            to = ds_grid_get(global.navEdges, NAV_EDGE_TO, i);
            if(ds_list_find_value(global.agentNavReachList, to) == 0)
            {
                ds_list_replace(global.agentNavReachList, to, 1);
                ds_queue_enqueue(q, to);
            }
        }
    }
}
ds_queue_destroy(q);

cnt = 0;
for(i = 0; i < global.navNodeCount; i += 1)
    if(ds_list_find_value(global.agentNavReachList, i) == 1)
        cnt += 1;

return cnt;
