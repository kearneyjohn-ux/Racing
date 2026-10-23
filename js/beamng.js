// BeamNG.drive level from a course: the track as a dirt road on gently rolling red desert,
// a start line and spawn point, a minimap coloured by corner grade, and in-game pace notes
// (a small Lua extension shipped in the same mod zip).
//
// File layout follows BeamNG's current level format (main/MissionGroup, NDJSON items, a
// version 9 .ter terrain), as written by the MapNG exporter (MIT, github.com/nikkiluzader/mapng).

import { GRADES, HAZARD_LEVELS, noteText } from './analysis.js';
import { encodePNG, makeZip } from './zip.js';
import { PACENOTES_LUA, MODSCRIPT_LUA } from './beamng-lua.js';

const MARGIN = 400; // metres of desert around the course
const BASE_HEIGHT = 10;
const MAX_HEIGHT = 32; // TerrainBlock.maxHeight: heights are stored as 0-65535 over this range
const ROAD_WIDTH = 7;

// Smallest terrain that holds the course: grid size (power of two) × metres per square.
// Finer squares first, but no bigger than 4096 (BeamNG's largest standard terrain).
export function planTerrain(spanMetres) {
  const need = spanMetres + 2 * MARGIN;
  for (const squareSize of [1, 2, 4]) {
    for (const size of [1024, 2048]) if (size * squareSize >= need) return { size, squareSize, worldSize: size * squareSize };
  }
  for (const squareSize of [2, 4, 8]) if (4096 * squareSize >= need) return { size: 4096, squareSize, worldSize: 4096 * squareSize };
  return null;
}

export function levelNameFor(courseName) {
  const slug = String(courseName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `westlime_${slug || 'course'}`;
}

// Deterministic value noise in 0..1. `period` makes it tile (for textures).
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y, seed, period = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const w = (i) => (period ? ((i % period) + period) % period : i);
  const v = (i, j) => hash2(w(i), w(j), seed);
  const a = v(ix, iy) + (v(ix + 1, iy) - v(ix, iy)) * sx;
  const b = v(ix, iy + 1) + (v(ix + 1, iy + 1) - v(ix, iy + 1)) * sx;
  return a + (b - a) * sy;
}

// Ground height in metres at world x, y: long low swells with a little shorter roll.
export function groundHeight(x, y) {
  return BASE_HEIGHT + 4 * (noise(x / 400, y / 400, 1) - 0.5) + 1 * (noise(x / 90, y / 90, 2) - 0.5);
}

// Local metres (x east, y north) around the course centre.
function projector(samples) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of samples) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  const lat0 = (minLat + maxLat) / 2;
  const lon0 = (minLon + maxLon) / 2;
  const phi = (lat0 * Math.PI) / 180;
  const ky = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const kx = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  return { toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky], span: Math.max((maxLon - minLon) * kx, (maxLat - minLat) * ky), lat0, lon0 };
}

// Keep only the points needed to stay within `tol` metres of the line (Douglas-Peucker),
// never more than `maxGap` metres apart.
function simplify(pts, tol, maxGap) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let wd = 0;
    for (let i = a + 1; i < b; i++) {
      // (A loop starts and ends at the same point: measure from that point.)
      const d = len > 1e-6 ? Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      if (d > wd) [wd, worst] = [d, i];
    }
    if (worst > 0 && (wd > tol || len > maxGap)) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    } else if (len > maxGap && b - a > 1) {
      const mid = (a + b) >> 1;
      keep[mid] = 1;
      stack.push([a, mid], [mid, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
const ndjson = (items) => items.map((o) => JSON.stringify(o)).join('\n') + '\n';
const r2 = (v) => Math.round(v * 100) / 100;
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

// Vehicle facing along (dx, dy): rows are right, forward (+Y), up.
function facing(dx, dy) {
  const l = Math.hypot(dx, dy) || 1;
  const nx = dx / l;
  const ny = dy / l;
  return [ny, -nx, 0, nx, ny, 0, 0, 0, 1].map((v) => Math.round(v * 1e6) / 1e6 + 0);
}

// Tileable ground texture: base colour with blotches and grit.
function groundTexture(size, [r, g, b], seed, grit) {
  const px = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = 0.5 * noise(x / 64, y / 64, seed, size / 64) + 0.3 * noise(x / 16, y / 16, seed + 1, size / 16) + 0.2 * noise(x / 4, y / 4, seed + 2, size / 4);
      const speck = hash2(x, y, seed + 3) < grit ? -0.25 : 0;
      const f = 0.82 + 0.36 * n + speck;
      const o = (y * size + x) * 3;
      px[o] = Math.max(0, Math.min(255, r * f));
      px[o + 1] = Math.max(0, Math.min(255, g * f));
      px[o + 2] = Math.max(0, Math.min(255, b * f));
    }
  }
  return px;
}

const SAND = [176, 98, 58];
const DIRT = [138, 82, 52];

// Top-down picture of the course (north up), coloured by corner grade.
function drawMap(size, worldSize, line, runs, start) {
  const px = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) px.set(SAND.map((v) => v * 0.9), i * 3);
  const half = worldSize / 2;
  const toPx = ([x, y]) => [((x + half) / worldSize) * size, ((half - y) / worldSize) * size];
  const dot = (cx, cy, rad, col) => {
    for (let y = Math.floor(cy - rad); y <= cy + rad; y++)
      for (let x = Math.floor(cx - rad); x <= cx + rad; x++)
        if (x >= 0 && y >= 0 && x < size && y < size && (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) px.set(col, (y * size + x) * 3);
  };
  const rad = Math.max(1.2, size / 500);
  const stroke = (pts, col, w) => {
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = toPx(pts[i - 1]);
      const [bx, by] = toPx(pts[i]);
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / (w * 0.5)) || 1;
      for (let k = 0; k <= steps; k++) dot(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps, w, col);
    }
  };
  stroke(line, [255, 255, 255], rad + 1.5);
  for (const run of runs) stroke(run.pts, run.color, rad);
  const [sx, sy] = toPx(start);
  dot(sx, sy, rad * 4, [255, 255, 255]);
  dot(sx, sy, rad * 2.5, [20, 20, 20]);
  return px;
}

// Build the mod zip. Returns { filename, bytes, levelName, terrain }.
export async function buildBeamNGLevel(title, analysis, { hazards = [], leadMeters = 100, leadSeconds = 0, author = 'Westlime Motorsport', onProgress = () => {} } = {}) {
  const { samples, corners, closed } = analysis;
  if (!samples?.length || samples.length < 20) throw new Error('The course is too short to build a level.');
  const proj = projector(samples);
  const terrain = planTerrain(proj.span);
  if (!terrain) throw new Error(`The course spans ${(proj.span / 1000).toFixed(1)} km, more than a BeamNG map can hold (about 32 km).`);
  const { size, squareSize, worldSize } = terrain;
  const half = worldSize / 2;
  const levelName = levelNameFor(title);
  const base = `levels/${levelName}`;
  const xy = samples.map((p) => proj.toXY(p.lat, p.lon));
  const total = analysis.length ?? samples.at(-1).s;
  const files = [];
  const add = (path, data) => files.push({ path, data });

  // --- Terrain: heights and where the track is (track dirt vs desert sand) -------------------
  onProgress('Shaping the terrain…');
  await new Promise((r) => setTimeout(r, 0));
  const heights = new Uint16Array(size * size);
  const scale = 65535 / MAX_HEIGHT;
  for (let j = 0; j < size; j++) {
    const y = -half + j * squareSize;
    // Whole 8 mm steps: invisible, and the terrain files compress far better.
    for (let i = 0; i < size; i++) heights[j * size + i] = Math.round((groundHeight(-half + i * squareSize, y) * scale) / 16) * 16;
  }
  const layers = new Uint8Array(size * size);
  const reach = ROAD_WIDTH / 2 + 1.5;
  const cells = Math.ceil(reach / squareSize);
  const step = Math.max(1, Math.round(squareSize / 2));
  for (let k = 0; k < xy.length; k += step) {
    const ci = Math.round((xy[k][0] + half) / squareSize);
    const cj = Math.round((xy[k][1] + half) / squareSize);
    for (let dj = -cells; dj <= cells; dj++)
      for (let di = -cells; di <= cells; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= size || j >= size) continue;
        const d = Math.hypot(-half + i * squareSize - xy[k][0], -half + j * squareSize - xy[k][1]);
        if (d <= Math.max(reach, squareSize * 0.71)) layers[j * size + i] = 1;
      }
  }
  const materials = ['DesertSand', 'TrackDirt'];
  const names = materials.map((m) => new TextEncoder().encode(m));
  const ter = new Uint8Array(5 + size * size * 3 + 4 + names.reduce((t, n) => t + 1 + n.length, 0));
  const tv = new DataView(ter.buffer);
  ter[0] = 9;
  tv.setUint32(1, size, true);
  let o = 5;
  for (let i = 0; i < heights.length; i++, o += 2) tv.setUint16(o, heights[i], true);
  ter.set(layers, o);
  o += layers.length;
  tv.setUint32(o, materials.length, true);
  o += 4;
  for (const n of names) {
    ter[o++] = n.length;
    ter.set(n, o);
    o += n.length;
  }
  add(`${base}/art/terrains/terrain.ter`, ter);

  onProgress('Painting textures…');
  await new Promise((r) => setTimeout(r, 0));
  // Heightmap image (north at the top) for the World Editor.
  const hm = new Uint16Array(size * size);
  for (let j = 0; j < size; j++) hm.set(heights.subarray(j * size, (j + 1) * size), (size - 1 - j) * size);
  add(`${base}/art/terrains/terrain.terrainheightmap.png`, await encodePNG(size, size, hm, { channels: 1, depth: 16 }));
  add(`${base}/art/terrains/desert_sand.png`, await encodePNG(512, 512, groundTexture(512, SAND, 11, 0.04)));
  add(`${base}/art/terrains/track_dirt.png`, await encodePNG(512, 512, groundTexture(512, DIRT, 21, 0.08)));
  add(
    `${base}/art/terrains/main.materials.json`,
    JSON.stringify(
      {
        DesertSand: { class: 'TerrainMaterial', internalName: 'DesertSand', persistentId: uuid(), diffuseMap: `levels/${levelName}/art/terrains/desert_sand.png`, diffuseSize: 24, groundmodelName: 'SAND' },
        TrackDirt: { class: 'TerrainMaterial', internalName: 'TrackDirt', persistentId: uuid(), diffuseMap: `levels/${levelName}/art/terrains/track_dirt.png`, diffuseSize: 16, groundmodelName: 'DIRT' },
      },
      null,
      2,
    ),
  );
  add(
    `${base}/terrain.terrain.json`,
    JSON.stringify(
      {
        binaryFormat: 'version(char), size(unsigned int), heightMap(heightMapSize * heightMapItemSize), layerMap(layerMapSize * layerMapItemSize), layerTextureMap(layerMapSize * layerMapItemSize), materialNames',
        datafile: `/${base}/art/terrains/terrain.ter`,
        heightMapItemSize: 2,
        heightMapSize: size * size,
        heightmapImage: `/${base}/art/terrains/terrain.terrainheightmap.png`,
        layerMapItemSize: 1,
        layerMapSize: size * size,
        materials,
        size,
        version: 9,
      },
      null,
      2,
    ),
  );

  // --- The road: decal road chunks along the smoothed track -----------------------------------
  const z = ([x, y]) => r2(groundHeight(x, y));
  const linePts = closed ? [...xy, xy[0]] : xy;
  const nodes = simplify(linePts, 0.25, 30);
  const roads = [];
  const CHUNK = 300;
  for (let a = 0, part = 1; a < nodes.length - 1; a += CHUNK - 1, part++) {
    const seg = nodes.slice(a, a + CHUNK).map((p) => [r2(p[0]), r2(p[1]), z(p), ROAD_WIDTH]);
    if (seg.length < 2) break;
    roads.push({
      class: 'DecalRoad',
      name: `course_${part}`,
      persistentId: uuid(),
      __parent: 'Decal_Roads',
      position: seg[0].slice(0, 3),
      improvedSpline: true,
      material: 'm_dirt_road',
      nodes: seg,
      breakAngle: 2,
      renderPriority: 10,
      textureLength: 88,
      drivability: 1,
      detail: 0.5,
    });
  }
  // Start line across the track (and a finish line on a point-to-point stage).
  const n = xy.length;
  const lineAt = (k, name) => {
    const [x, y] = xy[k];
    const [px, py] = xy[Math.min(n - 1, k + 3)];
    const [qx, qy] = xy[Math.max(0, k - 3)];
    const dx = px - qx;
    const dy = py - qy;
    const l = Math.hypot(dx, dy) || 1;
    const ox = (-dy / l) * (ROAD_WIDTH / 2 + 1);
    const oy = (dx / l) * (ROAD_WIDTH / 2 + 1);
    const a = [r2(x - ox), r2(y - oy)];
    const b = [r2(x + ox), r2(y + oy)];
    return { class: 'DecalRoad', name, persistentId: uuid(), __parent: 'Decal_Roads', position: [...a, z(a)], material: 'm_line_white', nodes: [[...a, z(a), 0.6], [...b, z(b), 0.6]], renderPriority: 5, textureLength: 6.4, breakAngle: 1, detail: 0.5 };
  };
  const startK = closed ? 0 : Math.min(n - 1, 15);
  roads.push(lineAt(startK, 'start_line'));
  if (!closed) roads.push(lineAt(n - 1, 'finish_line'));

  // Spawn 15 m behind the start line, facing along the track.
  const spawnK = closed ? Math.max(0, n - 15) : 0;
  const ahead = xy[Math.min(n - 1, spawnK + 5)];
  const spawnPos = [r2(xy[spawnK][0]), r2(xy[spawnK][1]), r2(z(xy[spawnK]) + 0.8)];
  const spawnRot = facing(ahead[0] - xy[spawnK][0], ahead[1] - xy[spawnK][1]);

  // --- Level objects --------------------------------------------------------------------------
  add(`${base}/main/items.level.json`, ndjson([{ class: 'SimGroup', name: 'MissionGroup', persistentId: uuid() }]));
  const groups = ['sky_and_sun', 'level_objects', 'PlayerDropPoints', 'Decal_Roads', 'AIWaypointsGroup', 'AIDecalWaypointsGroup'];
  add(`${base}/main/MissionGroup/items.level.json`, ndjson(groups.map((name) => ({ __parent: 'MissionGroup', class: 'SimGroup', name, persistentId: uuid() }))));
  add(
    `${base}/main/MissionGroup/sky_and_sun/items.level.json`,
    ndjson([
      { __parent: 'sky_and_sun', class: 'LevelInfo', name: 'theLevelInfo', persistentId: uuid(), canvasClearColor: [0, 0, 0, 1], fogAtmosphereHeight: 1000, fogDensity: 0.0001, fogDensityOffset: 0, globalEnviromentMap: 'cubemap_italy_reflection', gravity: -9.81, nearClip: 0.1, visibleDistance: 4000, decalBias: 0.0005, soundAmbience: 'AudioAmbienceDefault', soundDistanceModel: 'Logarithmic', temperatureCurveC: [0, 30, 0.25, 36, 0.5, 18, 0.75, 16, 1, 30] },
      { __parent: 'sky_and_sun', class: 'TimeOfDay', name: 'tod', persistentId: uuid(), startTime: 0.1 },
      { __parent: 'sky_and_sun', class: 'ScatterSky', name: 'sunsky', persistentId: uuid(), ambientScaleGradientFile: 'art/sky_gradients/default/gradient_ambient.png', colorizeGradientFile: 'art/sky_gradients/default/gradient_colorize.png', enableFogFallBack: false, fogScaleGradientFile: 'art/sky_gradients/default/gradient_fog.png', shadowDistance: 1500, skyBrightness: 40, sunScaleGradientFile: 'art/sky_gradients/default/gradient_sunscale.png', texSize: 2048 },
    ]),
  );
  add(
    `${base}/main/MissionGroup/level_objects/items.level.json`,
    ndjson([
      { __parent: 'level_objects', class: 'TerrainBlock', name: 'theTerrain', persistentId: uuid(), position: [-half, -half, 0], squareSize, maxHeight: MAX_HEIGHT, baseTexSize: size, terrainFile: `/${base}/art/terrains/terrain.ter`, materialTextureSet: '', minimapImage: `${base}/art/minimap.png` },
    ]),
  );
  add(
    `${base}/main/MissionGroup/PlayerDropPoints/items.level.json`,
    ndjson([{ __parent: 'PlayerDropPoints', class: 'SpawnSphere', dataBlock: 'SpawnSphereMarker', name: 'spawn_default', persistentId: uuid(), position: spawnPos, rotationMatrix: spawnRot, radius: 5 }]),
  );
  add(`${base}/main/MissionGroup/Decal_Roads/items.level.json`, ndjson(roads));
  add(`${base}/main/MissionGroup/AIWaypointsGroup/items.level.json`, '');
  add(`${base}/main/MissionGroup/AIDecalWaypointsGroup/items.level.json`, '');
  add(`${base}/map.json`, JSON.stringify({ segments: {} }, null, 2));

  // --- Minimap and preview, coloured like the app ----------------------------------------------
  onProgress('Drawing the map…');
  await new Promise((r) => setTimeout(r, 0));
  const owner = new Int32Array(n).fill(-1);
  corners.forEach((c, ci) => c.indices?.forEach((i) => (owner[i] = ci)));
  const runs = [];
  for (let i = 0; i < n; i++) {
    const c = owner[i] >= 0 ? corners[owner[i]] : null;
    const color = c ? hex(GRADES[c.grade]?.color ?? '#ffffff') : [60, 40, 30];
    const last = runs.at(-1);
    if (last && last.owner === owner[i]) last.pts.push(xy[i]);
    else runs.push({ owner: owner[i], color, pts: last ? [last.pts.at(-1), xy[i]] : [xy[i]] });
  }
  if (closed && runs.length) runs.at(-1).pts.push(xy[0]);
  const start = xy[startK];
  add(`${base}/art/minimap.png`, await encodePNG(1024, 1024, drawMap(1024, worldSize, linePts, runs, start)));
  add(`${base}/preview.png`, await encodePNG(512, 512, drawMap(512, worldSize, linePts, runs, start)));

  add(
    `${base}/info.json`,
    JSON.stringify(
      {
        title,
        description: `${title}: ${(total / 1000).toFixed(1)} km ${closed ? 'loop' : 'stage'} with ${corners.length} corners, exported from Race Course Plotter. Pace notes are shown as you drive.`,
        authors: author,
        previews: ['preview.png'],
        size: [worldSize, worldSize],
        defaultSpawnPointName: 'spawn_default',
        spawnPoints: [{ name: 'Start line', objectname: 'spawn_default', preview: 'preview.png', translationId: 'Start line' }],
        suitablefor: 'Freeroam, pace note practice',
        features: 'Recorded off-road course with pace notes',
        roads: 'Dirt',
        supportsTraffic: false,
        supportsTimeOfDay: true,
        minimap: [{ file: 'art/minimap.png', size: [worldSize, worldSize], offset: [-half, half] }],
      },
      null,
      2,
    ),
  );

  // --- Pace notes for the in-game extension ----------------------------------------------------
  const line = [];
  for (let i = 0; i < n; i += 5) line.push([r2(xy[i][0]), r2(xy[i][1]), Math.round(samples[i].s)]);
  if (line.at(-1)[2] !== Math.round(samples[n - 1].s)) line.push([r2(xy[n - 1][0]), r2(xy[n - 1][1]), Math.round(samples[n - 1].s)]);
  const notes = [
    ...corners.map((c) => ({ s: Math.round(c.startS), text: noteText(c), grade: Number(c.grade), dir: c.dir })),
    ...hazards.filter((h) => Number.isFinite(h.s)).map((h) => ({ s: Math.round(h.s), text: `${HAZARD_LEVELS[h.level]?.label ?? 'Hazard'} hazard`, hazard: h.level })),
  ].sort((a, b) => a.s - b.s);
  add(
    `${base}/westlime_pacenotes.json`,
    JSON.stringify({ version: 1, title, closed: !!closed, length: Math.round(total), lead: leadMeters, leadSeconds, start: closed ? 0 : Math.round(samples[startK].s), line, notes }),
  );
  add('lua/ge/extensions/westlimePacenotes.lua', PACENOTES_LUA);
  add('scripts/westlime_pacenotes/modScript.lua', MODSCRIPT_LUA);

  // Folder entries first, so the game's directory checks find them.
  const dirs = new Set();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
  }
  onProgress('Packing the mod zip…');
  await new Promise((r) => setTimeout(r, 0));
  const bytes = await makeZip([...[...dirs].sort().map((path) => ({ path })), ...files]);
  return { filename: `${levelName}.zip`, bytes, levelName, terrain, roads: roads.length, notes: notes.length };
}
