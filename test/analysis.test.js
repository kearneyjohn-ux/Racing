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
  dropStrayEnds,
  parseCornerCall,
  compareWithCalls,
  learnGradeRadii,
  bestGrip,
  gradeFor as gradeForOpts,
  physicsGradeRadii,
  compareTracks,
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
    // A few fixes without times (like a gap filled in by joining) must not disable stop detection.
    const pts = trackWithStop({ withSpeed }).map((p, i) => (i > 160 ? { ...p, t: NaN } : p));
    const a = analyzeCourse(pts);
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
  // KDR2026 at 70.39 km: a "45° right" crawled at 0.7 km/h where the road only turns 13°.
  assert.equal(isManoeuvre({ radius: 11.8, angle: 45, netTurn: 13, drivenKmh: 0.7 }), true, 'wobble at a stop');
  assert.equal(isManoeuvre({ radius: 12, angle: 90, netTurn: 85, drivenKmh: 0.7 }), false, 'a real bend you happened to stop in');
  assert.equal(isManoeuvre({ radius: 12, angle: 45, netTurn: 13, drivenKmh: 30 }), false, 'only applies at walking pace');
});

test('net turn matches a real corner and is small for a straight', () => {
  const a = analyzeCourse(track([{ straight: 200 }, { radius: 30, angle: 90, dir: 'L' }, { straight: 200 }]));
  near(a.corners[0].netTurn, 90, 8, 'net turn of a 90° corner');
});

// KDR Prologue: the recording began with a 5-minute-old fix and a glitch 830 m away, which moved
// the "start" and made the 20 km loop look like a 1.7 km lap.
test('stray fixes at the start of a recording are ignored', () => {
  const lap = toLatLon(buildPath(rectangle, { step: 2 })).map((p, i) => ({ lat: p.lat, lon: p.lon, t: Date.UTC(2026, 9, 1, 10) + i * 1000 }));
  const t0 = lap[0].t;
  const stale = { lat: lap[0].lat + 0.00005, lon: lap[0].lon, t: t0 - 300000 }; // 5 min earlier, ~5 m off
  const glitch = { lat: lap[0].lat - 0.0065, lon: lap[0].lon + 0.0049, t: t0 - 9000 }; // ~830 m away
  const waiting = Array.from({ length: 8 }, (_, i) => ({ lat: lap[0].lat, lon: lap[0].lon, t: t0 - 8000 + i * 1000 }));
  const pts = [stale, glitch, ...waiting, ...lap.slice(1)];
  assert.equal(dropStrayEnds(pts)[0], waiting[0], 'starts from the first good fix');
  const a = analyzeCourse(pts);
  assert.equal(a.closed, true);
  assert.equal(a.corners.length, 4);
  near(a.length, 900 + 4 * (20 * Math.PI) / 2, 40, 'full lap length');
});

test('a course that passes its own start and carries on is not cut short', () => {
  // Round the rectangle back through the start, then turn off and drive somewhere else.
  const pts = track([...rectangle, { radius: 20, angle: 90, dir: 'R' }, { straight: 800 }]);
  const a = analyzeCourse(pts);
  assert.equal(a.trimmed, false);
  assert.ok(a.length > 1800, `length ${a.length}`);
});

test('corner calls are read from waypoint names in common formats', () => {
  const cases = {
    L3: ['L', 3], 'R 2': ['R', 2], 'Left 4 tightens': ['L', 4], '3R': ['R', 3], 'right-5': ['R', 5], 'l1hp': ['L', 1],
    'L HP': ['L', 1], 'R2 LG T': ['R', 2], '376. Left 1 hairpin tightens': ['L', 1], 'K L 6': ['L', 6],
  };
  for (const [name, [dir, grade]] of Object.entries(cases)) {
    const c = parseCornerCall(name);
    assert.ok(c, `parsed ${name}`);
    assert.deepEqual([c.dir, c.grade], [dir, grade], name);
  }
  for (const name of ['Jump', 'Caution', 'KL', 'Red hazard', 'WP 12', 'Start']) assert.equal(parseCornerCall(name), null, name);
});

test('grade limits are learned from hand-logged grades', () => {
  const pairs = [[8, 1], [15, 1], [22, 2], [30, 2], [45, 3], [60, 3], [90, 4], [120, 4], [200, 5]].map(([radius, grade]) => ({ radius, grade }));
  const { radii, agreement } = learnGradeRadii(pairs);
  assert.equal(agreement, 1);
  near(radii[0], Math.sqrt(15 * 22), 0.2, 'limit 1|2');
  near(radii[3], Math.sqrt(120 * 200), 0.2, 'limit 4|5');
  assert.equal(gradeForOpts({ radius: 50, angle: 40 }, { gradeRadii: radii }).grade, '3');
  // A noisy log still gives increasing limits.
  const noisy = learnGradeRadii([...pairs, { radius: 25, grade: 4 }, { radius: 100, grade: 2 }]);
  assert.ok(noisy.radii.every((r, i) => i === 0 || r > noisy.radii[i - 1]));
});

test('the best grip setting is found from hand-logged grades', () => {
  const opts = { surface: 'gravel', confidence: 0.6 };
  const pairs = [10, 18, 25, 40, 55, 70, 110, 160].map((radius) => ({ radius, grade: Number(gradeForOpts({ radius, angle: 0 }, opts).grade) }));
  const best = bestGrip(pairs, { surface: 'gravel', confidence: 0.8 });
  assert.equal(best.agreement, 1);
  assert.ok(Math.abs(best.confidence - 0.6) <= 0.06, `grip ${best.confidence}`);
});

test('truck calls are matched to app corners, with misses, extras and disagreements', () => {
  const parts = [
    { straight: 200 }, { radius: 15, angle: 90, dir: 'L' }, // app: 1
    { straight: 200 }, { radius: 40, angle: 70, dir: 'R' }, // app: 2
    { straight: 200 }, { radius: 90, angle: 50, dir: 'L' }, // app: 4
    { straight: 300 },
  ];
  const a = analyzeCourse(track(parts));
  assert.equal(a.corners.length, 3);
  const at = (c) => ({ lat: c.lat, lon: c.lon });
  const [c1, c2, c3] = a.corners;
  const straightPoint = a.samples[Math.round(c3.endIdx + 150 / a.ds)];
  const calls = [
    { ...at(c1), dir: 'L', grade: Number(c1.grade), name: 'agrees' },
    { ...at(c2), dir: 'R', grade: Number(c2.grade) + 1, name: 'truck says faster' },
    { lat: straightPoint.lat, lon: straightPoint.lon, dir: 'R', grade: 5, name: 'not seen by the app' },
  ];
  const r = compareWithCalls(a, calls);
  assert.equal(r.matches.length, 2);
  assert.equal(r.exact, 1);
  assert.equal(r.matches[1].gradeDiff, -1, 'app one grade slower than the truck');
  assert.equal(r.missed.length, 1);
  assert.equal(r.extra.length, 1);
  assert.equal(r.extra[0], c3);
});

test('learning from a truck log brings the app in line with it', () => {
  // The truck crew grade by radius with their own limits (10/20/40/80 m).
  const truckGrade = (r) => 1 + [10, 20, 40, 80].filter((t) => r >= t).length;
  const radii = [8, 14, 18, 26, 33, 45, 60, 75, 95, 130];
  const parts = [{ straight: 200 }];
  radii.forEach((radius, i) => parts.push({ radius, angle: 60, dir: i % 2 ? 'R' : 'L' }, { straight: 200 }));
  const a = analyzeCourse(track(parts));
  const calls = a.corners.map((c, i) => ({ lat: c.lat, lon: c.lon, dir: c.dir, grade: truckGrade(radii[i]) }));
  const before = compareWithCalls(a, calls);
  const { radii: learned } = learnGradeRadii(before.matches.map((m) => ({ radius: m.corner.radius, grade: m.call.grade })));
  const after = compareWithCalls(analyzeCourse(track(parts), { gradeRadii: learned }), calls);
  assert.ok(after.exact > before.exact, `exact ${before.exact} -> ${after.exact}`);
  assert.ok(after.exact >= 9, `after learning ${after.exact}/10 agree`);
});

test('two recordings of the same course are compared corner by corner', () => {
  const a = analyzeCourse(track(rectangle));
  const b = analyzeCourse(track(rectangle), { smoothing: 8 });
  const r = compareTracks(a, b);
  assert.equal(r.pairs.length, 4);
  assert.ok(r.medianRatio > 0.7 && r.medianRatio < 1.3);
  assert.ok(physicsGradeRadii().every((v, i, arr) => i === 0 || v > arr[i - 1]));
});
