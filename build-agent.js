#!/usr/bin/env node
//=============================================================================
// build-agent.js - build a Gang Garrison 2 executable with the agent bridge
// compiled in.
//
// Owns the whole pipeline, so the game repo stays pristine:
//
//   1. inject the agent bridge into the split source tree
//   2. gm8-builder  lint the tree, then write the executable straight from it,
//                   with gm8x_fix's runner patches                    (~2s)
//   3. package      optional: copy music/licences and zip      (--package)
//   4. cleanup      remove the bridge again
//
// Step 4 runs from a finally block, so an interrupted or failed build still
// leaves the checkout clean.
//
// Step 2 is gm8-builder (../gm8-builder, see tools/gm8.js), a separate tool
// that knows nothing about this game or the bridge. It does not run Game Maker
// at all - it reproduces Create Executable itself, reading only the runner,
// libraries and extensions out of a Game Maker 8.0 install - so any change,
// resources included, costs the same two seconds.
//
// This clears Source/build first; build-fast.js is the same build without
// that, and with the game stopped and relaunched around it.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./tools/lib.js');
const { inject } = require('./inject.js');
const { cleanup } = require('./cleanup.js');
const { packageBuild } = require('./package.js');
const { GAME_IMAGE } = require('./run-agent.js');
const gm8 = require('./tools/gm8.js');

const USAGE = `
usage: node build-agent.js [--repo <path>] [--keep-injected] [--package] [--gm8 <dir>]

  --repo           the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
  --keep-injected  leave the bridge in the tree afterwards; run cleanup.js
                   before committing anything to the fork
  --package        also produce build.zip with music, licences and extensions
  --gm8            the Game Maker 8 install (default: GM8_DIR, then whatever
                   opens .gmk files)

Builds with gm8-builder - no Game Maker process, ~2s. Unlike build-fast.js it
clears Source/build first, and can package.
`;

async function buildAgent({
  repo,
  keepInjected = false,
  doPackage = false,
  gm8Dir = null,
}) {
  const repoFull = path.resolve(repo);
  const source = path.join(repoFull, 'Source');
  const build = path.join(source, 'build');
  const tree = path.join(source, 'gg2');
  const exeOut = path.join(build, 'Gang Garrison 2.exe');

  lib.step(`Building ${repoFull}`);

  const before = lib.gitStatus(repoFull);
  if (before.length > 0) {
    lib.warn('checkout has uncommitted changes before injecting:');
    for (const s of before) lib.detail(s);
    lib.warn('continuing, but cleanup will only remove bridge files');
  }

  inject(repoFull, false);

  try {
    // --- clear the build directory ------------------------------------------
    // A game still shutting down, or an open log, keeps a handle here.
    await lib.stopProcess(GAME_IMAGE);
    for (let attempt = 1; attempt <= 5 && fs.existsSync(build); attempt++) {
      try {
        fs.rmSync(build, { recursive: true, force: true });
      } catch (e) {
        lib.skip(`build dir busy, retry ${attempt}`);
        await lib.sleep(1000);
      }
    }
    if (fs.existsSync(build)) {
      const leftover = fs.readdirSync(build);
      if (leftover.length > 0) {
        throw new Error(
          `could not clear ${build} (still contains ${leftover.length} item(s): ` +
            `${leftover.slice(0, 5).join(', ')}${leftover.length > 5 ? ', ...' : ''}) - ` +
            'something holds this directory as its working directory (the game, a shell, a file search)'
        );
      }
      // A recursive remove deletes the contents before the directory itself,
      // so a directory that will not delete because it is locked - almost
      // always held as some process's current working directory, and the game
      // is only one candidate - fails here having already been emptied. An
      // empty directory is as clean a build target as a removed one, so carry
      // on.
      lib.skip(`${build} could not be removed but is already empty - continuing`);
    }
    fs.mkdirSync(build, { recursive: true });

    // --- 2. gm8-builder ------------------------------------------------------
    lib.step('Building the executable');
    await gm8.build(tree, exeOut, { gm8Dir });
    lib.ok(`built ${exeOut}`);

    // --- 3. package -------------------------------------------------------------
    if (doPackage) {
      lib.step('Packaging');
      await packageBuild({ repo: repoFull });
    }
  } finally {
    if (keepInjected) {
      lib.warn('leaving bridge injected (--keep-injected); run cleanup.js before committing');
    } else {
      cleanup(repoFull, false);
    }
  }

  lib.step('Done. Launch it with run-agent.js');
}

if (require.main === module) {
  const { flags } = lib.parseArgs(process.argv.slice(2), ['repo', 'gm8']);
  if (flags.help) lib.helpAndExit(USAGE);
  lib.cli(async () =>
    buildAgent({
      repo: flags.repo || lib.defaultRepo(),
      keepInjected: !!flags['keep-injected'],
      doPackage: !!flags.package,
      gm8Dir: flags.gm8 || null,
    })
  );
}

module.exports = { buildAgent };
