// string agentBridgeState()
// Returns a GGON snapshot of the parts of the game an agent usually wants.
// Every global lookup is guarded so this keeps working as the game changes.

var m;
m = ds_map_create();

ds_map_add(m, "room", room_get_name(room));
ds_map_add(m, "fps", string(fps));
ds_map_add(m, "roomSpeed", string(room_speed));

if (variable_global_exists("isHost"))
    ds_map_add(m, "isHost", string(global.isHost));
if (variable_global_exists("dedicatedMode"))
    ds_map_add(m, "dedicated", string(global.dedicatedMode));

// Players, encoded as a GGON list (a map with a length key).
var players, n;
players = ds_map_create();
n = 0;

if (variable_global_exists("players"))
{
    var i;
    for (i = 0; i < ds_list_size(global.players); i += 1)
    {
        var p, pm;
        p = ds_list_find_value(global.players, i);
        if (!instance_exists(p))
            continue;

        pm = ds_map_create();
        ds_map_add(pm, "name", string(p.name));
        ds_map_add(pm, "team", string(p.team));
        ds_map_add(pm, "class", string(p.class));
        ds_map_add(players, string(n), pm);
        n += 1;
    }
}

ds_map_add(players, "length", string(n));
ds_map_add(m, "players", players);

var out;
out = ggon_encode(m);
ggon_destroy_map(m);
return out;
