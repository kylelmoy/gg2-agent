#!/usr/bin/env node
//=============================================================================
// doctor.js - check a machine can build and run the game, and say how to
// register the MCP server on it.
//
// Every one of these otherwise fails late and badly: a missing Game Maker
// install at the first build, a missing audio device as two modal dialogs and
// a dead game before any code runs, a missing checkout as a path error from
// whichever tool happened to be first. Checking them here costs nothing and
// needs no game running, so this is the first thing to run on a new machine.
//
// Nothing is changed except that gm8-builder is fetched if it is missing,
// which the first build would do anyway.
//=============================================================================

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib.js');
const gm8 = require('./gm8.js');

const USAGE = `
Usage: node tools/doctor.js [--repo <path>]

Checks Node, the platform, koffi, gm8-builder, a Game Maker 8 install, an
audio device and the game checkout, then prints the command that registers
the MCP server with Claude Code. Exits non-zero if anything required is
missing.

  --repo <path>   the game checkout to check (default: GG2_REPO, else the one
                  containing the working directory, else ../Gang-Garrison-2)
`;

const SERVER = path.join(__dirname, 'gg2-mcp-server.js');

// An active render endpoint, from the same registry keys Windows' own sound
// settings read. DeviceState 1 is DEVICE_STATE_ACTIVE; a disabled, unplugged
// or absent device is anything else.
function audioEndpoints() {
  const r = spawnSync(
    'reg',
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render', '/s', '/v', 'DeviceState'],
    { encoding: 'utf8', windowsHide: true }
  );
  if (r.status !== 0 && !r.stdout) return null;
  return (r.stdout.match(/DeviceState\s+REG_DWORD\s+0x1\b/g) || []).length;
}

function main() {
  const { flags } = lib.parseArgs(process.argv.slice(2), ['repo']);
  if (flags.help) lib.helpAndExit(USAGE);

  let bad = 0;
  const need = (m) => { lib.fail(m); bad++; };

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) lib.ok(`Node ${process.versions.node}`);
  else need(`Node ${process.versions.node} - 18 or later is needed`);

  // The launcher clears GM8's modal dialogs through user32, and the game is a
  // Windows executable; building and linting alone would work elsewhere.
  if (process.platform === 'win32') lib.ok('Windows');
  else need(`${process.platform} - running the game needs Windows (building and linting do not)`);

  try {
    require('koffi');
    lib.ok('koffi');
  } catch (e) {
    need('koffi is not installed - run: npm install');
  }

  try {
    lib.ok(`gm8-builder ${gm8.exe()}`);
  } catch (e) {
    need(e.message);
  }

  const gm8Dir = gm8.findInstall();
  if (gm8Dir) lib.ok(`Game Maker 8 ${gm8Dir}`);
  else need('Game Maker 8 install not found (needs rundata and fnames) - set GM8_DIR to one');

  if (process.platform === 'win32') {
    const n = audioEndpoints();
    if (n === null) lib.warn('could not read the audio devices; the game will not start without one');
    else if (n > 0) lib.ok(`${n} audio device${n === 1 ? '' : 's'}`);
    else need('no active audio device - GM8 cannot start without one (over RDP: turn on audio redirection)');
  }

  const chosen = flags.repo
    ? { repo: path.resolve(flags.repo), reason: '--repo' }
    : lib.defaultRepoWithReason();
  if (lib.isGg2Checkout(chosen.repo)) {
    lib.ok(`game checkout ${chosen.repo} (${chosen.reason})`);
    if (!fs.existsSync(path.join(chosen.repo, 'Source', 'build'))) lib.detail('not built yet - node build-agent.js --repo "' + chosen.repo + '"');
  } else {
    lib.warn(`no Gang Garrison 2 checkout at ${chosen.repo} (${chosen.reason})`);
    lib.detail('clone https://github.com/Gang-Garrison-2/Gang-Garrison-2 there, set GG2_REPO,');
    lib.detail('or open your editor session inside a checkout - the server uses that one');
  }

  process.stdout.write(
    '\nRegister the MCP server with Claude Code, once for every project:\n\n' +
      `  claude mcp add gg2 -s user -- node "${SERVER}"\n\n` +
      'It works on the checkout the session is opened in, else Gang-Garrison-2 beside\n' +
      'gg2-agent; add  -e GG2_REPO=<path>  before the -- to pin one, and gg2_checkout\n' +
      'switches between forks or worktrees mid-session.\n'
  );
  process.exit(bad ? 1 : 0);
}

main();
