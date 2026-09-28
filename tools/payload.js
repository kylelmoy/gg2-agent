//=============================================================================
// payload.js - what the bridge payload consists of, in one place.
//
// inject.js copies these into the game's tree and registers them; cleanup.js
// deletes them and unregisters them. Both read this list, so adding a resource
// to the payload cannot leave half of it behind in the public fork.
//=============================================================================

// Objects registered in Objects/_resources.list.xml, in order.
//
// AgentBridge is the bridge itself. The spares date from when a fast rebuild
// could only splice code into an existing exe, so a new object meant a trip
// through the Game Maker IDE. gm8-builder builds a new object as cheaply as an
// edited one, so they are no longer needed - but they are still blank objects
// ready for an experiment, and cost nothing until an instance is created.
const OBJECTS = ['AgentBridge', 'AgentSpare0', 'AgentSpare1', 'AgentSpare2', 'AgentSpare3'];

// The single script group, registered in Scripts/_resources.list.xml. Besides
// the bridge's own scripts, it holds agentScriptSpare0..5 - the same idea as
// the object spares above, for a standalone script, and likewise no longer
// needed now that a new script name costs no more to build than an edit.
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

// Call sites in the game's own code that the payload rewrites, so a failure the
// game currently only puts on screen also reaches agent_bridge_<port>.log.
//
// WHY REPLACE A LINE RATHER THAN INSERT ONE. Both of these sites are the
// braceless body of an `if`, so an inserted neighbour does not join the branch -
// it displaces the original out of it. Insert beside deserializeState's
// show_message and the log line fires on every state update; insert beside
// getCharacterSpriteId's show_error and every sprite lookup in the game aborts.
// Swapping the whole line for a call to a payload script is the only edit that
// leaves the control flow alone, and it is its own inverse: cleanup.js replaces
// `to` with `from` and the file goes back byte for byte, indentation included.
//
// WHY THESE SITES AND NOTHING ELSE. show_message/show_error appear ~93 times
// across Scripts/ and 9 event files. Blanket coverage is not worth it - every
// anchor is a brittle exact-match string, and almost all of those sites are
// menu and hosting paths no automated run reaches. These are the ones that have
// actually cost a day: a desync whose cause only warns, and a fatal two steps
// downstream of it that names a symptom. Add a site when one bites.
//
// WHICH VERSION OF THE GAME. The payload targets stock upstream Gang Garrison 2
// and must not depend on any fork of it. Where a fork reshapes a site, the entry
// is `{ site, variants }` instead of one patch: each variant is a list of
// patches that must all match together, and the first variant the tree matches
// is applied (resolvePatches). A site no variant matches is skipped with a
// warning rather than failing the build - a build without one log line is still
// a correct build. Every other entry is a site with exactly one variant.
const CODE_PATCHES = [
  {
    site: 'desync report',
    variants: [
      // Upstream. deserializeState warns about a player-count mismatch and then
      // carries on reading a stream it knows is misaligned. The declared count is
      // read INSIDE the condition, so by the next line it is gone. Wrapping the
      // read is the only way to keep it, and the script hands the byte straight
      // back - the comparison is the stock comparison.
      [
        {
          file: ['Scripts', 'Serialization', 'deserializeState.gml'],
          from: 'if(read_ubyte(global.tempBuffer) != ds_list_size(global.players))',
          to: 'if(agentDebugStateCount(read_ubyte(global.tempBuffer)) != ds_list_size(global.players))',
        },
        {
          file: ['Scripts', 'Serialization', 'deserializeState.gml'],
          from: 'show_message("Wrong number of players while deserializing state");',
          to: 'agentDebugDesync();',
        },
      ],
      // A tree with Scripts/Client/clientProtocolError.gml (the kylelmoy fork's
      // desync-fixes branch): every stream desync the client detects reports
      // through this one line, with the counts, class or recent message ids
      // already in the text.
      [
        {
          file: ['Scripts', 'Client', 'clientProtocolError.gml'],
          from: 'promptRestartOrQuit(text);',
          to: 'agentDebugProtocolError(text);',
        },
      ],
    ],
  },
  {
    file: ['Scripts', 'Misc', 'getCharacterSpriteId.gml'],
    from: 'show_error("Attempted to get a sprite for unknown class ID: " + string(class), true);',
    to: 'agentDebugSpriteError(0, class, team, animation);',
  },
  {
    file: ['Scripts', 'Misc', 'getCharacterSpriteId.gml'],
    from: 'show_error("Attempted to get a sprite for unknown team ID: " + string(team), true);',
    to: 'agentDebugSpriteError(1, class, team, animation);',
  },

  // --- soak testing ---------------------------------------------------------
  //
  // The four below are not debug-logging sites; they are what makes an
  // unattended, accelerated, hours-long run against another server
  // implementation possible. Same rules apply: one line for one line, and every
  // replacement is a no-op unless its global has been turned on.

  // RateController pins room_speed every frame from global.game_fps, so nothing
  // outside can hold a different value. Patching the assignment keeps the
  // instance ACTIVE, which is what agentBridgeSpeed's deactivation gives up:
  // the boost then survives a map change, and RateController's Step keeps
  // maintaining global.run_virtual_ticks. agentRoomSpeed has the full argument.
  //
  // Both lines are plain statements inside a braced block, so neither is the
  // body of anything.
  {
    file: ['Objects', 'RateController.events', 'Begin Step.xml'],
    from: 'room_speed = 60;',
    to: 'agentRoomSpeed(60);',
  },
  {
    file: ['Objects', 'RateController.events', 'Begin Step.xml'],
    from: 'room_speed = 30;',
    to: 'agentRoomSpeed(30);',
  },

  // The prediction-snap probe. These two bracket the authoritative position
  // block a client hard-assigns every seventh tick, so the predicted and the
  // authoritative values are both in hand in the same frame - which is the only
  // way to measure the correction at all. agentSnapBegin has the argument.
  //
  // ANCHOR CHOICE. The block's last statement is
  //   moveStatus = (temp >> 1) & $07;
  // and in the event XML that line is stored escaped, as `&gt;&gt;` and `&amp;`,
  // so an anchor for it would have to carry the escaping and would break if the
  // file were ever re-serialised. `hp = read_ubyte(...)` is the last line that
  // assigns anything this probe reads and it is plain text, so it is the anchor.
  // Both are plain statements inside the braced `if`.
  {
    file: ['Objects', 'InGameElements', 'Character.events', 'User Event 13.xml'],
    from: 'receiveCompleteMessage(global.serverSocket,9,global.deserializeBuffer);',
    to: 'agentSnapBegin(); receiveCompleteMessage(global.serverSocket,9,global.deserializeBuffer);',
  },
  {
    file: ['Objects', 'InGameElements', 'Character.events', 'User Event 13.xml'],
    from: 'hp = read_ubyte(global.deserializeBuffer);',
    to: 'hp = read_ubyte(global.deserializeBuffer); agentSnapEnd();',
  },

  // AudioControl destroys itself in its own Create - `if(instance_number(
  // AudioControl)) > 1 {`, parenthesis in the wrong place - so currentSong is
  // never initialised and every round end raises a modal from WinBanner. One
  // dialog per round is survivable by hand and not by an unattended run: at 8x
  // it stalled a client until the server dropped it. agentAudioStopSong makes
  // the stock script safe and then does what the stock line did.
  //
  // This line IS the braceless body of an `if` - both are on one line - so the
  // whole line is replaced, which is the only safe edit for that shape.
  {
    file: ['Scripts', 'AudioControl', 'AudioControlPlaySong.gml'],
    from: 'if(AudioControl.currentSong != -1) sound_stop(AudioControl.currentSong);',
    to: 'agentAudioStopSong();',
  },
];

// Every CODE_PATCHES entry as { name, variants: [[patch, ...], ...] }.
function patchSites() {
  return CODE_PATCHES.map((entry) => entry.variants
    ? { name: entry.site, variants: entry.variants }
    : { name: `${entry.file.join('/')}: ${entry.from}`, variants: [[entry]] });
}

// Every patch of every variant - what cleanup has to look for, since it cannot
// know which variant inject chose.
function allPatches() {
  return patchSites().flatMap((s) => s.variants.flat());
}

// Which patches apply to the tree at `tree`, decided before anything is edited.
// A variant matches when each of its patches' files exists and holds either the
// anchor or the replacement (already applied) as a whole line.
function resolvePatches(tree) {
  const fs = require('fs');
  const path = require('path');
  const hasLine = (file, line) => fs.existsSync(file)
    && fs.readFileSync(file, 'utf8').split(/\r?\n/).some((l) => l.trim() === line.trim());
  const matches = (patch) => {
    const file = path.join(tree, ...patch.file);
    return hasLine(file, patch.from) || hasLine(file, patch.to);
  };

  const patches = [];
  const skipped = [];
  for (const site of patchSites()) {
    const variant = site.variants.find((v) => v.every(matches));
    if (variant) patches.push(...variant);
    else skipped.push(site.name);
  }
  return { patches, skipped };
}

// Anything matching this in `git status` after a cleanup means the fork is not
// clean and the build must fail.
const STRAY = /Agent(Bridge|Spare)|agent_bridge|agent_launcher|agent_instances|agent_shot/;

module.exports = {
  OBJECTS, SCRIPT_GROUP, INIT_ANCHOR, INIT_LINE,
  KEYSTATE_OBJECT, KEYSTATE_EVENT, KEYSTATE_ANCHOR, KEYSTATE_LINE,
  CODE_PATCHES, STRAY, patchSites, allPatches, resolvePatches,
};
