#!/usr/bin/env node
//=============================================================================
// build-agent.js - build a Gang Garrison 2 executable with the agent bridge
// compiled in.
//
// Owns the whole pipeline, so the game repo stays pristine:
//
//   1. inject the agent bridge into the split source tree
//   2. gmksplit    reassemble Source/gg2 into a .gmk
//   3. Game Maker  drive the IDE to create the executable            (~40s)
//   4. gm8x_fix    patch the resulting executable
//   5. template    keep this exe plus a manifest of the code it contains,
//                  so build-fast.js can splice later code changes into it
//   6. package     optional: copy music/licences and zip      (--package)
//   7. cleanup     remove the bridge again
//
// Step 7 runs from a finally block, so an interrupted or failed build still
// leaves the checkout clean.
//
// Step 3 is the one Game Maker 8 gives no command-line for, so tools/gm8ide.js
// drives the IDE with posted window messages instead: File > Create Executable,
// the save dialog, and the confirmations either side of it. That needs an
// interactive desktop session but not a person. If Game Maker cannot be found,
// or driving it fails, this falls back to opening the project and waiting - the
// behaviour it always had.
//
// You need this only to bootstrap a template, or after adding, removing or
// renaming a resource. Code changes go through build-fast.js.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./tools/lib.js');
const gamedata = require('./tools/gamedata.js');
const { inject } = require('./inject.js');
const { cleanup } = require('./cleanup.js');
const { packageBuild } = require('./package.js');
const { GAME_IMAGE } = require('./run-agent.js');
const gm8ide = require('./tools/gm8ide.js');

const USAGE = `
usage: node build-agent.js [--repo <path>] [--keep-injected] [--package]
                          [--wait <minutes>] [--manual] [--gm8 <dir>]

  --repo           the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
  --keep-injected  leave the bridge in the tree afterwards; run cleanup.js
                   before committing anything to the fork
  --package        also produce build.zip with music, licences and extensions
  --wait           how long to allow for the IDE build (default 15 minutes)
  --manual         do not drive the IDE; open the project and wait for a person
  --gm8            the Game Maker 8 install (default: auto-detect, or GM8_DIR)

Step 3 drives the Game Maker 8 IDE, since GM8 has no command-line compile. It
needs an interactive desktop session but not a person. If Game Maker cannot be
found, or driving it fails, this falls back to opening the project and waiting
for someone to choose File > Create Executable. Code-only changes do not need
any of this - use build-fast.js.
`;

async function buildAgent({ repo, keepInjected = false, doPackage = false, waitMinutes = 15, manual = false, gm8Dir = null }) {
  const repoFull = path.resolve(repo);
  const source = path.join(repoFull, 'Source');
  const build = path.join(source, 'build');
  const tree = path.join(source, 'gg2');
  const exeOut = path.join(build, 'Gang Garrison 2.exe');
  const gmkOut = path.join(build, 'gg2.gmk');

  // gmksplit / gm8x_fix may sit in this repo's tools directory or, following
  // the game's own convention, in its Source directory.
  const gmksplit = lib.findTool('gmksplit.exe', [path.join(__dirname, 'tools'), source]);
  const gm8x = lib.findTool('gm8x_fix.exe', [path.join(__dirname, 'tools'), source]);

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
      // on instead of throwing away a template, exe and nav cache that a full
      // rebuild would then have to redo whether or not that was wanted.
      lib.skip(`${build} could not be removed but is already empty - continuing`);
    }
    fs.mkdirSync(build, { recursive: true });

    // --- 2. reassemble the split tree ----------------------------------------
    lib.step('Reassembling source tree');
    await lib.run(gmksplit, ['gg2', path.join('build', 'gg2.gmk')], source);
    if (!fs.existsSync(gmkOut)) throw new Error(`gmksplit produced no ${gmkOut}`);
    lib.ok(`gg2.gmk (${fs.statSync(gmkOut).size} bytes)`);

    // --- 3. build it in the Game Maker 8 IDE ----------------------------------
    // Automatic when Game Maker can be found, which is the usual case. When it
    // cannot, or when driving it fails, this falls back to what it always did:
    // open the project and wait for a person. A failed drive leaves the IDE up
    // with the project loaded, so finishing by hand costs a menu click rather
    // than another two-minute load.
    let done = false;
    let ideOpen = false;
    const ide = manual ? null : gm8ide.find(gm8Dir);

    if (ide) {
      lib.step('Building in the Game Maker 8 IDE');
      lib.detail(`project:  ${gmkOut}`);
      lib.detail(`save as:  ${exeOut}`);
      try {
        await gm8ide.buildExe({
          gmk: gmkOut,
          exe: exeOut,
          gm8: gm8Dir,
          timeoutMinutes: waitMinutes,
          log: lib.detail,
        });
        done = true;
      } catch (e) {
        lib.warn(`could not drive the IDE: ${e.message}`);
        ideOpen = !!e.ideOpen;
      }
    } else if (!manual) {
      lib.warn('Game Maker 8 not found, so this step cannot be automated - pass --gm8 <dir> or set GM8_DIR');
    }

    if (!done) {
      lib.step('Waiting for the executable');
      lib.warn('this step needs you: File > Create Executable');
      lib.detail(`project:  ${gmkOut}`);
      lib.detail(`save as:  ${exeOut}`);
      if (!ideOpen) lib.openInShell(gmkOut);

      const built = await lib.waitForStableFile(exeOut, waitMinutes * 60 * 1000, (waited) =>
        lib.detail(`still waiting for the executable (${waited}s)`)
      );
      if (!built) {
        throw new Error(
          `no executable at ${exeOut} after ${waitMinutes} minutes. ` +
            'Build it with File > Create Executable, or pass --wait <minutes>.'
        );
      }
    }
    lib.ok(`built (${fs.statSync(exeOut).size} bytes)`);

    // --- 4. patch the executable ----------------------------------------------
    lib.step('Patching executable');
    await lib.run(gm8x, ['-nb', '-s', exeOut], source);
    lib.ok('patched');

    // --- 5. record the fast-rebuild template ----------------------------------
    // The tree is still injected here, which is the state this exe was built
    // from, so the manifest and the executable describe the same code.
    lib.step('Recording fast-rebuild template');
    const templateDir = path.join(build, 'template');
    fs.mkdirSync(templateDir, { recursive: true });
    const templateExe = path.join(templateDir, 'Gang Garrison 2.exe');
    fs.copyFileSync(exeOut, templateExe);
    gamedata.snapshot(tree, templateExe, path.join(templateDir, 'gamedata.manifest.json'), lib.detail);

    // --- 6. package -------------------------------------------------------------
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
  const { flags } = lib.parseArgs(process.argv.slice(2), ['repo', 'wait', 'gm8']);
  if (flags.help) lib.helpAndExit(USAGE);
  lib.cli(async () =>
    buildAgent({
      repo: flags.repo || lib.defaultRepo(),
      keepInjected: !!flags['keep-injected'],
      doPackage: !!flags.package,
      waitMinutes: flags.wait ? Number(flags.wait) : 15,
      manual: !!flags.manual,
      gm8Dir: flags.gm8 || null,
    })
  );
}

module.exports = { buildAgent };
