//=============================================================================
// navsuspects.js - which routes on a map are suspiciously expensive?
//
// navaudit answers a BOOLEAN question: can a bot get from spawn to the
// objective at all. That question was green for the whole life of the
// koth_valley shaft bug, and it was green honestly - every node in the shaft
// WAS reachable from spawn. What was wrong was the price. The climb out of the
// shaft is four rungs and one of them did not exist, so a bot that fell in
// walked a ~45-node detour to get back to a point 260px away. A directed BFS
// cannot see that, and neither can --gaps: the graph never split into
// components, it just became expensive in one direction.
//
// So this asks a METRIC question instead. For every node:
//
//   travel   how far the bot actually walks along the route Dijkstra picked, which
//            is NOT what the graph charges it - see travelOf below
//   dGraph   Dijkstra cost from that node to the objective, over the same edge
//            costs A* itself uses. Kept in the output beside travel, because the two
//            disagreeing IS a finding: a route charged 112 and walked 344 is one the
//            planner is choosing for the wrong reason.
//   dMin     straight-line distance in cells - which is exactly navFindPath's
//            own heuristic, and therefore a guaranteed lower bound on dGraph
//   ratio    dGraph / dMin
//
// A high ratio is a route the graph makes you walk much further than geometry
// says you should. That is the signature of a missing edge, and it is the one
// number that would have put the shaft at the top of a list before anybody
// happened to watch a bot fall into it.
//
// This ranks SUSPICION, not breakage. A map with one legitimate bridge between
// its halves ranks high forever and is working as designed. The output is a
// worklist: confirm a candidate by running it (--scenarios emits ready-made
// definitions for gg2_scenario) and then either fix the graph or record the
// measured baseline the way tools/bot-scenarios.js does for every leg it
// already knows is long.
//
// The live run is worth doing even when the ratio turns out to be honest,
// because comparing what the graph PREDICTED against what the bot actually
// walked splits the two failure classes on its own:
//
//   predicted high, actual high   missing edge - no short route exists
//   predicted low,  actual high   the follower cannot fly an arc the graph
//                                 promised, which is where every jump-edge bug
//                                 in this project has lived
//
// A graph only lands in the cache once a server has loaded that map, so this
// sees the maps that have been played, not the twenty that ship. Cycle a
// dedicated server through the rotation first if you want the lot.
//=============================================================================

const lib = require('./lib');
const nav = require('./navgraph');

// A node this close to the objective has a dMin small enough that the ratio is
// mostly noise - two cells of rounding is a large fraction of eight cells.
const MIN_CELLS = 8;
// And a route can be twice its lower bound without anything being wrong; what
// is interesting is a route many times it AND long in absolute terms.
const MIN_EXCESS_CELLS = 40;

//---------------------------------------------------------------------------

// Cost to reach `target` from every node, walking edges backwards so one sweep
// answers it for the whole map. Gates are applied per query the way the game
// applies them, so a red route and a blue route are different questions.
function costsToTarget(g, target, ctx, next) {
  const dist = new Array(g.nodeCount).fill(Infinity);
  if (target < 0) return dist;
  dist[target] = 0;

  // Dijkstra with a sorted-insert frontier. The graphs are small - 700 nodes
  // and 5000 edges at the top end - and a binary heap here would be more code
  // than the whole rest of the file.
  const queue = [[0, target]];
  const done = new Set();
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, at] = queue.shift();
    if (done.has(at)) continue;
    done.add(at);
    for (const e of g.in[at]) {
      if (ctx) {
        if (!g.gatePassable(e.gate, ctx.team, ctx.hasIntel, ctx.setupClosed)) continue;
        if (!g.gatePassable(g.node[e.from].gate, ctx.team, ctx.hasIntel, ctx.setupClosed)) continue;
      }
      const nd = d + Math.max(1, e.cost);
      // The sweep runs backwards from the objective, so the edge that relaxed a
      // node is the FIRST hop of its cheapest route out - which makes the route
      // readable forwards without a second search.
      if (nd < dist[e.from]) {
        dist[e.from] = nd;
        if (next) next[e.from] = e;
        queue.push([nd, e.from]);
      }
    }
  }
  return dist;
}

// Cost FROM the target outward, for the pocket test: a trap is cheap to enter
// and expensive to leave, which is invisible to either number on its own.
function costsFromTarget(g, target, ctx) {
  const dist = new Array(g.nodeCount).fill(Infinity);
  if (target < 0) return dist;
  dist[target] = 0;
  const queue = [[0, target]];
  const done = new Set();
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, at] = queue.shift();
    if (done.has(at)) continue;
    done.add(at);
    for (const e of g.out[at]) {
      if (ctx) {
        if (!g.gatePassable(e.gate, ctx.team, ctx.hasIntel, ctx.setupClosed)) continue;
        if (!g.gatePassable(g.node[e.to].gate, ctx.team, ctx.hasIntel, ctx.setupClosed)) continue;
      }
      const nd = d + Math.max(1, e.cost);
      if (nd < dist[e.to]) { dist[e.to] = nd; queue.push([nd, e.to]); }
    }
  }
  return dist;
}

// navFindPath's heuristic: straight-line distance in cells. Admissible only
// because walk costs are in cells too - see the warning in the koth_valley
// handoff about what happens to A* when that stops being true.
function straightLineCells(g, a, b) {
  const c = g.c;
  const [ax0, ax1] = g.worldSpan(a);
  const [bx0, bx1] = g.worldSpan(b);
  const ax = (ax0 + ax1) / 2;
  const bx = (bx0 + bx1) / 2;
  return Math.hypot(ax - bx, g.floorY(a) - g.floorY(b)) / c.NAV_CELL_SIZE;
}

// How far a bot actually walks along a route, in cells, as opposed to what the graph
// charges it. The two are not the same and the difference is not small: measured over
// 17 legs, cp_egypt's n248 route is charged 112 cells and covers 344.
//
// The gap is structural, not a bug in any one edge. A walk between two runs on the SAME
// row is charged a flat 1 cell - "they are, by construction, exactly adjacent" - and
// crossing the run you land on is then free, so a route over a 378px platform is priced
// at one cell. (navWalkEdges says as much in its own header, and defers it.)
//
// ⚠️ Do not "fix" that in the generator on the strength of this. It was tried offline
// against every node of every cached map: charging same-row walks by midpoint distance
// changes the real travel of the chosen routes by 0.0% overall - 61 nodes better on
// ctf_conflict, a handful worse elsewhere, nothing else moves. The under-pricing does
// not MISROUTE, because the cheap crossing is available to every candidate route
// equally. What it does is hide long routes from THIS tool, which is why the fix belongs
// here and not there.
function travelOf(g, next, from, target) {
  let at = from;
  let travel = 0;
  let hops = 0;
  while (at !== target && next[at] && hops < 1000) {
    const e = next[at];
    const a = g.node[e.from];
    const b = g.node[e.to];
    travel += Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) + Math.abs(a.row - b.row);
    hops += 1;
    at = e.to;
  }
  return { travel, hops };
}

function analyse(g, ctx, targetNode) {
  const out = [];
  const next = new Array(g.nodeCount).fill(null);
  // Dijkstra still runs on the graph's own costs - that is the route A* will pick, and
  // the point is to measure the route the bot will really take, not a nicer one.
  const toT = costsToTarget(g, targetNode, ctx, next);
  const fromT = costsFromTarget(g, targetNode, ctx);

  for (let n = 0; n < g.nodeCount; n++) {
    if (n === targetNode) continue;
    const dGraph = toT[n];
    // Unreachable is navaudit's finding, not ours.
    if (!Number.isFinite(dGraph)) continue;
    const dMin = straightLineCells(g, n, targetNode);
    if (dMin < MIN_CELLS) continue;
    const { travel, hops } = travelOf(g, next, n, targetNode);
    // Rank on what the bot walks, not on what it is charged.
    const excess = travel - dMin;
    if (excess < MIN_EXCESS_CELLS) continue;

    const [x0, x1] = g.worldSpan(n);
    const inTypes = g.in[n].map((e) => g.edgeTypeName(e.type));
    out.push({
      node: n,
      ratio: travel / dMin,
      dGraph,
      travel,
      hops,
      dMin,
      excess,
      // Cheap in, expensive out. costIn is the walk from the objective down to
      // here, which is the closest thing on disk to "how a bot ends up there".
      pocket: Number.isFinite(fromT[n]) && fromT[n] * 2 < dGraph,
      costIn: fromT[n],
      fromX: Math.round((x0 + x1) / 2),
      fromY: Math.round(g.chestY(n)),
      floorY: g.floorY(n),
      row: g.node[n].row,
      falls: inTypes.filter((t) => t === 'fall').length,
      inCount: inTypes.length,
      outCount: g.out[n].length,
    });
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}

//---------------------------------------------------------------------------

// The cheapest route from one node to the objective, hop by hop.
//
// This is the question the ranked list cannot answer. A ratio of 7 says the
// graph makes a bot walk seven times the straight line; it does not say whether
// that is a missing rung (koth_valley's shaft), a legitimate one-way drop into a
// pit, or a route that leaves the pocket immediately and is simply long. Reading
// the hops answers it in one look, and offline: where the route doubles back, or
// climbs out the way it came, or spends forty cells crossing a map it started
// next to, that is visible as text.
//
// Prints the same costs A* uses, so the cumulative column is exactly what
// navsuspects ranked on and what a scenario's tick count should be compared
// against.
function printRoute(g, from, targetNode, ctx) {
  const next = new Array(g.nodeCount).fill(null);
  const dist = costsToTarget(g, targetNode, ctx, next);

  if (!Number.isFinite(dist[from])) {
    console.log(`  n${from} cannot reach n${targetNode} at all - that is navaudit's question, not this one`);
    return;
  }

  console.log(`  route n${from} -> n${targetNode}, ${Math.round(dist[from])} cells over `
    + `${Math.round(straightLineCells(g, from, targetNode))} straight-line`);
  console.log('    hop  edge        node   world x        floor y   cost   cumulative');

  let at = from;
  let acc = 0;
  let hop = 0;
  const seen = new Set();
  while (at !== targetNode) {
    const e = next[at];
    // Dijkstra cannot produce a cycle, so this only fires if the graph changed
    // under us - but an infinite loop in a diagnostic is worse than a bad line.
    if (!e || seen.has(at)) { console.log('    route broke - no next hop'); return; }
    seen.add(at);
    const cost = Math.max(1, e.cost);
    acc += cost;
    hop += 1;
    const [x0, x1] = g.worldSpan(e.to);
    console.log(`    ${String(hop).padStart(3)}  ${g.edgeTypeName(e.type).padEnd(11)}`
      + `n${String(e.to).padEnd(5)}`
      + `${(x0 === x1 ? String(x0) : `${x0}-${x1}`).padStart(11)}`
      + `${String(g.floorY(e.to)).padStart(15)}`
      + `${String(Math.round(cost)).padStart(7)}`
      + `${String(Math.round(acc)).padStart(13)}`);
    at = e.to;
  }
}

// Where a missing rung would collapse a long route.
//
// --route says a route is long. This says where to point a human test at it, which is a
// different question and the one that actually gets answered: walk the route, then find
// pairs of points on it that are physically within jump reach of each other but far apart
// ALONG it. Each pair is a claim with a number attached - "if this 108px climb is
// makeable, the graph is missing an edge worth 45 hops" - and a claim like that is settled
// in half a minute in-game, where "koth_corinth feels wrong" is not.
//
// Only climbs are reported. A descent that shortcuts a route is a fall edge, and
// navFallEdges already emits every one it can reach.
//
// One row per source node: the same climb otherwise appears against every later node it
// beats, which is a dozen rows saying one thing.
function printShortcuts(g, from, targetNode, ctx) {
  const c = g.c;
  const next = new Array(g.nodeCount).fill(null);
  costsToTarget(g, targetNode, ctx, next);

  const route = [from];
  let at = from;
  while (at !== targetNode && next[at] && route.length < 2000) { at = next[at].to; route.push(at); }
  if (route.length < 2) { console.log(`  n${from} has no route to n${targetNode}`); return; }

  const apex = (c.NAV_JUMP_V0 * c.NAV_JUMP_V0) / (2 * c.NAV_JUMP_GRAVITY);
  const gapX = (a, b) => {
    const [a0, a1] = g.worldSpan(a);
    const [b0, b1] = g.worldSpan(b);
    if (b0 > a1) return b0 - a1;
    if (a0 > b1) return a0 - b1;
    return 0;
  };

  const found = [];
  for (let i = 0; i < route.length; i++) {
    for (let j = i + 6; j < route.length; j++) {
      const a = route[i];
      const b = route[j];
      const rise = g.floorY(a) - g.floorY(b);
      if (rise <= 0) continue;
      // One jump, or a two-rung climb that needs a ledge in between the graph may not have.
      const rungs = rise <= apex ? 1 : rise <= 2 * apex ? 2 : 0;
      if (!rungs) continue;
      const gap = gapX(a, b);
      if (gap > 96) continue;
      found.push({ a, b, saves: j - i, rise: Math.round(rise), gap: Math.round(gap), rungs });
    }
  }
  found.sort((x, y) => y.saves - x.saves);
  const seen = new Set();
  const rows = found.filter((f) => (seen.has(f.a) ? false : (seen.add(f.a), true))).slice(0, 10);

  console.log(`  route n${from} -> n${targetNode}, ${route.length - 1} hops`);
  if (!rows.length) {
    console.log('  nothing on this route comes back within jump reach of itself - the detour is');
    console.log('  the map, not a missing edge');
    return;
  }
  console.log('');
  console.log('  from      stand at          to        stand at         rise    gap  rungs  saves');
  for (const f of rows) {
    const [a0, a1] = g.worldSpan(f.a);
    const [b0, b1] = g.worldSpan(f.b);
    console.log(`  n${String(f.a).padEnd(5)} (${String(Math.round((a0 + a1) / 2)).padStart(5)},${String(g.floorY(f.a)).padStart(5)})   `
      + `n${String(f.b).padEnd(5)} (${String(Math.round((b0 + b1) / 2)).padStart(5)},${String(g.floorY(f.b)).padStart(5)})   `
      + `${String(f.rise).padStart(4)}px ${String(f.gap).padStart(4)}px    ${f.rungs}    ${String(f.saves).padStart(4)}`);
  }
  console.log('');
  console.log(`  apex is ${apex.toFixed(1)}px, so a 1-rung climb is one ordinary jump and a 2-rung one`);
  console.log('  needs a ledge in between. "gap" is the horizontal clearance between the two');
  console.log('  surfaces, "saves" the hops the climb would remove. Go and try the top row.');
}

function scenarioFor(g, s, goal, teamName) {
  // botNodeSnap searches DOWNWARD, so the placement is the node's own chest
  // height - the same point botSetGoal uses - rather than a guess above the
  // floor. A point level with the surface resolves to whatever is underneath
  // it, which is how you get a VOID instead of a run.
  return {
    name: `suspect-${g.map}-n${s.node}`,
    map: g.map,
    about:
      `Auto-generated by navsuspects. Node ${s.node} (row ${s.row}, floor y ${s.floorY}) walks `
      + `${Math.round(s.travel)} cells to reach the objective (the graph charges it `
      + `${Math.round(s.dGraph)}) against a straight-line floor of ${Math.round(s.dMin)} - `
      + `a ratio of ${s.ratio.toFixed(1)}, over ${s.hops} hops. `
      + (s.pocket ? 'Cheap to enter and expensive to leave, which is the trap shape. ' : '')
      + 'Confirm whether the detour is real map geometry or a missing edge before keeping this.',
    class: 'CLASS_SOLDIER',
    team: teamName,
    from: [s.fromX, s.fromY],
    to: [goal.goalX, goal.goalY],
    budget: Math.max(600, Math.round(s.travel * 3)),
  };
}

function report(key, repo, limit) {
  const g = nav.load(key, repo);
  const c = g.c;
  const ents = nav.entities(g.map, repo);
  const mode = nav.gameMode(ents);
  const team = c.TEAM_RED;
  const ctx = { team, hasIntel: false, setupClosed: false };

  const goals = nav.objectives(ents, mode, team, c);
  if (!goals.outbound || !goals.outbound.length) return { key, skipped: 'no objective', rows: [] };

  let goal = null;
  let targetNode = -1;
  for (const o of goals.outbound) {
    const snapped = g.snapObjective(o.x, o.y);
    if (snapped.node >= 0) { goal = snapped; targetNode = snapped.node; break; }
  }
  if (targetNode < 0) return { key, skipped: 'objective does not resolve', rows: [] };

  return {
    key,
    map: g.map,
    stale: g.stale,
    version: g.version,
    targetNode,
    goal,
    rows: analyse(g, ctx, targetNode).slice(0, limit),
    g,
    teamName: 'red',
  };
}

function printReport(r) {
  if (r.skipped) {
    console.log(`${r.key}  (skipped: ${r.skipped})\n`);
    return;
  }
  console.log(`${r.key}  objective -> n${r.targetNode}`
    + (r.stale ? `   ! stale cache (v${r.version})` : ''));
  if (!r.rows.length) {
    console.log('  nothing above threshold\n');
    return;
  }
  console.log('   node   ratio   travel     graph     floor    excess  shape');
  for (const s of r.rows) {
    const shape = [
      s.pocket ? 'pocket' : '',
      s.falls && s.falls === s.inCount ? 'fall-only-in' : (s.falls ? `${s.falls} fall-in` : ''),
      s.outCount ? '' : 'no exits',
    ].filter(Boolean).join(', ');
    console.log(`  n${String(s.node).padEnd(5)}`
      + `${s.ratio.toFixed(1).padStart(6)}`
      + `${Math.round(s.travel).toString().padStart(9)}`
      + `${Math.round(s.dGraph).toString().padStart(10)}`
      + `${Math.round(s.dMin).toString().padStart(10)}`
      + `${Math.round(s.excess).toString().padStart(10)}  ${shape}`);
  }
  console.log('');
}

function usage() {
  console.log('navsuspects.js - routes the graph prices far above their geometry');
  console.log('');
  console.log('  node navsuspects.js [<map|key>] [options]');
  console.log('');
  console.log('  (no map)          every cached graph');
  console.log('  --limit <n>       candidates per map (default 5)');
  console.log('  --scenarios       emit gg2_scenario definitions as JSON');
  console.log('  --route <n>       print the cheapest route from node n to the');
  console.log('                    objective instead of ranking, hop by hop. Needs a map.');
  console.log('  --shortcuts <n>   where a climb would collapse that route - the list to');
  console.log('                    take into the game and try by hand. Needs a map.');
  console.log('  --repo <path>     the Gang Garrison 2 checkout');
  console.log('  --help');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) { usage(); return 0; }

  const valOf = (f, d) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : d;
  };
  const repo = valOf('--repo', lib.defaultRepo());
  const limit = Number(valOf('--limit', 5));
  const emitScenarios = argv.includes('--scenarios');
  const routeFrom = valOf('--route', null);
  const shortcutFrom = valOf('--shortcuts', null);

  const flagValues = new Set();
  for (const f of ['--limit', '--repo', '--route', '--shortcuts']) {
    const i = argv.indexOf(f);
    if (i >= 0 && argv[i + 1]) flagValues.add(argv[i + 1]);
  }
  const target = argv.find((a) => !a.startsWith('--') && !flagValues.has(a));

  const keys = target ? [target] : nav.listKeys(repo);
  if (!keys.length) {
    console.log(`no cached graphs in ${nav.cacheDir(repo)}`);
    console.log('a graph appears there once a server has loaded that map');
    return 1;
  }

  const scenarios = [];
  for (const key of keys) {
    let r;
    try {
      r = report(key, repo, limit);
    } catch (e) {
      console.log(`${key}  ERROR ${e.message}`);
      continue;
    }
    if (shortcutFrom !== null) {
      if (r.skipped) { console.log(`${key}  (skipped: ${r.skipped})`); continue; }
      console.log(`${r.key}  objective -> n${r.targetNode}`);
      printShortcuts(r.g, Number(shortcutFrom), r.targetNode,
        { team: r.g.c.TEAM_RED, hasIntel: false, setupClosed: false });
      console.log('');
    } else if (routeFrom !== null) {
      if (r.skipped) { console.log(`${key}  (skipped: ${r.skipped})`); continue; }
      console.log(`${r.key}  objective -> n${r.targetNode}`);
      printRoute(r.g, Number(routeFrom), r.targetNode, { team: r.g.c.TEAM_RED, hasIntel: false, setupClosed: false });
      console.log('');
    } else if (emitScenarios) {
      if (!r.skipped) for (const s of r.rows) scenarios.push(scenarioFor(r.g, s, r.goal, r.teamName));
    } else {
      printReport(r);
    }
  }
  if (emitScenarios) console.log(JSON.stringify(scenarios, null, 2));
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { costsToTarget, costsFromTarget, straightLineCells, analyse, printRoute, printShortcuts };
