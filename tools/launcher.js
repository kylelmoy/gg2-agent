#!/usr/bin/env node
//=============================================================================
// launcher.js - launch Gang Garrison 2 with the agent bridge enabled, and keep
// it running unattended.
//
// GM8 answers two ordinary situations with a modal dialog: no audio device,
// which happens routinely over RDP, and any GML runtime error. Either one
// freezes the game before or after the bridge starts listening, and takes every
// pending MCP call down with it. Nothing inside the game can clear its own
// modal, so this process stays resident and clicks the boxes away from outside.
//
// It owns the game as a child process, so it knows the pid without searching
// and exits when the game does.
//
// Usage:
//   node launcher.js <path to game exe> [extra game args]
//
// Exit codes: 0 = game ran and exited, 1 = could not start it.
//=============================================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const win32 = require('./win32.js');

const POLL_MS = 250;

// The three windows that can stop the game, and the button to press in each.
//
// TErrorForm is the GML runtime error box, and the one that matters: it offers
// Abort and Ignore, so a launcher that clicks the first button it finds kills
// the game. Press Ignore by name, and read the error out of its memo first -
// that text is usually the only explanation an agent will get for a call that
// suddenly started timing out.
//
// These forms all exist from startup and are merely hidden, so only visible
// ones count - otherwise this would sit clicking buttons on invisible windows.
const DIALOGS = [
  { cls: 'TErrorForm', button: 'TBitBtn', press: 'Ignore', readFrom: 'TMemo' },
  { cls: 'TMessageForm', button: 'TButton' },
  { cls: '#32770', button: 'Button' },
];

let logFile = '';

function log(msg) {
  const t = new Date();
  const stamp =
    t.getFullYear().toString() +
    String(t.getMonth() + 1).padStart(2, '0') +
    String(t.getDate()).padStart(2, '0') +
    String(t.getHours()).padStart(2, '0') +
    String(t.getMinutes()).padStart(2, '0') +
    String(t.getSeconds()).padStart(2, '0');
  process.stdout.write(msg + '\n');
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${stamp} ${msg}\n`);
    } catch (e) {
      /* the log is a convenience, never a reason to stop watching */
    }
  }
}

function die(msg) {
  log('FAIL: ' + msg);
  process.exit(1);
}

// Run throws asynchronously. The usual cause is a previous instance still
// exiting and holding the exe, so retry briefly before giving up.
function startGame(exe, args, cwd, attempt = 1) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, stdio: 'ignore', windowsHide: false });
    child.once('spawn', () => resolve(child));
    child.once('error', (e) => {
      if (attempt >= 10) return reject(e);
      setTimeout(() => startGame(exe, args, cwd, attempt + 1).then(resolve, reject), 500);
    });
  });
}

async function main() {
  const [exe, ...extra] = process.argv.slice(2);
  if (!exe) die('usage: launcher.js <game exe> [extra args]');
  if (!fs.existsSync(exe)) die('not found: ' + exe);

  const exeDir = path.dirname(path.resolve(exe));
  logFile = path.join(exeDir, 'agent_launcher.log');
  try {
    fs.rmSync(logFile, { force: true });
  } catch (e) {
    /* an open handle on the old log is not worth failing over */
  }

  const args = ['-agent', ...extra];
  log(`launching ${path.basename(exe)} ${args.join(' ')}`);

  let child;
  try {
    child = await startGame(path.resolve(exe), args, exeDir);
  } catch (e) {
    die('could not start the game: ' + e.message);
  }
  log(`pid ${child.pid}`);

  let alive = true;
  let dismissed = 0;
  child.once('exit', () => {
    alive = false;
  });

  // Stay resident for as long as the game lives, clearing modal boxes. A window
  // can always vanish between finding it and clicking it, so nothing in here is
  // allowed to throw.
  while (alive) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    for (const spec of DIALOGS) {
      try {
        for (const w of win32.windows({ cls: spec.cls, pid: child.pid })) {
          const kids = win32.children(w.hwnd);

          const buttons = kids.filter((k) => k.cls === spec.button);
          const target = spec.press
            ? buttons.find((b) => b.text.replace('&', '').includes(spec.press))
            : buttons[0];
          if (!target) continue;

          if (spec.readFrom) {
            const source = kids.find((k) => k.cls === spec.readFrom);
            const text = source ? win32.controlText(source.hwnd).trim() : '';
            if (text) for (const line of text.split(/\r?\n/)) log('  | ' + line);
          }

          win32.clickButton(target.hwnd);
          dismissed++;
          log(`dismissed ${w.title || spec.cls}${spec.press ? ` (pressed ${spec.press})` : ''} - ${dismissed} so far`);
        }
      } catch (e) {
        log('warning while clearing dialogs: ' + e.message);
      }
    }
  }

  log(`game exited; dismissed ${dismissed} dialog(s)`);
  process.exit(0);
}

main();
