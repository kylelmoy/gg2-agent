#!/usr/bin/env node
//=============================================================================
// events.js - read, write and search the GML that lives inside object events.
//
// Scripts are plain .gml files and behave the way an agent expects. Object
// event code does not: it lives inside XML, in a <argument kind="STRING">
// element, XML-escaped -
//
//     <argument kind="STRING">if (dist &lt; closestDist)</argument>
//
// which makes it invisible to grep, and dangerous to edit with a text tool,
// because one bare < or & invalidates the file and GmkSplitter then refuses the
// whole tree rather than that one object.
//
// So both halves are here. Reading hands back real GML; writing escapes it,
// lints it first, and leaves every byte of the surrounding file alone. Searching
// covers scripts and events together, and reports a line number in the file as
// it exists on disk, which is the number an editor will jump to.
//
// Objects are resolved against the payload as well as the game, so the bridge's
// own AgentSpare objects are editable exactly like anything else - and edits to
// them land in the payload, which is where they survive a cleanup.
//
// Usage:
//   node tools/events.js list <object>
//   node tools/events.js read <object> <event> [index]
//   node tools/events.js find <regex>
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const lint = require('./gml-lint.js');

const USAGE = `
usage: node tools/events.js <list|read|find> [...]

  list <object>                  the events an object has, and their code actions
  read <object> <event> [index]  print one action's GML
  find <regex>                   search scripts and event code together

  --repo <path>   the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
  --tree          search only the game, not the bridge payload
`;

const PAYLOAD = path.resolve(__dirname, '..', 'payload');

//---------------------------------------------------------------------------
// XML text, escaped exactly as GmkSplitter writes it
//
// Three characters and no more: the tree uses &amp;, &lt; and &gt; and nothing
// else, and adding &quot; or numeric entities would make every file this
// touches differ from every file it does not.
//---------------------------------------------------------------------------

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, String.fromCharCode(39))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

// Every code action in an event file: where its text starts and ends in the
// XML, which line that is, and the GML itself. The span is what makes a write
// surgical - everything outside it is copied back untouched.
function codeActions(xml) {
  const out = [];
  const re = /<argument kind="STRING"[^>]*?(?:\/>|>([\s\S]*?)<\/argument>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const selfClosing = m[1] === undefined;
    const start = selfClosing ? m.index : m.index + m[0].indexOf('>') + 1;
    const end = selfClosing ? m.index + m[0].length : start + m[1].length;
    out.push({
      index: out.length,
      start,
      end,
      selfClosing,
      line: xml.slice(0, start).split(/\r?\n/).length,
      gml: selfClosing ? '' : unescapeXml(m[1]),
    });
  }
  return out;
}

//---------------------------------------------------------------------------
// Finding things on disk
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

// Where to look, and what to call what is found. The payload comes first: while
// the bridge is injected its files exist in both places, and the copy in the
// game tree is the one cleanup.js deletes.
function roots(repo, { payload = true } = {}) {
  const out = [];
  if (payload && fs.existsSync(PAYLOAD)) out.push({ dir: PAYLOAD, label: 'payload' });
  const tree = path.join(path.resolve(repo), 'Source', 'gg2');
  if (fs.existsSync(tree)) out.push({ dir: tree, label: 'gg2' });
  return out;
}

const relative = (root, p) => path.relative(root.dir, p).split(path.sep).join('/');
const display = (root, p) => (root.label === 'payload' ? 'payload/' : '') + relative(root, p);

function eventDirs(root) {
  return walk(path.join(root.dir, 'Objects'))
    .map((p) => path.dirname(p))
    .filter((d, i, all) => d.endsWith('.events') && all.indexOf(d) === i);
}

// Resolve an object name to its events directory. Missing is an error that says
// what does exist, because "no such object" and a typo look the same otherwise.
function resolveObject(repo, object, opts) {
  for (const root of roots(repo, opts)) {
    const hit = eventDirs(root).find((d) => path.basename(d) === object + '.events');
    if (hit) return { root, dir: hit };
  }
  const known = roots(repo, opts)
    .flatMap((root) => eventDirs(root).map((d) => path.basename(d).replace(/\.events$/, '')))
    .sort();
  throw new Error(
    `no object called ${JSON.stringify(object)} has any events. ` +
      (known.length ? `Objects with events: ${known.slice(0, 40).join(', ')}${known.length > 40 ? ', ...' : ''}` : '')
  );
}

// The event files an object has. Names are the file names GmkSplitter writes -
// Step, Draw, "Collision with Rocket", "Alarm 3" - which is what gmlerror.js
// reports and what a person sees in the IDE.
function listEvents(repo, object, opts) {
  const { root, dir } = resolveObject(repo, object, opts);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.xml'))
    .sort()
    .map((f) => {
      const full = path.join(dir, f);
      const actions = codeActions(lib.readText(full));
      return {
        event: f.replace(/\.xml$/, ''),
        file: display(root, full),
        actions: actions.length,
        lines: actions.map((a) => a.gml.split(/\r?\n/).length),
      };
    });
}

function eventFile(repo, object, event, opts) {
  const { root, dir } = resolveObject(repo, object, opts);
  const wanted = event.replace(/\.xml$/, '');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.xml'));
  const hit =
    files.find((f) => f === wanted + '.xml') ||
    files.find((f) => f.toLowerCase() === wanted.toLowerCase() + '.xml');
  if (!hit) {
    throw new Error(
      `${object} has no ${event} event. It has: ${files.map((f) => f.replace(/\.xml$/, '')).join(', ')}`
    );
  }
  return { root, full: path.join(dir, hit), event: hit.replace(/\.xml$/, '') };
}

function readEvent(repo, object, event, index = 0, opts) {
  const { root, full, event: name } = eventFile(repo, object, event, opts);
  const xml = lib.readText(full);
  const actions = codeActions(xml);
  const action = actions[index];
  if (!action) {
    throw new Error(`${object}'s ${name} event has ${actions.length} code action(s), so there is no index ${index}`);
  }
  return { file: display(root, full), path: full, event: name, index, line: action.line, gml: action.gml };
}

// Replace one action's GML. The file is rewritten from its own bytes with only
// that span changed, so line endings, indentation and every other action stay
// exactly as they were.
function writeEvent(repo, object, event, index, gml, { lintFirst = true, ...opts } = {}) {
  const { root, full, event: name } = eventFile(repo, object, event, opts);
  const xml = lib.readText(full);
  const actions = codeActions(xml);
  const action = actions[index];
  if (!action) {
    throw new Error(`${object}'s ${name} event has ${actions.length} code action(s), so there is no index ${index}`);
  }

  if (lintFirst) {
    const res = lint.check(gml, { trees: roots(repo).map((r) => r.dir), name: display(root, full) });
    if (!res.ok) {
      throw new Error(
        'Refused: this GML would not compile, and a built executable answers bad code with a modal dialog.\n' +
          res.errors.map((f) => `  line ${f.line}: ${f.message}`).join('\n')
      );
    }
  }

  // The splicer cannot place an empty string: it would match in thousands of
  // places in the exe's code blob and there would be no way to say which.
  if (!gml.trim()) throw new Error('an event cannot be given empty code - leave a comment in it instead');

  const body = escapeXml(gml);
  const replacement = action.selfClosing ? `<argument kind="STRING">${body}</argument>` : body;
  lib.writeText(full, xml.slice(0, action.start) + replacement + xml.slice(action.end));

  return { file: display(root, full), path: full, event: name, index, lines: gml.split(/\r?\n/).length };
}

//---------------------------------------------------------------------------
// Searching
//
// grep over the tree misses every line of event code, which is a large part of
// the game's logic. This searches the .gml files and the unescaped text of
// every code action, and reports both as file:line.
//---------------------------------------------------------------------------

function find(repo, pattern, { flags = '', limit = 200, ...opts } = {}) {
  const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
  const hits = [];

  const scan = (text, file, baseLine) => {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      hits.push({ file, line: baseLine + i, text: lines[i].trim() });
      if (hits.length >= limit) return true;
    }
    return false;
  };

  for (const root of roots(repo, opts)) {
    for (const p of walk(path.join(root.dir, 'Scripts'))) {
      if (!p.endsWith('.gml')) continue;
      if (scan(lib.readText(p), display(root, p), 1)) return hits;
    }
    for (const p of walk(path.join(root.dir, 'Objects'))) {
      if (!p.endsWith('.xml') || !path.basename(path.dirname(p)).endsWith('.events')) continue;
      const xml = lib.readText(p);
      for (const action of codeActions(xml)) {
        if (scan(action.gml, display(root, p), action.line)) return hits;
      }
    }
  }
  return hits;
}

if (require.main === module) {
  const { flags, positional } = lib.parseArgs(process.argv.slice(2), ['repo']);
  if (flags.help || positional.length === 0) lib.helpAndExit(USAGE);
  const repo = flags.repo || lib.defaultRepo();
  const opts = { payload: !flags.tree };

  lib.cli(async () => {
    switch (positional[0]) {
      case 'list':
        for (const e of listEvents(repo, positional[1], opts)) {
          lib.detail(`${e.event.padEnd(24)} ${e.actions} action(s)  ${e.file}`);
        }
        return;
      case 'read': {
        const r = readEvent(repo, positional[1], positional[2], Number(positional[3] || 0), opts);
        lib.step(`${r.file}:${r.line}`);
        process.stdout.write(r.gml + '\n');
        return;
      }
      case 'find': {
        const hits = find(repo, positional[1], opts);
        for (const h of hits) lib.detail(`${h.file}:${h.line}: ${h.text}`);
        if (hits.length === 0) lib.skip('no matches');
        return;
      }
      default:
        lib.helpAndExit(USAGE);
    }
  });
}

module.exports = { listEvents, readEvent, writeEvent, find, codeActions, escapeXml, unescapeXml, resolveObject };
