#!/usr/bin/env node
//=============================================================================
// run-agent.js - launch the built game with the agent bridge listening.
//
// Starts the game through tools/launcher.js, which stays resident and dismisses
// GM8 message boxes. Then waits for the bridge to accept connections, so this
// only returns once the game is actually driveable.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./tools/lib.js');

const USAGE = `
usage: node run-agent.js [--repo <path>] [--port <n>] [--timeout <seconds>]

  --repo     the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
  --port     bridge port (default 17777)
  --timeout  how long to wait for the bridge (default 60)
`;

const GAME_IMAGE = 'Gang Garrison 2.exe';

async function runAgent({ repo, port = 17777, timeoutSeconds = 60, quiet = false }) {
  const buildDir = path.join(path.resolve(repo), 'Source', 'build');
  const exe = path.join(buildDir, GAME_IMAGE);
  if (!fs.existsSync(exe)) throw new Error(`game not built: ${exe} (run build-agent.js first)`);

  const launcher = path.join(__dirname, 'tools', 'launcher.js');

  // Launching while the old process is still dying gives a sharing violation
  // on the exe.
  await lib.stopProcess(GAME_IMAGE);

  lib.step(`Launching ${exe}`, quiet);
  lib.launchDetached(process.execPath, [launcher, exe, '-agentport', String(port)], buildDir);

  if (await lib.waitForPort(port, '127.0.0.1', timeoutSeconds * 1000)) {
    lib.ok(`bridge is accepting connections on 127.0.0.1:${port}`, quiet);
    return true;
  }

  lib.fail(`bridge did not come up within ${timeoutSeconds}s`);
  for (const name of ['agent_launcher.log', 'agent_bridge.log']) {
    const p = path.join(buildDir, name);
    if (!fs.existsSync(p)) continue;
    lib.warn(`--- ${name} ---`);
    for (const line of lib.readText(p).split(/\r?\n/).filter(Boolean).slice(-20)) lib.detail(line);
  }
  return false;
}

if (require.main === module) {
  const { flags } = lib.parseArgs(process.argv.slice(2), ['repo', 'port', 'timeout']);
  if (flags.help) lib.helpAndExit(USAGE);
  lib.cli(async () => {
    const up = await runAgent({
      repo: flags.repo || lib.defaultRepo(),
      port: flags.port ? Number(flags.port) : 17777,
      timeoutSeconds: flags.timeout ? Number(flags.timeout) : 60,
    });
    if (!up) process.exit(1);
  });
}

module.exports = { runAgent, GAME_IMAGE };
