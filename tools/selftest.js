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

function startFakeBridge(port) {
  const seen = [];
  const live = [];
  let counters = { total: -1, succeeded: -1 };
  let fakeClock = 1000000;
  const server = net.createServer((sock) => {
    live.push(sock);
    let rx = Buffer.alloc(0);
    const reply = (text) => {
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
        const request = rx.slice(4, 4 + n).toString('latin1');
        rx = rx.slice(4 + n);
        seen.push(request);

        const [verb, ...restParts] = request.split(' ');
        const rest = restParts.join(' ');

        if (verb === 'PING') reply('OK pong');
        else if (verb === 'FREEZE') reply('OK frozen');
        else if (verb === 'RESUME') reply('OK running');
        else if (verb === 'STATE') reply('OK {room: MainMenu, fps: 30}');
        else if (verb === 'STEP') setTimeout(() => reply(`OK advanced ${rest} frame(s)`), 50);
        else if (verb === 'WAIT') setTimeout(() => reply('OK true after 2 frame(s)'), 50);
        else if (verb === 'INPUT') reply('OK');
        else if (verb === 'WATCH') reply('OK watching 1 expression(s)');
        else if (verb === 'SHOT') {
          fs.writeFileSync(rest, tinyBmp());
          reply('OK ' + rest);
        } else if (verb === 'EVAL' || verb === 'EVALX') {
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
            // every frame once global.winners is unbound (see HANDOFF.md).
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
          } else {
            reply(verb === 'EVAL' ? 'OK' : 'OK 42');
          }
        } else reply('ERR unknown verb ' + verb);
      }
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, seen, live })));
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

  const { server, seen, live } = await startFakeBridge(PORT);

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
  events.writeEvent(SCRATCH, 'Heavy', 'Step', 0, read.gml, { payload: false });
  check('a write that changes nothing is byte-identical', before.equals(fs.readFileSync(heavy)));
  events.writeEvent(SCRATCH, 'Heavy', 'Step', 0, 'a = 1 < 2 & 3 > 0;', { payload: false, lintFirst: false });
  check('what is written comes back the same', events.readEvent(SCRATCH, 'Heavy', 'Step', 0, { payload: false }).gml === 'a = 1 < 2 & 3 > 0;');
  contains('and is escaped on disk', fs.readFileSync(heavy, 'latin1'), '&lt; 2 &amp;&amp;'.slice(0, 5));
  await throws('bad GML is refused before it is written', async () =>
    events.writeEvent(SCRATCH, 'Heavy', 'Step', 0, 'array_length(x);', { payload: false }), 'would not compile');
  await throws('empty code is refused, since the splicer cannot place it', async () =>
    events.writeEvent(SCRATCH, 'Heavy', 'Step', 0, '  ', { payload: false, lintFirst: false }), 'empty code');
  fs.writeFileSync(heavy, before);

  process.stdout.write('\nlint cache invalidation\n');
  {
    const gmllint = require('./gml-lint.js');
    const newScript = path.join(TREE, 'Scripts', 'someBrandNewScript.gml');
    const manifestDir = path.join(BUILD, 'template');
    const manifestFile = path.join(manifestDir, 'gamedata.manifest.json');

    const before = gmllint.check('someBrandNewScript();', { trees: [TREE], name: '<test>' });
    check('a call to an unknown script is refused', !before.ok, JSON.stringify(before.errors));

    fs.writeFileSync(newScript, 'return 1;');
    const stillCached = gmllint.check('someBrandNewScript();', { trees: [TREE], name: '<test>' });
    check('adding the script alone does not invalidate the cache', !stillCached.ok);

    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(manifestFile, '{}');
    const afterBuild = gmllint.check('someBrandNewScript();', { trees: [TREE], name: '<test>' });
    check('a rewritten build manifest invalidates it', afterBuild.ok, JSON.stringify(afterBuild.errors));

    fs.rmSync(newScript, { force: true });
    fs.rmSync(manifestDir, { recursive: true, force: true });
  }

  // HANDOFF.md issue 3: events.js passes [payload, tree] (the payload is
  // checked first, since a bridge file the injected copy would shadow); the
  // MCP server passes [tree, payload]. Two callers in the same process asking
  // about the same project in a different order must land on one cache
  // entry, not thrash each other's - which would either waste every call
  // rebuilding, or, if a key ever collided wrongly, serve one caller's stale
  // answer to the other.
  process.stdout.write('\ntree order independence\n');
  {
    const gmllint = require('./gml-lint.js');
    const fakePayload = path.join(SCRATCH, 'fake-payload');
    fs.mkdirSync(fakePayload, { recursive: true });
    const newScript = path.join(TREE, 'Scripts', 'anotherBrandNewScript.gml');
    const manifestDir = path.join(BUILD, 'template');

    const orderA = gmllint.check('room_speed', { trees: [TREE, fakePayload] });
    const orderB = gmllint.check('room_speed', { trees: [fakePayload, TREE] });
    check(
      'two callers passing the same trees in a different order agree',
      orderA.ok && orderB.ok,
      JSON.stringify({ orderA: orderA.errors, orderB: orderB.errors })
    );

    const before = gmllint.check('anotherBrandNewScript();', { trees: [fakePayload, TREE] });
    check('unknown from the payload-first order too', !before.ok);

    fs.writeFileSync(newScript, 'return 1;');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'gamedata.manifest.json'), '{}');
    const after = gmllint.check('anotherBrandNewScript();', { trees: [TREE, fakePayload] });
    check('a manifest rewrite is picked up regardless of which order asked before it', after.ok, JSON.stringify(after.errors));

    fs.rmSync(newScript, { force: true });
    fs.rmSync(manifestDir, { recursive: true, force: true });
    fs.rmSync(fakePayload, { recursive: true, force: true });
  }

  // HANDOFF.md's lint-gate item: gg2_lint used to pass GML that does not
  // compile, because it never parsed expression grammar at all. These two
  // checks are narrow on purpose - "what comes right after this operator" and
  // "no bare ; inside a non-for-loop paren" - so this locks both the catch and
  // the absence of false positives on idioms that look similar but are fine.
  process.stdout.write('\nexpression grammar\n');
  {
    const gmllint = require('./gml-lint.js');
    const bad = (code, rule) => {
      const r = gmllint.check(code, { trees: [TREE], name: '<test>' });
      check(`refused: ${code}`, !r.ok && r.errors.some((e) => e.rule === rule), JSON.stringify(r.errors));
    };
    const good = (code) => {
      const r = gmllint.check(code, { trees: [TREE], name: '<test>' });
      check(`accepted: ${code}`, r.ok, JSON.stringify(r.errors));
    };

    bad('a = (1 + );', 'dangling-operator');
    bad('x = * 5;', 'dangling-operator');
    bad('z = 5 or or 6;', 'dangling-operator');
    bad('return (1 ; 2);', 'semicolon-in-expression');

    good('for (i = 0; i < 10; i += 1) { x += 1; }');
    good('a[i, j] = 5;');
    good('x = -y;');
    good('z = 1 - -1;');
    good('if (not flag) { exit; }');
    good('switch (x) { case 1: break; default: break; }');
    good('do { i += 1; } until (i >= 10);');
    good('var i, j; i = 0; j = 0;');
    good('with (self) { x = 1; }');
    good('a = b == c;');
    good('a = !b;');
    good('if (a = b) { exit; }');
  }

  process.stdout.write('\nbuild-fast refusal\n');
  {
    // patch() refuses before it ever opens an exe when the tree hash does not
    // match, so this needs no real Game Maker build - just a tree and a
    // manifest shaped the way snapshot() would have written one.
    const gamedata = require('./gamedata.js');
    const resourceDir = path.join(TREE, 'Rooms');
    fs.mkdirSync(resourceDir, { recursive: true });
    const resourceFile = path.join(resourceDir, 'room_fake.xml');
    fs.writeFileSync(resourceFile, '<room>original</room>');

    const treeFileHashes = gamedata.treeFileHashes(TREE);
    const manifest = {
      version: 1,
      template: 'nonexistent.exe',
      treeHash: gamedata.treeHash(TREE),
      treeFileHashes,
      code: [],
    };
    const manifestPath = path.join(BUILD, 'fake.manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    fs.writeFileSync(resourceFile, '<room>changed</room>');
    await throws('a changed resource file is refused', async () =>
      gamedata.patch(manifestPath, TREE, path.join(BUILD, 'out.exe'), true), 'Run build-agent.js');
    try {
      gamedata.patch(manifestPath, TREE, path.join(BUILD, 'out.exe'), true);
      check('and names it', false, 'nothing thrown');
    } catch (e) {
      contains('and names it', e.message, 'Rooms/room_fake.xml');
    }

    fs.rmSync(resourceFile, { force: true });
    fs.rmSync(manifestPath, { force: true });
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

    // The game answers in order, one reply per request, so a reply that arrives
    // after its caller gave up must be swallowed rather than handed to whoever
    // asks next - an answer that belongs to the previous call is exactly the
    // plausible wrong answer the rest of this file exists to prevent.
    contains('a slow reply times out', await failed('EVALX global.answersTooLate', 200), 'did not reply');
    await new Promise((r) => setTimeout(r, 400));
    contains('and a late reply is not handed to the next caller', await mcp.callTool('gg2_evalx', { expr: 'room_speed' }), '42');

    const message = await failed('EVALX global.neverAnswers', 300);
    contains('a call that never answers still reports what the launcher saw', message, 'Unknown variable winners');
    contains('and locates it', message, '.xml:');
    contains('and counts the repeats', message, '(x3)');
    contains('and says a per-frame error needs a restart', message, 'gg2_session stop');
    contains('and message boxes are reported here too', message, 'Assertion 7 failed');
    contains('and it still says how long it waited', message, '300ms');

    // Queued behind that one, which never answered: the game reads requests in
    // order, so this call was never looked at and nothing about it is at fault.
    const queued = await failed('EVALX global.quietlyNeverAnswers', 300);
    contains('a silent hang is not blamed on a dialog that did not happen', queued, 'dismissed no dialog');
    check('and does not invent one', !queued.includes('| ERROR in'), queued);
    contains('and says it was stuck behind an earlier call', queued, '1 earlier call(s) never answered');

    // Two requests are still outstanding against a game that will never answer
    // them; the rest of the file needs a bridge that is not queued behind them.
    mcp.disconnectAll('selftest: clearing a deliberately wedged bridge');
    contains('a fresh connection recovers', await mcp.callTool('gg2_evalx', { expr: 'room_speed' }), '42');
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
  check('input is sent as typed', (await mcp.callTool('gg2_input', { commands: 'press jump' })) === 'ok' && seen.includes('INPUT press jump'));
  contains('watch is added', await mcp.callTool('gg2_watch', { action: 'add', expr: 'fps' }), 'watching');

  const shot = await mcp.callTool('gg2_screenshot', {});
  check('a screenshot comes back as an image block', Array.isArray(shot) && shot[0].type === 'image' && shot[0].mimeType === 'image/png');
  check('and the temporary file is cleared away', !fs.existsSync(path.join(BUILD, `agent_shot_${PORT}.png`)));

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
