#!/usr/bin/env node
//=============================================================================
// run-agent.js - launch the built game with the agent bridge listening.
//
// Starts the game through tools/launcher.js, which stays resident, dismisses
// GM8 message boxes and records the instance in the register. Then waits for
// the bridge to accept connections, so this only returns once the game is
// actually driveable.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./tools/lib.js');
const instances = require('./tools/instances.js');

const USAGE = `
usage: node run-agent.js [--repo <path>] [--port <n>] [--name <label>]
                         [--role <role>] [--keep] [--timeout <seconds>]
                         [-- <game args>]

  --repo     the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
  --port     bridge port (default 17777)
  --name     what to call this instance in the register (default: agent)
  --role     solo, server or client - how gg2_* tools pick a default (default solo)
  --keep     leave any game that is already running alone
  --timeout  how long to wait for the bridge (default 60)

  Anything after -- is passed to the game, e.g. -- -dedicated -map ctf_conflict
`;

const GAME_IMAGE = 'Gang Garrison 2.exe';

async function runAgent({
  repo,
  port = 17777,
  timeoutSeconds = 60,
  quiet = false,
  name = 'agent',
  role = 'solo',
  gameArgs = [],
  stopOthers = true,
}) {
  const buildDir = path.join(path.resolve(repo), 'Source', 'build');
  const exe = path.join(buildDir, GAME_IMAGE);
  if (!fs.existsSync(exe)) throw new Error(`game not built: ${exe} (run build-agent.js first)`);

  const launcher = path.join(__dirname, 'tools', 'launcher.js');

  // Launching while the old process is still dying gives a sharing violation on
  // the exe. Killing by image name takes every copy with it, which is right for
  // a single game and wrong once a session is running - hence the escape hatch.
  if (stopOthers) await lib.stopProcess(GAME_IMAGE);

  lib.step(`Launching ${exe}${name ? ` as ${name}` : ''}`, quiet);
  lib.launchDetached(
    process.execPath,
    [launcher, exe, '--name', name, '--role', role, '-agentport', String(port), ...gameArgs],
    buildDir
  );

  if (await lib.waitForPort(port, '127.0.0.1', timeoutSeconds * 1000)) {
    lib.ok(`bridge is accepting connections on 127.0.0.1:${port}`, quiet);
    return true;
  }

  lib.fail(`bridge did not come up within ${timeoutSeconds}s`);
  for (const p of [instances.launcherLog(buildDir, port), instances.bridgeLog(buildDir, port)]) {
    if (!fs.existsSync(p)) continue;
    lib.warn(`--- ${path.basename(p)} ---`);
    for (const line of lib.readText(p).split(/\r?\n/).filter(Boolean).slice(-20)) lib.detail(line);
  }
  return false;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const split = argv.indexOf('--');
  const mine = split < 0 ? argv : argv.slice(0, split);
  const gameArgs = split < 0 ? [] : argv.slice(split + 1);

  const { flags } = lib.parseArgs(mine, ['repo', 'port', 'timeout', 'name', 'role']);
  if (flags.help) lib.helpAndExit(USAGE);
  lib.cli(async () => {
    const up = await runAgent({
      repo: flags.repo || lib.defaultRepo(),
      port: flags.port ? Number(flags.port) : 17777,
      timeoutSeconds: flags.timeout ? Number(flags.timeout) : 60,
      name: flags.name || 'agent',
      role: flags.role || 'solo',
      stopOthers: !flags.keep,
      gameArgs,
    });
    if (!up) process.exit(1);
  });
}

module.exports = { runAgent, GAME_IMAGE };
