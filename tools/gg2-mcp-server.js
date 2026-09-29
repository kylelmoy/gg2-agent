#!/usr/bin/env node
//=============================================================================
// gg2-mcp-server.js - an MCP server exposing running Gang Garrison 2 games to
// an AI agent.
//
// Talks MCP (JSON-RPC 2.0 over stdio) to the agent, and a small length-prefixed
// protocol to the AgentBridge object inside each game.
//
// Wire format to the game: uint32 little-endian length, then that many bytes.
// The body is "#<id> <request>"; the reply comes back framed the same way as
// "#<id> OK", "#<id> OK <text>" or "#<id> ERR <text>". The id is what matches a
// reply to the call that asked for it - a late reply belongs to the call that
// gave up on it by name, rather than to whoever happens to be next in a queue.
// The game treats it as optional and echoes whatever it is given, so a rebuilt
// game still answers a client that predates ids; this client does not send
// requests without one.
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
//   GG2_REPO         the game checkout to start on; otherwise the one the session
//                    was opened in, else a Gang-Garrison-2 beside this repo.
//                    gg2_checkout switches it mid-session.
//   GG2_BUILD_DIR    directory holding the game exe, the logs and the register
//=============================================================================

const net = require('net');
const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const instances = require('./instances.js');
const gmlerror = require('./gmlerror.js');
const image = require('./image.js');
const mapimage = require('./mapimage.js');
const areashot = require('./areashot.js');
const events = require('./events.js');
const session = require('./session.js');
const gmllint = require('./gml-lint.js');
const { buildFast } = require('../build-fast.js');

const DEFAULT_PORT = parseInt(process.env.GG2_AGENT_PORT || '17777', 10);
const HOST = '127.0.0.1';
const CALL_TIMEOUT_MS = 10000;
const ROOM_SPEED = 30; // what the game runs at, for turning frames into a timeout

// The checkout this server works on. It lives outside the game's repo, so the
// starting one is lib's choice - GG2_REPO, else the checkout the session was
// opened in, else one beside gg2-agent - and every process that talks to a game
// agrees on it. gg2_checkout switches it mid-session, for forks and worktrees.
let BUILD_DIR, REPO, TREE, TEST_DIR, REPO_REASON;
function setRepo(buildDir, reason) {
  BUILD_DIR = buildDir;
  REPO = lib.repoOfBuildDir(BUILD_DIR);
  TREE = path.join(REPO, 'Source', 'gg2');
  TEST_DIR = path.join(TREE, 'Scripts', 'Unit tests');
  REPO_REASON = reason;
}
setRepo(
  lib.findBuildDir(),
  process.env.GG2_BUILD_DIR ? 'GG2_BUILD_DIR' : lib.defaultRepoWithReason().reason
);
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
    this.connecting = null; // the one in-flight connect(), shared by every caller
    this.rx = Buffer.alloc(0);
    // id -> slot, in the order the requests went out. A slot whose caller has
    // given up stays here, marked abandoned, until the game answers it or the
    // connection goes: that is what lets a late reply be recognised as late
    // rather than handed to whoever asked next, and what makes "how many calls
    // ahead of this one never answered" answerable.
    this.pending = new Map();
    this.nextId = 1;
    // Whether this client stopped the world and has not started it again.
    // Nothing else can know it across a reconnect, and it is what decides
    // whether recovering a wedged bridge is free or costs the caller frames.
    this.frozen = false;
    // Set when this bridge was reconnected because nothing was answering, and
    // cleared by the first reply after it. A call that times out while it is
    // still set has just proved the reconnect did not help, which is a
    // different diagnosis from the first timeout - see timedOut.
    this.recoveredFromWedge = false;
    // Set while recoverIfWedged is working. request() calls recoverIfWedged
    // before it sends anything, and recovery sends a CANCEL through request(),
    // so without this the two call each other forever: on re-entry the pending
    // map still holds only the abandoned calls that made wedged() true, since
    // the CANCEL's own slot is not added until after that check.
    this.recovering = false;
  }

  disconnect(reason) {
    if (this.sock) {
      this.sock.removeAllListeners();
      // Abortive, not graceful, and this is load-bearing rather than tidy:
      // the game notices a closed client through tcp_eof, which Faucet only
      // reports once the read buffer is *also* exhausted. A client that gave up
      // with more than one request in flight leaves unread bytes sitting in that
      // buffer, so an ordinary FIN is invisible to the game for as long as it is
      // not reading - which is exactly the wedge this reconnect exists to clear
      // (measured live on 2026-08-22: FIN, no accept for the whole 120s budget;
      // RST, served 95ms later). A reset makes socket_has_error true whatever is
      // buffered, and nothing this client had in flight is worth delivering
      // anyway - it has stopped waiting for all of it.
      if (typeof this.sock.resetAndDestroy === 'function' && !this.sock.destroyed) this.sock.resetAndDestroy();
      else this.sock.destroy();
      this.sock = null;
    }
    this.rx = Buffer.alloc(0);
    // The game unfreezes itself the moment it loses its client, and it has just
    // lost one - so neither of these is true of it any more, whoever dropped the
    // connection and why. recoverIfWedged reads them before it calls this.
    this.frozen = false;
    this.recoveredFromWedge = false;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  // One connection, however many callers ask for it at once. Two calls that
  // start together used to open a socket each, and the game accepts exactly one
  // client: the loser's requests went into the accept backlog and were never
  // read, so a call could time out having never been looked at while a socket
  // nothing owned kept the game's real connection alive. Sharing the in-flight
  // attempt is the whole fix (found live on 2026-08-22, chasing a reconnect
  // that appeared not to reach the game).
  connect() {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
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
            if (!this.deliver(payload)) break;
          }
        });
        s.on('error', (e) => this.disconnect('bridge socket error: ' + e.message));
        s.on('close', () => this.disconnect('the game closed the connection'));
        resolve();
      });
    });

    // Cleared either way: a failed attempt must not be handed to the next
    // caller as if it were still in progress.
    const done = () => {
      this.connecting = null;
    };
    this.connecting.then(done, done);
    return this.connecting;
  }

  // Hand one reply frame to the call that asked for it. Returns false if the
  // connection was torn down and there is nothing left to read into.
  //
  // Replies carry the id of their request (see agentBridgeStep), so this is a
  // lookup and not an assumption about order. That matters most for a reply
  // that arrives after its caller gave up: it belongs to that abandoned call by
  // name, is dropped as such, and nothing after it is shifted onto the wrong
  // caller - which is the worst thing this bridge can produce, and used to be
  // prevented only by never removing a timed-out slot from a queue.
  deliver(payload) {
    if (payload[0] !== '#') {
      // A game built before replies carried ids. Nothing here can be matched to
      // anything, so say what to do rather than guessing at an alignment.
      this.disconnect(
        `The game on port ${this.port} is running an older AgentBridge: it replied without the request id ` +
          'this protocol carries, so replies cannot be matched to calls. Apply the current bridge with ' +
          `gg2_rebuild (~2s), or rebuild by hand with build-fast.js. (it said ${JSON.stringify(payload.slice(0, 60))})`
      );
      return false;
    }

    const sp = payload.indexOf(' ');
    const id = Number(payload.slice(1, sp < 0 ? payload.length : sp));
    const body = sp < 0 ? '' : payload.slice(sp + 1);
    const p = this.pending.get(id);
    if (!p) {
      log(`bridge on ${this.port}: reply to #${id}, which nothing is waiting for - ignored`);
      return true;
    }
    this.pending.delete(id);
    if (p.abandoned) {
      log(`bridge on ${this.port}: #${id} answered after its caller gave up - dropped`);
    } else {
      // Answering at all clears the suspicion a reconnect left behind.
      this.recoveredFromWedge = false;
      p.resolve(body);
    }
    return true;
  }

  // True when every request still outstanding has been given up on: the game
  // has answered nothing since, and is not necessarily reading either.
  wedged() {
    if (!this.sock || this.sock.destroyed || this.pending.size === 0) return false;
    for (const p of this.pending.values()) if (!p.abandoned) return false;
    return true;
  }

  // Ask the game to abandon whatever deferred reply it is sitting on.
  //
  // The polite half of recoverIfWedged, and the one that costs nothing: a
  // current bridge reads while a STEP or WAIT is outstanding, so CANCEL reaches
  // it, is answered immediately, and the connection - along with whatever this
  // client had frozen - survives untouched.
  //
  // The short budget is the compatibility test as well as a timeout. A bridge
  // built before this reads NOTHING while deferred, so CANCEL sits unread in
  // its socket buffer and no answer comes; that silence is the signal to fall
  // back to dropping the connection, which is the only thing such a bridge
  // notices. Two seconds is far longer than the ~40ms a live one takes and far
  // shorter than the frame budget of the WAIT being escaped.
  // Returns true only when something was actually cancelled. "OK nothing
  // deferred" means the bridge is reading and answering - so it is not stuck
  // behind a defer - but says nothing about why the outstanding calls went
  // unanswered. That is a different fault, and the reconnect is still the right
  // move for it; treating a polite "nothing to do" as a recovery would leave
  // those calls hanging with the wedge merely renamed.
  async cancelDeferred() {
    try {
      const said = await this.request('CANCEL', 2000);
      log(`bridge on ${this.port}: CANCEL -> ${said}`);
      // request() resolves the reply body verbatim, "OK ..." and all - there is
      // no layer below this that strips it.
      return said.startsWith('OK cancelled');
    } catch (e) {
      return false;
    }
  }

  // Recover a bridge that has stopped answering, before sending anything else
  // down it.
  //
  // Two tiers, because they cost very different amounts. CANCEL is tried first
  // and keeps everything: the connection, the freeze, and the call that
  // triggered it. Dropping the connection is the fallback, and it is a
  // sledgehammer - it loses the freeze, so the world runs on for a moment, and
  // the triggering call is failed rather than answered, because a result
  // measured after the world moved is exactly the plausible wrong answer the
  // rest of this file exists to prevent.
  //
  // The fallback is still here because it is the only thing that reaches a
  // bridge that has stopped *reading* - every build from before CANCEL, and any
  // future one wedged in a way CANCEL cannot describe. agentBridgeStep notices
  // the EOF ahead of its deferred reply, clears deferKind, unfreezes and
  // accepts the next client.
  async recoverIfWedged() {
    if (this.recovering) return;
    if (!this.wedged()) return;
    this.recovering = true;
    try {
      await this.recover();
    } finally {
      this.recovering = false;
    }
  }

  async recover() {

    // A bridge that answers this is reading, which means it is not wedged in
    // the sense that needs a reconnect - only stuck behind a defer this clears.
    if (await this.cancelDeferred()) {
      log(`bridge on ${this.port}: cleared a deferred reply with CANCEL, connection kept`);
      return;
    }

    const lost = this.pending.size;
    const wasFrozen = this.frozen;
    this.disconnect(`the bridge on port ${this.port} was reconnected while this call was outstanding`);
    await this.connect();
    this.recoveredFromWedge = lost;
    log(`bridge on ${this.port}: reconnected after ${lost} unanswered call(s)${wasFrozen ? ', re-freezing' : ''}`);

    if (!wasFrozen) return;
    await this.request('FREEZE');
    throw new Error(
      `The bridge on port ${this.port} had stopped answering - ${lost} call(s) went unanswered, and CANCEL ` +
        'went unanswered too, which means this game reads nothing at all while a deferred STEP or WAIT is ' +
        'outstanding. Every build from before CANCEL behaves that way; rebuilding it with gg2_rebuild (~3s) ' +
        'makes this recoverable without dropping anything. Reconnecting worked: the game drops the old ' +
        'client, cancels what it was waiting on, and accepts a new one.\n\n' +
        'It also unfreezes on losing a client, and this game was frozen at your request - so it ran on for a ' +
        'moment before being frozen again. It is frozen now, but has advanced by a few frames that nothing ' +
        'counted. That is why this call failed instead of answering: retry it, and the answer will be honest.'
    );
  }

  // A request that spans frames - STEP, WAIT, a test run that stops on forty
  // message boxes - cannot answer inside the ordinary budget, so callers that
  // know how long they are asking for say so.
  async request(text, timeoutMs = CALL_TIMEOUT_MS) {
    await this.recoverIfWedged();
    await this.connect();

    // Whether the world is stopped is not the transport's business, except that
    // it is the only thing that survives a reconnect - see recoverIfWedged. A
    // STEP leaves the game frozen exactly when it was frozen before, so it does
    // not appear here.
    if (text === 'FREEZE') this.frozen = true;
    else if (text === 'RESUME') this.frozen = false;

    // Where the logs stood before the command went out. The launcher writes
    // every dialog it dismisses to disk while a call is in flight, and that
    // happens whether or not the reply ever arrives - so a call that times out
    // can be explained from the same evidence watched() uses after a call that
    // returns, instead of guessing. This is the one thing the transport knows
    // about the world outside the socket, and it is why: without it, the same
    // failure reads as a full diagnosis or as nothing at all, depending only on
    // whether the reply beat the clock.
    const marks = logMarks(this.port);
    const id = this.nextId;
    this.nextId = this.nextId >= 1000000000 ? 1 : this.nextId + 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Requests are answered in order, so anything still abandoned ahead of
        // this one means the game never got as far as looking at this one.
        let behind = 0;
        for (const [key, p] of this.pending) {
          if (key === id) break;
          if (p.abandoned) behind++;
        }
        const slot = this.pending.get(id);
        if (slot) slot.abandoned = true;
        reject(new Error(timedOut(this.port, marks, timeoutMs, behind, this.recoveredFromWedge)));
      }, timeoutMs);

      this.pending.set(id, {
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

      const body = Buffer.from(`#${id} ${text}`, 'latin1');
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
function timedOut(port, marks, timeoutMs, behind = 0, recovered = 0) {
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

  // The stronger version of the same story: the connection this call went down
  // was opened moments ago, precisely because the last one had stopped
  // answering. A game that ignores a client it has only just accepted is not
  // deferring a reply - it is not running the bridge's Step event at all.
  const again =
    recovered > 0
      ? `\n\nThis bridge was already reconnected once, after ${recovered} call(s) the game never answered, and it ` +
        'still has not answered anything. Reconnecting is what clears a deferred STEP or WAIT that outlived its ' +
        'caller, so that is not what this is: the game is not servicing the bridge at all - stopped stepping, ' +
        'stuck in a loop, or gone. Restart the instance (gg2_session stop, then start).'
      : '';

  if (collapsed.length === 0) {
    return (
      `${head} The launcher dismissed no dialog while the call was in flight, so the game is probably not ` +
      'blocked on a modal one: more likely it is still working (ask for a longer timeout), it stopped stepping, ' +
      'or it is gone. gg2_ping says which; gg2_log with source: "launcher" shows the whole log.' +
      queued +
      again
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
    queued +
    again
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

// The linter fails open - a missing gm8-builder or Game Maker install must not
// block real work - but then nothing stands between a typo and a modal dialog.
// So whenever a call's code went unchecked, tools/call says so beside the
// result, where the agent cannot miss it, rather than only in a log. Per call,
// since calls can be in flight together.
const lintSkipped = new (require('async_hooks').AsyncLocalStorage)();

async function lintOrThrow(code, skip) {
  if (skip) return;
  const res = await lintGml(code);
  const skipped = lintSkipped.getStore();
  if (skipped && res.note && /unavailable/.test(res.note)) skipped.note = res.note;
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
//
// The table itself is data, and lives in mcp-schemas.js; what each name does is
// the switch in callTool below.
//--------------------------------------------------------------------------

const { TOOLS, INSTRUCTIONS } = require('./mcp-schemas.js');


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
      await lintOrThrow(args.code, args.skip_lint);
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
      await lintOrThrow('return (' + expr + ')', args.skip_lint);
      return await watched(where, () => command(where, 'EVALX ' + expr));
    }

    case 'gg2_lint': {
      if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required');
      const res = await lintGml(args.code);
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

    case 'gg2_map_image': {
      const where = target(args.instance);
      const scale = args.scale ?? 3;

      const mapName = await watched(where, () => command(where, 'EVALX global.currentMap'));

      const base = args.base || 'art';

      let picture = mapimage.basePicture(mapName, REPO, base);
      const native = { width: picture.width, height: picture.height };
      picture = mapimage.scaled(picture, scale);

      const png = mapimage.toPng(picture);
      if (args.save_to) fs.writeFileSync(args.save_to, png);

      return [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        {
          type: 'text',
          text:
            `${mapName}: ${picture.width}x${picture.height} (native ${native.width}x${native.height}, ${scale}x), ` +
            `base ${base}${base === 'mask' ? ' (dark = solid; pass base: "art" for the map art)' : ''}` +
            (args.save_to ? `, saved to ${args.save_to}` : ''),
        },
      ];
    }

    case 'gg2_area_shot': {
      const where = target(args.instance);
      const { picture, cols, rows, wport, hport, masked } = await areashot.capture({
        run: (text) => watched(where, () => command(where, text)),
        lint: (gml) => lintOrThrow(gml),
        buildDir: BUILD_DIR,
        repo: REPO,
        port: where.port,
        x: args.x,
        y: args.y,
        width: args.width,
        height: args.height,
        hideHud: args.hide_hud ?? true,
        walkmask: args.walkmask,
      });

      const png = image.encodePngRgba(picture.width, picture.height, picture.rgba);
      if (args.save_to) fs.writeFileSync(args.save_to, png);

      return [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        {
          type: 'text',
          text:
            `${where.name}: ${picture.width}x${picture.height} (${cols}x${rows} tiles of ${wport}x${hport})` +
            `${masked ? ', collision boundary outlined in magenta' : ''}` +
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

    case 'gg2_speed': {
      const where = target(args.instance);
      const factor = clamp(args.factor, 0, 20, 0);
      return await watched(where, () => command(where, 'SPEED ' + factor));
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
      await lintOrThrow('return (' + expr + ')', args.skip_lint);
      let setup = '';
      if (typeof args.setup === 'string' && args.setup.trim()) {
        // Same shape as gg2_eval: raw GML, run for its side effects.
        setup = args.setup.trim();
        await lintOrThrow(setup, args.skip_lint);
      }
      const frames = clamp(args.frames, 1, 3600, 300);
      // Length-prefixed, not delimited, so setup can contain anything - a
      // semicolon, a colon, a space - without ambiguity against expr.
      return await watched(where, () => command(where, `WAIT ${frames} ${setup.length}:${setup}${expr}`, framesTimeout(frames)));
    }

    case 'gg2_watch': {
      const where = target(args.instance);
      const action = args.action || 'list';
      if (action === 'add') {
        if (typeof args.expr !== 'string' || !args.expr.trim()) throw new Error('expr is required to add a watch');
        await lintOrThrow(args.expr, args.skip_lint);
        const expr = args.expr.replace(/;\s*$/, '');
        const label = typeof args.label === 'string' ? args.label.trim() : '';
        // Length-prefixed, not delimited, so label can be empty or contain
        // anything without ambiguity against expr.
        return await watched(where, () => command(where, `WATCH add ${label.length}:${label}${expr}`));
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
      await lintOrThrow(code, false);
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
        const w = await events.writeEvent(REPO, args.object, args.event, index, args.code);
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
        await lintOrThrow(body, args.skip_lint);
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
        await lintOrThrow(body, args.skip_lint);
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

    case 'gg2_checkout': {
      const describe = () => {
        const live = instances.list(BUILD_DIR);
        return (
          `checkout  ${REPO}  (${REPO_REASON})\n` +
          `build dir ${BUILD_DIR}${fs.existsSync(BUILD_DIR) ? '' : '  - not built yet; gg2_rebuild builds it'}\n` +
          (live.length ? `running   ${live.map((i) => i.name).join(', ')}` : 'running   nothing')
        );
      };
      if (!args.path) return describe();

      const repo = lib.enclosingCheckout(path.resolve(args.path));
      if (!repo) throw new Error(`not inside a Gang Garrison 2 checkout: ${path.resolve(args.path)}`);
      const left = instances.list(BUILD_DIR);
      // Games belong to the checkout they were built from; the register that
      // names them is in its build dir, so after switching they cannot be
      // addressed. Say so rather than leave them to be found by accident.
      const note = left.length && path.resolve(repo) !== path.resolve(REPO)
        ? `\n\nstill running from ${REPO}: ${left.map((i) => i.name).join(', ')} - ` +
          'switch back to address or stop them.'
        : '';
      disconnectAll('switching checkout');
      setRepo(lib.findBuildDir(repo), 'gg2_checkout');
      return describe() + note;
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
        instructions: INSTRUCTIONS,
      });
    }

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params && params.name;
      const skipped = { note: null };
      const unchecked = () => (skipped.note
        ? [{ type: 'text', text: `Warning: this GML was NOT linted (${skipped.note}); run node tools/doctor.js. ` +
          'Until it is fixed, a syntax error will reach the game as a modal dialog.' }]
        : []);
      try {
        const out = await lintSkipped.run(skipped, () => callTool(name, params && params.arguments));
        const content = Array.isArray(out) ? out : [{ type: 'text', text: String(out) }];
        return result(id, { content: [...content, ...unchecked()] });
      } catch (e) {
        // Tool failures are reported in-band so the model can react to them.
        return result(id, { content: [{ type: 'text', text: 'Error: ' + e.message }, ...unchecked()], isError: true });
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
