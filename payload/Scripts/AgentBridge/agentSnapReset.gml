// void agentSnapReset()
// Zeroes the snap totals and sets the tail thresholds. Called from
// agentBridgeCreate so every build has the arrays, and callable live to start a
// fresh measurement window without restarting the client.
//
// The thresholds are in each field's own units - pixels, pixels per tick, hit
// points - chosen against what the offline gate already measured rather than
// picked round: ClientPredictionGateTests holds four of its five single-player
// fixtures to two WIRE units, which is 0.4 px, so a position snap over 1 px is
// already outside what a quiet recording produces, 8 px is a visible twitch,
// and 64 px only happens on a teleport. For hp, 0.5 is below the smallest real
// step and 1 is the whole width of the ceil() the wire quantises hp to, so a
// count over 1 is the flicker a player can actually see.

var f;

for (f = 0; f <= 4; f += 1)
{
    global.agentSnapN[f] = 0;
    global.agentSnapSum[f] = 0;
    global.agentSnapMax[f] = 0;
    global.agentSnapOver0[f] = 0;
    global.agentSnapOver1[f] = 0;
    global.agentSnapOver2[f] = 0;
}

global.agentSnapT0[0] = 1;
global.agentSnapT1[0] = 8;
global.agentSnapT2[0] = 64;

global.agentSnapT0[1] = 1;
global.agentSnapT1[1] = 8;
global.agentSnapT2[1] = 64;

global.agentSnapT0[2] = 0.5;
global.agentSnapT1[2] = 2;
global.agentSnapT2[2] = 8;

global.agentSnapT0[3] = 0.5;
global.agentSnapT1[3] = 2;
global.agentSnapT2[3] = 8;

global.agentSnapT0[4] = 0.5;
global.agentSnapT1[4] = 1;
global.agentSnapT2[4] = 5;
