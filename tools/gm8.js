//=============================================================================
// gm8.js - running gm8-builder, the Game Maker 8 builder and linter.
//
// gm8-builder is a separate project (../gm8-builder) that knows nothing about
// this game or the bridge. It writes a GM8 executable straight from the split
// tree - no Game Maker process, no gmksplit, ~2s for the whole game - and
// checks GML against GM8's own fnames table. Everything here that builds or
// lints goes through this file, so there is one place that finds the exe and
// the Game Maker install, and one place that speaks its output formats:
//
//   build()   `gm8-builder build`, failing with what it printed
//   lint()    a long-running `gm8-builder lint --serve`, started once per
//             process and asked one JSON line per check - about half a
//             millisecond each, where launching the exe per check would cost
//             tens
//
// The exe is looked for in GM8_BUILDER, then ../gm8-builder/dist (where
// `dotnet publish src/Gm8Builder.Cli -c Release -o dist` puts it), then PATH.
//
// It still needs a Game Maker 8.0 install - not to run it, but for the runner
// and libraries it copies into every build and the fnames file the linter
// reads. That is GM8_DIR, else whatever opens .gmk files, else the default
// install paths.
//=============================================================================

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const lib = require('./lib.js');

const EXE_NAME = 'gm8-builder.exe';

// The .gex functions this game's extension packages provide. gm8-builder
// knows those of the installed packages a tree uses; this list covers the
// rest, and a snippet linted without a tree.
const EXTENSIONS = path.join(__dirname, 'gml-extensions.txt');

function find() {
  const candidates = [
    process.env.GM8_BUILDER,
    path.resolve(__dirname, '..', '..', 'gm8-builder', 'dist', EXE_NAME),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (d && fs.existsSync(path.join(d, EXE_NAME))) return path.join(d, EXE_NAME);
  }
  return null;
}

function exe() {
  const found = find();
  if (!found) {
    throw new Error(
      `${EXE_NAME} not found. Check out gm8-builder beside this repo and publish it ` +
        '(cd ../gm8-builder && dotnet publish src/Gm8Builder.Cli -c Release -o dist), or set GM8_BUILDER.'
    );
  }
  return found;
}

// The directory holding Game Maker's rundata and fnames. The .gmk file
// association is read with reg.exe once and remembered.
let installCache;
function findInstall() {
  if (installCache !== undefined) return installCache;
  const isInstall = (d) => d && fs.existsSync(path.join(d, 'rundata')) && fs.existsSync(path.join(d, 'fnames'));
  const candidates = [process.env.GM8_DIR];
  const r = spawnSync('reg', ['query', 'HKCR\\gmkfile\\shell\\open\\command', '/ve'], { encoding: 'utf8', windowsHide: true });
  const m = /"([^"]*Game_Maker\.exe)"/i.exec(r.stdout || '');
  if (m) candidates.push(path.dirname(m[1]));
  candidates.push('C:\\Program Files (x86)\\Game_Maker_8', 'C:\\Program Files\\Game_Maker_8');
  installCache = candidates.find(isInstall) || null;
  return installCache;
}

function install(explicit) {
  const found = explicit || findInstall();
  if (!found) {
    throw new Error('Game Maker 8 install not found (it needs rundata and fnames). Pass --gm8 <dir> or set GM8_DIR.');
  }
  return found;
}

// Build a split tree into an executable, with gm8x_fix's runner patches - the
// game has always shipped with them. With `lint`, the tree's GML is checked
// first and nothing is written if it has errors. Rejects with everything
// gm8-builder said, since a lint failure is a list and not a line.
function build(tree, out, { gm8Dir = null, lint = true, gm8xFix = true } = {}) {
  const args = ['build', tree, out, '--gm8', install(gm8Dir)];
  if (gm8xFix) args.push('--gm8x-fix');
  if (lint) args.push('--lint');
  return new Promise((resolve, reject) => {
    const child = spawn(exe(), args, { windowsHide: true });
    const said = [];
    const see = (line) => line.trim() && said.push(line.replace(/^gm8-builder: /, ''));
    readline.createInterface({ input: child.stdout }).on('line', see);
    readline.createInterface({ input: child.stderr }).on('line', see);
    child.on('error', (e) => reject(new Error(`could not run gm8-builder: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(said.join('\n') || `gm8-builder build exited with code ${code}`));
      for (const l of said) (l.startsWith('warning: ') ? lib.warn(l.slice(9)) : lib.detail(l));
      resolve();
    });
  });
}

//---------------------------------------------------------------------------
// The lint server
//
// One `gm8-builder lint --serve` per process, started on first use and reused.
// It keeps the engine's fnames and every tree's symbols in memory, and notices
// a resource added to or removed from a tree on the very next request.
//
// The child is unref'd: a CLI that lints once still exits when it is done.
// If it dies, everything waiting on it is rejected and the next check starts
// a new one.
//---------------------------------------------------------------------------

let server = null;

function startServer() {
  // stderr is ignored rather than piped: an unread pipe is one more handle
  // keeping this process alive after the last answer.
  const child = spawn(exe(), ['lint', '--serve', '--extensions', EXTENSIONS, '--gm8', install()], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let nextId = 1;
  child.unref();
  child.stdout.unref?.();
  child.stdin.unref?.();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch (e) {
      return;
    }
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (pending.size === 0) child.stdout.unref?.();
    waiter.resolve(reply);
  });
  const fail = (why) => {
    if (server === s) server = null;
    for (const w of pending.values()) w.reject(new Error(`gm8-builder lint server ${why}`));
    pending.clear();
  };
  child.on('exit', (code) => fail(`exited (code ${code})`));
  child.on('error', (e) => fail(`could not start: ${e.message}`));
  child.stdin.on('error', () => {});

  const s = {
    ask(request) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        // Keep the process alive only while an answer is owed.
        child.stdout.ref?.();
        child.stdin.write(JSON.stringify({ ...request, id }) + '\n');
      });
    },
    stop() {
      child.stdin.end();
    },
  };
  return s;
}

// Check a snippet, or every STRING argument of an event file when `xml` is set.
// Resolves { ok, findings, errors } - or { ok: true, note } when linting could
// not run at all, because a missing tool must never block real work.
async function lint(code, { trees = [], xml = false, name = '<gml>' } = {}) {
  if (!find()) return { ok: true, findings: [], errors: [], note: `lint unavailable: ${EXE_NAME} not found` };
  if (!findInstall()) return { ok: true, findings: [], errors: [], note: 'lint unavailable: Game Maker 8 install not found' };
  if (!server) server = startServer();
  try {
    const r = await server.ask({ code, xml, name, trees: trees.map((t) => path.resolve(t)) });
    if (r.error) return { ok: true, findings: [], errors: [], note: 'lint unavailable: ' + r.error };
    return { ok: r.ok, findings: r.findings, errors: r.errors, note: r.note };
  } catch (e) {
    return { ok: true, findings: [], errors: [], note: 'lint unavailable: ' + e.message };
  }
}

function stopLint() {
  if (server) server.stop();
  server = null;
}

module.exports = { find, exe, findInstall, install, build, lint, stopLint, EXTENSIONS };
