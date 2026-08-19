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

// The single script group, registered in Scripts/_resources.list.xml.
const SCRIPT_GROUP = 'AgentBridge';

// The one line added to the game's own code.
const INIT_ANCHOR = 'loadplugins();';
const INIT_LINE = '    instance_create(0, 0, AgentBridge);';

// Anything matching this in `git status` after a cleanup means the fork is not
// clean and the build must fail.
const STRAY = /Agent(Bridge|Spare)|agent_bridge|agent_launcher|agent_instances|agent_shot/;

module.exports = { OBJECTS, SCRIPT_GROUP, INIT_ANCHOR, INIT_LINE, STRAY };
