//=============================================================================
// lib.js - shared helpers for the build scripts.
//
// All file edits go through here so two things stay true across the split
// source tree: bytes are preserved exactly (the tree mixes LF and CRLF, and
// GmkSplitter parses these files as XML, where a stray BOM or a flipped line
// ending shows up as noise in every future diff), and every tool call reports
// failure by exit code rather than by whatever it wrote to stderr.
//
// Output goes through a sink so the same code can print to a terminal or be
// collected by the MCP server, whose stdout carries JSON-RPC and nothing else.
//=============================================================================

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

//---------------------------------------------------------------------------
// Output
//---------------------------------------------------------------------------

const COLOUR = { cyan: '\x1b[36m', green: '\x1b[32m', grey: '\x1b[90m', yellow: '\x1b[33m', red: '\x1b[31m', off: '\x1b[0m' };

const out = { sink: (line) => process.stdout.write(line + '\n'), colour: process.stdout.isTTY };

// Returns a function that puts the previous sink back, so a caller that only
// wants to capture output for a moment - rendering a report to a string, say -
// can restore whatever was there instead of assuming it was stdout. Assuming is
// wrong inside the MCP server, whose sink is its own stderr log.
function setSink(fn) {
  const prevSink = out.sink;
  const prevColour = out.colour;
  out.sink = fn;
  out.colour = false;
  return () => {
    out.sink = prevSink;
    out.colour = prevColour;
  };
}

function tag(mark, colour, msg) {
  out.sink(out.colour ? `${colour}[${mark}]${COLOUR.off} ${msg}` : `[${mark}] ${msg}`);
}

const step = (m, quiet) => { if (!quiet) tag('*', COLOUR.cyan, m); };
const ok = (m, quiet) => { if (!quiet) tag('+', COLOUR.green, m); };
const skip = (m, quiet) => { if (!quiet) tag('=', COLOUR.grey, m); };
const warn = (m) => tag('-', COLOUR.yellow, m);
const fail = (m) => tag('!', COLOUR.red, m);
const detail = (m) => out.sink('      ' + m);

//---------------------------------------------------------------------------
// Arguments
//
// Flags are --name or --name value; anything else is a positional. Kept this
// small on purpose - these scripts have a handful of options each.
//---------------------------------------------------------------------------

function parseArgs(argv, valueFlags = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (valueFlags.includes(name)) flags[name] = argv[++i];
    else flags[name] = true;
  }
  return { flags, positional };
}

function helpAndExit(usage) {
  process.stdout.write(usage.trim() + '\n');
  process.exit(0);
}

//---------------------------------------------------------------------------
// The game checkout
//---------------------------------------------------------------------------

const isGg2Checkout = (dir) =>
  fs.existsSync(path.join(dir, 'Source', 'gg2', 'Objects', '_resources.list.xml'));

// The checkout nearest `dir`: itself or an ancestor, so a session opened in a
// subdirectory of a fork or worktree still finds it. null when there is none.
function enclosingCheckout(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (isGg2Checkout(d)) return d;
    if (path.dirname(d) === d) return null;
  }
}

// Which checkout to work on when none is named, and why. GG2_REPO wins, then
// the checkout the process was started in - an MCP server is started in the
// editor session's directory, so opening a session in a fork or a worktree is
// how to point the tools at it - then a Gang-Garrison-2 beside this repo.
function defaultRepoWithReason() {
  if (process.env.GG2_REPO) return { repo: path.resolve(process.env.GG2_REPO), reason: 'GG2_REPO' };
  const here = enclosingCheckout(process.cwd());
  if (here) return { repo: here, reason: 'working directory' };
  // tools/ -> gg2-agent/ -> a sibling Gang-Garrison-2 checkout
  return { repo: path.resolve(__dirname, '..', '..', 'Gang-Garrison-2'), reason: 'beside gg2-agent' };
}

const defaultRepo = () => defaultRepoWithReason().repo;

// Where the built game, its logs and the instance register live.
//
// Every process that talks to a running game has to agree about this or the
// register resolves to nothing and a call goes to the wrong game (or no game).
// An explicit `repo` wins, then GG2_BUILD_DIR, then the default checkout's.
function findBuildDir(repo) {
  if (repo) return path.join(path.resolve(repo), 'Source', 'build');
  if (process.env.GG2_BUILD_DIR) return process.env.GG2_BUILD_DIR;
  return path.join(defaultRepo(), 'Source', 'build');
}

// The checkout a build directory belongs to - <repo>/Source/build -> <repo>.
const repoOfBuildDir = (buildDir) => path.resolve(buildDir, '..', '..');

function resolveGg2Tree(repo) {
  if (!fs.existsSync(repo)) throw new Error(`repo not found: ${repo}`);
  const tree = path.join(path.resolve(repo), 'Source', 'gg2');
  if (!fs.existsSync(path.join(tree, 'Objects', '_resources.list.xml'))) {
    throw new Error(`does not look like a Gang Garrison 2 checkout: ${path.resolve(repo)}`);
  }
  return tree;
}

//---------------------------------------------------------------------------
// Byte-preserving text edits
//
// latin1 maps every byte to one character and back, so a file read and written
// this way is unchanged except where we edited it - whatever its encoding.
//---------------------------------------------------------------------------

const readText = (p) => fs.readFileSync(p, 'latin1');
const writeText = (p, text) => fs.writeFileSync(p, Buffer.from(text, 'latin1'));
const newlineOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

// Insert `insert` immediately before the first line whose trimmed text equals
// `anchor`. Returns false if `insert` is already present.
function addBeforeLine(file, anchor, insert) {
  return insertLine(file, anchor, insert, 'before');
}

// Insert `insert` immediately after the first line whose trimmed text equals
// `anchor`. Returns false if `insert` is already present.
function addAfterLine(file, anchor, insert) {
  return insertLine(file, anchor, insert, 'after');
}

function insertLine(file, anchor, insert, where) {
  const text = readText(file);
  const next = insertLineText(text, anchor, insert, where);
  if (next === null) return false;
  writeText(file, next);
  return true;
}

// Same as insertLine, but on a string rather than a file - for text that lives
// inside something else, like an event's escaped GML. Returns null rather than
// writing anything if `insert` is already present; throws if `anchor` is not
// found, same as the file-based form.
function insertLineText(text, anchor, insert, where) {
  if (text.includes(insert.trim())) return null;

  const nl = newlineOf(text);
  const lines = text.split(/\r?\n/);
  const result = [];
  let done = false;
  for (const line of lines) {
    if (where === 'after') result.push(line);
    if (!done && line.trim() === anchor) {
      result.push(insert);
      done = true;
    }
    if (where === 'before') result.push(line);
  }
  if (!done) throw new Error(`anchor '${anchor}' not found`);
  return result.join(nl);
}

// Replace the first line whose trimmed text equals `from` with `to`, keeping
// that line's own indentation. Returns false if `to` is already there.
//
// This is what a call-site patch needs and insertLine cannot give it: the two
// sites the debug payload rewrites are both the braceless body of an `if`, so
// inserting a line beside one of them silently moves the original out of the
// branch it belongs to - the show_message would fire on every state update, and
// the show_error on every sprite lookup. Swapping the whole line for a call is
// the only edit that keeps the control flow it sits in.
function replaceLine(file, from, to) {
  const text = readText(file);
  const next = replaceLineText(text, from, to);
  if (next === null) return false;
  writeText(file, next);
  return true;
}

// Same as replaceLine, but on a string. Returns null rather than a copy if `to`
// is already present; throws if `from` is not found, same as insertLineText.
// Trims both ends of the match, so replaceLineText(t, a, b) and
// replaceLineText(t, b, a) are exact inverses whatever the indentation was.
function replaceLineText(text, from, to) {
  const nl = newlineOf(text);
  const lines = text.split(/\r?\n/);
  if (lines.some((l) => l.trim() === to.trim())) return null;

  let done = false;
  const out = lines.map((line) => {
    if (done || line.trim() !== from.trim()) return line;
    done = true;
    return line.slice(0, line.length - line.trimStart().length) + to.trim();
  });
  if (!done) throw new Error(`line '${from}' not found`);
  return out.join(nl);
}

// Remove every line whose trimmed text equals `line`. Returns false if none did.
function removeLine(file, line) {
  if (!fs.existsSync(file)) return false;
  const text = readText(file);
  const next = removeLineText(text, line);
  if (next === null) return false;
  writeText(file, next);
  return true;
}

// Same as removeLine, but on a string. Returns null if `line` was not present.
function removeLineText(text, line) {
  const nl = newlineOf(text);
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((l) => l.trim() !== line.trim());
  if (kept.length === lines.length) return null;
  return kept.join(nl);
}

//---------------------------------------------------------------------------
// Tools and processes
//---------------------------------------------------------------------------

// Run a program, forwarding its output line by line, and throw on a non-zero
// exit code.
function run(exe, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    let buf = '';
    const onData = (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim()) detail(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => reject(new Error(`could not run ${exe}: ${e.message}`)));
    child.on('close', (code) => {
      if (buf.trim()) detail(buf.trim());
      if (code !== 0) reject(new Error(`${path.basename(exe)} exited with code ${code}`));
      else resolve();
    });
  });
}

// Run a program and return its stdout, ignoring a non-zero exit code.
function capture(exe, args, cwd) {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').trim();
}

const gitStatus = (repo) =>
  capture('git', ['status', '--porcelain'], repo)
    .split(/\r?\n/)
    .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRunning(imageName) {
  const out = capture('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/NH', '/FO', 'CSV']);
  return out.toLowerCase().includes(imageName.toLowerCase());
}

// Stop a process by image name and wait for it to go. Returns false if it was
// not running, so callers can stay quiet in the common case.
async function stopProcess(imageName, timeoutMs = 5000) {
  if (!isRunning(imageName)) return false;
  spawnSync('taskkill', ['/F', '/IM', imageName], { encoding: 'utf8', windowsHide: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(imageName)) return true;
    await sleep(250);
  }
  throw new Error(`${imageName} is still running - close it and try again`);
}

// Launch a program and detach from it, the way the game and its launcher need.
function launchDetached(exe, args, cwd) {
  const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

function connectOnce(port, host) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (result) => {
      s.removeAllListeners();
      s.destroy();
      resolve(result);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await connectOnce(port, host)) return true;
  }
  return false;
}

//---------------------------------------------------------------------------
// CLI entry point wrapper: report failures the way the scripts always have.
//---------------------------------------------------------------------------

function cli(main) {
  main().catch((e) => {
    fail(e.message);
    process.exit(1);
  });
}

module.exports = {
  step, ok, skip, warn, fail, detail, setSink,
  parseArgs, helpAndExit, cli,
  defaultRepo, defaultRepoWithReason, isGg2Checkout, enclosingCheckout,
  resolveGg2Tree, findBuildDir, repoOfBuildDir,
  readText, writeText, addBeforeLine, addAfterLine, removeLine,
  insertLineText, removeLineText, replaceLine, replaceLineText,
  run, capture, gitStatus,
  sleep, isRunning, stopProcess, launchDetached, waitForPort,
};
