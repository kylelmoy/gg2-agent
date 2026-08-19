//=============================================================================
// payload.js - what the bridge payload consists of, in one place.
//
// inject.js copies these into the game's tree and registers them; cleanup.js
// deletes them and unregisters them. Both read this list, so adding a resource
// to the payload cannot leave half of it behind in the public fork.
//=============================================================================

// Objects registered in Objects/_resources.list.xml, in order.
//
// AgentBridge is the bridge itself. The spares exist because build-fast.js can
// only replace code that already exists in the template executable: an object
// that is in the template with empty events can be given behaviour by a ~3s
// splice, where a genuinely new object needs a trip through the Game Maker IDE.
// Four is enough for an experiment or two, and they cost nothing until an
// instance of one is created.
const OBJECTS = ['AgentBridge', 'AgentSpare0', 'AgentSpare1', 'AgentSpare2', 'AgentSpare3'];

// The single script group, registered in Scripts/_resources.list.xml. Besides
// the bridge's own scripts, it holds agentScriptSpare0..5 - the same idea as
// the object spares above, for a standalone script: build-fast.js can splice
// a spare's placeholder body into real behaviour in ~3s, where a genuinely
// new script name needs a full IDE build to be registered at all.
const SCRIPT_GROUP = 'AgentBridge';

// The one line added to the game's own code.
//
// This has to run before anything that can trigger a room change - a
// "-server"/"-port" launch creates a Client instance partway through
// game_init(), and its Create event calls room_goto_fix() immediately. GM8
// instances created afterwards in the same creation-code run (AudioControl,
// SSControl, and previously AgentBridge, injected after loadplugins()) come
// out with none of their Create-event variables set, as if Create never ran -
// confirmed against AudioControl's own game_errors.log entry ("Unknown
// variable currentSong"), so this is not particular to the bridge. Anchoring
// right after the one instance_create() that runs before any of that -
// RoomChangeObserver's - keeps AgentBridge out of that window entirely.
const INIT_ANCHOR = 'instance_create(0,0,RoomChangeObserver);';
const INIT_LINE = '    instance_create(0, 0, AgentBridge);';

// The one line added to an existing game object, so held input (left, right,
// up/jump, down, taunt) can be driven without a keyboard - see heldMask in
// agentBridgeCreate.gml and press/release in agentBridgeInput.gml for why
// keyboard_key_press cannot do this on its own. Anchored on the line right
// after PlayerControl finishes reading the keyboard for this step's keybyte,
// and still inside `if(!menuOpen)`, so simulated input is blocked by an open
// menu exactly like real input is.
const KEYSTATE_OBJECT = 'PlayerControl';
const KEYSTATE_EVENT = 'Begin Step';
const KEYSTATE_ANCHOR = 'if(keyboard_check(global.taunt)) keybyte |= $01;';
const KEYSTATE_LINE = '        if (instance_exists(AgentBridge)) keybyte |= (AgentBridge.heldMask & $E3);';

// Anything matching this in `git status` after a cleanup means the fork is not
// clean and the build must fail.
const STRAY = /Agent(Bridge|Spare)|agent_bridge|agent_launcher|agent_instances|agent_shot/;

module.exports = {
  OBJECTS, SCRIPT_GROUP, INIT_ANCHOR, INIT_LINE,
  KEYSTATE_OBJECT, KEYSTATE_EVENT, KEYSTATE_ANCHOR, KEYSTATE_LINE,
  STRAY,
};
