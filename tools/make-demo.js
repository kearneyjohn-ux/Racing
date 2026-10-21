// Generates samples/demo-course.gpx: a ~2.7 km off-road loop "recorded" with 1 Hz phone-grade GPS.
// Run with: npm run demo

import { writeFileSync } from 'node:fs';
import { buildPath, speedProfile, simulateGPS, toLatLon } from './track-gen.js';
import { toGPX } from '../js/formats.js';

const layout = (closeY, closeX) => [
  { straight: 130 },
  { radius: 40, angle: 90, dir: 'L' },
  { straight: 150 + closeY },
  { radius: 60, angle: 45, dir: 'R' },
  { radius: 30, angle: 70, dir: 'L' },
  { straight: 120 },
  { radius: 11, angle: 170, dir: 'L' },
  { straight: 160 },
  { radius: 25, angle: 100, dir: 'R' },
  { straight: 90 },
  { radius: 80, angle: 60, dir: 'L' },
  { straight: 200 },
  { radius: 18, angle: 80, dir: 'R' },
  { radius: 18, angle: 80, dir: 'L' },
  { straight: 140 },
  { radius: 130, angle: 40, dir: 'L' },
  { straight: 220 },
  { radius: 45, angle: 75, dir: 'L' },
  { straight: closeX },
];

// Straight 3 runs due north and the last straight due east, so they close the loop exactly.
const probe = buildPath(layout(0, 0)).at(-1);
const parts = layout(-probe.y, -probe.x);
if (-probe.x < 50 || 150 - probe.y < 50) throw new Error(`layout does not close nicely: ${probe.x}, ${probe.y}`);

// One lap plus a little extra, like stopping the recording just after the line.
const lap = buildPath([...parts, { straight: 60 }]);
const speeds = speedProfile(lap, { mu: 0.5, vmax: 22 });
const fixes = toLatLon(simulateGPS(lap, speeds, { hz: 1, noise: 1.5, seed: 11 }), { lat0: 53.2905, lon0: -7.0575 });
const points = fixes.map(({ lat, lon, t }) => ({ lat, lon, t }));
writeFileSync(new URL('../samples/demo-course.gpx', import.meta.url), toGPX('Demo off-road loop', points));
console.log(`wrote ${points.length} fixes`);
