#!/usr/bin/env node
//=============================================================================
// package.js - assemble a distributable build.zip, the way upstream's
// build.bat does.
//
// Copies the licences, readme, music, extension packages and the reassembled
// .gmk alongside the built executable, then zips the result with the 7za that
// ships in the game's own Included Files.
//
// Only needed for a release-shaped artefact. The normal agent loop just wants
// the exe, so build-agent.js skips this unless --package is passed.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./tools/lib.js');

const USAGE = `
usage: node package.js [--repo <path>]

  --repo   the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
`;

const TEXT_FILES = [
  '7zip.license.txt',
  'How To Play.txt',
  'miniupnp.license.txt',
  'MPL-2.0.txt',
  'Readme.txt',
  'sampleMapRotation.txt',
];

async function packageBuild({ repo }) {
  const repoFull = path.resolve(repo);
  const source = path.join(repoFull, 'Source');
  const build = path.join(source, 'build');
  const exe = path.join(build, 'Gang Garrison 2.exe');

  if (!fs.existsSync(exe)) throw new Error(`nothing to package: ${exe} not found`);

  // --- top-level text files -------------------------------------------------
  for (const t of TEXT_FILES) {
    const src = path.join(repoFull, t);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(build, t));
    else lib.warn(`missing ${t}`);
  }
  lib.ok('copied text files');

  // --- Source/: the gmk, the extension packages, the uuid helper ------------
  const pkgSource = path.join(build, 'Source');
  fs.mkdirSync(pkgSource, { recursive: true });

  const uuid = path.join(repoFull, 'UUIDGenerator.html');
  if (fs.existsSync(uuid)) fs.copyFileSync(uuid, path.join(pkgSource, 'UUIDGenerator.html'));

  const ext = path.join(repoFull, 'Extensions');
  if (fs.existsSync(ext)) {
    for (const f of fs.readdirSync(ext)) {
      if (f.endsWith('.gex')) fs.copyFileSync(path.join(ext, f), path.join(pkgSource, f));
    }
  }

  const gmk = path.join(build, 'gg2.gmk');
  if (fs.existsSync(gmk)) fs.renameSync(gmk, path.join(pkgSource, 'Gang Garrison 2.gmk'));
  lib.ok('copied source files');

  // --- music ----------------------------------------------------------------
  const music = path.join(repoFull, 'Music');
  if (fs.existsSync(music)) {
    fs.cpSync(music, path.join(build, 'Music'), { recursive: true, force: true });
    lib.ok('copied music');
  }

  // --- zip ------------------------------------------------------------------
  // Three things in the build directory are development leftovers rather than
  // parts of a release:
  //
  //   template     the fast-rebuild exe and its manifest; would double the zip
  //   agent_*      the bridge and launcher logs, the instance register, and any
  //                screenshot a tool asked for
  //   gg2.ini      whoever ran the game last left their settings in it, and
  //                gg2_session deliberately turns UseLobby off in there. The
  //                game writes itself a fresh one on first run.
  const zipTool = path.join(source, 'gg2', 'Included Files', '7za.exe');
  const zipOut = path.join(source, 'build.zip');
  if (fs.existsSync(zipOut)) fs.rmSync(zipOut);
  if (!fs.existsSync(zipTool)) throw new Error(`7za.exe not found at ${zipTool} - cannot build the archive`);

  await lib.run(
    zipTool,
    ['a', '-tzip', zipOut, path.join(build, '*'), '-xr!template', '-xr!agent_*', '-xr!gg2.ini'],
    source
  );

  const mb = (fs.statSync(zipOut).size / (1024 * 1024)).toFixed(1);
  lib.ok(`packaged ${zipOut} (${mb} MB)`);
}

if (require.main === module) {
  const { flags } = lib.parseArgs(process.argv.slice(2), ['repo']);
  if (flags.help) lib.helpAndExit(USAGE);
  lib.cli(async () => packageBuild({ repo: flags.repo || lib.defaultRepo() }));
}

module.exports = { packageBuild };
