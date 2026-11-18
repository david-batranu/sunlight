import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTEXT_MAP_HALF_M,
  CONTEXT_MAP_TILE_ZOOM,
  planContextMap,
  tileCanvasPosition
} from '../../src/scene/context-map.ts';

test('context map plan covers the requested square and has a usable canvas mapping', () => {
  const plan = planContextMap(45.6486, 25.6061);
  assert.equal(plan.zoom, CONTEXT_MAP_TILE_ZOOM);
  assert.ok(plan.canvasPx >= 512);
  // 15 km at 45° latitude needs a small number of z13 tiles, not a flood.
  assert.ok(plan.tiles.length >= 4 && plan.tiles.length <= 49);
  assert.ok(plan.maxTileX >= plan.minTileX);
  assert.ok(plan.maxTileY >= plan.minTileY);

  // The tile grid must cover the canvas; corners land inside or slightly
  // outside it, never in the middle of nowhere.
  const first = tileCanvasPosition(plan, plan.minTileX, plan.minTileY);
  const last = tileCanvasPosition(plan, plan.maxTileX, plan.maxTileY);
  assert.ok(first.x <= 1 && first.y <= 1);
  const scale = plan.canvasPx / plan.spanPx;
  assert.ok(last.x + 256 * scale >= plan.canvasPx - 1);
  assert.ok(last.y + 256 * scale >= plan.canvasPx - 1);
});

test('context map plan is deterministic and clamps oversized requests', () => {
  const a = planContextMap(45.65, 25.6, { halfMetres: 1000, canvasPx: 128 });
  const b = planContextMap(45.65, 25.6, { halfMetres: 1000, canvasPx: 128 });
  assert.deepEqual(a, b);
  assert.equal(a.canvasPx, 128);
  const tiny = planContextMap(45.65, 25.6, { halfMetres: 0, canvasPx: 1 });
  assert.ok(tiny.spanPx > 0);
  assert.ok(tiny.canvasPx >= 64);
  assert.equal(CONTEXT_MAP_HALF_M, 7500);
});
