#!/usr/bin/env node
//=============================================================================
// navimage.js - draw the nav graph over the map's own art.
//
// Renders Included Files/<map>.png at native resolution with one bar per node,
// green if a start point can reach it and red if not. A nav cell is exactly one
// map pixel (NAV_CELL_SIZE and the map art's x6 world scale are the same 6), so
// the overlay needs no coordinate conversion at all - which is the whole reason
// this reads the PNG off disk instead of screenshotting the camera. No window
// resolution cap, no aspect-ratio warping, nothing to stitch.
//
// ⚠️ WHAT THIS IS GOOD FOR, AND WHAT IT WILL LIE TO YOU ABOUT.
//
// It is very good at "are these two regions connected" - a clean red/green
// boundary is visible instantly and reading it took one look to establish that
// koth_corinth's control point is not reachable from spawn.
//
// It is actively misleading about WHY. The same picture suggested corinth
// needed some exotic jump across a gap; the edge lists showed an ordinary ramp
// with every edge present except one, running one-way downhill. An asymmetric
// edge list - outgoing edges to a neighbour with none coming back - is one line
// of text and is invisible in any image, at any zoom.
//
// So: use this to find WHERE to look, then use navaudit.js --node and --gaps to
// find out what is actually wrong. Do not form a theory from the picture.
//
// Usage:
//   node navimage.js koth_corinth out.png
//   node navimage.js koth_corinth out.png --crop 228,100,300,145 --scale 14
//   node navimage.js ctf_conflict out.png --team blue
//=============================================================================

const fs = require('fs');

const lib = require('./lib');
const img = require('./image');
const nav = require('./navgraph');

const USAGE = `
navimage.js - the nav graph drawn over the map art

  node navimage.js <map|key> <out.png> [options]

  --team red|blue      respect that team's gates when deciding reachability
                       (default: red). Omit --team and pass --nogates for the
                       gate-blind traversal, which answers a different question.
  --nogates            ignore gates entirely
  --from <x>,<y>       world position to measure reachability from
                       (default: that team's first spawn)
  --crop <x0,y0,x1,y1> map-pixel rectangle to render (default: the whole map).
                       Map pixels are world/6.
  --scale <n>          nearest-neighbour upscale, default 3
  --repo <path>        the Gang Garrison 2 checkout
  --help

  green = reachable from the start, red = not.
`;

function render(key, outPath, opts = {}) {
  const repo = opts.repo || lib.defaultRepo();
  const g = nav.load(key, repo);
  const c = g.c;
  const ents = nav.entities(g.map, repo);

  const team = opts.team === 'blue' ? c.TEAM_BLUE : c.TEAM_RED;
  const ctx = opts.nogates ? null : { team, hasIntel: false, setupClosed: false };

  let start;
  if (opts.from) {
    const [fx, fy] = opts.from.split(',').map(Number);
    start = g.snapObjective(fx, fy).node;
  } else {
    const s = nav.spawns(ents, team, c)[0];
    if (!s) throw new Error(`${g.map} has no ${team === c.TEAM_RED ? 'red' : 'blue'} spawn; pass --from x,y`);
    start = g.snapObjective(s.x, s.y).node;
  }
  if (start < 0) throw new Error('the start point does not resolve to any node');

  const seen = g.reach(start, ctx);

  const src = img.decodePng(fs.readFileSync(
    require('path').join(require('path').resolve(repo), 'Source', 'gg2', 'Included Files', `${g.map}.png`),
  ));
  const { width: W, height: H } = src;
  const rgba = Buffer.from(src.rgba);
  const put = (x, y, r, gr, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    rgba[i] = r; rgba[i + 1] = gr; rgba[i + 2] = b; rgba[i + 3] = 255;
  };

  // One bar per node, along the row its feet are on. The span is drawn out to
  // x1 + NAV_BOX_W - 1 because a node's span is in anchor columns (the left edge
  // of the body) and the body is NAV_BOX_W wide - drawing only to x1 makes every
  // surface look three cells shorter than a character can actually stand on.
  for (let i = 0; i < g.nodeCount; i++) {
    const n = g.node[i];
    const row = n.row + c.NAV_BOX_H;
    const ok = seen.has(i);
    for (let col = n.x0; col <= n.x1 + c.NAV_BOX_W - 1; col++) {
      put(col, row, ok ? 0 : 255, ok ? 255 : 0, 0);
    }
  }

  let out = { width: W, height: H, rgba };
  if (opts.crop) {
    const [x0, y0, x1, y1] = opts.crop.split(',').map(Number);
    const cw = x1 - x0;
    const ch = y1 - y0;
    if (cw <= 0 || ch <= 0) throw new Error('--crop wants x0,y0,x1,y1 with x1>x0 and y1>y0');
    const buf = Buffer.alloc(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      rgba.copy(buf, y * cw * 4, ((y0 + y) * W + x0) * 4, ((y0 + y) * W + x1) * 4);
    }
    out = { width: cw, height: ch, rgba: buf };
  }

  const scale = Number(opts.scale || 3);
  if (scale > 1) out = img.scaleNearest(out.width, out.height, out.rgba, scale);

  fs.writeFileSync(outPath, img.encodePngRgba(out.width, out.height, out.rgba));
  return { key: g.key, start, reached: seen.size, nodes: g.nodeCount, width: out.width, height: out.height };
}

async function main() {
  const { flags, positional } = lib.parseArgs(
    process.argv.slice(2), ['repo', 'team', 'from', 'crop', 'scale'],
  );
  if (flags.help || positional.length < 2) lib.helpAndExit(USAGE);

  const repo = flags.repo || lib.defaultRepo();
  const want = positional[0];
  const keys = nav.listKeys(repo);
  const key = keys.includes(want) ? want
    : keys.includes(`${want}_a1`) ? `${want}_a1`
      : keys.find((k) => nav.mapOf(k) === want);
  if (!key) throw new Error(`no cached graph for "${want}". Cached: ${keys.join(', ') || '(none)'}`);

  const r = render(key, positional[1], { ...flags, repo });
  lib.ok(`${r.key}: ${r.reached}/${r.nodes} reachable from n${r.start} `
    + `-> ${positional[1]} (${r.width}x${r.height})`);
}

if (require.main === module) lib.cli(main);

module.exports = { render };
