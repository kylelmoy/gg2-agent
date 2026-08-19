//=============================================================================
// gmlerror.js - turn a Game Maker 8 error dialog into a file and a line number.
//
// GM8 reports a runtime error like this:
//
//   ERROR in
//   action number 1
//   of  Step Event
//   for object AgentBridge:
//
//   Error in code at line 1:
//      return global.aTypoNobodyDefined
//                    ^
//   at position 15: Unknown variable aTypoNobodyDefined
//
// which names the object and the event but not the file, and gives a line
// number counted from the start of that one piece of code rather than from the
// start of anything on disk. The launcher writes that text to its log, and an
// agent then has to guess where to look.
//
// This resolves it. The object and event name a file; the action number picks
// the code action inside it; and the offending source line, which the dialog
// quotes verbatim, both confirms the answer and rescues the cases where the
// event naming does not match - if that line appears exactly once in the tree,
// that is where the error is, whatever the header said.
//=============================================================================

const fs = require('fs');
const path = require('path');

//---------------------------------------------------------------------------
// Parsing the dialog text
//---------------------------------------------------------------------------

function parse(text) {
  const lines = String(text).split(/\r?\n/);
  const err = { object: null, script: null, event: null, action: 1, line: null, code: null, message: null };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();

    let m = /^for object (.+?):?$/.exec(l);
    if (m) err.object = m[1].replace(/:$/, '');

    m = /^in script (.+?):?$/.exec(l);
    if (m) err.script = m[1].replace(/:$/, '');

    m = /^action number (\d+)/.exec(l);
    if (m) err.action = parseInt(m[1], 10);

    m = /^of\s+(.+)$/.exec(l);
    if (m && /event/i.test(m[1])) err.event = m[1].trim();

    m = /^Error in code at line (\d+)/.exec(l);
    if (m) {
      err.line = parseInt(m[1], 10);
      // The next line is the offending source, indented; the one after it is
      // the caret pointing into it.
      if (lines[i + 1] !== undefined && !/^\s*\^\s*$/.test(lines[i + 1])) err.code = lines[i + 1].trim();
    }

    m = /^at position \d+: (.+)$/.exec(l);
    if (m) err.message = m[1];
  }

  if (!err.message) {
    const last = lines.map((l) => l.trim()).filter(Boolean).pop();
    if (last && !/^\^+$/.test(last)) err.message = last;
  }
  return err.object || err.script || err.line ? err : null;
}

//---------------------------------------------------------------------------
// Event name -> the file GmkSplitter writes it to
//---------------------------------------------------------------------------

const SIMPLE = {
  create: 'Create',
  destroy: 'Destroy',
  step: 'Step',
  'begin step': 'Begin Step',
  'end step': 'End Step',
  draw: 'Draw',
  'room start': 'Room Start',
  'room end': 'Room End',
  'game start': 'Game Start',
  'game end': 'Game End',
  'animation end': 'Animation end',
  'no more lives': 'No More Lives',
  'no more health': 'No More Health',
};

// "of  Step Event", "of Alarm Event for alarm 3", "of Collision Event with
// object Rocket", "of Other Event: User Defined 8".
function eventFile(desc) {
  if (!desc) return null;
  const d = desc.replace(/\s+/g, ' ').trim();

  let m = /alarm (?:event )?(?:for alarm )?(\d+)/i.exec(d);
  if (m) return 'Alarm ' + m[1];

  m = /collision event with (?:object )?(\S+)/i.exec(d);
  if (m) return 'Collision with ' + m[1].replace(/:$/, '');

  m = /user defined (\d+)/i.exec(d);
  if (m) return 'User Event ' + m[1];

  const name = d
    .replace(/^of\s+/i, '')
    .replace(/\s*event\b.*$/i, '')
    .trim()
    .toLowerCase();
  return SIMPLE[name] || null;
}

//---------------------------------------------------------------------------
// Finding the file
//---------------------------------------------------------------------------

function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const relative = (tree, p) => path.relative(tree, p).split(path.sep).join('/');

function findScript(tree, name) {
  return walk(path.join(tree, 'Scripts')).find((p) => path.basename(p) === name + '.gml') || null;
}

function findEventDir(tree, object) {
  return (
    walk(path.join(tree, 'Objects'))
      .map((p) => path.dirname(p))
      .find((d) => path.basename(d) === object + '.events') || null
  );
}

// The <argument kind="STRING"> elements of an event file, with the line each one
// starts on - which is what turns a line number counted from the start of a code
// action into a line number in the file.
function stringArguments(xml) {
  const out = [];
  const re = /<argument kind="STRING"[^>]*?(?:\/>|>([\s\S]*?)<\/argument>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const at = m.index + m[0].indexOf('>') + 1;
    out.push({ at, line: xml.slice(0, at).split(/\r?\n/).length, text: m[1] === undefined ? '' : m[1] });
  }
  return out;
}

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, String.fromCharCode(39))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

// Every line of GML in the tree, so a quoted source line can be looked up when
// the header does not resolve. The tree is ~20,000 lines, so this is cheap, but
// it is cached anyway because errors arrive in bursts.
function indexLines(tree) {
  const index = new Map();
  const add = (text, file, base) => {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const key = lines[i].trim();
      if (key.length < 4) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ file, line: base + i });
    }
  };

  for (const p of walk(path.join(tree, 'Scripts'))) {
    if (p.endsWith('.gml')) add(fs.readFileSync(p, 'latin1'), relative(tree, p), 1);
  }
  for (const p of walk(path.join(tree, 'Objects'))) {
    if (!p.endsWith('.xml') || !path.basename(path.dirname(p)).endsWith('.events')) continue;
    const xml = fs.readFileSync(p, 'latin1');
    for (const arg of stringArguments(xml)) add(unescapeXml(arg.text), relative(tree, p), arg.line);
  }
  return index;
}

let cache = { tree: null, index: null, at: 0 };

function lineIndex(tree) {
  if (cache.tree === tree && Date.now() - cache.at < 30000) return cache.index;
  cache = { tree, index: indexLines(tree), at: Date.now() };
  return cache.index;
}

//---------------------------------------------------------------------------

// Resolve one parsed error to { file, line, how }, or null if it cannot be
// placed. `how` records which route found it, because a guess and a certainty
// should not read the same.
function place(err, tree) {
  if (!err) return null;

  // A script error names its script, and its line numbers are the file's own.
  if (err.script) {
    const file = findScript(tree, err.script);
    if (file) return { file: relative(tree, file), line: err.line || 1, how: 'script' };
  }

  if (err.object && err.line) {
    const dir = findEventDir(tree, err.object);
    if (dir) {
      const wanted = eventFile(err.event);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.xml'));
      const name = wanted && files.includes(wanted + '.xml') ? wanted + '.xml' : null;
      if (name) {
        const full = path.join(dir, name);
        const args = stringArguments(fs.readFileSync(full, 'latin1'));
        const arg = args[Math.max(0, err.action - 1)] || args[0];
        if (arg) return { file: relative(tree, full), line: arg.line + err.line - 1, how: 'event' };
      }
    }
  }

  // Nothing matched - or the object was AgentBridge, running a string that was
  // never in the tree at all. The line the dialog quoted is the last resort.
  if (err.code) {
    const hits = lineIndex(tree).get(err.code.trim()) || [];
    if (hits.length === 1) return Object.assign({}, hits[0], { how: 'source line' });
    if (hits.length > 1) return Object.assign({}, hits[0], { how: 'source line, ' + hits.length + ' matches' });
  }

  return null;
}

// Read a block of GM8 dialog text and work out where it happened. Returns null
// for text that is not an error at all.
function locate(text, tree) {
  const err = parse(text);
  if (!err) return null;
  const at = place(err, tree);
  return Object.assign({}, err, at || {}, { located: !!at });
}

// One line summarising an error, for a tool result.
function describe(text, tree) {
  const e = locate(text, tree);
  if (!e) return null;
  const where = e.located ? e.file + ':' + e.line : e.object ? 'object ' + e.object : 'unknown location';
  const guess = e.located && e.how !== 'script' && e.how !== 'event' ? ' (matched by ' + e.how + ')' : '';
  return where + ': ' + (e.message || 'error') + guess;
}

module.exports = { parse, locate, describe, eventFile, stringArguments };
