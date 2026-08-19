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

function setSink(fn) {
  out.sink = fn;
  out.colour = false;
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

function defaultRepo() {
  return path.resolve(__dirname, '..', '..', 'Gang-Garrison-2');
}

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

// Locate a tool by name across candidate directories, then PATH.
function findTool(name, dirs) {
  for (const d of dirs) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return path.resolve(p);
  }
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${name} not found. Looked in: ${dirs.join('; ')} and PATH.`);
}

// Run a program, forwarding its output line by line, and throw on a non-zero
// exit code. Streaming matters here: the Game Maker step takes ~35 seconds.
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

// Hand a file to whatever is registered to open it - a .gmk opens Game Maker.
function openInShell(file) {
  const child = spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' });
  child.unref();
}

// Wait for a file to appear and stop growing. Game Maker writes its executable
// over several seconds, so "exists" is not the same as "finished".
async function waitForStableFile(file, timeoutMs, onWait, stableSeconds = 3) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let lastSize = -1;
  let held = 0;
  let announced = 0;

  while (Date.now() < deadline) {
    await sleep(1000);

    const waited = Math.round((Date.now() - started) / 1000);
    if (onWait && waited - announced >= 30) {
      announced = waited;
      onWait(waited);
    }

    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    if (size > 0 && size === lastSize) {
      if (++held >= stableSeconds) return true;
    } else {
      held = 0;
    }
    lastSize = size;
  }
  return false;
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
  defaultRepo, resolveGg2Tree,
  readText, writeText, addBeforeLine, addAfterLine, removeLine,
  insertLineText, removeLineText,
  findTool, run, capture, gitStatus,
  sleep, isRunning, stopProcess, launchDetached, waitForPort,
  openInShell, waitForStableFile,
};
