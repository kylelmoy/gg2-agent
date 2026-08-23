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
// WRITING ONE WHILE YOU WORK
//
// The tool takes an inline `scenario` - the same shape as a file entry, passed
// in the call - and runs that and nothing else. That is the loop for a behaviour
// you are in the middle of: define, run, nudge a coordinate, run again, with
// nothing written to disk and no throwaway probe left in the committed suite.
// Promote it into bot-scenarios.js only once it is worth keeping. `normalise`
// validates inline and saved scenarios identically, so a typo is caught the same
// way in both, and `map`/`class` are checked rather than trusted because both
// are interpolated into GML - an unknown class name would otherwise surface as a
// modal dialog about a line in a snippet nobody can see.
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

  To run a scenario you have not saved to bot-scenarios.js, use the
  gg2_scenario MCP tool's inline "scenario" argument.
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
//
// A timeout here usually means the map has no nav graph on disk rather than that
// the map change failed - the game loads graphs and no longer builds them, so a
// map gg2-nav-gen has not been run over never reaches state 9. Run
// `gg2navgen build --all`.
async function ensureMap(call, inst, map) {
  const now = await evalExpr(call, inst, 'global.currentMap');
  if (String(now).trim() === map) {
    await waitFor(call, inst, `global.navReady and global.navKey == "${map}_a1"`, 1800);
    await pastSetup(call, inst);
    return false;
  }
  lib.step(`map -> ${map}`);
  await waitFor(call, inst, `global.navKey == "${map}_a1" and global.navBuildState == 9`, 3600,
    `global.currentMapArea = 1; serverGotoMap("${map}");`);
  await pastSetup(call, inst);
  return true;
}

// A round starts in setup, and during setup the setup gates are SHUT - which is not a
// detail, it is a different map. ctf_avanti has 63 setup-gated edges, and a leg measured
// inside that window is measured against a graph where they do not exist: the same
// avanti scenario read 897 ticks as the first run after a map change and 266-289 on
// every run after it, because the first one was routed the long way round quite
// correctly. Nothing in the counters says so, which is what makes it dangerous - it
// looks exactly like flake, and "run it again" makes it go away.
//
// So a scenario waits for the gates to open before anything is placed. ⚠️ That means
// this harness cannot currently measure setup-phase behaviour at all; a scenario that
// wants to would need a field here saying so, and to say what it expects, rather than
// getting it by accident of ordering.
//
// areSetupGatesClosed() is safe on every map - global.setupTimer is 0 where there is no
// setup phase, and the FauxCPHUD branch simply does not run.
async function pastSetup(call, inst) {
  if (Number(await evalExpr(call, inst, 'areSetupGatesClosed()')) === 0) return;
  lib.step('waiting for the setup gates to open');
  await waitFor(call, inst, 'not areSetupGatesClosed()', 3600);
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

// How much hp the enemy team is currently carrying: every live enemy Character
// plus any enemy Generator. Sampled once at setup and again at the end, the drop
// is damage this scenario's bot dealt - exactly, as long as the enemies are
// dummies, since a dummy never fires and so nothing else can be removing hp.
//
// ⚠️ This is a difference of two snapshots, so it is only monotone while nothing
// heals or respawns. That is why a dummy is given 100000 hp: a dead one respawns
// at full and the difference reads zero, which is indistinguishable from a bot
// that never fired. With `dummy: false` that protection is gone and the number
// needs repeats rather than a single verdict.
//
// A Generator counts because on gen_destroy it IS the target: at 2100 hp it is
// shot from range and never touched, which is the case that most wants an
// assertion, and it cannot respawn to muddy the reading the way a Character can.
const enemyHpGml = (teamConst) => `
hpsum = 0;
with(Character)
{
    if(team != ${teamConst})
    {
        if(hp > 0)
            hpsum += hp;
    }
}
with(Generator)
{
    if(team != ${teamConst})
        hpsum += hp;
}`;

async function runOne(call, inst, s, speed) {
  const allow = Object.assign({}, DEFAULT_ALLOW, s.allow || {});
  const team = s.team === 'blue' ? 'TEAM_BLUE' : 'TEAM_RED';
  const foeTeam = s.team === 'blue' ? 'TEAM_RED' : 'TEAM_BLUE';
  const window = s.to ? s.budget : s.hold;

  await ensureMap(call, inst, s.map);
  await clearBots(call, inst);

  // Add the bot and wait for it to actually have a body: botAdd queues a spawn
  // on an alarm rather than spawning inline, and everything below needs the
  // Character.
  await waitFor(call, inst, 'global.scenBot.object != -1', 300,
    `global.scenBot = botAdd(${team}, ${s.class}, "scen");`);

  // Enemies, if any, in one call - then one wait for all their bodies. Counting
  // Characters is enough and avoids needing a per-enemy expression, which GM8
  // could not loop over anyway.
  if (s.enemies.length) {
    await waitFor(call, inst, `instance_number(Character) >= ${s.enemies.length + 1}`, 300,
      s.enemies.map((e, i) => `botAdd(${foeTeam}, ${e.class}, "foe${i}");`).join('\n'));
  }

  // Place, pin and launch, all inside one call. Splitting this across calls
  // would let the bot walk, re-plan or be re-teamed between placement and the
  // goal being issued, and the tick count would silently include that.
  const setup = await probe(call, inst,
    `var p, c, fromN, toN, fx, fy, tx, ty, hpsum, ex, ey, k, i, q, n, placed;
p = global.scenBot;
c = p.object;
global.scenReport = "";

fromN = botNodeSnap(${s.from[0]}, ${s.from[1]});
toN = ${s.to ? `botNodeSnap(${s.to[0]}, ${s.to[1]})` : '0'};
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

${s.enemies.length ? `
// Place the enemies, in the roster order they were added in. A dummy is pinned
// twice over: botGoalLocked stops the objective layer walking it away, and an
// acquisition delay longer than any scenario stops it ever aiming or firing -
// both are ordinary knobs, so this needs no test-only code in the game.
${s.enemies.map((e, i) => `ex[${i}] = ${e.at[0]}; ey[${i}] = ${e.at[1]}; q[${i}] = ${e.dummy ? 1 : 0};`).join('\n')}
placed = 0;
k = 0;
for(i = 0; i < ds_list_size(global.players); i += 1)
{
    var foe;
    foe = ds_list_find_value(global.players, i);
    if(foe == -1)
        continue;
    if(!foe.isBot)
        continue;
    if(foe == p)
        continue;
    if(foe.object == -1)
        continue;
    if(k >= ${s.enemies.length})
        break;
    n = botNodeSnap(ex[k], ey[k]);
    if(n >= 0)
    {
        foe.object.x = navColWorldX(max(ds_grid_get(global.navNodes, NAV_NODE_X0, n),
                                    min(ds_grid_get(global.navNodes, NAV_NODE_X1, n),
                                        navAnchorCol(ex[k]))));
        foe.object.y = (ds_grid_get(global.navNodes, NAV_NODE_Y, n) + NAV_BOX_H) * NAV_CELL_SIZE - 23;
        foe.object.hspeed = 0;
        foe.object.vspeed = 0;
        placed += 1;
    }
    foe.botGoalLocked = true;
    foe.botRegroupUntil = 0;
    if(q[k] == 1)
    {
        foe.botAcquireTicks = 9999999;
        // A dummy is a damage sponge, and that is what makes the damage figure
        // a measurement rather than a coin flip. Damage is read as enemy hp at
        // setup minus enemy hp at the end; a dummy that DIES and respawns comes
        // back at full hp and the difference reads zero. Measured exactly that:
        // the same scenario gave 34.91, 113.73 and then 0, the zero being a run
        // where the Heavy died with time to spare and respawned before the
        // window closed. Scaling maxHp with hp keeps the ratio botFindTarget
        // scores on (hp <= maxHp * 0.4), so it still reads as a healthy enemy.
        foe.object.maxHp = 100000;
        foe.object.hp = 100000;
    }
    k += 1;
}
global.scenReport = global.scenReport + "foesPlaced=" + string(placed) + " ";
` : ''}

${s.to ? `
tx = navColWorldX(max(ds_grid_get(global.navNodes, NAV_NODE_X0, toN),
                  min(ds_grid_get(global.navNodes, NAV_NODE_X1, toN),
                      navAnchorCol(${s.to[0]}))));
ty = (ds_grid_get(global.navNodes, NAV_NODE_Y, toN) + NAV_BOX_H) * NAV_CELL_SIZE - 23;
botSetGoal(p, tx, ty);
` : `
// Hold: no goal at all. botPathKeys returns no keys without one, and
// botGoalLocked keeps the objective layer from supplying one, so the bot stands
// where it was put and does nothing but fight.
tx = fx;
ty = fy;
`}

${enemyHpGml(team)}

global.scenT0 = GameServer.frame;
global.scenChar = c.id;
global.scenFx = fx;
global.scenFy = fy;
global.scenHp0 = hpsum;
global.scenAcquired = 0;
global.scenReport = global.scenReport + "fromNode=" + string(fromN) + " toNode=" + string(toN)
    + " fx=" + string(round(fx)) + " fy=" + string(round(fy))
    + " tx=" + string(round(tx)) + " ty=" + string(round(ty))
    + " hp0=" + string(hpsum)
    + " t0=" + string(global.scenT0) + " ok=1";`);

  if (!setup.ok) {
    return {
      name: s.name,
      verdict: 'VOID',
      why: s.to
        ? `no nav node under from=[${s.from}] (${setup.fromNode}) or to=[${s.to}] (${setup.toNode})`
        : `no nav node under from=[${s.from}] (${setup.fromNode})`,
      setup,
    };
  }

  if (s.enemies.length && setup.foesPlaced !== s.enemies.length) {
    return {
      name: s.name,
      verdict: 'VOID',
      why: `placed ${setup.foesPlaced} of ${s.enemies.length} enemies - one of the "at" points has no nav node under it`,
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
  // has stopped stepping, while the in-expression window test is what decides a
  // scenario, so the two must not be the same number.
  //
  // A hold scenario has no early exit - standing still for the whole window is
  // the point - but it still latches whether a target was ever acquired, because
  // "aimed at the wrong thing" and "never saw anything" are different bugs with
  // the same symptom and the difference is gone by the time the window ends.
  const cap = Math.min(3600, window + 120);
  const outOfTime = `GameServer.frame - global.scenT0 > ${window}`;
  const died = 'global.scenBot.object != global.scenChar';

  if (s.to) {
    // A nav leg ends the moment it arrives - there is nothing to learn from the
    // frames after that, and stopping early is most of why the suite is quick.
    await call('gg2_wait', {
      instance: inst,
      frames: cap,
      expr: `global.scenBot.botArrived or ${died} or ${outOfTime}`,
      skip_lint: true,
    }).catch(() => {});
  } else {
    // A hold scenario runs its whole window - standing still for all of it is
    // the point. But "did it ever acquire a target" has to be latched while it
    // happens: botTarget is cleared when the target dies or leaves range, so by
    // the end a bot that fought and won looks like one that never saw anything.
    // Wait for the first acquisition, record it, then run the rest out.
    await call('gg2_wait', {
      instance: inst,
      frames: cap,
      expr: `global.scenBot.botTarget != noone or ${died} or ${outOfTime}`,
      skip_lint: true,
    }).catch(() => {});
    await evalCode(call, inst, 'if(global.scenBot.botTarget != noone) global.scenAcquired = 1;');
    await call('gg2_wait', {
      instance: inst,
      frames: cap,
      expr: `${died} or ${outOfTime}`,
      skip_lint: true,
    }).catch(() => {});
  }

  const last = await probe(call, inst,
    `var p, hpsum;
p = global.scenBot;
${enemyHpGml(team)}
if(p.botTarget != noone)
    global.scenAcquired = 1;
global.scenReport = "frame=" + string(GameServer.frame)
    + " arrived=" + string(p.botArrived)
    + " arrivedAt=" + string(p.botArrivedAt)
    + " replans=" + string(p.botReplans)
    + " stuck=" + string(p.botStuckFires)
    + " blacklisted=" + string(p.botBlacklistFires)
    // Space-free by construction (see botBlacklistEdge), so it survives the
    // whitespace-split field parser as one token. Empty when nothing was
    // blacklisted, which parses to "" and prints as nothing.
    + " blacklistLog=" + p.botBlacklistLog
    + " offRoute=" + string(p.botOffRouteFires)
    + " path=" + string(p.botPath)
    + " sameChar=" + string(p.object == global.scenChar)
    + " damage=" + string(global.scenHp0 - hpsum)
    + " acquired=" + string(global.scenAcquired)
    + " firing=" + string((p.botAttackKeys & KEY_ATTACK) != 0)
    + " moved=" + string(round(point_distance(p.object.x, p.object.y, global.scenFx, global.scenFy)))
    + " d=" + string(round(point_distance(p.object.x, p.object.y, p.botGoalX, p.botGoalY)));`);

  if (speed > 1) await call('gg2_speed', { instance: inst, factor: 0 });

  // Checked before anything is asserted: a bot that died or was re-teamed
  // mid-leg makes every counter below meaningless rather than merely bad.
  if (!last.sameChar) {
    return { name: s.name, verdict: 'VOID', why: 'the bot died or was re-teamed mid-scenario', setup, last };
  }

  const ticks = last.arrived ? last.arrivedAt - setup.t0 : null;
  const fails = [];

  if (s.to) {
    if (!last.arrived) fails.push(`never arrived (still ${last.d}px away after ${s.budget} ticks)`);
    else if (ticks > s.budget) fails.push(`took ${ticks} ticks, budget ${s.budget}`);
  }

  for (const k of COUNTERS) {
    if (allow[k] !== undefined && last[k] > allow[k]) fails.push(`${k} ${last[k]} > ${allow[k]}`);
  }

  // Combat expectations. Everything here is measured for every scenario and
  // asserted only where one was stated, so a nav scenario can still say "and it
  // took no damage getting there" without becoming a different kind of thing.
  const measured = { damage: last.damage, moved: last.moved, ticks: ticks === null ? last.frame - setup.t0 : ticks };
  for (const [k, bound] of Object.entries(s.expect)) {
    if (k === 'acquired') {
      const got = last.acquired === 1;
      if (got !== bound) fails.push(bound ? 'never acquired a target' : `acquired a target and should not have`);
      continue;
    }
    const v = measured[k];
    if (bound.min !== undefined && v < bound.min) fails.push(`${k} ${v} < ${bound.min}`);
    if (bound.max !== undefined && v > bound.max) fails.push(`${k} ${v} > ${bound.max}`);
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
    hold: s.to ? 0 : s.hold,
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
// A hold scenario and a nav scenario are interested in different halves of the
// same measurement bag, so each prints the half that means something. Printing
// route counters for a bot that was told to stand still would be noise, and
// printing "no arrival" for one is actively misleading.
function metrics(r) {
  if (!r.last) return '';
  if (r.hold) {
    return `held ${r.hold} ticks, damage ${r.last.damage}, moved ${r.last.moved}px, ` +
      `acquired ${r.last.acquired ? 'yes' : 'no'}, firing ${r.last.firing ? 'yes' : 'no'}`;
  }
  const t = r.ticks === null || r.ticks === undefined ? `no arrival (${r.last.d}px short)` : `${r.ticks} ticks`;
  // WHICH edges were blacklisted, when there were any. A count says an arc
  // misled the follower; the endpoints say which arc, and that is the line that
  // turns a scenario result into a `navaudit --node` query. Printed only when
  // non-empty, so the common all-clear line stays short.
  const bl = r.last.blacklistLog ? ` (${r.last.blacklistLog})` : '';
  return `${t}, replans ${r.last.replans}, stuck ${r.last.stuck}, ` +
    `blacklisted ${r.last.blacklisted}${bl}, offRoute ${r.last.offRoute}`;
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

//---------------------------------------------------------------------------
// Validating a scenario
//
// Applied to inline scenarios and to the ones in bot-scenarios.js alike, so
// there is one definition of what a valid scenario is and a typo in the file is
// caught the same way as a typo in a tool call.
//
// `map` and `class` are worth checking rather than trusting, because both are
// interpolated into GML source: an unknown class name becomes an undefined
// variable inside execute_string, which GM8 reports as a modal dialog naming a
// line number in a snippet nobody can see. Failing here instead names the field.
//---------------------------------------------------------------------------

const CLASSES = [
  'CLASS_SCOUT', 'CLASS_SOLDIER', 'CLASS_SNIPER', 'CLASS_DEMOMAN', 'CLASS_MEDIC',
  'CLASS_ENGINEER', 'CLASS_HEAVY', 'CLASS_SPY', 'CLASS_PYRO', 'CLASS_QUOTE',
];

function point(v, field, name) {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isFinite(Number(n)))) {
    throw new Error(`${name}: ${field} must be [x, y] world coordinates, got ${JSON.stringify(v)}`);
  }
  return [Number(v[0]), Number(v[1])];
}

const BOUNDS = ['min', 'max'];

// expect.<what>.<min|max>, e.g. { damage: { min: 1 }, moved: { max: 40 } }.
// `acquired` is the one boolean, because "did it ever pick a target" has no
// useful magnitude - it separates "aimed at the wrong thing" from "never saw
// anything", which are different bugs with the same symptom.
const MEASURES = ['damage', 'moved', 'ticks'];

function expectations(spec, name) {
  const out = {};
  for (const [k, v] of Object.entries(spec.expect || {})) {
    if (k === 'acquired') {
      if (typeof v !== 'boolean') throw new Error(`${name}: expect.acquired must be true or false`);
      out.acquired = v;
      continue;
    }
    if (!MEASURES.includes(k)) {
      throw new Error(`${name}: expect.${k} is not a measurement - use ${MEASURES.join(', ')} or acquired`);
    }
    if (!v || typeof v !== 'object') throw new Error(`${name}: expect.${k} must be {min} and/or {max}`);
    const bound = {};
    for (const [b, n] of Object.entries(v)) {
      if (!BOUNDS.includes(b)) throw new Error(`${name}: expect.${k}.${b} - only min and max`);
      if (!Number.isFinite(Number(n))) throw new Error(`${name}: expect.${k}.${b} must be a number`);
      bound[b] = Number(n);
    }
    out[k] = bound;
  }
  return out;
}

function enemies(spec, name) {
  const list = spec.enemies === undefined ? [] : spec.enemies;
  if (!Array.isArray(list)) throw new Error(`${name}: enemies must be an array`);
  return list.map((e, i) => {
    const who = `${name}: enemies[${i}]`;
    if (!e || typeof e !== 'object') throw new Error(`${who} must be an object`);
    const cls = e.class === undefined ? 'CLASS_HEAVY' : String(e.class);
    if (!CLASSES.includes(cls)) throw new Error(`${who}.class must be one of ${CLASSES.join(', ')}`);
    return {
      class: cls,
      at: point(e.at, 'at', who),
      // A dummy never aims and never moves, so every point of damage measured is
      // this scenario's bot doing it. Turn it off for a genuine two-sided fight,
      // and expect the numbers to need repeats rather than a single verdict.
      dummy: e.dummy === undefined ? true : Boolean(e.dummy),
    };
  });
}

function normalise(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('a scenario must be an object');
  const name = String(spec.name || 'ad-hoc');

  if (typeof spec.map !== 'string' || !/^[A-Za-z0-9_]+$/.test(spec.map)) {
    throw new Error(`${name}: map must be an internal map name like "koth_valley", got ${JSON.stringify(spec.map)}`);
  }
  const cls = spec.class === undefined ? 'CLASS_SOLDIER' : String(spec.class);
  if (!CLASSES.includes(cls)) {
    throw new Error(`${name}: class must be one of ${CLASSES.join(', ')} - got ${JSON.stringify(spec.class)}`);
  }
  const team = spec.team === undefined ? 'red' : String(spec.team);
  if (team !== 'red' && team !== 'blue') {
    throw new Error(`${name}: team must be "red" or "blue", got ${JSON.stringify(spec.team)}`);
  }

  // `to` walks somewhere, `hold` stands still - and a scenario is one or the
  // other, never both and never neither. Requiring the choice rather than
  // defaulting it is deliberate: a combat scenario that silently inherited a
  // movement goal would measure the wrong thing and still look like it passed.
  const hasTo = spec.to !== undefined;
  const hasHold = spec.hold !== undefined;
  if (hasTo && hasHold) throw new Error(`${name}: give "to" (walk somewhere) or "hold" (stand still), not both`);
  if (!hasTo && !hasHold) throw new Error(`${name}: needs either "to" (a place to walk to) or "hold" (ticks to stand and fight)`);

  const budget = spec.budget === undefined ? 1200 : Number(spec.budget);
  if (!Number.isFinite(budget) || budget < 1) throw new Error(`${name}: budget must be a positive number of ticks`);
  const hold = hasHold ? Number(spec.hold) : 0;
  if (hasHold && (!Number.isFinite(hold) || hold < 1)) throw new Error(`${name}: hold must be a positive number of ticks`);

  const allow = {};
  for (const [k, v] of Object.entries(spec.allow || {})) {
    if (!COUNTERS.includes(k)) {
      // Deliberately does not offer `replans`, which the next check rejects.
      throw new Error(
        `${name}: allow.${k} is not a counter - use one of ${COUNTERS.filter((c) => c !== 'replans').join(', ')}`
      );
    }
    if (k === 'replans') {
      throw new Error(
        `${name}: allow.replans cannot be set. Planning is on a 45-90 tick timer, so replans measures how long ` +
          'the leg took rather than whether anything went wrong, and the interval depends on the bot instance ' +
          'id so it moves between runs. Use stuck, blacklisted or offRoute.'
      );
    }
    if (!Number.isFinite(Number(v)) || Number(v) < 0) throw new Error(`${name}: allow.${k} must be a number >= 0`);
    allow[k] = Number(v);
  }

  return {
    name,
    map: spec.map,
    about: spec.about ? String(spec.about) : '',
    class: cls,
    team,
    from: point(spec.from, 'from', name),
    to: hasTo ? point(spec.to, 'to', name) : null,
    hold,
    budget,
    allow,
    enemies: enemies(spec, name),
    expect: expectations(spec, name),
    known: spec.known ? String(spec.known) : undefined,
  };
}

// Pick scenarios by name, or all of them, or take inline ones as given. Shared
// so the CLI and the MCP tool cannot disagree about what "no name given" means.
//
// Inline scenarios are the point of `adhoc`: iterating on a behaviour means
// running one thing repeatedly with a coordinate nudged, and making that a
// committed file edit each time is both slow and a good way to leave a
// throwaway probe in the suite. Write it inline, get it working, then promote it
// into bot-scenarios.js once it is worth keeping.
function select(names, adhoc) {
  if (adhoc) {
    const list = Array.isArray(adhoc) ? adhoc : [adhoc];
    if (!list.length) throw new Error('scenario was given but empty');
    return list.map(normalise);
  }
  if (!names || !names.length) return SCENARIOS.map(normalise);
  const todo = SCENARIOS.filter((s) => names.includes(s.name));
  if (!todo.length) throw new Error(`no scenario named ${names.join(', ')} - known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  return todo.map(normalise);
}

// Run a set of scenarios and hand back both the raw results and a rendered
// report. The caller decides what to do with them - the CLI prints and sets an
// exit code, the MCP tool returns the text.
async function runAll(call, { instance, names, scenario, speed = 20, keep = false } = {}) {
  const todo = select(names, scenario);
  const factor = Math.max(1, Math.min(20, Number(speed) || 20));

  // What the population manager was doing before we turned it off, so it can be
  // turned back on. clearBots sets global.botsEnabled = false - it has to, or the
  // manager refills the roster mid-scenario and the role assignment moves under
  // the test - but game_init writes every one of these globals back out to
  // gg2.ini on shutdown. So a suite run used to leave `[Bots] Enabled=0` on
  // disk, and the next ordinary game the user started had no bots in it at all,
  // with nothing anywhere saying why. Measured exactly that, 2026-08-21.
  let botsWere = null;
  try {
    botsWere = await evalExpr(call, instance, 'global.botsEnabled');
  } catch (e) {
    // Not fatal: an older build without the population manager still runs
    // scenarios fine, it just has nothing to restore.
  }

  const results = [];
  try {
    for (const s of todo) results.push(await runOne(call, instance, s, factor));
    if (!keep) await clearBots(call, instance);
  } finally {
    await call('gg2_speed', { instance, factor: 0 });
    if (botsWere !== null && String(botsWere).trim() !== '0') {
      try {
        await evalCode(call, instance, 'global.botsEnabled = true;');
      } catch (e) {
        lib.warn('could not restore global.botsEnabled - check [Bots] Enabled in gg2.ini');
      }
    }
  }
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
