#!/usr/bin/env node
//=============================================================================
// mcp-schemas.js - the tool table gg2-mcp-server.js advertises over MCP.
//
// Declarations only: names, descriptions and JSON Schema for the arguments.
// Nothing here runs anything or talks to a game - the behaviour behind each
// name lives in gg2-mcp-server.js's callTool, and the two are kept in step by
// selftest, which asserts that every advertised tool has a case and vice versa.
//
// It is a separate file because it is data, and because 650 lines of schema
// sitting between the transport and the dispatch made both harder to find.
//=============================================================================

const path = require('path');

const INSTANCE_ARG = {
  instance: {
    type: 'string',
    description:
      'Which running game to talk to: a name from gg2_session (server, client1, ...) or a bridge port. ' +
      'Optional while only one game is running.',
  },
};

const TOOLS = [
  {
    name: 'gg2_ping',
    description:
      'Check whether a running Gang Garrison 2 instance is reachable and responding. Use this first if other tools fail.',
    inputSchema: { type: 'object', properties: { ...INSTANCE_ARG }, additionalProperties: false },
  },
  {
    name: 'gg2_eval',
    description:
      'Run GML code inside the running game for its side effects. Returns nothing on success. ' +
      'GM8-era GML only: no ternary, no try/catch, no structs, no modern functions like array_length. ' +
      'Pass raw GML - do not HTML/XML-escape < > & as &lt; &gt; &amp;, unlike gg2_event which wants ' +
      'escaped text. The code is linted against the installed Game Maker 8 before being sent, and ' +
      'refused if it would not compile, because a syntax error freezes the game on a modal dialog.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'GML statements, e.g. global.playerLimit = 24;' },
        skip_lint: { type: 'boolean', description: 'Bypass the lint gate. Only if you are certain the linter is wrong.' },
        ...INSTANCE_ARG,
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_evalx',
    description:
      'Evaluate a single GML expression in the running game and return its value as a string. ' +
      'Use this to inspect live state, e.g. "room_speed", "instance_number(Player)", "global.currentMap". ' +
      'Pass raw GML - do not HTML/XML-escape < > & as &lt; &gt; &amp;, unlike gg2_event which wants escaped text. ' +
      'This wraps the whole expr in "return", so it must be one expression, not statements - "a = 1; a" never ' +
      'reaches the read. Assign with gg2_eval, then read the variable back with a separate gg2_evalx call.',
    inputSchema: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: 'A GML expression, without a trailing semicolon.' },
        skip_lint: { type: 'boolean', description: 'Bypass the lint gate.' },
        ...INSTANCE_ARG,
      },
      required: ['expr'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_state',
    description:
      'Return a structured snapshot of the running game: current room, fps, room speed, host/dedicated flags, ' +
      'and the connected players with their name, team and class - plus x, y and hp for any player who ' +
      'currently has a Character (omitted between a death and a respawn). Encoded as GGON, the game\'s own ' +
      'JSON-like format.',
    inputSchema: { type: 'object', properties: { ...INSTANCE_ARG }, additionalProperties: false },
  },
  {
    name: 'gg2_screenshot',
    description:
      'Look at the game: saves the current frame and returns it as an image. Works while the game is frozen - ' +
      'a frozen game has its instances deactivated and would otherwise draw an empty room, so the bridge ' +
      'reactivates, redraws and freezes again, which runs no step events and does not advance anything.',
    inputSchema: {
      type: 'object',
      properties: {
        save_to: { type: 'string', description: 'Also write the PNG here, for keeping.' },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_map_image',
    description:
      'Full-resolution image of the map itself, straight from the game\'s own Included Files PNG - not a ' +
      'screenshot, so there is no camera, no window-resolution cap and nothing to stitch. Every built-in map ' +
      'ships as exactly this art at its native size (checked against all 22: e.g. koth_valley is 804x180 - ' +
      'the map-pixel size, 1/6th of world coordinates, F10). Built for "what does this map actually look like" ' +
      'and "what can a body stand on here" without touching the live game beyond reading its current map name. ' +
      'Custom (player-uploaded) maps are not resolvable from disk yet and return a clear error rather than a ' +
      'wrong image - only the maps shipped in this repo work.\n' +
      'base picks what is drawn: "mask" is the map\'s own collision walkmask (dark = solid, light = open), read ' +
      'out of the same PNG\'s embedded level data; "art" is the painted map; "both" blends them. They are ' +
      'different questions and the art answers the second one badly - it paints scenery nothing collides with ' +
      'and draws solid geometry as background. On koth_valley the art is a dark night scene in which two ' +
      'vertical shafts are invisible; the mask shows them at a glance.',
    inputSchema: {
      type: 'object',
      properties: {
        base: {
          type: 'string',
          enum: ['art', 'mask', 'both'],
          description:
            'What to draw: "mask" the collision walkmask (dark = solid), "art" the painted map, "both" blended. ' +
            'Default: art.',
        },
        scale: { type: 'integer', description: 'Nearest-neighbour upscale factor - the native map-pixel art is often small. Default: 3.' },
        save_to: { type: 'string', description: 'Also write the PNG here, for keeping.' },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_area_shot',
    description:
      'A full-resolution screenshot of live game state - players, projectiles, capture progress, whatever is ' +
      'actually happening - across an area larger than one window. gg2_map_image is faster and sharper for the ' +
      'static map itself, but it cannot show anything that moves; this is for when the *game*, not the map, is ' +
      'what needs seeing at more than one window\'s worth at a time. Freezes the game, tiles the requested area ' +
      '(the whole map by default) into window-sized shots at 1:1 zoom - never scaled, so nothing warps - and ' +
      'stitches them into one image, then resumes. Freezing first means every tile comes from the same instant ' +
      'instead of a game that kept moving between shots, which would otherwise show as seams. hide_hud (default ' +
      'true) deactivates every known HUD-drawing object - the team-select/class-select panels, the gamemode\'s ' +
      'own status bar (score, timer, capture-point lock icon), kill log, ammo/health/uber/sentry/nuts-and-bolts ' +
      'HUD, respawn timer, win banner, medic radar, notices, and the spectator overlay - and blanks the mouse ' +
      'cursor sprite, so a full-map capture is not tiled with a repeating scoreboard and crosshair. This needed ' +
      'deactivating rather than the more obvious visible = false: most of those objects draw through their own ' +
      'Draw event code, which - confirmed live - runs regardless of visible, and only deactivating actually ' +
      'stops it. Pass hide_hud: false to capture the HUD as players actually see it instead.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Left edge of the area to cover, world px. Default: 0.' },
        y: { type: 'number', description: 'Top edge of the area to cover, world px. Default: 0.' },
        width: { type: 'number', description: 'Area width, world px. Default: the whole map.' },
        height: { type: 'number', description: 'Area height, world px. Default: the whole map.' },
        hide_hud: { type: 'boolean', description: 'Suppress HUD and the cursor sprite for the capture. Default: true.' },
        walkmask: {
          type: 'boolean',
          description:
            'Trace the map\'s collision boundary - where solid meets open - in magenta over the shot, so what ' +
            'the geometry actually is can be read off the same picture as what everyone is doing in it. It is ' +
            'an outline rather than a wash: one world pixel per boundary, so nothing live is covered up. Default: false.',
        },
        save_to: { type: 'string', description: 'Also write the PNG here, for keeping.' },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_step',
    description:
      'Freeze the game and advance it by an exact number of frames. This is the clock: it turns "it happens too ' +
      'fast to see" into a sequence you can inspect one frame at a time with gg2_evalx and gg2_screenshot. ' +
      'The game stays frozen afterwards - call gg2_resume to let it run again. ' +
      'Freezing stops the objects that service the network too, so a connected client or a hosting server will ' +
      'fall behind and may drop: use it freely on a single game, carefully inside a session.',
    inputSchema: {
      type: 'object',
      properties: {
        frames: { type: 'integer', description: 'How many frames to advance (default 1, max 3600). The game runs at 30 a second.' },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_resume',
    description: 'Let a frozen game run again. Harmless if it was not frozen.',
    inputSchema: { type: 'object', properties: { ...INSTANCE_ARG }, additionalProperties: false },
  },
  {
    name: 'gg2_speed',
    description:
      'Set how fast the game runs relative to real time, for burning through a slow stretch of bot behaviour ' +
      'without gg2_step\'s frame-by-frame cost. GM8 paces its own step loop to hit room_speed steps a real ' +
      'second, and RateController.Begin Step resets room_speed back to 30 or 60 every single frame - so a plain ' +
      '`room_speed = ...` via gg2_eval gets stomped within one frame. This tool deactivates RateController first, ' +
      'which is what makes a different value stick. Per-tick game logic is not affected: RateController only ' +
      'recalculates delta_factor/frameskip/ticks_per_virtual for its own two supported rates, and deactivating ' +
      'it leaves those alone - a boosted game does the same thing per tick, just more ticks per real second. ' +
      'Verified live: factor 10 measured 296.7 sim-fps against a 30.0 sim-fps baseline, with an exact restore ' +
      'to 30.0 on reset.\n' +
      'gg2_wait KEEPS the boost, so "fast-forward and wait for a condition" is one call and needs no polling: ' +
      'WAIT never touches instances, it only re-tests its expression each step. Measured 2026-08-21: 600 frames ' +
      'waited in 1022ms (~587 sim-fps) with room_speed still 600 afterwards. gg2_eval/gg2_evalx keep it too. ' +
      'What DOES end it is a room change - a new room means a new, active RateController; measured room_speed ' +
      '600 before serverGotoMap and 30 after, so re-apply the factor after changing map - and anything that ' +
      'un-freezes the game (gg2_resume, a frozen gg2_screenshot, gg2_step when the game was already frozen), ' +
      'since instance_activate_all() brings RateController back with everything else. ' +
      'Also speeds up whatever services the network each frame - same caution as freezing: fine solo, careful ' +
      'inside a gg2_session.',
    inputSchema: {
      type: 'object',
      properties: {
        factor: {
          type: 'number',
          description:
            'Ticks per real second, as a multiple of normal (1 = normal, 10 = ten times faster, 0.5 = half ' +
            'speed). 0 or omitted resets to normal. Clamped to [0, 20].',
        },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_input',
    description:
      'Drive the game as a player would, not by writing to its variables. Commands are separated by ";" -\n' +
      '  press <action>    hold a key down, e.g. press jump\n' +
      '  release <action>  let it up\n' +
      '  clear             drop all simulated input\n' +
      '  aim <x> <y>       move the mouse, in room coordinates - currently hangs, see below\n' +
      '  click 0|1         release or hold the left mouse button\n' +
      'left, right, jump/up, down and taunt actually hold: the bridge ORs a mask into PlayerControl\'s own ' +
      'keybyte every step, so combine with gg2_step to hold a direction for an exact number of frames. ' +
      'Every other action - attack, special, drop, medic, changeteam, changeclass, chat1..3, a single ' +
      'character, a raw key code - goes through keyboard_key_press/release instead, which only drives the ' +
      'pressed/released edge, not a held key: fine for one-shot actions, but press attack will not hold down ' +
      'fire. aim needs the game window to have real OS focus to do anything - a game launched by this tooling ' +
      'normally does not have it, and nothing here can grant it - so expect a ~10s timeout and no effect.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: { type: 'string', description: 'e.g. "press right;press jump" or "aim 320 240;click 1"' },
        ...INSTANCE_ARG,
      },
      required: ['commands'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_wait',
    description:
      'Let the game run until a GML expression becomes true, or give up after a number of frames. Use it instead ' +
      'of polling gg2_evalx: the condition is tested every frame inside the game, so nothing that is true for ' +
      'two frames is missed. The expression is linted first, and the lint gate cannot see every way an ' +
      'expression can fail to compile; if the game rejects it anyway, the wait is abandoned after the first ' +
      'frame with an error reply rather than repeating the same failure for the rest of the budget. Pass raw ' +
      'GML - do not HTML/XML-escape < > & as &lt; &gt; &amp;, unlike gg2_event which wants escaped text. ' +
      'Optional setup runs once, synchronously, before the first evaluation of expr - use it to place a bot or ' +
      'set up state in the same call that starts waiting, instead of a separate gg2_eval first: the game keeps ' +
      'running between calls, so a setup done as a prior gg2_eval leaves an unknown amount of real game time ' +
      'before the wait actually arms, and a bot can walk off, re-plan, or finish before anything is watching.',
    inputSchema: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: 'A GML expression, e.g. "instance_number(Player) > 0"' },
        setup: { type: 'string', description: 'Optional GML run once for its side effects, immediately before expr is first tested.' },
        frames: { type: 'integer', description: 'How many frames to allow (default 300 - ten seconds, max 3600).' },
        skip_lint: { type: 'boolean', description: 'Bypass the lint gate.' },
        ...INSTANCE_ARG,
      },
      required: ['expr'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_watch',
    description:
      'Sample GML expressions once a frame and record every change in the bridge log. This is how to see something ' +
      'that is true for three frames and then gone, which no amount of polling from outside will catch. ' +
      'Read the trace back with gg2_log. Up to eight expressions at a time, since each one costs an evaluation ' +
      'every frame. Sampling is skipped automatically while instances are deactivated (a FREEZE, or between the ' +
      'frames of a STEP) rather than raising an error every frame - the trace records the suspension and its end, ' +
      'not a gap.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'clear', 'list'], description: 'What to do (default list).' },
        expr: { type: 'string', description: 'The expression to watch, for add.' },
        label: { type: 'string', description: 'Optional short name for add, logged as "label = value" instead of the full expression.' },
        skip_lint: { type: 'boolean', description: 'Bypass the lint gate.' },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_sprite',
    description:
      'Replace a sprite in the running game from a PNG on disk. Sprites are loaded at runtime by GM8, so art can ' +
      'be iterated without a rebuild - but only in the running game: to keep the change, put the file in the ' +
      'tree and gg2_rebuild.',
    inputSchema: {
      type: 'object',
      properties: {
        sprite: { type: 'string', description: 'The sprite resource to replace, e.g. ScoutRedSprite.' },
        file: { type: 'string', description: 'Path to the image file, readable by the game.' },
        images: { type: 'integer', description: 'How many sub-images the strip holds (default 1).' },
        origin_x: { type: 'integer', description: 'Origin x (default: whatever the sprite already uses).' },
        origin_y: { type: 'integer', description: 'Origin y (default: whatever the sprite already uses).' },
        remove_background: { type: 'boolean', description: 'Treat the top-left pixel as transparent (default false).' },
        ...INSTANCE_ARG,
      },
      required: ['sprite', 'file'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_lint',
    description:
      'Check GML against the installed Game Maker 8 without running it. Verifies syntax, that every ' +
      'function exists (built-ins come from GM8\'s own fnames table, plus project scripts and .gex ' +
      'extensions), and that argument counts match the real signatures. Use it on code you are about ' +
      'to write into a source file, since a full rebuild costs ~50s. gg2_eval runs this automatically.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'GML to check.' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_event',
    description:
      'Read and write the GML inside an object\'s events. Event code lives in XML, XML-escaped, so grep misses it ' +
      'and a text edit that writes a bare < or & invalidates the file and makes GmkSplitter reject the whole ' +
      'tree. This reads real GML back and escapes what it writes, leaving every other byte of the file alone. ' +
      'Writes are linted first. Objects resolve against the bridge payload too, so the AgentSpare objects - ' +
      'blank objects kept ready for experiments - are editable the same way.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write'], description: 'What to do (default read).' },
        object: { type: 'string', description: 'Object name, e.g. Player or AgentSpare0.' },
        event: { type: 'string', description: 'Event name as the tree spells it: Step, Draw, Create, "Alarm 3", "Collision with Rocket".' },
        index: { type: 'integer', description: 'Which code action in that event (default 0).' },
        code: { type: 'string', description: 'The GML to write, for write.' },
      },
      required: ['object'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_find',
    description:
      'Search the game\'s GML - the scripts and the code inside object events together - and report file:line. ' +
      'Prefer this over grep, which cannot see event code at all and so misses a large part of the game\'s logic.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'A JavaScript regular expression.' },
        ignore_case: { type: 'boolean', description: 'Match case-insensitively.' },
        limit: { type: 'integer', description: 'Stop after this many hits (default 100).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_test',
    description:
      'Run the game\'s own unit tests inside the running game and report how many assertions passed. Run it after ' +
      'a rebuild - nothing else checks that a change to, say, GGON still round-trips. ' +
      'By default the game opens its own suite file off disk (file_text_open_read) and runs it with ' +
      'test_unit_end() stripped out, since that helper resets the assertion counters after showing a message box ' +
      'and the counters are the only part of its report that can be read from outside: GM8 draws message text ' +
      'with no window handle. A failed assertion still shows a box, which the launcher dismisses so the game ' +
      'keeps running. Pass send_source: true to send the suite text down the wire instead - only needed when the ' +
      'game and this tooling are not on the same machine.',
    inputSchema: {
      type: 'object',
      properties: {
        suite: { type: 'string', description: 'One suite by name, e.g. test_ggon. Default: every suite found.' },
        timeout_seconds: { type: 'integer', description: 'How long one suite may take (default 60).' },
        skip_lint: {
          type: 'boolean',
          description: 'Bypass the lint gate. Only if you are certain the linter is wrong.',
        },
        send_source: {
          type: 'boolean',
          description: 'Send the suite text over the wire instead of having the game read it off disk itself.',
        },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_profile',
    description:
      'Time GML the game has no profiler for: GM8 has no get_timer, delta_time or fps_real, only ' +
      'current_time, which has 1-16ms Windows granularity - so a single call is never trustworthy and this ' +
      'exists to amortise that properly instead of hand-rolling it with gg2_eval and gg2_watch. Two modes:\n' +
      '  mode "expr" (default) - runs code repeat(n) between two current_time reads inside one call and ' +
      'reports the total and the per-iteration mean. For a pure CPU cost, e.g. one collision check or one ' +
      'grid cell of a bot-nav build.\n' +
      '  mode "frames" - freezes the game and steps it one frame at a time, reading current_time after each ' +
      'step (the in-game clock, not a stopwatch on this side of the wire, which would measure MCP round-trip ' +
      'time instead of GML time), and reports the frame-time distribution. For the per-frame cost of whatever ' +
      'is already running, e.g. a chunked build spread across many step events. Leaves the game frozen ' +
      'afterwards - call gg2_resume. Freezing stops the network, so use this mode carefully inside a session.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['expr', 'frames'], description: 'What to time (default expr).' },
        code: { type: 'string', description: 'mode "expr": GML statement(s) to repeat, e.g. navClearanceBuild();' },
        n: { type: 'integer', description: 'mode "expr": how many iterations (default 100, max 1000000).' },
        frames: { type: 'integer', description: 'mode "frames": how many frames to sample (default 60, min 2, max 600).' },
        timeout_seconds: { type: 'integer', description: 'mode "expr": how long the whole repeat may take (default 60).' },
        skip_lint: { type: 'boolean', description: 'mode "expr": bypass the lint gate.' },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_session',
    description:
      'Start, stop and list games. A session is a dedicated server and its clients, each named and separately ' +
      'addressable, which is the only way to exercise the network protocol: nothing about what one game sends ' +
      'another is observable from inside one process. Starting a session sets UseLobby=0 first, so a test server ' +
      'never announces itself to the public lobby.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'list'], description: 'What to do (default list).' },
        clients: { type: 'integer', description: 'How many clients to bring up alongside the server (default 1).' },
        map: { type: 'string', description: 'The map the server opens on (default ctf_truefort).' },
        name: { type: 'string', description: 'For stop: which member to stop. Omit to stop all of them.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_checkout',
    description:
      'Show or switch which Gang Garrison 2 checkout the other tools work on - the tree gg2_event, gg2_find, ' +
      'gg2_lint and gg2_rebuild read and write, and the build dir whose running games the live tools address. ' +
      'It starts as GG2_REPO if set, else the checkout the session was opened in, else Gang-Garrison-2 beside ' +
      'gg2-agent. Switch to work on another fork or worktree; games started from the old checkout keep ' +
      'running but cannot be addressed until you switch back.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'A checkout, or any directory inside one, to switch to. Leave out to show the current one.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_rebuild',
    description:
      'Rebuild the game from the source tree, in about two seconds, and relaunch it. ' +
      'gm8-builder writes the executable straight from the tree without Game Maker, so any change - ' +
      'scripts, event code, and new objects, scripts, sprites or rooms alike - is picked up. ' +
      'The whole tree is linted first and nothing is built if it has errors, because bad code in a built ' +
      'exe hangs the game on a modal dialog. ' +
      'This stops every running game, so a session has to be started again afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        relaunch: { type: 'boolean', description: 'Restart the game and wait for the bridge afterwards (default true).' },
        dry_run: { type: 'boolean', description: 'Lint the tree without building.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gg2_log',
    description:
      'Read the tail of a game\'s logs. The bridge log is what the AgentBridge object recorded, including any ' +
      'gg2_watch trace; the launcher log holds every GM8 dialog the launcher dismissed - GML runtime errors ' +
      'marked E, show_message boxes marked M - which is where to look when a value came back wrong or a call ' +
      'timed out. Errors are annotated with the file and line they came from.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'integer', description: 'How many trailing lines to return (default 40).' },
        source: {
          type: 'string',
          enum: ['both', 'bridge', 'launcher', 'engine'],
          description:
            'Which log to read (default both). "engine" is the game engine\'s own game_errors.log, which is ' +
            'where a compilation error inside execute_string goes - those raise no dialog at all and are ' +
            'invisible everywhere else.',
        },
        ...INSTANCE_ARG,
      },
      additionalProperties: false,
    },
  },
];

// Sent in the initialize reply; MCP clients put it in the agent's context for
// every session. It is the only guidance that reaches a session opened in the
// game checkout - CLAUDE.md and GML.md load only in one opened in this repo -
// so it carries what an agent editing the game must not get wrong, and points
// at the rest by absolute path.
const ROOT = path.resolve(__dirname, '..');
const INSTRUCTIONS = `\
These tools build, run and drive Gang Garrison 2, a Game Maker 8 game, through a debug bridge injected at build time.

GM8 GML is not GameMaker Studio GML. Before writing any, read ${path.join(ROOT, 'GML.md')} - it lists what compiles but misbehaves. The short version: no ternary, try/catch, structs, static, #region, arrays beyond 2D, or string escapes ("\\n" is literal; use chr(10)). and/or do not short-circuit. -1 is self, not "no instance". var is script-scoped and must not shadow a built-in (x, score, health, other...). House style: and/or/not, semicolons always, parentheses around conditions, braces on their own line, four-space indent; never use new, delete or function as identifiers.

Editing: object event code is XML-escaped inside Objects/**/*.events/*.xml - read and write it with gg2_event, never by hand, and search with gg2_find, which sees event code that grep does not. Run gg2_lint on GML before writing it. The running game only changes when rebuilt: try an idea with gg2_eval, write it into the tree, then gg2_rebuild (~2s). gg2_checkout says which checkout the tools are working on.

Running games: each accepts one bridge client, and this session is it - a node script run against the same game waits forever. A GML error comes back as a failed call with its file:line; gg2_log with source "launcher" has the history. Freezing (gg2_step) stops the network too, so a frozen server's clients fall behind and may drop. gg2_input aim hangs; use press and click.

Never commit AgentBridge files, agentDebug*/agentSnap*/agentRoomSpeed/agentAudioStopSong calls or an AgentBridge.heldMask line to the game repository; the build removes them, and node ${path.join(ROOT, 'cleanup.js')} does if a build was killed. The full operating guide is ${path.join(ROOT, 'CLAUDE.md')}.`;

module.exports = { TOOLS, INSTANCE_ARG, INSTRUCTIONS };
