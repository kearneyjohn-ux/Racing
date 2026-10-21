import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCourse, cornerSpeedKmh, gradeFor, locate, cornersAhead, colourRuns, noteText } from '../js/analysis.js';
import { buildPath, toLatLon, simulateGPS, speedProfile } from '../tools/track-gen.js';

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

test('tight 180° right is a hairpin', () => {
  const a = analyzeCourse(track([{ straight: 150 }, { radius: 10, angle: 180, dir: 'R' }, { straight: 150 }]));
  assert.equal(a.corners.length, 1);
  assert.equal(a.corners[0].dir, 'R');
  assert.equal(a.corners[0].grade, 'H');
  assert.match(noteText(a.corners[0]), /^Right Hairpin/);
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
  assert.equal(gradeFor({ radius: 12, angle: 170 }, { surface: 'gravel' }).grade, 'H');
  assert.equal(gradeFor({ radius: 2000, angle: 20 }, { surface: 'tarmac', topSpeedKmh: 120 }).grade, 'F');
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
