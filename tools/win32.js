//=============================================================================
// win32.js - the small slice of user32 the launcher needs.
//
// Enough to find a window by class and process, read its title, and click a
// button inside it. That is all the automation left in this repo now that the
// IDE build is manual - it exists because GM8 answers a runtime error with a
// modal dialog that freezes the game and every pending bridge call, and only a
// click from outside can clear it.
//
// Everything here posts rather than sends. PostMessageW returns immediately;
// SendMessageW would block until the target's message loop answers, and the
// windows this deals with are, by definition, the ones that stop answering.
//
// Top-level windows are walked with FindWindowExW(NULL, prev, ...), which needs
// no callback into JS - a nice simplification over EnumWindows.
//=============================================================================

const koffi = require('koffi');
const { execSync } = require('child_process');

const user32 = koffi.load('user32.dll');

const FindWindowExW = user32.func('void* __stdcall FindWindowExW(void*, void*, void*, void*)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void*, void*, int)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void*, void*, int)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void*, void*)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void*)');
// wParam and lParam are integers here rather than pointers: every message this
// module sends carries a command id or nothing at all, and the one that needs a
// buffer (WM_SETTEXT) goes through SendMessageTimeoutW instead.
const PostMessageW = user32.func('bool __stdcall PostMessageW(void*, uint32, size_t, size_t)');
const SendMessageTimeoutW = user32.func(
  'void* __stdcall SendMessageTimeoutW(void*, uint32, size_t, void*, uint32, uint32, void*)'
);
const GetMenu = user32.func('void* __stdcall GetMenu(void*)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void*, void*)');
const GetDC = user32.func('void* __stdcall GetDC(void*)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(void*, void*)');
const PrintWindow = user32.func('bool __stdcall PrintWindow(void*, void*, uint32)');

const gdi32 = koffi.load('gdi32.dll');
const CreateCompatibleDC = gdi32.func('void* __stdcall CreateCompatibleDC(void*)');
const CreateCompatibleBitmap = gdi32.func('void* __stdcall CreateCompatibleBitmap(void*, int, int)');
const SelectObject = gdi32.func('void* __stdcall SelectObject(void*, void*)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(void*)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void*)');
const GetDIBits = gdi32.func('int __stdcall GetDIBits(void*, void*, uint32, uint32, void*, void*, uint32)');

const kernel32 = koffi.load('kernel32.dll');
const GetCurrentProcessId = kernel32.func('uint32 __stdcall GetCurrentProcessId()');
const ProcessIdToSessionId = kernel32.func('bool __stdcall ProcessIdToSessionId(uint32, void*)');

const BM_CLICK = 0x00f5;
const WM_GETTEXT = 0x000d;
const WM_SETTEXT = 0x000c;
const WM_COMMAND = 0x0111;
const WM_CLOSE = 0x0010;
const SMTO_ABORTIFHUNG = 0x0002;
const SM_REMOTESESSION = 0x1000;

// A UTF-16 buffer, read back as far as the API says it wrote.
function readWide(fn, hwnd, max = 256) {
  const buf = Buffer.alloc(max * 2);
  const n = fn(hwnd, buf, max);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

const classOf = (hwnd) => readWide(GetClassNameW, hwnd);
const titleOf = (hwnd) => readWide(GetWindowTextW, hwnd);

function pidOf(hwnd) {
  const buf = Buffer.alloc(4);
  GetWindowThreadProcessId(hwnd, buf);
  return buf.readUInt32LE(0);
}

// Every visible top-level window, optionally filtered by class and owning pid.
function windows({ cls = null, pid = null } = {}) {
  const found = [];
  let hwnd = null;
  for (;;) {
    hwnd = FindWindowExW(null, hwnd, null, null);
    if (!hwnd) break;
    if (!IsWindowVisible(hwnd)) continue;
    const c = classOf(hwnd);
    if (cls !== null && c !== cls) continue;
    const p = pidOf(hwnd);
    if (pid !== null && p !== pid) continue;
    found.push({ hwnd, cls: c, title: titleOf(hwnd), pid: p });
  }
  return found;
}

// Direct children of a window, with their class and caption.
function children(parent) {
  const found = [];
  let hwnd = null;
  for (;;) {
    hwnd = FindWindowExW(parent, hwnd, null, null);
    if (!hwnd) break;
    found.push({ hwnd, cls: classOf(hwnd), text: titleOf(hwnd) });
  }
  return found;
}

// GetWindowText only returns a caption, and only ever an empty string for a
// control living in another process - the content of an edit box has to be
// asked for with WM_GETTEXT. Time-limited, because the windows this reads from
// belong to a game that has just stopped responding.
function controlText(hwnd, max = 4096, timeoutMs = 500) {
  const buf = Buffer.alloc(max * 2);
  const result = Buffer.alloc(8);
  const sent = SendMessageTimeoutW(hwnd, WM_GETTEXT, max, buf, SMTO_ABORTIFHUNG, timeoutMs, result);
  if (!sent) return '';
  const chars = Number(result.readBigUInt64LE(0));
  return chars > 0 ? buf.toString('utf16le', 0, Math.min(chars, max) * 2) : '';
}

// Setting a control's text is the other half of controlText, and the only
// message here that carries a pointer: the file dialog's edit box is filled
// this way rather than by typing into it, which needs no focus and cannot be
// mistimed.
function setControlText(hwnd, text, timeoutMs = 2000) {
  const buf = Buffer.from(String(text) + '\0', 'utf16le');
  const result = Buffer.alloc(8);
  return !!SendMessageTimeoutW(hwnd, WM_SETTEXT, 0, buf, SMTO_ABORTIFHUNG, timeoutMs, result);
}

// Every window beneath this one, not just its direct children. Dialogs nest -
// the file name box in a save dialog lives inside a combo box inside a band -
// so anything looking for a control by class has to go all the way down.
function descendants(parent, depth = 0) {
  const found = [];
  if (depth > 6) return found;
  for (const k of children(parent)) {
    found.push(k);
    found.push(...descendants(k.hwnd, depth + 1));
  }
  return found;
}

const clickButton = (hwnd) => PostMessageW(hwnd, BM_CLICK, 0, 0);

// Invoke a menu command by id. GM8 owner-draws its menus, so GetMenuString
// reports nothing and an item cannot be found by name - the id has to be known,
// and whatever it opens has to be checked before anything is typed into it.
const postCommand = (hwnd, id) => PostMessageW(hwnd, WM_COMMAND, id, 0);

const closeWindow = (hwnd) => PostMessageW(hwnd, WM_CLOSE, 0, 0);

// Whether a window has a menu bar - which, for a Delphi main form, is a decent
// proxy for "finished starting up".
const hasMenu = (hwnd) => !!GetMenu(hwnd);

// Whether this process is running in a Remote Desktop session. GM8 loads its
// sound resources into DirectSound during engine startup, before any game
// code runs, and an RDP session with no audio redirection has no endpoint for
// that - two modal errors and a silent exit, which from here just looks like
// the bridge never came up. This is one deterministic check for the single
// most common reason for that.
const isRemoteSession = () => !!GetSystemMetrics(SM_REMOTESESSION);

// The Windows session this process is running in ("Active", "Disc", "Conn", ...),
// via `query session` rather than WTSQuerySessionInformationW - the latter hands
// back an allocated buffer keyed off a pointer-to-pointer out param, which koffi
// has no ergonomic way to read; parsing the console tool's own table is a few
// lines and needs no new native surface. Matches by session id (from
// ProcessIdToSessionId) rather than position, since SESSIONNAME is blank for a
// disconnected RDP session and shifts every later column left. Returns null if
// the check itself fails - a disconnected session is a diagnosis to attempt, not
// one to depend on.
function sessionState() {
  const idBuf = Buffer.alloc(4);
  if (!ProcessIdToSessionId(GetCurrentProcessId(), idBuf)) return null;
  const sessionId = idBuf.readUInt32LE(0);

  let out;
  try {
    out = execSync('query session', { windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString();
  } catch (e) {
    out = e.stdout ? e.stdout.toString() : '';
  }
  if (!out) return null;

  for (const line of out.split(/\r?\n/)) {
    const tokens = line.trim().replace(/^>/, '').trim().split(/\s+/);
    const idIndex = tokens.findIndex((t) => /^\d+$/.test(t) && Number(t) === sessionId);
    if (idIndex >= 0 && tokens[idIndex + 1]) return tokens[idIndex + 1];
  }
  return null;
}

const PW_RENDERFULLCONTENT = 0x00000002;

// A window's pixels as a BMP buffer, for the dialogs `controlText` cannot read -
// Delphi paints some captions with no window handle, so the text is gone but the
// pixels are not. GetWindowRect sizes a compatible bitmap, PrintWindow renders
// the target into it (falling back to the plain flag for a window that ignores
// PW_RENDERFULLCONTENT), and GetDIBits reads it back top-down as 32bpp BI_RGB so
// it can be wrapped in a plain BMP file header with no palette to worry about.
// Returns null rather than throwing - this is always a best-effort addition to
// a diagnosis that already has a text fallback.
function captureWindow(hwnd) {
  const rect = Buffer.alloc(16);
  if (!GetWindowRect(hwnd, rect)) return null;
  const width = rect.readInt32LE(8) - rect.readInt32LE(0);
  const height = rect.readInt32LE(12) - rect.readInt32LE(4);
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return null;

  const screenDC = GetDC(null);
  if (!screenDC) return null;
  const memDC = CreateCompatibleDC(screenDC);
  const bmp = CreateCompatibleBitmap(screenDC, width, height);
  const old = SelectObject(memDC, bmp);
  try {
    if (!PrintWindow(hwnd, memDC, PW_RENDERFULLCONTENT)) PrintWindow(hwnd, memDC, 0);

    const headerSize = 40;
    const info = Buffer.alloc(headerSize);
    info.writeInt32LE(headerSize, 0);
    info.writeInt32LE(width, 4);
    info.writeInt32LE(-height, 8); // negative height = top-down rows
    info.writeInt16LE(1, 12); // biPlanes
    info.writeInt16LE(32, 14); // biBitCount
    info.writeInt32LE(0, 16); // BI_RGB

    const pixels = Buffer.alloc(width * 4 * height);
    if (!GetDIBits(memDC, bmp, 0, height, pixels, info, 0)) return null;

    const fileHeader = Buffer.alloc(14);
    fileHeader.write('BM', 0, 'ascii');
    fileHeader.writeUInt32LE(fileHeader.length + info.length + pixels.length, 2);
    fileHeader.writeUInt32LE(fileHeader.length + info.length, 10);
    return Buffer.concat([fileHeader, info, pixels]);
  } finally {
    SelectObject(memDC, old);
    DeleteObject(bmp);
    DeleteDC(memDC);
    ReleaseDC(null, screenDC);
  }
}

module.exports = {
  windows, children, descendants,
  controlText, setControlText,
  clickButton, postCommand, closeWindow, hasMenu,
  classOf, titleOf, pidOf,
  isRemoteSession, sessionState,
  captureWindow,
};

if (require.main === module) {
  const pid = process.argv[2] ? Number(process.argv[2]) : null;
  for (const w of windows({ pid })) {
    console.log(`pid ${String(w.pid).padStart(6)}  ${w.cls.padEnd(28)}  ${w.title}`);
  }
}
