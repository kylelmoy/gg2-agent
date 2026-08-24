#!/usr/bin/env node
//=============================================================================
// navsoak.js - walk the whole rotation and let the bots find the bugs.
//
// The three tiers that came before this each have a coverage ceiling built into
// their shape:
//
//   navaudit / navsuspects / navfollow  read the cached graphs. Deterministic,
//       sub-second, every map - and as of 2026-08-23 all three are saturated:
//       23/24 graphs reach their objective (gen_destroy is meant not to), and
//       navfollow reports 0 unflyable-at-best-run-up for every class on every
//       map. They have nothing left to say.
//
//   botscenario  runs legs a person thought of: 14 of them, on 7 of 24 maps.
//       A failure anywhere else is invisible to it.
//
//   navcensus  reads what the bots on a running server already failed at. This
//       is the right shape for a search - but it is hand-driven, one map at a
//       time, and the field it reads is capped (below), so nobody had run it
//       over more than a map or two.
//
// What is left over is exactly the population navfollow declines to judge. The
// same sweep that reports 0 unflyable also reports **5,473 jump edges across the
// 24 graphs that are flyable only WITH a run-up** - a bot that has just landed on
// the takeoff column and jumps again gets less. NAVMETHOD calls that "a follower-
// timing question, not a lying edge", and a timing question is only answerable
// live. That is what this searches.
//
// It drives the rotation itself: for every cached graph, put the server on it,
// boost to 20x, zero the counters, let the bots play for a few thousand frames,
// and harvest. Twenty-four maps in a few minutes of wall clock.
//
// THE 240-CHARACTER CAP, AND WHY A DRAIN LOOP IS THE WHOLE TRICK
//
// botBlacklistEdge keeps the endpoints of each failure in botBlacklistLog and
// stops writing at 240 characters - the string is bounded because every bot in
// every round carries one. An event is ~18 characters, so a bot records its
// first ~13 failures and silently drops the rest. navcensus says so in its own
// header: "the counters are exact and the log is a biased early sample". Over a
// two-minute window that is fine for finding a place. Over a rotation soak it
// throws away most of the evidence, and worse, it throws away a BIASED sample -
// whatever happens early in a round, on every map.
//
// So this reads the log and clears it, repeatedly, and accumulates out here
// where there is no cap. Two details make that trustworthy:
//
//   - **Read and clear happen in the same gg2_eval.** They are one GML script,
//     so they run inside one step with no frame between them. Done as two calls
//     the game runs in the gap and every failure fired in it is lost - which is
//     this tool's own bug, reintroduced in the sampler.
//
//   - **The capture rate is measured, not assumed.** botBlacklistFires is an
//     exact counter and a drain does not clear it, so the number of events a
//     chunk SHOULD have yielded is its delta. Comparing that against the events
//     actually parsed says what fraction survived. 100% means the chunk was
//     short enough; anything less is printed, and the answer is a smaller
//     --chunk. The tool measures its own instrument rather than trusting it.
//
// THE ROUND ENDS UNDERNEATH YOU, AND THAT IS NOT OPTIONAL
//
// GameServerBeginStep advances the map on a win: red taking the last point on a
// multi-area map bumps global.currentMapArea, anything else calls
// nextMapInRotation, and either way serverGotoMap fires 300 ticks later. At 20x
// a 6000-frame window is 200 seconds of game time, so this happens - repeatedly,
// on the shorter modes.
//
// It matters more than it looks, because node numbers are only meaningful inside
// one graph and they resolve perfectly well against the wrong one (navcensus'
// lie #3). A window that straddles a map change produces confident nonsense. So
// every drain reports the key it was taken under and whether a map change is
// already pending, and a chunk that disagrees with the key being soaked is
// dropped whole and counted, then the server is put back and the counters
// re-zeroed. Dropping a chunk in ten costs nothing; keeping one costs the run.
//
// GameServer is persistent, so GameServer.frame survives a map change and is a
// safe thing to wait on. That is not incidental - it is why a chunk boundary can
// be a frame number at all.
//
// WHAT IT DOES NOT DO
//
// Ordinary play is objective-biased. Bots walk the route between their spawn and
// the intel, and much of an 11,500-node rotation never gets stepped on, however
// long this runs. This finds what the bots meet; it does not find what they
// avoid. Coverage-directed roaming is the next tool, not this one.
//
// ⚠️ The bridge serves ONE client at a time. From an editor session that already
// holds the game, this CLI will hang rather than fail - see navcensus' header.
//=============================================================================

const fs = require('fs');
const lib = require('./lib');
const nav = require('./navgraph');
const census = require('./navcensus');
const scen = require('./botscenario');

//---------------------------------------------------------------------------
// Talking to the game
//---------------------------------------------------------------------------

const mkCall = (callTool, instance) => ({
  raw: (tool, args) => callTool(tool, { ...args, instance }),
  expr: async (e) => String(await callTool('gg2_evalx', { expr: e, instance })).replace(/^"|"$/g, '').trim(),
  num: async (e) => Number(String(await callTool('gg2_evalx', { expr: e, instance })).trim()),
  code: (c) => callTool('gg2_eval', { code: c, instance }),
  wait: (expr, frames, setup) => callTool('gg2_wait', { expr, frames, setup, instance }),
});

//---------------------------------------------------------------------------
// The drain
//
// One script, one step: stamp the window's identity, then for every bot append
// its name, its exact fire count and its log, and blank the log. Nothing here
// steers the game - the four diagnostics and the log string are read by nothing
// the bot plans with, which is what makes this safe against a server mid-round.
//
// Field separator "|", record separator ";". A bot is identified by its instance
// id and not by its name, which matters: the name is global.botNamePrefix plus a
// counter, the prefix is read out of gg2.ini ("[BOT] " by default) and is
// therefore whatever the user put there - a prefix containing a separator would
// silently shift every field after it. An id is a number. Nothing downstream
// wants the name anyway; the attribution this feeds is "how many distinct bots
// hit this edge", which an id answers exactly. With ids, the only alphabet left
// in a record is digits and the log's own [a-z]:digits>digits@digits plus commas,
// so the parse needs no escaping and cannot be confused by an empty log.
//
// ⚠️ GM8: no `var` here on purpose. These are ordinary instance variables of
// whatever ran the eval, which is the pattern navcensus' RESET_GML already uses;
// a `var` list is where this dialect kills the whole build for shadowing a
// built-in, and there is nothing to gain from one in a script that runs once.
//---------------------------------------------------------------------------

const DRAIN_GML = `
global.agentSoakOut = string(GameServer.frame) + "|" + global.currentMap
    + "_a" + string(global.currentMapArea) + "|" + string(global.mapchanging);
agentSoakI = 0;
repeat(ds_list_size(global.players))
{
    agentSoakP = ds_list_find_value(global.players, agentSoakI);
    if(agentSoakP.isBot)
    {
        global.agentSoakOut += ";" + string(agentSoakP.id) + "|"
            + string(agentSoakP.botBlacklistFires) + "|" + agentSoakP.botBlacklistLog;
        agentSoakP.botBlacklistLog = "";
    }
    agentSoakI += 1;
}
`.trim();

function parseDrain(text) {
  const parts = String(text).split(';');
  const head = parts[0].split('|');
  return {
    frame: Number(head[0]),
    key: head[1],
    changing: head[2] === '1',
    bots: parts.slice(1).filter(Boolean).map((r) => {
      const f = r.split('|');
      return { bot: f[0], fires: Number(f[1]) || 0, log: f.slice(2).join('|') };
    }),
  };
}

async function drain(g) {
  await g.code(DRAIN_GML);
  return parseDrain(await g.expr('global.agentSoakOut'));
}

//---------------------------------------------------------------------------
// The map
//
// botscenario.ensureMap pins global.currentMapArea to 1, which is right for a
// scenario and wrong here: cp_dirtbowl has three cached graphs and each stage is
// a genuinely different one. So the goto is written against a full key. The
// setup-gate wait is botscenario's own - a round starts with the setup gates
// SHUT, which on ctf_avanti is 59 missing edges and effectively a different map.
//
// ⚠️ But it is only waited out on a map that HAS a gate, and asking the graph is
// the only reliable way to know. `areSetupGatesClosed()` is not a question about
// the geometry: on arena it reads `ArenaHUD.cpUnlock > 0`, which is the control
// point's 60-second lock and has nothing to do with whether a bot can walk
// anywhere. arena_lumberyard and arena_montane have **0 gated edges between
// them** and never answer false inside any budget worth waiting - a round cycles
// WAITING -> ROUND_SETUP (roundStart 300) -> cpUnlock 1800 and sets it again on
// every restart. Waiting on that cost both arena maps in the first full rotation
// (`still false after 3600 frame(s)`), for a wait that could not have changed
// what was measured. Count the gates offline; wait only if there are any.
//---------------------------------------------------------------------------

// How many edges (or nodes) this graph gates. Zero means a setup phase cannot
// change what the bot can reach, so there is nothing to wait for.
function gateCount(key, repo) {
  try {
    const g = nav.load(key, repo);
    let n = 0;
    for (let i = 0; i < g.node.length; i++) {
      if (g.node[i].gate) n += 1;
      for (const e of g.out[i]) if (e.gate) n += 1;
    }
    return n;
  } catch (e) {
    // No graph on disk is a real problem, but it is soakOne's to report - and it
    // will, the moment the goto waits for navBuildState. Be conservative here.
    return 1;
  }
}

async function gotoKey(g, key, gated = true) {
  const map = nav.mapOf(key);
  const area = Number((key.match(/_a(\d+)$/) || [, '1'])[1]);
  const at = await g.expr('global.currentMap');
  const atArea = await g.num('global.currentMapArea');

  if (at === map && atArea === area) {
    await g.wait(`global.navReady and global.navKey == "${key}"`, 1800);
  } else {
    lib.step(`map -> ${key}`);
    // navBuildState alone races: it is still 9 from the previous map for a frame
    // or two before navServerTick notices the key changed.
    await g.wait(`global.navKey == "${key}" and global.navBuildState == 9`, 3600,
      `global.currentMapArea = ${area}; serverGotoMap("${map}");`);
  }
  if (!gated) return false;
  try {
    await scen.pastSetup(g.raw, undefined);
    return false;
  } catch (e) {
    // A gated map whose gates outlast the budget is still worth soaking - the
    // reader just has to know the window was measured against a graph missing
    // its gated edges, which is why this is reported per map rather than thrown.
    lib.warn(`${key}: setup gates never opened - soaking anyway, gated edges will read as missing`);
    return true;
  }
}

//---------------------------------------------------------------------------
// The bot roster
//
// botPopulationUpdate refuses to place anything while humans < botMinHumans, and
// a dedicated soak server has no humans at all - so a run with the shipped
// defaults can sit on an empty map for four minutes and report nothing wrong.
//
// ⚠️ game_init writes every one of these globals back out to gg2.ini on shutdown,
// so leaving them changed silently reconfigures the next ordinary game the user
// starts. botscenario learned that on 2026-08-21 and restores; so does this, in
// a finally.
//---------------------------------------------------------------------------

const ROSTER = ['botsEnabled', 'botMinHumans', 'botFillToPlayers', 'botMaxBots'];

async function readRoster(g) {
  const was = {};
  for (const k of ROSTER) {
    try {
      was[k] = await g.expr(`global.${k}`);
    } catch (e) {
      // An older build without the population manager runs a soak fine; it just
      // has nothing to configure and nothing to put back.
      return null;
    }
  }
  return was;
}

async function setRoster(g, n) {
  await g.code('global.botsEnabled = true; global.botMinHumans = 0;'
    + ` global.botFillToPlayers = ${n}; global.botMaxBots = max(global.botMaxBots, ${n});`);
}

async function restoreRoster(g, was) {
  if (!was) return;
  const set = ROSTER
    .filter((k) => /^-?\d+(\.\d+)?$/.test(was[k]))
    .map((k) => `global.${k} = ${was[k]};`);
  if (set.length) await g.code(set.join(' '));
}

//---------------------------------------------------------------------------
// One map's window
//---------------------------------------------------------------------------

async function soakOne(g, key, opts) {
  const gated = gateCount(key, opts.repo) > 0;
  let inSetup = await gotoKey(g, key, gated);
  // A map change replaces RateController, and a new one paces the room back to
  // 30 - so the boost has to be re-applied on the far side of every goto.
  if (opts.speed > 1) await g.raw('gg2_speed', { factor: opts.speed });

  await census.reset(g.raw, {});

  const acc = new Map();      // bot instance id -> accumulated log, in order
  const prev = new Map();     // bot instance id -> last exact fire count seen
  let expected = 0;           // events the counters say happened
  let got = 0;                // events the log actually yielded
  let dropped = 0;
  let covered = 0;
  // The drain already walks the roster and skips non-bots, so the population is
  // read off it rather than from ds_list_size(global.players) - that counts every
  // player slot, which on a dedicated server is one more than the bots in it.
  let botCount = 0;

  let at = await g.num('GameServer.frame');
  const start = at;

  while (covered < opts.frames) {
    const chunk = Math.min(opts.chunk, opts.frames - covered);
    // gg2_wait gives up after `frames`; a little slack covers the frame or two
    // spent issuing the call. It keeps the speed boost, so this is one call.
    await g.wait(`GameServer.frame >= ${at + chunk}`, Math.min(3600, chunk + 120));
    const d = await drain(g);

    // A chunk that straddles a map change carries node numbers from two graphs
    // and there is no way to tell them apart afterwards. Drop it whole.
    if (d.key !== key || d.changing) {
      dropped += 1;
      lib.warn(`${key}: dropped a chunk (${d.changing ? 'map change pending' : `now on ${d.key}`})`);
      if (await gotoKey(g, key, gated)) inSetup = true;
      if (opts.speed > 1) await g.raw('gg2_speed', { factor: opts.speed });
      await census.reset(g.raw, {});
      prev.clear();
      at = await g.num('GameServer.frame');
      covered += chunk;
      continue;
    }

    botCount = Math.max(botCount, d.bots.length);
    for (const b of d.bots) {
      // Monotonic within an epoch; a re-created bot restarts at 0, which reads
      // as a smaller number and is charged as its own delta rather than as a
      // negative one.
      const was = prev.get(b.bot) || 0;
      expected += b.fires >= was ? b.fires - was : b.fires;
      prev.set(b.bot, b.fires);

      got += census.parseLog(b.log).length;
      if (b.log) acc.set(b.bot, acc.has(b.bot) ? `${acc.get(b.bot)},${b.log}` : b.log);
    }

    covered += chunk;
    at = d.frame;
  }

  // Hand the accumulated logs back to navcensus in the shape it harvests, so the
  // aggregation, the burst collapsing and the offline join are the same code
  // that produced every finding this project already trusts.
  const h = {
    map: nav.mapOf(key),
    area: Number((key.match(/_a(\d+)$/) || [, '1'])[1]),
    frame: at,
    key,
    bots: [...acc.entries()].map(([bot, log]) => ({ name: bot, botBlacklistLog: log })),
  };
  const agg = census.withModel(census.aggregate(h, { window: opts.window }), key, opts.repo, opts.cls);

  return {
    key,
    frames: at - start,
    bots: botCount,
    dropped,
    inSetup,
    expected,
    got,
    capture: expected ? got / expected : 1,
    agg,
  };
}

//---------------------------------------------------------------------------
// Reporting
//
// navcensus' own render is not reused, and the reason is one line of its output:
// it tells the reader the log is "capped at 240 chars - an early sample, not a
// rate". Draining is exactly what makes that false, and a caveat that no longer
// applies is worse than no caveat. What replaces it is the measured capture rate.
//---------------------------------------------------------------------------

const pct = (x) => `${(x * 100).toFixed(0)}%`;

function findings(r) {
  const out = [];
  for (const e of r.agg.edges) {
    if (e.stale) continue;
    out.push({
      kind: 'edge',
      key: r.key,
      from: e.from,
      to: e.to,
      off: e.off,
      stk: e.stk,
      thr: e.thr,
      bots: e.bots.size,
      unflyable: !!e.unflyable,
      short: e.short,
      isJump: !!e.isJump,
      // Both methods agreeing is the strongest thing this project produces: a
      // live bot failed the arc, and an offline model sharing no code with it
      // says the arc cannot be flown.
      confirmed: !!e.unflyable,
    });
  }
  for (const n of r.agg.nodes) {
    if (n.stale) continue;
    if (n.bursts < 2 && n.exits.size < 3) continue;
    out.push({ kind: 'node', key: r.key, node: n.node, bursts: n.bursts, exits: n.exits.size, why: [...n.why] });
  }
  return out;
}

function render(results, opts) {
  const L = [];
  L.push('');
  L.push('  map                    frames  bots    bl   stk   off   events  capture  dropped');
  for (const r of results) {
    if (r.error) {
      L.push(`  ${r.key.padEnd(22)} ${r.error}`);
      continue;
    }
    const live = r.agg.edges.filter((e) => !e.stale);
    L.push(`  ${r.key.padEnd(22)}${String(r.frames).padStart(6)}`
      + `${String(r.bots).padStart(6)}`
      + `${String(live.reduce((a, e) => a + e.off + e.stk + e.thr, 0)).padStart(6)}`
      + `${String(live.reduce((a, e) => a + e.stk, 0)).padStart(6)}`
      + `${String(live.reduce((a, e) => a + e.off, 0)).padStart(6)}`
      + `${String(r.agg.events.length).padStart(9)}`
      + `${pct(r.capture).padStart(9)}`
      + `${String(r.dropped).padStart(9)}`);
  }

  const all = results.filter((r) => !r.error).flatMap(findings);
  const edges = all.filter((f) => f.kind === 'edge')
    .sort((a, b) => (b.confirmed ? 1 : 0) - (a.confirmed ? 1 : 0) || b.off - a.off || b.bots - a.bots);
  const nodes = all.filter((f) => f.kind === 'node').sort((a, b) => b.bursts - a.bursts || b.exits - a.exits);
  const confirmed = edges.filter((f) => f.confirmed);

  L.push('');
  L.push(`  ${confirmed.length} edge(s) failed live AND are refused by the offline model; `
    + `${edges.length - confirmed.length} live-only; ${nodes.length} wedge site(s).`);

  if (edges.length) {
    L.push('');
    L.push('  edges, worst first');
    L.push('     map                   edge           off   stk   thr  bots   offline verdict');
    for (const f of edges.slice(0, opts.limit)) {
      L.push(`  ${f.key.padEnd(22)}n${String(f.from).padEnd(5)}->n${String(f.to).padEnd(6)}`
        + `${String(f.off).padStart(4)}${String(f.stk).padStart(6)}${String(f.thr).padStart(6)}`
        + `${String(f.bots).padStart(6)}   `
        + (f.unflyable ? `UNFLYABLE, lands ${f.short}px short`
          : f.isJump ? 'jump the model accepts' : ''));
    }
    if (edges.length > opts.limit) L.push(`     ... ${edges.length - opts.limit} more`);
  }

  if (nodes.length) {
    L.push('');
    L.push('  nodes, by how often a bot got wedged there');
    L.push('     map                   node      bursts   exits tried   kinds');
    for (const f of nodes.slice(0, opts.limit)) {
      L.push(`  ${f.key.padEnd(22)}n${String(f.node).padEnd(7)}${String(f.bursts).padStart(7)}`
        + `${String(f.exits).padStart(14)}   ${f.why.join(',')}`);
    }
    if (nodes.length > opts.limit) L.push(`     ... ${nodes.length - opts.limit} more`);
  }

  const leaky = results.filter((r) => !r.error && r.capture < 0.995);
  if (leaky.length) {
    L.push('');
    L.push(`  ⚠ ${leaky.length} map(s) lost events to the 240-char log cap between drains`
      + ` (worst ${pct(Math.min(...leaky.map((r) => r.capture)))}).`);
    L.push('    The counters are exact and the log is not, so those maps are under-reported;');
    L.push(`    run them again with --chunk ${Math.max(60, Math.floor(opts.chunk / 2))}.`);
  }

  const stuckShut = results.filter((r) => !r.error && r.inSetup);
  if (stuckShut.length) {
    L.push('');
    L.push(`  ⚠ ${stuckShut.length} map(s) were soaked with the setup gates still shut`
      + ` (${stuckShut.map((r) => r.key).join(', ')}).`);
    L.push('    Their gated edges did not exist for the window, so those routes read as missing.');
  }

  const lost = results.reduce((a, r) => a + (r.dropped || 0), 0);
  if (lost) {
    L.push('');
    L.push(`  ${lost} chunk(s) dropped for straddling a map change. Node numbers resolve against`);
    L.push('    whatever graph is loaded, so a straddling window would have read the wrong map.');
  }
  return L.join('\n');
}

//---------------------------------------------------------------------------

async function soak(callTool, opts) {
  const g = mkCall(callTool, opts.instance);
  const keys = opts.keys.length ? opts.keys : nav.listKeys(opts.repo);
  if (!keys.length) throw new Error('no cached graphs - run `gg2navgen build --all` first');

  const was = await readRoster(g);
  const results = [];
  try {
    if (opts.bots) await setRoster(g, opts.bots);
    for (const key of keys) {
      lib.step(`${key}  (${opts.frames} frames at ${opts.speed}x)`);
      try {
        results.push(await soakOne(g, key, opts));
      } catch (e) {
        lib.warn(`${key}: ${e.message.split('\n')[0]}`);
        results.push({ key, error: e.message.split('\n')[0] });
      }
    }
  } finally {
    try {
      await g.raw('gg2_speed', { factor: 0 });
    } catch (e) {
      // The game may already be gone; the roster restore below matters more.
    }
    try {
      await restoreRoster(g, was);
    } catch (e) {
      lib.warn('could not restore the bot roster - check [Bots] in gg2.ini');
    }
  }
  return results;
}

const USAGE = `
navsoak.js - drive the rotation and harvest what the bots fail at

  node tools/navsoak.js [map|key ...] [options]

  --frames <n>      game frames to soak each map for (default 6000)
  --chunk <n>       frames between log drains (default 600). Lower it if the
                    capture rate comes back under 100%.
  --speed <n>       fast-forward factor, 1-20 (default 20)
  --bots <n>        fill the server to this many bots first, and restore after
  --window <ticks>  how close two blacklists must be to count as one wedge (60)
  --class <name>    class to model the offline verdict as (heavy)
  --limit <n>       rows per section (20)
  --json <path>     write the raw per-map result for downstream tooling
  --instance <name> which game, inside a gg2_session
  --repo <path>     the Gang Garrison 2 checkout
  --help

Exits 1 if any edge failed live AND is refused by the offline model - the two
methods share no code, so that pair is as confirmed as this project gets without
a person watching.

⚠️ The bridge serves one client at a time. From an editor session that already
holds the game this will hang, not fail; drive it with the MCP tools instead.
`;

if (require.main === module) {
  const mcp = require('./gg2-mcp-server');
  lib.setSink((line) => process.stdout.write(line + '\n'));

  lib.cli(async () => {
    const { flags, positional } = lib.parseArgs(process.argv.slice(2),
      ['frames', 'chunk', 'speed', 'bots', 'window', 'class', 'limit', 'json', 'instance', 'repo']);
    if (flags.help) lib.helpAndExit(USAGE);

    const repo = flags.repo || lib.defaultRepo();
    const known = nav.listKeys(repo);
    // A bare map name is that map's _a1 key - the resolution navsuspects still
    // wants and navimage already has (docs/OPEN.md).
    const keys = positional.map((p) => {
      if (known.includes(p)) return p;
      const hit = known.find((k) => nav.mapOf(k) === p);
      if (hit) return hit;
      throw new Error(`no cached graph for "${p}" - have: ${known.join(', ')}`);
    });

    const opts = {
      instance: flags.instance,
      keys,
      repo,
      frames: Number(flags.frames || 6000),
      chunk: Math.min(3000, Number(flags.chunk || 600)),
      speed: Math.max(1, Math.min(20, Number(flags.speed || 20))),
      bots: flags.bots ? Number(flags.bots) : 0,
      window: Number(flags.window || 60),
      cls: String(flags.class || 'heavy').toLowerCase(),
      limit: Number(flags.limit || 20),
    };

    try {
      await mcp.callTool('gg2_ping', { instance: opts.instance });
    } catch (e) {
      mcp.disconnectAll('failed to connect');
      throw new Error('could not reach the game. Start one with `node tools/session.js start`, '
        + `and note the bridge serves one client at a time. (${e.message.split('\n')[0]})`);
    }

    try {
      const results = await soak(mcp.callTool, opts);
      process.stdout.write(`${render(results, opts)}\n`);
      if (flags.json) {
        fs.writeFileSync(flags.json, JSON.stringify(results.map((r) => ({
          key: r.key,
          error: r.error,
          frames: r.frames,
          bots: r.bots,
          dropped: r.dropped,
          inSetup: r.inSetup,
          expected: r.expected,
          got: r.got,
          capture: r.capture,
          findings: r.error ? [] : findings(r),
        })), null, 2));
        lib.ok(`wrote ${flags.json}`);
      }
      const confirmed = results.filter((r) => !r.error).flatMap(findings).filter((f) => f.confirmed);
      if (confirmed.length) process.exitCode = 1;
    } finally {
      mcp.disconnectAll('done');
    }
  });
}

module.exports = { soak, soakOne, drain, parseDrain, gotoKey, findings, render, DRAIN_GML };
