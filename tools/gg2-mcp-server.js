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
// Deliberately dependency-free: this drops into the repo without a package.json
// or node_modules.
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

// stdout is the MCP channel and must carry nothing but JSON-RPC.
const log = (...a) => process.stderr.write('[gg2-mcp] ' + a.join(' ') + '\n');

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
            `  AutoHotkey64.exe Source/gg2_agent.ahk "<path to Gang Garrison 2.exe>"`
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
      'GM8-era GML only: no ternary, no try/catch, no structs, use "and"/"or" rather than && and ||. ' +
      'A syntax error will pop a modal dialog in the game and block further calls, so keep statements simple.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'GML statements, e.g. global.playerLimit = 24;' } },
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
    name: 'gg2_log',
    description:
      'Read the tail of the agent bridge log file. Useful when a call times out or the game is behaving oddly.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'integer', description: 'How many trailing lines to return (default 40).' },
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
      const r = await command('PING');
      return `${r} (${Date.now() - t0}ms)`;
    }

    case 'gg2_eval': {
      if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required');
      await command('EVAL ' + args.code);
      return 'ok';
    }

    case 'gg2_evalx': {
      if (typeof args.expr !== 'string' || !args.expr.trim()) throw new Error('expr is required');
      return await command('EVALX ' + args.expr.replace(/;\s*$/, ''));
    }

    case 'gg2_state':
      return await command('STATE');

    case 'gg2_log': {
      const file = path.join(BUILD_DIR, 'agent_bridge.log');
      if (!fs.existsSync(file)) return `no log file at ${file}`;
      const n = Number.isInteger(args.lines) ? args.lines : 40;
      const all = fs.readFileSync(file, 'latin1').split(/\r?\n/).filter(Boolean);
      return all.slice(-n).join('\n') || '(log is empty)';
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
