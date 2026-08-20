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
const win32 = require('./tools/win32.js');

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

  // The single most common reason for exactly this failure: GM8 loads its
  // sound resources into DirectSound during engine startup, before any game
  // code runs, and a Remote Desktop session with no audio redirection has no
  // endpoint for that - two modal "no audio device" errors and a silent exit,
  // which from here looks identical to any other stuck-modal timeout. This
  // check is deterministic and cheap, so it is worth doing even though it
  // cannot tell audio redirection is or is not configured - only that the
  // session is remote at all.
  let remote = false;
  try {
    remote = win32.isRemoteSession();
  } catch (e) {
    /* best-effort: a failed check should not hide the real timeout below */
  }
  if (remote) {
    lib.warn(
      'this is a Remote Desktop session - if it has no audio redirection, GM8 hangs on a ' +
        '"no audio device" modal during startup and never gets as far as opening the bridge. ' +
        'Try `tscon <id> /dest:console` (see `query session` for <id>) to run on the console instead, ' +
        'or enable audio redirection for this RDP session.'
    );
  }

  // The second most common reason, and the most misleading one: a compile
  // error in any script takes down the whole startup, before AgentBridge's
  // Create event ever runs - no bridge log, no launcher "E|" line if the
  // dialog is still up, just a game window that opens, paints, and answers
  // Responding: True while doing nothing. Unlike show_message, TErrorForm's
  // text lives in a real TMemo and answers WM_GETTEXT, so it can be read from
  // out here - and it names the failing script and line outright.
  try {
    const inst = instances.list(buildDir).find((i) => i.port === port);
    if (inst) {
      for (const w of win32.windows({ pid: inst.pid, cls: 'TErrorForm' })) {
        const memo = win32.descendants(w.hwnd).find((d) => d.cls === 'TMemo');
        const text = memo && win32.controlText(memo.hwnd);
        if (text && text.trim()) {
          lib.warn('the game is showing an error dialog - this is almost certainly why the bridge never came up:');
          // The offending line's own newlines come back flattened into one
          // wall of text; the header lines above it carry the signal, so only
          // the first few are worth printing by default.
          for (const line of text.trim().split(/\r?\n/).filter(Boolean).slice(0, 8)) lib.detail(line);
        }
      }
    }
  } catch (e) {
    /* best-effort: a failed check should not hide the real timeout above */
  }

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
