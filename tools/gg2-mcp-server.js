#!/usr/bin/env node
//=============================================================================
// gg2-mcp-server.js - an MCP server exposing a running Gang Garrison 2 to an
// AI agent.
//
// Talks MCP (JSON-RPC 2.0 over stdio) to the agent, and a small length-prefixed
// protocol to the AgentBridge object inside the game.
//
// Wire format to the game: uint32 little-endian length, then that many bytes.
// Replies come back framed the same way, as "OK", "OK <text>" or "ERR <text>".
//
// This file has no dependencies of its own; only the launcher it starts needs
// one (koffi, for the handful of user32 calls that clear GM8's modal dialogs).
//
// Usage (in .mcp.json or claude mcp add):
//   node Source/gg2-mcp-server.js
//
// Environment:
//   GG2_AGENT_PORT   bridge port (default 17777)
//   GG2_BUILD_DIR    directory holding the game exe and agent_bridge.log
//=============================================================================

const net = require('net');
const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const { buildFast } = require('../build-fast.js');

const PORT = parseInt(process.env.GG2_AGENT_PORT || '17777', 10);
const HOST = '127.0.0.1';
const CALL_TIMEOUT_MS = 10000;

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

// stdout is the MCP channel and must carry nothing but JSON-RPC. That applies
// to the build scripts too, so lib's sink points at stderr from the start and
// is only ever swapped for a collector.
const log = (...a) => process.stderr.write('[gg2-mcp] ' + a.join(' ') + '\n');
const logSink = (line) => log(line);
lib.setSink(logSink);

//--------------------------------------------------------------------------
// Bridge client
//--------------------------------------------------------------------------

let sock = null;
let rxBuf = Buffer.alloc(0);
const pending = [];

function disconnect(reason) {
  if (sock) {
    sock.removeAllListeners();
    sock.destroy();
    sock = null;
  }
  rxBuf = Buffer.alloc(0);
  while (pending.length) pending.shift().reject(new Error(reason));
}

function connect() {
  return new Promise((resolve, reject) => {
    if (sock && !sock.destroyed) return resolve();

    const s = net.connect({ port: PORT, host: HOST });
    const onErr = (e) => {
      s.removeAllListeners();
      s.destroy();
      reject(
        new Error(
          `Cannot reach the game on ${HOST}:${PORT} (${e.code || e.message}). ` +
            `Is it running with -agent? Launch it with:\n` +
            `  node run-agent.js`
        )
      );
    };
    s.once('error', onErr);
    s.once('connect', () => {
      s.removeListener('error', onErr);
      sock = s;

      s.on('data', (d) => {
        rxBuf = Buffer.concat([rxBuf, d]);
        for (;;) {
          if (rxBuf.length < 4) break;
          const n = rxBuf.readUInt32LE(0);
          if (rxBuf.length < 4 + n) break;
          const payload = rxBuf.slice(4, 4 + n).toString('latin1');
          rxBuf = rxBuf.slice(4 + n);
          const p = pending.shift();
          if (p) p.resolve(payload);
        }
      });
      s.on('error', (e) => disconnect('bridge socket error: ' + e.message));
      s.on('close', () => disconnect('the game closed the connection'));
      resolve();
    });
  });
}

function request(text) {
  return new Promise(async (resolve, reject) => {
    try {
      await connect();
    } catch (e) {
      return reject(e);
    }

    const timer = setTimeout(() => {
      const i = pending.findIndex((p) => p.timer === timer);
      if (i >= 0) pending.splice(i, 1);
      reject(
        new Error(
          'The game did not reply within ' +
            CALL_TIMEOUT_MS +
            'ms. It is most likely blocked on a modal dialog ' +
            '(GM8 does this when a GML error occurs, or when no audio device is available). ' +
            'Check the game window.'
        )
      );
    }, CALL_TIMEOUT_MS);

    pending.push({
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
    sock.write(Buffer.concat([head, body]));
  });
}

// Sends a command and unwraps the OK/ERR envelope.
async function command(text) {
  const reply = await request(text);
  if (reply.startsWith('ERR ')) throw new Error(reply.slice(4));
  if (reply === 'OK') return '';
  if (reply.startsWith('OK ')) return reply.slice(3);
  return reply;
}

//--------------------------------------------------------------------------
// Game errors
//
// GM8 has no exceptions, so a GML error inside execute_string does not come
// back as one: the runtime raises a modal dialog, the launcher presses Ignore,
// execute_string returns 0, and the bridge cheerfully replies "OK 0". Without
// this, an agent asking for a value it mistyped gets a plausible wrong answer
// and no signal at all.
//
// The launcher writes the dialog's text to its log before dismissing it, and
// the game is frozen until then, so anything appended to that log while a call
// was in flight belongs to that call.
//--------------------------------------------------------------------------

const LAUNCHER_LOG = path.join(BUILD_DIR, 'agent_launcher.log');
const BRIDGE_LOG = path.join(BUILD_DIR, 'agent_bridge.log');

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

// The launcher prefixes dialog text with "| ". Strip its timestamps and hand
// back the game's own words.
function gameErrorsSince(mark) {
  return logSince(LAUNCHER_LOG, mark)
    .split(/\r?\n/)
    .filter((l) => l.includes(' | '))
    .map((l) => l.slice(l.indexOf(' | ') + 3).trim())
    .filter(Boolean)
    .join('\n');
}

// Run a bridge command and refuse to report success if the game raised an
// error while it ran.
async function watched(fn) {
  const mark = logSize(LAUNCHER_LOG);
  const reply = await fn();
  const errors = gameErrorsSince(mark);
  if (!errors) return reply;
  throw new Error(
    'The game raised a GML error during this call, so the reply cannot be trusted.\n' +
      errors
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n') +
      `\n\nThe bridge replied: ${JSON.stringify(reply)} - for a failed expression that is 0, not a real value.`
  );
}

//--------------------------------------------------------------------------
// Lint gate
//
// A GML syntax error inside execute_string raises a modal dialog that freezes
// the game and every pending call. That is the worst failure mode here and it
// needs a person to clear it, so code is checked before it is ever sent.
//--------------------------------------------------------------------------

const { spawnSync } = require('child_process');

function lintGml(code) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'gml-lint.js'), '--stdin', '--json'], {
    input: code,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) return { ok: true, note: 'lint unavailable: ' + r.error.message };
  try {
    const out = JSON.parse(r.stdout);
    const errors = out.findings.filter((f) => f.severity === 'error');
    return { ok: errors.length === 0, errors };
  } catch (e) {
    // Never let a linter problem block legitimate work.
    return { ok: true, note: 'lint output unreadable' };
  }
}

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
// Tools
//--------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'gg2_ping',
    description:
      'Check whether the running Gang Garrison 2 instance is reachable and responding. Use this first if other tools fail.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gg2_eval',
    description:
      'Run GML code inside the running game for its side effects. Returns nothing on success. ' +
      'GM8-era GML only: no ternary, no try/catch, no structs, no modern functions like array_length. ' +
      'The code is linted against the installed Game Maker 8 before being sent, and refused if it ' +
      'would not compile, because a syntax error freezes the game on a modal dialog.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'GML statements, e.g. global.playerLimit = 24;' },
        skip_lint: { type: 'boolean', description: 'Bypass the lint gate. Only if you are certain the linter is wrong.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_evalx',
    description:
      'Evaluate a single GML expression in the running game and return its value as a string. ' +
      'Use this to inspect live state, e.g. "room_speed", "instance_number(Player)", "global.currentMap".',
    inputSchema: {
      type: 'object',
      properties: { expr: { type: 'string', description: 'A GML expression, without a trailing semicolon.' } },
      required: ['expr'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_state',
    description:
      'Return a structured snapshot of the running game: current room, fps, room speed, host/dedicated flags, ' +
      'and the connected players with their name, team and class. Encoded as GGON, the game\'s own JSON-like format.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
    name: 'gg2_rebuild',
    description:
      'Rebuild the game from code changes alone, in about three seconds, and relaunch it. ' +
      'GM8 stores GML as source inside the executable, so changed scripts and object event code are ' +
      'spliced into the last exe the IDE produced rather than compiled. Use this after editing .gml ' +
      'files or event code. It refuses, and tells you to run build-agent.js, if anything else changed ' +
      '(a new sprite, object, room or setting) - it never produces a stale executable. ' +
      'The GML is linted first, because bad code in a built exe hangs the game on a modal dialog.',
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
      'Read the tail of the game logs. The bridge log is what the AgentBridge object recorded; the ' +
      'launcher log holds every GM8 dialog the launcher dismissed, including the full text of GML ' +
      'runtime errors - which is where to look when a value came back wrong or a call timed out.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'integer', description: 'How many trailing lines to return (default 40).' },
        source: {
          type: 'string',
          enum: ['both', 'bridge', 'launcher'],
          description: 'Which log to read (default both).',
        },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'gg2_ping': {
      const t0 = Date.now();
      const r = await watched(() => command('PING'));
      return `${r} (${Date.now() - t0}ms)`;
    }

    case 'gg2_eval': {
      if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required');
      lintOrThrow(args.code, args.skip_lint);
      await watched(() => command('EVAL ' + args.code));
      return 'ok';
    }

    case 'gg2_evalx': {
      if (typeof args.expr !== 'string' || !args.expr.trim()) throw new Error('expr is required');
      const expr = args.expr.replace(/;\s*$/, '');
      lintOrThrow(expr, args.skip_lint);
      return await watched(() => command('EVALX ' + expr));
    }

    case 'gg2_lint': {
      if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required');
      const res = lintGml(args.code);
      if (res.note) return res.note;
      if (res.ok) return 'clean - this compiles under Game Maker 8';
      return res.errors.map((f) => `line ${f.line}: ${f.message} [${f.rule}]`).join('\n');
    }

    case 'gg2_state':
      return await watched(() => command('STATE'));

    case 'gg2_rebuild': {
      // In-process, so there is no shell, no execution policy and no output to
      // parse: the build reports through lib's sink, which is redirected here
      // because this process's stdout carries JSON-RPC and nothing else.
      const lines = [];
      lib.setSink((l) => lines.push(l));

      // Relaunching drops the bridge connection; the next call reconnects.
      disconnect('rebuilding');

      try {
        await buildFast({
          repo: path.resolve(BUILD_DIR, '..', '..'),
          launch: !args.dry_run && args.relaunch !== false,
          dryRun: !!args.dry_run,
          port: PORT,
        });
      } catch (e) {
        throw new Error([...lines, e.message].join('\n'));
      } finally {
        lib.setSink(logSink);
      }
      return lines.join('\n') || 'rebuilt';
    }

    case 'gg2_log': {
      const n = Number.isInteger(args.lines) ? args.lines : 40;
      const want = args.source || 'both';
      const files = [];
      if (want === 'both' || want === 'bridge') files.push(['bridge', BRIDGE_LOG]);
      if (want === 'both' || want === 'launcher') files.push(['launcher', LAUNCHER_LOG]);

      return files
        .map(([name, file]) => {
          const head = `--- ${name} (${path.basename(file)}) ---`;
          if (!fs.existsSync(file)) return `${head}\nno log file at ${file}`;
          const all = fs.readFileSync(file, 'latin1').split(/\r?\n/).filter(Boolean);
          return `${head}\n` + (all.slice(-n).join('\n') || '(empty)');
        })
        .join('\n\n');
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
        serverInfo: { name: 'gg2-agent-bridge', version: '0.1.0' },
      });
    }

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params && params.name;
      try {
        const text = await callTool(name, params && params.arguments);
        return result(id, { content: [{ type: 'text', text: String(text) }] });
      } catch (e) {
        // Tool failures are reported in-band so the model can react to them.
        return result(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
      }
    }

    default:
      return failure(id, -32601, 'method not found: ' + method);
  }
}

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
log(`ready; bridge ${HOST}:${PORT}, build dir ${BUILD_DIR}`);
