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
          } else if (rest.includes('test_unit_begin')) {
            // A suite's source, run with its reporting call stripped out. One
            // assertion fails, and GM8 shows a box whose text nobody can read.
            check('the suite runs without its reset', !rest.includes('test_unit_end('));
            appendDialog(port, 'M', ['(dialog had no readable text)']);
            counters = { total: 45, succeeded: 44 };
            reply('OK');
          } else if (rest.startsWith('global.testAssertionsSucceeded')) {
            reply('OK ' + counters.succeeded);
          } else if (rest.startsWith('global.testAssertions')) {
            reply('OK ' + counters.total);
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

  const tested = await mcp.callTool('gg2_test', { suite: 'test_ggon' });
  contains('a suite reports its assertion counts', tested, '44/45 assertions succeeded');
  contains('and says how many failed when the text is unreadable', tested, '1 assertion(s) failed');
  contains('and a failed assertion is not called a crash', tested, '0/1 suite(s) passed');

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
