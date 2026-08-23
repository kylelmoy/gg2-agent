//=============================================================================
// navcensus.js - harvest what the bots have ALREADY failed at, from a game that
// is simply running.
//
// tools/botscenario.js asks one bot to walk one leg that somebody thought of in
// advance. That is the right shape for a regression suite and the wrong shape
// for a search: three maps are covered, the legs are the ones already suspected,
// and a failure somewhere nobody aimed at is invisible.
//
// Meanwhile an ordinary dedicated server with twelve bots on it walks the whole
// map thousands of times an hour and records every failure as it happens. Every
// bot already carries:
//
//   botBlacklistFires   edges it gave up on
//   botStuckFires       times it pressed a key and went nowhere
//   botOffRouteFires    times a finished move left it somewhere off its route
//   botBlacklistLog     "why:from>to@frame", the endpoints, in order
//
// Nobody was reading them. This reads them off every bot at once, aggregates by
// edge and by node, and - if the graph for that map is cached - says which of
// the failures navfollow could have predicted offline. Measured on an untouched
// 52k-frame ctf_truefort server: 12 bots, 749 blacklists between them, and 12 of
// the 123 distinct edges named were ones navfollow independently calls unflyable.
//
// TWO SIGNATURES, AND THEY ARE DIFFERENT BUGS
//
// The `why` tag and the timing separate them, and mixing them up sends you
// looking at the wrong half of the code:
//
//   off  a finished move put the bot somewhere its route does not mention. This
//        is a LYING EDGE - the arc did not go where the graph said. Every one of
//        the twelve edges navfollow flagged on truefort was reported as `off`,
//        and never as `stk`.
//
//   stk  the bot pressed a key and did not move for BOT_STUCK_TICKS. This is a
//        WEDGE, and it is about the node, not the edge: the log shows one `from`
//        with four or five different `to` values twelve ticks apart, which is
//        the bot working through every exit it has and failing at all of them
//        because it never left the ground at all.
//
//   thr  replanned twice without covering ground.
//
// So a burst - one `from`, several `to`, consecutive frames - is one finding
// about a node, and must not be counted as several findings about edges. That
// is what --nodes ranks, and it is the view that puts a trap at the top.
//
// ⚠️ TWO THINGS THAT WILL FOOL THIS, BOTH SEEN IN THE FIRST HARVEST
//
//   1. **The log is capped at 240 characters** (botBlacklistEdge keeps only what
//      fits), so a bot with 92 fires reports its first ~14. The counters are
//      exact and the log is a biased early sample - which is fine for finding
//      places and wrong for counting them. Do not read the totals here as rates.
//
//   2. **Immobility that has nothing to do with navigation still reads as stuck.**
//      Six of the twelve bots blacklisted something at frame 3512 exactly, on
//      unrelated nodes across the whole map - a round transition, where nothing
//      can move and every bot's stuck detector fires at once. --since drops
//      everything before a frame; a cluster of unrelated nodes at one frame is
//      the signature to look for before believing any of them.
//
//   3. **Node numbers are only meaningful inside one map's graph, and the log is
//      not cleared on a map change.** A rotating server hands back a log whose
//      early entries name nodes on a map that is no longer loaded, and those
//      numbers resolve perfectly well against the current graph - to the wrong
//      surfaces. Caught the first time this ran: a `n58>n44` that was really
//      koth_gallery's pit, read against ctf_truefort's graph. Events naming a
//      pair that is not an edge in the current graph are marked `stale?` and
//      kept out of the ranking, which catches most of it; `--reset` then
//      `--since` is how to get a clean window on purpose.
//
// This reads only. It runs `gg2_evalx` against a live game and changes nothing,
// so it is safe against a server mid-round - but the bridge serves ONE client at
// a time, so from an editor session with the MCP tools attached, read the same
// fields with gg2_evalx rather than running this CLI (see CLAUDE.md).
//=============================================================================

const lib = require('./lib');

// The per-bot fields worth pulling. Cheap: one evalx each, ~40ms.
const FIELDS = ['name', 'botBlacklistFires', 'botStuckFires', 'botOffRouteFires', 'botBlacklistLog'];

async function harvest(callTool, opts = {}) {
  const call = async (expr) => {
    const r = await callTool('gg2_evalx', { expr, instance: opts.instance });
    return typeof r === 'string' ? r : String(r);
  };

  const map = (await call('global.currentMap')).replace(/^"|"$/g, '');
  const area = Number(await call('global.currentMapArea')) || 1;
  const frame = Number(await call('GameServer.frame'));
  const count = Number(await call('ds_list_size(global.players)'));

  const bots = [];
  for (let i = 0; i < count; i++) {
    const p = `(ds_list_find_value(global.players,${i})).`;
    if (String(await call(p + 'isBot')) !== '1') continue;
    const row = { index: i };
    for (const f of FIELDS) row[f] = await call(p + f);
    bots.push(row);
  }
  return { map, area, frame, key: `${map}_a${area}`, bots };
}

// Zero every bot's diagnostics so the next harvest covers a known window. This
// is the one thing here that writes: it touches only the four counters and the
// log string, never anything the game plans or steers with, so it is safe to run
// against a server mid-round. Clear, leave it playing for a few minutes on the
// map in question, harvest - that is the sweep this is for.
const RESET_GML = `
for(agentCensusI = 0; agentCensusI < ds_list_size(global.players); agentCensusI += 1)
{
    agentCensusP = ds_list_find_value(global.players, agentCensusI);
    if(agentCensusP.isBot)
    {
        agentCensusP.botBlacklistLog = "";
        agentCensusP.botBlacklistFires = 0;
        agentCensusP.botStuckFires = 0;
        agentCensusP.botOffRouteFires = 0;
    }
}
`.trim();

async function reset(callTool, opts = {}) {
  await callTool('gg2_eval', { code: RESET_GML, instance: opts.instance });
}

// "off:280>285@1352,stk:470>471@3512" -> one record per event.
function parseLog(text) {
  const out = [];
  for (const m of String(text).matchAll(/(off|stk|thr):(\d+)>(\d+)@(\d+)/g)) {
    out.push({ why: m[1], from: Number(m[2]), to: Number(m[3]), frame: Number(m[4]) });
  }
  return out;
}

// A burst is one `from` blacklisting several exits inside a few dozen ticks:
// one wedge, not several bad edges. Collapsing them is what keeps a node with
// nine exits from outranking a genuinely broken arc nine times over.
function collapse(events, window = 60) {
  const bursts = [];
  const sorted = events.slice().sort((a, b) => a.frame - b.frame || a.from - b.from);
  for (const e of sorted) {
    const open = bursts.find((b) => b.from === e.from && e.frame - b.last <= window);
    if (open) { open.last = e.frame; open.to.add(e.to); open.why.add(e.why); open.n += 1; }
    else bursts.push({ from: e.from, first: e.frame, last: e.frame, n: 1, to: new Set([e.to]), why: new Set([e.why]) });
  }
  return bursts;
}

function aggregate(h, opts = {}) {
  const since = opts.since || 0;
  const events = [];
  for (const b of h.bots) {
    for (const e of parseLog(b.botBlacklistLog)) {
      if (e.frame >= since) events.push({ ...e, bot: b.name });
    }
  }

  const edges = new Map();
  for (const e of events) {
    const k = `${e.from}>${e.to}`;
    const rec = edges.get(k) || { from: e.from, to: e.to, off: 0, stk: 0, thr: 0, bots: new Set() };
    rec[e.why] += 1;
    rec.bots.add(e.bot);
    edges.set(k, rec);
  }

  const bursts = collapse(events, opts.window);
  const nodes = new Map();
  for (const b of bursts) {
    const rec = nodes.get(b.from) || { node: b.from, bursts: 0, exits: new Set(), why: new Set(), frames: [] };
    rec.bursts += 1;
    for (const t of b.to) rec.exits.add(t);
    for (const w of b.why) rec.why.add(w);
    rec.frames.push(b.first);
    nodes.set(b.from, rec);
  }

  // A frame where several UNRELATED nodes fire at once is a game-state freeze
  // (round transition, setup), not a navigation failure. Name them rather than
  // silently dropping them - the caller may want the frame, not the verdict.
  const byFrame = new Map();
  for (const e of events) {
    const rec = byFrame.get(e.frame) || new Set();
    rec.add(e.from);
    byFrame.set(e.frame, rec);
  }
  const freezes = [...byFrame.entries()]
    .filter(([, froms]) => froms.size >= 3)
    .map(([frame, froms]) => ({ frame, nodes: froms.size }));

  return { events, edges: [...edges.values()], nodes: [...nodes.values()], freezes };
}

// Join the harvest against what navfollow says offline, when the graph for this
// map is on disk. An edge that both a live bot and the offline model reject is
// as confirmed as this project gets without a person watching.
function withModel(agg, key, repo, cls) {
  let verdict = null;
  try {
    const nav = require('./navgraph');
    const nf = require('./navfollow');
    const g = nav.load(key, repo);
    const p = nf.profile(cls);
    const rows = nf.analyse(g, p, { tol: 6 });
    const bad = new Map(rows.filter((r) => r.failBest).map((r) => [`${r.from}>${r.to}`, r]));
    const all = new Map(rows.map((r) => [`${r.from}>${r.to}`, r]));
    verdict = { g, bad, all, cls };
  } catch (e) {
    return { ...agg, modelError: e.message };
  }
  const g = verdict.g;
  for (const e of agg.edges) {
    const k = `${e.from}>${e.to}`;
    e.unflyable = verdict.bad.has(k);
    e.short = e.unflyable ? Math.round(verdict.bad.get(k).shortBest) : null;
    e.isJump = verdict.all.has(k);
    // Not an edge in the graph that is loaded now. Either the log survived a map
    // change (the usual case on a rotating server) or the graph was rebuilt under
    // it - and both mean these node numbers point at the wrong geometry.
    e.stale = e.from >= g.node.length || e.to >= g.node.length
      || !g.out[e.from].some((x) => x.to === e.to);
  }
  for (const n of agg.nodes) {
    n.stale = n.node >= g.node.length;
  }
  return { ...agg, model: verdict };
}

//---------------------------------------------------------------------------

function render(h, agg, opts) {
  const lines = [];
  const totals = h.bots.reduce((a, b) => ({
    bl: a.bl + Number(b.botBlacklistFires || 0),
    stk: a.stk + Number(b.botStuckFires || 0),
    off: a.off + Number(b.botOffRouteFires || 0),
  }), { bl: 0, stk: 0, off: 0 });

  lines.push(`${h.key}  frame ${h.frame}, ${h.bots.length} bot(s)`);
  lines.push(`  totals: ${totals.bl} blacklists, ${totals.stk} stuck, ${totals.off} off-route`);
  lines.push(`  logged: ${agg.events.length} event(s) with endpoints`
    + '   (the log is capped at 240 chars per bot - an early sample, not a rate)');
  if (agg.modelError) lines.push(`  no offline verdict: ${agg.modelError}`);

  if (agg.freezes.length) {
    const worst = agg.freezes.sort((a, b) => b.nodes - a.nodes).slice(0, 3);
    lines.push(`  ⚠ ${agg.freezes.length} frame(s) where 3+ unrelated nodes fired at once`
      + ` (likely a round transition, not navigation): `
      + worst.map((f) => `${f.frame}(${f.nodes})`).join(', '));
  }

  const stale = agg.edges.filter((e) => e.stale);
  if (stale.length) {
    lines.push(`  ⚠ ${stale.length} of ${agg.edges.length} logged edges are not edges in the graph`
      + ' loaded now - the log survives a map change. Held out of the ranking below;'
      + ' use --reset then --since for a clean window.');
  }

  const edges = agg.edges.filter((e) => !e.stale).sort((a, b) =>
    (b.unflyable ? 1 : 0) - (a.unflyable ? 1 : 0) || b.off - a.off || b.bots.size - a.bots.size);
  lines.push('');
  lines.push('  edges, worst first');
  lines.push('     edge        off   stk   thr   bots   offline verdict');
  for (const e of edges.slice(0, opts.limit)) {
    lines.push(`  n${String(e.from).padEnd(4)}->n${String(e.to).padEnd(5)}`
      + `${String(e.off).padStart(4)}${String(e.stk).padStart(6)}${String(e.thr).padStart(6)}`
      + `${String(e.bots.size).padStart(7)}   `
      + (e.unflyable ? `UNFLYABLE, lands ${e.short}px short` : e.isJump ? 'jump the model accepts' : ''));
  }
  if (edges.length > opts.limit) lines.push(`     ... ${edges.length - opts.limit} more`);

  const nodes = agg.nodes.slice().sort((a, b) => b.bursts - a.bursts || b.exits.size - a.exits.size);
  lines.push('');
  lines.push('  nodes, by how often a bot got wedged there');
  lines.push('     node    bursts   exits tried   kinds');
  for (const n of nodes.slice(0, opts.limit)) {
    if (n.bursts < 2 && n.exits.size < 3) continue;
    lines.push(`  n${String(n.node).padEnd(6)}${String(n.bursts).padStart(6)}`
      + `${String(n.exits.size).padStart(14)}   ${[...n.why].join(',')}`);
  }
  return lines.join('\n');
}

const USAGE = `
navcensus.js - what the bots on a running server have already failed at

  node tools/navcensus.js [options]

  --reset           zero every bot's counters and log first, then report nothing
                    (the way to get a clean window: reset, play, harvest)
  --since <frame>   ignore events before this frame
  --window <ticks>  how close two blacklists must be to count as one wedge (60)
  --class <name>    class to model the offline verdict as (heavy)
  --limit <n>       rows per section (12)
  --instance <name> which game, inside a gg2_session
  --repo <path>     the Gang Garrison 2 checkout
  --help

⚠️ The bridge serves one client at a time. From an editor session that already
holds the game, read the same fields with gg2_evalx instead of running this.
`;

if (require.main === module) {
  const mcp = require('./gg2-mcp-server');
  lib.setSink((line) => process.stdout.write(line + '\n'));

  lib.cli(async () => {
    const { flags } = lib.parseArgs(process.argv.slice(2),
      ['since', 'window', 'class', 'limit', 'instance', 'repo']);
    if (flags.help) lib.helpAndExit(USAGE);

    const opts = {
      instance: flags.instance,
      since: Number(flags.since || 0),
      window: Number(flags.window || 60),
      cls: String(flags.class || 'heavy').toLowerCase(),
      limit: Number(flags.limit || 12),
      repo: flags.repo || lib.defaultRepo(),
    };

    try {
      await mcp.callTool('gg2_ping', { instance: opts.instance });
    } catch (e) {
      mcp.disconnectAll('failed to connect');
      throw new Error('could not reach the game. If an editor MCP session is holding it, '
        + `read the bot fields with gg2_evalx from there instead. (${e.message.split('\n')[0]})`);
    }

    try {
      if (flags.reset) {
        await reset(mcp.callTool, opts);
        const at = await mcp.callTool('gg2_evalx', { expr: 'GameServer.frame', instance: opts.instance });
        process.stdout.write([
          `cleared every bot's counters and log at frame ${at}.`,
          'let it play, then harvest - and pass --since to be sure of the window.',
          '',
        ].join('\n'));
        return;
      }
      const h = await harvest(mcp.callTool, opts);
      if (!h.bots.length) throw new Error('no bots on this server - nothing to census');
      const agg = withModel(aggregate(h, opts), h.key, opts.repo, opts.cls);
      process.stdout.write(render(h, agg, opts) + '\n');
    } finally {
      mcp.disconnectAll('done');
    }
  });
}

module.exports = { harvest, reset, parseLog, collapse, aggregate, withModel, render };
