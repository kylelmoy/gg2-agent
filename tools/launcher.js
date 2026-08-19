#!/usr/bin/env node
//=============================================================================
// launcher.js - launch Gang Garrison 2 with the agent bridge enabled, and keep
// it running unattended.
//
// GM8 answers three ordinary situations with a modal dialog: no audio device,
// which happens routinely over RDP; any GML runtime error; and every call to
// show_message, which is how the game's own unit tests report. All of them
// freeze the game before or after the bridge starts listening, and take every
// pending MCP call down with them. Nothing inside the game can clear its own
// modal, so this process stays resident and clicks the boxes away from outside,
// writing down what they said on the way past.
//
// It owns the game as a child process, so it knows the pid without searching,
// exits when the game does, and can keep the instance register honest.
//
// Usage:
//   node launcher.js <path to game exe> [--name <label>] [--role <role>]
//                    [extra game args]
//
// Exit codes: 0 = game ran and exited, 1 = could not start it.
//=============================================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const win32 = require('./win32.js');
const instances = require('./instances.js');

const POLL_MS = 250;

// The three windows that can stop the game, and the button to press in each.
//
// TErrorForm is the GML runtime error box, and the one that matters most: it
// offers Abort and Ignore, so a launcher that clicks the first button it finds
// kills the game. Press Ignore by name, and read the error out of it first -
// that text is usually the only explanation an agent will get for a call that
// suddenly started timing out.
//
// The other two carry show_message, which is how the game's assertion helpers
// report; the test runner reads its results back out of this log. The two kinds
// are marked differently, because a failed assertion is not a crash and must
// not be reported as one.
//
// These forms all exist from startup and are merely hidden, so only visible
// ones count - otherwise this would sit clicking buttons on invisible windows.
const DIALOGS = [
  { cls: 'TErrorForm', button: 'TBitBtn', press: 'Ignore', mark: 'E' },
  { cls: 'TMessageForm', button: 'TButton', mark: 'M' },
  { cls: '#32770', button: 'Button', mark: 'M' },
];

// Controls that hold a dialog's buttons rather than its words. Everything else
// in the window is read as text. Delphi paints some captions with no window
// handle at all, so this is best effort: what cannot be read is reported as
// unreadable rather than silently dropped.
const BUTTON_CLASSES = ['TBitBtn', 'TButton', 'Button', 'TSpeedButton'];

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

// Everything a dialog is saying, from all of its non-button controls. Some
// dialogs nest their text inside a panel, so this walks descendants rather than
// direct children - shallowly, since these are small windows and this runs four
// times a second.
function dialogText(hwnd, depth = 0) {
  const lines = [];
  if (depth > 3) return lines;
  for (const k of win32.children(hwnd)) {
    if (BUTTON_CLASSES.includes(k.cls)) continue;
    const text = (win32.controlText(k.hwnd) || k.text || '').trim();
    for (const line of text.split(/\r?\n/)) if (line.trim()) lines.push(line.trim());
    if (!text) lines.push(...dialogText(k.hwnd, depth + 1));
  }
  return lines;
}

// Split "--name x --role y" out of the argument list. Everything not recognised
// here is passed to the game untouched: the game has its own flags and they
// must not be swallowed on the way through.
function parseArgs(argv) {
  const opts = { name: '', role: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name' || argv[i] === '--role') opts[argv[i].slice(2)] = argv[++i] || '';
    else rest.push(argv[i]);
  }
  return { opts, rest };
}

// The bridge takes its port from the game's own command line, so read it from
// the same place rather than being told twice and risking disagreement.
function portOf(args) {
  const i = args.indexOf('-agentport');
  const n = i >= 0 ? parseInt(args[i + 1], 10) : NaN;
  return Number.isFinite(n) ? n : 17777;
}

async function main() {
  const { opts, rest } = parseArgs(process.argv.slice(2));
  const [exe, ...extra] = rest;
  if (!exe) die('usage: launcher.js <game exe> [--name <label>] [--role <role>] [extra args]');
  if (!fs.existsSync(exe)) die('not found: ' + exe);

  const exeDir = path.dirname(path.resolve(exe));
  const args = ['-agent', ...extra];
  const port = portOf(args);
  const name = opts.name || 'game';

  // One log per port, matching the bridge's own naming, so two games sharing a
  // directory never interleave their output into one file.
  logFile = instances.launcherLog(exeDir, port);
  try {
    fs.rmSync(logFile, { force: true });
  } catch (e) {
    /* an open handle on the old log is not worth failing over */
  }

  log(`launching ${path.basename(exe)} ${args.join(' ')} as ${name}`);

  let child;
  try {
    child = await startGame(path.resolve(exe), args, exeDir);
  } catch (e) {
    die('could not start the game: ' + e.message);
  }
  log(`pid ${child.pid}`);

  instances.register(exeDir, {
    name,
    port,
    pid: child.pid,
    role: opts.role || 'solo',
    args,
    launcher: process.pid,
  });

  const leave = () => {
    try {
      instances.unregister(exeDir, port);
    } catch (e) {
      /* a stale entry is pruned on the next read anyway */
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      leave();
      process.exit(0);
    });
  }

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

          // Read before clicking: once the box is gone, so is its text.
          const said = dialogText(w.hwnd);
          if (said.length === 0) said.push('(dialog had no readable text)');
          for (const line of said) log(`  ${spec.mark}| ${line}`);

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
  leave();
  process.exit(0);
}

main();
