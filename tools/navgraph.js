//=============================================================================
// navgraph.js - read and reason about the bot nav graph, without a running game.
//
// A Gang Garrison 2 nav graph lives on disk, at
// Source/build/botnav/<map>_a<area>.txt, written by gg2-nav-gen and read by the
// game's navCacheLoad.gml. (Servers used to write these themselves; the
// generator has since moved out of the game entirely.) That file
// plus the map's own PNG is enough to answer "can a bot get from its spawn to
// the objective on this map" with no game, no agent bridge, and no map rotation
// - which is the fastest possible answer to "why are the bots standing still",
// and cheap enough to run over every cached map at once.
//
// This module is the reader and the model. navaudit.js is the checks on top.
//
// WHAT IS FAITHFUL TO THE GAME, AND WHY IT HAS TO BE
//
// Three pieces of game logic are transcribed here rather than approximated,
// because each one has already produced a wrong answer when it was left out:
//
//   navNodeFromWorld  - the +-3 row tolerance and the anchor-column arithmetic.
//                       A node is not "the nearest one"; it is the best-ranked
//                       one inside a tolerance, and the ranking weights height
//                       above horizontal distance.
//   the downward snap - botObjectiveUpdate searches downward from an objective
//                       marker for the first node that resolves, because map
//                       objects are not anchored like Characters. koth_corinth's
//                       control point marker floats 48px above its floor and
//                       koth_harvest's 66px; taking the marker's own y gives -1.
//   navGatePassable   - gates are a per-query cost, not baked into the graph,
//                       and the answer depends on the caller's team AND whether
//                       it is carrying intel. A gate-blind traversal answers
//                       "can a body get there" when the question is "can a BLUE
//                       body get there", and that hid a broken ctf_conflict
//                       behind a passing audit through two revisions.
//
// The constants come out of the game's own Constants.xml rather than being
// copied, so that a NAV_CELL_SIZE or NAV_BOX_W change cannot leave this tool
// quietly measuring the previous geometry.
//
// THE CACHE FORMAT, WHICH IS NOT THE OBVIOUS ONE
//
//   line 1  "navgraph <NAV_CACHE_VERSION>"
//   line 2  "<maskW> <maskH> <nodeCount> <edgeCount>"
//   line 3  ds_grid_write(nodes)   hex
//   line 4  ds_grid_write(edges)   hex
//
// ds_grid_write is a 12-byte header (uint32 601, uint32 width, uint32 height)
// followed by COLUMN-MAJOR cells of SIXTEEN bytes each, with the double sitting
// FOUR bytes into the cell - not 8-byte doubles packed end to end, which is what
// it looks like and what costs an afternoon. Cell (x, y) is at
// 12 + 16*(x*height + y) + 4.
//=============================================================================

const fs = require('fs');
const path = require('path');

const lib = require('./lib');
const walkmaskModule = require('./walkmask');

const CACHE_DIR = path.join('Source', 'build', 'botnav');

const GRID_HEADER = 12;
const GRID_CELL = 16;
const GRID_VALUE_AT = 4;

//---------------------------------------------------------------------------
// Constants, read from the game rather than copied
//---------------------------------------------------------------------------

// Only the ones this tool actually reasons with. A missing name is an error
// rather than a default: a silently-wrong cell size makes every number here
// plausible and wrong, which is the worst failure mode available.
const WANTED = [
  'NAV_CELL_SIZE', 'NAV_BOX_W', 'NAV_BOX_H',
  'NAV_NODE_FIELDS', 'NAV_NODE_Y', 'NAV_NODE_X0', 'NAV_NODE_X1',
  'NAV_NODE_FLAGS', 'NAV_NODE_DOOR', 'NAV_NODE_GATE',
  'NAV_EDGE_FIELDS', 'NAV_EDGE_FROM', 'NAV_EDGE_TO', 'NAV_EDGE_TYPE',
  'NAV_EDGE_BUCKET', 'NAV_EDGE_TICKS', 'NAV_EDGE_COST', 'NAV_EDGE_GATE',
  'NAV_EDGE_TAKEOFF',
  'NAV_EDGE_WALK', 'NAV_EDGE_FALL', 'NAV_EDGE_JUMP', 'NAV_EDGE_DROPTHROUGH',
  'NAV_EDGE_MOVEBOX', 'NAV_EDGE_DOUBLEJUMP', 'NAV_EDGE_ROCKETJUMP',
  'NAV_EDGE_STICKYJUMP',
  'NAV_GATE_NONE', 'NAV_GATE_TEAM_RED', 'NAV_GATE_TEAM_BLUE',
  'NAV_GATE_INTEL_RED', 'NAV_GATE_INTEL_BLUE', 'NAV_GATE_SETUP',
  'NAV_MAX_FALL', 'NAV_CACHE_VERSION',
  'TEAM_RED', 'TEAM_BLUE',
];

let constantCache = null;

function constants(repo = lib.defaultRepo()) {
  if (constantCache && constantCache.repo === repo) return constantCache.values;
  const file = path.join(lib.resolveGg2Tree(repo), 'Constants.xml');
  const xml = fs.readFileSync(file, 'utf8');
  const values = {};
  const re = /<constant\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>/g;
  let m;
  while ((m = re.exec(xml))) values[m[1]] = Number(m[2]);
  const missing = WANTED.filter((k) => !(k in values) || Number.isNaN(values[k]));
  if (missing.length) {
    throw new Error(`Constants.xml is missing or malformed for: ${missing.join(', ')}`);
  }
  constantCache = { repo, values };
  return values;
}

// The character's own physics, for reporting how far a rejected jump was from
// being possible. Not required to read a graph, so a checkout without them is
// not an error - the caller just gets undefined and prints less.
function jumpEnvelope(repo = lib.defaultRepo()) {
  const c = constants(repo);
  const v0 = c.NAV_JUMP_V0;
  const g = c.NAV_JUMP_GRAVITY;
  if (!v0 || !g) return null;
  return { v0, g, maxRise: (v0 * v0) / (2 * g) };
}

//---------------------------------------------------------------------------
// The cache file
//---------------------------------------------------------------------------

function cacheDir(repo = lib.defaultRepo()) {
  return path.join(path.resolve(repo), CACHE_DIR);
}

// Every graph the server has ever built, newest map name order. A key is
// "<map>_a<area>"; multi-area maps (cp_dirtbowl) have one per stage, because
// basicRoomSetup destroys everything outside the active stage's y-band and each
// stage is genuinely a different graph.
function listKeys(repo = lib.defaultRepo()) {
  const dir = cacheDir(repo);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => f.slice(0, -4))
    .sort();
}

const mapOf = (key) => key.replace(/_a\d+$/, '');

function readGrid(hex) {
  const b = Buffer.from(hex, 'hex');
  const version = b.readUInt32LE(0);
  const w = b.readUInt32LE(4);
  const h = b.readUInt32LE(8);
  const need = GRID_HEADER + w * h * GRID_CELL;
  if (b.length < need) {
    throw new Error(`grid truncated: ${b.length} bytes, expected ${need} for ${w}x${h}`);
  }
  const at = (x, y) => b.readDoubleLE(GRID_HEADER + GRID_CELL * (x * h + y) + GRID_VALUE_AT);
  return { version, w, h, at };
}

function load(key, repo = lib.defaultRepo()) {
  const c = constants(repo);
  const file = path.join(cacheDir(repo), `${key}.txt`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  const header = (lines[0] || '').trim().split(/\s+/);
  if (header[0] !== 'navgraph') throw new Error(`${key}: not a nav cache (first line "${lines[0]}")`);
  const version = Number(header[1]);
  // A version mismatch is worth saying out loud rather than refusing: the field
  // layout is what matters and it rarely moves, but a reader that silently
  // accepts a graph built by a different generator is how you end up trusting
  // numbers about geometry that no longer exists.
  const stale = version !== c.NAV_CACHE_VERSION;

  const [maskW, maskH, nodeCount, edgeCount] = lines[1].trim().split(/\s+/).map(Number);
  const nodes = readGrid(lines[2].trim());
  const edges = readGrid(lines[3].trim());
  if (nodes.w !== c.NAV_NODE_FIELDS || edges.w !== c.NAV_EDGE_FIELDS) {
    throw new Error(`${key}: field count ${nodes.w}/${edges.w} does not match the current `
      + `NAV_NODE_FIELDS/NAV_EDGE_FIELDS (${c.NAV_NODE_FIELDS}/${c.NAV_EDGE_FIELDS})`);
  }

  return new NavGraph({ key, repo, c, version, stale, maskW, maskH, nodeCount, edgeCount, nodes, edges });
}

//---------------------------------------------------------------------------
// The graph
//---------------------------------------------------------------------------

class NavGraph {
  constructor(o) {
    Object.assign(this, o);
    this.map = mapOf(o.key);
    this.area = Number((o.key.match(/_a(\d+)$/) || [, 1])[1]);

    const { c, nodes, edges, nodeCount, edgeCount } = o;
    // Materialise once. A few hundred nodes and a few thousand edges is nothing,
    // and every check below wants random access.
    this.node = [];
    for (let i = 0; i < nodeCount; i++) {
      this.node.push({
        i,
        row: nodes.at(c.NAV_NODE_Y, i),
        x0: nodes.at(c.NAV_NODE_X0, i),
        x1: nodes.at(c.NAV_NODE_X1, i),
        flags: nodes.at(c.NAV_NODE_FLAGS, i),
        door: nodes.at(c.NAV_NODE_DOOR, i),
        gate: nodes.at(c.NAV_NODE_GATE, i),
      });
    }
    this.edge = [];
    this.out = Array.from({ length: nodeCount }, () => []);
    this.in = Array.from({ length: nodeCount }, () => []);
    for (let e = 0; e < edgeCount; e++) {
      const rec = {
        e,
        from: edges.at(c.NAV_EDGE_FROM, e),
        to: edges.at(c.NAV_EDGE_TO, e),
        type: edges.at(c.NAV_EDGE_TYPE, e),
        bucket: edges.at(c.NAV_EDGE_BUCKET, e),
        ticks: edges.at(c.NAV_EDGE_TICKS, e),
        cost: edges.at(c.NAV_EDGE_COST, e),
        gate: edges.at(c.NAV_EDGE_GATE, e),
        takeoff: edges.at(c.NAV_EDGE_TAKEOFF, e),
      };
      this.edge.push(rec);
      this.out[rec.from].push(rec);
      this.in[rec.to].push(rec);
    }
  }

  //-- coordinates ---------------------------------------------------------
  // navAnchorCol / navColWorldX. A node's x-span is in anchor columns - the
  // LEFT edge of the NAV_BOX_W-wide body box - while a Character's x is the
  // centre of its sprite. The two are half a box apart, and converting by hand
  // is how a two-cell ledge gets missed entirely.

  anchorCol(worldX) {
    const c = this.c;
    return Math.floor(worldX / c.NAV_CELL_SIZE) - (c.NAV_BOX_W >> 1);
  }

  colWorldX(col) {
    const c = this.c;
    return col * c.NAV_CELL_SIZE + (c.NAV_BOX_W * c.NAV_CELL_SIZE) / 2;
  }

  // The world y of the surface a node stands on.
  floorY(n) {
    const c = this.c;
    return (this.node[n].row + c.NAV_BOX_H) * c.NAV_CELL_SIZE;
  }

  // Where a Character standing on this node has its origin (the chest, feet
  // ~23px below - the same formula botSetGoal uses).
  chestY(n) {
    return this.floorY(n) - 23;
  }

  worldSpan(n) {
    return [this.colWorldX(this.node[n].x0), this.colWorldX(this.node[n].x1)];
  }

  // navNodeFromWorld, transcribed. Neither axis demands an exact hit: a bot
  // mid-step still has to resolve to the surface it is plainly on. Height is
  // weighted above horizontal distance in the tie-break because two surfaces
  // stacked a few rows apart are a much likelier confusion than two side by
  // side. (The rank variable is called rank and not score in the GML because
  // `var score` is a GM8 compilation error - see gg2-agent/GML.md.)
  nodeFromWorld(worldX, worldY) {
    const c = this.c;
    const mx = this.anchorCol(worldX);
    const my = Math.floor((worldY + 23) / c.NAV_CELL_SIZE);
    let best = -1;
    let bestRank = Infinity;
    for (let i = 0; i < this.nodeCount; i++) {
      const n = this.node[i];
      const dy = Math.abs(n.row + c.NAV_BOX_H - my);
      if (dy > 3) continue;
      let dx = 0;
      if (mx < n.x0) dx = n.x0 - mx;
      else if (mx > n.x1) dx = mx - n.x1;
      if (dx > 2) continue;
      const rank = dy * 4 + dx;
      if (rank < bestRank) { bestRank = rank; best = i; }
    }
    return best;
  }

  // botObjectiveUpdate's downward search. Map objects are not anchored the way
  // a Character is and there is no single offset that generalises across object
  // types - koth_corinth's capture zone marker floats 48px above its floor,
  // koth_harvest's 66px. So search downward for the first node that resolves,
  // then derive the goal from THAT node rather than from the original marker,
  // which is what makes the same call resolve the same way every time.
  snapObjective(worldX, worldY) {
    const c = this.c;
    for (let d = 0; d <= c.NAV_MAX_FALL * c.NAV_CELL_SIZE; d += c.NAV_CELL_SIZE) {
      const n = this.nodeFromWorld(worldX, worldY + d);
      if (n >= 0) {
        const col = Math.max(this.node[n].x0, Math.min(this.node[n].x1, this.anchorCol(worldX)));
        return { node: n, drop: d, goalX: this.colWorldX(col), goalY: this.chestY(n) };
      }
    }
    return { node: -1, drop: -1, goalX: worldX, goalY: worldY };
  }

  //-- gates ---------------------------------------------------------------
  // navGatePassable, transcribed. Mirrors charSetSolids, which is the only
  // place the engine decides this:
  //
  //   TeamGate   solid = (team != other.team or other.intel)
  //   IntelGate  solid = (team != other.team and other.intel)
  //
  // Inverted: your own team gate is open UNLESS you are carrying intel out of
  // it, and an enemy intel gate is closed only to a carrier. That first rule is
  // why a CTF return leg is a different query from the outbound one, and why
  // checking only the outbound leg passed a ctf_conflict where red can fetch
  // the flag and then cannot carry it home.
  gatePassable(code, team, hasIntel, setupClosed = false) {
    const c = this.c;
    if (code === c.NAV_GATE_NONE) return true;
    if (code === c.NAV_GATE_TEAM_RED) return team === c.TEAM_RED && !hasIntel;
    if (code === c.NAV_GATE_TEAM_BLUE) return team === c.TEAM_BLUE && !hasIntel;
    if (code === c.NAV_GATE_INTEL_RED) return team === c.TEAM_RED || !hasIntel;
    if (code === c.NAV_GATE_INTEL_BLUE) return team === c.TEAM_BLUE || !hasIntel;
    if (code === c.NAV_GATE_SETUP) return !setupClosed;
    return false; // unknown code: refusing passage is the safe answer
  }

  //-- traversal -----------------------------------------------------------
  // ctx omitted means gate-blind, which answers a different and usually wrong
  // question - it exists only to measure how much a team loses to gates.
  reach(start, ctx = null) {
    if (start < 0) return new Set();
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const at = queue.shift();
      for (const e of this.out[at]) {
        if (ctx) {
          if (!this.gatePassable(e.gate, ctx.team, ctx.hasIntel, ctx.setupClosed)) continue;
          if (!this.gatePassable(this.node[e.to].gate, ctx.team, ctx.hasIntel, ctx.setupClosed)) continue;
        }
        if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
      }
    }
    return seen;
  }

  // Which nodes can reach `target`, following edges backwards. Pairs with
  // reach() to answer "is this a one-way street" - a component you can leave
  // and not re-enter looks identical to a connected one in a forward BFS.
  reachBackward(target, ctx = null) {
    if (target < 0) return new Set();
    const seen = new Set([target]);
    const queue = [target];
    while (queue.length) {
      const at = queue.shift();
      for (const e of this.in[at]) {
        if (ctx) {
          if (!this.gatePassable(e.gate, ctx.team, ctx.hasIntel, ctx.setupClosed)) continue;
          if (!this.gatePassable(this.node[e.from].gate, ctx.team, ctx.hasIntel, ctx.setupClosed)) continue;
        }
        if (!seen.has(e.from)) { seen.add(e.from); queue.push(e.from); }
      }
    }
    return seen;
  }

  edgeTypeName(type) {
    const c = this.c;
    for (const [name, value] of Object.entries({
      walk: c.NAV_EDGE_WALK, fall: c.NAV_EDGE_FALL, jump: c.NAV_EDGE_JUMP,
      drop: c.NAV_EDGE_DROPTHROUGH, movebox: c.NAV_EDGE_MOVEBOX,
      doublejump: c.NAV_EDGE_DOUBLEJUMP, rocketjump: c.NAV_EDGE_ROCKETJUMP,
      stickyjump: c.NAV_EDGE_STICKYJUMP,
    })) if (value === type) return name;
    return `type${type}`;
  }

  gateName(code) {
    const c = this.c;
    for (const [name, value] of Object.entries({
      none: c.NAV_GATE_NONE, redteam: c.NAV_GATE_TEAM_RED, blueteam: c.NAV_GATE_TEAM_BLUE,
      redintel: c.NAV_GATE_INTEL_RED, blueintel: c.NAV_GATE_INTEL_BLUE, setup: c.NAV_GATE_SETUP,
    })) if (value === code) return name;
    return `gate${code}`;
  }

  describe(n) {
    const [wx0, wx1] = this.worldSpan(n);
    const g = this.node[n].gate;
    return `n${n} [row ${this.node[n].row}, world x ${wx0}-${wx1}, floor y ${this.floorY(n)}`
      + `${g ? `, gate ${this.gateName(g)}` : ''}]`;
  }
}

//---------------------------------------------------------------------------
// The map's own entity list, and the terrain under it
//
// Every built-in map ships as a PNG whose zTXt chunk holds the entity list and
// a 1-bit walkmask (F21). Entity coordinates are already WORLD coordinates - no
// x6 conversion, despite the art being 1/6 scale.
//
// Both readers live in walkmask.js, which also renders the mask; these two are
// re-exports so that `nav.levelData`/`nav.walkmask` keep working. There is one
// decoder, not two - they were written independently on 2026-08-22, from the
// same GML, and merged the same day.
//
// Worth knowing the mask is here before reaching for the game: it is the ground
// truth every nav question is really about ("is there a wall at the end of this
// run?", "how tall is that step?"), and it is on disk, so answering one costs no
// server, no map load and no bridge. Solidity only, though - gates, player walls
// and drop-through platforms are instances stamped in at generation time by
// gg2-nav-gen's instances.js and are NOT here; a cell this calls open can still
// be closed to a bot.
//---------------------------------------------------------------------------

const levelData = (map, repo = lib.defaultRepo()) => walkmaskModule.levelData(map, repo);

// { width, height, bits, solid(x, y) } - see walkmask.decode.
const walkmask = (map, repo = lib.defaultRepo()) => walkmaskModule.decode(map, repo);

function entities(map, repo = lib.defaultRepo()) {
  const txt = levelData(map, repo);
  const start = txt.indexOf('{ENTITIES}');
  const end = txt.indexOf('{END ENTITIES}');
  if (start < 0 || end < 0) throw new Error(`${map}: no ENTITIES block`);
  const body = txt.slice(start + '{ENTITIES}'.length, end).trim().replace(/^\[|\]$/g, '');
  return body.split('},{').map((chunk) => {
    const out = {};
    for (const pair of chunk.replace(/[{}]/g, '').split(',')) {
      const i = pair.indexOf(':');
      if (i < 0) continue;
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      out[k] = v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    }
    return out;
  });
}

//---------------------------------------------------------------------------
// Game mode, inferred the way the game infers it
//
// There is no stored mode (F25) - basicRoomSetup and botObjectiveUpdate both
// decide from which objects exist, so this decides from which entities exist,
// in the same order. Getting the order wrong matters: DKOTH has to be tested
// before the generic control-point branch, because "nearest unlocked point" is
// the wrong answer there - each team caps the OTHER team's point.
//---------------------------------------------------------------------------

const has = (ents, ...types) => ents.some((e) => types.includes(e.type));

function gameMode(ents) {
  if (has(ents, 'redintel', 'blueintel')) return 'ctf';
  if (has(ents, 'GeneratorRed', 'GeneratorBlue')) return 'generator';
  if (has(ents, 'KothRedControlPoint') && has(ents, 'KothBlueControlPoint')) return 'dkoth';
  if (has(ents, 'KothControlPoint', 'ArenaControlPoint',
    'controlPoint1', 'controlPoint2', 'controlPoint3', 'controlPoint4', 'controlPoint5')) return 'cp';
  return 'tdm';
}

// What a bot of this team is told to walk to, as world points, in the order
// botObjectiveUpdate would pick them. Locked control points are skipped by the
// real script and cannot be known from disk, so every point is returned and the
// caller reports on all of them.
function objectives(ents, mode, team, c) {
  const red = team === c.TEAM_RED;
  const pick = (...types) => ents.filter((e) => types.includes(e.type));

  if (mode === 'ctf') {
    return {
      // Not carrying: the enemy's flag. Carrying: your own BASE - the fixed
      // spawn spot, not Intelligence{ownTeam}, which moves once an enemy picks
      // it up. The shipped code has this right.
      outbound: pick(red ? 'blueintel' : 'redintel').map((e) => ({ ...e, role: 'enemy intel' })),
      home: pick(red ? 'redintel' : 'blueintel').map((e) => ({ ...e, role: 'own intel base' })),
    };
  }
  if (mode === 'generator') {
    return { outbound: pick(red ? 'GeneratorBlue' : 'GeneratorRed').map((e) => ({ ...e, role: 'enemy generator' })) };
  }
  if (mode === 'dkoth') {
    return { outbound: pick(red ? 'KothBlueControlPoint' : 'KothRedControlPoint').map((e) => ({ ...e, role: 'enemy point' })) };
  }
  if (mode === 'cp') {
    // botObjectiveUpdate walks to the CaptureZone bound to the point, not the
    // point sprite - they are different instances at different places (F26).
    // The map calls the zone "CapturePoint".
    const zones = pick('CapturePoint').map((e) => ({ ...e, role: 'capture zone' }));
    if (zones.length) return { outbound: zones };
    return {
      outbound: pick('KothControlPoint', 'ArenaControlPoint',
        'controlPoint1', 'controlPoint2', 'controlPoint3', 'controlPoint4', 'controlPoint5')
        .map((e) => ({ ...e, role: 'control point' })),
    };
  }
  return {};
}

function spawns(ents, team, c) {
  return ents.filter((e) => e.type === (team === c.TEAM_RED ? 'redspawn' : 'bluespawn'));
}

module.exports = {
  constants, jumpEnvelope,
  cacheDir, listKeys, mapOf, load, NavGraph,
  levelData, walkmask, entities, gameMode, objectives, spawns,
};
