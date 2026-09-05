#!/usr/bin/env node
//=============================================================================
// build-agent.js - build a Gang Garrison 2 executable with the agent bridge
// compiled in.
//
// Owns the whole pipeline, so the game repo stays pristine:
//
//   1. inject the agent bridge into the split source tree
//   2. gmksplit    reassemble Source/gg2 into a .gmk
//   3. Game Maker  create the executable                              (~10s)
//   4. gm8x_fix    patch the resulting executable
//   5. template    keep this exe plus a manifest of the code it contains,
//                  so build-fast.js can splice later code changes into it
//   6. package     optional: copy music/licences and zip      (--package)
//   7. cleanup     remove the bridge again
//
// Step 7 runs from a finally block, so an interrupted or failed build still
// leaves the checkout clean.
//
// Step 3 is the one Game Maker 8 gives no command-line for, so two ways to get
// an executable out of it are tried in order:
//
//   1. tools/gm8directbuild.js - launches Game Maker on a desktop that is
//      never displayed and calls straight into the compiled routine behind
//      File > Create Executable. No desktop session, no person, no window.
//      Only works against the one exact Game_Maker.exe build it was
//      reverse-engineered against; refuses against any other rather than
//      calling a hardcoded address that would mean something else there.
//   2. Manual - opens the project and waits for a person. The behaviour this
//      always had, and now only reached when tier 1 refuses or fails.
//
// --manual skips straight to the second tier.
//
// There used to be a middle tier, tools/gm8ide.js, which drove the visible IDE
// through File > Create Executable with posted window messages. It needed an
// interactive desktop session and about a minute; gm8directbuild.js needs
// neither and does the same job against the same Game Maker build, so it was
// removed rather than kept as a slower duplicate. Its git history is the place
// to look if the direct call ever has to be re-derived.
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
const gm8directbuild = require('./tools/gm8directbuild.js');

const USAGE = `
usage: node build-agent.js [--repo <path>] [--keep-injected] [--package]
                          [--wait <minutes>] [--manual] [--gm8 <dir>]

  --repo           the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
  --keep-injected  leave the bridge in the tree afterwards; run cleanup.js
                   before committing anything to the fork
  --package        also produce build.zip with music, licences and extensions
  --wait           how long to allow for the IDE build (default 15 minutes)
  --manual         do not build headlessly; open the project and wait for a
                   person
  --gm8            the Game Maker 8 install (default: auto-detect, or GM8_DIR)

Step 3 builds headlessly with gm8directbuild.js - no desktop session, no
window, ~10s - and falls back to opening the project and waiting for a person
if that is not available for this Game Maker build. Code-only changes do not
need any of this - use build-fast.js.
`;

//---------------------------------------------------------------------------
// The two external tools
//
// Neither is committed to this repo, and as of 2026-09-05 neither is in the
// game's checkout either: both binaries lived in the old fork's Source/ and
// went with it when that was replaced by upstream, which ships GitToGmk.bat
// (which calls gmksplit.exe) but not the tool it calls.
//
// So both are looked for in the sibling source repos as well, at the paths
// their own build scripts write to. Neither is fetched or built from here -
// that is the user's call, not a build step's - but the moment an artefact
// exists in either repo it is picked up with nothing else to configure.
//---------------------------------------------------------------------------

// gmksplit reassembles the split tree into a .gmk, and it is a JAR: the .exe
// is only a launch4j wrapper around gmksplit.jar, whose manifest names
// com.ganggarrison.gmdec.GmkSplitter. So a jar and a JRE do the same job as the
// exe, and a JRE is a far more ordinary thing to have - which matters here,
// because Gmk-Splitter's own build-release.sh emits the jar unconditionally and
// only wraps it into an exe if it can also fetch launch4j.
function resolveSplitter(source, sibling = path.resolve(__dirname, '..', 'Gmk-Splitter')) {
  const here = [path.join(__dirname, 'tools'), source];
  try {
    return { exe: lib.findTool('gmksplit.exe', here), args: [] };
  } catch (e) {
    // ignore: the jar is just as good
  }

  const jarDirs = [...here, sibling, ...releaseDirs(path.join(sibling, 'release'))];
  for (const dir of jarDirs) {
    const jar = path.join(dir, 'gmksplit.jar');
    if (fs.existsSync(jar)) return { exe: 'java', args: ['-jar', path.resolve(jar)] };
  }

  throw new Error(
    'neither gmksplit.exe nor gmksplit.jar found.\n' +
      `  Looked in: ${jarDirs.join('; ')} and PATH.\n` +
      `  The source is at ${sibling}; its build-release.sh writes release/GmkSplitter.<version>/gmksplit.jar,\n` +
      '  and needs a JDK (javac) - a JRE alone can run the jar but cannot build it.\n' +
      '  A prebuilt gmksplit.exe also ships in the upstream GmkSplitter release zip.'
  );
}

// gm8x_fix patches the built exe: input lag, joystick, scheduler, memory and
// DirectPlay. All of them are quality fixes to a game that already runs, so a
// build without it is a working build - which is why this warns and carries on
// rather than throwing before anything has been done. It used to throw at
// discovery, so a missing patcher failed the build a minute before it would
// have mattered, and for a reason that never had to stop it.
function resolveGm8xFix(source, sibling = path.resolve(__dirname, '..', 'gm8x_fix')) {
  const dirs = [path.join(__dirname, 'tools'), source, sibling];
  try {
    return lib.findTool('gm8x_fix.exe', dirs);
  } catch (e) {
    lib.warn('gm8x_fix.exe not found - building without it');
    lib.detail(`looked in: ${dirs.join('; ')} and PATH`);
    lib.detail('the exe still runs; it just keeps GM8\'s input lag, joystick, scheduler and DirectPlay bugs');
    lib.detail(`source at ${sibling}: cc gm8x_fix.c patches.c -o gm8x_fix.exe`);
    return null;
  }
}

// Every <dir>/*/ under a release directory, newest first, so the most recent
// build-release.sh run wins without anyone naming a version.
function releaseDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

async function buildAgent({
  repo,
  keepInjected = false,
  doPackage = false,
  waitMinutes = 15,
  manual = false,
  gm8Dir = null,
}) {
  const repoFull = path.resolve(repo);
  const source = path.join(repoFull, 'Source');
  const build = path.join(source, 'build');
  const tree = path.join(source, 'gg2');
  const exeOut = path.join(build, 'Gang Garrison 2.exe');
  const gmkOut = path.join(build, 'gg2.gmk');

  // gm8x_fix first: it only warns, and resolving it after gmksplit would mean
  // a missing patcher stayed invisible until the missing splitter was fixed.
  const gm8x = resolveGm8xFix(source);
  const gmksplit = resolveSplitter(source);

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
    await lib.run(gmksplit.exe, [...gmksplit.args, 'gg2', path.join('build', 'gg2.gmk')], source);
    if (!fs.existsSync(gmkOut)) throw new Error(`gmksplit produced no ${gmkOut}`);
    lib.ok(`gg2.gmk (${fs.statSync(gmkOut).size} bytes)`);

    // --- 3. build it in Game Maker 8 -------------------------------------------
    // gm8directbuild.js always tears its own Game Maker process down whatever
    // the outcome - it runs on a desktop nobody can see, so there would be no
    // sense in leaving a loaded project open on it - which means the fallback
    // starts a fresh IDE rather than inheriting one.
    let done = false;

    if (!manual) {
      lib.step('Building headlessly (gm8directbuild.js)');
      lib.detail(`project:  ${gmkOut}`);
      lib.detail(`save as:  ${exeOut}`);
      try {
        await gm8directbuild.buildExe({
          gmk: gmkOut,
          exe: exeOut,
          gm8: gm8Dir,
          timeoutMinutes: waitMinutes,
          log: lib.detail,
        });
        done = true;
      } catch (e) {
        // A modal in front of the IDE is the one failure the fallback cannot
        // help with: opening the project for a person puts them in front of the
        // same dialog, and the wait below then burns another --wait minutes
        // before saying so. Measured 2026-09-05, before gm8directbuild watched
        // for TMessageForm: 3 minutes of headless timeout and 15 of "still
        // waiting for the executable", for a Yes/No prompt about temp folders.
        if (e instanceof gm8directbuild.BlockedByDialog) throw e;
        lib.warn(`could not build headlessly: ${e.message}`);
      }
    }

    if (!done) {
      lib.step('Waiting for the executable');
      lib.warn('this step needs you: File > Create Executable');
      lib.detail(`project:  ${gmkOut}`);
      lib.detail(`save as:  ${exeOut}`);
      lib.openInShell(gmkOut);

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
    if (gm8x) {
      lib.step('Patching executable');
      await lib.run(gm8x, ['-nb', '-s', exeOut], source);
      lib.ok('patched');
    } else {
      lib.skip('not patching: gm8x_fix.exe is not available (warned above)');
    }

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

module.exports = { buildAgent, resolveSplitter, resolveGm8xFix };
