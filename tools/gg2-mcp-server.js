#!/usr/bin/env node
//=============================================================================
// gg2-mcp-server.js - an MCP server exposing running Gang Garrison 2 games to
// an AI agent.
//
// Talks MCP (JSON-RPC 2.0 over stdio) to the agent, and a small length-prefixed
// protocol to the AgentBridge object inside each game.
//
// Wire format to the game: uint32 little-endian length, then that many bytes.
// Replies come back framed the same way, as "OK", "OK <text>" or "ERR <text>".
//
// More than one game can be up at once - a dedicated server and its clients are
// the only way to see the network protocol work - so every tool that talks to a
// game takes an optional `instance`, resolved through the register that the
// launcher writes. With one game running it can be left out.
//
// This file has no dependencies of its own; only the launcher it starts needs
// one (koffi, for the handful of user32 calls that clear GM8's modal dialogs).
//
// Usage (in .mcp.json or claude mcp add):
//   node tools/gg2-mcp-server.js
//
// Environment:
//   GG2_AGENT_PORT   bridge port to assume when nothing is registered (17777)
//   GG2_BUILD_DIR    directory holding the game exe, the logs and the register
//=============================================================================

const net = require('net');
const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const instances = require('./instances.js');
const gmlerror = require('./gmlerror.js');
const image = require('./image.js');
const events = require('./events.js');
const session = require('./session.js');
const gmllint = require('./gml-lint.js');
const { buildFast } = require('../build-fast.js');

const DEFAULT_PORT = parseInt(process.env.GG2_AGENT_PORT || '17777', 10);
const HOST = '127.0.0.1';
const CALL_TIMEOUT_MS = 10000;
const ROOM_SPEED = 30; // what the game runs at, for turning frames into a timeout

// This server lives outside the game's repo, so find the build directory rather
// than assuming it sits alongside. GG2_BUILD_DIR overrides the search.
function findBuildDir() {
  if (process.env.GG2_BUILD_DIR) return process.env.GG2_BUILD_DIR;
  const candidates = [
    // tools/ -> gg2-agent/ -> a sibling Gang-Garrison-2 checkout
    path.resolve(__dirname, '..', '..', 'Gang-Garrison-2', 'Source', 'build'),
    path.resolve(process.cwd(), 'Source', 'build'),
    path.resolve(__dirname, 'build'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}

const BUILD_DIR = findBuildDir();
const REPO = path.resolve(BUILD_DIR, '..', '..');
const TREE = path.join(REPO, 'Source', 'gg2');
const PAYLOAD = path.resolve(__dirname, '..', 'payload');

// stdout is the MCP channel and must carry nothing but JSON-RPC. That applies
// to the build scripts too, so lib's sink points at stderr from the start and
// is only ever swapped for a collector.
const log = (...a) => process.stderr.write('[gg2-mcp] ' + a.join(' ') + '\n');
const logSink = (line) => log(line);
lib.setSink(logSink);

//--------------------------------------------------------------------------
// Bridge clients, one per game
//
// Each running game listens on its own port and accepts a single connection,
// so a connection is kept per port and reused. Nothing here is shared between
// them: a client that dies takes only its own game's pending calls with it.
//--------------------------------------------------------------------------

class Bridge {
  constructor(port) {
    this.port = port;
    this.sock = null;
    this.rx = Buffer.alloc(0);
    this.pending = [];
  }

  disconnect(reason) {
    if (this.sock) {
      this.sock.removeAllListeners();
      this.sock.destroy();
      this.sock = null;
    }
    this.rx = Buffer.alloc(0);
    while (this.pending.length) this.pending.shift().reject(new Error(reason));
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.sock && !this.sock.destroyed) return resolve();

      const s = net.connect({ port: this.port, host: HOST });
      const onErr = (e) => {
        s.removeAllListeners();
        s.destroy();
        reject(
          new Error(
            `Cannot reach a game on ${HOST}:${this.port} (${e.code || e.message}). ` +
              `Is it running with -agent? Launch one with:\n` +
              `  node run-agent.js\n` +
              `or a server and its clients with gg2_session.`
          )
        );
      };
      s.once('error', onErr);
      s.once('connect', () => {
        s.removeListener('error', onErr);
        this.sock = s;

        s.on('data', (d) => {
          this.rx = Buffer.concat([this.rx, d]);
          for (;;) {
            if (this.rx.length < 4) break;
            const n = this.rx.readUInt32LE(0);
            if (this.rx.length < 4 + n) break;
            const payload = this.rx.slice(4, 4 + n).toString('latin1');
            this.rx = this.rx.slice(4 + n);
            const p = this.pending.shift();
            // A call that timed out leaves its slot behind rather than removing
            // it, because the game may still answer: the game replies in order,
            // one reply per request, so dropping the slot would hand a late
            // reply to the next caller and every answer after it would belong
            // to the call before. Swallowing it here keeps the two sides lined
            // up - a wrong answer that looks right is the worst thing this
            // bridge can produce.
            if (p && !p.abandoned) p.resolve(payload);
          }
        });
        s.on('error', (e) => this.disconnect('bridge socket error: ' + e.message));
        s.on('close', () => this.disconnect('the game closed the connection'));
        resolve();
      });
    });
  }

  // A request that spans frames - STEP, WAIT, a test run that stops on forty
  // message boxes - cannot answer inside the ordinary budget, so callers that
  // know how long they are asking for say so.
  async request(text, timeoutMs = CALL_TIMEOUT_MS) {
    await this.connect();
    // Where the logs stood before the command went out. The launcher writes
    // every dialog it dismisses to disk while a call is in flight, and that
    // happens whether or not the reply ever arrives - so a call that times out
    // can be explained from the same evidence watched() uses after a call that
    // returns, instead of guessing. This is the one thing the transport knows
    // about the world outside the socket, and it is why: without it, the same
    // failure reads as a full diagnosis or as nothing at all, depending only on
    // whether the reply beat the clock.
    const marks = logMarks(this.port);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.pending.findIndex((p) => p.timer === timer);
        // Requests are answered in order, so anything still abandoned ahead of
        // this one means the game never got as far as looking at this one.
        const behind = at < 0 ? 0 : this.pending.slice(0, at).filter((p) => p.abandoned).length;
        if (at >= 0) this.pending[at].abandoned = true;
        reject(new Error(timedOut(this.port, marks, timeoutMs, behind)));
      }, timeoutMs);

      this.pending.push({
        timer,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      const body = Buffer.from(text, 'latin1');
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length, 0);
      this.sock.write(Buffer.concat([head, body]));
    });
  }
}

const bridges = new Map();

function bridgeFor(port) {
  if (!bridges.has(port)) bridges.set(port, new Bridge(port));
  return bridges.get(port);
}

const disconnectAll = (reason) => {
  for (const b of bridges.values()) b.disconnect(reason);
};

//--------------------------------------------------------------------------
// Which game a call is for
//--------------------------------------------------------------------------

// Resolve the `instance` argument to something with a port and a name. With
// nothing registered - a game started by hand, say - the configured default
// port is assumed, so the simple case needs no session at all.
function target(want) {
  const found = instances.resolve(BUILD_DIR, want);
  if (found) return found;
  if (want !== undefined && want !== null && want !== '') {
    throw new Error(
      `no game is registered as ${JSON.stringify(String(want))}, and none is running. ` +
        'Start one with gg2_session, or run-agent.js.'
    );
  }
  return { name: 'default', port: DEFAULT_PORT, role: 'solo' };
}

// Send one command to a game and unwrap the OK/ERR envelope.
async function command(where, text, timeoutMs) {
  const reply = await bridgeFor(where.port).request(text, timeoutMs);
  if (reply.startsWith('ERR ')) throw new Error(reply.slice(4));
  if (reply === 'OK') return '';
  if (reply.startsWith('OK ')) return reply.slice(3);
  return reply;
}

//--------------------------------------------------------------------------
// What the game said in a dialog
//
// GM8 has no exceptions, so a GML error inside execute_string does not come
// back as one: the runtime raises a modal dialog, the launcher presses Ignore,
// execute_string returns 0, and the bridge cheerfully replies "OK 0". Without
// this, an agent asking for a value it mistyped gets a plausible wrong answer
// and no signal at all.
//
// The launcher writes every dialog it dismisses to its log, marked E| for a
// runtime error and M| for a show_message - and the difference matters, because
// the game's unit tests report through show_message and a failed assertion is
// not a crash. The game is frozen until the box is dismissed, so anything
// appended while a call was in flight belongs to that call.
//--------------------------------------------------------------------------

function logSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    return 0;
  }
}

// Text appended since `mark`. A relaunch truncates the log, so a mark past the
// end means the file was replaced and everything in it is new.
function logSince(file, mark) {
  const size = logSize(file);
  if (size === 0) return '';
  const from = size < mark ? 0 : mark;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

// The dialogs in a stretch of launcher log, one entry per box, each with its
// lines in order. Consecutive marked lines belong to the same dialog; anything
// unmarked - the "dismissed ..." line that follows - ends it.
function dialogsIn(text, mark) {
  const want = ` ${mark}| `;
  const out = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(want);
    if (at < 0) {
      current = null;
      continue;
    }
    const said = line.slice(at + want.length).trim();
    if (!current) out.push((current = []));
    if (said) current.push(said);
  }
  return out.map((lines) => lines.join('\n')).filter(Boolean);
}

const dialogsSince = (port, at, mark) => dialogsIn(logSince(instances.launcherLog(BUILD_DIR, port), at), mark);

// GM8 names the object an error happened in but never the file, and counts
// lines from the start of one piece of code. gmlerror turns that back into
// file:line - against the game tree, and against the payload, since the bridge
// only exists in the game's tree while it is injected.
function describeError(text) {
  for (const tree of [TREE, PAYLOAD]) {
    const e = gmlerror.locate(text, tree);
    if (e && e.located) {
      const guess = e.how === 'script' || e.how === 'event' ? '' : ` (matched by ${e.how})`;
      return `${e.file}:${e.line}: ${e.message || 'error'}${guess}`;
    }
  }
  const e = gmlerror.locate(text, TREE);
  if (!e) return null;
  return `${e.object ? 'object ' + e.object : 'unknown location'}: ${e.message || 'error'}`;
}

const annotate = (block) => describeError(block) || block.split('\n')[0];

// Where both logs stood at a moment. Everything a call can be blamed for is the
// difference between one of these and the same reading later, so a caller that
// might need to explain itself takes one before it starts.
const logMarks = (port) => ({
  launcher: logSize(instances.launcherLog(BUILD_DIR, port)),
  engine: logSize(instances.errorLog(BUILD_DIR)),
});

// A stuck-in-a-loop error (the same dialog raised every frame of a call that
// ran for a while) produces many byte-identical entries - all signal-free
// repeats past the first. The count is still useful, as a cheap proxy for how
// many frames the call took, so it is kept - just not the text.
function collapse(entries) {
  const out = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.text === e.text) last.count++;
    else out.push({ ...e, count: 1 });
  }
  return out;
}

// Everything the game complained about since `marks`, collapsed.
//
// There are two channels, and both have to be read. A *runtime* error raises a
// modal dialog, which the launcher dismisses and records. A *compilation* error
// inside execute_string raises nothing at all: GM8 appends it to game_errors.log
// beside the executable, execute_string returns 0, and the bridge replies
// "OK 0" - which is precisely the plausible wrong answer this exists to stop.
//
// Message boxes are a third thing and are off by default: show_message is how
// the game's own assertions report, and a failed assertion is a result, not a
// crash. They are worth having when explaining why nothing answered, since a
// box the launcher has not reached yet is exactly what a frozen game looks like.
function troublesSince(port, marks, { messages = false } = {}) {
  const found = dialogsSince(port, marks.launcher, 'E').map((e) => ({ kind: 'error', text: e, located: annotate(e) }));
  if (messages) {
    // Said, not raised: labelled so a reader does not take an assertion's own
    // report for a crash just because it is in the same list.
    for (const m of dialogsSince(port, marks.launcher, 'M')) {
      found.push({ kind: 'message', text: m, located: 'message box: ' + m.split('\n')[0] });
    }
  }
  const silent = logSince(instances.errorLog(BUILD_DIR), marks.engine).trim();
  if (silent) found.push({ kind: 'error', text: silent, located: describeError(silent) || silent.slice(0, 200) });
  return collapse(found);
}

// How many dialogs of each kind, counting the collapsed repeats.
const totalOf = (collapsed, kind) =>
  collapsed.filter((e) => e.kind === kind).reduce((sum, e) => sum + e.count, 0);

const MAX_REPORTED = 10;

// Two views of the same list: one located line each, then the raw text, so a
// reader who does not trust the located guess can still see what was said.
function renderTroubles(collapsed) {
  const suffix = (e) => (e.count > 1 ? ` (x${e.count})` : '');
  const shown = collapsed.slice(0, MAX_REPORTED);
  const rest = collapsed.length - shown.length;
  return (
    shown.map((e) => '  ' + e.located + suffix(e)).join('\n') +
    (rest > 0 ? `\n  ... and ${rest} more, see gg2_log` : '') +
    '\n\n' +
    shown.map((e) => e.text.split('\n').map((l) => '  | ' + l).join('\n') + suffix(e)).join('\n')
  );
}

// An identical dialog raised over and over inside one call is not that call
// failing once: it is code the game runs on its own schedule - a Step event, a
// server's per-tick service - failing every frame, and it will go on failing
// after the call returns. Nothing that can be sent over the bridge clears that.
const STUCK_REPEATS = 3;

function hints(collapsed) {
  const out = [];
  if (collapsed.some((e) => e.kind === 'error' && e.count >= STUCK_REPEATS)) {
    out.push(
      'The same error came back every frame, so something the game runs on its own - a Step event, a server ' +
        'tick - is raising it, not only this call. It will not clear on its own and no later call will ' +
        'succeed either: restart the instance (gg2_session stop, then start). The usual cause is an ' +
        'out-of-band call having touched a global that a live server object also uses every tick.'
    );
  }
  if (totalOf(collapsed, 'message') >= STUCK_REPEATS) {
    out.push(
      `${totalOf(collapsed, 'message')} message box(es) were shown. The game is frozen inside each until the ` +
        'launcher notices it, up to 250ms apart, so a call that shows many of them is slow rather than stuck - ' +
        'a longer timeout may be all it needs.'
    );
  }
  return out.length ? '\n\n' + out.join('\n\n') : '';
}

// Why a call never came back, from what the game wrote down while it was in
// flight. The launcher log is written independently of the socket, so this is
// available on exactly the path that used to have nothing but a guess.
function timedOut(port, marks, timeoutMs, behind = 0) {
  const head = `The game on port ${port} did not reply within ${timeoutMs}ms.`;
  const collapsed = troublesSince(port, marks, { messages: true });

  // Queued behind a call that never answered, which is worth saying outright:
  // this one may never have been read at all, and nothing about its own code
  // explains the wait.
  const queued =
    behind > 0
      ? `\n\n${behind} earlier call(s) never answered either. The game reads requests in order, so this one was ` +
        'waiting behind them and may not have been looked at: the bridge has stopped being serviced altogether. ' +
        'Restart the instance (gg2_session stop, then start).'
      : '';

  if (collapsed.length === 0) {
    return (
      `${head} The launcher dismissed no dialog while the call was in flight, so the game is probably not ` +
      'blocked on a modal one: more likely it is still working (ask for a longer timeout), it stopped stepping, ' +
      'or it is gone. gg2_ping says which; gg2_log with source: "launcher" shows the whole log.' +
      queued
    );
  }

  const counts = [
    totalOf(collapsed, 'error') ? `${totalOf(collapsed, 'error')} error dialog(s)` : '',
    totalOf(collapsed, 'message') ? `${totalOf(collapsed, 'message')} message box(es)` : '',
  ].filter(Boolean);

  return (
    `${head} While it was in flight the launcher dismissed ${counts.join(' and ')}, which is very likely why:\n` +
    renderTroubles(collapsed) +
    hints(collapsed) +
    queued
  );
}

// Run a bridge command and refuse to report success if the game reported an
// error while it ran.
async function watched(where, fn) {
  const marks = logMarks(where.port);
  const reply = await fn();

  const collapsed = troublesSince(where.port, marks);
  if (collapsed.length === 0) return reply;

  throw new Error(
    'The game reported an error during this call, so the reply cannot be trusted.\n' +
      renderTroubles(collapsed) +
      `\n\nThe bridge replied: ${JSON.stringify(reply)} - for a failed expression that is 0, not a real value.` +
      hints(collapsed)
  );
}

//--------------------------------------------------------------------------
// Lint gate
//
// A GML syntax error inside execute_string raises a modal dialog that freezes
// the game and every pending call. That is the worst failure mode here and it
// needs a person to clear it, so code is checked before it is ever sent.
//--------------------------------------------------------------------------

const lintGml = (code) => gmllint.check(code, { trees: [TREE, PAYLOAD] });

function lintOrThrow(code, skip) {
  if (skip) return;
  const res = lintGml(code);
  if (res.ok) return;
  const lines = res.errors.map((f) => `  line ${f.line}: ${f.message}`).join('\n');
  throw new Error(
    'Refused: this GML would not compile, and sending it would freeze the game on a modal error dialog.\n' +
      lines +
      '\nFix it, or pass skip_lint: true if you are certain the linter is wrong.'
  );
}

//--------------------------------------------------------------------------
// Unit tests
//
// The game has assertion helpers and real suites, but no entry point an agent
// can reach, and its code must not be changed to give it one.
//
// The helpers report through show_message, which the launcher does read - its
// DIALOGS table watches TMessageForm - but only best effort: Delphi paints some
// captions with no window handle at all, so a box sometimes comes back as
// "(dialog had no readable text)" and sometimes as the assertion in full. That
// is enough to report against, never enough to rely on.
//
// The counters behind those messages are exact, though. test_unit_begin
// zeroes global.testAssertions and global.testAssertionsSucceeded, every
// assertion moves them, and test_unit_end is the only thing that resets them -
// after it has shown its message. So the suite's own source is run here with
// its test_unit_end() calls taken out, and the totals are read directly. That
// is the same code the game runs, minus the one line whose only job is to
// report and forget.
//--------------------------------------------------------------------------

const TEST_DIR = path.join(TREE, 'Scripts', 'Unit tests');

function testSuites() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith('.gml') || !e.name.startsWith('test_')) continue;
      // The helpers are named like the suites; what distinguishes a suite is
      // that it opens one.
      if (/^test_(assert|unit)_/.test(e.name)) continue;
      const text = lib.readText(p);
      if (!text.includes('test_unit_begin')) continue;
      out.push({ name: path.basename(e.name, '.gml'), file: path.relative(REPO, p).split(path.sep).join('/'), abs: p });
    }
  };
  walk(TEST_DIR);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The one line of a suite's source whose only job is to report and forget.
const stripReporting = (source) => source.replace(/test_unit_end\s*\(\s*\)\s*;?/g, '');

// Have the game read its own suite off disk, rather than sending the source
// down the wire: no lint gate to fight, no payload-size ceiling, and no
// escaping concerns, since the tooling already knows the absolute path of
// every suite it discovered. GM8 string literals have no escapes at all, so a
// Windows path pastes in exactly as-is - which is also why one containing a
// quote has to be refused rather than escaped.
function suiteLoader(abs) {
  if (abs.includes('"')) throw new Error(`suite path cannot contain a quote: ${abs}`);
  return (
    'var __gg2SuiteFile, __gg2SuiteSrc, __gg2SuiteLine;\n' +
    `__gg2SuiteFile = file_text_open_read("${abs}");\n` +
    '__gg2SuiteSrc = "";\n' +
    'while (!file_text_eof(__gg2SuiteFile))\n' +
    '{\n' +
    '    __gg2SuiteLine = file_text_read_string(__gg2SuiteFile);\n' +
    '    file_text_readln(__gg2SuiteFile);\n' +
    '    if (string_pos("test_unit_end", __gg2SuiteLine) == 0)\n' +
    '        __gg2SuiteSrc += __gg2SuiteLine + chr(13) + chr(10);\n' +
    '}\n' +
    'file_text_close(__gg2SuiteFile);\n' +
    'execute_string(__gg2SuiteSrc);'
  );
}

// Reading a global that was never assigned is an error dialog in its own right,
// so a suite that fell over before test_unit_begin is given a value that says so.
const TEST_COUNTER_GUARD =
  'EVAL if (not variable_global_exists("testAssertions")) global.testAssertions = -1; ' +
  'if (not variable_global_exists("testAssertionsSucceeded")) global.testAssertionsSucceeded = -1;';

function summarise(name, { total, succeeded, messages, errors }) {
  if (total < 0) {
    return {
      name,
      passed: false,
      text: `${name}: did not run - the assertion counters were never opened, so test_unit_begin was not reached`,
    };
  }

  const lines = messages.join('\n').split('\n').filter(Boolean);
  const failures = lines.filter((l) => /^Assertion \d+ failed/.test(l));
  const passed = succeeded === total && errors.length === 0;

  const body = [...failures.map((f) => '  ' + f), ...errors.map((e) => '  GML error: ' + annotate(e))];

  // Every failed assertion shows a message box, and the launcher reads what it
  // can out of each one before dismissing it. That is best effort - Delphi
  // paints some captions with no window handle - so when nothing recognisable
  // came back, say how many boxes there were and show whatever text did.
  if (!failures.length && succeeded < total) {
    const said = lines.filter((l) => l !== '(dialog had no readable text)');
    body.push(`  ${total - succeeded} assertion(s) failed, but no "Assertion N failed:" line was read back.`);
    if (said.length) body.push('  The boxes that could be read said:', ...said.map((l) => '    ' + l));
    else {
      body.push(
        '  None of their text could be read this time (GM8 paints some captions with no window handle). ' +
          'gg2_log with source: "launcher" shows every box it dismissed, in case one of them did come through; ' +
          'failing that, run the suite with the game visible.'
      );
    }
  }

  return { name, passed, text: [`${name}: ${succeeded}/${total} assertions succeeded`, ...body].join('\n') };
}

//--------------------------------------------------------------------------
// Tools
//--------------------------------------------------------------------------

const INSTANCE_ARG = {
  instance: {
    type: 'string',
    description:
      'Which running game to talk to: a name from gg2_session (server, client1, ...) or a bridge port. ' +
      'Optional while only one game is running.',
  },
};

const TOOLS = [
  {
    name: 'gg2_ping',
    description:
      'Check whether a running Gang Garrison 2 instance is reachable and responding. Use this first if other tools fail.',
    inputSchema: { type: 'object', properties: { ...INSTANCE_ARG }, additionalProperties: false },
  },
  {
    name: 'gg2_eval',
    description:
      'Run GML code inside the running game for its side effects. Returns nothing on success. ' +
      'GM8-era GML only: no ternary, no try/catch, no structs, no modern functions like array_length. ' +
      'Pass raw GML - do not HTML/XML-escape < > & as &lt; &gt; &amp;, unlike gg2_event which wants ' +
      'escaped text. The code is linted against the installed Game Maker 8 before being sent, and ' +
      'refused if it would not compile, because a syntax error freezes the game on a modal dialog.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'GML statements, e.g. global.playerLimit = 24;' },
        skip_lint: { type: 'boolean', description: 'Bypass the lint gate. Only if you are certain the linter is wrong.' },
        ...INSTANCE_ARG,
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_evalx',
    description:
      'Evaluate a single GML expression in the running game and return its value as a string. ' +
      'Use this to inspect live state, e.g. "room_speed", "instance_number(Player)", "global.currentMap". ' +
      'Pass raw GML - do not HTML/XML-escape < > & as &lt; &gt; &amp;, unlike gg2_event which wants escaped text. ' +
      'This wraps the whole expr in "return", so it must be one expression, not statements - "a = 1; a" never ' +
      'reaches the read. Assign with gg2_eval, then read the variable back with a separate gg2_evalx call.',
    inputSchema: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: 'A GML expression, without a trailing semicolon.' },
        skip_lint: { type: 'boolean', description: 'Bypass the lint gate.' },
        ...INSTANCE_ARG,
      },
      required: ['expr'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_state',
    description:
      'Return a structured snapshot of the running game: current room, fps, room speed, host/dedicated flags, ' +
      'and the connected players with their name, team and class - plus x, y and hp for any player who ' +
      'currently has a Character (omitted between a death and a respawn). Encoded as GGON, the game\'s own ' +
      'JSON-like format.',
    inputSchema: { type: 'object', properties: { ...INSTANCE_ARG }, additionalProperties: false },
  },
  {
    name: 'gg2_screenshot',
    description:
      'Look at the game: saves the current frame and returns it as an image. Works while the game is frozen - ' +
      'a frozen game has its instances deactivated and would otherwise draw an empty room, so the bridge ' +
      'reactivates, redraws and freezes again, which runs no step events and does not advance anything.',
    inputSchema: {
      type: 'object',
      properties: {
        save_to: { type: 'string', description: 'Also write the PNG here, for keeping.' },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_step',
    description:
      'Freeze the game and advance it by an exact number of frames. This is the clock: it turns "it happens too ' +
      'fast to see" into a sequence you can inspect one frame at a time with gg2_evalx and gg2_screenshot. ' +
      'The game stays frozen afterwards - call gg2_resume to let it run again. ' +
      'Freezing stops the objects that service the network too, so a connected client or a hosting server will ' +
      'fall behind and may drop: use it freely on a single game, carefully inside a session.',
    inputSchema: {
      type: 'object',
      properties: {
        frames: { type: 'integer', description: 'How many frames to advance (default 1, max 3600). The game runs at 30 a second.' },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_resume',
    description: 'Let a frozen game run again. Harmless if it was not frozen.',
    inputSchema: { type: 'object', properties: { ...INSTANCE_ARG }, additionalProperties: false },
  },
  {
    name: 'gg2_input',
    description:
      'Drive the game as a player would, not by writing to its variables. Commands are separated by ";" -\n' +
      '  press <action>    hold a key down, e.g. press jump\n' +
      '  release <action>  let it up\n' +
      '  clear             drop all simulated input\n' +
      '  aim <x> <y>       move the mouse, in room coordinates - currently hangs, see below\n' +
      '  click 0|1         release or hold the left mouse button\n' +
      'left, right, jump/up, down and taunt actually hold: the bridge ORs a mask into PlayerControl\'s own ' +
      'keybyte every step, so combine with gg2_step to hold a direction for an exact number of frames. ' +
      'Every other action - attack, special, drop, medic, changeteam, changeclass, chat1..3, a single ' +
      'character, a raw key code - goes through keyboard_key_press/release instead, which only drives the ' +
      'pressed/released edge, not a held key: fine for one-shot actions, but press attack will not hold down ' +
      'fire. aim needs the game window to have real OS focus to do anything - a game launched by this tooling ' +
      'normally does not have it, and nothing here can grant it - so expect a ~10s timeout and no effect.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: { type: 'string', description: 'e.g. "press right;press jump" or "aim 320 240;click 1"' },
        ...INSTANCE_ARG,
      },
      required: ['commands'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_wait',
    description:
      'Let the game run until a GML expression becomes true, or give up after a number of frames. Use it instead ' +
      'of polling gg2_evalx: the condition is tested every frame inside the game, so nothing that is true for ' +
      'two frames is missed. The expression is linted first, and the lint gate cannot see every way an ' +
      'expression can fail to compile; if the game rejects it anyway, the wait is abandoned after the first ' +
      'frame with an error reply rather than repeating the same failure for the rest of the budget. Pass raw ' +
      'GML - do not HTML/XML-escape < > & as &lt; &gt; &amp;, unlike gg2_event which wants escaped text.',
    inputSchema: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: 'A GML expression, e.g. "instance_number(Player) > 0"' },
        frames: { type: 'integer', description: 'How many frames to allow (default 300 - ten seconds, max 3600).' },
        skip_lint: { type: 'boolean', description: 'Bypass the lint gate.' },
        ...INSTANCE_ARG,
      },
      required: ['expr'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_watch',
    description:
      'Sample GML expressions once a frame and record every change in the bridge log. This is how to see something ' +
      'that is true for three frames and then gone, which no amount of polling from outside will catch. ' +
      'Read the trace back with gg2_log. Up to eight expressions at a time, since each one costs an evaluation ' +
      'every frame.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'clear', 'list'], description: 'What to do (default list).' },
        expr: { type: 'string', description: 'The expression to watch, for add.' },
        skip_lint: { type: 'boolean', description: 'Bypass the lint gate.' },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_sprite',
    description:
      'Replace a sprite in the running game from a PNG on disk. Sprites are loaded at runtime by GM8, so art can ' +
      'be iterated without a rebuild - but only in the running game: to keep the change, put the file in the ' +
      'tree and run a full build-agent.js, since build-fast.js can only splice code.',
    inputSchema: {
      type: 'object',
      properties: {
        sprite: { type: 'string', description: 'The sprite resource to replace, e.g. ScoutRedSprite.' },
        file: { type: 'string', description: 'Path to the image file, readable by the game.' },
        images: { type: 'integer', description: 'How many sub-images the strip holds (default 1).' },
        origin_x: { type: 'integer', description: 'Origin x (default: whatever the sprite already uses).' },
        origin_y: { type: 'integer', description: 'Origin y (default: whatever the sprite already uses).' },
        remove_background: { type: 'boolean', description: 'Treat the top-left pixel as transparent (default false).' },
        ...INSTANCE_ARG,
      },
      required: ['sprite', 'file'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_lint',
    description:
      'Check GML against the installed Game Maker 8 without running it. Verifies syntax, that every ' +
      'function exists (built-ins come from GM8\'s own fnames table, plus project scripts and .gex ' +
      'extensions), and that argument counts match the real signatures. Use it on code you are about ' +
      'to write into a source file, since a full rebuild costs ~50s. gg2_eval runs this automatically.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'GML to check.' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_event',
    description:
      'Read and write the GML inside an object\'s events. Event code lives in XML, XML-escaped, so grep misses it ' +
      'and a text edit that writes a bare < or & invalidates the file and makes GmkSplitter reject the whole ' +
      'tree. This reads real GML back and escapes what it writes, leaving every other byte of the file alone. ' +
      'Writes are linted first. Objects resolve against the bridge payload too, so the AgentSpare objects - ' +
      'blank objects that exist in the build precisely so new behaviour can be added by a 3s splice rather than ' +
      'an IDE trip - are editable the same way.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write'], description: 'What to do (default read).' },
        object: { type: 'string', description: 'Object name, e.g. Player or AgentSpare0.' },
        event: { type: 'string', description: 'Event name as the tree spells it: Step, Draw, Create, "Alarm 3", "Collision with Rocket".' },
        index: { type: 'integer', description: 'Which code action in that event (default 0).' },
        code: { type: 'string', description: 'The GML to write, for write.' },
      },
      required: ['object'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_find',
    description:
      'Search the game\'s GML - the scripts and the code inside object events together - and report file:line. ' +
      'Prefer this over grep, which cannot see event code at all and so misses a large part of the game\'s logic.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'A JavaScript regular expression.' },
        ignore_case: { type: 'boolean', description: 'Match case-insensitively.' },
        limit: { type: 'integer', description: 'Stop after this many hits (default 100).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_test',
    description:
      'Run the game\'s own unit tests inside the running game and report how many assertions passed. Run it after ' +
      'a rebuild - nothing else checks that a change to, say, GGON still round-trips. ' +
      'By default the game opens its own suite file off disk (file_text_open_read) and runs it with ' +
      'test_unit_end() stripped out, since that helper resets the assertion counters after showing a message box ' +
      'and the counters are the only part of its report that can be read from outside: GM8 draws message text ' +
      'with no window handle. A failed assertion still shows a box, which the launcher dismisses so the game ' +
      'keeps running. Pass send_source: true to send the suite text down the wire instead - only needed when the ' +
      'game and this tooling are not on the same machine.',
    inputSchema: {
      type: 'object',
      properties: {
        suite: { type: 'string', description: 'One suite by name, e.g. test_ggon. Default: every suite found.' },
        timeout_seconds: { type: 'integer', description: 'How long one suite may take (default 60).' },
        skip_lint: {
          type: 'boolean',
          description: 'Bypass the lint gate. Only if you are certain the linter is wrong.',
        },
        send_source: {
          type: 'boolean',
          description: 'Send the suite text over the wire instead of having the game read it off disk itself.',
        },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_profile',
    description:
      'Time GML the game has no profiler for: GM8 has no get_timer, delta_time or fps_real, only ' +
      'current_time, which has 1-16ms Windows granularity - so a single call is never trustworthy and this ' +
      'exists to amortise that properly instead of hand-rolling it with gg2_eval and gg2_watch. Two modes:\n' +
      '  mode "expr" (default) - runs code repeat(n) between two current_time reads inside one call and ' +
      'reports the total and the per-iteration mean. For a pure CPU cost, e.g. one collision check or one ' +
      'grid cell of a bot-nav build.\n' +
      '  mode "frames" - freezes the game and steps it one frame at a time, reading current_time after each ' +
      'step (the in-game clock, not a stopwatch on this side of the wire, which would measure MCP round-trip ' +
      'time instead of GML time), and reports the frame-time distribution. For the per-frame cost of whatever ' +
      'is already running, e.g. a chunked build spread across many step events. Leaves the game frozen ' +
      'afterwards - call gg2_resume. Freezing stops the network, so use this mode carefully inside a session.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['expr', 'frames'], description: 'What to time (default expr).' },
        code: { type: 'string', description: 'mode "expr": GML statement(s) to repeat, e.g. navClearanceBuild();' },
        n: { type: 'integer', description: 'mode "expr": how many iterations (default 100, max 1000000).' },
        frames: { type: 'integer', description: 'mode "frames": how many frames to sample (default 60, min 2, max 600).' },
        timeout_seconds: { type: 'integer', description: 'mode "expr": how long the whole repeat may take (default 60).' },
        skip_lint: { type: 'boolean', description: 'mode "expr": bypass the lint gate.' },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_session',
    description:
      'Start, stop and list games. A session is a dedicated server and its clients, each named and separately ' +
      'addressable, which is the only way to exercise the network protocol: nothing about what one game sends ' +
      'another is observable from inside one process. Starting a session sets UseLobby=0 first, so a test server ' +
      'never announces itself to the public lobby.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'list'], description: 'What to do (default list).' },
        clients: { type: 'integer', description: 'How many clients to bring up alongside the server (default 1).' },
        map: { type: 'string', description: 'The map the server opens on (default ctf_truefort).' },
        name: { type: 'string', description: 'For stop: which member to stop. Omit to stop all of them.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_rebuild',
    description:
      'Rebuild the game from code changes alone, in about three seconds, and relaunch it. ' +
      'GM8 stores GML as source inside the executable, so changed scripts and object event code are ' +
      'spliced into the last exe the IDE produced rather than compiled. Use this after editing .gml ' +
      'files or event code. It refuses, and tells you to run build-agent.js, if anything else changed ' +
      '(a new sprite, object, room or setting) - it never produces a stale executable. ' +
      'The GML is linted first, because bad code in a built exe hangs the game on a modal dialog. ' +
      'This stops every running game, so a session has to be started again afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        relaunch: { type: 'boolean', description: 'Restart the game and wait for the bridge afterwards (default true).' },
        dry_run: { type: 'boolean', description: 'List what would be spliced without building.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_log',
    description:
      'Read the tail of a game\'s logs. The bridge log is what the AgentBridge object recorded, including any ' +
      'gg2_watch trace; the launcher log holds every GM8 dialog the launcher dismissed - GML runtime errors ' +
      'marked E, show_message boxes marked M - which is where to look when a value came back wrong or a call ' +
      'timed out. Errors are annotated with the file and line they came from.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'integer', description: 'How many trailing lines to return (default 40).' },
        source: {
          type: 'string',
          enum: ['both', 'bridge', 'launcher', 'engine'],
          description:
            'Which log to read (default both). "engine" is the game engine\'s own game_errors.log, which is ' +
            'where a compilation error inside execute_string goes - those raise no dialog at all and are ' +
            'invisible everywhere else.',
        },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
];

//--------------------------------------------------------------------------

const clamp = (n, lo, hi, fallback) => {
  const v = Number.isFinite(n) ? n : fallback;
  return Math.max(lo, Math.min(hi, v));
};

// A deferred request answers after the frames it was given, so its timeout has
// to cover them - generously, since a frozen game runs no faster than one that
// is not, and a dropped frame is not an error.
const framesTimeout = (frames) => Math.max(CALL_TIMEOUT_MS, (frames / ROOM_SPEED) * 1000 * 3 + 5000);

async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'gg2_ping': {
      const where = target(args.instance);
      const t0 = Date.now();
      const r = await watched(where, () => command(where, 'PING'));
      return `${r} from ${where.name} on port ${where.port} (${Date.now() - t0}ms)`;
    }

    case 'gg2_eval': {
      if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required');
      const where = target(args.instance);
      lintOrThrow(args.code, args.skip_lint);
      await watched(where, () => command(where, 'EVAL ' + args.code));
      return 'ok';
    }

    case 'gg2_evalx': {
      if (typeof args.expr !== 'string' || !args.expr.trim()) throw new Error('expr is required');
      const where = target(args.instance);
      const expr = args.expr.replace(/;\s*$/, '');
      // Lint the wrapped form, not the bare expression - EVALX runs it as
      // `execute_string("return " + expr)`, and "return (" + expr + ")" is what
      // the game actually has to compile. An operator or ";" in operand
      // position (e.g. a mistakenly HTML-escaped "&gt;") can be a syntactically
      // valid statement sequence on its own while being invalid inside `return
      // (...)`, so linting the bare form alone missed exactly that case.
      lintOrThrow('return (' + expr + ')', args.skip_lint);
      return await watched(where, () => command(where, 'EVALX ' + expr));
    }

    case 'gg2_lint': {
      if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required');
      const res = lintGml(args.code);
      if (res.note) return res.note;
      if (res.ok) return 'clean - this compiles under Game Maker 8';
      return res.errors.map((f) => `line ${f.line}: ${f.message} [${f.rule}]`).join('\n');
    }

    case 'gg2_state': {
      const where = target(args.instance);
      return await watched(where, () => command(where, 'STATE'));
    }

    case 'gg2_screenshot': {
      const where = target(args.instance);
      // The game writes where it is told; keep it beside the exe, one file per
      // instance, and take it away again once it has been read.
      const shot = path.join(BUILD_DIR, `agent_shot_${where.port}.png`);
      try {
        fs.rmSync(shot, { force: true });
      } catch (e) {
        /* an old shot that cannot be removed is about to be overwritten */
      }

      await watched(where, () => command(where, 'SHOT ' + shot));
      if (!fs.existsSync(shot)) throw new Error(`the game reported success but wrote no file to ${shot}`);

      const raw = fs.readFileSync(shot);
      const { png, converted, width, height } = image.toPng(raw);
      fs.rmSync(shot, { force: true });
      if (args.save_to) fs.writeFileSync(args.save_to, png);

      return [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        {
          type: 'text',
          text:
            `${where.name}: ${width}x${height}${converted ? ' (converted from the bitmap GM8 wrote)' : ''}` +
            (args.save_to ? `, saved to ${args.save_to}` : ''),
        },
      ];
    }

    case 'gg2_step': {
      const where = target(args.instance);
      const frames = clamp(args.frames, 1, 3600, 1);
      await watched(where, () => command(where, 'FREEZE'));
      return await watched(where, () => command(where, 'STEP ' + frames, framesTimeout(frames)));
    }

    case 'gg2_resume': {
      const where = target(args.instance);
      return await watched(where, () => command(where, 'RESUME'));
    }

    case 'gg2_input': {
      if (typeof args.commands !== 'string' || !args.commands.trim()) throw new Error('commands is required');
      const where = target(args.instance);
      await watched(where, () => command(where, 'INPUT ' + args.commands.trim()));
      return 'ok';
    }

    case 'gg2_wait': {
      if (typeof args.expr !== 'string' || !args.expr.trim()) throw new Error('expr is required');
      const where = target(args.instance);
      const expr = args.expr.replace(/;\s*$/, '');
      // Lint the wrapped form, not the bare expression - see gg2_evalx above
      // for why. WAIT runs it inside `if (expr) ...`, not `return (...)`, but
      // both are expression context, and this catches the same class of thing
      // the bare form does not: an operator or ";" in operand position.
      lintOrThrow('return (' + expr + ')', args.skip_lint);
      const frames = clamp(args.frames, 1, 3600, 300);
      return await watched(where, () => command(where, `WAIT ${frames} ${expr}`, framesTimeout(frames)));
    }

    case 'gg2_watch': {
      const where = target(args.instance);
      const action = args.action || 'list';
      if (action === 'add') {
        if (typeof args.expr !== 'string' || !args.expr.trim()) throw new Error('expr is required to add a watch');
        lintOrThrow(args.expr, args.skip_lint);
        return await watched(where, () => command(where, 'WATCH add ' + args.expr.replace(/;\s*$/, '')));
      }
      return await watched(where, () => command(where, 'WATCH ' + action));
    }

    case 'gg2_sprite': {
      if (!args.sprite || !args.file) throw new Error('sprite and file are both required');
      const where = target(args.instance);
      const file = path.resolve(args.file);
      if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);

      const sprite = args.sprite;
      const images = clamp(args.images, 1, 1000, 1);
      const xorig = Number.isInteger(args.origin_x) ? String(args.origin_x) : `sprite_get_xoffset(${sprite})`;
      const yorig = Number.isInteger(args.origin_y) ? String(args.origin_y) : `sprite_get_yoffset(${sprite})`;
      // GM8 takes a Windows path in a GML string, where a backslash is literal -
      // but a quote in a file name would end the string, so refuse one.
      if (file.includes('"')) throw new Error('a file name with a quote in it cannot be passed to GML');

      const code =
        `sprite_replace(${sprite}, "${file}", ${images}, ` +
        `${args.remove_background ? 'true' : 'false'}, false, ${xorig}, ${yorig});`;
      lintOrThrow(code, false);
      await watched(where, () => command(where, 'EVAL ' + code));
      return `replaced ${sprite} from ${file} in ${where.name}`;
    }

    case 'gg2_event': {
      const action = args.action || 'read';
      if (!args.object) throw new Error('object is required');

      if (action === 'list') {
        const list = events.listEvents(REPO, args.object);
        if (list.length === 0) return `${args.object} has no events`;
        return list.map((e) => `${e.event.padEnd(24)} ${e.actions} code action(s)  ${e.file}`).join('\n');
      }

      if (!args.event) throw new Error('event is required, e.g. Step - use action: "list" to see which exist');
      const index = Number.isInteger(args.index) ? args.index : 0;

      if (action === 'read') {
        const r = events.readEvent(REPO, args.object, args.event, index);
        return `${r.file}:${r.line}\n\n${r.gml}`;
      }

      if (action === 'write') {
        if (typeof args.code !== 'string') throw new Error('code is required to write an event');
        const w = events.writeEvent(REPO, args.object, args.event, index, args.code);
        return (
          `wrote ${w.lines} line(s) to ${w.file} (${w.event}, action ${w.index}). ` +
          'Run gg2_rebuild to put it in the running game.'
        );
      }
      throw new Error('action must be list, read or write');
    }

    case 'gg2_find': {
      if (!args.pattern) throw new Error('pattern is required');
      const limit = clamp(args.limit, 1, 1000, 100);
      const hits = events.find(REPO, args.pattern, { flags: args.ignore_case ? 'i' : '', limit });
      if (hits.length === 0) return 'no matches';
      return (
        hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n') +
        (hits.length >= limit ? `\n\n(stopped at ${limit} matches)` : '')
      );
    }

    case 'gg2_test': {
      const where = target(args.instance);
      const suites = testSuites();
      if (suites.length === 0) return `no unit test suites found under ${TEST_DIR}`;

      const wanted = args.suite ? suites.filter((s) => s.name === args.suite) : suites;
      if (wanted.length === 0) {
        throw new Error(`no suite called ${args.suite}. Found: ${suites.map((s) => s.name).join(', ')}`);
      }

      const timeout = clamp(args.timeout_seconds, 5, 600, 60) * 1000;
      const logFile = instances.launcherLog(BUILD_DIR, where.port);
      const results = [];

      for (const suite of wanted) {
        const mark = logSize(logFile);
        // Not watched(): a failed assertion is reported through show_message and
        // is a result, not a crash. Real errors are collected separately below.
        let body;
        if (args.send_source) {
          body = stripReporting(lib.readText(suite.abs));
        } else {
          body = suiteLoader(suite.abs);
        }
        lintOrThrow(body, args.skip_lint);
        try {
          await command(where, 'EVAL ' + body, timeout);
        } catch (e) {
          // A run of every suite does not otherwise say which one it stopped in,
          // and the counters cannot be read back from a game that is not
          // answering - so name the suite here. What the game said on the way
          // down is already in the message: the failure carries the launcher
          // log, whether it timed out or came back as an error.
          throw new Error(`${suite.name} (${suite.file}) did not finish.\n\n${e.message}`);
        }
        const text = logSince(logFile, mark);

        // A suite that never reached test_unit_begin leaves the counters
        // undefined, and reading an undefined global is itself an error dialog.
        await command(where, TEST_COUNTER_GUARD);
        const total = Number(await command(where, 'EVALX global.testAssertions'));
        const succeeded = Number(await command(where, 'EVALX global.testAssertionsSucceeded'));
        await command(where, 'EVAL test_unit_begin();');

        results.push(
          summarise(suite.name, {
            total,
            succeeded,
            messages: dialogsIn(text, 'M'),
            errors: dialogsIn(text, 'E'),
          })
        );
      }

      const failed = results.filter((r) => !r.passed);
      return (
        `${results.length - failed.length}/${results.length} suite(s) passed in ${where.name}\n\n` +
        results.map((r) => r.text).join('\n')
      );
    }

    case 'gg2_profile': {
      const where = target(args.instance);
      const mode = args.mode === 'frames' ? 'frames' : 'expr';

      if (mode === 'expr') {
        if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required for mode "expr"');
        const n = clamp(args.n, 1, 1000000, 100);
        const timeout = clamp(args.timeout_seconds, 5, 600, 60) * 1000;
        const body =
          'var __gg2ProfT0, __gg2ProfT1;\n' +
          '__gg2ProfT0 = current_time;\n' +
          `repeat (${n})\n` +
          '{\n' +
          args.code +
          '\n}\n' +
          '__gg2ProfT1 = current_time;\n' +
          'global.gg2ProfileMs = __gg2ProfT1 - __gg2ProfT0;';
        lintOrThrow(body, args.skip_lint);
        await watched(where, () => command(where, 'EVAL ' + body, timeout));
        const totalMs = Number(await command(where, 'EVALX global.gg2ProfileMs'));
        return (
          `${n} iteration(s): ${totalMs}ms total, ${(totalMs / n).toFixed(4)}ms/iteration ` +
          '(current_time has 1-16ms Windows granularity - trust the mean only when the total is comfortably ' +
          'larger than that; raise n if it is not)'
        );
      }

      // mode "frames": the per-frame cost of whatever is already running, not
      // a snippet - freezes the game and steps it a frame at a time, reading
      // the in-game clock after each step. A stopwatch on this side of the
      // wire would measure MCP round-trip time instead of GML time. At least
      // two samples are needed for a single delta between them.
      const frames = clamp(args.frames, 2, 600, 60);
      await watched(where, () => command(where, 'FREEZE'));
      const samples = [];
      for (let i = 0; i < frames; i++) {
        await command(where, 'STEP 1', framesTimeout(1));
        samples.push(Number(await command(where, 'EVALX current_time')));
      }
      const deltas = [];
      for (let i = 1; i < samples.length; i++) deltas.push(samples[i] - samples[i - 1]);
      deltas.sort((a, b) => a - b);
      const sum = deltas.reduce((a, b) => a + b, 0);
      const pct = (p) => deltas[Math.min(deltas.length - 1, Math.floor((p / 100) * deltas.length))];
      return (
        `${frames} frame(s) sampled (${deltas.length} delta(s)): mean ${(sum / deltas.length).toFixed(2)}ms, ` +
        `min ${deltas[0]}ms, p50 ${pct(50)}ms, p95 ${pct(95)}ms, max ${deltas[deltas.length - 1]}ms\n` +
        'the game is left frozen - call gg2_resume to let it run again.'
      );
    }

    case 'gg2_session': {
      const action = args.action || 'list';

      if (action === 'list') {
        const live = instances.list(BUILD_DIR);
        if (live.length === 0) return 'no games are running';
        return live.map((i) => `${i.name.padEnd(10)} port ${i.port}  pid ${i.pid}  ${i.role}`).join('\n');
      }

      if (action === 'start') {
        const lines = [];
        lib.setSink((l) => lines.push(l));
        disconnectAll('starting a session');
        try {
          const started = await session.start({
            repo: REPO,
            clients: clamp(args.clients, 0, 8, 1),
            map: args.map || session.DEFAULT_MAP,
          });
          return (
            started.map((s) => `${s.name.padEnd(10)} port ${s.port}  ${s.role}`).join('\n') +
            '\n\nAddress them by name with the instance argument.'
          );
        } catch (e) {
          throw new Error([...lines, e.message].join('\n'));
        } finally {
          lib.setSink(logSink);
        }
      }

      if (action === 'stop') {
        const lines = [];
        lib.setSink((l) => lines.push(l));
        try {
          const stopped = await session.stop({ repo: REPO, name: args.name });
          disconnectAll('the game was stopped');
          return stopped.length ? `stopped ${stopped.map((s) => s.name).join(', ')}` : 'nothing to stop';
        } finally {
          lib.setSink(logSink);
        }
      }
      throw new Error('action must be start, stop or list');
    }

    case 'gg2_rebuild': {
      // In-process, so there is no shell, no execution policy and no output to
      // parse: the build reports through lib's sink, which is redirected here
      // because this process's stdout carries JSON-RPC and nothing else.
      const lines = [];
      lib.setSink((l) => lines.push(l));

      // Rebuilding stops every game; the next call reconnects to whatever comes
      // back up.
      disconnectAll('rebuilding');

      try {
        await buildFast({
          repo: REPO,
          launch: !args.dry_run && args.relaunch !== false,
          dryRun: !!args.dry_run,
          port: DEFAULT_PORT,
        });
      } catch (e) {
        throw new Error([...lines, e.message].join('\n'));
      } finally {
        lib.setSink(logSink);
      }
      return lines.join('\n') || 'rebuilt';
    }

    case 'gg2_log': {
      const where = target(args.instance);
      const n = Number.isInteger(args.lines) ? args.lines : 40;
      const want = args.source || 'both';
      const files = [];
      if (want === 'both' || want === 'bridge') files.push(['bridge', instances.bridgeLog(BUILD_DIR, where.port)]);
      if (want === 'both' || want === 'launcher') files.push(['launcher', instances.launcherLog(BUILD_DIR, where.port)]);
      if (want === 'both' || want === 'engine') files.push(['engine', instances.errorLog(BUILD_DIR)]);

      const tails = files
        .map(([kind, file]) => {
          const head = `--- ${kind} (${path.basename(file)}) ---`;
          if (!fs.existsSync(file)) return `${head}\nno log file at ${file}`;
          const all = lib.readText(file).split(/\r?\n/).filter(Boolean);
          return `${head}\n` + (all.slice(-n).join('\n') || '(empty)');
        })
        .join('\n\n');

      // Point at the errors rather than leaving them to be read out of raw
      // dialog text; GM8 names the object but never the file.
      const errors = dialogsIn(
        fs.existsSync(instances.launcherLog(BUILD_DIR, where.port))
          ? lib.readText(instances.launcherLog(BUILD_DIR, where.port))
          : '',
        'E'
      );
      if (errors.length === 0) return tails;
      return (
        tails +
        '\n\n--- GML errors in this log, located ---\n' +
        errors
          .slice(-10)
          .map((e) => annotate(e))
          .join('\n')
      );
    }

    default:
      throw new Error('unknown tool: ' + name);
  }
}

//--------------------------------------------------------------------------
// MCP over stdio: newline-delimited JSON-RPC 2.0
//--------------------------------------------------------------------------

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}

function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  // Notifications carry no id and get no reply.
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      const version = SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
      return result(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'gg2-agent-bridge', version: '0.2.0' },
      });
    }

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params && params.name;
      try {
        const out = await callTool(name, params && params.arguments);
        const content = Array.isArray(out) ? out : [{ type: 'text', text: String(out) }];
        return result(id, { content });
      } catch (e) {
        // Tool failures are reported in-band so the model can react to them.
        return result(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
      }
    }

    default:
      return failure(id, -32601, 'method not found: ' + method);
  }
}

// Serving is what this file does when it is run, and nothing it does when it is
// required: the tests drive callTool directly, and taking over stdin then would
// be rude to whoever required it.
function serve() {
  let stdinBuf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinBuf += chunk;
    let nl;
    while ((nl = stdinBuf.indexOf('\n')) >= 0) {
      const line = stdinBuf.slice(0, nl).trim();
      stdinBuf = stdinBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        log('bad JSON on stdin: ' + e.message);
        continue;
      }
      Promise.resolve(handle(msg)).catch((e) => log('handler error: ' + e.message));
    }
  });

  process.stdin.on('end', () => process.exit(0));
  log(`ready; default bridge ${HOST}:${DEFAULT_PORT}, build dir ${BUILD_DIR}`);
}

if (require.main === module) serve();

// `command` is exported for the selftest: every tool's timeout is measured in
// seconds, and a test that has to wait one out is a test nobody runs.
module.exports = { callTool, handle, TOOLS, testSuites, dialogsIn, summarise, describeError, disconnectAll, command };
