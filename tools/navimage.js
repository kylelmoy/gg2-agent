#!/usr/bin/env node
//=============================================================================
// navimage.js - draw the nav graph over the map's own collision mask.
//
// Renders Included Files/<map>.png at native resolution with one bar per node,
// green if a start point can reach it and red if not. A nav cell is exactly one
// map pixel (NAV_CELL_SIZE and the map art's x6 world scale are the same 6), so
// the overlay needs no coordinate conversion at all - which is the whole reason
// this reads the PNG off disk instead of screenshotting the camera. No window
// resolution cap, no aspect-ratio warping, nothing to stitch.
//
// The base layer is the walkmask, not the art (--base art for the art, --base
// both for the two blended). The graph is built against the mask and nothing
// else, so the art can only ever agree with the picture by coincidence: it
// paints scenery nothing collides with, and draws solid geometry as though it
// were background. koth_valley is the plain case - a dark night scene whose
// underground is nearly black, in which the two vertical shafts that cost this
// project a bug are invisible, and which the mask shows at a glance.
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
const nav = require('./navgraph');
const mapimage = require('./mapimage');

const USAGE = `
navimage.js - the nav graph drawn over the map's collision mask

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
  --base mask|art|both what to draw the graph over (default: mask). The graph
                       is built against the walkmask; the art is decoration.
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

  // The base layer is the mask here and the art in gg2_map_image, because the
  // CLI is reached for to answer a nav question and the tool is reached for to
  // answer both. Everything past this point is the same picture, drawn once.
  let picture = mapimage.basePicture(g.map, repo, opts.base || 'mask');
  mapimage.overlayNodes(
    picture,
    Array.from({ length: g.nodeCount }, (_, i) => ({
      row: g.node[i].row + c.NAV_BOX_H,
      x0: g.node[i].x0,
      x1: g.node[i].x1,
      reached: seen.has(i),
    })),
    { repo },
  );

  if (opts.crop) {
    const [x0, y0, x1, y1] = opts.crop.split(',').map(Number);
    picture = mapimage.crop(picture, x0, y0, x1, y1);
  }
  picture = mapimage.scaled(picture, Number(opts.scale || 3));

  fs.writeFileSync(outPath, mapimage.toPng(picture));
  return { key: g.key, start, reached: seen.size, nodes: g.nodeCount, width: picture.width, height: picture.height };
}

async function main() {
  const { flags, positional } = lib.parseArgs(
    process.argv.slice(2), ['repo', 'team', 'from', 'crop', 'scale', 'base'],
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
