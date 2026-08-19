#!/usr/bin/env node
//=============================================================================
// session.js - run a dedicated server and its clients as one addressable set.
//
// Half of Gang Garrison 2 is the network protocol, and none of it is observable
// from inside a single process: a change to how a player's position is sent is
// only really tested by a second game receiving it. This starts a server and as
// many clients as asked for, names them, and registers each one so the MCP
// tools can address them by name.
//
// Three settings decide whether this works at all, and all three live in
// gg2.ini beside the executable rather than on the command line:
//
//   UseLobby        a dedicated server announces itself to the public lobby
//                   unless this is 0. It is set to 0 here, every time, before
//                   anything starts.
//   HostingPort     the port the server listens on. There is no flag for it,
//                   so clients are pointed at whatever the file says.
//   MultiClientLimit  how many connections the server accepts from one address,
//                   which is exactly what a local session is.
//
// Both games share that one file and one working directory. Their logs do not:
// those are named after the bridge port.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const instances = require('./instances.js');
const { runAgent, GAME_IMAGE } = require('../run-agent.js');

const USAGE = `
usage: node tools/session.js <start|stop|list> [options]

  start   --clients <n>   how many clients to bring up (default 1)
          --map <name>    the map the server opens on (default ctf_truefort)
          --port <n>      bridge port for the server; clients take the next
                          ports up (default 17777)
  stop    --name <label>  stop one member, or all of them if not given
  list                    what is running

  --repo <path>           the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
`;

const DEFAULT_MAP = 'ctf_truefort';
const SERVER_NAME = 'server';

const buildDirOf = (repo) => path.join(path.resolve(repo), 'Source', 'build');

//---------------------------------------------------------------------------
// gg2.ini
//
// Read and written byte for byte, like everything else this repo edits: the
// file belongs to the game, is rewritten by it, and carries settings this
// tooling has no business reformatting.
//---------------------------------------------------------------------------

function readIni(buildDir) {
  const file = path.join(buildDir, 'gg2.ini');
  return { file, text: fs.existsSync(file) ? lib.readText(file) : '' };
}

// The value of a key in a section, or null. Section names are matched loosely
// because the game writes them as [Settings] and reads them case-insensitively.
function iniValue(text, section, key) {
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[(.+?)\]\s*$/.exec(line);
    if (head) {
      inSection = head[1].toLowerCase() === section.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const kv = /^\s*([^=;]+?)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv && kv[1].toLowerCase() === key.toLowerCase()) return kv[2];
  }
  return null;
}

// Set a key, adding it to the section - or the section itself - if missing.
// Returns the new text, or null if it already said that.
function withIniValue(text, section, key, value) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let inSection = false;
  let sectionEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*\[(.+?)\]\s*$/.exec(lines[i]);
    if (head) {
      if (inSection) break; // the next section starts; ours ended above
      inSection = head[1].toLowerCase() === section.toLowerCase();
      if (inSection) sectionEnd = i;
      continue;
    }
    if (!inSection) continue;
    if (lines[i].trim()) sectionEnd = i;
    const kv = /^\s*([^=;]+?)\s*=\s*(.*?)\s*$/.exec(lines[i]);
    if (kv && kv[1].toLowerCase() === key.toLowerCase()) {
      if (kv[2] === String(value)) return null;
      lines[i] = `${kv[1]}=${value}`;
      return lines.join(nl);
    }
  }

  if (sectionEnd < 0) {
    lines.push(`[${section}]`, `${key}=${value}`);
  } else {
    lines.splice(sectionEnd + 1, 0, `${key}=${value}`);
  }
  return lines.join(nl);
}

function setIniValue(buildDir, section, key, value) {
  const { file, text } = readIni(buildDir);
  const next = withIniValue(text, section, key, value);
  if (next === null) return false;
  lib.writeText(file, next);
  return true;
}

//---------------------------------------------------------------------------
// Starting and stopping
//---------------------------------------------------------------------------

async function start({ repo, clients = 1, map = DEFAULT_MAP, port = 17777, timeoutSeconds = 60, quiet = false }) {
  const buildDir = buildDirOf(repo);
  if (!fs.existsSync(path.join(buildDir, GAME_IMAGE))) {
    throw new Error(`game not built: ${path.join(buildDir, GAME_IMAGE)} (run build-agent.js first)`);
  }

  const { text } = readIni(buildDir);
  const hostingPort = Number(iniValue(text, 'Settings', 'HostingPort') || 8190);
  const clientLimit = Number(iniValue(text, 'Settings', 'MultiClientLimit') || 3);
  if (clients > clientLimit) {
    throw new Error(
      `MultiClientLimit in gg2.ini is ${clientLimit}, so the server will refuse the ${clients} clients asked ` +
        `for - every one of them connects from 127.0.0.1. Raise the setting deliberately, or ask for fewer.`
    );
  }

  // A dedicated server announces itself to the public lobby unless this is off,
  // and a test session has no business appearing in a server list.
  if (setIniValue(buildDir, 'Settings', 'UseLobby', 0)) lib.ok('set UseLobby=0 in gg2.ini', quiet);

  // One clean slate, then nothing else in this function is allowed to kill by
  // image name: every later launch would take the earlier ones with it.
  await lib.stopProcess(GAME_IMAGE);
  instances.prune(buildDir);

  const started = [];

  lib.step(`Starting the server on ${map}, hosting port ${hostingPort}`, quiet);
  if (!(await runAgent({
    repo,
    port,
    name: SERVER_NAME,
    role: 'server',
    timeoutSeconds,
    quiet,
    stopOthers: false,
    gameArgs: ['-dedicated', '-map', map],
  }))) {
    throw new Error('the server never opened its bridge - see the log tails above');
  }
  started.push({ name: SERVER_NAME, port, role: 'server' });

  for (let i = 1; i <= clients; i++) {
    const name = `client${i}`;
    const clientPort = port + i;
    lib.step(`Starting ${name} against 127.0.0.1:${hostingPort}`, quiet);
    if (!(await runAgent({
      repo,
      port: clientPort,
      name,
      role: 'client',
      timeoutSeconds,
      quiet,
      stopOthers: false,
      gameArgs: ['-server', '127.0.0.1', '-port', String(hostingPort)],
    }))) {
      throw new Error(`${name} never opened its bridge - see the log tails above`);
    }
    started.push({ name, port: clientPort, role: 'client' });
  }

  lib.ok(`session up: ${started.map((s) => `${s.name} (${s.port})`).join(', ')}`, quiet);
  return started;
}

// Stopping a member kills the game by pid, not by image name: its launcher
// notices the child exit, takes the entry out of the register and leaves.
async function stop({ repo, name, quiet = false }) {
  const buildDir = buildDirOf(repo);
  const live = instances.list(buildDir);
  const targets = name ? live.filter((i) => i.name === name || String(i.port) === String(name)) : live;

  if (targets.length === 0) {
    lib.skip(name ? `nothing running called ${name}` : 'nothing to stop', quiet);
    return [];
  }

  for (const t of targets) {
    lib.capture('taskkill', ['/F', '/PID', String(t.pid)]);
    lib.step(`stopped ${t.name} (pid ${t.pid}, port ${t.port})`, quiet);
  }

  // The launchers unregister themselves; give them a moment before reporting.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!instances.list(buildDir).some((i) => targets.some((t) => t.port === i.port))) break;
    await lib.sleep(250);
  }
  instances.prune(buildDir);
  return targets;
}

const list = (repo) => instances.list(buildDirOf(repo));

if (require.main === module) {
  const { flags, positional } = lib.parseArgs(process.argv.slice(2), ['repo', 'clients', 'map', 'port', 'name', 'timeout']);
  if (flags.help || positional.length === 0) lib.helpAndExit(USAGE);
  const repo = flags.repo || lib.defaultRepo();

  lib.cli(async () => {
    switch (positional[0]) {
      case 'start':
        await start({
          repo,
          clients: flags.clients ? Number(flags.clients) : 1,
          map: flags.map || DEFAULT_MAP,
          port: flags.port ? Number(flags.port) : 17777,
          timeoutSeconds: flags.timeout ? Number(flags.timeout) : 60,
        });
        return;
      case 'stop':
        await stop({ repo, name: flags.name });
        return;
      case 'list': {
        const live = list(repo);
        if (live.length === 0) return lib.skip('no games are running');
        for (const i of live) lib.detail(`${i.name.padEnd(10)} port ${i.port}  pid ${i.pid}  ${i.role}`);
        return;
      }
      default:
        lib.helpAndExit(USAGE);
    }
  });
}

module.exports = { start, stop, list, iniValue, withIniValue, setIniValue, readIni, DEFAULT_MAP };
