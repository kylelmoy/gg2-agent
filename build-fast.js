#!/usr/bin/env node
//=============================================================================
// build-fast.js - rebuild the game in place and relaunch it (~2s).
//
// The same build as build-agent.js - gm8-builder writes the executable straight
// from the tree, so a new script, object, sprite or room costs no more than an
// edited line - but shaped for the edit loop:
//
//   1. stop the running game, which holds its own exe open
//   2. inject the agent bridge
//   3. gm8-builder  lint the tree, then build over Source/build's exe; bad GML
//                   is refused rather than built, since in an exe it is a
//                   modal dialog with no way back
//   4. cleanup      remove the bridge again
//   5. relaunch, with --launch
//
// Nothing else in Source/build is touched: gg2.ini, maps and logs stay.
// --dry-run stops after linting.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./tools/lib.js');
const gm8 = require('./tools/gm8.js');
const { inject } = require('./inject.js');
const { cleanup } = require('./cleanup.js');
const { runAgent, GAME_IMAGE } = require('./run-agent.js');

const USAGE = `
usage: node build-fast.js [--repo <path>] [--launch] [--dry-run] [--port <n>]

  --repo     the Gang Garrison 2 checkout (default: GG2_REPO, else the one
             you are in, else ../Gang-Garrison-2)
  --launch   relaunch the game afterwards and wait for the bridge
  --dry-run  lint the tree and stop, building nothing
  --port     bridge port to wait on with --launch (default 17777)
`;

async function buildFast({ repo, launch = false, dryRun = false, port = 17777 }) {
  const repoFull = path.resolve(repo);
  const tree = path.join(repoFull, 'Source', 'gg2');
  const build = path.join(repoFull, 'Source', 'build');
  const exeOut = path.join(build, 'Gang Garrison 2.exe');

  const started = Date.now();

  // The game holds its own exe open, and it is about to be replaced.
  if (!dryRun && (await lib.stopProcess(GAME_IMAGE))) lib.step('Stopped the running game');

  inject(repoFull, true);
  try {
    if (dryRun) {
      lib.step('Linting the tree');
      const failures = await lintTree(tree);
      if (failures.length) throw new Error(`the GML has errors:\n${failures.join('\n')}`);
      lib.ok('the tree lints clean');
      return;
    }
    lib.step('Building the executable');
    fs.mkdirSync(build, { recursive: true });
    await gm8.build(tree, exeOut);
  } finally {
    cleanup(repoFull, true);
  }

  lib.ok(`rebuilt in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (launch && !(await runAgent({ repo: repoFull, port }))) {
    throw new Error('the game was rebuilt but its bridge never came up - see the log tails above');
  }
}

// Every script and event file of the tree, through the lint server - the same
// check `build --lint` runs, without writing anything.
async function lintTree(tree) {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.gml$/i.test(e.name) || (/\.xml$/i.test(e.name) && !/_resources\.list\.xml$/i.test(e.name))) files.push(f);
    }
  };
  walk(tree);
  const failures = [];
  for (const f of files) {
    const text = lib.readText(f);
    const xml = /\.xml$/i.test(f);
    if (xml && !text.includes('<argument kind="STRING">')) continue;
    const r = await gm8.lint(text, { trees: [tree], xml, name: path.relative(tree, f) });
    if (r.note && r.ok && !r.findings.length) throw new Error(r.note);
    for (const e of r.errors || []) failures.push(`${e.file}:${e.line}:${e.col}: ${e.message} [${e.rule}]`);
  }
  return failures;
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
