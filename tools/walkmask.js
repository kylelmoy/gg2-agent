#!/usr/bin/env node
//=============================================================================
// walkmask.js - the collision mask a map is actually made of, read off disk.
//
// A GG2 map PNG carries more than its art. The level data - entities and the
// walkmask - is deflated into a zTXt chunk keyed "Gang Garrison 2 Level Data",
// which is how the game itself loads a custom map (Scripts/Maps/CustomMaps).
// So the mask is available with no game running, at exactly the resolution the
// art is.
//
// That matters because the art is decorative and the mask is the truth. Every
// question about movement - what is this player standing on, is that gap
// crossable, why can nobody get up there - is a question about the mask; the art
// answers it only when the two happen to agree, and they routinely do not
// (painted-on scenery that nothing collides with, and blocking geometry that is
// drawn as background). Rendering the mask instead of the art removes an entire
// class of wrong guess from looking at these pictures.
//
// Encoding (Scripts/Maps/CustomMaps/compressWalkmask.gml):
//
//   {WALKMASK}\n<width>\n<height>\n<data>\n{END WALKMASK}
//
// <data> is one continuous bitstream, row-major, six bits per character, most
// significant bit first, each character stored as chr(value + 32) - printable
// ASCII. Rows are not padded: the stream runs on from one row into the next,
// and only the very last character is padded out with zeros.
//
// A mask cell is one map pixel and six world px, so nothing here needs
// converting. Verified against the running game
// on ctf_avanti: a 35x30 cell window came back identical, cell for cell, to
// collision_point against the live CollisionDummy.
//
// ⚠️ Solidity only. Gates, player walls and drop-through platforms are
// instances listed in the same chunk's entity section, not bits in the mask,
// so a cell this calls open can still be closed to whoever is asking.
//
// Usage:
//   node tools/walkmask.js koth_valley out.png [--scale 3]
//=============================================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const lib = require('./lib');
const img = require('./image');

const KEYWORD = 'Gang Garrison 2 Level Data';

const USAGE = `
walkmask.js - render a map's collision mask, black on white

  node tools/walkmask.js <map> <out.png> [--scale <n>] [--repo <path>]

  --scale <n>   nearest-neighbour upscale, default 3
  --repo <path> the Gang Garrison 2 checkout (default: GG2_REPO, else the
                one you are in, else ../Gang-Garrison-2)

  Solid is dark, open is light. This is what the game collides against;
  the map art is only decoration over it.
`;

// The map's own PNG, as the game ships it.
function mapFile(map, repo) {
  return path.join(path.resolve(repo || lib.defaultRepo()), 'Source', 'gg2', 'Included Files', `${map}.png`);
}

// The whole level-data text - entities as well as the mask - out of a map's PNG.
//
// Throws rather than returning empty for a map it cannot find: a custom
// (player-uploaded) map has no fixed path on disk, and an empty entity list
// reads as "this map has no objective", which is a far more confusing answer.
function levelData(map, repo) {
  const file = mapFile(map, repo);
  if (!fs.existsSync(file)) {
    throw new Error(
      `no built-in map art at ${file} - custom (player-uploaded) maps are not resolvable from disk, ` +
        'only maps shipped in this repo'
    );
  }
  const png = fs.readFileSync(file);

  let o = 8; // past the signature
  while (o + 8 <= png.length) {
    const len = png.readUInt32BE(o);
    const type = png.slice(o + 4, o + 8).toString('latin1');
    if (type === 'zTXt') {
      const data = png.slice(o + 8, o + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0 && data.slice(0, nul).toString('latin1') === KEYWORD) {
        // byte after the keyword's NUL is the compression method (0 = deflate)
        return zlib.inflateSync(data.slice(nul + 2)).toString('latin1');
      }
    }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  throw new Error(`${path.basename(file)} carries no "${KEYWORD}" chunk`);
}

// { width, height, bits, solid(x, y) } for a map: bits[y * width + x] is 1 where
// the world is solid, and solid() is the same thing bounds-checked, for callers
// that ask about a handful of cells rather than walking the whole grid. Throws
// with something actionable rather than returning a half-answer - a caller
// drawing a blank mask over a real map would not notice.
function decode(map, repo) {
  const text = levelData(map, repo);

  const m = /\{WALKMASK\}\n(\d+)\n(\d+)\n([\s\S]*?)\n\{END WALKMASK\}/.exec(text);
  if (!m) throw new Error(`${map}'s level data has no {WALKMASK} block`);

  const width = Number(m[1]);
  const height = Number(m[2]);
  const packed = m[3];
  const bits = Buffer.alloc(width * height);

  let at = 0;
  for (let i = 0; i < packed.length && at < bits.length; i++) {
    const six = packed.charCodeAt(i) - 32;
    for (let b = 5; b >= 0 && at < bits.length; b--) bits[at++] = (six >> b) & 1;
  }
  if (at < bits.length) {
    throw new Error(`${map}'s walkmask is short: ${at} of ${width * height} cells decoded`);
  }

  const solid = (x, y) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : bits[y * width + x];
  return { width, height, bits, solid };
}

// The mask as an image, ready to be drawn on. Light where a character can
// stand, dark where it cannot - the same way round as looking at the map, and
// far enough from the overlay's saturated red/green that neither is mistaken
// for the other.
const SOLID = [44, 48, 56];
const OPEN = [242, 244, 248];

function toRgba({ width, height, bits }) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < bits.length; i++) {
    const c = bits[i] ? SOLID : OPEN;
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

// The mask blended into a picture that is already of the same world, for when
// both questions are being asked at once: the art stays recognisable and
// everything solid is tinted, so a gap between "what is drawn" and "what
// collides" shows up as a mismatch rather than having to be remembered between
// two pictures.
//
// `cell` is how many of the image's pixels one mask cell covers, and
// origin is where the image's top-left corner sits in those same units - so
// map art is cell 1 at (0, 0), and a live screenshot is cell 6 (always: six
// world pixels to a mask cell) at the world coordinate the capture started
// from. That is the whole coordinate conversion, and it is exact in both
// directions rather than a resample.
// `only: 'solid'` leaves open space exactly as it came, which is what a
// picture of the *live* game wants: everything worth looking at in one of those
// - players, projectiles, a capture in progress - is in the open, and washing
// it out to show it is not solid says nothing anyone did not already know.
function tint(image, mask, { cell = 1, originX = 0, originY = 0, strength = 0.55, only = 'both' } = {}) {
  const { width, height } = image;
  const rgba = Buffer.from(image.rgba);
  for (let y = 0; y < height; y++) {
    const my = Math.floor((originY + y) / cell);
    for (let x = 0; x < width; x++) {
      const mx = Math.floor((originX + x) / cell);
      // Off the edge of the mask is off the map: leave it as it came.
      if (mx < 0 || my < 0 || mx >= mask.width || my >= mask.height) continue;
      const solid = mask.bits[my * mask.width + mx];
      if (only === 'solid' && !solid) continue;
      const c = solid ? SOLID : OPEN;
      const at = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) {
        rgba[at + k] = Math.round(rgba[at + k] * (1 - strength) + c[k] * strength);
      }
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}

// The line where solid meets open, drawn over a picture of the same world.
//
// This is the form that works over a *live* screenshot, where a wash does not:
// GG2's maps are painted dark and detailed, so tinting solid ground either
// disappears into the art or hides what the shot was taken for. An outline
// costs one world pixel per boundary and covers nothing, which turns out to be
// exactly the question anyone has of a live picture - where can a character
// stand, what is that player stuck on - rather than "which half of the screen is
// rock".
//
// The edge is drawn on the solid side, on the cell's own outermost pixel row or
// column, so it traces the real collision boundary rather than approximating it.
const EDGE = [255, 0, 200];

function outline(image, mask, { cell = 1, originX = 0, originY = 0, color = EDGE } = {}) {
  const { width, height } = image;
  const rgba = Buffer.from(image.rgba);
  const solidAt = (cx, cy) =>
    cx >= 0 && cy >= 0 && cx < mask.width && cy < mask.height ? mask.bits[cy * mask.width + cx] : 0;
  const mod = (v, m) => ((v % m) + m) % m;

  for (let y = 0; y < height; y++) {
    const wy = originY + y;
    const cy = Math.floor(wy / cell);
    for (let x = 0; x < width; x++) {
      const wx = originX + x;
      const cx = Math.floor(wx / cell);
      if (!solidAt(cx, cy)) continue;
      const ox = mod(wx, cell);
      const oy = mod(wy, cell);
      const edge =
        (ox === 0 && !solidAt(cx - 1, cy)) ||
        (ox === cell - 1 && !solidAt(cx + 1, cy)) ||
        (oy === 0 && !solidAt(cx, cy - 1)) ||
        (oy === cell - 1 && !solidAt(cx, cy + 1));
      if (!edge) continue;
      const at = (y * width + x) * 4;
      rgba[at] = color[0];
      rgba[at + 1] = color[1];
      rgba[at + 2] = color[2];
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}

async function main() {
  const { flags, positional } = lib.parseArgs(process.argv.slice(2), ['repo', 'scale']);
  if (flags.help || positional.length < 2) lib.helpAndExit(USAGE);

  const mask = decode(positional[0], flags.repo);
  let out = toRgba(mask);
  const scale = Number(flags.scale || 3);
  if (scale > 1) out = img.scaleNearest(out.width, out.height, out.rgba, scale);
  fs.writeFileSync(positional[1], img.encodePngRgba(out.width, out.height, out.rgba));

  const solid = mask.bits.reduce((n, b) => n + b, 0);
  lib.ok(
    `${positional[0]}: ${mask.width}x${mask.height} mask, ${((100 * solid) / mask.bits.length).toFixed(1)}% solid ` +
      `-> ${positional[1]} (${out.width}x${out.height})`
  );
}

if (require.main === module) lib.cli(main);

module.exports = { decode, toRgba, tint, outline, levelData, mapFile, SOLID, OPEN, EDGE };
