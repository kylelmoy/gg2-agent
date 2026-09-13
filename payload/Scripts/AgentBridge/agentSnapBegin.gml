// void agentSnapBegin()
// Called on a Character, from Objects/InGameElements/Character.events/User
// Event 13.xml, on the line that reads the authoritative position block -
// BEFORE any of it is assigned. Stores what the client had PREDICTED so
// agentSnapEnd can measure how far off it was.
//
// This is the one measurement that cannot be taken from outside the client. A
// client hard-assigns x, y, hspeed, vspeed and hp from the wire every seventh
// tick and dead-reckons in between, so its state between updates IS its
// prediction: an external sampler comparing it against the server is measuring
// the dead-reckoning gap plus whatever clock skew the two round trips added,
// and can never say what the correction itself was. Capturing both sides in the
// same frame, at the assignment, removes the skew by construction.
//
// The quantity is the same one ClientPredictionGateTests pins offline from
// recorded traces ("how far the stock client's prediction has drifted by the
// moment a correction lands"), so a live soak becomes comparable to those
// numbers rather than being a separate unit.

if (!variable_global_exists("agentSnap"))
    global.agentSnap = false;

if (!global.agentSnap)
    exit;

agentSnapPredX = x;
agentSnapPredY = y;
agentSnapPredHs = hspeed;
agentSnapPredVs = vspeed;
agentSnapPredHp = hp;
agentSnapHave = 1;
