// string agentSnapReport()
// The snap totals as one line per field, for gg2_evalx. No new bridge verb: the
// existing EVAL path already reaches this and a soak runner wants the numbers in
// its own log anyway.
//
// Reads "field n mean max over>t0/t1/t2". A healthy run has a small mean, a max
// explained by respawn teleports, and over-counts that stay flat as the run gets
// longer - a tail that grows with time is drift, which is the thing worth
// catching.

var f, out, name, n, mean;

name[0] = "x ";
name[1] = "y ";
name[2] = "hs";
name[3] = "vs";
name[4] = "hp";

out = "snap on=" + string(global.agentSnap);

for (f = 0; f <= 4; f += 1)
{
    n = global.agentSnapN[f];

    if (n > 0)
        mean = global.agentSnapSum[f] / n;
    else
        mean = 0;

    out = out + "; " + name[f]
        + " n=" + string(n)
        + " mean=" + string(mean)
        + " max=" + string(global.agentSnapMax[f])
        + " over=" + string(global.agentSnapOver0[f])
        + "/" + string(global.agentSnapOver1[f])
        + "/" + string(global.agentSnapOver2[f]);
}

return out;
