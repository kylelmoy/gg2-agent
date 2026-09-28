#!/usr/bin/env node
//=============================================================================
// selftest.js - exercise the tooling without Game Maker and without the game.
//
// Everything here runs against a scratch copy of the source tree and a fake
// bridge: a socket that speaks the same length-prefixed protocol the AgentBridge
// object does, and a launcher log written by hand. That covers the parts that
// are ours - framing, instance routing, the error gate, event editing, the
// screenshot conversion, the test reader - and says nothing about the GML, which
// only a built game can answer for.
//
// It exists because the alternative is a full IDE build for every change to a
// Node module, and because a wire format is exactly the sort of thing that is
// easy to get subtly wrong and hard to notice.
//
//   node tools/selftest.js
//
// Exit codes: 0 = everything passed, 1 = something did not.
//=============================================================================

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const SCRATCH = path.join(os.tmpdir(), 'gg2-agent-selftest');
const BUILD = path.join(SCRATCH, 'Source', 'build');
const TREE = path.join(SCRATCH, 'Source', 'gg2');
const PORT = 17999;

//---------------------------------------------------------------------------
// A very small test runner
//---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failures.push(name + (detail ? `\n       ${detail}` : ''));
    process.stdout.write(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}\n`);
  }
}

const contains = (name, haystack, needle) =>
  check(name, String(haystack).includes(needle), `expected to find ${JSON.stringify(needle)} in ${JSON.stringify(String(haystack).slice(0, 400))}`);

async function throws(name, fn, needle) {
  try {
    await fn();
    check(name, false, 'nothing was thrown');
  } catch (e) {
    check(name, !needle || e.message.includes(needle), `message was: ${e.message.split('\n')[0]}`);
  }
}

//---------------------------------------------------------------------------
// The scratch tree
//---------------------------------------------------------------------------

function realTree() {
  const guess = path.resolve(__dirname, '..', '..', 'Gang-Garrison-2', 'Source', 'gg2');
  if (!fs.existsSync(path.join(guess, 'Objects'))) {
    throw new Error(`selftest needs a Gang Garrison 2 checkout; looked in ${guess}`);
  }
  return guess;
}

function makeScratch() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(TREE, { recursive: true });
  // Only the two directories that hold code: enough for events, find, the unit
  // test discovery and the error locator, and a fraction of the bytes.
  for (const dir of ['Scripts', 'Objects']) {
    fs.cpSync(path.join(realTree(), dir), path.join(TREE, dir), { recursive: true });
  }
  // gml-lint resolves the game's own constants out of Constants.xml, so the
  // scratch tree needs the real one for the lint sections below.
  fs.cpSync(path.join(realTree(), 'Constants.xml'), path.join(TREE, 'Constants.xml'));
}

//---------------------------------------------------------------------------
// The fake bridge
//
// Answers the verbs the MCP server sends, records what it was asked, and can be
// told to behave like a game that has just raised a GML error - which, from
// outside, means writing to the launcher log and replying 0 anyway.
//---------------------------------------------------------------------------

function launcherLogPath(port) {
  return path.join(BUILD, `agent_launcher_${port}.log`);
}

function appendDialog(port, mark, lines) {
  const stamp = '20260819000000';
  const text =
    lines.map((l) => `${stamp}   ${mark}| ${l}\n`).join('') + `${stamp} dismissed dialog (pressed Ignore) - 1 so far\n`;
  fs.appendFileSync(launcherLogPath(port), text);
}

// A 2x2 uncompressed 24-bit bitmap, which is what GM8's screen_save produces on
// the builds that do not write a PNG.
function tinyBmp() {
  const stride = 8; // 2 pixels * 3 bytes, padded to 4
  const pixels = Buffer.alloc(stride * 2);
  pixels.writeUInt8(255, 2); // one red pixel, so a wrong channel order shows up
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(2, 18);
  header.writeInt32LE(2, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  return Buffer.concat([header, pixels]);
}

// A map PNG the way the game ships one: art, plus the level data deflated into
// a zTXt chunk keyed "Gang Garrison 2 Level Data". The walkmask inside it is
// the same six-bits-per-character bitstream compressWalkmask.gml writes - one
// continuous run, row-major, most significant bit first, padded only at the
// very end.
function fakeMapPng(width, height, solid) {
  const zlib = require('zlib');
  const image = require('./image.js');

  let packed = '';
  let value = 0;
  let filled = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      value = (value << 1) | (solid(x, y) ? 1 : 0);
      if (++filled === 6) {
        packed += String.fromCharCode(value + 32);
        value = 0;
        filled = 0;
      }
    }
  }
  if (filled > 0) packed += String.fromCharCode((value << (6 - filled)) + 32);

  const level =
    '{ENTITIES}\n[{type:meta}]\n{END ENTITIES}\n' +
    `{WALKMASK}\n${width}\n${height}\n${packed}\n{END WALKMASK}`;
  const body = Buffer.concat([
    Buffer.from('Gang Garrison 2 Level Data\0\0', 'latin1'),
    zlib.deflateSync(Buffer.from(level, 'latin1')),
  ]);
  const chunk = Buffer.alloc(12 + body.length);
  chunk.writeUInt32BE(body.length, 0);
  chunk.write('zTXt', 4, 'latin1');
  body.copy(chunk, 8);
  chunk.writeUInt32BE(image.crc32(chunk.slice(4, 8 + body.length)) >>> 0, 8 + body.length);

  // Straight after IHDR, which is where the game's own maps carry it.
  const png = image.encodePngRgba(width, height, Buffer.alloc(width * height * 4, 200));
  const afterIhdr = 8 + 25;
  return Buffer.concat([png.slice(0, afterIhdr), chunk, png.slice(afterIhdr)]);
}

function startFakeBridge(port) {
  const seen = [];
  const live = [];
  // How this fake answers a CANCEL sent while a reply is deferred:
  //   'answer' - a current bridge, which reads during a defer
  //   'ignore' - a bridge built before CANCEL, which reads nothing while one is
  //              outstanding, so the request is never even seen
  // The second is not a hypothetical: every build before this protocol change
  // behaves that way, and it is what the client's reconnect fallback exists for.
  const mode = { cancel: 'answer' };
  // The deferred request's own prefix, held so its reply carries its own id.
  // This models the bridge's deferPrefix, and the reason it has to exist.
  let deferred = null;
  let counters = { total: -1, succeeded: -1 };
  let fakeClock = 1000000;
  const server = net.createServer((sock) => {
    live.push(sock);
    // The client tears a wedged connection down abortively (see Bridge's
    // disconnect), so ECONNRESET here is normal and not a failure - the real
    // game notices the same reset and goes back to accepting.
    sock.on('error', () => {});
    // agentBridgeStep clears deferKind when it loses a client, so a deferred
    // reply never outlives the connection that asked for it. Modelled here for
    // the same reason it exists there: without it a WAIT abandoned by one
    // connection is still sitting there for the next one to trip over.
    sock.on('close', () => { deferred = null; });
    let rx = Buffer.alloc(0);
    const send = (text) => {
      const body = Buffer.from(text, 'latin1');
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length, 0);
      sock.write(Buffer.concat([head, body]));
    };

    sock.on('data', (d) => {
      rx = Buffer.concat([rx, d]);
      for (;;) {
        if (rx.length < 4) return;
        const n = rx.readUInt32LE(0);
        if (rx.length < 4 + n) return;
        let request = rx.slice(4, 4 + n).toString('latin1');
        rx = rx.slice(4 + n);

        // The id the reply has to carry back, exactly as agentBridgeStep does
        // it: strip "#<digits> " off the front and put it back on every reply,
        // including a deferred one sent later. Everything below - and every
        // assertion against `seen` - then sees the request itself.
        let prefix = '';
        const idEnd = request.indexOf(' ');
        if (request[0] === '#' && idEnd > 1 && /^\d+$/.test(request.slice(1, idEnd))) {
          prefix = request.slice(0, idEnd + 1);
          request = request.slice(idEnd + 1);
        }
        const reply = (text) => send(prefix + text);
        seen.push(request);

        const [verb, ...restParts] = request.split(' ');
        const rest = restParts.join(' ');

        if (verb === 'CANCEL') {
          if (mode.cancel === 'ignore') continue; // never read it in the first place
          if (!deferred) reply('OK nothing deferred');
          else {
            clearTimeout(deferred.timer);
            send(deferred.prefix + 'ERR cancelled after 1 of 600 frame(s)');
            deferred = null;
            reply('OK cancelled WAIT after 1 of 600 frame(s)');
          }
        } else if (verb === 'PING') reply('OK pong');
        else if (verb === 'FREEZE') reply('OK frozen');
        else if (verb === 'RESUME') reply('OK running');
        else if (verb === 'STATE') reply('OK {room: MainMenu, fps: 30}');
        else if (verb === 'STEP') setTimeout(() => reply(`OK advanced ${rest} frame(s)`), 50);
        else if (verb === 'WAIT') {
          // "neverFinishes" is the case the whole redesign is about: a deferred
          // reply whose caller has given up long before its frame budget runs
          // out. Nothing is scheduled, so only a CANCEL - or losing the
          // connection - ends it.
          if (rest.includes('neverFinishes')) deferred = { prefix, timer: null };
          else setTimeout(() => reply('OK true after 2 frame(s)'), 50);
        }
        else if (verb === 'INPUT') reply('OK');
        else if (verb === 'WATCH') reply('OK watching 1 expression(s)');
        else if (verb === 'SHOT') {
          fs.writeFileSync(rest, tinyBmp());
          reply('OK ' + rest);
        } else if (verb === 'EVAL' || verb === 'EVALX') {
          if (rest.includes('oldBridgePretendsNoId')) {
            // A game built before replies carried ids: framed the same way,
            // but with nothing to match it to a call.
            send('OK 42');
            continue;
          }
          // The two ways a game answers badly: a runtime error, which only the
          // launcher log reveals, and a suite reporting through show_message.
          if (rest.includes('aTypoNobodyDefined')) {
            appendDialog(port, 'E', [
              'ERROR in',
              'action number 1',
              'of  Step Event',
              'for object AgentBridge:',
              '',
              'Error in code at line 1:',
              '   return global.aTypoNobodyDefined',
              '                 ^',
              'at position 15: Unknown variable aTypoNobodyDefined',
            ]);
            reply('OK 0');
          } else if (rest.includes('sameErrorEveryFrame')) {
            // The stuck-in-a-loop case: an identical dialog raised several
            // times in a row within one call, the way CTFHUD's Step throws
            // every frame once global.winners is unbound.
            for (let i = 0; i < 4; i++) {
              appendDialog(port, 'E', [
                'ERROR in',
                'action number 1',
                'of  Step Event',
                'for object CTFHUD:',
                '',
                'Error in code at line 36:',
                '   if (global.winners == -1)',
                '        ^',
                'at position 8: Unknown variable winners',
              ]);
            }
            reply('OK 0');
          } else if (rest.includes('neverAnswers')) {
          // A game that is wedged: dialogs pile up in the launcher log while
          // the call is in flight, and no reply ever comes. Everything the
          // caller will be told has to come out of that log.
          for (let i = 0; i < 3; i++) {
            appendDialog(port, 'E', [
              'ERROR in',
              'action number 1',
              'of  Step Event',
              'for object CTFHUD:',
              '',
              'Error in code at line 36:',
              '   if (global.winners == -1)',
              '        ^',
              'at position 8: Unknown variable winners',
            ]);
          }
          appendDialog(port, 'M', ['Assertion 7 failed: 1 should be equal to 2']);
          // no reply, on purpose
        } else if (rest.includes('quietlyNeverAnswers')) {
          // The other wedge: nothing in the log at all, which means the game is
          // not stopped on a dialog and the caller must be told something else.
        } else if (rest.includes('answersTooLate')) {
          // A game that was only slow. Its reply arrives after the caller has
          // given up, and must not be handed to whoever asks next.
          setTimeout(() => reply('OK stale'), 400);
        } else if (rest.includes('notAFunctionAnywhere')) {
            // A compilation error inside execute_string: no dialog anywhere,
            // just a line in the engine's own log and a cheerful "OK 0".
            fs.appendFileSync(
              path.join(BUILD, 'game_errors.log'),
              'COMPILATION ERROR in string to be executedError in code at line 1:   ' +
                'return notAFunctionAnywhere(1)         ^at position 8: Unknown function or script: notAFunctionAnywhere'
            );
            reply('OK 0');
          } else if (rest.trim() === 'test_unit_begin();') {
            counters = { total: 0, succeeded: 0 }; // the reset between suites
            reply('OK');
          } else if (rest.includes('test_wedged')) {
            // A suite that goes wrong mid-run. Which suite it was is the one
            // thing a whole-run failure cannot say for itself.
            reply('ERR the game gave up on this one');
          } else if (rest.includes('file_text_open_read')) {
            // gg2_test's default path: the game opens its own suite file
            // rather than being sent its source. A wrong path here should
            // fail the same way a wrong path would in the real game, so this
            // actually reads the file the loader named rather than trusting it.
            const m = rest.match(/file_text_open_read\("([^"]+)"\)/);
            const found = !!(m && fs.existsSync(m[1]));
            check('the loader names a real suite file', found);
            const source = found ? fs.readFileSync(m[1], 'latin1') : '';
            check('the suite runs without its reset', source.includes('test_unit_begin') && !rest.includes('test_unit_end('));
            appendDialog(port, 'M', ['(dialog had no readable text)']);
            counters = { total: 45, succeeded: 44 };
            reply('OK');
          } else if (rest.includes('test_unit_begin')) {
            // The send_source fallback: a suite's source sent directly, with
            // its reporting call stripped out. One assertion fails, and GM8
            // shows a box whose text nobody can read.
            check('the suite runs without its reset', !rest.includes('test_unit_end('));
            appendDialog(port, 'M', ['(dialog had no readable text)']);
            counters = { total: 45, succeeded: 44 };
            reply('OK');
          } else if (rest.startsWith('global.testAssertionsSucceeded')) {
            reply('OK ' + counters.succeeded);
          } else if (rest.startsWith('global.testAssertions')) {
            reply('OK ' + counters.total);
          } else if (rest.trim() === 'current_time') {
            // gg2_profile's frames mode: a fake clock that advances a plausible
            // amount (~1 frame at 30fps) on every read, so consecutive samples
            // produce a real, non-zero delta.
            fakeClock += 33;
            reply('OK ' + fakeClock);
          } else if (rest.trim() === 'global.gg2ProfileMs') {
            reply('OK 12');
          } else if (rest.trim() === 'global.currentMap') {
            reply('OK fakemap');
          } else {
            reply(verb === 'EVAL' ? 'OK' : 'OK 42');
          }
        } else reply('ERR unknown verb ' + verb);
      }
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, seen, live, mode })));
}

//---------------------------------------------------------------------------

async function main() {
  makeScratch();
  process.env.GG2_BUILD_DIR = BUILD;

  const instances = require('./instances.js');
  const win32 = require('./win32.js');
  const events = require('./events.js');
  const session = require('./session.js');
  const image = require('./image.js');
  const mcp = require('./gg2-mcp-server.js');

  const { server, seen, live, mode } = await startFakeBridge(PORT);

  // The register is what routes a call to a game. This process stands in for
  // the game, so its own pid is one that is genuinely alive.
  instances.register(BUILD, { name: 'fake', port: PORT, pid: process.pid, role: 'solo', args: ['-agent'] });

  process.stdout.write('\ninstance register\n');
  check('a registered instance is listed', instances.list(BUILD).some((i) => i.name === 'fake'));
  check('a name resolves', instances.resolve(BUILD, 'fake').port === PORT);
  check('a port resolves', instances.resolve(BUILD, String(PORT)).name === 'fake');
  check('a dead pid is pruned', (() => {
    instances.register(BUILD, { name: 'ghost', port: 65000, pid: 999999, role: 'solo' });
    return !instances.list(BUILD).some((i) => i.name === 'ghost');
  })());
  await throws('an unknown name is an error, not a guess', async () => instances.resolve(BUILD, 'nope'), 'no running game');

  process.stdout.write('\nwin32\n');
  check('isRemoteSession answers without throwing', typeof win32.isRemoteSession() === 'boolean');
  check('sessionState answers without throwing, string or null', (() => {
    const s = win32.sessionState();
    return s === null || typeof s === 'string';
  })());
  check('captureWindow on a bogus handle returns null rather than throwing', win32.captureWindow(0) === null);

  process.stdout.write('\ngm8-builder\n');
  {
    // The build and the linter are gm8-builder (../gm8-builder), a separate
    // tool with its own tests (`dotnet test` there). What is left to check here
    // is how this repo plugs into it, since nothing in gm8-builder would notice
    // that going missing.
    const gm8 = require('./gm8.js');
    const found = gm8.find();
    check('gm8-builder.exe is found', !!found,
      'publish it: cd ../gm8-builder && dotnet publish src/Gm8Builder.Cli -c Release -o dist (or set GM8_BUILDER)');
    check('a Game Maker 8 install is found', !!gm8.findInstall(), 'set GM8_DIR to the directory holding rundata and fnames');

    // Both build scripts go through the one helper, which lints first and
    // applies gm8x_fix - the game has always shipped with its patches.
    const helper = gm8.build.toString();
    contains('the build lints the tree first', helper, "args.push('--lint')");
    contains('and applies gm8x_fix', helper, "args.push('--gm8x-fix')");
    for (const script of ['build-agent.js', 'build-fast.js']) {
      contains(`${script} builds through gm8.build`, fs.readFileSync(path.join(__dirname, '..', script), 'utf8'), 'gm8.build(tree, exeOut');
    }

    if (found && gm8.findInstall()) {
      // A build that fails comes back as an error carrying what gm8-builder
      // said, not an exit code.
      await throws('a failed build comes back in gm8-builder\'s own words', async () =>
        gm8.build(path.join(BUILD, 'no-such-tree'), path.join(BUILD, 'out.exe'), { lint: false }), 'no-such-tree');
    }
  }

  process.stdout.write('\ngg2.ini\n');
  fs.writeFileSync(path.join(BUILD, 'gg2.ini'), '[Settings]\r\nUseLobby=1\r\nHostingPort=8190\r\n\r\n[Server]\r\nDedicated=0\r\n');
  check('a value is read out of a section', session.iniValue(fs.readFileSync(path.join(BUILD, 'gg2.ini'), 'latin1'), 'Settings', 'HostingPort') === '8190');
  check('setting a value reports a change', session.setIniValue(BUILD, 'Settings', 'UseLobby', 0));
  check('setting it again does not', !session.setIniValue(BUILD, 'Settings', 'UseLobby', 0));
  check('the rest of the file is untouched',
    fs.readFileSync(path.join(BUILD, 'gg2.ini'), 'latin1') === '[Settings]\r\nUseLobby=0\r\nHostingPort=8190\r\n\r\n[Server]\r\nDedicated=0\r\n');

  process.stdout.write('\nevent code\n');
  const heavy = path.join(TREE, 'Objects', 'Characters', 'Heavy.events', 'Step.xml');
  const before = fs.readFileSync(heavy);
  const read = events.readEvent(SCRATCH, 'Heavy', 'Step', 0, { payload: false });
  check('event code comes back unescaped', !read.gml.includes('&amp;') && read.gml.includes('&'));
  await events.writeEvent(SCRATCH, 'Heavy', 'Step', 0, read.gml, { payload: false });
  check('a write that changes nothing is byte-identical', before.equals(fs.readFileSync(heavy)));
  await events.writeEvent(SCRATCH, 'Heavy', 'Step', 0, 'a = 1 < 2 & 3 > 0;', { payload: false, lintFirst: false });
  check('what is written comes back the same', events.readEvent(SCRATCH, 'Heavy', 'Step', 0, { payload: false }).gml === 'a = 1 < 2 & 3 > 0;');
  contains('and is escaped on disk', fs.readFileSync(heavy, 'latin1'), '&lt; 2 &amp;&amp;'.slice(0, 5));
  await throws('bad GML is refused before it is written', async () =>
    events.writeEvent(SCRATCH, 'Heavy', 'Step', 0, 'array_length(x);', { payload: false }), 'would not compile');
  await throws('empty code is refused', async () =>
    events.writeEvent(SCRATCH, 'Heavy', 'Step', 0, '  ', { payload: false, lintFirst: false }), 'empty code');
  fs.writeFileSync(heavy, before);

  process.stdout.write('\nlint cache invalidation\n');
  {
    // The lint server keeps each tree's symbols in memory. gm8-builder
    // notices a resource directory's time moving, so a script is in scope on
    // the very next check.
    const gmllint = require('./gml-lint.js');
    const newScript = path.join(TREE, 'Scripts', 'someBrandNewScript.gml');
    // A directory's time has the file system's resolution; move it on by hand
    // so the change cannot land in the same tick the last check saw.
    const bumpDir = (d) => {
      const t = new Date(Date.now() + 2000 + Math.random() * 1000);
      fs.utimesSync(d, t, t);
    };

    const before = await gmllint.check('someBrandNewScript();', { trees: [TREE], name: '<test>' });
    check('a call to an unknown script is refused', !before.ok, JSON.stringify(before.errors));

    fs.writeFileSync(newScript, 'return 1;');
    bumpDir(path.dirname(newScript));
    const after = await gmllint.check('someBrandNewScript();', { trees: [TREE], name: '<test>' });
    check('adding the script puts it in scope straight away', after.ok, JSON.stringify(after.errors || after.note));

    fs.rmSync(newScript, { force: true });
    bumpDir(path.dirname(newScript));
    const gone = await gmllint.check('someBrandNewScript();', { trees: [TREE], name: '<test>' });
    check('and removing it takes it out again', !gone.ok);
  }

  // events.js passes [payload, tree]; the MCP server passes [tree, payload].
  // Two callers asking about the same project in a different order must get
  // the same answer.
  process.stdout.write('\ntree order independence\n');
  {
    const gmllint = require('./gml-lint.js');
    const fakePayload = path.join(SCRATCH, 'fake-payload');
    fs.mkdirSync(path.join(fakePayload, 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(fakePayload, 'Scripts', 'onlyInThePayload.gml'), 'return 1;');

    const orderA = await gmllint.check('onlyInThePayload(); room_speed', { trees: [TREE, fakePayload] });
    const orderB = await gmllint.check('onlyInThePayload(); room_speed', { trees: [fakePayload, TREE] });
    check(
      'two callers passing the same trees in a different order agree',
      orderA.ok && orderB.ok,
      JSON.stringify({ orderA: orderA.errors || orderA.note, orderB: orderB.errors || orderB.note })
    );
    fs.rmSync(fakePayload, { recursive: true, force: true });
  }

  process.stdout.write('\nexpression grammar\n');
  {
    const gmllint = require('./gml-lint.js');
    const bad = async (code, rule) => {
      const r = await gmllint.check(code, { trees: [TREE], name: '<test>' });
      check(`refused: ${code}`, !r.ok && r.errors.some((e) => e.rule === rule), JSON.stringify(r.errors));
    };
    const good = async (code) => {
      const r = await gmllint.check(code, { trees: [TREE], name: '<test>' });
      check(`accepted: ${code}`, r.ok, JSON.stringify(r.errors));
    };

    await bad('a = (1 + );', 'dangling-operator');
    await bad('x = * 5;', 'dangling-operator');
    await bad('z = 5 or or 6;', 'dangling-operator');
    await bad('return (1 ; 2);', 'semicolon-in-expression');
    // The comma-in-grouping-paren gap: "(" opened right
    // after an identifier or "]"/")" is a call, and a call's own comma is
    // fine; any other "(" is a bare grouping, where GM8 has no comma operator
    // at all.
    await bad('y = (1, 2);', 'comma-in-grouping');
    await bad('x = (a, b, c);', 'comma-in-grouping');
    await bad('if (a, b) { exit; }', 'comma-in-grouping');

    await good('for (i = 0; i < 10; i += 1) { x += 1; }');
    await good('a[i, j] = 5;');
    await good('x = -y;');
    await good('z = 1 - -1;');
    await good('if (not flag) { exit; }');
    await good('switch (x) { case 1: break; default: break; }');
    await good('do { i += 1; } until (i >= 10);');
    await good('var i, j; i = 0; j = 0;');
    await good('with (self) { x = 1; }');
    await good('a = b == c;');
    await good('a = !b;');
    await good('if (a = b) { exit; }');
    await good('x = point_distance(a, b, c, d);');       // call comma, not grouping
    await good('x = ds_grid_get(grid, a[i, j], y);');    // call comma alongside a 2D index
    await good('y = (a[i, j]);');                        // 2D index nested inside a grouping paren
  }

  process.stdout.write('\npayload call-site patches\n');
  {
    // CODE_PATCHES holds the only edits this tooling makes *to* a line of the
    // game's own logic rather than beside one, and several sites are the
    // braceless body of an `if` - so getting a line wrong here does not fail, it
    // silently changes what the game does. Checked against the real tree's own
    // text, because an anchor is worth nothing unless it is still exactly one
    // line of the file it names.
    const payloadSpec = require('./payload.js');
    const lib = require('./lib.js');
    const group = lib.readText(path.join(__dirname, '..', 'payload', 'Scripts', payloadSpec.SCRIPT_GROUP, '_resources.list.xml'));

    // Every agent* name a replacement calls, in any variant, has to be a
    // registered payload script, or the patched tree is one build away from an
    // unknown-function error.
    for (const patch of payloadSpec.allPatches()) {
      for (const called of patch.to.match(/\bagent[A-Za-z0-9_]*(?=\()/g) || []) {
        check(`${called} is a registered payload script`, group.includes(`name="${called}"`));
      }
    }

    // The checkout selftest copies is upstream, and every site has to resolve
    // against it: the payload must not depend on a fork of the game.
    const { patches, skipped } = payloadSpec.resolvePatches(TREE);
    check('every site resolves against the upstream tree', skipped.length === 0, skipped.join(', '));

    const roundTrip = (tree, list, label) => {
      const originals = new Map();
      for (const patch of list) {
        const file = path.join(tree, ...patch.file);
        if (!originals.has(file)) originals.set(file, lib.readText(file));
        const lines = lib.readText(file).split(/\r?\n/).map((l) => l.trim());
        check(`${label}${patch.file.join('/')}: the anchor is exactly one line`,
          lines.filter((l) => l === patch.from.trim()).length === 1, patch.from);
      }
      for (const patch of list) {
        check(`${label}applies: ${patch.to}`, lib.replaceLine(path.join(tree, ...patch.file), patch.from, patch.to) === true);
      }
      check(`${label}applying twice is a no-op`, list.every(
        (patch) => lib.replaceLine(path.join(tree, ...patch.file), patch.from, patch.to) === false));
      // cleanup cannot know which variant inject chose; an applied tree has to
      // resolve to the same one.
      const again = payloadSpec.resolvePatches(tree).patches;
      check(`${label}an applied tree still resolves to the same patches`, list.every((p) => again.includes(p)));
      for (const patch of list) {
        lib.replaceLine(path.join(tree, ...patch.file), patch.to, patch.from);
      }
      for (const [file, text] of originals) {
        check(`${label}${path.basename(file)} comes back byte for byte`, lib.readText(file) === text);
      }
    };
    roundTrip(TREE, patches, '');

    // The other shape of the desync site, the one a tree carrying
    // Scripts/Client/clientProtocolError.gml has. Built synthetically, so this
    // does not need a fork checked out.
    const desync = payloadSpec.patchSites().find((s) => s.name === 'desync report');
    const protocolPatch = desync.variants[1][0];
    const serialize = path.join(TREE, 'Scripts', 'Serialization', 'deserializeState.gml');
    const upstreamSerialize = lib.readText(serialize);
    const forkFile = path.join(TREE, ...protocolPatch.file);
    fs.mkdirSync(path.dirname(forkFile), { recursive: true });
    fs.writeFileSync(forkFile, `// argument0: text\nvar text;\ntext = argument0;\n    ${protocolPatch.from}\n`);
    fs.writeFileSync(serialize, upstreamSerialize.split(/\r?\n/)
      .filter((l) => !desync.variants[0].some((p) => l.trim() === p.from.trim())).join('\n'));
    const fork = payloadSpec.resolvePatches(TREE);
    check('a clientProtocolError tree picks that variant',
      fork.skipped.length === 0 && fork.patches.includes(protocolPatch)
      && !desync.variants[0].some((p) => fork.patches.includes(p)));
    roundTrip(TREE, [protocolPatch], 'fork shape: ');

    // Neither shape: the site is skipped by name, and the rest still apply.
    fs.rmSync(forkFile);
    const neither = payloadSpec.resolvePatches(TREE);
    check('a site that matches no variant is skipped, not fatal',
      neither.skipped.length === 1 && neither.skipped[0] === 'desync report'
      && neither.patches.length === patches.length - desync.variants[0].length);

    fs.writeFileSync(serialize, upstreamSerialize);
  }

  process.stdout.write('\nimages\n');
  const png = image.toPng(tinyBmp());
  check('a bitmap becomes a PNG', png.converted && png.width === 2 && png.height === 2);
  check('and the PNG survives a second pass', !image.toPng(png.png).converted);

  process.stdout.write('\nMCP tools\n');
  contains('ping reaches the right instance', await mcp.callTool('gg2_ping', { instance: 'fake' }), 'pong from fake');
  contains('an expression comes back', await mcp.callTool('gg2_evalx', { expr: 'room_speed' }), '42');
  contains('state comes back', await mcp.callTool('gg2_state', {}), 'MainMenu');
  await throws('modern GML is refused before it is sent', async () =>
    mcp.callTool('gg2_eval', { code: 'array_length(x);' }), 'would not compile');

  await throws('a GML error turns a plausible 0 into a failure', async () =>
    mcp.callTool('gg2_evalx', { expr: 'global.aTypoNobodyDefined' }), 'reported an error');

  {
    let message = '';
    try {
      await mcp.callTool('gg2_evalx', { expr: 'global.sameErrorEveryFrame' });
    } catch (e) {
      message = e.message;
    }
    contains('repeated identical dialogs are collapsed', message, '(x4)');
    // Once in the located summary line, once in the raw dialog dump - not four
    // times each, which is what a message like this looked like before the fix.
    check('and the raw dialog text is not repeated four times', message.split('Unknown variable winners').length - 1 === 2, message);
  }

  // A call that never comes back used to throw away every diagnostic the
  // launcher had already written down, and guess instead - so the same failure
  // read as a full report or as nothing at all, depending only on whether the
  // reply beat the clock. These go through command() directly: every tool's
  // timeout is measured in seconds, and a test that waits one out is a test
  // nobody runs.
  process.stdout.write('\ntimeout diagnosis\n');
  {
    const fake = { name: 'fake', port: PORT };
    const failed = async (text, timeoutMs) => {
      try {
        await mcp.command(fake, text, timeoutMs);
        return '';
      } catch (e) {
        return e.message;
      }
    };

    // A reply that arrives after its caller gave up belongs to that call by id,
    // so it is dropped as such - handing it to whoever asked next is exactly
    // the plausible wrong answer the rest of this file exists to prevent.
    contains('a slow reply times out', await failed('EVALX global.answersTooLate', 200), 'did not reply');
    await new Promise((r) => setTimeout(r, 400));
    contains('and a late reply is not handed to the next caller', await mcp.callTool('gg2_evalx', { expr: 'room_speed' }), '42');
    check('and every request carried an id', seen.length > 0 && !seen.some((s) => s.startsWith('#')), seen.slice(-3).join(' | '));

    const message = await failed('EVALX global.neverAnswers', 300);
    contains('a call that never answers still reports what the launcher saw', message, 'Unknown variable winners');
    contains('and locates it', message, '.xml:');
    contains('and counts the repeats', message, '(x3)');
    contains('and says a per-frame error needs a restart', message, 'gg2_session stop');
    contains('and message boxes are reported here too', message, 'Assertion 7 failed');
    contains('and it still says how long it waited', message, '300ms');

    // A bridge whose every outstanding call has been given up on is
    // reconnected before the next one goes out, rather than left for the caller
    // to work out. Dropping the connection is the only thing that reaches a
    // game that has stopped reading - a deferred STEP or WAIT that outlived its
    // caller blocks every later request until its whole budget runs out. So
    // this call goes down a connection opened moments ago, and the dialogs the
    // one before it collected are not its to explain.
    const connectionsBefore = live.length;
    const quiet = await failed('EVALX global.quietlyNeverAnswers', 300);
    check('a wedged bridge is reconnected before the next call', live.length > connectionsBefore, `${live.length} connection(s)`);
    contains('a silent hang is not blamed on a dialog that did not happen', quiet, 'dismissed no dialog');
    check('and does not invent one', !quiet.includes('| ERROR in'), quiet);

    // Reconnecting cures a game that stopped reading; it cannot cure one that
    // stopped stepping, and failing again straight after one has to say so
    // rather than repeat the first diagnosis.
    contains('and failing again after a reconnect is diagnosed differently', quiet, 'already reconnected once');
    contains('and that says to restart the instance', quiet, 'gg2_session stop');

    // A reply clears the suspicion again, so the next real failure is not
    // reported as if this one had never been answered.
    contains('a reconnected bridge answers normally', await mcp.callTool('gg2_evalx', { expr: 'room_speed' }), '42');

    // Two calls in flight at once against a game that answers neither. The
    // second is not at fault for its own wait: the game reads requests in
    // order, so it may never have been looked at. (Concurrently, or the
    // reconnect above would clear the first out of the way.)
    const [, behind] = await Promise.all([
      failed('EVALX global.quietlyNeverAnswers', 200),
      failed('EVALX global.quietlyNeverAnswers', 500),
    ]);
    contains('and says it was stuck behind an earlier call', behind, '1 earlier call(s) never answered');

    // --- escaping a deferred reply -----------------------------------------
    //
    // The case the whole CANCEL protocol exists for: a WAIT whose caller gave
    // up long before its frame budget ran out. Before this, the only way to
    // reach a bridge in that state was to drop the connection - which loses
    // whatever the caller had frozen and costs the game a few unaccounted
    // frames - because the bridge read nothing at all until the deferred reply
    // went out.
    {
      // Settle first. The block above deliberately leaves two abandoned calls,
      // and the next request through this bridge recovers from them - so
      // without this, the reconnect being measured here would be the previous
      // test's, not this one's.
      await mcp.callTool('gg2_evalx', { expr: 'room_speed' });
      const connections = live.length;
      const stuck = await failed('WAIT 600 0:neverFinishes', 200);
      contains('a deferred reply that outlives its caller times out', stuck, 'did not reply');

      // The next call clears it with CANCEL. Same connection: nothing is
      // dropped, so nothing this client froze is lost.
      contains('the next call goes through', await mcp.callTool('gg2_evalx', { expr: 'room_speed' }), '42');
      check('and CANCEL cleared it without reconnecting', live.length === connections, `${live.length} vs ${connections}`);
      check('and the CANCEL actually reached the game', seen.includes('CANCEL'), seen.slice(-4).join(' | '));
    }

    // A bridge from before CANCEL reads nothing while deferred, so the request
    // is never even seen and no answer comes. That silence is what selects the
    // reconnect, and it must still work - every build older than this protocol
    // behaves this way.
    {
      mode.cancel = 'ignore';
      const connections = live.length;
      const stuck = await failed('WAIT 600 0:neverFinishes', 200);
      contains('an older bridge still times out the same way', stuck, 'did not reply');
      contains('the next call still succeeds', await mcp.callTool('gg2_evalx', { expr: 'room_speed' }), '42');
      check('and it reconnected, because CANCEL went unanswered', live.length > connections, `${live.length} vs ${connections}`);
      mode.cancel = 'answer';
    }


    // The rest of the file needs a bridge that is not queued behind either of
    // those.
    mcp.disconnectAll('selftest: clearing a deliberately wedged bridge');
    contains('a fresh connection recovers', await mcp.callTool('gg2_evalx', { expr: 'room_speed' }), '42');

    // The catch that kept this fix on the shelf: the game unfreezes when its
    // client vanishes, so reconnecting resumes a world the caller deliberately
    // stopped. The freeze is re-applied, and the call that triggered all this
    // is failed rather than answered - a value measured after the world moved
    // is worth less than being told that it moved.
    await mcp.command(fake, 'FREEZE');
    const freezes = seen.filter((s) => s === 'FREEZE').length;
    await failed('EVALX global.quietlyNeverAnswers', 200);
    const refroze = await failed('EVALX room_speed', 500);
    contains('recovering a frozen game says the world moved', refroze, 'frozen at your request');
    contains('and says to retry rather than answering', refroze, 'retry it');
    check('and freezes it again', seen.filter((s) => s === 'FREEZE').length === freezes + 1, seen.slice(-4).join(' | '));
    contains('and the retry then works', await mcp.command(fake, 'EVALX room_speed'), '42');
    await mcp.command(fake, 'RESUME');

    // A game whose bridge predates request ids answers frames that cannot be
    // matched to anything. Guessing at an alignment is how a wrong answer that
    // looks right gets produced, so it says what to do instead.
    const old = await failed('EVALX global.oldBridgePretendsNoId', 500);
    contains('a reply with no id is refused, not guessed at', old, 'older AgentBridge');
    contains('and names the fix', old, 'gg2_rebuild');
    contains('and the next call reconnects and works', await mcp.command(fake, 'EVALX room_speed'), '42');
  }

  // The other error channel: a compilation error inside execute_string raises
  // no dialog and is only ever written to the engine's own log.
  fs.writeFileSync(path.join(BUILD, 'game_errors.log'), '');
  await throws('a silent compilation error is caught too', async () =>
    mcp.callTool('gg2_evalx', { expr: 'notAFunctionAnywhere(1)', skip_lint: true }), 'reported an error');

  const stepped = await mcp.callTool('gg2_step', { frames: 5 });
  contains('stepping advances exactly what was asked', stepped, 'advanced 5 frame(s)');
  check('and freezes first', seen.includes('FREEZE'), seen.join(' | '));
  contains('resume works', await mcp.callTool('gg2_resume', {}), 'running');
  contains('waiting returns when the condition holds', await mcp.callTool('gg2_wait', { expr: 'fps > 0', frames: 60 }), 'true after');
  check('and with no setup the wire still carries a (zero) length prefix', seen.includes('WAIT 60 0:fps > 0'), seen.filter((s) => s.startsWith('WAIT')).join(' | '));

  // setup runs once, synchronously, before the first evaluation of
  // expr, so a trial's placement and its wait arm on the same call instead of
  // leaving an unknown amount of real game time between two separate ones.
  // The fake bridge does not parse WAIT's rest, so this checks what the JS
  // side put on the wire - the length-prefixed encoding that keeps setup and
  // expr unambiguous regardless of what either contains.
  contains('wait accepts a setup and still reports true', await mcp.callTool('gg2_wait', { expr: 'fps > 0', setup: 'x = 1;', frames: 60 }), 'true after');
  check('and setup is sent length-prefixed ahead of the expression', seen.includes('WAIT 60 6:x = 1;fps > 0'), seen.filter((s) => s.startsWith('WAIT')).join(' | '));
  await throws('a setup that would not compile is refused before it is sent', async () =>
    mcp.callTool('gg2_wait', { expr: 'fps > 0', setup: 'array_length(x);', frames: 60 }), 'would not compile');

  check('input is sent as typed', (await mcp.callTool('gg2_input', { commands: 'press jump' })) === 'ok' && seen.includes('INPUT press jump'));
  contains('watch is added', await mcp.callTool('gg2_watch', { action: 'add', expr: 'fps' }), 'watching');
  check('and with no label the wire still carries a (zero) length prefix', seen.includes('WATCH add 0:fps'), seen.filter((s) => s.startsWith('WATCH')).join(' | '));
  contains('watch accepts a label', await mcp.callTool('gg2_watch', { action: 'add', expr: 'fps', label: 'FPS' }), 'watching');
  check('and the label is sent length-prefixed ahead of the expression', seen.includes('WATCH add 3:FPSfps'), seen.filter((s) => s.startsWith('WATCH')).join(' | '));

  const shot = await mcp.callTool('gg2_screenshot', {});
  check('a screenshot comes back as an image block', Array.isArray(shot) && shot[0].type === 'image' && shot[0].mimeType === 'image/png');
  check('and the temporary file is cleared away', !fs.existsSync(path.join(BUILD, `agent_shot_${PORT}.png`)));

  // The walkmask: the collision the nav graph is built against, read out of the
  // map PNG's own level data. Synthesised here rather than taken from the game
  // repo, so the encoding is checked against a pattern this file knows the
  // answer to - a mask decoded one bit out of step still looks like a map.
  process.stdout.write('\nwalkmask\n');
  {
    const walkmask = require('./walkmask.js');
    const W = 10;
    const H = 4;
    // Solid: the whole bottom row, plus a single block in the middle of row 1.
    const solid = (x, y) => (y === H - 1 || (y === 1 && x === 4) ? 1 : 0);
    fs.mkdirSync(path.join(TREE, 'Included Files'), { recursive: true });
    fs.writeFileSync(path.join(TREE, 'Included Files', 'fakemap.png'), fakeMapPng(W, H, solid));

    const mask = walkmask.decode('fakemap', SCRATCH);
    check('a walkmask decodes at the map art\'s own size', mask.width === W && mask.height === H, `${mask.width}x${mask.height}`);
    check(
      'and every pixel lands where it was encoded',
      [...mask.bits].every((b, i) => b === solid(i % W, Math.floor(i / W))),
      [...mask.bits].join(''),
    );

    check('and answers cell queries the same way', mask.solid(4, 1) === 1 && mask.solid(0, 0) === 0);

    const art = { width: W, height: H, rgba: Buffer.alloc(W * H * 4, 0) };
    const solidOnly = walkmask.tint(art, mask, { strength: 1, only: 'solid' });
    const openPx = (im, x, y) => im.rgba[(y * W + x) * 4];
    check('tinting solids leaves open space alone', openPx(solidOnly, 0, 0) === 0);
    check('and paints the solid ones', openPx(solidOnly, 4, 1) === walkmask.SOLID[0], String(openPx(solidOnly, 4, 1)));

    // Six world pixels to the mask cell, always (NAV_CELL_SIZE): a live shot
    // is tinted through that scale and an offset, and getting either wrong puts
    // the geometry somewhere it is not.
    const shot = { width: 12, height: 12, rgba: Buffer.alloc(12 * 12 * 4, 0) };
    const overWorld = walkmask.tint(shot, mask, { cell: 6, originX: 24, originY: 6, strength: 1, only: 'solid' });
    const at = (x, y) => overWorld.rgba[(y * 12 + x) * 4];
    check('a live shot maps 6 world px to one mask cell', at(0, 0) === walkmask.SOLID[0], String(at(0, 0)));
    check('and the origin offsets it', at(6, 0) === 0, String(at(6, 0)));

    // The outline, which is what a live shot actually gets: one world pixel on
    // the solid side of the boundary, and nothing at all inside or outside it.
    const traced = walkmask.outline(shot, mask, { cell: 6, originX: 24, originY: 6 });
    const edge = (x, y) => traced.rgba[(y * 12 + x) * 4 + 2] === walkmask.EDGE[2];
    check('the outline marks the top of a solid cell', edge(0, 0));
    check('and the cell interior is left alone', !edge(2, 2));
    check('and open space is untouched', !edge(6, 0));

    await throws('a map with no level data says so', async () => {
      fs.writeFileSync(path.join(TREE, 'Included Files', 'bare.png'), image.encodePngRgba(2, 2, Buffer.alloc(16, 255)));
      return walkmask.decode('bare', SCRATCH);
    }, 'Level Data');

    const drawn = await mcp.callTool('gg2_map_image', { base: 'mask', scale: 1 });
    check('gg2_map_image can draw the mask', Array.isArray(drawn) && drawn[0].type === 'image', JSON.stringify(drawn).slice(0, 80));
    contains('and says which base it used', drawn[1].text, 'base mask');
    contains('and art is still available', (await mcp.callTool('gg2_map_image', { scale: 1 }))[1].text, 'base art');
  }

  // The tool table is data in one file and behaviour in another, so nothing but
  // a check keeps them in step.
  process.stdout.write('\nMCP tool table\n');
  {
    const src = fs.readFileSync(path.join(__dirname, 'gg2-mcp-server.js'), 'utf8');
    const missing = mcp.TOOLS.filter((t) => !src.includes(`case '${t.name}':`)).map((t) => t.name);
    check('every advertised tool has a case in callTool', missing.length === 0, missing.join(', '));

    const cased = [...src.matchAll(/case '(gg2_[a-z_]+)':/g)].map((m) => m[1]);
    const unlisted = cased.filter((n) => !mcp.TOOLS.some((t) => t.name === n));
    check('and every implemented tool is advertised', unlisted.length === 0, unlisted.join(', '));

    check('every tool declares a schema and a description',
      mcp.TOOLS.every((t) => t.description && t.inputSchema && t.inputSchema.type === 'object'));
  }

  contains('find sees code inside events', await mcp.callTool('gg2_find', { pattern: 'closestDist' }), '.events/');
  contains('find sees scripts too', await mcp.callTool('gg2_find', { pattern: 'test_unit_begin' }), '.gml:');
  contains('events can be listed', await mcp.callTool('gg2_event', { action: 'list', object: 'Heavy' }), 'Step');

  const beforeTest = seen.length;
  const tested = await mcp.callTool('gg2_test', { suite: 'test_ggon' });
  contains('a suite reports its assertion counts', tested, '44/45 assertions succeeded');
  contains('and says how many failed when the text is unreadable', tested, '1 assertion(s) failed');
  contains('and a failed assertion is not called a crash', tested, '0/1 suite(s) passed');
  check(
    'gg2_test defaults to the game reading its own suite off disk',
    seen.slice(beforeTest).some((s) => s.includes('file_text_open_read')),
    seen.slice(beforeTest).join(' | ')
  );

  {
    // A run of every suite stops at the first one that goes wrong, and the
    // counters cannot be read back from a game that is not answering - so the
    // failure has to name the suite itself.
    const wedged = path.join(TREE, 'Scripts', 'Unit tests', 'test_wedged.gml');
    fs.writeFileSync(wedged, 'test_unit_begin();\ntest_assert_equals(1, 1);\ntest_unit_end();\n');
    let message = '';
    try {
      await mcp.callTool('gg2_test', { suite: 'test_wedged' });
    } catch (e) {
      message = e.message;
    }
    contains('a suite that fails mid-run says which suite it was', message, 'test_wedged');
    contains('and names its file', message, 'Unit tests/test_wedged.gml');
    contains('and carries what the game said', message, 'gave up on this one');
    fs.rmSync(wedged, { force: true });
  }

  const beforeSendSource = seen.length;
  const testedSendSource = await mcp.callTool('gg2_test', { suite: 'test_ggon', send_source: true });
  contains('send_source falls back to sending the suite text over the wire', testedSendSource, '44/45 assertions succeeded');
  check(
    'and that call does not use the in-game loader',
    seen.slice(beforeSendSource).every((s) => !s.includes('file_text_open_read')),
    seen.slice(beforeSendSource).join(' | ')
  );

  const beforeProfileExpr = seen.length;
  const profiledExpr = await mcp.callTool('gg2_profile', { code: 'x = x + 1;', n: 10 });
  contains('gg2_profile expr mode reports iterations and a total', profiledExpr, '10 iteration(s)');
  contains('and a per-iteration mean', profiledExpr, 'ms/iteration');
  check(
    'and the repeat count reached the game',
    seen.slice(beforeProfileExpr).some((s) => s.includes('repeat (10)')),
    seen.slice(beforeProfileExpr).join(' | ')
  );

  const beforeProfileFrames = seen.length;
  const profiledFrames = await mcp.callTool('gg2_profile', { mode: 'frames', frames: 5 });
  check(
    'gg2_profile frames mode freezes before stepping',
    seen.slice(beforeProfileFrames).includes('FREEZE'),
    seen.slice(beforeProfileFrames).join(' | ')
  );
  check(
    'and steps one frame at a time',
    seen.slice(beforeProfileFrames).filter((s) => s === 'STEP 1').length >= 5,
    seen.slice(beforeProfileFrames).join(' | ')
  );
  contains('and reports a frame-time distribution', profiledFrames, 'mean');
  contains('with a p95', profiledFrames, 'p95');
  check('and leaves the game frozen for the caller to resume', profiledFrames.includes('call gg2_resume'));

  const logged = await mcp.callTool('gg2_log', { source: 'launcher', lines: 100 });
  contains('the log locates the error it recorded', logged, 'Unknown variable aTypoNobodyDefined');
  check('and names a file for it', /Scripts[\w\/ .-]*\.gml:\d+|Objects[\w\/ .-]*\.xml:\d+|object AgentBridge/.test(logged), logged.slice(-300));

  contains('sessions can be listed', await mcp.callTool('gg2_session', { action: 'list' }), 'fake');

  // The server keeps its connection to a game open on purpose, so nothing here
  // exits until the sockets on both ends are let go.
  mcp.disconnectAll('selftest finished');
  for (const s of live) s.destroy();
  server.close();
  instances.unregister(BUILD, PORT);
  fs.rmSync(SCRATCH, { recursive: true, force: true });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) process.stdout.write('  - ' + f + '\n');
    process.exit(1);
  }
}

main().catch((e) => {
  process.stdout.write('selftest could not run: ' + e.stack + '\n');
  process.exit(1);
});
