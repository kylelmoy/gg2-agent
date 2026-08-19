//=============================================================================
// instances.js - the register of running game instances.
//
// One game was enough while the agent only ever drove a single client. Half of
// Gang Garrison 2 is the network protocol, though, and nothing about a server
// and its clients is observable from inside one process - so the tooling has to
// be able to hold several games at once and address them by name.
//
// The launcher owns each game as a child process, so it is what writes here: an
// entry when the game starts, and no entry once it has gone. Everything else
// reads. The file lives beside the executable, with the logs.
//
// Nothing here locks. Two launchers starting at the same instant can lose an
// entry, which costs a name in a listing and nothing else, and a stale entry is
// pruned on the next read by asking the operating system whether the pid is
// still there.
//=============================================================================

const fs = require('fs');
const path = require('path');

const FILE = 'agent_instances.json';

const file = (dir) => path.join(dir, FILE);

function alive(pid) {
  if (!pid) return false;
  try {
    // Signal 0 asks whether the process exists without touching it.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // running, but not ours to signal
  }
}

function readRaw(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
    return Array.isArray(parsed.instances) ? parsed.instances : [];
  } catch (e) {
    return [];
  }
}

function writeRaw(dir, instances) {
  const tmp = file(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ instances }, null, 2));
  fs.renameSync(tmp, file(dir));
}

// Every instance that is still running, oldest first.
function list(dir) {
  const live = readRaw(dir).filter((i) => alive(i.pid));
  return live.sort((a, b) => (a.started || '').localeCompare(b.started || ''));
}

// Prune the dead and write the survivors back, so a listing does not grow
// forever across sessions.
function prune(dir) {
  const live = list(dir);
  if (live.length !== readRaw(dir).length) writeRaw(dir, live);
  return live;
}

function register(dir, entry) {
  const now = list(dir).filter((i) => i.port !== entry.port);
  now.push(Object.assign({ started: new Date().toISOString() }, entry));
  writeRaw(dir, now);
  return entry;
}

function unregister(dir, port) {
  writeRaw(dir, list(dir).filter((i) => i.port !== port));
}

// Resolve what an agent asked for - a name, a port, or nothing at all - to one
// running instance. Ambiguity is an error rather than a guess: picking a game at
// random and reporting on it as if it were the one asked for is worse than
// saying which names exist.
function resolve(dir, want) {
  const live = list(dir);
  if (live.length === 0) return null;

  if (want === undefined || want === null || want === '') {
    if (live.length === 1) return live[0];
    const primary = live.find((i) => i.role === 'server') || live.find((i) => i.role === 'solo');
    if (primary) return primary;
    throw new Error(
      'several games are running and none of them is the obvious one; pass instance: ' +
        live.map((i) => JSON.stringify(i.name)).join(', ')
    );
  }

  const asPort = typeof want === 'number' ? want : /^\d+$/.test(String(want)) ? Number(want) : null;
  const hit = live.find((i) => i.name === want || (asPort !== null && i.port === asPort));
  if (hit) return hit;

  throw new Error(
    `no running game called ${JSON.stringify(String(want))}. Running: ` +
      (live.map((i) => `${i.name} (port ${i.port})`).join(', ') || 'none')
  );
}

// The log files an instance writes, both named after its port so two games in
// one directory cannot interleave their output.
const bridgeLog = (dir, port) => path.join(dir, `agent_bridge_${port}.log`);
const launcherLog = (dir, port) => path.join(dir, `agent_launcher_${port}.log`);

// GM8's own error log. Not ours and not per port - the engine picks the name
// and writes it beside the executable, so two games in one directory share it.
// It matters because it is the only record of a compilation error inside
// execute_string: those raise no dialog at all, and the bridge replies "OK 0"
// as though nothing had happened.
const errorLog = (dir) => path.join(dir, 'game_errors.log');

module.exports = { list, prune, register, unregister, resolve, alive, bridgeLog, launcherLog, errorLog, FILE };
