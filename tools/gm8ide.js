#!/usr/bin/env node
//=============================================================================
// gm8ide.js - drive the Game Maker 8 IDE to turn a .gmk into an .exe.
//
// This is the one step of the build that used to need a person. Game Maker 8
// has no command-line compile; the IDE is the only thing that can produce an
// executable, so every published build process for a GM8 project - including
// the game's own build.bat - stops at a human choosing File > Create
// Executable. This closes that gap with the same handful of user32 calls the
// launcher already uses to clear modal dialogs.
//
// Nothing here simulates a keystroke. Every step is a posted message:
//
//   WM_COMMAND 19   File > Create Executable
//   WM_SETTEXT      write the output path into the save dialog
//   BM_CLICK        Save, and any confirmation that follows
//   WM_CLOSE        shut the IDE down again
//
// which means no window has to be activated, nothing can be mistimed, and the
// desktop is not stolen from whoever is using it.
//
// The command id is hardcoded because it has to be: GM8 owner-draws its menu
// items, so GetMenuString returns nothing and every item looks like a
// separator. Firing a numeric command blind would be reckless, so the dialog it
// opens is checked by title before a single character is written into it - if
// GM8 ever renumbers its menu, this fails loudly instead of typing a path into
// whatever window happened to appear.
//
// It still needs an interactive desktop session. Unattended is not the same as
// headless: there is no way to run the GM8 IDE without a window station.
//
// Usage:
//   node tools/gm8ide.js <project.gmk> <output.exe> [--gm8 <dir>]
//
// Exit codes: 0 = the executable was produced, 1 = it was not.
//=============================================================================

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const lib = require('./lib.js');
const win32 = require('./win32.js');

const USAGE = `
usage: node tools/gm8ide.js <project.gmk> <output.exe> [options]

  --gm8 <dir>      the Game Maker 8 install (default: auto-detect, or GM8_DIR)
  --timeout <n>    minutes to allow for the whole build (default 12)
  --keep-open      leave the IDE running afterwards
`;

const IDE_IMAGE = 'Game_Maker.exe';
const MAIN_CLASS = 'TMainForm';
const DIALOG_CLASS = '#32770';

// File > Create Executable. See the header: this cannot be discovered by name.
const ID_CREATE_EXE = 19;

// The title GM8 gives the save dialog. Everything after the menu command is
// gated on this, so a wrong command id cannot become a wrong file written.
const SAVE_DIALOG_TITLE = /stand alone/i;

const POLL_MS = 400;

//---------------------------------------------------------------------------
// Finding Game Maker
//---------------------------------------------------------------------------

function find(dir) {
  const guesses = [
    dir,
    process.env.GM8_DIR,
    'D:\\GameDev\\Game_Maker_8',
    'C:\\Program Files (x86)\\Game_Maker_8',
    'C:\\Program Files\\Game_Maker_8',
  ].filter(Boolean);
  for (const g of guesses) {
    const exe = path.join(g, IDE_IMAGE);
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

//---------------------------------------------------------------------------
// Waiting for windows
//---------------------------------------------------------------------------

const deadlineIn = (ms) => Date.now() + ms;

async function until(test, timeoutMs, what) {
  const stop = deadlineIn(timeoutMs);
  for (;;) {
    const got = test();
    if (got) return got;
    if (Date.now() > stop) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
    await lib.sleep(POLL_MS);
  }
}

const mainWindow = (pid) => win32.windows({ cls: MAIN_CLASS, pid })[0] || null;
const dialogs = (pid) => win32.windows({ cls: DIALOG_CLASS, pid });

// A button by caption, with Windows' accelerator ampersand ignored.
function buttonNamed(hwnd, names) {
  const wanted = names.map((n) => n.toLowerCase());
  return (
    win32
      .descendants(hwnd)
      .filter((k) => k.cls === 'Button' || k.cls === 'TButton' || k.cls === 'TBitBtn')
      .find((b) => wanted.includes(b.text.replace(/&/g, '').trim().toLowerCase())) || null
  );
}

// Everything a dialog says, for reporting one we did not expect.
function dialogText(hwnd) {
  return win32
    .descendants(hwnd)
    .filter((k) => !/button/i.test(k.cls))
    .map((k) => (win32.controlText(k.hwnd) || k.text || '').trim())
    .filter(Boolean)
    .join(' / ');
}

//---------------------------------------------------------------------------
// The build
//---------------------------------------------------------------------------

async function buildExe({ gmk, exe, gm8 = null, timeoutMinutes = 12, keepOpen = false, log = lib.detail }) {
  const ide = find(gm8);
  if (!ide) throw new Error('Game Maker 8 not found - pass --gm8 <dir> or set GM8_DIR');
  if (!fs.existsSync(gmk)) throw new Error(`project not found: ${gmk}`);
  if (lib.isRunning(IDE_IMAGE)) {
    throw new Error(`${IDE_IMAGE} is already running - close it, since a second copy will not open the project`);
  }

  // "The file appeared" is the completion signal, so there must not be one to
  // begin with.
  if (fs.existsSync(exe)) fs.rmSync(exe, { force: true });

  const budget = timeoutMinutes * 60 * 1000;
  const started = Date.now();
  const left = () => Math.max(5000, budget - (Date.now() - started));

  log(`launching ${path.basename(ide)} with ${path.basename(gmk)}`);
  const child = spawn(ide, [gmk], { cwd: path.dirname(gmk), stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (e) => reject(new Error(`could not start ${ide}: ${e.message}`)));
  });

  try {
    // --- wait for the project to load ---------------------------------------
    // A Delphi main form exists long before it is usable. It is loaded once it
    // has a menu bar and its title - which carries the project name - has
    // stopped changing.
    let lastTitle = null;
    let stable = 0;
    const main = await until(
      () => {
        const w = mainWindow(child.pid);
        if (!w || !win32.hasMenu(w.hwnd)) {
          stable = 0;
          return null;
        }
        stable = w.title === lastTitle ? stable + 1 : 0;
        lastTitle = w.title;
        return stable >= Math.ceil(2000 / POLL_MS) ? w : null;
      },
      Math.min(left(), 180000),
      'the project to finish loading'
    );
    log(`loaded: ${main.title}`);

    // --- File > Create Executable -------------------------------------------
    win32.postCommand(main.hwnd, ID_CREATE_EXE);

    const save = await until(
      () => dialogs(child.pid).find((d) => d.title),
      Math.min(left(), 60000),
      'the save dialog'
    );
    if (!SAVE_DIALOG_TITLE.test(save.title)) {
      throw new Error(
        `expected the "file name for stand alone game" dialog and got "${save.title}" - ` +
          `menu command ${ID_CREATE_EXE} is no longer Create Executable in this Game Maker build`
      );
    }
    log(`dialog: ${save.title}`);

    // --- write the destination and save --------------------------------------
    const edit = win32.descendants(save.hwnd).find((k) => k.cls === 'Edit');
    if (!edit) throw new Error('the save dialog has no edit control to put a file name in');

    win32.setControlText(edit.hwnd, exe);
    const readBack = win32.controlText(edit.hwnd).trim();
    if (readBack !== exe) {
      throw new Error(`the save dialog kept "${readBack}" rather than "${exe}"`);
    }

    const saveButton = buttonNamed(save.hwnd, ['save', 'ok', '&save']);
    if (saveButton) win32.clickButton(saveButton.hwnd);
    else win32.postCommand(save.hwnd, 1); // IDOK, if the button was renamed
    log('compiling');

    // --- wait for the executable ---------------------------------------------
    // Two things can happen while this runs: a confirmation to overwrite, which
    // is answered, and a GM8 error box, which is fatal and must not be answered
    // away silently.
    let lastSize = -1;
    let held = 0;
    await until(
      () => {
        for (const d of dialogs(child.pid)) {
          if (/error/i.test(d.title)) throw new Error(`Game Maker reported an error: ${d.title} - ${dialogText(d.hwnd)}`);
          const yes = buttonNamed(d.hwnd, ['yes']);
          if (yes) win32.clickButton(yes.hwnd);
        }

        if (!fs.existsSync(exe)) return false;
        const size = fs.statSync(exe).size;
        if (size > 0 && size === lastSize) held++;
        else held = 0;
        lastSize = size;
        return held >= Math.ceil(3000 / POLL_MS);
      },
      left(),
      'the executable to appear and stop growing'
    );

    log(`built ${exe} (${fs.statSync(exe).size} bytes)`);
  } catch (e) {
    // Deliberately leave the IDE running. Whatever went wrong, the project is
    // open and loaded, so a person can finish with File > Create Executable
    // rather than waiting through another two-minute load.
    e.ideOpen = true;
    e.pid = child.pid;
    throw e;
  }

  if (!keepOpen) await close(child, log);
  return { pid: child.pid, exe };
}

// Shut the IDE down, declining the "save changes?" prompt. A build leaves the
// project dirty even when nothing was edited, so that prompt is expected.
async function close(child, log = lib.detail) {
  const stop = deadlineIn(20000);
  let asked = false;

  while (Date.now() < stop) {
    const main = mainWindow(child.pid);
    if (main && !asked) {
      win32.closeWindow(main.hwnd);
      asked = true;
    }
    for (const d of dialogs(child.pid)) {
      const no = buttonNamed(d.hwnd, ['no', "don't save"]);
      if (no) win32.clickButton(no.hwnd);
    }
    if (child.exitCode !== null || !mainWindow(child.pid)) break;
    await lib.sleep(POLL_MS);
  }

  // It has had its chance to leave politely.
  if (lib.isRunning(IDE_IMAGE)) {
    spawnSync('taskkill', ['/F', '/PID', String(child.pid)], { windowsHide: true });
    log('closed Game Maker (forced)');
  } else {
    log('closed Game Maker');
  }
}

if (require.main === module) {
  const { flags, positional } = lib.parseArgs(process.argv.slice(2), ['gm8', 'timeout']);
  if (flags.help || positional.length < 2) lib.helpAndExit(USAGE);
  lib.cli(async () => {
    await buildExe({
      gmk: path.resolve(positional[0]),
      exe: path.resolve(positional[1]),
      gm8: flags.gm8 || null,
      timeoutMinutes: flags.timeout ? Number(flags.timeout) : 12,
      keepOpen: !!flags['keep-open'],
      log: (m) => lib.detail(m),
    });
    lib.ok('built');
  });
}

module.exports = { buildExe, find, IDE_IMAGE, ID_CREATE_EXE };
