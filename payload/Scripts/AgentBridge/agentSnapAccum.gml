// void agentSnapAccum(field, delta)
// One field's worth of bookkeeping. field: 0 x, 1 y, 2 hspeed, 3 vspeed, 4 hp.
//
// Count, sum and max, plus how often the delta passed each of three thresholds.
// Threshold counts rather than a histogram because the question a soak asks is
// "is the tail bounded", and three counters answer it for a fraction of the
// cost on a path that runs once per character per update.

var f, d;
f = argument0;
d = argument1;

global.agentSnapN[f] += 1;
global.agentSnapSum[f] += d;

if (d > global.agentSnapMax[f])
    global.agentSnapMax[f] = d;

if (d > global.agentSnapT0[f])
    global.agentSnapOver0[f] += 1;

if (d > global.agentSnapT1[f])
    global.agentSnapOver1[f] += 1;

if (d > global.agentSnapT2[f])
    global.agentSnapOver2[f] += 1;
