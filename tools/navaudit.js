#!/usr/bin/env node
//=============================================================================
// navaudit.js - can a bot actually play this map?
//
// Reads the nav graphs the server has already cached to disk and answers, per
// map and per team, whether a bot can path from its spawn to the thing its game
// mode tells it to walk to. No running game, no bridge, no map rotation - so it
// is cheap enough to run over every cached map before a playtest, and it should
// be, because a bot with no route stands perfectly still and that is
// indistinguishable from a dozen other bugs when you are watching it happen.
//
// Warm the cache first: a graph only exists here once the server has loaded the
// map. Cycle a dedicated server through the rotation with
//
//   gg2_wait  setup: 'global.currentMapArea = N; serverGotoMap("<name>");'
//             expr:  'global.navKey == "<name>_a<N>" and global.navBuildState == 9'
//
// (Waiting on navBuildState alone races: it is still 9 from the previous map for
// a frame or two before navServerTick notices the key changed.)
//
// THE THREE CHECKS, AND WHY EACH ONE EXISTS
//
// Each was added after a human playtest found a broken map that the previous
// version of this audit had passed. That history is the argument for keeping
// all three: every one of them caught something.
//
//   gates          A gate is a per-query cost evaluated against the caller's
//                  team (navGatePassable), not a property of the graph. A
//                  gate-blind BFS asks "can a body get there" and passed a
//                  ctf_conflict where blue cannot reach the red intel at all.
//
//   the return leg Carrying the intel closes your OWN team gate - you may not
//                  run the enemy flag into your own spawn room. So a CTF return
//                  is a different query from the outbound one, with a different
//                  start and different permissions. ctf_conflict passes the
//                  outbound leg for red and fails the return: the bot fetches
//                  the flag and then stands on it forever, which takes the flag
//                  out of play and stalls the round.
//
//   chokepoints    A region whose ONLY entrance is a gated node. This is the
//                  sharpest signal here - far better than a reachability
//                  percentage, because it points at one edge and says "the
//                  ungated route that obviously exists in the world is missing
//                  from the graph". On ctf_conflict it isolates 81 nodes behind
//                  2 gated ones.
//
// A note on reading the output: the percentage is NOT the predictor. gen_destroy
// reaches 98% of its graph and cannot touch a generator; ctf_oldfort reaches 31%
// and plays fine. What matters is whether the objective is in the spawn's
// component. And an unreachable objective is only a blocker for modes where
// standing on the objective IS the goal - it is meaningless for Generator, where
// the bot is supposed to shoot the thing from a distance.
//
// Usage:
//   node navaudit.js                        every cached graph, one line each
//   node navaudit.js koth_corinth           one map, in detail
//   node navaudit.js koth_corinth --gaps    near-miss pairs between components
//   node navaudit.js koth_corinth --node 64 one node's edges, both directions
//=============================================================================

const lib = require('./lib');
const nav = require('./navgraph');

const has = (ents, type) => ents.some((e) => e.type === type);

const USAGE = `
navaudit.js - can a bot path to the objective on this map?

  node navaudit.js [<map|key>] [options]

  (no map)          audit every cached graph, one summary line each
  <map>             audit one graph in detail; "koth_valley" or "cp_dirtbowl_a2"

  --gaps            list near-miss node pairs across a component boundary,
                    closest first - where an edge should probably exist
  --node <n>        dump one node's outgoing and incoming edges
  --all             in a full audit, list passing maps too (default: failures
                    and warnings only)
  --repo <path>     the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)
  --help
`;

//---------------------------------------------------------------------------

function teamName(team, c) { return team === c.TEAM_RED ? 'red' : 'blue'; }

// One team's verdict on one graph.
function auditTeam(g, ents, mode, team) {
  const c = g.c;
  const out = { team, name: teamName(team, c), problems: [], warnings: [], notes: [] };

  const spawnEnts = nav.spawns(ents, team, c);
  if (!spawnEnts.length) { out.notes.push('no spawn points on this map'); return out; }

  // Any spawn will do - they are all in the same room - but take the first that
  // resolves, since a spawn marker can sit above its floor like any other.
  let spawn = -1;
  for (const s of spawnEnts) {
    const snapped = g.snapObjective(s.x, s.y);
    if (snapped.node >= 0) { spawn = snapped.node; break; }
  }
  if (spawn < 0) { out.problems.push('spawn does not resolve to any node'); return out; }
  out.spawn = spawn;

  const ctx = { team, hasIntel: false, setupClosed: false };
  const gated = g.reach(spawn, ctx);
  const blind = g.reach(spawn, null);
  out.reach = gated.size;
  out.reachBlind = blind.size;
  out.lostToGates = blind.size - gated.size;

  const goals = nav.objectives(ents, mode, team, c);
  if (!goals.outbound || !goals.outbound.length) {
    out.notes.push(mode === 'tdm'
      ? 'no objective (TDM) - bots fight what comes to them, by design'
      : 'no objective entity found');
    return out;
  }

  // ⚠️ On a multi-stage map every stage's objectives are in the PNG's entity
  // list, but basicRoomSetup destroys the instances outside the active stage's
  // y-band - so only some of them exist while this graph is in play. Which band
  // is active is game state, not disk state, so it cannot be filtered here and
  // the out-of-stage entries will read FAIL. Say so rather than letting someone
  // chase them. (The terrain nodes DO exist map-wide, which is why they resolve
  // at all; it is the instances that are stage-local.)
  if (has(ents, 'NextAreaO')) {
    out.notes.push('multi-stage map: objectives from the other stages are in this list and '
      + 'will read FAIL - only the ones in the active stage are real');
  }

  // Outbound. Report every candidate: on a multi-point map botObjectiveUpdate
  // picks the nearest UNLOCKED one and we cannot know lock state from disk, so
  // "some are unreachable" is a weaker finding than "all are".
  out.outbound = goals.outbound.map((o) => {
    const snapped = g.snapObjective(o.x, o.y);
    return {
      role: o.role, type: o.type, x: o.x, y: o.y,
      node: snapped.node, drop: snapped.drop,
      ok: snapped.node >= 0 && gated.has(snapped.node),
      okBlind: snapped.node >= 0 && blind.has(snapped.node),
    };
  });
  const reachable = out.outbound.filter((o) => o.ok);
  if (!reachable.length) {
    out.problems.push(`cannot reach ${out.outbound.length === 1 ? 'the objective'
      : `any of the ${out.outbound.length} objectives`}`);
  } else if (reachable.length < out.outbound.length) {
    // Weaker than a failure and still worth saying. botObjectiveUpdate walks to
    // the nearest UNLOCKED point, and lock state is not knowable from disk - so
    // a bot may or may not be handed one of the unreachable ones depending on
    // how the round is going. On a multi-stage A/D map that is the difference
    // between "plays fine" and "stalls after the first cap".
    out.warnings.push(`${out.outbound.length - reachable.length} of ${out.outbound.length} `
      + 'objectives unreachable - fine until the round hands the bot one of those');
  }
  // The specific embarrassment worth calling out: the gate model is the only
  // reason this failed. Without it the audit would have said yes.
  for (const o of out.outbound) {
    if (o.okBlind && !o.ok) out.problems.push(`${o.role} is reachable only by ignoring team gates`);
  }

  // Return leg. Only CTF has one, and it only means anything from an objective
  // the bot can actually get to.
  if (goals.home && goals.home.length && reachable.length) {
    const from = reachable[0].node;
    const carrying = { team, hasIntel: true, setupClosed: false };
    const back = g.reach(from, carrying);
    out.home = goals.home.map((h) => {
      const snapped = g.snapObjective(h.x, h.y);
      return {
        role: h.role, type: h.type, node: snapped.node,
        ok: snapped.node >= 0 && back.has(snapped.node),
      };
    });
    if (!out.home.some((h) => h.ok)) {
      out.problems.push('can fetch the intel but cannot carry it home '
        + '(own team gate is closed to a carrier)');
    }
  } else if (goals.home && goals.home.length) {
    out.notes.push('return leg untested - the outbound leg never gets there');
  }

  // Everything this team must be able to stand on, for the chokepoint check.
  out.targets = [
    ...(out.outbound || []).map((o) => o.node),
    ...(out.home || []).map((h) => h.node),
  ].filter((n) => n >= 0);

  return out;
}

// A region whose only entrance is gated: the sharpest localiser available. It
// beats a reachability percentage because it points at one edge and says "the
// ungated route that obviously exists in the world is missing from the graph".
//
// ⚠️ It only says that when the pocket holds something the team NEEDS. Every map
// also has a pocket behind an enemy team gate that is simply the enemy spawn
// room - correctly sealed, working as designed - and reporting those buries the
// real signal in noise on every single map. So `targets` is required: pass the
// nodes this team must reach, and a pocket is only interesting if it contains
// one. On ctf_conflict that is 81 nodes holding the red intel; on koth_corinth
// the 7-node pocket holds nothing but the other team's spawn, and is silent.
function chokepoints(g, spawn, team, targets) {
  const want = new Set((targets || []).filter((n) => n >= 0));
  if (!want.size) return [];

  const ctx = { team, hasIntel: false, setupClosed: false };
  const gated = g.reach(spawn, ctx);
  const blind = g.reach(spawn, null);

  // Only pockets that a gate is what closed off - unreachable even without
  // gates is a plain graph hole, which is a different finding (and is what the
  // objective FAIL line and --gaps are for).
  const lost = [...blind].filter((n) => !gated.has(n));
  const lostSet = new Set(lost);
  const stranded = [...want].filter((n) => lostSet.has(n));
  if (!stranded.length) return [];

  // The boundary: gated edges with a reachable tail and an unreachable head.
  const boundary = new Map();
  for (const e of g.edge) {
    if (!gated.has(e.from) || gated.has(e.to)) continue;
    const code = e.gate || g.node[e.to].gate;
    if (!code) continue;
    if (!boundary.has(code)) boundary.set(code, new Set());
    boundary.get(code).add(e.to);
  }
  return [...boundary].map(([code, heads]) => ({
    gate: g.gateName(code),
    entrances: [...heads],
    behind: lost.length,
    stranded,
  }));
}

//---------------------------------------------------------------------------
// Reporting
//---------------------------------------------------------------------------

function reportOne(g, { showGaps = false, node = null } = {}) {
  const c = g.c;
  const ents = nav.entities(g.map, g.repo);
  const mode = nav.gameMode(ents);

  console.log(`${g.key}  ${g.map} area ${g.area}, mode ${mode}`);
  console.log(`  ${g.maskW}x${g.maskH} mask, ${g.nodeCount} nodes, ${g.edgeCount} edges`);
  if (g.stale) {
    console.log(`  ! cache version ${g.version}, current NAV_CACHE_VERSION is ${c.NAV_CACHE_VERSION}`);
    console.log('    this graph was built by a different generator - rebuild before trusting it');
  }

  const byType = {};
  for (const e of g.edge) byType[g.edgeTypeName(e.type)] = (byType[g.edgeTypeName(e.type)] || 0) + 1;
  console.log(`  edges by type: ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  const gatedNodes = g.node.filter((n) => n.gate).length;
  const gatedEdges = g.edge.filter((e) => e.gate).length;
  if (gatedNodes || gatedEdges) console.log(`  gated: ${gatedNodes} nodes, ${gatedEdges} edges`);

  let failed = false;
  for (const team of [c.TEAM_RED, c.TEAM_BLUE]) {
    const r = auditTeam(g, ents, mode, team);
    const pct = r.reach === undefined ? '' : ` reaches ${r.reach}/${g.nodeCount} `
      + `(${Math.round((100 * r.reach) / g.nodeCount)}%)`;
    console.log(`\n  ${r.name}:${pct}`);
    if (r.lostToGates) console.log(`    ${r.lostToGates} nodes lost to gates (${r.reachBlind} without them)`);
    for (const o of r.outbound || []) {
      console.log(`    ${o.ok ? 'OK  ' : 'FAIL'} ${o.role} ${o.type}@(${o.x},${o.y}) -> `
        + `${o.node < 0 ? 'UNRESOLVED' : `n${o.node}${o.drop > 0 ? ` (found ${o.drop}px below the marker)` : ''}`}`);
    }
    for (const h of r.home || []) {
      console.log(`    ${h.ok ? 'OK  ' : 'FAIL'} return carrying -> ${h.role} `
        + `${h.node < 0 ? 'UNRESOLVED' : `n${h.node}`}`);
    }
    for (const n of r.notes) console.log(`    - ${n}`);
    for (const w of r.warnings || []) console.log(`    ?  ${w}`);
    for (const p of r.problems) { console.log(`    ** ${p}`); failed = true; }

    if (r.spawn !== undefined) {
      for (const cp of chokepoints(g, r.spawn, team, r.targets)) {
        console.log(`    ** ${cp.stranded.map((n) => `n${n}`).join(', ')} `
          + `${cp.stranded.length === 1 ? 'is' : 'are'} inside a ${cp.behind}-node pocket whose only `
          + `entrance is ${cp.entrances.length} ${cp.gate}-gated node(s): `
          + `${cp.entrances.slice(0, 6).map((n) => `n${n}`).join(', ')}`);
        console.log('       an ungated route almost certainly exists in the world and is missing '
          + 'from the graph - this is the edge to go and find');
      }
    }
  }

  if (node !== null) reportNode(g, node);
  if (showGaps) reportGaps(g, ents, c);
  return !failed;
}

function reportNode(g, n) {
  if (n < 0 || n >= g.nodeCount) { console.log(`\n  no node ${n} in this graph`); return; }
  console.log(`\n  ${g.describe(n)}`);
  const fmt = (e, other) => `${g.edgeTypeName(e.type)}->n${other}`
    + `${e.gate ? ` [${g.gateName(e.gate)}]` : ''}`;
  console.log(`    out: ${g.out[n].map((e) => fmt(e, e.to)).join(', ') || '(none)'}`);
  console.log(`    in:  ${g.in[n].map((e) => fmt(e, e.from)).join(', ') || '(none)'}`);
  // The asymmetry that is invisible in any picture: edges leaving to a
  // neighbour with none coming back is a one-way street, and it is how
  // koth_corinth's ramp reads - descend freely, never climb.
  const outTo = new Set(g.out[n].map((e) => e.to));
  const inFrom = new Set(g.in[n].map((e) => e.from));
  const oneWay = [...outTo].filter((t) => !inFrom.has(t));
  if (oneWay.length) {
    console.log(`    one-way OUT to ${oneWay.map((t) => `n${t}`).join(', ')} `
      + '(this node can leave to them and not come back)');
  }
}

// Near-miss pairs across the boundary of what the first spawn can reach. The
// global nearest pair is NOT the route - it is whatever two nodes happen to be
// closest anywhere on the map - so pairs are ranked by how plausible an edge
// between them is, and the jump envelope is quoted so a marginal case is
// visible as marginal.
function reportGaps(g, ents, c) {
  const spawnEnts = nav.spawns(ents, c.TEAM_RED, c);
  if (!spawnEnts.length) return;
  const spawn = g.snapObjective(spawnEnts[0].x, spawnEnts[0].y).node;
  if (spawn < 0) return;
  const seen = g.reach(spawn, null);
  const env = nav.jumpEnvelope(g.repo);

  const gapX = (a, b) => {
    const [a0, a1] = g.worldSpan(a);
    const [b0, b1] = g.worldSpan(b);
    if (b0 > a1) return b0 - a1;
    if (a0 > b1) return a0 - b1;
    return 0;
  };

  const pairs = [];
  for (let a = 0; a < g.nodeCount; a++) {
    if (!seen.has(a)) continue;
    for (let b = 0; b < g.nodeCount; b++) {
      if (seen.has(b)) continue;
      const dx = gapX(a, b);
      const rise = g.floorY(a) - g.floorY(b); // >0 means b is higher
      if (dx > 150 || Math.abs(rise) > 160) continue;
      pairs.push({ a, b, dx, rise });
    }
  }
  pairs.sort((p, q) => (p.dx + Math.abs(p.rise)) - (q.dx + Math.abs(q.rise)));

  console.log(`\n  near-miss pairs (reachable -> unreachable), closest first:`);
  if (env) console.log(`  a standing jump rises ${env.maxRise.toFixed(1)}px, so a rise near that is marginal, not impossible`);
  const shown = new Set();
  let printed = 0;
  for (const p of pairs) {
    if (shown.has(p.b)) continue;
    shown.add(p.b);
    const marginal = env && p.rise > 0 && p.rise <= env.maxRise && p.rise > env.maxRise * 0.85;
    console.log(`    gap ${String(p.dx).padStart(3)}px  rise ${String(p.rise).padStart(4)}px  `
      + `${g.describe(p.a)} -> ${g.describe(p.b)}${marginal ? '   <- inside the jump envelope, barely' : ''}`);
    if (++printed >= 15) break;
  }
  if (!printed) console.log('    (none - the components are nowhere near each other)');
}

function reportAll(repo, showAll) {
  const keys = nav.listKeys(repo);
  if (!keys.length) {
    console.log(`no cached graphs in ${nav.cacheDir(repo)}`);
    console.log('a graph appears there once the server has loaded that map - cycle a dedicated');
    console.log('server through the rotation first (see the header of this file)');
    return true;
  }

  const c = nav.constants(repo);
  console.log(`${keys.length} cached graph(s) in ${nav.cacheDir(repo)}\n`);
  const rows = [];
  let allOk = true;

  for (const key of keys) {
    let g;
    try { g = nav.load(key, repo); } catch (e) { rows.push({ key, verdict: `ERROR ${e.message}`, ok: false }); allOk = false; continue; }
    let ents;
    try { ents = nav.entities(g.map, repo); } catch (e) { rows.push({ key, verdict: `ERROR ${e.message}`, ok: false }); allOk = false; continue; }

    const mode = nav.gameMode(ents);
    const parts = [];
    let ok = true;
    for (const team of [c.TEAM_RED, c.TEAM_BLUE]) {
      const r = auditTeam(g, ents, mode, team);
      if (r.problems.length) { ok = false; parts.push(`${r.name}: ${r.problems.join('; ')}`); }
    }
    if (!ok) allOk = false;
    rows.push({
      key, mode, nodes: g.nodeCount, stale: g.stale, ok,
      verdict: ok ? (mode === 'tdm' ? 'no objective (TDM), by design' : 'OK') : parts.join(' | '),
    });
  }

  for (const r of rows) {
    if (r.ok && !showAll) continue;
    const flag = r.ok ? '   ' : ' ! ';
    console.log(`${flag}${r.key.padEnd(22)} ${String(r.nodes || '').padStart(4)}n  ${r.verdict}`);
    if (r.stale) console.log(`    (cache built by a different NAV_CACHE_VERSION - rebuild)`);
  }

  const bad = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - bad}/${rows.length} graphs let both teams reach their objective.`);
  if (bad && !showAll) console.log('(passing graphs hidden; --all shows them)');
  console.log('\nremember: the reachability percentage is not the predictor, and an unreachable');
  console.log('objective only blocks modes where standing on it IS the goal - not Generator,');
  console.log('where the bot is meant to shoot it from a distance.');
  return allOk;
}

//---------------------------------------------------------------------------

async function main() {
  const { flags, positional } = lib.parseArgs(process.argv.slice(2), ['repo', 'node']);
  if (flags.help) lib.helpAndExit(USAGE);
  const repo = flags.repo || lib.defaultRepo();

  if (!positional.length) {
    const ok = reportAll(repo, !!flags.all);
    process.exit(ok ? 0 : 1);
  }

  // Accept either "koth_valley" or "cp_dirtbowl_a2"; bare map names default to
  // area 1, which is every map except the multi-stage ones.
  const want = positional[0];
  const keys = nav.listKeys(repo);
  const key = keys.includes(want) ? want
    : keys.includes(`${want}_a1`) ? `${want}_a1`
      : keys.find((k) => nav.mapOf(k) === want);
  if (!key) {
    throw new Error(`no cached graph for "${want}". Cached: ${keys.join(', ') || '(none)'}`);
  }

  const g = nav.load(key, repo);
  const ok = reportOne(g, {
    showGaps: !!flags.gaps,
    node: flags.node === undefined ? null : Number(flags.node),
  });
  process.exit(ok ? 0 : 1);
}

if (require.main === module) lib.cli(main);

module.exports = { auditTeam, chokepoints, reportOne, reportAll };
