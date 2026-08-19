#!/usr/bin/env node
//=============================================================================
// build-fast.js - rebuild the game from code changes alone, without Game
// Maker (~3s).
//
// GM8 does not compile GML: a built executable stores it as source text inside
// the gamedata appended to the runner. So a change that only touches code can
// be spliced straight into the last executable the IDE produced, instead of
// driving the IDE again:
//
//   1. inject the agent bridge, so the tree matches how the template was built
//   2. gamedata.js  splice every changed script and event into the template
//   3. cleanup      remove the bridge again
//
// The template and a manifest of the code it contains are written by
// build-agent.js into Source/build/template. Anything the splicer cannot
// express - a new sprite, object, room or setting - is caught by a hash of the
// tree taken at that time, and reported as an error telling you to run
// build-agent.js. It never silently produces a stale executable.
//
// Use build-agent.js for releases, and whenever this refuses.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./tools/lib.js');
const gamedata = require('./tools/gamedata.js');
const { inject } = require('./inject.js');
const { cleanup } = require('./cleanup.js');
const { runAgent, GAME_IMAGE } = require('./run-agent.js');

const USAGE = `
usage: node build-fast.js [--repo <path>] [--launch] [--dry-run] [--port <n>]

  --repo     the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
  --launch   relaunch the game afterwards and wait for the bridge
  --dry-run  list what would be spliced and stop
  --port     bridge port to wait on with --launch (default 17777)
`;

async function buildFast({ repo, launch = false, dryRun = false, port = 17777 }) {
  const repoFull = path.resolve(repo);
  const tree = path.join(repoFull, 'Source', 'gg2');
  const build = path.join(repoFull, 'Source', 'build');
  const template = path.join(build, 'template', 'Gang Garrison 2.exe');
  const manifest = path.join(build, 'template', 'gamedata.manifest.json');
  const exeOut = path.join(build, 'Gang Garrison 2.exe');

  if (!fs.existsSync(template) || !fs.existsSync(manifest)) {
    throw new Error(`no fast-rebuild template in ${path.join(build, 'template')} - run build-agent.js once first`);
  }

  const started = Date.now();

  // The game holds its own exe open, and it is about to be replaced.
  if (!dryRun && (await lib.stopProcess(GAME_IMAGE))) lib.step('Stopped the running game');

  inject(repoFull, true);
  let result;
  try {
    lib.step('Splicing code changes into the template');
    result = gamedata.patch(manifest, tree, exeOut, dryRun, lib.detail);
  } finally {
    cleanup(repoFull, true);
  }

  if (dryRun) return result;

  lib.ok(`rebuilt in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (launch && !(await runAgent({ repo: repoFull, port }))) {
    throw new Error('the game was rebuilt but its bridge never came up - see the log tails above');
  }
  return result;
}

if (require.main === module) {
  const { flags } = lib.parseArgs(process.argv.slice(2), ['repo', 'port']);
  if (flags.help) lib.helpAndExit(USAGE);
  lib.cli(async () => {
    await buildFast({
      repo: flags.repo || lib.defaultRepo(),
      launch: !!flags.launch,
      dryRun: !!flags['dry-run'],
      port: flags.port ? Number(flags.port) : 17777,
    });
  });
}

module.exports = { buildFast };
