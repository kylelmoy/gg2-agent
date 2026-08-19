#!/usr/bin/env node
//=============================================================================
// cleanup.js - remove the agent bridge from a Gang Garrison 2 checkout.
//
// Exactly reverses inject.js: deletes the copied object and scripts, and
// removes the three inserted lines. Edits are surgical rather than a git
// checkout, so any unrelated work in progress in those files survives.
//
// Verifies the result with git status and reports anything left behind. This
// is what keeps the bridge - which is remote code execution by design - out of
// the public fork, so it fails loudly rather than quietly.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./tools/lib.js');
const payloadSpec = require('./tools/payload.js');

const USAGE = `
usage: node cleanup.js [--repo <path>] [--quiet]

  --repo   the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
  --quiet  only report problems

Exit code 1 means bridge artefacts are still in the checkout.
`;

function cleanup(repo, quiet) {
  const tree = lib.resolveGg2Tree(repo);
  lib.step(`Removing agent bridge from ${tree}`, quiet);

  // --- 1. undo the three line edits ----------------------------------------
  if (lib.removeLine(path.join(tree, 'Scripts', 'Game', 'game_init.gml'), payloadSpec.INIT_LINE)) {
    lib.ok('removed instance_create from game_init.gml', quiet);
  } else {
    lib.skip('game_init.gml already clean', quiet);
  }

  const objList = path.join(tree, 'Objects', '_resources.list.xml');
  let removed = 0;
  for (const name of payloadSpec.OBJECTS) {
    if (lib.removeLine(objList, `<resource name="${name}" type="RESOURCE"/>`)) removed++;
  }
  if (removed) lib.ok(`unregistered ${removed} object(s)`, quiet);
  else lib.skip('objects already unregistered', quiet);

  if (lib.removeLine(path.join(tree, 'Scripts', '_resources.list.xml'), `<resource name="${payloadSpec.SCRIPT_GROUP}" type="GROUP"/>`)) {
    lib.ok('unregistered script group', quiet);
  } else {
    lib.skip('script group already unregistered', quiet);
  }

  // --- 2. delete the payload -------------------------------------------------
  const targets = [path.join(tree, 'Scripts', payloadSpec.SCRIPT_GROUP)];
  for (const name of payloadSpec.OBJECTS) {
    targets.push(path.join(tree, 'Objects', `${name}.xml`), path.join(tree, 'Objects', `${name}.events`));
  }
  for (const t of targets) {
    if (fs.existsSync(t)) {
      fs.rmSync(t, { recursive: true, force: true });
      lib.ok(`deleted ${path.basename(t)}`, quiet);
    } else {
      lib.skip(`${path.basename(t)} not present`, quiet);
    }
  }

  // --- 3. prove the checkout is clean ---------------------------------------
  const status = lib.gitStatus(path.resolve(repo));
  if (status.length === 0) {
    lib.ok('git status clean', quiet);
    return true;
  }

  lib.warn('checkout is not clean; remaining changes:');
  for (const s of status) lib.detail(s);
  const stray = status.filter((s) => payloadSpec.STRAY.test(s));
  if (stray.length > 0) {
    lib.fail('bridge artefacts still present - cleanup did not fully reverse');
    return false;
  }
  lib.ok('no bridge artefacts remain (changes above are unrelated)', quiet);
  return true;
}

if (require.main === module) {
  const { flags } = lib.parseArgs(process.argv.slice(2), ['repo']);
  if (flags.help) lib.helpAndExit(USAGE);
  lib.cli(async () => {
    const clean = cleanup(flags.repo || lib.defaultRepo(), !!flags.quiet);
    if (!clean) process.exit(1);
  });
}

module.exports = { cleanup };
