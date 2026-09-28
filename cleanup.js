#!/usr/bin/env node
//=============================================================================
// cleanup.js - remove the agent bridge from a Gang Garrison 2 checkout.
//
// Exactly reverses inject.js: deletes the copied object and scripts, removes
// the inserted lines, and swaps every rewritten call site back to the line it
// replaced. Edits are surgical rather than a git checkout, so any unrelated work
// in progress in those files survives.
//
// Verifies the result with git status and reports anything left behind. This
// is what keeps the bridge - which is remote code execution by design - out of
// the public fork, so it fails loudly rather than quietly.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./tools/lib.js');
const payloadSpec = require('./tools/payload.js');
const events = require('./tools/events.js');

const USAGE = `
usage: node cleanup.js [--repo <path>] [--quiet]

  --repo   the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
  --quiet  only report problems

Exit code 1 means bridge artefacts are still in the checkout.
`;

function isPatched(file, patch) {
  return fs.existsSync(file) && lib.readText(file).split(/\r?\n/).some((l) => l.trim() === patch.to.trim());
}

function cleanup(repo, quiet) {
  const tree = lib.resolveGg2Tree(repo);
  lib.step(`Removing agent bridge from ${tree}`, quiet);

  // --- 1. undo the line edits ------------------------------------------------
  if (lib.removeLine(path.join(tree, 'Scripts', 'Game', 'game_init.gml'), payloadSpec.INIT_LINE)) {
    lib.ok('removed instance_create from game_init.gml', quiet);
  } else {
    lib.skip('game_init.gml already clean', quiet);
  }

  // Not linted: this is the game's own code plus one known line, and skipping
  // the (async) lint keeps writeEvent's write synchronous, so it lands before
  // the build that follows rather than whenever the lint server answers.
  const opts = { payload: false, lintFirst: false };
  const before = events.readEvent(repo, payloadSpec.KEYSTATE_OBJECT, payloadSpec.KEYSTATE_EVENT, 0, opts).gml;
  const after = lib.removeLineText(before, payloadSpec.KEYSTATE_LINE);
  if (after === null) {
    lib.skip(`${payloadSpec.KEYSTATE_OBJECT}.${payloadSpec.KEYSTATE_EVENT} already clean`, quiet);
  } else {
    events.writeEvent(repo, payloadSpec.KEYSTATE_OBJECT, payloadSpec.KEYSTATE_EVENT, 0, after, opts);
    lib.ok(`removed heldMask wiring from ${payloadSpec.KEYSTATE_OBJECT}.${payloadSpec.KEYSTATE_EVENT}`, quiet);
  }

  // Every variant's replacement is looked for, since which one inject chose
  // depends on the tree; a file or line that is not there is simply not patched.
  let unpatched = 0;
  for (const patch of payloadSpec.allPatches()) {
    const file = path.join(tree, ...patch.file);
    if (!isPatched(file, patch)) continue;
    if (lib.replaceLine(file, patch.to, patch.from)) unpatched++;
  }
  if (unpatched) lib.ok(`restored ${unpatched} debug call site(s)`, quiet);
  else lib.skip('debug call sites already restored', quiet);

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
  //
  // git status alone cannot see a call site that failed to revert: STRAY matches
  // paths, and a half-restored deserializeState.gml is just a modified path like
  // any other. So check the rewritten lines themselves are gone before trusting
  // the status output.
  const leftover = payloadSpec.allPatches().filter((patch) => isPatched(path.join(tree, ...patch.file), patch));
  if (leftover.length > 0) {
    lib.fail('debug call sites still patched - cleanup did not fully reverse');
    for (const patch of leftover) lib.detail(`${path.join(...patch.file)}: ${patch.to}`);
    return false;
  }

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
