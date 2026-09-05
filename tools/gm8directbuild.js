#!/usr/bin/env node
//=============================================================================
// gm8directbuild.js - build a GM8 project into an exe with no GUI at all.
//
// Game Maker 8 has no command-line compile: the IDE is the only thing that can
// produce an executable, so every published build process for a GM8 project -
// including the game's own build.bat - stops at a person choosing File > Create
// Executable. This closes that gap without a person and without a visible
// desktop: it launches Game Maker attached to a throwaway desktop that is never
// displayed anywhere, injects a small DLL that calls straight into the compiled
// routine behind that menu item (skipping the menu, and the Save dialog with
// it), and tears the whole thing down again. See tools/gm8directbuild/build.c
// for how that routine was found and what it does.
//
// Game Maker does not need to be told its window is hidden - CreateDesktop
// gives it a real desktop object with a real window station, so it starts up
// exactly as it would on the interactive one (its own IsWindowVisible even
// reports true). It just never gets composited to a monitor, because nothing
// ever makes that desktop the active one. This is why the win32.windows() /
// hasMenu() readiness check below works completely unchanged: the calling
// thread switches its own desktop with SetThreadDesktop, and FindWindowExW -
// which enumerates whatever desktop the calling thread is currently on -
// simply follows it there.
//
// The desktop is doing more than hiding the main window, which is why it is
// worth its ~20 lines rather than patching the executable to start invisible
// (which is possible - Game_Maker.exe is XtreamLok-wrapped, but the wrapper
// turns out not to checksum .text, measured 2026-08-21). Everything that
// actually threatens an unattended build is a *separate* window: a Delphi
// TErrorForm, a DFM streaming failure at startup, a message box from inside
// the build path. None of those care whether the main form is visible, and on
// a real desktop they would land in front of whoever is using the machine,
// take focus, and block the injected thread until it times out. A desktop
// nobody is looking at contains all of them for free.
//
// ⚠️ SetThreadDesktop is not free to leave behind: while this thread is on the
// hidden desktop it can see no other window on the machine, CloseDesktop
// refuses (ERROR_BUSY) while any thread is still assigned to it, and there is
// no "back to where I came from" unless the original handle was kept. Measured:
// 45 top-level windows visible, 0 after switching, 0 still after a CloseDesktop
// that returned false, 45 again only after switching back. So the original
// desktop is saved before the switch and restored in the finally, ahead of
// CloseDesktop - otherwise every later win32 window enumeration in this Node
// process (build-agent.js and launcher.js both do plenty) would quietly find
// nothing at all.
//
// Because it calls a hardcoded address, this only works against the one
// exact Game_Maker.exe build it was reverse-engineered against (sha256
// below) - a different build, even a same-version recompile, would have
// that address mean something else entirely. It refuses to run against
// anything else rather than guess, and build-agent.js falls back to opening
// the project for a person.
//
// Usage:
//   node tools/gm8directbuild.js <project.gmk> <output.exe> [options]
//
// Exit codes: 0 = the executable was produced, 1 = it was not.
//=============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const koffi = require('koffi');
const lib = require('./lib.js');
const win32 = require('./win32.js');

const USAGE = `
usage: node tools/gm8directbuild.js <project.gmk> <output.exe> [options]

  --gm8 <dir>      the Game Maker 8 install (default: auto-detect, or GM8_DIR)
  --timeout <n>    minutes to allow for the whole build (default 5)
`;

const IDE_IMAGE = 'Game_Maker.exe';
const MAIN_CLASS = 'TMainForm';

// Every window class a blocking modal can arrive as. `#32770` is the Win32
// standard dialog; the other two are Delphi's, and are what Game Maker itself
// actually uses - the same two launcher.js watches for on the game.
//
// ⚠️ `TMessageForm` was missing here until 2026-09-05, and the cost was a build
// that hung for eighteen minutes saying nothing useful. GM8 asked *"detected 190
// old temp folders left over from earlier runs - remove these?"* before it would
// load anything; the readiness check timed out after 180s with a bare "timed out
// waiting for the project to finish loading", describeDialogs found no `#32770`
// and so added nothing, and build-agent.js then fell back to opening the IDE for
// a person and waited out another --wait. Nothing anywhere named the dialog.
const DIALOG_CLASSES = ['#32770', 'TMessageForm', 'TErrorForm'];

const POLL_MS = 400;

// How long a dialog must stay up before the build gives up on it. GM8 flashes
// windows of its own while loading, so one sighting is not enough; three polls
// of the same title is a modal that is waiting for somebody.
const DIALOG_SETTLE_POLLS = 3;

// Game_Maker.exe 8.0.0.0 as installed by this repo's setup - the only build
// the addresses in gm8directbuild/build.c were reverse-engineered against.
const KNOWN_GM8_SHA256 = 'f3db12d340afb849efce8d0ae2cac941e10971a13227db763d3537f8d1814109';

const DLL_PATH = path.join(__dirname, 'gm8directbuild', 'build.dll');
const INJECTOR_PATH = path.join(__dirname, 'gm8directbuild', 'inject32.exe');

//---------------------------------------------------------------------------
// Win32: just enough to run a process on a desktop nobody displays.
// win32.js already covers everything needed to poll that process's windows
// once the calling thread has switched onto the same desktop (see the header
// comment above) - this only adds what creates and tears down the desktop.
//---------------------------------------------------------------------------

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const CreateDesktopW = user32.func('void* __stdcall CreateDesktopW(str16, void*, void*, uint32, uint32, void*)');
const CloseDesktop = user32.func('bool __stdcall CloseDesktop(void*)');
const SetThreadDesktop = user32.func('bool __stdcall SetThreadDesktop(void*)');
const GetThreadDesktop = user32.func('void* __stdcall GetThreadDesktop(uint32)');
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');

const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'str16',
  lpDesktop: 'str16',
  lpTitle: 'str16',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: 'void*',
  hStdInput: 'void*',
  hStdOutput: 'void*',
  hStdError: 'void*',
});
const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: 'void*',
  hThread: 'void*',
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
});
const CreateProcessW = kernel32.func(
  'bool __stdcall CreateProcessW(str16, str16, void*, void*, bool, uint32, void*, str16, ' +
    '_Inout_ STARTUPINFOW *, _Out_ PROCESS_INFORMATION *)'
);
const TerminateProcess = kernel32.func('bool __stdcall TerminateProcess(void*, uint32)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void*)');

const GENERIC_ALL = 0x10000000;

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

function verifyKnownBuild(idePath) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(idePath)).digest('hex');
  if (digest !== KNOWN_GM8_SHA256) {
    throw new Error(
      `${idePath} does not match the Game Maker build gm8directbuild/build.c was reverse-engineered ` +
        `against (expected sha256 ${KNOWN_GM8_SHA256}, got ${digest}) - the hardcoded call address is ` +
        `only valid for that exact executable. Build by hand (build-agent.js --manual), or re-derive ` +
        `the address for this build.`
    );
  }
}

//---------------------------------------------------------------------------
// Waiting for windows
//---------------------------------------------------------------------------

async function until(test, timeoutMs, what) {
  const stop = Date.now() + timeoutMs;
  for (;;) {
    const got = test();
    if (got) return got;
    if (Date.now() > stop) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
    await lib.sleep(POLL_MS);
  }
}

const mainWindow = (pid) => win32.windows({ cls: MAIN_CLASS, pid })[0] || null;

const dialogWindows = (pid) => DIALOG_CLASSES.flatMap((cls) => win32.windows({ cls, pid }));

// Everything one dialog of this process is saying. Nothing here answers a
// dialog - on a desktop nobody can see, one that appears is a dead end by
// definition, so the only useful thing to do with it is say what it was. This
// is how a wrong-looking install reports itself as, say, "Application Error /
// Exception EReadError in module Game_Maker.exe..." rather than a bare timeout.
//
// ⚠️ A Delphi TMessageForm paints its message with no window handle, so
// controlText finds nothing but the buttons - the 2026-09-05 temp-folder prompt
// came back as exactly `&Yes`/`&No` and not one word of the question. The
// buttons are therefore reported rather than filtered out, since on that class
// they are the only structured thing there is, and `shotDir` asks for a
// screenshot as well: PrintWindow captures what was painted, which is the only
// way the text is recoverable at all. Same trick, same reason, as launcher.js.
function describeDialog(d, shotDir) {
  const parts = win32.descendants(d.hwnd);
  const body = parts
    .filter((k) => !/button/i.test(k.cls))
    .map((k) => (win32.controlText(k.hwnd) || k.text || '').trim())
    .filter(Boolean)
    .join(' / ');
  const buttons = parts
    .filter((k) => /button/i.test(k.cls))
    .map((k) => (win32.controlText(k.hwnd) || k.text || '').trim().replace(/&/g, ''))
    .filter(Boolean);

  let said = [`[${d.cls}] ${d.title || '(no title)'}`, body].filter(Boolean).join(': ');
  if (!body && buttons.length) said += ` (buttons: ${buttons.join(', ')} - the message itself is painted, not a control)`;

  if (shotDir) {
    try {
      const bmp = win32.captureWindow(d.hwnd);
      if (bmp) {
        const shot = path.join(shotDir, `gm8-dialog-${Date.now()}.bmp`);
        fs.writeFileSync(shot, bmp);
        said += ` (screenshot: ${shot})`;
      }
    } catch (e) {
      said += ` (could not screenshot it: ${e.message})`;
    }
  }
  return said;
}

function describeDialogs(pid, shotDir) {
  return dialogWindows(pid)
    .map((d) => describeDialog(d, shotDir))
    .filter(Boolean)
    .join(' | ');
}

// Thrown when a modal is sitting in front of the IDE. Its own class, because
// the caller has to tell "Game Maker is waiting for an answer nobody can give"
// (retrying is pointless, and so is the manual fallback - the same dialog will
// be there) from "this took too long".
class BlockedByDialog extends Error {}

// Give up the moment a modal has settled, rather than at the timeout.
//
// This is the difference between an 18-minute silence and a named failure. A
// dialog on a desktop nobody displays can never be answered, so every second
// spent waiting for it is wasted, and the timeout that eventually arrives says
// only that time passed. Checked on the same poll as the readiness test, so it
// costs nothing extra.
// The settling rule on its own, with no Win32 in it, so it can be checked
// without a Game Maker to put a dialog up. `seen` is the caller's carry between
// polls. Returns the window once the same one has been there long enough to be
// a modal rather than something GM8 flashed while loading.
function settle(found, seen) {
  if (found.length === 0) {
    seen.title = null;
    seen.count = 0;
    return null;
  }
  const d = found[0];
  const key = `${d.cls} ${d.title}`;
  seen.count = key === seen.title ? seen.count + 1 : 1;
  seen.title = key;
  return seen.count >= DIALOG_SETTLE_POLLS ? d : null;
}

function blockingDialog(pid, seen, shotDir) {
  const d = settle(dialogWindows(pid), seen);
  if (!d) return null;
  return new BlockedByDialog(
    `Game Maker is waiting on a dialog and cannot be answered - it is on a desktop nothing displays. ` +
      `It says: ${describeDialog(d, shotDir)}`
  );
}

// A Delphi main form exists long before it is usable. It is loaded once it
// has a menu bar and its title - which carries the project name - has stopped
// changing.
async function waitForProjectLoaded(pid, timeoutMs, shotDir) {
  let lastTitle = null;
  let stable = 0;
  const seen = { title: null, count: 0 };
  try {
    return await until(
      () => {
        const blocked = blockingDialog(pid, seen, shotDir);
        if (blocked) throw blocked;

        const w = mainWindow(pid);
        if (!w || !win32.hasMenu(w.hwnd)) {
          stable = 0;
          return null;
        }
        stable = w.title === lastTitle ? stable + 1 : 0;
        lastTitle = w.title;
        return stable >= Math.ceil(2000 / POLL_MS) ? w : null;
      },
      timeoutMs,
      'the project to finish loading'
    );
  } catch (e) {
    if (e instanceof BlockedByDialog) throw e;
    const said = describeDialogs(pid, shotDir);
    if (said) e.message += ` - Game Maker is showing: ${said}`;
    throw e;
  }
}

//---------------------------------------------------------------------------
// The build
//---------------------------------------------------------------------------

async function buildExe({ gmk, exe, gm8 = null, timeoutMinutes = 5, log = lib.detail, shotDir = null }) {
  const ide = find(gm8);
  if (!ide) throw new Error('Game Maker 8 not found - pass --gm8 <dir> or set GM8_DIR');
  verifyKnownBuild(ide);
  if (!fs.existsSync(gmk)) throw new Error(`project not found: ${gmk}`);
  if (lib.isRunning(IDE_IMAGE)) {
    throw new Error(`${IDE_IMAGE} is already running - close it first`);
  }

  // "The file appeared" is the completion signal, so there must not be one to
  // begin with.
  if (fs.existsSync(exe)) fs.rmSync(exe, { force: true });

  // Where a screenshot of a blocking dialog goes. Beside the output by default,
  // so it is next to the build it explains rather than in a temp directory.
  const shots = shotDir || path.dirname(path.resolve(exe));

  const budget = timeoutMinutes * 60 * 1000;
  const started = Date.now();
  const left = () => Math.max(5000, budget - (Date.now() - started));

  const deskName = `gm8directbuild_${process.pid}_${Date.now()}`;
  const hDesktop = CreateDesktopW(deskName, null, null, 0, GENERIC_ALL, null);
  if (!hDesktop) throw new Error('CreateDesktop failed - could not create a hidden desktop to run Game Maker on');

  // GetThreadDesktop hands back a borrowed handle - it must be restored but
  // never closed.
  const priorDesktop = GetThreadDesktop(GetCurrentThreadId());
  let switched = false;
  let pi = null;
  try {
    log(`launching ${path.basename(ide)} with ${path.basename(gmk)} on a hidden desktop`);
    // lpDesktop takes "winsta\desktop" or, as here, a bare desktop name
    // meaning "that desktop on the window station this process already has" -
    // which is the one CreateDesktopW just created it on, whatever it is
    // called. Naming WinSta0 outright would be wrong for anything not running
    // in an interactive session.
    const si = { cb: koffi.sizeof(STARTUPINFOW), lpDesktop: deskName };
    pi = {};
    const launched = CreateProcessW(null, `"${ide}" "${gmk}"`, null, null, false, 0, null, path.dirname(gmk), si, pi);
    if (!launched) throw new Error('CreateProcess failed to launch Game Maker');

    // Everything win32.js already knows how to ask a window (does it have a
    // menu, what is its title) works unchanged once this thread is looking at
    // the same desktop Game Maker is actually on.
    if (!SetThreadDesktop(hDesktop)) throw new Error('SetThreadDesktop failed');
    switched = true;

    const main = await waitForProjectLoaded(pi.dwProcessId, Math.min(left(), 180000), shots);
    log(`loaded: ${main.title}`);

    const logPath = path.join(os.tmpdir(), `gm8directbuild_${pi.dwProcessId}.log`);
    if (fs.existsSync(logPath)) fs.rmSync(logPath, { force: true });

    log('injecting and building');
    await lib.run(INJECTOR_PATH, [String(pi.dwProcessId), DLL_PATH, exe, logPath], process.cwd());

    const buildLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim() : null;
    if (buildLog) for (const line of buildLog.split(/\r?\n/)) log(`  ${line}`);
    if (fs.existsSync(logPath)) fs.rmSync(logPath, { force: true });

    if (!fs.existsSync(exe)) {
      const said = describeDialogs(pi.dwProcessId, shots);
      throw new Error(
        `no executable appeared at ${exe} after injection` +
          (buildLog ? ` (log: ${buildLog})` : '') +
          (said ? ` - Game Maker is showing: ${said}` : '')
      );
    }
    log(`built ${exe} (${fs.statSync(exe).size} bytes)`);
  } finally {
    // The process exists only for the duration of this one build - there is
    // no IDE left running to hand back to a person, and nothing on the hidden
    // desktop could be handed to one anyway.
    if (pi && pi.hProcess) {
      TerminateProcess(pi.hProcess, 0);
      CloseHandle(pi.hProcess);
      CloseHandle(pi.hThread);
    }
    // Order matters: CloseDesktop fails with ERROR_BUSY while this thread is
    // still assigned to the desktop, and the thread would be left unable to
    // see any window on the machine. See the header.
    let restored = true;
    if (switched && !SetThreadDesktop(priorDesktop)) {
      restored = false;
      log('warning: could not switch back off the hidden desktop - window lookups in this process will fail');
    }
    if (restored && !CloseDesktop(hDesktop)) {
      log('warning: the hidden desktop could not be closed and will leak until this process exits');
    }
  }

  return { pid: pi.dwProcessId, exe };
}

if (require.main === module) {
  const { flags, positional } = lib.parseArgs(process.argv.slice(2), ['gm8', 'timeout']);
  if (flags.help || positional.length < 2) lib.helpAndExit(USAGE);
  lib.cli(async () => {
    await buildExe({
      gmk: path.resolve(positional[0]),
      exe: path.resolve(positional[1]),
      gm8: flags.gm8 || null,
      timeoutMinutes: flags.timeout ? Number(flags.timeout) : 5,
      log: (m) => lib.detail(m),
    });
    lib.ok('built');
  });
}

module.exports = {
  buildExe, find, verifyKnownBuild,
  BlockedByDialog, settle, DIALOG_CLASSES, DIALOG_SETTLE_POLLS,
  IDE_IMAGE, KNOWN_GM8_SHA256,
};
