//=============================================================================
// bot-scenarios.js - the behaviour scenarios botscenario.js runs.
//
// One entry per scenario. Adding a test is an edit to this file and nothing
// else: no GML, no rebuild. That is the whole reason the runner lives in Node -
// every new script or constant in the game costs a full Game Maker build, so a
// harness that wanted GML per scenario would cost a minute per test written.
//
// FIELDS
//
//   name      unique, kebab-case. What you pass to run one scenario.
//   map       internal map name, e.g. "koth_valley". The runner only changes
//             map when the running game is on a different one, because a map
//             change plus a nav build is most of a scenario's cost.
//   about     one line saying what a failure here would mean. Read this when
//             the scenario goes red; it is the difference between "the bot is
//             broken" and "this leg was always marginal".
//   class     CLASS_* name. Movement is class-independent today (botPathKeys
//             has no class references at all), so a nav scenario should use
//             SOLDIER unless it is specifically about a class.
//   team      "red" or "blue". Decides which gates the route may use.
//   from      [x, y] world coordinates to place the bot at.
//   to        [x, y] world coordinates to send it to. A scenario has EITHER
//             `to` (walk somewhere) OR `hold` (stand still and fight) - never
//             both, and never neither. The choice is required rather than
//             defaulted because a combat scenario that quietly inherited a
//             movement goal would measure the wrong thing and still pass.
//   hold      ticks to stand where it was placed, with no goal at all, while
//             whatever happens happens. This is the combat mode.
//   enemies   [{ class, at:[x,y], dummy }] - bots on the opposing team, placed
//             and, unless `dummy: false`, made inert: an acquisition delay
//             longer than any scenario means they never aim or fire, and a
//             locked goal means they never move. Both are ordinary knobs, so a
//             training dummy needs no test-only code in the game. Leave them
//             inert unless the scenario is specifically about a two-sided
//             fight, because every point of damage measured is then
//             unambiguously this bot's doing.
//   expect    combat assertions over what was measured:
//               damage   {min,max} hp removed from the enemy team - live enemy
//                        Characters plus any enemy Generator
//               moved    {max} px from where the bot was placed. ⚠️ In hold
//                        mode this does NOT test "did it walk to the
//                        objective" - the bot has no goal and botPathKeys
//                        returns no keys without one, so it cannot path
//                        anywhere. It measures knockback and evasive hops, so a
//                        splash class shelling something at close range drifts
//                        a lot and a tight bound is flaky (measured 23, 42 and
//                        232px on three runs of one scenario).
//               ticks    {min,max} length of the run
//               acquired true/false - did it ever pick a target at all. Latched
//                        while it happens, because botTarget clears when the
//                        target dies and by the end a bot that fought and won
//                        looks like one that never saw anything.
//   budget    ticks allowed. A leg that takes longer is a fail even if it
//             eventually arrives - "gets there in the end" is how a bot that
//             re-plans in a loop looks from the outside.
//   known     optional. A scenario that reproduces a bug nobody has fixed yet:
//             it reports KNOWN instead of FAIL and does not fail the run, so
//             green keeps meaning "no NEW regressions". Say what is wrong and
//             what has been ruled out, because the next person to read it is
//             deciding whether to start there. If it ever passes, the runner
//             says FIXED and the entry should be deleted.
//   allow     optional caps on the diagnostics counters: stuck, blacklisted,
//             offRoute. Omit one and it is reported but not asserted, which is
//             the right state until the scenario has been measured - a guessed
//             cap fails for reasons that have nothing to do with the bot. Never
//             cap `replans`; see botscenario.js's header for why it is a measure
//             of how long the leg took rather than of anything going wrong.
//
// ⚠️ `from` and `to` are snapped to nav nodes by the runner (botNodeSnap, which
// searches downward), and the snapped position is what is used and reported. A
// raw objective coordinate usually does NOT resolve to a node on its own: a
// CaptureZone marker can float 60px above the floor it belongs to, and
// botSetGoal on that plans nothing at all and the bot never moves. Take
// coordinates off a screenshot or gg2_evalx, then let the snap fix the height.
//=============================================================================

const SCENARIOS = [
  {
    name: 'valley-floor-to-point',
    map: 'koth_valley',
    about:
      'The four-jump climb out of the valley floor onto the control point. This is the ' +
      'chain M6 was built for - each link has to land for the next to be attempted - so ' +
      'it is the most sensitive scenario here to any change in jump edge geometry or in ' +
      'how the follower flies an arc.',
    class: 'CLASS_SOLDIER',
    team: 'red',
    // The lowest node within 900px of the point - found by asking the graph, not
    // by reading it off a screenshot. [1200, 900] looked like the valley floor
    // and has no node under it at all, which the runner correctly reported as
    // VOID rather than as the bot failing to climb.
    from: [1974, 859],
    to: [2331, 546],
    budget: 900,
  },
  {
    name: 'valley-spawn-to-point',
    map: 'koth_valley',
    about:
      'The ordinary route a bot takes every round: red spawn to the control point. Longer ' +
      'and easier than the valley climb, and it exercises the team gate on the way out.',
    class: 'CLASS_SOLDIER',
    team: 'red',
    from: [784, 581],
    to: [2331, 546],
    budget: 1200,
  },
  {
    name: 'valley-point-to-spawn',
    map: 'koth_valley',
    about:
      'The return leg. Worth having separately from the outbound one because gates are ' +
      'evaluated per query against the asking team, so a route that works one way is not ' +
      'evidence about the other.',
    class: 'CLASS_SOLDIER',
    team: 'red',
    from: [2331, 546],
    to: [784, 581],
    budget: 1200,
  },
  {
    name: 'valley-shaft-crate-to-point',
    map: 'koth_valley',
    about:
      'The climb OUT of the control point shaft, starting on the crate at its bottom. The ' +
      'shaft is a dogleg: the free channel sits at cols 367-370 between the crate and the ' +
      'lower ledge, then jogs three columns left to 364-367 at the ledge row and above. The ' +
      'climb therefore rises AND moves sideways, which is the case navJumpCeiling did not ' +
      'model - it scanned straight up from the takeoff column, hit the wall shoulder nine ' +
      'rows up, and reported 48px of headroom against the 54px the rung needs, so ' +
      'navJumpLanding refused every arc and n261 had no upward edge at all. A human makes ' +
      'the jump comfortably: measured takeoff (2232.66, 768.40), landing (2198.60, 714.46), ' +
      'a 53.9px rise inside a 57.6px apex. This scenario does not test arrival - the bot ' +
      'always got out eventually by walking a ~45-node detour through the rest of the map - ' +
      'it tests the COST of getting out. Measured 532 and 673 ticks by the detour before the ' +
      'fix, and 100 ticks with zero stuck/blacklisted/offRoute after it. The bound is set ' +
      'well clear of both: anything near the detour figure means the rung is missing again.',
    class: 'CLASS_SOLDIER',
    team: 'red',
    // Above the crate, not on it: botNodeSnap searches downward, so a point level
    // with the surface you mean resolves to whatever is under it instead. The
    // crate node n261 spans x 2226-2274 with its floor at y 792.
    from: [2250, 780],
    to: [2331, 546],
    budget: 1200,
    expect: { ticks: { max: 300 } },
  },
  {
    name: 'valley-shaft-floor-to-point',
    map: 'koth_valley',
    about:
      'The same shaft one rung lower, from the underground floor n263 (x 2088-2220, floor ' +
      'y 828) rather than from the crate. Worth having separately from the crate scenario ' +
      'because it exercises the floor->crate rung as well, and because it is the position a ' +
      'bot actually falls into: n177, n216 and n242 all have fall edges down here. Measured ' +
      '489 and 1139 ticks by the detour before the fix - within a 1200 budget only barely, ' +
      'which is why this always read as "the bot took the long way" rather than as a failure ' +
      'anywhere, and why arrival alone asserts nothing useful here. 161 ticks after the fix. ' +
      'The right-hand shaft (n262 -> n243) is the mirror of this and was verified by hand at ' +
      '679 ticks before and 100 after; it is not duplicated here because it exercises the ' +
      'same generator path.',
    class: 'CLASS_SOLDIER',
    team: 'red',
    from: [2150, 815],
    to: [2331, 546],
    budget: 1200,
    expect: { ticks: { max: 400 } },
  },
  {
    name: 'truefort-spawn-to-intel',
    map: 'ctf_truefort',
    about:
      'Red spawn to the enemy intel on the largest shipped map - the long-route case, and ' +
      'the one where a pruning regression in the jump edge generator would show up first, ' +
      'since truefort is where NAV_JUMP_DIVERSITY_ROWS was needed. Keep it: it is the only ' +
      'scenario that covers two stacked jumps in a row - and both of the bugs that made it ' +
      'a KNOWN failure from the day it was written until 2026-08-21 lived in exactly that: ' +
      'the follower advancing its route index in mid-air, and navNodeFromWorld flooring the ' +
      'feet row so a bot on a ramp believed it was a step behind where it stood. Arrives in ' +
      '2200-2500 ticks with no blacklists now.',
    class: 'CLASS_SOLDIER',
    team: 'red',
    from: [384, 864],
    to: [4962, 864],
    budget: 6000,
  },
  {
    name: 'truefort-blue-spawn-exit-west',
    map: 'ctf_truefort',
    about:
      'The first move of every blue life: out of the spawn shelf (n178) and west over the ' +
      'hole. It exists because the search used to route this leg wrong for every bot in the ' +
      'game and nothing noticed for a whole milestone. n178 -> n177 is one direct jump at ' +
      'cost 33.67; the alternative is three hops across two SINGLE-COLUMN ledges (n196, n195, ' +
      'six pixels wide each) at 54.67. With the per-bot cost jitter on, every non-zero seed ' +
      'took the three-hop route - and a bot that misses a six-pixel ledge lands in n310, a pit ' +
      'whose only exit is walk->n311 behind a BLUE TEAM GATE. navGatePassable closes a team ' +
      'gate to a carrier, so a red bot or a blue flag carrier that falls in is stuck there ' +
      'until something kills it. Measured before the fix: 1484 stuck fires and 724 off-route ' +
      'events, never arriving. After: 58 ticks, nothing flagged. ' +
      'The jitter is gone (see docs/ROUTEVARIETY.md); this is the regression test that would have ' +
      'caught it, and it is the one to run first if route variety comes back in any form.',
    class: 'CLASS_SOLDIER',
    team: 'blue',
    from: [3630, 456],
    to: [3480, 456],
    budget: 600,
    allow: { stuck: 0, blacklisted: 0 },
    expect: { ticks: { max: 300 } },
  },
  {
    name: 'avanti-ramp-pocket-to-intel',
    map: 'ctf_avanti',
    about:
      'Found by tools/navsuspects.js rather than by watching a bot, and it turned out to be ' +
      'two bugs stacked on one leg. n251 stands one anchor column from a 54px block whose top ' +
      '(n229) is the way out; the climb needs 54px of a 57.4px apex, so the character cannot ' +
      'have moved sideways AT ALL before it is over the top, and the clearance walk treated ' +
      'that first cell of lateral overlap as fatal instead of as a wall to slide up. With no ' +
      'edge there, the graph priced this run at 538 cells against a straight line of 76 - the ' +
      'worst ratio on any shipped map - and sent the bot down a ramp, across the map and back. ' +
      'On the way it crossed two fall edges whose takeoff end the follower guessed wrong, ' +
      'walked into a solid block and wedged. Both are fixed (navJumpTakeoff samples the swept ' +
      'column; falls carry NAV_EDGE_TAKEOFF), and the leg is 538 cells -> 205 and 1032-1288 ' +
      'ticks -> 352-438. A regression in either shows up here first.',
    class: 'CLASS_SOLDIER',
    team: 'red',
    // n251 is one anchor column wide (x 1626-1626, floor y 840) - the stepped-terrain
    // shape that navNodeFromWorld's round() fix was about, where the node one row up
    // is also one column across.
    from: [1626, 817],
    to: [1218, 607],
    // ⚠️ This budget assumes the runner waits out the setup phase (ensureMap ->
    // pastSetup). ctf_avanti has 63 setup-gated edges, so a run started inside setup is
    // routed the long way round quite correctly and reads 897+ ticks - which looks like
    // flake and is not. If this fails only as the first run after a map change, the MCP
    // server is still holding a cached copy of botscenario.js; reconnect it.
    //
    // Measured 352, 354, 438 ticks against a route the graph prices at 205 cells and
    // that is 208 cells to actually walk - a ticks/travel of 1.7, which is mid-band for
    // this project (see the measured band in gg2-agent/docs/NAVLOG.md). The budget is set at roughly
    // twice the measurement rather than at the old 1635: anything near that figure means
    // the climb out of the pocket is gone again and the bot is walking the long way
    // round, which is precisely what a passing 1635 hid for four runs.
    budget: 600,
    allow: { stuck: 0, blacklisted: 0 },
  },
  {
    name: 'soldier-shells-generator',
    map: 'gen_destroy',
    about:
      'A Soldier with a clear line to the enemy generator should shell it from where it stands. This pins M7 ' +
      '6.3, which is the finding that bots had NEVER damaged a generator - botFindTarget iterated with(Character) ' +
      'and nothing else, so a 2100hp objective that is shot rather than stood on was invisible to every bot in ' +
      'the game. A regression there is silent: the round simply never ends.',
    class: 'CLASS_SOLDIER',
    team: 'red',
    // High ground with line of sight, 212px above the generator and ~460px from
    // it - found by scoring nodes for height among those with a clear line
    // inside the Soldier's band, not read off a screenshot.
    from: [2358, 235],
    hold: 600,
    // Measured 206, 165 damage over 600 ticks across runs. The floor is
    // deliberately far below that: this asserts "it shoots the thing at all",
    // which is the behaviour that was missing, rather than a damage-per-second
    // figure that would move with any weapon tuning.
    //
    // ⚠️ No `moved` assertion here, and that is not an oversight. Measured 23,
    // 42 and then 232px on three runs of the same scenario: a Soldier shelling
    // something 460px away is standing in its own splash, and enough knockback
    // walks it off the ledge. A tight bound would be flaky and a loose one would
    // assert nothing. It is also unnecessary - in hold mode the bot has no goal
    // at all and botPathKeys returns no keys without one, so it *cannot* path
    // anywhere; any movement is knockback or an evasive hop, which is physics
    // rather than the behaviour under test. Use `moved` on classes that do not
    // splash themselves.
    expect: { acquired: true, damage: { min: 50 } },
  },
  {
    name: 'soldier-holds-and-fires',
    map: 'koth_valley',
    about:
      'The plainest combat case: an enemy 200px away, on the same floor, outside the Soldier\'s splash-safe ' +
      'band. It should acquire, fire, and not walk anywhere. A failure here is the see/acquire/aim/fire chain ' +
      'itself rather than anything about a particular map.',
    class: 'CLASS_SOLDIER',
    team: 'red',
    // Both points sit inside nav node 268, which spans x 1866-2082 on the valley
    // floor. 200px apart is comfortably outside BOT_SPLASH_SAFE (110), so the
    // bot has no reason to back away and any movement is a real finding.
    from: [1880, 859],
    hold: 400,
    enemies: [{ class: 'CLASS_HEAVY', at: [2080, 859] }],
    // No `moved` bound, for a reason worth knowing before adding one: measured
    // 57, 1, 1 and then 576px across four runs. The Soldier's own rockets knock
    // the dummy toward it, the dummy drifts inside BOT_SPLASH_SAFE, and
    // botInputUpdate then walks the Soldier away from it - so a scenario about
    // firing turns into one about retreating, at a distance that depends on
    // where the splash happened to land. sniper-holds-position below asserts
    // the standing-still half with a weapon that has no self-knockback.
    expect: { acquired: true, damage: { min: 1 } },
  },
  {
    name: 'sniper-fires-at-close-range',
    map: 'koth_valley',
    about:
      'A Sniper with an enemy well inside BOT_ZOOM_RANGE must actually shoot it. This is the regression test ' +
      'for a bug this harness found: the trigger was gated on rifle charge, charge only accumulates while ' +
      'zoomed, and the bot only zooms past 400px - so from the minimum band out to ~250-400px it acquired an ' +
      'enemy, tracked it all the way in, and never fired. Measured 0 damage over four runs before the fix and ' +
      '280-315 after, which is the Rifle\'s own unscopedDamage of 35 landing repeatedly.',
    class: 'CLASS_SNIPER',
    team: 'red',
    // Both points sit near the middle of nav node 268 (x 1866-2082) rather than
    // at its edges. Placement 14px from the edge made this flaky at 264px of
    // drift: with a target held the bot takes an evasive hop about 1% of ticks,
    // and a hop that close to a lip walks it off the platform. Nothing to do
    // with the behaviour under test, but it fails the same way.
    from: [1930, 859],
    hold: 400,
    enemies: [{ class: 'CLASS_HEAVY', at: [2030, 859] }],
    // No `moved` bound: see soldier-holds-and-fires. Standing still is not what
    // this scenario is about, and on a 216px-wide platform it is not stable
    // enough to assert.
    expect: { acquired: true, damage: { min: 1 } },
  },
];

module.exports = { SCENARIOS };
