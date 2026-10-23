import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCourse } from '../js/analysis.js';
import { buildBeamNGLevel, planTerrain, levelNameFor } from '../js/beamng.js';
import { crc32, encodePNG } from '../js/zip.js';
import { buildPath, toLatLon } from '../tools/track-gen.js';

// Read a zip back: { path: bytes }.
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (dv.getUint32(end, true) !== 0x06054b50) end--;
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out = {};
  for (let k = 0; k < count; k++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen));
    const lnl = dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    let data = bytes.subarray(off + 30 + lnl, off + 30 + lnl + csize);
    if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out[name] = data;
    p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return out;
}

test('terrain size is the smallest grid that holds the course', () => {
  assert.deepEqual(planTerrain(1000), { size: 2048, squareSize: 1, worldSize: 2048 });
  assert.deepEqual(planTerrain(4500), { size: 2048, squareSize: 4, worldSize: 8192 });
  assert.deepEqual(planTerrain(29100), { size: 4096, squareSize: 8, worldSize: 32768 });
  assert.equal(planTerrain(40000), null);
  assert.equal(levelNameFor('KDR Prologue 2026!'), 'westlime_kdr_prologue_2026');
});

test('PNG encoder writes a valid header', async () => {
  const png = await encodePNG(2, 2, new Uint8Array(12).fill(200));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(new DataView(png.buffer).getUint32(16), 2);
});

test('BeamNG level: terrain, road, spawn and pace notes', async () => {
  const pts = toLatLon(
    buildPath([{ straight: 300 }, { radius: 40, angle: 90, dir: 'L' }, { straight: 200 }, { radius: 25, angle: 120, dir: 'R' }, { straight: 300 }]),
  );
  const a = analyzeCourse(pts);
  const { bytes, filename, levelName, terrain } = await buildBeamNGLevel('Test Stage', a, { hazards: [{ s: 100, level: 'red' }] });
  assert.equal(filename, 'westlime_test_stage.zip');
  const files = await unzip(bytes);
  const base = `levels/${levelName}`;
  for (const f of ['info.json', 'main/items.level.json', 'main/MissionGroup/items.level.json', 'art/terrains/terrain.ter', 'art/terrains/main.materials.json', 'terrain.terrain.json', 'westlime_pacenotes.json', 'preview.png', 'art/minimap.png'])
    assert.ok(files[`${base}/${f}`], `${f} is in the zip`);
  assert.ok(files['lua/ge/extensions/westlimePacenotes.lua'] && files['scripts/westlime_pacenotes/modScript.lua']);
  assert.ok(files[`${base}/main/MissionGroup/`], 'folders have their own entries');

  // .ter: version 9, size, heights, layer map (track painted), then the material names.
  const ter = files[`${base}/art/terrains/terrain.ter`];
  const dv = new DataView(ter.buffer, ter.byteOffset, ter.byteLength);
  const n = terrain.size;
  assert.equal(ter[0], 9);
  assert.equal(dv.getUint32(1, true), n);
  const layers = ter.subarray(5 + 2 * n * n, 5 + 3 * n * n);
  assert.ok(layers.some((v) => v === 1) && layers.some((v) => v === 0), 'track and desert both painted');
  let o = 5 + 3 * n * n;
  assert.equal(dv.getUint32(o, true), 2);
  o += 4;
  const names = [];
  for (let k = 0; k < 2; k++) {
    const len = ter[o++];
    names.push(new TextDecoder().decode(ter.subarray(o, o + len)));
    o += len;
  }
  assert.deepEqual(names, ['DesertSand', 'TrackDirt']);
  assert.equal(o, ter.length);
  const tj = JSON.parse(new TextDecoder().decode(files[`${base}/terrain.terrain.json`]));
  assert.deepEqual(tj.materials, names);

  // Every scene file is one JSON object per line, each with a parent group.
  const lines = (p) => new TextDecoder().decode(files[`${base}/main/MissionGroup/${p}/items.level.json`]).trim().split('\n').map((l) => JSON.parse(l));
  const roads = lines('Decal_Roads');
  const course = roads.filter((r) => r.name.startsWith('course_'));
  assert.ok(course.length >= 1 && course.every((r) => r.class === 'DecalRoad' && r.nodes.length >= 2 && r.nodes.every((p) => p.length === 4)));
  assert.ok(roads.some((r) => r.name === 'start_line') && roads.some((r) => r.name === 'finish_line'), 'a stage has start and finish lines');
  const [spawn] = lines('PlayerDropPoints');
  assert.equal(spawn.class, 'SpawnSphere');
  assert.equal(spawn.name, JSON.parse(new TextDecoder().decode(files[`${base}/info.json`])).defaultSpawnPointName);
  const [block] = lines('level_objects');
  assert.equal(block.terrainFile, `/${base}/art/terrains/terrain.ter`);
  assert.deepEqual(block.position, [-terrain.worldSize / 2, -terrain.worldSize / 2, 0]);

  const notes = JSON.parse(new TextDecoder().decode(files[`${base}/westlime_pacenotes.json`]));
  assert.equal(notes.closed, false);
  assert.deepEqual(notes.notes.map((x) => x.text.split(' ').slice(0, 2).join(' ')), ['Red hazard', `Left ${a.corners[0].grade}`, `Right ${a.corners[1].grade}`]);
  assert.ok(notes.line.length > 100 && notes.line.every((p) => p.length === 3));
});
