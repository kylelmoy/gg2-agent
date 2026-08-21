#!/usr/bin/env node
//=============================================================================
// botscenario.js - does the bot still do the thing?
//
// The third and most expensive tier of bot testing. The other two should catch
// most regressions before anything gets here:
//
//   1. the game's own GML unit suite (gg2_test)  - tables, arithmetic, the aim
//      solver against a forward simulation of the engine. Milliseconds, no
//      flake, but it cannot express "run 600 frames and then check", because a
//      GML script runs to completion inside one step and there is no way to
//      yield. That limit is the whole reason this file exists in Node.
//   2. navaudit.js - can a bot path from its spawn to the objective, read off
//      the cached graphs with no game running. ~1s for every shipped map.
//
// What only this tier can see is whether the bot can *execute* what the graph
// promised. That distinction is not academic: every one of this project's three
// jump-edge bugs was a graph describing an arc the follower could not fly, and
// navaudit passes all of them, because the edge is right there in the graph.
//
// WHAT A SCENARIO MEASURES
//
// Not "is the bot at B". A bot that arrives clears its goal and is then free to
// walk off, so a position sampled at the end says nothing - measured live, a bot
// that had genuinely completed its leg read as 1854px from the goal a few
// thousand frames later. What is asserted instead:
//
//   arrived       botArrived, latched by botPathKeys when it stops on the goal
//   ticks         botArrivedAt - the tick the goal was issued. Exact, because
//                 the game records it; polling from out here could only ever
//                 bracket it to the poll interval.
//   replans       botReplans     - a route re-planned. Some is normal.
//   stuck         botStuckFires  - the follower gave up on making progress.
//   blacklisted   botBlacklistFires - an edge misled it and was banned.
//   offRoute      botOffRouteFires  - it finished a move somewhere the route
//                                     did not go.
//
// The last four are the interesting half. A leg that still arrives but now
// re-plans nine times instead of once is a regression that "did it arrive"
// cannot see, and most of this project's navigation bugs would have moved one
// of these counters well before they stopped the bot completing a leg.
//
// THREE WAYS A SCENARIO LIES, ALL FOUND BY RUNNING IT
//
//   1. The objective layer overwrites the goal. botObjectiveUpdate rewrites it
//      from the game mode every BOT_OBJECTIVE_PERIOD, so a goal set from out
//      here survives at most 30 ticks and the test silently measures the
//      objective layer. Fixed in the game with botGoalLocked, which is a flag
//      nothing else sets.
//   2. A raw coordinate is not a place. botSetGoal needs its point to resolve
//      to a nav node; an objective marker floating 60px above its floor does
//      not, and the bot then stands still forever with no path and no error.
//      Every from/to here is put through botNodeSnap first.
//   3. The game keeps playing. At 20x a scenario burns a minute of game time in
//      three seconds, and rounds end, teams get shuffled and bots respawn
//      somewhere else entirely - which is what that 1854px reading above
//      actually was. The runner pins the bot's Character at the start and voids
//      the scenario if it changes, rather than reporting a number it cannot
//      stand behind.
//
// ON DETERMINISM
//
// Navigation is very nearly deterministic already. Of the nine random() sites in
// the bot code, eight are gated behind `botTarget != noone` - so with no enemies
// in the room the only live one is botRegroupUntil, a spawn hold of up to 90
// ticks, which the runner zeroes. The route seed and goal spread are derived
// from the bot's instance id, so those are pinned explicitly rather than left to
// whatever id the bot happened to get.
//
// Combat scenarios are a different problem and this runner does not pretend
// otherwise: aim error, hold-fire and evasion are all live there, and a single
// pass/fail over one run would be noise. Those want N runs and a distribution
// compared against a stored baseline - which is a mode to add here, not a
// different tool, since the setup and teardown are the same.
//
// ⚠️ ONE CLIENT AT A TIME - which is why this is also an MCP tool
//
//
// AgentBridge accepts a connection only when it does not already have one
// (`if (sock < 0)` in agentBridgeStep). A second client is accepted by the OS
// into the listen backlog and then never serviced, so it does not fail - it
// hangs, and every call times out with the game plainly alive and answering the
// other client. In practice that means this CLI cannot run while an editor's MCP
// server is connected to the same game - which is exactly when you would want to
// run it.
//
// So the primary way to run these is the `gg2_scenario` MCP tool, which calls
// runOne() in-process over the connection the server already holds. The CLI
// stays for CI and for a game nothing else is talking to; it pings first and
// explains itself rather than timing out anonymously.
//
// Usage:
//   node botscenario.js                    run every scenario
//   node botscenario.js valley-floor-to-point   run one
//   node botscenario.js --list             names and maps, run nothing
//   node botscenario.js --speed 10         fast-forward factor (default 20)
//   node botscenario.js --keep             leave the bots in place at the end
//=============================================================================

const lib = require('./lib');
const { SCENARIOS } = require('./bot-scenarios');

// `call` is passed in rather than required, and that is not ceremony: the MCP
// server is a consumer of this module (gg2_scenario), so requiring it back here
// would be a cycle, and Node would hand whichever module loaded second a
// half-initialised copy of the other. Threading the caller also means the CLI
// and the MCP tool share one code path instead of two that drift.
//
// Whatever is passed must be the MCP server's callTool or something with its
// behaviour, because two of its habits are load-bearing here: it lints every
// snippet before sending, and it reads the launcher log for GM8 dialogs. A GML
// error inside execute_string is not an exception - it is a modal box the
// launcher dismisses while execute_string returns 0 - so without that, a
// mistyped expression comes back as a plausible wrong number and no signal.

const USAGE = `
botscenario.js - live bot behaviour scenarios

  node botscenario.js [<name>] [options]

  (no name)         run every scenario
  <name>            run one, by its name in bot-scenarios.js

  --list            list the scenarios and exit
  --speed <n>       fast-forward factor, 1-20 (default 20)
  --instance <s>    which running game (default: the only one)
  --keep            do not remove the test bot afterwards
  --help
`;

const evalCode = (call, inst, code) => call('gg2_eval', { instance: inst, code });
const evalExpr = (call, inst, expr) => call('gg2_evalx', { instance: inst, expr });

// One round trip that both sets up and starts watching. The game keeps running
// between separate calls, so a setup done as its own call leaves an unknown
// amount of game time before the wait actually arms.
const waitFor = (call, inst, expr, frames, setup) =>
  call('gg2_wait', { instance: inst, expr, frames, setup });

//---------------------------------------------------------------------------
// Reading a bundle of values back
//
// Never read a live instance reference across two calls: the game runs in
// between, so an id cached in one call can be stale or reused by the next. Each
// probe below builds its whole answer inside a single gg2_eval into a global,
// then reads that global back - the id never leaves the game.
//---------------------------------------------------------------------------

// Values come back as `key=value` pairs joined by spaces, which keeps the GML
// side to string concatenation - there is no structured return from the bridge,
// and building JSON in GML would be more code in the place that is hardest to
// debug.
function parseFields(text) {
  const out = {};
  for (const pair of String(text).trim().split(/\s+/)) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const v = pair.slice(at + 1);
    out[pair.slice(0, at)] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}

async function probe(call, inst, code) {
  await evalCode(call, inst, code);
  return parseFields(await evalExpr(call, inst, 'global.scenReport'));
}

//---------------------------------------------------------------------------
// Map
//---------------------------------------------------------------------------

// Changing map is most of a scenario's cost, so it is skipped when the game is
// already there. Waiting on navBuildState alone races: it is still 9 from the
// previous map for a frame or two before navServerTick notices the key changed,
// so the key has to be part of the condition.
async function ensureMap(call, inst, map) {
  const now = await evalExpr(call, inst, 'global.currentMap');
  if (String(now).trim() === map) {
    await waitFor(call, inst, `global.navReady and global.navKey == "${map}_a1"`, 1800);
    return false;
  }
  lib.step(`map -> ${map}`);
  await waitFor(call, inst, `global.navKey == "${map}_a1" and global.navBuildState == 9`, 3600,
    `global.currentMapArea = 1; serverGotoMap("${map}");`);
  return true;
}

//---------------------------------------------------------------------------
// Bots
//
// Teardown has to be thorough, and the reason is not tidiness. Roles are handed
// out by counting a bot's position among its team's bots of the same class
// period (botRoleAssign), so a bot left over from the previous scenario shifts
// the next one's role assignment. Two scenarios that pass alone and fail in
// sequence is the worst kind of test suite to own.
//---------------------------------------------------------------------------

async function clearBots(call, inst) {
  await evalCode(call, inst,
    `var i, p, doomed;
doomed = ds_list_create();
for(i = 0; i < ds_list_size(global.players); i += 1)
{
    p = ds_list_find_value(global.players, i);
    if(p == -1)
        continue;
    if(p.isBot)
        ds_list_add(doomed, p);
}
for(i = 0; i < ds_list_size(doomed); i += 1)
    botRemove(ds_list_find_value(doomed, i));
ds_list_destroy(doomed);
global.botsEnabled = false;`);
}

//---------------------------------------------------------------------------
// One scenario
//---------------------------------------------------------------------------

// Which counters are asserted, and which are only reported.
//
// `stuck` is the only one asserted by default, because it is the only one that
// means the same thing on every route: the follower gave up on making progress.
//
// `replans` is deliberately NOT a defect signal and must never be given a bare
// cap. Planning is on a timer - botReplanAt is frame + BOT_REPLAN_TICKS +
// (player mod BOT_REPLAN_TICKS) - so a route re-plans every 45 to 90 ticks
// whether or not anything is wrong, and the count is therefore a measure of how
// long the leg took. Measured: 11 replans on a 586-tick leg, which is below what
// the timer alone produces. Capping it would fail every scenario for the crime
// of being long. Worse, the interval depends on the bot's instance id, so the
// count moves between runs on its own. The re-plans that do mean something are
// already counted separately by offRoute and blacklisted, which are what force
// the event-driven ones.
//
// offRoute and blacklisted are real signals but have no universal baseline -
// jumpy terrain earns some honestly. So they are reported, and asserted only
// once a scenario has been measured and states a number it expects to hold.
const DEFAULT_ALLOW = { stuck: 0 };
const COUNTERS = ['replans', 'stuck', 'blacklisted', 'offRoute'];

async function runOne(call, inst, s, speed) {
  const allow = Object.assign({}, DEFAULT_ALLOW, s.allow || {});
  const team = s.team === 'blue' ? 'TEAM_BLUE' : 'TEAM_RED';

  await ensureMap(call, inst, s.map);
  await clearBots(call, inst);

  // Add the bot and wait for it to actually have a body: botAdd queues a spawn
  // on an alarm rather than spawning inline, and everything below needs the
  // Character.
  await waitFor(call, inst, 'global.scenBot.object != -1', 300,
    `global.scenBot = botAdd(${team}, ${s.class}, "scen");`);

  // Place, pin and launch, all inside one call. Splitting this across calls
  // would let the bot walk, re-plan or be re-teamed between placement and the
  // goal being issued, and the tick count would silently include that.
  const setup = await probe(call, inst,
    `var p, c, fromN, toN, fx, fy, tx, ty;
p = global.scenBot;
c = p.object;
global.scenReport = "";

fromN = botNodeSnap(${s.from[0]}, ${s.from[1]});
toN = botNodeSnap(${s.to[0]}, ${s.to[1]});
if(fromN < 0 or toN < 0)
{
    global.scenReport = "fromNode=" + string(fromN) + " toNode=" + string(toN) + " ok=0";
    exit;
}

// A node's own canonical stand position - the same arithmetic botSetGoalNode
// uses - so that navNodeFromWorld resolves both ends back to these same nodes.
fx = navColWorldX(max(ds_grid_get(global.navNodes, NAV_NODE_X0, fromN),
                  min(ds_grid_get(global.navNodes, NAV_NODE_X1, fromN),
                      navAnchorCol(${s.from[0]}))));
fy = (ds_grid_get(global.navNodes, NAV_NODE_Y, fromN) + NAV_BOX_H) * NAV_CELL_SIZE - 23;
tx = navColWorldX(max(ds_grid_get(global.navNodes, NAV_NODE_X0, toN),
                  min(ds_grid_get(global.navNodes, NAV_NODE_X1, toN),
                      navAnchorCol(${s.to[0]}))));
ty = (ds_grid_get(global.navNodes, NAV_NODE_Y, toN) + NAV_BOX_H) * NAV_CELL_SIZE - 23;

c.x = fx;
c.y = fy;
c.hspeed = 0;
c.vspeed = 0;

// The regroup hold is the one live random() in a fight-free scenario: up to 90
// ticks of standing at spawn waiting for team-mates. Zeroing it is the
// difference between a tick count that is a measurement and one that is a
// measurement plus a uniform 0-3s.
p.botRegroupUntil = 0;
// Derived from the instance id by botRoleAssign, so pin them rather than
// inheriting whatever id this bot happened to get.
p.botRouteSeed = 1;
p.botSpreadX = 0;
p.botGoalLocked = true;

botSetGoal(p, tx, ty);

global.scenT0 = GameServer.frame;
global.scenChar = c.id;
global.scenReport = "fromNode=" + string(fromN) + " toNode=" + string(toN)
    + " fx=" + string(round(fx)) + " fy=" + string(round(fy))
    + " tx=" + string(round(tx)) + " ty=" + string(round(ty))
    + " t0=" + string(global.scenT0) + " ok=1";`);

  if (!setup.ok) {
    return {
      name: s.name,
      verdict: 'VOID',
      why: `no nav node under from=[${s.from}] (${setup.fromNode}) or to=[${s.to}] (${setup.toNode})`,
      setup,
    };
  }

  // Fast-forward, then wait for the leg to finish in a single call.
  //
  // gg2_wait keeps the speed boost - it never touches instances, it only
  // re-tests its expression once per step from agentBridgeDefer. (The bridge's
  // own notes used to claim otherwise and this harness polled around it for
  // nothing; measured 2026-08-21, 600 frames waited in 1022ms at ~587 fps with
  // room_speed still 600 afterwards.) What does end a boost is a room change,
  // which is why the factor is applied here rather than once at startup:
  // ensureMap above may have just replaced RateController.
  //
  // Waiting rather than polling is also what makes the tick count exact. The
  // condition is tested every frame inside the game, so a leg cannot finish
  // between two samples - and `arrived or died or out of budget` is one
  // expression, so the runner learns which of the three happened by reading the
  // state afterwards rather than by racing it.
  if (speed > 1) await call('gg2_speed', { instance: inst, factor: speed });

  // Budget plus a margin: the wait's own frame cap is a backstop for a game that
  // has stopped stepping, while the in-expression budget test is what decides a
  // scenario, so the two must not be the same number.
  const cap = Math.min(3600, s.budget + 120);
  await call('gg2_wait', {
    instance: inst,
    frames: cap,
    expr:
      'global.scenBot.botArrived' +
      ' or global.scenBot.object != global.scenChar' +
      ` or GameServer.frame - global.scenT0 > ${s.budget}`,
    skip_lint: true,
  }).catch(() => {}); // a timeout here is "still going", which the state below reports properly

  const last = await probe(call, inst,
    `var p;
p = global.scenBot;
global.scenReport = "frame=" + string(GameServer.frame)
    + " arrived=" + string(p.botArrived)
    + " arrivedAt=" + string(p.botArrivedAt)
    + " replans=" + string(p.botReplans)
    + " stuck=" + string(p.botStuckFires)
    + " blacklisted=" + string(p.botBlacklistFires)
    + " offRoute=" + string(p.botOffRouteFires)
    + " path=" + string(p.botPath)
    + " sameChar=" + string(p.object == global.scenChar)
    + " d=" + string(round(point_distance(p.object.x, p.object.y, p.botGoalX, p.botGoalY)));`);

  if (speed > 1) await call('gg2_speed', { instance: inst, factor: 0 });

  // Checked before anything is asserted: a bot that died or was re-teamed
  // mid-leg makes every counter below meaningless rather than merely bad.
  if (!last.sameChar) {
    return { name: s.name, verdict: 'VOID', why: 'the bot died or was re-teamed mid-scenario', setup, last };
  }

  const ticks = last.arrived ? last.arrivedAt - setup.t0 : null;
  const fails = [];
  if (!last.arrived) fails.push(`never arrived (still ${last.d}px away after ${s.budget} ticks)`);
  else if (ticks > s.budget) fails.push(`took ${ticks} ticks, budget ${s.budget}`);
  for (const k of COUNTERS) {
    if (allow[k] !== undefined && last[k] > allow[k]) fails.push(`${k} ${last[k]} > ${allow[k]}`);
  }

  // A scenario that documents a bug nobody has fixed yet is worth keeping and
  // must not turn the suite red for ever - a suite that is always red is a suite
  // nobody reads. `known` reports it as KNOWN instead, and green then means "no
  // new regressions" rather than "everything works". A known scenario that
  // starts passing is reported too, loudly: that is someone having fixed it, and
  // the entry should come out.
  let verdict = fails.length ? 'FAIL' : 'PASS';
  if (s.known && verdict === 'FAIL') verdict = 'KNOWN';
  if (s.known && verdict === 'PASS') verdict = 'FIXED';

  return {
    name: s.name,
    verdict,
    why: fails.join('; '),
    known: s.known,
    ticks,
    setup,
    last,
    about: s.about,
  };
}

//---------------------------------------------------------------------------

// Every scenario prints its whole counter set, passing or not. A failing test
// that shows only the assertion that broke makes you re-run it to find out
// what the other numbers were doing, and re-running this tier is not free -
// these are the numbers you calibrate a budget against.
function metrics(r) {
  if (!r.last) return '';
  const t = r.ticks === null || r.ticks === undefined ? `no arrival (${r.last.d}px short)` : `${r.ticks} ticks`;
  return `${t}, replans ${r.last.replans}, stuck ${r.last.stuck}, ` +
    `blacklisted ${r.last.blacklisted}, offRoute ${r.last.offRoute}`;
}

function report(results) {
  for (const r of results) {
    if (r.verdict === 'PASS') lib.ok(`${r.name}  ${metrics(r)}`);
    else if (r.verdict === 'FIXED') lib.ok(`${r.name}  ${metrics(r)}  [was KNOWN-broken - drop its known entry]`);
    else if (r.verdict === 'VOID') lib.warn(`${r.name}  ${r.why}  [VOID - not a verdict on the bot]`);
    else if (r.verdict === 'KNOWN') lib.warn(`${r.name}  ${r.why}  [KNOWN]`);
    else lib.fail(`${r.name}  ${r.why}`);

    if (r.verdict === 'FAIL' || r.verdict === 'KNOWN') {
      lib.detail(metrics(r));
      if (r.verdict === 'KNOWN') lib.detail(`known: ${r.known}`);
      else if (r.about) lib.detail(r.about);
    }
  }

  const tally = (v) => results.filter((r) => r.verdict === v).length;
  const parts = [`${tally('PASS') + tally('FIXED')}/${results.length} passed`];
  for (const v of ['KNOWN', 'VOID', 'FAIL']) if (tally(v)) parts.push(`${tally(v)} ${v.toLowerCase()}`);
  lib.step(parts.join(', '));

  // Only a genuine regression fails the run. VOID means the scenario could not
  // be set up, which is a bug in the scenario rather than in the bot, but it is
  // still not a pass - so it counts.
  return tally('FAIL') + tally('VOID');
}

// Pick scenarios by name, or all of them. Shared so the CLI and the MCP tool
// cannot disagree about what "no name given" means.
function select(names) {
  if (!names || !names.length) return SCENARIOS;
  const todo = SCENARIOS.filter((s) => names.includes(s.name));
  if (!todo.length) throw new Error(`no scenario named ${names.join(', ')} - known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  return todo;
}

// Run a set of scenarios and hand back both the raw results and a rendered
// report. The caller decides what to do with them - the CLI prints and sets an
// exit code, the MCP tool returns the text.
async function runAll(call, { instance, names, speed = 20, keep = false } = {}) {
  const todo = select(names);
  const factor = Math.max(1, Math.min(20, Number(speed) || 20));
  const results = [];
  for (const s of todo) results.push(await runOne(call, instance, s, factor));
  if (!keep) await clearBots(call, instance);
  await call('gg2_speed', { instance, factor: 0 });
  return results;
}

// Render without printing, so the MCP tool can return the same text the CLI
// shows instead of reimplementing the formatting.
function render(results) {
  const lines = [];
  const restore = lib.setSink((line) => lines.push(line));
  let bad;
  try {
    bad = report(results);
  } finally {
    // Put the sink back whatever happened, or one throw in here silently
    // redirects the MCP server's own logging into a dead array.
    restore();
  }
  return { text: lines.join('\n'), bad };
}

if (require.main === module) {
  const mcp = require('./gg2-mcp-server');
  // Requiring the MCP server points lib's sink at its own stderr log, which is
  // right when it is serving and wrong here - it would tag every line of this
  // runner's report as if the server had said it.
  lib.setSink((line) => process.stdout.write(line + '\n'));

  lib.cli(async () => {
    const { flags, positional } = lib.parseArgs(process.argv.slice(2), ['speed', 'instance']);
    if (flags.help) lib.helpAndExit(USAGE);

    if (flags.list) {
      for (const s of SCENARIOS) lib.detail(`${s.name.padEnd(28)} ${s.map}`);
      return;
    }

    const inst = flags.instance;

    // Prove the bridge is ours before running anything. Without this the
    // one-client-at-a-time rule above presents as every scenario timing out for
    // no stated reason, which reads exactly like the bots being broken.
    try {
      await mcp.callTool('gg2_ping', { instance: inst });
    } catch (e) {
      mcp.disconnectAll('failed to connect');
      throw new Error(
        'could not reach the game. If it is running and answering another client, that is ' +
          'the problem: AgentBridge services one connection at a time, so an editor MCP ' +
          'session connected to the same game leaves this one queued forever. Close it and ' +
          `retry, or use the gg2_scenario tool from that session instead. (${e.message.split('\n')[0]})`
      );
    }

    let results;
    try {
      results = await runAll(mcp.callTool, {
        instance: inst,
        names: positional,
        speed: flags.speed,
        keep: flags.keep,
      });
    } finally {
      // The sockets are keep-alive, so without this the process never exits.
      mcp.disconnectAll('done');
    }

    if (report(results) > 0) process.exit(1);
  });
}

module.exports = { runOne, runAll, clearBots, ensureMap, select, render, report, SCENARIOS };
