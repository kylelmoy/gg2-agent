#!/usr/bin/env node
//=============================================================================
// areashot.js - a full-resolution live screenshot of an area bigger than one
// window, tiled and stitched.
//
// gg2_map_image and this answer two questions that look similar and are not.
// That one reads the map's art off disk and never asks the game anything: it
// shows what the map IS. This one shows what is HAPPENING on it - players,
// projectiles, capture progress, an actual running match - which no amount of
// reading files can produce.
//
// The mechanics, each of which was arrived at the hard way:
//
//   * It freezes first. A camera-follow Step event otherwise resets the view
//     before every tile's redraw - confirmed live, two tiles taken without
//     freezing came back pixel-identical.
//   * Tiles are exactly window-sized at 1:1 zoom. GM8 scales each view axis
//     independently, so anything else warps a map whose aspect ratio does not
//     already match the window.
//   * The HUD is deactivated, not hidden. `visible = false` does not stop a
//     custom Draw event, and most of GG2's HUD draws through one - so a naive
//     full-map capture comes out tiled with a repeating scoreboard.
//
// This module owns the capture. It does not own the transport: the caller
// passes `run`, which sends one bridge request and resolves with its reply, so
// the same code serves the MCP tool and can be exercised against a fake game.
//
// Usage: a module only - gg2_area_shot is the tool.
//=============================================================================

const fs = require('fs');
const path = require('path');

const image = require('./image');
const walkmask = require('./walkmask');

// Everything this deactivates to get a clean frame. Team/class select are the
// one pair that need only `visible`, having no custom Draw event of their own.
const HUD_OFF =
  'EVAL global.agentHideHud = true;\nagentBridgeHudVisible(false);\ncursor_sprite = -1;';
const HUD_ON =
  'EVAL global.agentHideHud = false;\nagentBridgeHudVisible(true);\ncursor_sprite = CrosshairS;';

// One tile: point the view at the tile's top-left corner at 1:1 and redraw.
function viewGml(x, y, w, h) {
  return (
    `view_enabled = true;\n` +
    `view_visible[0] = true;\n` +
    `view_object[0] = -1;\n` +
    `view_xview[0] = ${x};\n` +
    `view_yview[0] = ${y};\n` +
    `view_wview[0] = ${w};\n` +
    `view_hview[0] = ${h};\n` +
    `view_wport[0] = ${w};\n` +
    `view_hport[0] = ${h};`
  );
}

// `run(text)` sends one bridge request and resolves with the reply.
// `lint(gml)` rejects if the GML would not compile; a no-op is acceptable.
async function capture({ run, lint = () => {}, buildDir, repo, port, x, y, width, height, hideHud = true, walkmask: withMask = false }) {
  const dims = await run(
    'EVALX string(view_wport[0]) + "," + string(view_hport[0]) + "," + string(map_width()) + "," + string(map_height())'
  );
  const [wport, hport, mapW, mapH] = dims.split(',').map(Number);

  const rx0 = x ?? 0;
  const ry0 = y ?? 0;
  const rw = Math.ceil(width ?? mapW);
  const rh = Math.ceil(height ?? mapH);
  const cols = Math.ceil(rw / wport);
  const rows = Math.ceil(rh / hport);

  const canvas = Buffer.alloc(rw * rh * 4);
  const shot = path.join(buildDir, `agent_shot_${port}.png`);

  let frozen = false;
  try {
    await run(hideHud ? HUD_OFF : 'EVAL with(TeamSelectController) visible = false;');
    await run('FREEZE');
    frozen = true;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const view = viewGml(rx0 + c * wport, ry0 + r * hport, wport, hport);
        await lint(view);
        await run('EVAL ' + view);

        try {
          fs.rmSync(shot, { force: true });
        } catch (e) {
          /* an old shot that cannot be removed is about to be overwritten */
        }
        await run('SHOT ' + shot);
        if (!fs.existsSync(shot)) {
          throw new Error(`the game reported success but wrote no file to ${shot} (tile ${c},${r})`);
        }
        const { png } = image.toPng(fs.readFileSync(shot));
        const tile = image.decodePng(png);

        // Clip to both the tile's own bounds and the canvas's - the rightmost
        // and bottommost tiles usually overshoot the requested area, since it
        // need not be a multiple of the window size.
        const destX = c * wport;
        const destY = r * hport;
        const copyW = Math.min(tile.width, rw - destX);
        const copyH = Math.min(tile.height, rh - destY);
        if (copyW > 0 && copyH > 0) {
          for (let ty = 0; ty < copyH; ty++) {
            tile.rgba.copy(canvas, ((destY + ty) * rw + destX) * 4, ty * tile.width * 4, ty * tile.width * 4 + copyW * 4);
          }
        }
      }
    }
  } finally {
    try {
      fs.rmSync(shot, { force: true });
    } catch (e) {
      /* best effort */
    }
    if (frozen) await run('RESUME');
    await run(hideHud ? HUD_ON : 'EVAL with(TeamSelectController) visible = true;');
  }

  // The mask over the live picture, composited here rather than drawn in the
  // game: one mask cell is exactly six world pixels and the tiles are
  // captured at 1:1, so this lands on the exact pixels the collision does -
  // no resample, no GML, and nothing that could disturb a running server.
  // Outlined rather than filled, because a fill over a map this dark and this
  // detailed either vanishes into the art or hides whatever the shot was taken
  // for (both tried, live).
  let picture = { width: rw, height: rh, rgba: canvas };
  let masked = false;
  if (withMask) {
    const mapName = await run('EVALX global.currentMap');
    picture = walkmask.outline(picture, walkmask.decode(mapName, repo), {
      cell: 6,
      originX: rx0,
      originY: ry0,
    });
    masked = true;
  }

  return { picture, cols, rows, wport, hport, masked };
}

module.exports = { capture, viewGml, HUD_OFF, HUD_ON };
