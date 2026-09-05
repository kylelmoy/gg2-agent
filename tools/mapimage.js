#!/usr/bin/env node
//=============================================================================
// mapimage.js - one picture of a map, built one way.
//
// The map's own Included Files/<name>.png is the whole source: the art is the
// image, and the collision mask is a zTXt chunk inside the same file (see
// walkmask.js). Nothing here asks a running game anything, so there is no
// camera, no window-resolution cap and nothing to stitch.
//
// Coordinates are map pixels throughout. The mask is one bit per 6x6 world
// pixels, which is what walkmask.js scales by, so a mask base layer lines up
// with the art without conversion.
//
// This also drew a bot nav-graph overlay, shared between an offline CLI and the
// live gg2_map_image so the two could not drift - they had, by 6 cells, and that
// is what the sharing fixed. Both consumers went with the bot layer when the
// fork was replaced by the upstream reference checkout; gg2-server owns bot
// navigation now. `git show d346b8a^:tools/mapimage.js` has the overlay code.
//
// Usage: a module only - gg2_map_image is the tool.
//=============================================================================

const fs = require('fs');

const lib = require('./lib');
const img = require('./image');
const walkmask = require('./walkmask');

//---------------------------------------------------------------------------
// The base layer
//---------------------------------------------------------------------------

// A picture asking what the map looks like should be of the art; a picture
// asking what a body can stand on should be of the mask, since the art paints
// scenery nothing collides with and draws real geometry as though it were
// background. `koth_valley` is the plain case - a night scene whose underground
// is nearly black, in which two vertical shafts are invisible in the art and
// obvious in the mask. Neither is a good default for the other question, which
// is why the caller passes the question and not the answer.
const BASES = ['art', 'mask', 'both'];

function basePicture(map, repo, base = 'art') {
  if (!BASES.includes(base)) {
    throw new Error(`base wants ${BASES.map((b) => `"${b}"`).join(', ')}, not "${base}"`);
  }
  const file = walkmask.mapFile(map, repo);
  if (!fs.existsSync(file)) {
    throw new Error(
      `no map art at ${file} - custom (player-uploaded) maps are not resolvable from disk yet, ` +
        'only maps shipped in this repo'
    );
  }
  const art = img.decodePng(fs.readFileSync(file));
  if (base === 'art') return { width: art.width, height: art.height, rgba: Buffer.from(art.rgba) };

  const mask = walkmask.decode(map, repo);
  const picture = base === 'both' ? walkmask.tint(art, mask) : walkmask.toRgba(mask);
  return { width: picture.width, height: picture.height, rgba: Buffer.from(picture.rgba) };
}

//---------------------------------------------------------------------------
// Framing
//---------------------------------------------------------------------------

function crop(picture, x0, y0, x1, y1) {
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) throw new Error('crop wants x0,y0,x1,y1 with x1>x0 and y1>y0');
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    picture.rgba.copy(rgba, y * w * 4, ((y0 + y) * picture.width + x0) * 4, ((y0 + y) * picture.width + x1) * 4);
  }
  return { width: w, height: h, rgba };
}

function scaled(picture, scale = 1) {
  if (!Number.isInteger(scale) || scale < 1) throw new Error('scale must be a positive integer');
  if (scale === 1) return picture;
  return img.scaleNearest(picture.width, picture.height, picture.rgba, scale);
}

function toPng(picture) {
  return img.encodePngRgba(picture.width, picture.height, picture.rgba);
}

module.exports = { basePicture, crop, scaled, toPng, BASES };
