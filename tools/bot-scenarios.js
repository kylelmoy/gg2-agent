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
//   to        [x, y] world coordinates to send it to.
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
    name: 'truefort-spawn-to-intel',
    map: 'ctf_truefort',
    about:
      'Red spawn to the enemy intel on the largest shipped map - the long-route case, and ' +
      'the one where a pruning regression in the jump edge generator would show up first, ' +
      'since truefort is where NAV_JUMP_DIVERSITY_ROWS was needed.',
    class: 'CLASS_SOLDIER',
    team: 'red',
    from: [384, 864],
    to: [4962, 864],
    budget: 6000,
    known:
      'the bot stalls ~740px short, inside the blue base, and never arrives - measured 262 ' +
      'off-route events in 6000 ticks, one every ~22 ticks. It is NOT a missing route: ' +
      'navaudit passes red -> blue intel (n650), and asking navFindPath from where the bot ' +
      'is standing, with its own team and intel state, returns a 19-node path every time. ' +
      'So the graph promises a route the follower cannot execute, which is the one class of ' +
      'bug only this tier can see. Found by the first run of this harness, 2026-08-21.',
  },
];

module.exports = { SCENARIOS };
