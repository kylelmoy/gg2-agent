#!/usr/bin/env node
//=============================================================================
// gml-lint.js - check GML before it can freeze the game.
//
// A GML syntax error in execute_string, or in a built exe, raises a modal
// dialog that freezes the game and every pending call, so code is checked
// before it is sent or built. The checking itself is `gm8-builder lint` (see
// gm8.js): GM8's own fnames table for built-ins and their argument counts, the
// split tree for project symbols, gml-extensions.txt for the .gex functions.
// This file is what the rest of the tooling calls, and the defaults that make
// sense for this game: its tree, plus the bridge payload when that is what is
// being linted.
//
// Usage:
//   node tools/gml-lint.js <file-or-dir> [...]   lint files or directories
//   node tools/gml-lint.js --stdin               lint a snippet on stdin
//   (any other gm8-builder lint option passes through: --json, --no-arity, --style, --tree)
//=============================================================================

'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib.js');
const gm8 = require('./gm8.js');

const PAYLOAD = path.resolve(__dirname, '..', 'payload');

// Check a snippet (or, with `xml`, the STRING arguments of an event file)
// against `trees`. Resolves { ok, findings, errors }, or { ok: true, note }
// when linting could not run - a missing tool must never block real work.
function check(code, { trees = [], xml = false, name = '<gml>' } = {}) {
  const list = trees.length ? trees : [lib.resolveGg2Tree(lib.defaultRepo())];
  return gm8.lint(code, { trees: list, xml, name });
}

function main() {
  const argv = process.argv.slice(2);
  const args = ['lint', '--extensions', gm8.EXTENSIONS, '--gm8', gm8.install()];
  if (!argv.includes('--tree')) {
    args.push('--tree', lib.resolveGg2Tree(lib.defaultRepo()));
    // The bridge payload defines scripts that call each other and are not in
    // the game's tree until they are injected; linting it against the game
    // alone would report every one of them as an unknown function.
    if (argv.some((a) => path.resolve(a).startsWith(PAYLOAD))) args.push('--tree', PAYLOAD);
  }
  const r = spawnSync(gm8.exe(), [...args, ...argv], { stdio: 'inherit' });
  process.exit(r.status === null ? 2 : r.status);
}

if (require.main === module) main();
module.exports = { check };
