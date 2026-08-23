//=============================================================================
// navfollow.js - which edges does the graph promise that the FOLLOWER cannot fly?
//
// navaudit asks whether a route exists. navsuspects asks whether it is priced
// honestly. Both read the graph and only the graph, and both were green for the
// whole life of every jump-edge bug this project has had - because the graph was
// never the thing that was wrong. What was wrong was the gap between the arc the
// generator PROVED and the arc botPathKeys can actually make a character fly.
//
// That gap has a shape, and it is arithmetic:
//
//   navJumpTakeoff proves an arc as a CONSTANT horizontal velocity vx, applied
//   from the takeoff column at tick 0. It records vx on the edge (NAV_EDGE_BUCKET)
//   and the airtime beside it (NAV_EDGE_TICKS), and every clearance cell it
//   checked is about that arc and no other.
//
//   A GG2 character has no constant velocity. It accelerates:
//
//       hspeed = (hspeed + runPower * controlFactor) / baseFriction
//
//   which converges on basemaxspeed geometrically and is at zero when the bot is
//   standing still. botPathKeys' in-flight tracker presses toward where the plan
//   says the bot should be by now, so it catches up - but only out of the surplus
//   between the arc's vx and the class's own ceiling. An arc that asks for most of
//   that ceiling has no surplus, the deficit built up over the acceleration ramp
//   is never repaid, and the bot lands short. Every tick of it.
//
// So this replays the follower's own law, offline, against every jump edge in a
// cached graph, and reports how far short of the landing it comes down. No game,
// no bridge, no map rotation: a whole map in well under a second.
//
// WHAT DECIDES THE TAKEOFF SPEED, AND WHY THE SOURCE NODE'S WIDTH IS THE ANSWER
//
// The follower does not leave at whatever speed it likes. Two rules bound it:
//
//   - the gate refuses to jump while vAlong > needVx + BOT_JUMP_VTOL, so a bot
//     cannot leave faster than the arc asks for - it brakes instead;
//   - the run-up is BOT_RUNUP_CELLS of continuous floor behind the takeoff
//     column, found by following WALK edges out of the source node (botRunupCol).
//     A walk edge is one continuous surface by construction - a same-row touch, or
//     a one-cell step that characterHitObstacle takes for free while keeping
//     hspeed - so a chain of them is exactly what runupSpeed models.
//
// ⚠️ That second rule USED to stop at the source node: botPathKeys clamped the
// run-up into [x0, x1] of the node the bot was standing on, so a ONE-COLUMN node -
// the top step of a staircase - offered no run-up at all and every arc leaving it
// started from a standstill. That clamp was the bug this tool was written to find,
// and it is fixed. Modelled here first: it takes a Heavy's unflyable edges from
// 3310 to 253 across all twenty-three cached graphs, and koth_gallery's 105 to 0.
// The CAP is not what matters - 6, 10, 14, 20, 30 and unbounded cells all give 253,
// because the gate refuses to leave faster than needVx + BOT_JUMP_VTOL and six
// cells already reaches that on almost every arc. Being allowed to leave the node
// is the whole fix.
//
// Hence two numbers per edge, and the pair is the finding:
//
//   best   full run-up across the walk-connected floor, then the gate's cap
//   worst  a standstill at the takeoff column - which is what a bot that arrived
//          by jump, and had no time to back up, actually gets
//
// An edge that fails at `best` is a fiction for every bot that ever tries it.
// An edge that only fails at `worst` is flown by a bot with room to build speed
// and missed by a bot that has just landed on the takeoff column, which is the
// intermittent kind and the reason a live scenario "flakes".
//
// AND THE HARD CEILING, WHICH NEEDS NO SIMULATION AT ALL
//
// vx > basemaxspeed for the class is unflyable at any run-up from any state, and
// the generator never checks it: NAV_JUMP_VX (4.53) is Heavy's ceiling and is
// used to budget wall contact, not to reject arcs. Those edges are reported as
// IMPOSSIBLE rather than as a shortfall, because no follower change can fix one.
//
// CLASSES ARE NOT THE SAME BOT, AND THE GRAPH IS CLASS-BLIND
//
// basemaxspeed = baseRunPower * baseControl / (baseFriction - 1), so Heavy tops
// out at 4.53 and Scout at 7.93 - a 75% spread over the same graph. One graph is
// handed to every class, so an arc is only honest if the SLOWEST class that will
// be asked to fly it can. --class picks which one to model; the default is heavy,
// because Heavy is the one that decides whether the edge is a lie.
//=============================================================================

const lib = require('./lib');
const nav = require('./navgraph');

// Character.Create: baseControl 0.85, baseFriction 1.15, and
// basemaxspeed = abs(baseRunPower * baseControl / (baseFriction - 1)).
const BASE_CONTROL = 0.85;
const BASE_FRICTION = 1.15;
// Character.Begin Step: below this, an uncontrolled character is snapped to rest.
const REST_SPEED = 0.195;

// Objects/Characters/<Class>.events/Create.xml, baseRunPower.
const RUN_POWER = {
  heavy: 0.8, soldier: 0.9, sniper: 0.9, demoman: 1, engineer: 1,
  quote: 1.07, spy: 1.08, medic: 1.09, pyro: 1.1, scout: 1.4,
};

function profile(name) {
  const runPower = RUN_POWER[name];
  if (runPower === undefined) {
    throw new Error(`unknown class ${name} (have ${Object.keys(RUN_POWER).join(', ')})`);
  }
  return {
    name,
    runPower,
    accel: runPower * BASE_CONTROL,
    maxSpeed: Math.abs(runPower * BASE_CONTROL / (BASE_FRICTION - 1)),
  };
}

//---------------------------------------------------------------------------
// One tick of Character.Begin Step's horizontal motion. `press` is -1, 0 or +1.
//
// The order is the game's: the run key adds first and only while under the cap,
// friction divides unconditionally afterwards (baseFriction and frictionFactor
// are both 1.15 on an unmodified character), and the rest snap applies only when
// nothing is held. GM8 then applies hspeed to x.
function tick(hspeed, press, p) {
  if (press > 0 && hspeed <= p.maxSpeed) hspeed += p.accel;
  else if (press < 0 && hspeed >= -p.maxSpeed) hspeed -= p.accel;
  hspeed /= BASE_FRICTION;
  if (Math.abs(hspeed) < REST_SPEED && press === 0) hspeed = 0;
  return hspeed;
}

// The speed a character has after covering `dist` px of run-up from rest. The
// follower walks to the takeoff column and jumps from it, so what matters is
// what it is carrying when it arrives, not how long it took.
function runupSpeed(dist, p) {
  let v = 0;
  let x = 0;
  for (let i = 0; i < 240 && x < dist; i++) {
    v = tick(v, 1, p);
    x += v;
  }
  return v;
}

//---------------------------------------------------------------------------
// botPathKeys' in-flight tracker, replayed. The bot presses toward where the
// plan says it should be by now and brakes when it is ahead, which is a pure
// 1-D problem: the arc's height was proven by the generator and the tracker
// never touches it.
//
//   jumpWantX = takeoffX + dir * min(needVx * ticks, needVx * airTicks)
//
// with airTicks at 1 on the first airborne tick, and a one-pixel dead band.
function flyJump(needVx, ticks, v0, p) {
  const total = needVx * ticks;
  let v = v0;
  let x = 0;
  const n = Math.max(1, Math.round(ticks));
  for (let air = 1; air <= n; air++) {
    const want = Math.min(total, needVx * air);
    let press = 0;
    if (x < want - 1) press = 1;
    else if (x > want + 1) press = -1;
    v = tick(v, press, p);
    x += v;
  }
  return x;
}

//---------------------------------------------------------------------------
// botRunupCol, replayed: cells of continuous floor behind `takeoff`, heading away
// from the jump, following WALK edges out of the source node and onward. Only
// walks - backing across a fall walks the bot off a ledge and backing across a
// jump means flying it again to get back - and only neighbours that both touch
// the frontier and extend past it, or the walk sits on the spot.
function runupAvailable(g, srcIdx, takeoff, dir, cap) {
  const c = g.c;
  const seen = new Set([srcIdx]);
  let node = g.node[srcIdx];
  let frontier = dir > 0 ? node.x0 : node.x1;
  for (let hops = 0; hops < c.BOT_RUNUP_HOPS; hops++) {
    if (Math.abs(takeoff - frontier) >= cap) break;
    let best = null;
    for (const e of g.out[node.i]) {
      if (e.type !== c.NAV_EDGE_WALK) continue;
      if (seen.has(e.to)) continue;
      const n = g.node[e.to];
      if (dir > 0) {
        if (n.x1 < frontier - 1 || n.x1 >= frontier) continue;
        if (best === null || n.x0 < best.x0) best = n;
      } else {
        if (n.x0 > frontier + 1 || n.x0 <= frontier) continue;
        if (best === null || n.x1 > best.x1) best = n;
      }
    }
    if (!best) break;
    seen.add(best.i);
    node = best;
    frontier = dir > 0 ? best.x0 : best.x1;
  }
  return Math.min(Math.abs(takeoff - frontier), cap);
}

//---------------------------------------------------------------------------

// Every jump edge, with what the follower would actually do with it.
function analyse(g, p, opts) {
  const c = g.c;
  const cell = c.NAV_CELL_SIZE;
  const rows = [];

  for (const e of g.edge) {
    if (e.type !== c.NAV_EDGE_JUMP && e.type !== c.NAV_EDGE_DOUBLEJUMP) continue;
    const needVx = e.bucket;
    const ticks = e.ticks;
    if (!(needVx > 0) || !(ticks > 0)) continue;

    const src = g.node[e.from];
    const dst = g.node[e.to];
    const takeoff = e.takeoff >= 0
      ? e.takeoff
      : (dst.x0 > src.x1 ? src.x1 : src.x0);
    const takeoffX = g.colWorldX(takeoff);

    // The generator's own direction: the side of the takeoff column the landing
    // is on. botPathKeys computes jumpDir exactly this way, and it is not the
    // node-midpoint test - a wide surface can straddle that.
    let dir = 0;
    if (dst.x0 > takeoff) dir = 1;
    else if (dst.x1 < takeoff) dir = -1;
    if (dir === 0) continue;   // landing straddles the takeoff: no crossing to fly

    // The near column of the landing node is what the arc has to reach; the far
    // one is how much overshoot it may still land on.
    const nearX = g.colWorldX(dir > 0 ? dst.x0 : dst.x1);
    const farX = g.colWorldX(dir > 0 ? dst.x1 : dst.x0);
    const need = Math.abs(nearX - takeoffX);
    const width = Math.abs(farX - nearX);

    // Run-up: continuous floor behind the takeoff column, capped at
    // BOT_RUNUP_CELLS, which is as far back as the follower ever goes.
    const runupCols = runupAvailable(g, e.from, takeoff, dir, c.BOT_RUNUP_CELLS);

    // Two takeoff speeds, both capped by the gate: the follower refuses to leave
    // while it is going faster than the arc asks for.
    const cap = needVx + c.BOT_JUMP_VTOL;
    // Scored WITHOUT the six px of intra-cell lead botPathKeys allows itself, to
    // match gg2-nav-gen's canFly - see the note there for why the generator does
    // not spend it. This is deliberately the pessimistic reading: it asks whether
    // the arc works for a bot that jumps the moment it reaches the takeoff
    // column, which is the bot BOT_TAKEOFF_PATIENCE eventually produces.
    const vBest = Math.min(runupSpeed(runupCols * cell, p), cap, p.maxSpeed);

    const best = flyJump(needVx, ticks, vBest, p);
    const worst = flyJump(needVx, ticks, 0, p);
    const impossible = needVx > p.maxSpeed;

    rows.push({
      from: e.from, to: e.to, needVx, ticks, takeoff, takeoffX, dir,
      need, width, runupCols, vBest, best, worst,
      shortBest: need - best,
      shortWorst: need - worst,
      impossible,
      failBest: impossible || need - best > opts.tol,
      failWorst: impossible || need - worst > opts.tol,
    });
  }
  return rows;
}

// A node whose every outgoing arc is unflyable is a trap: the bot arrives,
// blacklists each exit in turn over a few dozen ticks, and then stands still
// with nothing left to plan through. That is the shape the live blacklist logs
// keep showing, and it is worth reporting above any single edge.
function traps(g, rows) {
  const c = g.c;
  const bad = new Set(rows.filter((r) => r.failBest).map((r) => `${r.from}>${r.to}`));
  const out = [];
  for (const n of g.node) {
    const exits = g.out[n.i].filter((e) => e.to !== n.i);
    if (!exits.length) continue;
    const flyable = exits.filter((e) => {
      // Walks, falls, drop-throughs and move-boxes are not arcs the tracker flies.
      if (e.type !== c.NAV_EDGE_JUMP && e.type !== c.NAV_EDGE_DOUBLEJUMP) return true;
      return !bad.has(`${e.from}>${e.to}`);
    });
    const climbs = (list) => list.filter((e) => g.node[e.to].row < n.row);
    // Down-only escape is still a trap for a bot that has to get back up: falls
    // and drop-throughs cannot climb, so what matters is whether any exit that
    // gains height survives.
    if (!flyable.length || (climbs(exits).length && !climbs(flyable).length)) {
      out.push({
        node: n.i, exits: exits.length, flyable: flyable.length,
        up: climbs(flyable).length, upWanted: climbs(exits).length,
      });
    }
  }
  return out;
}

// ⚠️ REACHABILITY IS THE WRONG METRIC FOR THIS FAILURE CLASS, and it was tried
// first. Deleting all 105 unflyable edges from koth_gallery changes red's
// reachable count by exactly nothing: the graph is redundant enough that every
// node keeps some other way in. It is the same reason navsuspects exists - the
// koth_valley shaft was fully reachable throughout its bug.
//
// What actually happens is worse than disconnection and invisible to a BFS.
// A* is handed the CHEAPEST route, which is the one across the unflyable arc.
// The bot flies it, lands somewhere else, blacklists the edge - and the
// blacklist expires after BOT_BLACKLIST_TICKS, so A* hands back the identical
// route and it does the whole thing again. Measured live on koth_gallery: 1200
// ticks, 12 replans, the same three edges blacklisted twice each, 177px short.
//
// So the number that predicts a stuck bot is this one: of the nodes that can
// reach the objective at all, how many have a CHEAPEST route that crosses an
// arc this class cannot fly. Those bots thrash. The ones with no flyable route
// at any price are worse, and are counted separately.
function routeHealth(g, rows) {
  const c = g.c;
  const bad = new Set(rows.filter((r) => r.failBest).map((r) => `${r.from}>${r.to}`));
  const ents = nav.entities(g.map, g.repo);
  const mode = nav.gameMode(ents);
  const out = [];

  for (const team of [c.TEAM_RED, c.TEAM_BLUE]) {
    const ctx = { team, hasIntel: false, setupClosed: false };
    const goals = nav.objectives(ents, mode, team, c) || {};
    let target = -1;
    for (const o of goals.outbound || []) {
      const snapped = g.snapObjective(o.x, o.y);
      if (snapped.node >= 0) { target = snapped.node; break; }
    }
    if (target < 0) continue;

    // Dijkstra backwards from the objective over the graph's own costs, which
    // is the route A* will pick. `next` is the first hop of that route, so a
    // path can be walked forward without keeping every path.
    const dijkstra = (skipBad) => {
      const dist = new Array(g.node.length).fill(Infinity);
      const next = new Array(g.node.length).fill(-1);
      dist[target] = 0;
      const queue = [[0, target]];
      const done = new Set();
      while (queue.length) {
        queue.sort((a, b) => a[0] - b[0]);
        const [d, at] = queue.shift();
        if (done.has(at)) continue;
        done.add(at);
        for (const e of g.in[at]) {
          if (skipBad && bad.has(`${e.from}>${e.to}`)) continue;
          if (!g.gatePassable(e.gate, ctx.team, ctx.hasIntel, ctx.setupClosed)) continue;
          if (!g.gatePassable(g.node[e.from].gate, ctx.team, ctx.hasIntel, ctx.setupClosed)) continue;
          const alt = d + e.cost;
          if (alt < dist[e.from]) {
            dist[e.from] = alt;
            next[e.from] = e.to;
            queue.push([alt, e.from]);
          }
        }
      }
      return { dist, next };
    };

    const all = dijkstra(false);
    const fly = dijkstra(true);

    let reachable = 0;
    let thrash = 0;
    let stranded = 0;
    for (let n = 0; n < g.node.length; n++) {
      if (n === target || !Number.isFinite(all.dist[n])) continue;
      reachable += 1;
      if (!Number.isFinite(fly.dist[n])) { stranded += 1; continue; }
      // Walk the cheapest route and see whether it crosses a lie.
      let at = n;
      for (let hop = 0; hop < g.node.length && at !== target && at >= 0; hop++) {
        const to = all.next[at];
        if (to < 0) break;
        if (bad.has(`${at}>${to}`)) { thrash += 1; break; }
        at = to;
      }
    }
    out.push({
      name: team === c.TEAM_RED ? 'red' : 'blue',
      target, reachable, thrash, stranded,
    });
  }
  return out;
}

//---------------------------------------------------------------------------

function report(key, repo, opts) {
  const g = nav.load(key, repo);
  const p = profile(opts.cls);
  return { g, p, rows: analyse(g, p, opts), key: g.key };
}

function printRows(list, title, limit) {
  if (!list.length) return;
  console.log(`\n  ${title}`);
  console.log('     edge          vx   ticks   run-up      need   reaches      short');
  for (const x of list.slice(0, limit)) {
    console.log(`  n${String(x.from).padEnd(4)}->n${String(x.to).padEnd(4)}`
      + `${x.needVx.toFixed(2).padStart(6)}`
      + `${x.ticks.toFixed(1).padStart(8)}`
      + `${(x.runupCols + 'c').padStart(9)}`
      + `${Math.round(x.need).toString().padStart(10)}`
      + `${Math.round(x.best).toString().padStart(10)}`
      + `${(x.impossible ? 'IMPOSSIBLE' : Math.round(x.shortBest) + 'px').padStart(11)}`);
  }
  if (list.length > limit) console.log(`     ... ${list.length - limit} more`);
}

function printReport(r, opts) {
  const { g, p, rows } = r;
  const bad = rows.filter((x) => x.failBest).sort((a, b) => b.shortBest - a.shortBest);
  const marginal = rows.filter((x) => !x.failBest && x.failWorst)
    .sort((a, b) => b.shortWorst - a.shortWorst);

  console.log(`${r.key}  ${rows.length} jump edges, modelled as ${p.name}`
    + ` (max ${p.maxSpeed.toFixed(2)} px/tick)`);
  console.log(`  unflyable with the run-up the source offers: ${bad.length}`
    + `   only from a standstill: ${marginal.length}`);

  let health = [];
  try { health = routeHealth(g, rows); }
  catch (e) { console.log(`  (route health unavailable: ${e.message})`); }
  for (const t of health) {
    const pct = t.reachable ? Math.round((100 * t.thrash) / t.reachable) : 0;
    console.log(`  ${t.name} -> n${t.target}: ${t.thrash}/${t.reachable} node(s) (${pct}%)`
      + ' have a cheapest route across an arc this class cannot fly'
      + (t.stranded ? `, ${t.stranded} with no flyable route at all` : ''));
  }

  printRows(bad, 'unflyable even with the run-up the source node offers', opts.limit);
  if (opts.all) {
    printRows(marginal, 'flyable with a run-up, missed after landing on the takeoff', opts.limit);
  }

  const t = traps(g, rows);
  if (t.length) {
    console.log(`\n  ${t.length} node(s) with no flyable way out that climbs:`);
    for (const x of t.slice(0, opts.limit)) {
      const [w0, w1] = g.worldSpan(x.node);
      console.log(`  n${String(x.node).padEnd(4)} world x ${w0}-${w1} floor y ${g.floorY(x.node)}`
        + `   ${x.flyable}/${x.exits} exits survive, ${x.up}/${x.upWanted} of the climbs do`);
    }
    if (t.length > opts.limit) console.log(`     ... ${t.length - opts.limit} more`);
  }
  console.log('');
}

function printEdge(r, from, to, opts) {
  const { g, p, rows } = r;
  const x = rows.find((e) => e.from === from && e.to === to);
  if (!x) { console.log(`no jump edge n${from} -> n${to} in ${r.key}`); return; }
  console.log(`${r.key}  n${from} -> n${to} as ${p.name} (max ${p.maxSpeed.toFixed(2)} px/tick)`);
  console.log(`  takeoff col ${x.takeoff} (world x ${x.takeoffX}), heading `
    + `${x.dir > 0 ? 'right' : 'left'}, arc ${x.needVx.toFixed(2)} px/tick`
    + ` over ${x.ticks.toFixed(1)} ticks`);
  console.log(`  run-up available ${x.runupCols} cell(s) -> leaves at ${x.vBest.toFixed(2)} px/tick`);
  console.log(`  needs ${Math.round(x.need)}px to the near column of n${to}`
    + `, whose run is ${Math.round(x.width)}px wide`);
  console.log('');
  console.log('   tick     want     have   press   hspeed');
  const total = x.needVx * x.ticks;
  let v = x.vBest;
  let px = 0;
  for (let air = 1; air <= Math.max(1, Math.round(x.ticks)); air++) {
    const want = Math.min(total, x.needVx * air);
    let press = 0;
    if (px < want - 1) press = 1;
    else if (px > want + 1) press = -1;
    v = tick(v, press, p);
    px += v;
    console.log(`${String(air).padStart(7)}${want.toFixed(1).padStart(9)}`
      + `${px.toFixed(1).padStart(9)}${(press > 0 ? '+' : press < 0 ? '-' : '.').padStart(8)}`
      + `${v.toFixed(2).padStart(9)}`);
  }
  console.log(`\n  lands ${Math.round(x.need - px)}px short of n${to}`
    + (x.impossible ? '  (IMPOSSIBLE: the arc asks for more than this class can run)' : ''));
  console.log('');
}

function usage() {
  console.log('navfollow.js - jump edges the follower cannot actually fly');
  console.log('');
  console.log('  node navfollow.js [<map|key>] [options]');
  console.log('');
  console.log('  (no map)          every cached graph');
  console.log('  --class <name>    heavy (default), soldier, scout, medic, ...');
  console.log('  --tol <px>        landing slack before an edge counts as failed (default 6)');
  console.log('  --all             also list edges that only fail from a standstill');
  console.log('  --limit <n>       rows per section (default 12)');
  console.log('  --edge <a>,<b>    replay one edge tick by tick');
  console.log('  --repo <path>     the Gang Garrison 2 checkout');
  console.log('  --help');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) { usage(); return 0; }
  const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const repo = valOf('--repo', lib.defaultRepo());
  const opts = {
    cls: String(valOf('--class', 'heavy')).toLowerCase(),
    tol: Number(valOf('--tol', 6)),
    limit: Number(valOf('--limit', 12)),
    all: argv.includes('--all'),
  };
  const edge = valOf('--edge', null);

  const taken = new Set();
  for (const f of ['--class', '--tol', '--limit', '--repo', '--edge']) {
    const i = argv.indexOf(f);
    if (i >= 0 && argv[i + 1]) taken.add(argv[i + 1]);
  }
  const target = argv.find((a) => !a.startsWith('--') && !taken.has(a));
  const keys = target ? [target] : nav.listKeys(repo);
  if (!keys.length) {
    console.log(`no cached graphs in ${nav.cacheDir(repo)}`);
    console.log('a graph appears there once a server has loaded that map');
    return 1;
  }

  for (const key of keys) {
    let r;
    try { r = report(key, repo, opts); }
    catch (e) { console.log(`${key}  ERROR ${e.message}`); continue; }
    if (edge) {
      const [a, b] = edge.split(',').map(Number);
      printEdge(r, a, b, opts);
    } else printReport(r, opts);
  }
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { profile, tick, runupSpeed, flyJump, analyse, traps, routeHealth, report, RUN_POWER };
