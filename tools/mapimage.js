#!/usr/bin/env node
//=============================================================================
// mapimage.js - one picture of a map, built one way.
//
// A nav-graph overlay was being drawn twice: once in navimage.js against a
// graph read off disk, once in gg2-mcp-server.js's gg2_map_image against a live
// agentNavDump(). Same base art, same mask tinting, same node bars, same
// nearest-neighbour scale - and, by 2026-08-22, no longer the same picture. The
// offline one drew each node's span out to `x1 + NAV_BOX_W - 1`; the live one
// stopped at `x1`, so every surface in the MCP overlay came out three cells
// short of the same surface in the CLI overlay.
//
// The two questions really are different - "what does the cached graph reach"
// and "what does the running game reach" - but the drawing is not, so the
// drawing lives here and the callers bring their own nodes.
//
// Coordinates are map pixels throughout, which are also nav cells: NAV_CELL_SIZE
// is the same 6 the game scales map pixels to world pixels by, so an overlay
// needs no unit conversion at all.
//
// Usage: a module only - navimage.js is the CLI, gg2_map_image is the tool.
//=============================================================================

const fs = require('fs');

const lib = require('./lib');
const img = require('./image');
const walkmask = require('./walkmask');
const nav = require('./navgraph');

//---------------------------------------------------------------------------
// The base layer
//---------------------------------------------------------------------------

// The nav graph is built against the walkmask and nothing else, so a picture
// asking a nav question should be of the mask. A picture asking what the map
// looks like should be of the art. Neither is a good default for the other
// question, which is why the caller passes the question and not the answer.
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
// The node bars
//---------------------------------------------------------------------------

const REACHED = [0, 255, 0, 255];
const UNREACHED = [255, 0, 0, 255];
const UNKNOWN = [80, 140, 255, 255];

// One bar per node, on the row its feet are on.
//
// `row` is the floor row (the node's own Y plus NAV_BOX_H) - the same "where the
// feet are" row botSetGoal's own callers use, and what agentNavDump already
// sends, so neither caller has to know NAV_BOX_H.
//
// The span runs to `x1 + NAV_BOX_W - 1` because a node's span is in *anchor*
// columns - the left edge of the body - and the body is NAV_BOX_W wide. Drawing
// only to x1 makes every surface look three cells shorter than a character can
// actually stand on, which is what the MCP copy of this used to do.
//
// `reached` is true, false, or null for "nothing has been asked yet", which is
// drawn as a third colour rather than silently guessing green or red.
function overlayNodes(picture, nodes, { repo, thickness = 2 } = {}) {
  const boxW = nav.constants(repo || lib.defaultRepo()).NAV_BOX_W;
  const { width, height, rgba } = picture;

  const put = (x, y, colour) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 4;
    rgba[at] = colour[0];
    rgba[at + 1] = colour[1];
    rgba[at + 2] = colour[2];
    rgba[at + 3] = colour[3];
  };

  for (const n of nodes) {
    const colour = n.reached === true ? REACHED : n.reached === false ? UNREACHED : UNKNOWN;
    for (let x = n.x0; x <= n.x1 + boxW - 1; x++) {
      // Upward from the feet row: the extra rows are inside the body, which is
      // air, so a thicker bar never covers geometry the picture was taken for.
      for (let t = 0; t < thickness; t++) put(x, n.row - t, colour);
    }
  }
  return picture;
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

module.exports = { basePicture, overlayNodes, crop, scaled, toPng, BASES, REACHED, UNREACHED, UNKNOWN };
