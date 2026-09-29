//=============================================================================
// gm8.js - running gm8-builder, the Game Maker 8 builder and linter.
//
// gm8-builder (github.com/kylelmoy/gm8-builder) is a separate project that
// knows nothing about this game or the bridge. It writes a GM8 executable
// straight from the split tree - no Game Maker process, ~2s for the whole game,
// gm8x_fix's runner patches built in - and checks GML against GM8's own fnames
// table. Everything here that builds or lints goes through this file, so there
// is one place that finds the exe and the Game Maker install, and one place
// that speaks its output formats:
//
//   build()   `gm8-builder build`, failing with what it printed
//   lint()    a long-running `gm8-builder lint --serve`, started once per
//             process and asked one JSON line per check - about half a
//             millisecond each, where launching the exe per check would cost
//             tens
//
// It is a dependency, not part of this repo: RELEASE pins one published
// release, and `node tools/gm8.js fetch` (run by `npm install`, and by find()
// the first time it is missing) downloads that release's zip, checks it
// against the pinned SHA-256, and unpacks it under .deps/, which is ignored.
// GM8_BUILDER points at any other exe instead - a local build of gm8-builder,
// say - and skips all of that. To move to a new release, change RELEASE.
//
// It still needs a Game Maker 8.0 install - not to run it, but for the runner
// and libraries it copies into every build and the fnames file the linter
// reads. That is GM8_DIR, else whatever opens .gmk files, else the default
// install paths.
//=============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const lib = require('./lib.js');

const RELEASE = {
  version: '0.2.0',
  assets: {
    'win32-x64': { name: 'win-x64', sha256: 'c1e625b5d81be52fceab922b582097c0bee2979a1b996616ab556aac25e7e7ec' },
    'linux-x64': { name: 'linux-x64', sha256: 'f034f2eb07eb8c370bf6bf09c5c395c524ca7b256a7e6998fed5b3d8e97ae9fe' },
    'darwin-arm64': { name: 'osx-arm64', sha256: 'ab690cbb3c81c3aeeecf2f98b886bd8e910538ea65a46d4d2461d6dc696f97c2' },
  },
};

const EXE_NAME = process.platform === 'win32' ? 'gm8-builder.exe' : 'gm8-builder';
const DEPS = path.join(__dirname, '..', '.deps', 'gm8-builder', RELEASE.version);

// The .gex functions this game's extension packages provide. gm8-builder
// knows those of the installed packages a tree uses; this list covers the
// rest, and a snippet linted without a tree.
const EXTENSIONS = path.join(__dirname, 'gml-extensions.txt');

function asset() {
  const a = RELEASE.assets[`${process.platform}-${process.arch}`];
  if (!a) throw new Error(`gm8-builder v${RELEASE.version} has no build for ${process.platform}-${process.arch}`);
  const file = `gm8-builder-v${RELEASE.version}-${a.name}.zip`;
  return { ...a, file, url: `https://github.com/kylelmoy/gm8-builder/releases/download/v${RELEASE.version}/${file}` };
}

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'gg2-agent' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${url}: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Download, verify and unpack the pinned release into DEPS. Resolves the exe.
async function fetchBuilder({ quiet = false } = {}) {
  const exePath = path.join(DEPS, EXE_NAME);
  if (fs.existsSync(exePath)) return exePath;
  const a = asset();
  lib.step(`Fetching gm8-builder v${RELEASE.version} (${a.file})`, quiet);
  const zip = await get(a.url);
  const digest = crypto.createHash('sha256').update(zip).digest('hex');
  if (digest !== a.sha256) throw new Error(`${a.file}: sha256 ${digest}, expected ${a.sha256}`);

  // Unpacked beside DEPS and renamed into place, so a failure halfway never
  // leaves something find() would take for a finished install. Beside, not in
  // the system temp directory: a rename cannot cross drives.
  fs.mkdirSync(path.dirname(DEPS), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(path.dirname(DEPS), '.fetch-'));
  try {
    const zipPath = path.join(tmp, a.file);
    fs.writeFileSync(zipPath, zip);
    // Windows' own tar reads zip; the tar Git for Windows puts first on PATH does not.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'unzip';
    const args = process.platform === 'win32' ? ['-xf', zipPath, '-C', tmp] : ['-q', zipPath, '-d', tmp];
    const r = spawnSync(tar, args, { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`could not unpack ${a.file}: ${(r.stderr || r.error || '').toString().trim()}`);
    const unpacked = path.join(tmp, `gm8-builder-${a.name}`);
    if (!fs.existsSync(path.join(unpacked, EXE_NAME))) throw new Error(`${a.file} has no ${EXE_NAME}`);
    fs.rmSync(DEPS, { recursive: true, force: true });
    fs.renameSync(unpacked, DEPS);
    if (process.platform !== 'win32') fs.chmodSync(exePath, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  lib.ok(`gm8-builder v${RELEASE.version} in ${path.relative(path.join(__dirname, '..'), DEPS)}`, quiet);
  return exePath;
}

// find() is synchronous - gml-lint's CLI and the lint server need an answer
// on the spot - so a missing release is fetched by a child process, once per
// process. Offline, it stays missing and lint() says so rather than blocking.
let fetchTried = false;
function find() {
  if (process.env.GM8_BUILDER) return fs.existsSync(process.env.GM8_BUILDER) ? process.env.GM8_BUILDER : null;
  const exePath = path.join(DEPS, EXE_NAME);
  if (!fs.existsSync(exePath) && !fetchTried) {
    fetchTried = true;
    spawnSync(process.execPath, [__filename, 'fetch', '--quiet'], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  }
  return fs.existsSync(exePath) ? exePath : null;
}

function exe() {
  const found = find();
  if (!found) {
    throw new Error(
      process.env.GM8_BUILDER
        ? `GM8_BUILDER is set to ${process.env.GM8_BUILDER}, which does not exist.`
        : `gm8-builder v${RELEASE.version} is not installed and could not be fetched. Run: node tools/gm8.js fetch`
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

if (require.main === module) {
  const { positional, flags } = lib.parseArgs(process.argv.slice(2), []);
  if (flags.help || positional[0] !== 'fetch') {
    lib.helpAndExit(`
usage: node tools/gm8.js fetch [--quiet] [--soft]

  Download gm8-builder v${RELEASE.version}, check its SHA-256 and unpack it into
  .deps/. Does nothing if it is already there. npm install runs this.

  --soft   warn rather than fail if it cannot be fetched - what npm install
           uses, so an offline install still succeeds; the first build or lint
           tries again.
`);
  }
  lib.cli(async () => {
    try {
      await fetchBuilder({ quiet: !!flags.quiet });
    } catch (e) {
      if (!flags.soft) throw e;
      console.warn(`warning: could not fetch gm8-builder (${e.message}); it will be fetched on first use`);
    }
  });
}

module.exports = { find, exe, fetchBuilder, findInstall, install, build, lint, stopLint, EXTENSIONS, RELEASE };
