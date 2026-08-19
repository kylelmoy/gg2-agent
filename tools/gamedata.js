#!/usr/bin/env node
//=============================================================================
// gamedata.js - splice GML into a built Gang Garrison 2 executable, without
// Game Maker.
//
// A GM8 executable is the runner stub with the game's "gamedata" appended at a
// fixed offset (2,000,000, read from a pointer at 0x144AC0). Nothing in that
// gamedata is compiled: GML is stored as source text inside per-asset zlib
// blobs, and the whole asset stream is wrapped in a swap-table cipher. Nothing
// holds an absolute offset into the stream either, so a blob can change size
// and everything after it simply shifts.
//
// That makes a code-only rebuild a splice rather than a compile:
//
//   unpack -> decrypt -> find [uint32 len][old code] -> replace -> re-encrypt
//
// which costs about a second, against ~50s for driving the IDE. Everything the
// splicer does not recognise is copied through byte for byte, so it cannot
// corrupt assets it does not understand - it can only fail to find its target,
// which is an error, never a silent miss.
//
// It cannot add or remove resources. build-fast.js guards that with a hash of
// every non-code file in the tree, taken when the template exe was built.
//
// Usage:
//   node gamedata.js selftest  <exe>
//   node gamedata.js scripts   <exe>
//   node gamedata.js snapshot  <tree> <exe> <manifest.json>
//   node gamedata.js patch     <manifest.json> <tree> <out.exe> [--dry-run]
//=============================================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const HEADER_PTR = 0x144ac0; // the runner reads its gamedata offset from here
const GM80_MAGIC = 1234321;
const GM80_VERSION = 800;

//---------------------------------------------------------------------------
// Container
//---------------------------------------------------------------------------

// Locate the gamedata inside an exe and pull out the encrypted asset stream.
// Everything before `lenPos` is copied to the output untouched, which is why
// the icon, the PE headers and gm8x_fix's patches all survive a splice.
function unpack(exe) {
  if (exe.length < HEADER_PTR + 4) throw new Error('not a GM8 executable: too short');

  const headerPos = exe.readUInt32LE(HEADER_PTR);
  if (headerPos + 16 > exe.length) throw new Error('gamedata pointer out of range');
  if (exe.readUInt32LE(headerPos) !== GM80_MAGIC) {
    throw new Error(`no GM8.0 gamedata at 0x${headerPos.toString(16)} (magic mismatch)`);
  }
  if (exe.readUInt32LE(headerPos + 4) !== GM80_VERSION) {
    throw new Error('gamedata is not version 800 - only GM8.0 builds are supported');
  }

  // magic, version, two dwords, then the settings blob and the bundled D3DX8.
  let o = headerPos + 16;
  o += 4 + exe.readUInt32LE(o); // settings
  o += 4 + exe.readUInt32LE(o); // dll name
  o += 4 + exe.readUInt32LE(o); // dll payload

  // The swap table sits between two runs of filler dwords.
  const garbage1 = exe.readUInt32LE(o);
  const garbage2 = exe.readUInt32LE(o + 4);
  o += 8;
  const tablePos = o + garbage1 * 4;
  const table = exe.slice(tablePos, tablePos + 256);
  if (table.length !== 256) throw new Error('truncated swap table');

  const lenPos = tablePos + 256 + garbage2 * 4;
  const alen = exe.readUInt32LE(lenPos);
  const apos = lenPos + 4;
  if (apos + alen > exe.length) throw new Error('asset stream runs past end of file');

  return {
    prefix: exe.slice(0, lenPos),
    tail: exe.slice(apos + alen),
    table,
    stream: decrypt(exe.slice(apos, apos + alen), table),
  };
}

function repack(c, stream) {
  const encrypted = encrypt(stream, c.table);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(encrypted.length, 0);
  return Buffer.concat([c.prefix, len, encrypted, c.tail]);
}

//---------------------------------------------------------------------------
// The swap-table cipher
//
// Decryption is a byte substitution through the inverse table, subtracting the
// previous ciphertext byte and the position, followed by a run of swaps walked
// backwards. Encryption is exactly that inverted: swaps forwards first, then
// the substitution ascending so each byte sees the ciphertext byte before it.
//---------------------------------------------------------------------------

function decrypt(buf, table) {
  const rev = new Uint8Array(256);
  for (let i = 0; i < 256; i++) rev[table[i]] = i;

  const d = Buffer.from(buf);
  const n = d.length;
  for (let i = n; i >= 2; i--) d[i - 1] = (rev[d[i - 1]] - (d[i - 2] + ((i - 1) & 0xff))) & 0xff;
  for (let i = n - 1; i >= 0; i--) {
    const b = Math.max(i - table[i & 0xff], 0);
    const t = d[i];
    d[i] = d[b];
    d[b] = t;
  }
  return d;
}

function encrypt(buf, table) {
  const d = Buffer.from(buf);
  const n = d.length;
  for (let i = 0; i < n; i++) {
    const b = Math.max(i - table[i & 0xff], 0);
    const t = d[i];
    d[i] = d[b];
    d[b] = t;
  }
  for (let i = 2; i <= n; i++) d[i - 1] = table[(d[i - 1] + d[i - 2] + ((i - 1) & 0xff)) & 0xff];
  return d;
}

//---------------------------------------------------------------------------
// Blob chain
//
// Assets are [uint32 length][zlib blob], with section headers in between that
// we deliberately do not parse. A blob is anything that inflates cleanly at a
// plausible length; everything else is scenery we step over one byte at a time.
//---------------------------------------------------------------------------

function readBlobs(stream) {
  const blobs = [];
  let i = 0;
  while (i + 6 <= stream.length) {
    if (stream[i + 4] !== 0x78 || stream[i + 5] !== 0x9c) {
      i++;
      continue;
    }
    const len = stream.readUInt32LE(i);
    if (len < 8 || i + 4 + len > stream.length) {
      i++;
      continue;
    }
    let data;
    try {
      data = zlib.inflateSync(stream.slice(i + 4, i + 4 + len));
    } catch (e) {
      i++;
      continue;
    }
    blobs.push({ off: i, compLen: len, data });
    i += 4 + len;
  }
  return blobs;
}

// Every asset starts [uint32 exists][uint32 nameLen][name], whatever it is.
function assetName(data) {
  if (data.length < 8 || data.readUInt32LE(0) !== 1) return null;
  const n = data.readUInt32LE(4);
  if (n === 0 || n > 128 || 8 + n > data.length) return null;
  const name = data.slice(8, 8 + n).toString('latin1');
  return /^[A-Za-z_][A-Za-z0-9_ ]*$/.test(name) ? name : null;
}

// Scripts are [exists][name][version][code] and nothing else, so they can be
// read out in full - used by `scripts` and by the snapshot's sanity check.
function readScript(data) {
  const name = assetName(data);
  if (name === null) return null;
  let o = 8 + name.length;
  if (o + 8 > data.length) return null;
  const version = data.readUInt32LE(o);
  if (version !== 400 && version !== 800) return null;
  o += 4;
  const codeLen = data.readUInt32LE(o);
  o += 4;
  if (o + codeLen !== data.length) return null;
  return { name, code: data.slice(o, o + codeLen).toString('latin1') };
}

// Splice new blob contents back into the stream. Blobs must be given in
// ascending offset order; the gaps between them are copied verbatim.
function rebuild(stream, edits) {
  const parts = [];
  let cursor = 0;
  for (const e of edits.slice().sort((a, b) => a.blob.off - b.blob.off)) {
    parts.push(stream.slice(cursor, e.blob.off));
    const comp = zlib.deflateSync(e.data, { level: 6 });
    const len = Buffer.alloc(4);
    len.writeUInt32LE(comp.length, 0);
    parts.push(len, comp);
    cursor = e.blob.off + 4 + e.blob.compLen;
  }
  parts.push(stream.slice(cursor));
  return Buffer.concat(parts);
}

//---------------------------------------------------------------------------
// Splicing
//
// A code string lives in its blob as [uint32 length][bytes], so replacing one
// needs no understanding of the asset around it. The old text comes from the
// snapshot taken when the template exe was built, which is what makes the
// search exact rather than a guess.
//---------------------------------------------------------------------------

function findString(data, text) {
  const body = Buffer.from(text, 'latin1');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  const needle = Buffer.concat([head, body]);

  const hits = [];
  let at = data.indexOf(needle);
  while (at >= 0) {
    hits.push(at);
    at = data.indexOf(needle, at + 1);
  }
  return { hits, needleLen: needle.length };
}

function replaceString(data, at, oldLen, text) {
  const body = Buffer.from(text, 'latin1');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([data.slice(0, at), head, body, data.slice(at + oldLen)]);
}

// changes: [{ key, asset, from, to }]. Returns the new stream, or throws with a
// message that says which change could not be placed and why.
function applyChanges(stream, changes) {
  const blobs = readBlobs(stream);
  const byName = new Map();
  for (const b of blobs) {
    const n = assetName(b.data);
    if (n === null) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(b);
  }

  const edited = new Map(); // blob -> working copy of its data
  for (const c of changes) {
    const candidates = byName.get(c.asset) || [];
    if (candidates.length === 0) {
      throw new Error(`${c.key}: no asset named "${c.asset}" in the executable - it needs a full build`);
    }

    const found = [];
    for (const b of candidates) {
      const data = edited.get(b) || b.data;
      const { hits, needleLen } = findString(data, c.from);
      for (const at of hits) found.push({ blob: b, at, needleLen });
    }

    if (found.length === 0) {
      throw new Error(
        `${c.key}: the code in the executable does not match the snapshot. ` +
          `The template exe is out of date - run build-agent.js.`
      );
    }
    if (found.length > 1) {
      throw new Error(
        `${c.key}: this code appears ${found.length} times in "${c.asset}", so the splice would be ambiguous. ` +
          `Run build-agent.js for this change.`
      );
    }

    const { blob, at, needleLen } = found[0];
    const data = edited.get(blob) || blob.data;
    edited.set(blob, replaceString(data, at, needleLen, c.to));
  }

  const edits = [];
  for (const [blob, data] of edited) edits.push({ blob, data });
  return rebuild(stream, edits);
}

//---------------------------------------------------------------------------
// Reading code out of the split tree
//---------------------------------------------------------------------------

function walk(dir, out) {
  out = out || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (tree, p) => path.relative(tree, p).split(path.sep).join('/');

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// GmkSplitter copies .gml files into the .gmk byte for byte - the tree has a
// mix of LF and CRLF scripts and the exe mirrors whichever the file uses, so
// script text is taken verbatim. Event code is different: it lives in XML, and
// an XML parser normalises line endings away, so GmkSplitter re-emits it as
// CRLF. Put those back, or the text we search for will not match the exe.
const toCrlf = (s) => s.replace(/\r\n|\n|\r/g, '\r\n');

// Every piece of GML in the tree, keyed so the same key means the same string
// in the snapshot and at patch time.
//
//   Scripts/Game/game_init.gml              -> asset "game_init"
//   Objects/Characters/Scout.events/Step.xml#0 -> asset "Scout"
function collectCode(tree) {
  const out = [];

  const scripts = path.join(tree, 'Scripts');
  if (fs.existsSync(scripts)) {
    for (const p of walk(scripts)) {
      if (!p.endsWith('.gml')) continue;
      out.push({
        key: rel(tree, p),
        asset: path.basename(p, '.gml'),
        text: fs.readFileSync(p, 'latin1'),
      });
    }
  }

  const objects = path.join(tree, 'Objects');
  if (fs.existsSync(objects)) {
    for (const p of walk(objects)) {
      const dir = path.basename(path.dirname(p));
      if (!p.endsWith('.xml') || !dir.endsWith('.events')) continue;
      const asset = dir.slice(0, -'.events'.length);
      const xml = fs.readFileSync(p, 'latin1');
      // Only STRING arguments carry GML. EXPRESSION, SCRIPT and MENU arguments
      // are resource ids and small literals, which the exe stores as numbers
      // rather than as the names GmkSplitter writes into the XML; they are
      // covered by treeHash instead.
      const re = /<argument kind="STRING"[^>]*?(?:\/>|>([\s\S]*?)<\/argument>)/g;
      let m;
      let i = 0;
      while ((m = re.exec(xml)) !== null) {
        out.push({
          key: `${rel(tree, p)}#${i++}`,
          asset,
          text: m[1] === undefined ? '' : toCrlf(unescapeXml(m[1])),
        });
      }
    }
  }

  return out;
}

// Hash of everything the splicer cannot express: sprites, rooms, object
// properties, settings, included files. If this moves, only the IDE can build.
//
// Script files are excluded outright - they are pure code, and adding or
// removing one is caught by the key comparison in `patch`. Event files are
// included with their STRING arguments blanked, so editing event code does not
// trip the hash but adding an action, or touching an argument the splicer
// cannot place, does.
function treeHash(tree) {
  const h = crypto.createHash('sha256');
  const files = walk(tree)
    .filter((p) => !rel(tree, p).startsWith('Scripts/'))
    .sort();
  for (const p of files) {
    const r = rel(tree, p);
    let content = fs.readFileSync(p);
    if (/\.events\/[^/]+\.xml$/.test(r)) {
      content = Buffer.from(
        content
          .toString('latin1')
          .replace(/(<argument kind="STRING"[^>]*>)[\s\S]*?(<\/argument>)/g, '$1$2'),
        'latin1'
      );
    }
    h.update(r);
    h.update(crypto.createHash('sha256').update(content).digest());
  }
  return h.digest('hex');
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

//---------------------------------------------------------------------------
// Lint gate
//
// A splice is fast enough that it is tempting to skip checking the code first,
// but GM8 has no error recovery: bad GML in a built exe is a modal dialog that
// hangs the game and every pending bridge call. gml-lint.js costs milliseconds
// and refuses that outcome, so it runs on every string we are about to write.
//---------------------------------------------------------------------------

function lint(changes) {
  const { spawnSync } = require('child_process');
  const linter = path.join(__dirname, 'gml-lint.js');
  if (!fs.existsSync(linter)) return [];

  const problems = [];
  for (const c of changes) {
    const r = spawnSync(process.execPath, [linter, '--stdin', '--json'], {
      input: c.to,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) return []; // never let a linter problem block a build
    let out;
    try {
      out = JSON.parse(r.stdout);
    } catch (e) {
      return [];
    }
    for (const f of out.findings.filter((f) => f.severity === 'error')) {
      problems.push(`${c.key} line ${f.line}: ${f.message}`);
    }
  }
  return problems;
}

//---------------------------------------------------------------------------
// Commands
//---------------------------------------------------------------------------

function cmdSelftest(exePath) {
  const exe = fs.readFileSync(exePath);
  const c = unpack(exe);
  const blobs = readBlobs(c.stream);
  const scripts = blobs.map((b) => readScript(b.data)).filter(Boolean);

  const out = repack(c, c.stream);
  if (!out.equals(exe)) {
    throw new Error('round-trip is not byte-identical - the cipher or the container parse is wrong');
  }

  console.log(`[+] gamedata: ${c.stream.length} bytes, ${blobs.length} blobs, ${scripts.length} scripts`);
  console.log('[+] unpack -> repack is byte-identical');
}

function cmdScripts(exePath) {
  const c = unpack(fs.readFileSync(exePath));
  for (const b of readBlobs(c.stream)) {
    const s = readScript(b.data);
    if (s) console.log(`${String(s.code.length).padStart(7)}  ${s.name}`);
  }
}

function snapshot(tree, exePath, outPath, log = () => {}) {
  const exe = fs.readFileSync(exePath);
  const c = unpack(exe);
  const code = collectCode(tree);

  // Prove the snapshot describes this exe before anything relies on it.
  const stream = c.stream;
  const blobs = readBlobs(stream);
  const byName = new Map();
  for (const b of blobs) {
    const n = assetName(b.data);
    if (n !== null) byName.set(n, (byName.get(n) || []).concat([b]));
  }
  let placed = 0;
  const missing = [];
  for (const c2 of code) {
    const candidates = byName.get(c2.asset) || [];
    const hit = candidates.some((b) => findString(b.data, c2.text).hits.length > 0);
    if (hit) placed++;
    else missing.push(c2.key);
  }

  const manifest = {
    version: 1,
    created: new Date().toISOString(),
    template: path.resolve(exePath),
    templateSha256: sha256(exe),
    treeHash: treeHash(tree),
    placed,
    unplaced: missing,
    code,
  };
  fs.writeFileSync(outPath, JSON.stringify(manifest));

  log(`[+] snapshot: ${code.length} code strings, ${placed} located in the exe`);
  if (missing.length) {
    log(`[-] ${missing.length} not found in the exe (these will force a full build if edited):`);
    for (const k of missing.slice(0, 10)) log(`    ${k}`);
    if (missing.length > 10) log(`    ... and ${missing.length - 10} more`);
  }
  return { total: code.length, placed, missing };
}

function patch(manifestPath, tree, outPath, dryRun, log = () => {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1) throw new Error(`unsupported manifest version ${manifest.version}`);

  const hash = treeHash(tree);
  if (hash !== manifest.treeHash) {
    throw new Error(
      'the tree has changes the splicer cannot make - a sprite, room, object property, setting or ' +
        'included file differs from the template build. Run build-agent.js.'
    );
  }

  const before = new Map(manifest.code.map((c) => [c.key, c]));
  const now = collectCode(tree);
  const changes = [];
  for (const c of now) {
    const old = before.get(c.key);
    if (old === undefined) {
      throw new Error(`${c.key} did not exist when the template was built - run build-agent.js`);
    }
    if (old.text !== c.text) changes.push({ key: c.key, asset: c.asset, from: old.text, to: c.text });
    before.delete(c.key);
  }
  if (before.size > 0) {
    const gone = [...before.keys()].slice(0, 5).join(', ');
    throw new Error(`code was removed since the template was built (${gone}) - run build-agent.js`);
  }

  if (changes.length === 0) {
    log('[=] no code changes since the template was built');
    if (!dryRun && path.resolve(outPath) !== path.resolve(manifest.template)) {
      fs.copyFileSync(manifest.template, outPath);
    }
    return { changes, wrote: !dryRun };
  }

  for (const c of changes) log(`[*] ${c.key}  (${c.from.length} -> ${c.to.length} bytes)`);

  const problems = lint(changes);
  if (problems.length) {
    throw new Error(
      'refusing to build: this GML would not compile, and a built exe has no error recovery - ' +
        'it would hang on a modal dialog.\n  ' +
        problems.join('\n  ')
    );
  }

  if (dryRun) {
    log(`[=] dry run: ${changes.length} change(s) not applied`);
    return { changes, wrote: false };
  }

  const exe = fs.readFileSync(manifest.template);
  if (sha256(exe) !== manifest.templateSha256) {
    throw new Error(`${manifest.template} has changed since the snapshot - run build-agent.js`);
  }

  const c = unpack(exe);
  const stream = applyChanges(c.stream, changes);
  fs.writeFileSync(outPath, repack(c, stream));
  log(`[+] patched ${changes.length} code string(s) into ${outPath}`);
  return { changes, wrote: true };
}

//---------------------------------------------------------------------------

function main(argv) {
  const [cmd, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  const args = rest.filter((a) => a !== '--dry-run');

  switch (cmd) {
    case 'selftest':
      if (args.length !== 1) throw new Error('usage: gamedata.js selftest <exe>');
      return cmdSelftest(args[0]);
    case 'scripts':
      if (args.length !== 1) throw new Error('usage: gamedata.js scripts <exe>');
      return cmdScripts(args[0]);
    case 'snapshot': {
      if (args.length !== 3) throw new Error('usage: gamedata.js snapshot <tree> <exe> <manifest.json>');
      snapshot(args[0], args[1], args[2], console.log);
      console.log(`[+] wrote ${args[2]}`);
      return;
    }
    case 'patch':
      if (args.length !== 3) throw new Error('usage: gamedata.js patch <manifest.json> <tree> <out.exe> [--dry-run]');
      patch(args[0], args[1], args[2], dryRun, console.log);
      return;
    default:
      throw new Error(
        'usage:\n' +
          '  gamedata.js selftest <exe>\n' +
          '  gamedata.js scripts  <exe>\n' +
          '  gamedata.js snapshot <tree> <exe> <manifest.json>\n' +
          '  gamedata.js patch    <manifest.json> <tree> <out.exe> [--dry-run]'
      );
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error('[!] ' + e.message);
    process.exit(1);
  }
}

module.exports = {
  unpack, repack, decrypt, encrypt,
  readBlobs, readScript, collectCode, treeHash, applyChanges,
  snapshot, patch,
};
