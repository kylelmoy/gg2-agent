#!/usr/bin/env node
//=============================================================================
// inject.js - add the agent bridge to a clean Gang Garrison 2 checkout.
//
// Copies the AgentBridge object and its scripts into the split source tree and
// makes the three one-line edits the tree needs to see them:
//
//   Objects/_resources.list.xml   register the object
//   Scripts/_resources.list.xml   register the script group
//   Scripts/Game/game_init.gml    create the instance at startup
//
// Idempotent: running it twice is harmless. Reverse it with cleanup.js.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./tools/lib.js');

const USAGE = `
usage: node inject.js [--repo <path>] [--quiet]

  --repo   the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
  --quiet  only report problems
`;

function inject(repo, quiet) {
  const tree = lib.resolveGg2Tree(repo);
  lib.step(`Injecting agent bridge into ${tree}`, quiet);

  const payload = path.join(__dirname, 'payload');

  // --- 1. copy the payload -------------------------------------------------
  fs.copyFileSync(path.join(payload, 'Objects', 'AgentBridge.xml'), path.join(tree, 'Objects', 'AgentBridge.xml'));
  fs.cpSync(path.join(payload, 'Objects', 'AgentBridge.events'), path.join(tree, 'Objects', 'AgentBridge.events'), {
    recursive: true,
    force: true,
  });
  fs.cpSync(path.join(payload, 'Scripts', 'AgentBridge'), path.join(tree, 'Scripts', 'AgentBridge'), {
    recursive: true,
    force: true,
  });
  lib.ok('copied object, events and scripts', quiet);

  // --- 2. register the resources -------------------------------------------
  const objList = path.join(tree, 'Objects', '_resources.list.xml');
  if (lib.addBeforeLine(objList, '</resources>', '  <resource name="AgentBridge" type="RESOURCE"/>')) {
    lib.ok('registered object in Objects/_resources.list.xml', quiet);
  } else {
    lib.skip('object already registered', quiet);
  }

  const scrList = path.join(tree, 'Scripts', '_resources.list.xml');
  if (lib.addBeforeLine(scrList, '</resources>', '  <resource name="AgentBridge" type="GROUP"/>')) {
    lib.ok('registered script group in Scripts/_resources.list.xml', quiet);
  } else {
    lib.skip('script group already registered', quiet);
  }

  // --- 3. create the instance at startup ------------------------------------
  const init = path.join(tree, 'Scripts', 'Game', 'game_init.gml');
  if (lib.addAfterLine(init, 'loadplugins();', '    instance_create(0, 0, AgentBridge);')) {
    lib.ok('added instance_create to game_init.gml', quiet);
  } else {
    lib.skip('game_init.gml already patched', quiet);
  }
}

if (require.main === module) {
  const { flags } = lib.parseArgs(process.argv.slice(2), ['repo']);
  if (flags.help) lib.helpAndExit(USAGE);
  lib.cli(async () => {
    const repo = flags.repo || lib.defaultRepo();
    inject(repo, !!flags.quiet);
    lib.step('Injected. Build with build-agent.js, or remove with cleanup.js.', !!flags.quiet);
  });
}

module.exports = { inject };
