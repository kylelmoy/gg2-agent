#!/usr/bin/env node
//=============================================================================
// control.js - a browser GUI for driving a running Gang Garrison 2.
//
// The MCP tools are built for an agent: one call, one answer, a paragraph of
// reasoning either side. Playtesting wants the opposite - freeze *now*, put me
// over there, make it eight bots, try that map - which is a control panel, not
// a conversation. This serves one.
//
// It drives the game through gg2-mcp-server.js's own `callTool`/`command`
// rather than reimplementing the wire protocol, exactly as botscenario.js does:
// the framing, the request ids, the wedged-bridge recovery and the modal-dialog
// detection are all subtle and all already solved in there. This file adds a
// transport (HTTP) and the four operations a playtest actually wants.
//
//   ONE CONNECTION AT A TIME. AgentBridge services a single client, so this
//   process and an editor's MCP session cannot both hold a game. Whoever is
//   second gets queued in the accept backlog forever, which presents as every
//   call timing out for no stated reason. /api/release drops this process's
//   sockets so an agent can take the game back without stopping the GUI; the
//   next request here reconnects. The page has a button for it.
//
// Usage:
//   node tools/control.js [--port 7311] [--repo <path>] [--no-open]
//=============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const lib = require('./lib.js');
const instances = require('./instances.js');
const mcp = require('./gg2-mcp-server.js');

// Requiring the MCP server points lib's sink at its own stderr log, which is
// right when it is serving and wrong here - it would tag this server's lines as
// if the MCP server had said them.
lib.setSink((line) => process.stdout.write(line + '\n'));

const UI_FILE = path.join(__dirname, 'control-ui.html');

//---------------------------------------------------------------------------
// Where the game lives
//
// lib.findBuildDir, the same one the MCP server uses - the two have to agree
// about which game they are talking about or the instance register resolves to
// nothing. Two copies of the search had already drifted apart by one candidate.
//---------------------------------------------------------------------------

let BUILD_DIR = lib.findBuildDir();
const repoOf = lib.repoOfBuildDir;

//---------------------------------------------------------------------------
// The map list
//
// Parsed out of the game's own findInternalMapName.gml rather than kept as a
// copy here, because serverGotoMap on a name that script does not know is a
// fatal show_error - "Shutting down." - not an exception. The list the page
// offers and the list the game accepts have to be the same list, so there is
// only one of them.
//
// Several names are aliases for one PNG - ctf_2dfort/ctf_2dfort2/ctf_2dfortremix
// are one map, dkoth_sixties/dkoth_60s another - and offering every spelling
// makes a menu worse, so one name per PNG reaches the list.
//
// Which one is not "the first": the game's own case list opens the oldfort group
// with `case "ctf_2dfort[0]"`, a legacy alias with brackets in it, which is both
// an ugly menu entry and one changeMap's own name check would then refuse. The
// PNG's basename is the canonical name whenever it is spelled as one of the
// aliases, which it is for every group here; the tidiest remaining alias wins
// otherwise.
//---------------------------------------------------------------------------

const TIDY_NAME = /^[a-z0-9_]+$/i;

function readMaps(buildDir) {
  const gml = path.join(repoOf(buildDir), 'Source', 'gg2', 'Scripts', 'Maps', 'findInternalMapName.gml');
  let text;
  try {
    text = fs.readFileSync(gml, 'utf8');
  } catch (e) {
    return [];
  }

  const byFile = new Map(); // png -> [alias, ...] in source order
  let pending = [];
  for (const line of text.split(/\r?\n/)) {
    const c = /^\s*case\s+"([^"]+)"\s*:/.exec(line);
    if (c) {
      pending.push(c[1]);
      continue;
    }
    const r = /^\s*return\s+"([^"]+\.png)"/.exec(line);
    if (r && pending.length) {
      if (!byFile.has(r[1])) byFile.set(r[1], []);
      byFile.get(r[1]).push(...pending);
      pending = [];
    }
  }

  const maps = [];
  for (const [file, aliases] of byFile) {
    const base = file.replace(/\.png$/i, '');
    const name = aliases.includes(base) ? base : aliases.find((a) => TIDY_NAME.test(a)) || aliases[0];
    maps.push({ name, mode: (/^([a-z]+)_/.exec(name) || [, 'other'])[1], aliases });
  }
  return maps;
}

let MAPS = readMaps(BUILD_DIR);
const isKnownMap = (name) => MAPS.some((m) => m.name === name);

//---------------------------------------------------------------------------
// Talking to a game
//---------------------------------------------------------------------------

// Resolve an instance name the way every MCP tool does, so "server" means here
// what it means there. Returns {name, port, ...}.
function target(want) {
  const found = instances.resolve(BUILD_DIR, want || undefined);
  if (found) return found;
  throw new Error('no game is running. Start one with gg2_session, or run-agent.js.');
}

// This process's belief about whether it has stopped the world. The bridge
// tracks its own copy for recovery purposes; this one is what the page shows,
// and it is per instance because freezing a server and freezing a client are
// different acts with different consequences.
const frozen = new Map();

const evalCode = (where, code) => mcp.callTool('gg2_eval', { instance: where.name, code });
const evalExpr = (where, expr) => mcp.callTool('gg2_evalx', { instance: where.name, expr });

//---------------------------------------------------------------------------
// The snapshot
//
// Built as one delimited string by the game rather than read field by field:
// a poll that costs nine round trips is a poll you cannot run once a second.
// gg2_state already returns most of this, but not `isBot` - and which players
// are bots is the whole point of half this panel - so it is assembled here
// instead of parsing GGON.
//
// chr(1) between fields and chr(2) between records, because a player name can
// contain any printable character a person can type and every printable
// separator is therefore a bug waiting for someone called "a|b".
//
// global.players exists only once a server or client has started - it is
// created in GameServerCreate/ClientCreate, not in game_init - so a game
// sitting in the menu room answers "nogame" rather than dying on a modal
// "Unknown variable players" dialog.
//
// FREEZING IS WHAT MAKES THIS AWKWARD, and it is the panel's headline feature.
// The bridge stops the world with instance_deactivate_all(true), and a
// deactivated instance's fields are unreachable from anywhere - so the obvious
// `p.name` raises "Unknown variable name" on every frozen poll. GM8 raises that
// as a modal dialog rather than an exception, so it does not even fail here: the
// launcher dismisses it, execute_string returns 0, and the *next* call is the
// one that gets blamed for the dialog it finds in the log.
//
// agentBridgeShot has the same problem for the same reason and solves it by
// reactivating, doing the work, and deactivating again - no step event runs, so
// nothing advances. Same idiom here. It is gated on the bridge's own
// `instancesDeactivated`, not on this process's belief about the freeze and not
// on `frozen` either: during a STEP's active frames the world is frozen but its
// instances are readable, which is exactly when a panel most wants to read them.
// EVAL runs via execute_string inside AgentBridge's own step, so that instance
// variable is in scope here.
//
// instance_exists() is still checked per player - it is false for a deactivated
// instance, so it is the guard that would have prevented this outright - and
// `p.object != -1` is tested BEFORE instance_exists(p.object) because -1 means
// `self` in GM8: instance_exists(-1) is true and would sail straight past.
//---------------------------------------------------------------------------

// Wrap a body so it can read and write instances whether or not the world is
// frozen. Everything the panel does touches Player or Character instances, so
// everything it sends goes through here.
function freezeSafe(body) {
  return [
    'var ctlWasDeact;',
    'ctlWasDeact = false;',
    'if(variable_local_exists("instancesDeactivated"))',
    '    ctlWasDeact = instancesDeactivated;',
    'if(ctlWasDeact)',
    '    instance_activate_all();',
  ]
    .concat(body)
    .concat(['if(ctlWasDeact)', '    instance_deactivate_all(true);'])
    .join('\n');
}

const SNAPSHOT_GML = freezeSafe([
  'var i, n, p, c, s, nav;',
  'if(!variable_global_exists("players"))',
  '    global.ctlSnapshot = "nogame";',
  'else',
  '{',
  '    nav = -1;',
  '    if(variable_global_exists("navReady"))',
  '        nav = global.navReady;',
  '    s = "";',
  '    if(variable_global_exists("currentMap"))',
  '        s = string(global.currentMap);',
  '    s = s + chr(1) + room_get_name(room) + chr(1) + string(fps)',
  '      + chr(1) + string(global.botsEnabled) + chr(1) + string(global.botMaxBots)',
  '      + chr(1) + string(global.botFillToPlayers) + chr(1) + string(global.botDifficulty)',
  '      + chr(1) + string(global.playerLimit) + chr(1) + string(getNumberOfOccupiedSlots())',
  '      + chr(1) + string(nav) + chr(2);',
  '    n = ds_list_size(global.players);',
  '    for(i = 0; i < n; i += 1)',
  '    {',
  '        p = ds_list_find_value(global.players, i);',
  '        if(p == -1)',
  '            continue;',
  '        if(!instance_exists(p))',
  '            continue;',
  '        s = s + string(i) + chr(1) + string(p.name) + chr(1) + string(p.team)',
  '          + chr(1) + string(p.class) + chr(1) + string(p.isBot);',
  '        c = p.object;',
  '        if(c != -1 and instance_exists(c))',
  '            s = s + chr(1) + string(round(c.x)) + chr(1) + string(round(c.y)) + chr(1) + string(round(c.hp));',
  '        else',
  '            s = s + chr(1) + chr(1) + chr(1);',
  '        s = s + chr(2);',
  '    }',
  '    global.ctlSnapshot = s;',
  '}',
]);

const TEAMS = ['red', 'blue', 'spectator'];
const CLASSES = ['Scout', 'Soldier', 'Sniper', 'Demoman', 'Medic', 'Engineer', 'Heavy', 'Spy', 'Pyro', 'Quote'];

async function snapshot(where) {
  await evalCode(where, SNAPSHOT_GML);
  const raw = await evalExpr(where, 'global.ctlSnapshot');

  if (raw.trim() === 'nogame') {
    return { instance: where.name, port: where.port, inGame: false, frozen: !!frozen.get(where.port), players: [] };
  }

  const records = raw.split('\x02').filter((r) => r.length);
  const head = (records.shift() || '').split('\x01');
  const num = (v) => (v === '' || v === undefined ? null : Number(v));

  return {
    instance: where.name,
    port: where.port,
    inGame: true,
    frozen: !!frozen.get(where.port),
    map: head[0],
    room: head[1],
    fps: num(head[2]),
    botsEnabled: num(head[3]) === 1,
    botMaxBots: num(head[4]),
    botFillToPlayers: num(head[5]),
    botDifficulty: num(head[6]),
    playerLimit: num(head[7]),
    humans: num(head[8]),
    // -1 is "this game has no nav graph at all" (a client), which is a
    // different thing from "not built yet" and must not render as a warning.
    navReady: num(head[9]) === -1 ? null : num(head[9]) === 1,
    players: records.map((r) => {
      const f = r.split('\x01');
      return {
        index: num(f[0]),
        name: f[1],
        team: num(f[2]),
        teamName: TEAMS[num(f[2])] || String(num(f[2])),
        class: num(f[3]),
        className: CLASSES[num(f[3])] || String(num(f[3])),
        isBot: num(f[4]) === 1,
        x: num(f[5]),
        y: num(f[6]),
        hp: num(f[7]),
      };
    }),
  };
}

//---------------------------------------------------------------------------
// The operations
//---------------------------------------------------------------------------

// A bare FREEZE, not gg2_step's freeze-then-advance: "pause" should stop on the
// frame you were looking at, not the one after it.
async function freeze(where) {
  await mcp.command(where, 'FREEZE');
  frozen.set(where.port, true);
  return 'frozen';
}

async function resume(where) {
  const r = await mcp.callTool('gg2_resume', { instance: where.name });
  frozen.set(where.port, false);
  return r || 'running';
}

async function step(where, frames) {
  const r = await mcp.callTool('gg2_step', { instance: where.name, frames });
  frozen.set(where.port, true);
  return r || 'stepped ' + frames;
}

async function speed(where, factor) {
  return await mcp.callTool('gg2_speed', { instance: where.name, factor });
}

//---------------------------------------------------------------------------
// Turning a click on the map picture into a world coordinate
//
// Three different units are in play and two of them look alike:
//
//   world      what the game uses, what teleport takes, what the F11 labels show
//   map pixel  the map PNG's own resolution and the nav graph's cell grid - one
//              nav cell is exactly one map pixel. NAV_CELL_SIZE world per cell.
//   image px   what gg2_map_image RETURNS, which is the map PNG upscaled - by 3
//              unless told otherwise.
//
// So world-per-image-pixel is NAV_CELL_SIZE / scale, and it is emphatically not
// NAV_CELL_SIZE. Getting that wrong put every marker and every click at three
// times its true offset, which on ctf_truefort (891 map px wide, returned at
// 2673) still lands inside the picture and still looks like a plausible spot -
// the failure is invisible near the left edge and grows across the map.
//
// The scale is pinned here rather than left to the tool's default, and the cell
// size is read from the running game rather than assumed, so the number the page
// gets is derived from both halves rather than hardcoded at either end.
//---------------------------------------------------------------------------

const MAP_SCALE = 3;
const cellSizeCache = new Map();

// How long the server holds the announced map change before making it, in ticks
// at 30 a second. The game's own end-of-round path uses 300 (ten seconds) to
// show a win banner; this only has to cover the client receiving MAP_END and
// quiescing, and a control panel should feel immediate.
const MAP_CHANGE_TICKS = 60;

async function worldPerPixel(where) {
  if (!cellSizeCache.has(where.port)) {
    const n = Number(await evalExpr(where, 'NAV_CELL_SIZE'));
    cellSizeCache.set(where.port, Number.isFinite(n) && n > 0 ? n : 6);
  }
  return cellSizeCache.get(where.port) / MAP_SCALE;
}

// Changing map has two ways to go wrong and both of them have bitten.
//
// 1. serverGotoMap calls show_error(..., true) on a name it does not recognise,
//    which is a fatal dialog, not an exception. So the name is checked twice -
//    against the list parsed out of findInternalMapName.gml, and then against
//    findInternalMapName inside the running game, which is the only authority
//    that actually matters.
//
// 2. CHANGING MAP IS A TWO-PHASE PROTOCOL AND BOTH PHASES ARE LOAD-BEARING.
//    GameServerBeginStep announces MAP_END, sets global.mapchanging, counts
//    down 300 ticks, and only then calls serverGotoMap + ServerChangeMap.
//
//    Skipping phase one does not work, and this was established by experiment
//    rather than by reading: with the CHANGE_MAP broadcast alone - and with
//    zero bots, so nothing else could be blamed - a connected client still died
//    every time. `global.mapchanging` is what quiesces the client: while it is
//    set, PlayerSpawn does not spawn, charSetSolids/gunSetSolids/
//    collision_line_bulletblocking all no-op, intel is dropped and team and
//    class changes are refused. A client taken straight from fully live to a
//    room change never gets that, and comes apart during the transition -
//    "The server sent unexpected data", a KothHUD raising "Unknown variable
//    teamoffset" on a CTF map, a Character with team 2 asking for a spectator
//    sprite. All symptoms of the same missing phase.
//
//    So this emits phase one exactly as the game does and then lets
//    GameServerBeginStep run phase two itself, on its own object at its own
//    point in the frame - rather than reimplementing the half that does the
//    room change, the CHANGE_MAP broadcast and the stat reset.
//
//    winners is TEAM_SPECTATOR because that is the game's own "nobody won"
//    value - WinBanner.Create has an explicit branch for it - and it must be a
//    real team id since MAP_END writes it as a ubyte. basicRoomSetup resets
//    global.winners to -1 on arrival, so this cannot leave the server
//    permanently believing a round just ended.
async function changeMap(where, name, wait) {
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error('not a map name: ' + JSON.stringify(name));
  if (!isKnownMap(name)) throw new Error(name + ' is not one of the built-in maps');

  const known = await evalExpr(where, 'findInternalMapName("' + name + '") != ""');
  if (Number(known) !== 1) throw new Error('the game does not recognise the map ' + JSON.stringify(name));

  // A frozen game cannot change room, and it cannot flush a send buffer either
  // - the object that services the network is deactivated - so writing
  // CHANGE_MAP into the buffer while frozen would leave a half-announced map
  // change sitting there. Resume first, always.
  if (frozen.get(where.port)) await resume(where);

  await evalCode(where, [
    'global.winners = TEAM_SPECTATOR;',
    'global.currentMapArea = 1;',
    'global.nextMap = "' + name + '";',
    // Set before the broadcast: it is what stops GameServerBeginStep's own
    // end-of-round block from firing on top of this one and picking a map out
    // of the rotation instead.
    'global.mapchanging = true;',
    'write_ubyte(global.sendBuffer, MAP_END);',
    'write_ubyte(global.sendBuffer, string_length(global.nextMap));',
    'write_string(global.sendBuffer, global.nextMap);',
    'write_ubyte(global.sendBuffer, global.winners);',
    'write_ubyte(global.sendBuffer, global.currentMapArea);',
    'if(!instance_exists(ScoreTableController))',
    '    instance_create(0, 0, ScoreTableController);',
    'instance_create(0, 0, WinBanner);',
    // Last, so the countdown cannot reach zero before the announcement above is
    // in the buffer. The real path waits 300 ticks to show a win banner; a
    // control panel only needs long enough for the client to receive MAP_END
    // and quiesce.
    'with(GameServer)',
    '    impendingMapChange = ' + MAP_CHANGE_TICKS + ';',
  ].join('\n'));

  if (!wait) return 'switching to ' + name + ' in ' + (MAP_CHANGE_TICKS / 30).toFixed(1) + 's';

  // The nav graph is rebuilt from scratch on arrival and the bots are useless
  // until it is: navBuildState 9 is done. Generous budget - truefort is the
  // big one. (Matches what botscenario.js waits for.)
  await mcp.callTool('gg2_wait', {
    instance: where.name,
    expr: 'global.navKey == "' + name + '_a1" and global.navBuildState == 9',
    frames: 3600,
  });
  return 'on ' + name + ', nav graph built';
}

// Set the bot population.
//
// The server has three knobs for this and only one of them means "N bots".
// A control panel that asks for 12 must get 12 and keep 12, so the other two are
// set to values that cannot interfere rather than left where a human's coming
// and going moves them:
//
//   botMaxBots        IS the knob. Set to what was asked for.
//   botFillToPlayers  is a fill-to-TOTAL, and the manager takes
//                     min(maxBots, fillToPlayers - humans) - so leaving it at
//                     humans+want means every human who joins evicts a bot.
//                     Set well clear of maxBots so it never binds.
//   botMinHumans      removes EVERY bot while fewer humans than this are
//                     connected. At its default of 1 an unattended server drops
//                     all 12 bots the moment the last client leaves, silently -
//                     which is exactly the "observe the bots" case. Set to 0.
//
// playerLimit is raised generously and never lowered. Bots are excluded from the
// join check (getNumberOfOccupiedSlots subtracts them), so this only has to
// cover humans - but that subtraction is a `with(Player)` loop, which iterates
// nothing while the world is frozen, and a frozen server therefore counts every
// bot as a human. Headroom is what stops that arithmetic ever reaching the
// limit and answering a join with "the server is full".
//
// Raising the count is just the globals - botPopulationUpdate reconciles on its
// next step - but lowering it is not: botRemoveOnDeath makes the manager wait
// for each surplus bot to die, which is right for a live server and wrong for a
// knob you just turned. So the surplus is removed here, newest first, collected
// before any of it is removed because botRemove renumbers global.players
// underneath an index loop.
async function setBots(where, count, difficulty) {
  const want = Math.max(0, Math.min(31, Math.round(count)));
  const diff = Math.max(1, Math.min(5, Math.round(difficulty)));

  await evalCode(where, freezeSafe([
    'var want, have, i, p, doomed, extra;',
    'want = ' + want + ';',
    'global.botDifficulty = ' + diff + ';',
    'global.botsEnabled = (want > 0);',
    'global.botMaxBots = want;',
    'global.botFillToPlayers = want + 24;',
    'global.botMinHumans = 0;',
    'if(global.playerLimit < want + 16)',
    '    global.playerLimit = min(48, want + 16);',
    'have = 0;',
    'with(Player)',
    '    if(isBot)',
    '        have += 1;',
    'if(have > want)',
    '{',
    '    doomed = ds_list_create();',
    '    extra = have - want;',
    '    for(i = ds_list_size(global.players) - 1; i >= 0; i -= 1)',
    '    {',
    '        if(extra <= 0)',
    '            break;',
    '        p = ds_list_find_value(global.players, i);',
    '        if(p == -1)',
    '            continue;',
    '        if(!instance_exists(p))',
    '            continue;',
    '        if(p.isBot)',
    '        {',
    '            ds_list_add(doomed, p);',
    '            extra -= 1;',
    '        }',
    '    }',
    '    for(i = 0; i < ds_list_size(doomed); i += 1)',
    '        botRemove(ds_list_find_value(doomed, i));',
    '    ds_list_destroy(doomed);',
    '}',
  ]));

  return 'bots -> ' + want + ' at difficulty ' + diff;
}

// Put a player somewhere. Velocity is zeroed as well as position: dropping a
// character mid-fall with its old vspeed intact sends it straight back through
// the floor it was just moved above.
//
// -1 is `self` in GM8, not "no instance", so both sentinel checks are real
// guards and not defensive noise - without them this would quietly teleport the
// AgentBridge object.
async function teleport(where, index, x, y) {
  const i = Math.round(index);
  if (!Number.isFinite(i) || i < 0) throw new Error('which player?');
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('need a finite x and y');

  await evalCode(where, freezeSafe([
    'var p, c;',
    'p = ds_list_find_value(global.players, ' + i + ');',
    'if(p != -1 and instance_exists(p))',
    '{',
    '    c = p.object;',
    '    if(c != -1 and instance_exists(c))',
    '    {',
    '        c.x = ' + Math.round(x) + ';',
    '        c.y = ' + Math.round(y) + ';',
    '        c.hspeed = 0;',
    '        c.vspeed = 0;',
    '    }',
    '}',
  ]));
  return '-> ' + Math.round(x) + ', ' + Math.round(y);
}

//---------------------------------------------------------------------------
// HTTP
//---------------------------------------------------------------------------

const send = (res, code, type, body) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => {
      b += d;
      if (b.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        reject(new Error('bad JSON body'));
      }
    });
  });
}

// Every failure a game can produce arrives here as an Error whose message is
// already written for a person - the MCP server takes trouble over that. The
// one thing worth adding is the one-client rule, because a bridge timeout is
// the symptom and "something else is holding the game" is the cause, and
// nothing in the timeout says so.
function explain(e) {
  const msg = e && e.message ? e.message : String(e);
  if (/timed out|Cannot reach a game/i.test(msg)) {
    return (
      msg +
      '\n\nIf a game IS running, something else may be holding its bridge: AgentBridge ' +
      'services one connection at a time, so an editor MCP session connected to the same ' +
      'game leaves this one queued. Close that session or have it release the game.'
    );
  }
  return msg;
}

const OPS = {
  freeze: (w) => freeze(w),
  resume: (w) => resume(w),
  step: (w, b) => step(w, Math.max(1, Math.min(3600, Math.round(Number(b.frames) || 1)))),
  speed: (w, b) => speed(w, Number(b.factor) || 0),
  map: (w, b) => changeMap(w, String(b.name || ''), b.wait !== false),
  bots: (w, b) => setBots(w, Number(b.count), Number(b.difficulty) || 3),
  teleport: (w, b) => teleport(w, Number(b.index), Number(b.x), Number(b.y)),
  eval: (w, b) => evalCode(w, String(b.code || '')).then(() => 'ok'),
  evalx: (w, b) => evalExpr(w, String(b.expr || '')),
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(UI_FILE));
  }

  if (p === '/api/maps') return json(res, 200, { ok: true, maps: MAPS });

  if (p === '/api/instances') {
    const live = instances.list(BUILD_DIR).map((i) => ({ name: i.name, port: i.port, role: i.role }));
    return json(res, 200, { ok: true, instances: live, buildDir: BUILD_DIR });
  }

  // Dropping the sockets is the whole point, so this must not go through
  // target() - it has to work even when nothing is registered any more.
  if (p === '/api/release') {
    mcp.disconnectAll('released from the control panel');
    frozen.clear();
    return json(res, 200, { ok: true, result: 'bridge released - an agent can take the game now' });
  }

  if (p === '/api/state') {
    try {
      return json(res, 200, { ok: true, state: await snapshot(target(url.searchParams.get('instance'))) });
    } catch (e) {
      return json(res, 200, { ok: false, error: explain(e) });
    }
  }

  if (p === '/api/mapimage' || p === '/api/screenshot') {
    try {
      const where = target(url.searchParams.get('instance'));
      const out =
        p === '/api/mapimage'
          ? await mcp.callTool('gg2_map_image', {
              instance: where.name,
              base: url.searchParams.get('base') || 'art',
              scale: MAP_SCALE,
            })
          : await mcp.callTool('gg2_screenshot', { instance: where.name });
      const img = (Array.isArray(out) ? out : []).find((c) => c.type === 'image');
      if (!img) throw new Error('the game returned no image');
      const png = Buffer.from(img.data, 'base64');
      const headers = { 'Content-Type': img.mimeType || 'image/png', 'Cache-Control': 'no-store' };
      if (p === '/api/mapimage') headers['X-World-Per-Pixel'] = String(await worldPerPixel(where));
      res.writeHead(200, headers);
      return res.end(png);
    } catch (e) {
      return json(res, 200, { ok: false, error: explain(e) });
    }
  }

  const op = /^\/api\/([a-z]+)$/.exec(p);
  if (op && OPS[op[1]] && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const where = target(body.instance);
      const result = await OPS[op[1]](where, body);
      return json(res, 200, { ok: true, result: String(result === undefined ? 'ok' : result) });
    } catch (e) {
      return json(res, 200, { ok: false, error: explain(e) });
    }
  }

  return json(res, 404, { ok: false, error: 'no such endpoint: ' + p });
}

//---------------------------------------------------------------------------
// Entry point
//---------------------------------------------------------------------------

function main() {
  const { flags } = lib.parseArgs(process.argv.slice(2), ['port', 'repo']);
  if (flags.help) {
    lib.helpAndExit([
      'usage: node tools/control.js [options]',
      '',
      '  --port <n>     what to listen on (default 7311)',
      '  --repo <path>  the Gang Garrison 2 checkout (default: ../Gang-Garrison-2)',
      '  --no-open      do not open a browser',
      '',
      'Drives a game that is already running. Start one first with gg2_session or',
      'run-agent.js. Only one client can hold a game bridge at a time, so an MCP',
      'session on the same game must release it - see the button on the page.',
    ].join('\n'));
  }

  if (flags.repo) {
    BUILD_DIR = lib.findBuildDir(flags.repo);
    MAPS = readMaps(BUILD_DIR);
  }

  const port = Number(flags.port) || 7311;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => json(res, 500, { ok: false, error: explain(e) }));
  });

  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port + '/';
    lib.ok('control panel on ' + url);
    lib.detail('build dir ' + BUILD_DIR);
    lib.detail(MAPS.length + ' built-in maps');
    const live = instances.list(BUILD_DIR);
    if (live.length === 0) lib.warn('no game is running - start one with gg2_session or run-agent.js');
    else lib.detail('games: ' + live.map((i) => i.name + ' (' + i.port + ')').join(', '));
    if (!flags['no-open']) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  });

  // Keep-alive sockets to the game would hold the process open past Ctrl-C, and
  // leaving them held is also what would stop an agent taking the game back.
  const bye = () => {
    mcp.disconnectAll('control panel shutting down');
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

if (require.main === module) main();

module.exports = { readMaps, snapshot, setBots, teleport, changeMap };
