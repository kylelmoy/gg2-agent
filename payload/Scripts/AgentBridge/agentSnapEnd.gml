// void agentSnapEnd()
// The other half of agentSnapBegin, on the line that finishes assigning the
// authoritative block. Folds |predicted - authoritative| into the running
// totals agentSnapReport prints.
//
// The FIRST update a character ever receives is skipped. A client creates a
// Character at instance_create's default position and only then learns where it
// actually is, so that first delta is the distance from (0,0)-ish to the real
// spawn - not prediction error. agentSnapSeen is what distinguishes them.
//
// A respawn is the same problem and is NOT skipped, deliberately: the character
// instance survives, so there is no edge to detect here, and a death-to-spawn
// teleport lands in the totals as a genuine large snap. That is why the report
// carries threshold counts rather than a bare maximum - the offline gate uses
// p99 for exactly this reason (ClientPredictionGateTests, "p99, not max ... a
// death teleports a character to a spawn point").

if (!variable_global_exists("agentSnap"))
    global.agentSnap = false;

if (!global.agentSnap)
    exit;

if (!variable_local_exists("agentSnapHave"))
    exit;

if (!agentSnapHave)
    exit;

agentSnapHave = 0;

if (!variable_local_exists("agentSnapSeen"))
    agentSnapSeen = 0;

if (agentSnapSeen > 0)
{
    agentSnapAccum(0, abs(x - agentSnapPredX));
    agentSnapAccum(1, abs(y - agentSnapPredY));
    agentSnapAccum(2, abs(hspeed - agentSnapPredHs));
    agentSnapAccum(3, abs(vspeed - agentSnapPredVs));
    agentSnapAccum(4, abs(hp - agentSnapPredHp));
}

agentSnapSeen += 1;
