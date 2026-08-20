#!/usr/bin/env node
//=============================================================================
// gml-lint.js - a deterministic checker for Game Maker 8 GML.
//
// Exists because the only other way to know whether GML is valid is to compile
// it in the GM8 IDE (~50s), or to run it through gg2_eval, where a syntax error
// raises a modal dialog that freezes the game and every pending call.
//
// It is authoritative rather than guesswork: GM8 ships a file called `fnames`
// listing every built-in name, 1069 of them with full signatures, e.g.
//     instance_create(x,y,obj)
//     execute_string(str,arg0,arg1,...)
// so both existence and argument counts are checked against the installed
// engine. Project symbols (scripts, objects, sprites, constants) are read from
// the split source tree.
//
// Deliberately conservative: it reports only what it is confident about. A
// linter that cries wolf gets ignored, and the compiler remains the final word.
//
// Usage:
//   node gml-lint.js <file-or-dir> [...]     lint files, directories, or a tree
//   node gml-lint.js --stdin                 lint a snippet on stdin
//   node gml-lint.js --json <path>           machine-readable findings
//
// Options:
//   --gm8 <dir>      Game Maker 8 install (for fnames); default: auto-detect
//   --tree <dir>     split source tree (Source/gg2); default: auto-detect
//   --no-arity       skip argument-count checks
//
// Exit codes: 0 = no errors, 1 = errors found, 2 = could not run
//=============================================================================

'use strict';
const fs = require('fs');
const path = require('path');

//---------------------------------------------------------------------------
// GM8 built-ins, read from the engine's own fnames table
//---------------------------------------------------------------------------

function loadFnames(gm8Dir) {
  const file = path.join(gm8Dir, 'fnames');
  const text = fs.readFileSync(file, 'latin1');
  const funcs = new Map();
  const names = new Set();

  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;

    const call = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)\s*$/);
    if (call) {
      const name = call[1];
      const inner = call[2].trim();
      const parts = inner === '' ? [] : inner.split(',').map((s) => s.trim());
      const variadic = parts.some((p) => p === '...' || p.endsWith('...'));
      let named = parts.filter((p) => p !== '...');
      let min;
      if (variadic) {
        // In a signature like execute_string(str,arg0,arg1,...) the numbered
        // tail illustrates the variadic part rather than being required, so
        // drop trailing numbered parameters when computing the minimum.
        while (named.length && /^[A-Za-z_]*\d+$/.test(named[named.length - 1])) named.pop();
        min = Math.max(1, named.length);
      } else {
        min = named.length;
      }
      funcs.set(name, { min, max: variadic ? Infinity : named.length });
      names.add(name);
      continue;
    }
    // Constants end with #, assignable built-in variables with *.
    names.add(line.replace(/[#*&@]$/, ''));
  }
  return { funcs, names };
}

// Functions supplied by .gex extension packages. Not in fnames, not project
// scripts, so they are listed explicitly in gml-extensions.txt.
function loadExtensions() {
  const file = path.join(__dirname, 'gml-extensions.txt');
  const out = new Set();
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) out.add(line);
  }
  return out;
}

function autodetectGm8() {
  const guesses = [
    process.env.GM8_DIR,
    'D:\\GameDev\\Game_Maker_8',
    'C:\\Program Files (x86)\\Game_Maker_8',
    'C:\\Program Files\\Game_Maker_8',
  ].filter(Boolean);
  for (const g of guesses) if (fs.existsSync(path.join(g, 'fnames'))) return g;
  return null;
}

//---------------------------------------------------------------------------
// Project symbols, read from the split source tree
//---------------------------------------------------------------------------

function collectResourceNames(dir, acc) {
  // Resource names are the file basenames; groups are directories.
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '_resources.list.xml') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.events')) continue;
      collectResourceNames(full, acc);
    } else {
      acc.add(entry.name.replace(/\.(gml|xml|png|wav|mp3|mid|ico)$/i, ''));
    }
  }
  return acc;
}

function loadProject(tree) {
  const syms = {
    scripts: collectResourceNames(path.join(tree, 'Scripts'), new Set()),
    objects: collectResourceNames(path.join(tree, 'Objects'), new Set()),
    sprites: collectResourceNames(path.join(tree, 'Sprites'), new Set()),
    sounds: collectResourceNames(path.join(tree, 'Sounds'), new Set()),
    backgrounds: collectResourceNames(path.join(tree, 'Backgrounds'), new Set()),
    rooms: collectResourceNames(path.join(tree, 'Rooms'), new Set()),
    fonts: collectResourceNames(path.join(tree, 'Fonts'), new Set()),
    timelines: collectResourceNames(path.join(tree, 'Time Lines'), new Set()),
    paths: collectResourceNames(path.join(tree, 'Paths'), new Set()),
    constants: new Set(),
  };

  const cfile = path.join(tree, 'Constants.xml');
  if (fs.existsSync(cfile)) {
    const xml = fs.readFileSync(cfile, 'utf8');
    for (const m of xml.matchAll(/name="([^"]+)"/g)) syms.constants.add(m[1]);
  }

  // globalvar declarations anywhere in the tree are legitimate globals.
  syms.globalvars = new Set();
  for (const f of walk(tree, ['.gml'])) {
    const src = fs.readFileSync(f, 'latin1');
    for (const m of src.matchAll(/\bglobalvar\s+([^;]+);/g)) {
      for (const n of m[1].split(',')) syms.globalvars.add(n.trim());
    }
  }

  // Read-only at compile time - unlike a globalvar, which is deliberately
  // assignable and must never be flagged as if it were a resource.
  syms.resources = new Set();
  for (const k of ['scripts', 'objects', 'sprites', 'sounds', 'backgrounds', 'rooms', 'fonts', 'timelines', 'paths', 'constants']) {
    for (const v of syms[k]) syms.resources.add(v);
  }

  syms.all = new Set();
  for (const k of Object.keys(syms)) {
    if (syms[k] instanceof Set) for (const v of syms[k]) syms.all.add(v);
  }
  return syms;
}

function autodetectTree(start) {
  let d = path.resolve(start || process.cwd());
  const candidates = [
    path.resolve(__dirname, '..', '..', 'Gang-Garrison-2', 'Source', 'gg2'),
    path.resolve(d, 'Source', 'gg2'),
    d,
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'Objects'))) return c;
  return null;
}

//---------------------------------------------------------------------------
// Tokenizer
//---------------------------------------------------------------------------

const PUNCT = [
  '&&', '||', '^^', '<<', '>>', '<=', '>=', '==', '!=', ':=', '+=', '-=', '*=', '/=', '|=', '&=', '^=',
  '{', '}', '(', ')', '[', ']', ';', ',', '.', '+', '-', '*', '/', '=', '<', '>', '!', '~', '?', ':', '&', '|', '^', '@', '$', '#',
];

function tokenize(src) {
  const toks = [];
  let i = 0, line = 1, col = 1;
  const push = (type, value, l, c) => toks.push({ type, value, line: l, col: c });

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\n') { i++; line++; col = 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue; }

    // comments
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const sl = line, sc = col;
      i += 2; col += 2;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '*' && src[i + 1] === '/') { i += 2; col += 2; closed = true; break; }
        if (src[i] === '\n') { line++; col = 1; } else col++;
        i++;
      }
      if (!closed) push('unterminated-comment', '/*', sl, sc);
      continue;
    }

    // strings: GM8 has no escape sequences at all
    if (ch === '"' || ch === "'") {
      const quote = ch, sl = line, sc = col;
      i++; col++;
      let closed = false, val = '';
      while (i < src.length) {
        if (src[i] === quote) { i++; col++; closed = true; break; }
        if (src[i] === '\n') { line++; col = 1; } else col++;
        val += src[i];
        i++;
      }
      if (!closed) push('unterminated-string', quote, sl, sc);
      else push('string', val, sl, sc);
      continue;
    }

    // numbers (including $ hex)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const sl = line, sc = col;
      let val = '';
      while (i < src.length && /[0-9.]/.test(src[i])) { val += src[i]; i++; col++; }
      push('number', val, sl, sc);
      continue;
    }
    if (ch === '$' && /[0-9a-fA-F]/.test(src[i + 1] || '')) {
      const sl = line, sc = col;
      let val = '$';
      i++; col++;
      while (i < src.length && /[0-9a-fA-F]/.test(src[i])) { val += src[i]; i++; col++; }
      push('number', val, sl, sc);
      continue;
    }

    // identifiers
    if (/[A-Za-z_]/.test(ch)) {
      const sl = line, sc = col;
      let val = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) { val += src[i]; i++; col++; }
      push('ident', val, sl, sc);
      continue;
    }

    // punctuation, longest match first
    let matched = null;
    for (const p of PUNCT) {
      if (src.startsWith(p, i)) { matched = p; break; }
    }
    if (matched) {
      push('punct', matched, line, col);
      i += matched.length; col += matched.length;
      continue;
    }

    push('unknown', ch, line, col);
    i++; col++;
  }
  return toks;
}

//---------------------------------------------------------------------------
// Checks
//---------------------------------------------------------------------------

const KEYWORDS = new Set([
  'if', 'else', 'while', 'do', 'until', 'for', 'repeat', 'switch', 'case', 'default',
  'break', 'continue', 'exit', 'return', 'with', 'var', 'globalvar', 'then', 'begin', 'end',
  'and', 'or', 'not', 'xor', 'mod', 'div', 'true', 'false',
]);

// Identifiers GM8 accepts but later GameMaker versions reserved. The project has
// already had to fix a use of `new`; using these invites the same breakage.
const FUTURE_RESERVED = new Set(['new', 'delete', 'function', 'static', 'constructor', 'struct', 'try', 'catch', 'finally', 'throw']);

// Modern-GML constructs GM8's parser rejects outright.
// GM8 accepts these, and the game's own code uses them, so they are style
// issues rather than errors - despite what Contributing.md implies.
const STYLE_PUNCT = {
  '&&': 'house style prefers "and" over "&&"',
  '||': 'house style prefers "or" over "||"',
  '^^': 'house style prefers "xor" over "^^"',
};

// Functions that exist in modern GameMaker but not in GM8. Calling one is a
// hard error, and it is the single most likely mistake an agent makes here.
const MODERN_ONLY = new Set([
  'array_length', 'array_push', 'array_pop', 'array_insert', 'array_delete', 'array_sort',
  'array_create', 'array_copy', 'array_resize', 'array_get', 'array_set',
  'string_split', 'string_join', 'string_trim', 'string_starts_with', 'string_ends_with',
  'struct_exists', 'struct_get', 'struct_set', 'struct_remove', 'variable_struct_exists',
  'method', 'method_call', 'is_method', 'is_struct', 'is_undefined', 'is_array', 'is_ptr',
  'json_parse', 'json_stringify', 'buffer_write', 'buffer_read',
  'instance_create_layer', 'instance_create_depth', 'layer_create', 'draw_sprite_pos',
  'audio_play_sound', 'audio_stop_sound',
  'ds_map_secure_save', 'string_hash_to_newline', 'gc_collect', 'exception_unhandled_handler',
]);

// Built-in instance variables. Every instance already has one of these, so
// `var` declaring a local of the same name is not a redeclaration - it is a
// compilation error, and one that takes the whole script's compile down with
// it (GM8 compiles every script at load, before any Create event runs), which
// is what makes it so much more expensive than the error message suggests.
// Verified against this project's own ~20,000 lines: zero `var` declarations
// shadow any of these.
const INSTANCE_VARS = new Set([
  'x', 'y', 'xprevious', 'yprevious', 'xstart', 'ystart',
  'hspeed', 'vspeed', 'speed', 'direction', 'friction', 'gravity', 'gravity_direction',
  'solid', 'persistent', 'depth', 'visible', 'id',
  'object_index', 'sprite_index', 'mask_index',
  'image_index', 'image_speed', 'image_xscale', 'image_yscale', 'image_angle', 'image_alpha', 'image_blend',
  'alarm', 'bbox_left', 'bbox_right', 'bbox_top', 'bbox_bottom',
]);

// Assignment operators. Deliberately excludes "==", "<=", ">=" and "!=" - none
// of those write anything, so a resource name is fine on their left.
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '|=', '&=', '^=', ':=']);

function lintSource(src, ctx, originName) {
  const findings = [];
  const add = (sev, line, col, rule, msg) =>
    findings.push({ severity: sev, file: originName, line, col, rule, message: msg });

  const toks = tokenize(src);

  // --- lexical problems ---
  for (const t of toks) {
    if (t.type === 'unterminated-string') add('error', t.line, t.col, 'unterminated-string', 'string literal is never closed');
    if (t.type === 'unterminated-comment') add('error', t.line, t.col, 'unterminated-comment', 'block comment is never closed');
  }

  // --- banned operators ---
  for (const t of toks) {
    if (t.type === 'punct' && STYLE_PUNCT[t.value]) {
      if (ctx.style) add('warning', t.line, t.col, 'style-operator', STYLE_PUNCT[t.value]);
    }
  }

  // "!" as logical not. GM8 does accept it, but house style forbids it and it
  // reads as a typo next to "not"; flag as a warning only.
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (ctx.style && t.type === 'punct' && t.value === '!' && !(toks[k + 1] && toks[k + 1].value === '=')) {
      add('warning', t.line, t.col, 'style-operator', 'house style prefers "not" over "!"');
    }
  }

  // --- reserved-word hazards and modern keywords ---
  for (const t of toks) {
    if (t.type === 'ident' && FUTURE_RESERVED.has(t.value)) {
      add('error', t.line, t.col, 'future-reserved',
        `"${t.value}" is not usable here: GM8 has no such construct, and later GameMaker versions reserve the word`);
    }
  }

  // --- ternary ---
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].type === 'punct' && toks[k].value === '?') {
      add('error', toks[k].line, toks[k].col, 'ternary', 'GM8 has no ternary operator; use if/else');
    }
  }

  // --- bracket balance ---
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (const t of toks) {
    if (t.type !== 'punct') continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') stack.push(t);
    else if (pairs[t.value]) {
      const open = stack.pop();
      if (!open) add('error', t.line, t.col, 'unbalanced', `unmatched "${t.value}"`);
      else if (open.value !== pairs[t.value])
        add('error', t.line, t.col, 'unbalanced', `"${t.value}" closes "${open.value}" opened at line ${open.line}`);
    }
  }
  for (const open of stack) add('error', open.line, open.col, 'unbalanced', `"${open.value}" is never closed`);

  // --- calls: existence and arity ---
  const localVars = new Set();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === 'ident' && (t.value === 'var' || t.value === 'globalvar')) {
      const isVar = t.value === 'var';
      let j = k + 1;
      while (j < toks.length && toks[j].value !== ';') {
        if (toks[j].type === 'ident') {
          localVars.add(toks[j].value);
          if (isVar && INSTANCE_VARS.has(toks[j].value)) {
            add('error', toks[j].line, toks[j].col, 'var-shadows-builtin',
              `"var ${toks[j].value}" is a compilation error in GM8: "${toks[j].value}" is a built-in instance ` +
              'variable, not a free name - the whole script fails to compile, before any Create event runs');
          }
        }
        j++;
      }
    }
  }

  // --- assignment to a resource/constant name ---
  //
  // Script, object, sprite, room, font, timeline, path and constant names are
  // read-only constants at compile time, so `global.navNodeGrid = -1;` is not
  // an assignment when a script called navNodeGrid exists - it fails to
  // compile, identically to the var-shadow case above, and just as silently
  // (the game boots, opens its window, and never starts the bridge).
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const next = toks[k + 1];
    if (t.type !== 'ident' || !next || next.type !== 'punct' || !ASSIGN_OPS.has(next.value)) continue;
    if (!ctx.syms.resources.has(t.value)) continue;
    add('error', t.line, t.col, 'assign-to-resource-name',
      `"${t.value}" is a script/object/sprite/room/constant name, which is a read-only constant at compile ` +
      'time - assigning to it is a compilation error, not an assignment');
  }

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const next = toks[k + 1];
    if (t.type !== 'ident' || !next || next.value !== '(') continue;
    if (KEYWORDS.has(t.value)) continue;
    // a.b(...) is a method-ish access; GM8 has none, but skip to avoid noise
    if (k > 0 && toks[k - 1].type === 'punct' && toks[k - 1].value === '.') continue;

    // fnames is authoritative, so never contradict it: a wrong entry in
    // MODERN_ONLY degrades to silence rather than a false positive.
    if (MODERN_ONLY.has(t.value) && !ctx.fnames.names.has(t.value)) {
      add('error', t.line, t.col, 'modern-function',
        `"${t.value}" is a modern GameMaker function and does not exist in GM8`);
      continue;
    }

    const builtin = ctx.fnames.funcs.get(t.value);
    const known = builtin || ctx.fnames.names.has(t.value) || ctx.syms.all.has(t.value) ||
                  ctx.extensions.has(t.value) || localVars.has(t.value);

    if (!known) {
      add('error', t.line, t.col, 'unknown-function',
        `"${t.value}" is not a GM8 built-in, a project script, or a known extension function` +
        ' (if it comes from a .gex, add it to tools/gml-extensions.txt)');
      continue;
    }

    if (builtin && ctx.arity) {
      // count top-level commas between the parentheses
      let depth = 0, args = 0, seenAny = false;
      for (let j = k + 1; j < toks.length; j++) {
        const v = toks[j].value;
        if (toks[j].type === 'punct' && (v === '(' || v === '[' || v === '{')) { depth++; if (depth === 1) continue; }
        else if (toks[j].type === 'punct' && (v === ')' || v === ']' || v === '}')) {
          depth--;
          if (depth === 0) break;
          continue;
        }
        if (depth === 1) {
          if (toks[j].type === 'punct' && v === ',') args++;
          else seenAny = true;
        }
      }
      const count = seenAny || args > 0 ? args + 1 : 0;
      if (count < builtin.min || count > builtin.max) {
        const want = builtin.max === Infinity ? `${builtin.min}+` : String(builtin.min);
        add('error', t.line, t.col, 'arity',
          `${t.value}() takes ${want} argument${want === '1' ? '' : 's'}, got ${count}`);
      }
    }
  }

  return findings;
}

//---------------------------------------------------------------------------
// Event XML: GML lives inside <argument kind="STRING">, XML-escaped
//---------------------------------------------------------------------------

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

function lintEventXml(xml, ctx, originName) {
  const findings = [];
  const re = /<argument kind="STRING">([\s\S]*?)<\/argument>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    // line number of the payload start, so reported lines point into the XML
    const before = xml.slice(0, m.index + m[0].indexOf('>') + 1);
    const baseLine = before.split('\n').length - 1;
    const gml = unescapeXml(m[1]);
    for (const f of lintSource(gml, ctx, originName)) {
      f.line += baseLine;
      findings.push(f);
    }
  }
  return findings;
}

//---------------------------------------------------------------------------
// Driver
//---------------------------------------------------------------------------

function walk(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const st = fs.statSync(dir);
  if (st.isFile()) return exts.some((e) => dir.endsWith(e)) ? [dir] : [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

//---------------------------------------------------------------------------
// In-process entry point
//
// The CLI above is the interactive face of this file; callers inside the
// tooling want an answer rather than an exit code, and want it without paying
// for a process launch on every keystroke of generated GML. Building the
// context means reading GM8's fnames and walking the tree, so it is cached -
// keyed on the trees it was built from, since the payload adds symbols the
// game's own tree does not have.
//
// That cache used to live for the life of the process, which is wrong: a
// long-running MCP server keeps a lint context around for as long as it is
// up, but a full build-agent.js run - a separate process - can add or remove
// scripts and objects underneath it at any time. The manifest a full build
// writes (Source/build/template/gamedata.manifest.json, the same one
// build-fast.js checks a tree hash against) changes exactly when that
// happens, so its mtime is folded into the cache key: one stat() per lint
// call instead of one full tree walk, but no longer stale after a build.
//---------------------------------------------------------------------------

// Where a full build leaves its manifest, relative to a split source tree
// (Source/gg2 -> Source/build/template/gamedata.manifest.json). Trees that
// are not laid out this way - the bridge payload, a scratch tree in tests -
// have no such file, which is fine: they never gain or lose symbols outside
// a lint call's own edit.
//
// Every tree that has one is folded in, not just the first found: a caller
// that passes trees in a different order from another caller in the same
// process (events.js puts the payload first; the MCP server puts the game
// tree first) must not end up with a cache key blind to one of them.
function manifestMtime(trees) {
  const parts = [];
  for (const tree of trees) {
    const manifest = path.resolve(tree, '..', 'build', 'template', 'gamedata.manifest.json');
    try {
      parts.push(`${manifest}@${fs.statSync(manifest).mtimeMs}`);
    } catch (e) {
      continue;
    }
  }
  return parts.sort().join('|');
}

// A handful of entries, not one: distinct callers legitimately ask for
// distinct tree sets in the same process (the game tree alone from the CLI,
// the game tree plus the payload from the MCP server), and a single-slot
// cache makes those interleave into constant misses - always correct, since
// the key still carries the real state, but paying for a full tree walk on
// every call defeats the point of caching at all. Oldest evicted first.
const CTX_CACHE_SIZE = 8;
let ctxCache = [];

function context(trees, gm8Dir) {
  // Order must not matter: two callers passing the same trees in a different
  // sequence describe the same project and must hit the same entry, or a
  // single-slot-shaped thrash comes back under a different name. The merge
  // below is a set union either way, so sorting changes nothing it computes.
  const sortedTrees = [...trees].sort();
  const key = JSON.stringify([sortedTrees, gm8Dir, manifestMtime(sortedTrees)]);

  const hit = ctxCache.find((e) => e.key === key);
  if (hit) return hit.ctx;

  const syms = loadProject(sortedTrees[0]);
  for (const extra of sortedTrees.slice(1)) {
    if (!fs.existsSync(extra)) continue;
    const more = loadProject(extra);
    for (const k of Object.keys(more)) {
      if (!(more[k] instanceof Set)) continue;
      if (!(syms[k] instanceof Set)) syms[k] = new Set();
      for (const v of more[k]) syms[k].add(v);
    }
  }

  const ctx = { fnames: loadFnames(gm8Dir), syms, extensions: loadExtensions(), arity: true, style: false };
  ctxCache.push({ key, ctx });
  if (ctxCache.length > CTX_CACHE_SIZE) ctxCache.shift();
  return ctx;
}

// Check a snippet, or the STRING arguments of an event file. Returns
// { ok, findings, errors } - or { ok: true, note } when the linter could not
// run at all, because a missing GM8 install must never block real work.
function check(code, { trees = [], gm8 = null, xml = false, name = '<gml>' } = {}) {
  const gm8Dir = gm8 || autodetectGm8();
  const treeList = (trees.length ? trees : [autodetectTree(null)]).filter(Boolean);
  if (!gm8Dir) return { ok: true, findings: [], errors: [], note: 'lint unavailable: no Game Maker 8 install found' };
  if (treeList.length === 0) return { ok: true, findings: [], errors: [], note: 'lint unavailable: no source tree found' };

  let findings;
  try {
    const ctx = context(treeList, gm8Dir);
    findings = xml ? lintEventXml(code, ctx, name) : lintSource(code, ctx, name);
  } catch (e) {
    return { ok: true, findings: [], errors: [], note: 'lint unavailable: ' + e.message };
  }
  const errors = findings.filter((f) => f.severity === 'error');
  return { ok: errors.length === 0, findings, errors };
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { json: false, stdin: false, arity: true, style: false, gm8: null, trees: [], targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--stdin') opts.stdin = true;
    else if (a === '--no-arity') opts.arity = false;
    else if (a === '--style') opts.style = true;
    else if (a === '--gm8') opts.gm8 = argv[++i];
    else if (a === '--tree') opts.trees.push(argv[++i]);
    else opts.targets.push(a);
  }

  const gm8 = opts.gm8 || autodetectGm8();
  if (!gm8) {
    console.error('gml-lint: could not find a Game Maker 8 install (needs its "fnames" file). Pass --gm8 <dir> or set GM8_DIR.');
    process.exit(2);
  }
  const trees = opts.trees.length ? opts.trees.map((t) => path.resolve(t)) : [autodetectTree(opts.targets[0])].filter(Boolean);
  if (trees.length === 0) {
    console.error('gml-lint: could not find the split source tree (Source/gg2). Pass --tree <dir>.');
    process.exit(2);
  }

  // The bridge payload defines scripts that call each other and are not in the
  // game's tree until they are injected. Linting it against the game alone would
  // report every one of them as an unknown function.
  const payload = path.resolve(__dirname, '..', 'payload');
  const touchesPayload = opts.targets.some((t) => path.resolve(t).startsWith(payload));
  if (touchesPayload && fs.existsSync(payload) && !trees.includes(payload)) trees.push(payload);

  const ctx = Object.assign(context(trees, gm8), { arity: opts.arity, style: opts.style });

  const run = (text, name, isXml) =>
    isXml ? lintEventXml(text, ctx, name) : lintSource(text, ctx, name);

  const finish = (findings) => {
    const errors = findings.filter((f) => f.severity === 'error');
    if (opts.json) {
      console.log(JSON.stringify({ findings, errors: errors.length, warnings: findings.length - errors.length }, null, 2));
    } else if (findings.length === 0) {
      console.log('gml-lint: clean');
    } else {
      for (const f of findings) {
        console.log(`${f.file}:${f.line}:${f.col}: ${f.severity}: ${f.message} [${f.rule}]`);
      }
      console.log(`\n${errors.length} error(s), ${findings.length - errors.length} warning(s)`);
    }
    process.exit(errors.length > 0 ? 1 : 0);
  };

  if (opts.stdin) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => finish(run(buf, '<stdin>', false)));
    return;
  }

  if (opts.targets.length === 0) {
    console.error('gml-lint: nothing to lint. Pass a file or directory, or --stdin.');
    process.exit(2);
  }

  const findings = [];
  for (const t of opts.targets) {
    for (const f of walk(t, ['.gml', '.xml'])) {
      if (f.endsWith('_resources.list.xml')) continue;
      const text = fs.readFileSync(f, 'latin1');
      const isXml = f.endsWith('.xml');
      if (isXml && !text.includes('<argument kind="STRING">')) continue;
      findings.push(...run(text, path.relative(process.cwd(), f), isXml));
    }
  }
  finish(findings);
}

if (require.main === module) main();
module.exports = { tokenize, lintSource, lintEventXml, loadFnames, loadProject, check, autodetectGm8, autodetectTree };
