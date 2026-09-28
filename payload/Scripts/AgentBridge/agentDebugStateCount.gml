// real agentDebugStateCount(real declared)
// Records the player count a state update declares of itself, and hands it
// straight back.
//
// inject.js patches this around the read_ubyte() inside deserializeState.gml's
// own count check. It has to sit inside the condition because that is where the
// byte is consumed: by the next line the number is gone, and "the server said
// 6, we hold 5" is the whole diagnosis where "we hold 5" on its own is not.
//
// Returns its argument unchanged and touches nothing else, so the comparison it
// sits in behaves exactly as it does in a stock client. Cost is one script call
// per state update - the same order as the dozens the receive loop already
// makes each frame.

global.agentDeclaredPlayers = argument0;
return argument0;
