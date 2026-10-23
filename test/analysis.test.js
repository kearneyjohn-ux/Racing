import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCourse,
  cornerSpeedKmh,
  gradeFor,
  locate,
  cornersAhead,
  colourRuns,
  noteText,
  spokenNote,
  placeHazards,
  hazardsAhead,
  positionAtTime,
  hazardLevelFromSpeech,
  joinTracks,
  isManoeuvre,
} from '../js/analysis.js';
import { buildPath, toLatLon, simulateGPS, speedProfile, rng } from '../tools/track-gen.js';

const track = (parts, opts) => toLatLon(buildPath(parts, opts));
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected} ± ${tol}, got ${actual.toFixed(2)}`);

test('a straight has no corners', () => {
  const a = analyzeCourse(track([{ straight: 500 }]));
  assert.equal(a.corners.length, 0);
  assert.equal(a.closed, false);
  near(a.length, 500, 2, 'length');
});

test('single 90° left: direction, radius, angle', () => {
  const a = analyzeCourse(track([{ straight: 200 }, { radius: 30, angle: 90, dir: 'L' }, { straight: 200 }]));
  assert.equal(a.corners.length, 1);
  const c = a.corners[0];
  assert.equal(c.dir, 'L');
  near(c.angle, 90, 6, 'angle');
  near(c.radius, 30, 5, 'radius');
  near(c.apexS, 200 + (30 * Math.PI) / 4, 8, 'apex position');
});

test('tight 180° right is a grade 1 hairpin', () => {
  const a = analyzeCourse(track([{ straight: 150 }, { radius: 10, angle: 180, dir: 'R' }, { straight: 150 }]));
  assert.equal(a.corners.length, 1);
  assert.equal(a.corners[0].dir, 'R');
  assert.equal(a.corners[0].grade, '1');
  assert.equal(a.corners[0].hairpin, true);
  assert.match(noteText(a.corners[0]), /^Right 1 hairpin/);
  assert.match(spokenNote(a.corners[0]), /^right 1 hairpin/);
});

test('S-bend gives two corners in opposite directions', () => {
  const a = analyzeCourse(
    track([{ straight: 150 }, { radius: 40, angle: 60, dir: 'L' }, { radius: 40, angle: 60, dir: 'R' }, { straight: 150 }]),
  );
  assert.deepEqual(a.corners.map((c) => c.dir), ['L', 'R']);
  assert.equal(a.corners[0].into, true, 'first corner leads straight into the second');
});

test('gentle sweeper above the straight threshold is ignored', () => {
  const a = analyzeCourse(track([{ straight: 150 }, { radius: 400, angle: 30, dir: 'L' }, { straight: 150 }]));
  assert.equal(a.corners.length, 0);
});

test('tightening corner is flagged', () => {
  const a = analyzeCourse(
    track([{ straight: 150 }, { radius: 60, angle: 45, dir: 'R' }, { radius: 20, angle: 70, dir: 'R' }, { straight: 150 }]),
  );
  assert.equal(a.corners.length, 1);
  assert.equal(a.corners[0].tightens, true);
  assert.equal(a.corners[0].opens, false);
});

const rectangle = [
  { straight: 300 },
  { radius: 20, angle: 90, dir: 'L' },
  { straight: 150 },
  { radius: 20, angle: 90, dir: 'L' },
  { straight: 300 },
  { radius: 20, angle: 90, dir: 'L' },
  { straight: 150 },
  { radius: 20, angle: 90, dir: 'L' },
];

test('closed loop is detected and has four corners', () => {
  const a = analyzeCourse(track(rectangle));
  assert.equal(a.closed, true);
  assert.equal(a.corners.length, 4);
  for (const c of a.corners) {
    assert.equal(c.dir, 'L');
    near(c.angle, 90, 6, 'angle');
  }
});

test('loop recorded starting mid-corner does not split that corner', () => {
  const rotated = [{ radius: 20, angle: 45, dir: 'L' }, ...rectangle.slice(1), { radius: 20, angle: 45, dir: 'L' }];
  const a = analyzeCourse(track([...rotated.slice(0, 1), { straight: 300 }, ...rotated.slice(1)]));
  // Build: half corner, straight 300, the other three corners and straights, then the other half.
  assert.equal(a.closed, true);
  assert.equal(a.corners.length, 4);
  for (const c of a.corners) near(c.angle, 90, 8, 'angle');
});

test('extra laps are trimmed to the first lap', () => {
  const a = analyzeCourse(track([...rectangle, ...rectangle, { straight: 100 }]));
  assert.equal(a.closed, true);
  assert.equal(a.trimmed, true);
  assert.equal(a.corners.length, 4);
});

test('noisy 1 Hz GPS still finds the right corners', () => {
  const parts = [
    { straight: 250 },
    { radius: 25, angle: 90, dir: 'R' },
    { straight: 200 },
    { radius: 60, angle: 70, dir: 'L' },
    { straight: 250 },
  ];
  const dense = buildPath(parts);
  const v = speedProfile(dense, { mu: 0.6 });
  const fixes = toLatLon(simulateGPS(dense, v, { hz: 1, noise: 1.5, seed: 3 }));
  const a = analyzeCourse(fixes);
  assert.deepEqual(a.corners.map((c) => c.dir), ['R', 'L']);
  near(a.corners[0].radius, 25, 12, 'tight radius');
  near(a.corners[1].radius, 60, 25, 'open radius');
  assert.ok(a.corners[0].speedKmh < a.corners[1].speedKmh, 'tighter corner is slower');
  assert.ok(a.hasDriven);
  assert.ok(a.corners[0].drivenKmh > 20 && a.corners[0].drivenKmh < 60, `driven ${a.corners[0].drivenKmh}`);
});

test('speed model and grading', () => {
  // v = sqrt(mu * confidence * g * r): 0.55 * 0.8 * 9.80665 * 50 -> 52.9 km/h
  near(cornerSpeedKmh(50, { surface: 'gravel', confidence: 0.8 }), 52.9, 0.2, 'speed');
  assert.equal(gradeFor({ radius: 50, angle: 60 }, { surface: 'gravel' }).grade, '3');
  assert.equal(gradeFor({ radius: 8, angle: 90 }, { surface: 'gravel' }).grade, '1');
  const hp = gradeFor({ radius: 12, angle: 170 }, { surface: 'gravel' });
  assert.deepEqual([hp.grade, hp.hairpin], ['1', true]);
  // Only grades 1-5 exist: anything very fast is a 5, capped at the vehicle's top speed.
  const fast = gradeFor({ radius: 2000, angle: 20 }, { surface: 'tarmac', topSpeedKmh: 120 });
  assert.deepEqual([fast.grade, fast.speedKmh], ['5', 120]);
  // Less grip means a slower (lower) grade for the same corner.
  const dry = gradeFor({ radius: 80, angle: 60 }, { surface: 'hardpack' }).grade;
  const mud = gradeFor({ radius: 80, angle: 60 }, { surface: 'mud' }).grade;
  assert.ok(Number(mud) < Number(dry));
});

test('overrides stick to the nearest corner', () => {
  const pts = track([{ straight: 200 }, { radius: 30, angle: 90, dir: 'L' }, { straight: 200 }]);
  const auto = analyzeCourse(pts).corners[0];
  const a = analyzeCourse(pts, { overrides: [{ s: auto.apexS + 5, grade: '1', note: "don't cut" }] });
  assert.equal(a.corners[0].grade, '1');
  assert.equal(a.corners[0].autoGrade, auto.grade);
  assert.equal(a.corners[0].note, "don't cut");
});

test('locate and cornersAhead on a loop', () => {
  const a = analyzeCourse(track(rectangle));
  const at = a.samples[100];
  const pos = locate(a, at.lat, at.lon);
  near(pos.s, 100 * a.ds, 1.5, 'position along course');
  const [next, after] = cornersAhead(a, pos.index, 2);
  assert.equal(next.corner.number, 1);
  assert.ok(next.distance > 150 && next.distance < 300, `distance ${next.distance}`);
  assert.equal(after.corner.number, 2);
  // Just past the last corner, the next one wraps around to corner 1.
  const last = a.corners.at(-1);
  const [wrap] = cornersAhead(a, (last.endIdx + 5) % a.samples.length, 1);
  assert.equal(wrap.corner.number, 1);
});

test('reverse direction flips corner directions', () => {
  const a = analyzeCourse(track([{ straight: 200 }, { radius: 30, angle: 90, dir: 'L' }, { straight: 200 }]), { reverse: true });
  assert.equal(a.corners[0].dir, 'R');
});

test('colour runs cover the whole course', () => {
  const a = analyzeCourse(track(rectangle));
  const runs = colourRuns(a);
  assert.equal(runs.filter((r) => r.corner).length, 4);
  const pts = runs.reduce((s, r) => s + r.latlngs.length - 1, 0);
  assert.equal(pts, a.samples.length, 'every segment drawn once, including the closing one');
});

test('hazards snap to the course and are found ahead, including across the line', () => {
  const a = analyzeCourse(track(rectangle));
  const at = (i) => ({ lat: a.samples[i].lat, lon: a.samples[i].lon });
  const n = a.samples.length;
  const far = { lat: a.samples[0].lat + 0.01, lon: a.samples[0].lon };
  const placed = placeHazards(a, [
    { ...at(400), level: 'red' },
    { ...at(50), level: 'green' },
    { ...far, level: 'orange' }, // 1 km away: dropped
    { ...at(60), level: 'purple' }, // unknown level: dropped
  ]);
  assert.deepEqual(placed.map((h) => h.level), ['green', 'red']);
  const ahead = hazardsAhead(a, placed, 350, 100);
  assert.equal(ahead.length, 1);
  assert.equal(ahead[0].hazard.level, 'red');
  assert.ok(Math.abs(ahead[0].distance - 50 * a.ds) < 2);
  const wrap = hazardsAhead(a, placed, n - 20, 100);
  assert.deepEqual(wrap.map((x) => x.hazard.level), ['green']);
});

test('positionAtTime interpolates between fixes', () => {
  const pts = [
    { lat: 52, lon: -7, t: 1000 },
    { lat: 52.001, lon: -7, t: 2000 },
  ];
  assert.deepEqual(positionAtTime(pts, 1500), { lat: 52.0005, lon: -7 });
  assert.deepEqual(positionAtTime(pts, 500), { lat: 52, lon: -7 });
  assert.deepEqual(positionAtTime(pts, 9000), { lat: 52.001, lon: -7 });
  assert.equal(positionAtTime([{ lat: 1, lon: 1, t: NaN }], 5), null);
});

test('hazard colours are picked out of speech', () => {
  assert.equal(hazardLevelFromSpeech('Red'), 'red');
  assert.equal(hazardLevelFromSpeech('read'), 'red');
  assert.equal(hazardLevelFromSpeech('uh amber'), 'orange');
  assert.equal(hazardLevelFromSpeech('green then red'), 'green');
  assert.equal(hazardLevelFromSpeech('Greenland'), null);
  assert.equal(hazardLevelFromSpeech('left three'), null);
});

test('joining two parts fills the gap with a smooth curve', () => {
  // One lap of the rectangle with the recording interrupted around the second corner.
  const lap = track(rectangle, { step: 2 });
  const cutA = lap.findIndex((p) => p.x > 310); // part a stops just into corner 1
  const cutB = cutA + 60; // part b restarts 120 m later, past corner 1
  const joined = joinTracks(lap.slice(0, cutA), lap.slice(cutB));
  assert.equal(joined.overlapTrimmed, false);
  assert.ok(joined.gap > 50 && joined.gap < 120, `gap ${joined.gap}`);
  assert.ok(joined.points.some((p) => p.filled));
  const a = analyzeCourse(joined.points);
  assert.equal(a.closed, true);
  assert.equal(a.corners.length, 4, 'the corner inside the gap is rebuilt');
  assert.equal(a.corners.filter((c) => c.guessed).length, 1, 'and flagged as guessed');
  assert.ok(a.samples.some((p) => p.filled));
});

test('joining trims an overlap instead of filling', () => {
  const lap = track(rectangle, { step: 2 });
  const joined = joinTracks(lap.slice(0, 300), lap.slice(290));
  assert.equal(joined.overlapTrimmed, true);
  assert.equal(joined.gap, 0);
  assert.ok(!joined.points.some((p) => p.filled));
  assert.equal(analyzeCourse(joined.points).corners.length, 4);
});

// A rest stop in the middle of a straight: the GPS keeps wandering a few metres while parked.
function trackWithStop({ withSpeed }) {
  const rand = rng(5);
  const pts = [];
  let t = Date.UTC(2026, 9, 1, 9);
  let x = 0;
  for (let i = 0; i < 25; i++, t += 1000, x += 15) pts.push({ x, y: 0, t, speed: 15 });
  let jx = 0;
  let jy = 0;
  for (let i = 0; i < 120; i++, t += 1000) {
    jx = 0.85 * jx + 1.2 * rand.gauss();
    jy = 0.85 * jy + 1.2 * rand.gauss();
    pts.push({ x: x + jx, y: jy, t, speed: Math.abs(0.2 * rand.gauss()) });
  }
  for (let i = 0; i < 25; i++, t += 1000) pts.push({ x: (x += 15), y: 0, t, speed: 15 });
  return toLatLon(pts).map(({ lat, lon, t: time, speed }) => ({ lat, lon, t: time, ...(withSpeed ? { speed } : {}) }));
}

test('a rest stop on a straight does not become a corner', () => {
  for (const withSpeed of [true, false]) {
    const a = analyzeCourse(trackWithStop({ withSpeed }));
    assert.equal(a.corners.length, 0, `${withSpeed ? 'with' : 'without'} GPS speed: ${a.corners.map((c) => `${Math.round(c.angle)}° r${c.radius.toFixed(1)}`).join(', ')}`);
    assert.ok(Math.abs(a.length - 750) < 30, `length ${a.length}`);
  }
});

// A messier stop: slow roll in and out, poor accuracy under trees, GPS drifting up to ~15 m,
// and the phone reporting speed as invalid (-1) while parked.
test('a rest stop with poor GPS and a slow roll in/out does not become a corner', () => {
  const rand = rng(9);
  const pts = [];
  let t = Date.UTC(2026, 9, 1, 9);
  let x = 0;
  const push = (px, py, speed, acc) => pts.push({ x: px, y: py, t: (t += 1000), speed, acc });
  for (let i = 0; i < 25; i++) push((x += 15), 0, 15, 4);
  for (const v of [10, 6, 3, 1.5, 0.6]) push((x += v), 0, v, 6); // braking
  let jx = 0;
  let jy = 0;
  for (let i = 0; i < 150; i++) {
    jx = 0.9 * jx + 2.5 * rand.gauss();
    jy = 0.9 * jy + 2.5 * rand.gauss();
    push(x + jx, jy, i % 3 ? -1 : Math.abs(0.3 * rand.gauss()), 12 + 6 * Math.abs(rand.gauss()));
  }
  for (const v of [0.6, 1.5, 3, 6, 10]) push((x += v), 0, v, 6); // pulling away
  for (let i = 0; i < 25; i++) push((x += 15), 0, 15, 4);
  const fixes = toLatLon(pts).map(({ lat, lon, t: time, speed, acc }) => ({ lat, lon, t: time, speed, acc }));
  const a = analyzeCourse(fixes);
  assert.equal(a.corners.length, 0, a.corners.map((c) => `${Math.round(c.angle)}° r${c.radius.toFixed(1)}`).join(', '));
});

// Pulling off the track to park and rejoining: a real few-metre jog at walking pace.
test('pulling over for a rest and rejoining does not become corners', () => {
  const rand = rng(13);
  const pts = [];
  let t = Date.UTC(2026, 9, 1, 9);
  let x = 0;
  let y = 0;
  const push = (speed, acc = 5) => pts.push({ x: x + 0.8 * rand.gauss(), y: y + 0.8 * rand.gauss(), t: (t += 1000), speed, acc });
  for (let i = 0; i < 25; i++) { x += 15; push(15); }
  for (const v of [8, 4, 2]) { x += v; push(v); }
  for (let i = 0; i < 6; i++) { x += 0.4; y -= 0.9; push(0.9); } // creep off to the right
  for (let i = 0; i < 90; i++) push(0, 8); // parked
  for (let i = 0; i < 6; i++) { x += 0.4; y += 0.9; push(0.9); } // creep back on
  for (const v of [2, 4, 8]) { x += v; push(v); }
  for (let i = 0; i < 25; i++) { x += 15; push(15); }
  const fixes = toLatLon(pts).map(({ lat, lon, t: time, speed, acc }) => ({ lat, lon, t: time, speed, acc }));
  const a = analyzeCourse(fixes);
  assert.equal(a.corners.length, 0, a.corners.map((c) => `${c.dir} ${Math.round(c.angle)}° r${c.radius.toFixed(1)} driven ${c.drivenKmh?.toFixed(1)}`).join(', '));
});

test('corners tighter than a vehicle can turn, or crawled through, are dropped', () => {
  assert.equal(isManoeuvre({ radius: 1, drivenKmh: 2 }), true, 'the rest-stop case: 1 m at 2 km/h');
  assert.equal(isManoeuvre({ radius: 1.5, drivenKmh: null }), true, 'GPS noise even without speed data');
  assert.equal(isManoeuvre({ radius: 5, drivenKmh: 3 }), true, 'turning round at walking pace');
  assert.equal(isManoeuvre({ radius: 5, drivenKmh: 12 }), false, 'a real tight hairpin taken slowly');
  assert.equal(isManoeuvre({ radius: 8, drivenKmh: 2 }), false, 'wider than a manoeuvre');
  assert.equal(isManoeuvre({ radius: 4, drivenKmh: null }), false, 'tight but possible, no speed data');
});
