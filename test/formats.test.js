import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrackFile, parseGPXHazards, toGPX, toKML, toGeoJSON, toPaceNotesCSV } from '../js/formats.js';
import { analyzeCourse, colourRuns, placeHazards } from '../js/analysis.js';
import { buildPath, toLatLon } from '../tools/track-gen.js';

const gpx = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
<trkpt lat="52.1" lon="-7.1"><ele>10</ele><time>2026-10-01T10:00:00Z</time></trkpt>
<trkpt lon="-7.1001" lat="52.1001"><time>2026-10-01T10:00:01Z</time></trkpt>
<trkpt lat="52.1002" lon="-7.1002"/>
</trkseg></trk></gpx>`;

test('GPX with mixed attribute order and self-closing points', () => {
  const pts = parseTrackFile(gpx, 'lap.gpx');
  assert.equal(pts.length, 3);
  assert.deepEqual([pts[1].lat, pts[1].lon], [52.1001, -7.1001]);
  assert.equal(pts[0].ele, 10);
  assert.equal(pts[1].t - pts[0].t, 1000);
});

test('KML LineString', () => {
  const kml = `<kml><Document><Placemark><Point><coordinates>-7,52,0</coordinates></Point></Placemark>
  <Placemark><LineString><coordinates>-7.1,52.1,0 -7.1001,52.1001,0
  -7.1002,52.1002,0</coordinates></LineString></Placemark></Document></kml>`;
  const pts = parseTrackFile(kml, 'x.kml');
  assert.equal(pts.length, 3);
  assert.equal(pts[2].lat, 52.1002);
});

test('CSV with header and ISO times', () => {
  const csv = 'time;Latitude;Longitude\n2026-10-01T10:00:00Z;52.1;-7.1\n2026-10-01T10:00:01Z;52.1001;-7.1001\n2026-10-01T10:00:02Z;52.1002;-7.1002\n';
  const pts = parseTrackFile(csv, 'log.csv');
  assert.equal(pts.length, 3);
  assert.equal(pts[2].lon, -7.1002);
  assert.equal(pts[1].t - pts[0].t, 1000);
});

test('NMEA RMC sentences', () => {
  const nmea = [
    '$GPRMC,100000.00,A,5206.0000,N,00706.0000,W,20.0,0.0,011026,,,A*00',
    '$GPGGA,100000.00,5206.0000,N,00706.0000,W,1,08,0.9,10.0,M,,,,*00',
    '$GPRMC,100000.10,A,5206.0010,N,00706.0010,W,20.0,0.0,011026,,,A*00',
    '$GPRMC,100000.20,A,5206.0020,N,00706.0020,W,20.0,0.0,011026,,,A*00',
  ].join('\n');
  const pts = parseTrackFile(nmea, 'log.nmea');
  assert.equal(pts.length, 3);
  assert.ok(Math.abs(pts[0].lat - 52.1) < 1e-9);
  assert.ok(Math.abs(pts[0].lon + 7.1) < 1e-9);
  assert.equal(pts[1].t - pts[0].t, 100);
  assert.ok(Math.abs(pts[0].speed - 10.29) < 0.01);
});

test('exports round-trip and carry corner colours', () => {
  const pts = toLatLon(buildPath([{ straight: 200 }, { radius: 30, angle: 90, dir: 'L' }, { straight: 200 }]));
  const a = analyzeCourse(pts);
  const runs = colourRuns(a);
  const hz = placeHazards(a, [{ lat: a.samples[100].lat, lon: a.samples[100].lon, level: 'red' }]);
  assert.ok(parseTrackFile(toGPX('Test <1>', pts), 'a.gpx').length > 100);
  const gj = toGeoJSON('Test', a, runs, hz);
  assert.match(gj, /"role": "hazard"/);
  assert.equal(parseTrackFile(gj, 'a.geojson').length, a.samples.length);
  assert.match(gj, /"stroke": "#/);
  const kml = toKML('Test', a, runs, undefined, hz);
  assert.match(kml, /<styleUrl>#g\w<\/styleUrl>/);
  assert.match(kml, /<styleUrl>#hz-red<\/styleUrl>/);
  const csv = toPaceNotesCSV(a, undefined, hz).trim().split('\n');
  assert.equal(csv.length, 3);
  assert.match(csv[2], /^hazard,Red hazard,red,/);
  assert.match(csv[1], /^1,"Left \d/);
});

test('GPX export carries corners and hazards, and hazards re-import', () => {
  const pts = toLatLon(buildPath([{ straight: 200 }, { radius: 30, angle: 90, dir: 'L' }, { straight: 200 }])).map((p, i) => ({ ...p, t: Date.UTC(2026, 9, 1) + i * 100 }));
  const a = analyzeCourse(pts);
  const hazards = [{ lat: a.samples[50].lat, lon: a.samples[50].lon, level: 'orange' }];
  const gpx = toGPX('Lap <1>', pts, { corners: a.corners, hazards });
  assert.match(gpx, /<wpt [^>]+><name>Left \d[^<]*<\/name><desc>\d+ m radius/);
  assert.doesNotMatch(gpx, /<name>\d+\./, "corner waypoints carry no sequence numbers");
  assert.match(gpx, /<type>hazard-orange<\/type>/);
  assert.ok(gpx.indexOf('<wpt') < gpx.indexOf('<trk>'), 'waypoints come before the track (GPX 1.1 order)');
  assert.match(gpx, /<name>Lap &lt;1&gt;<\/name>/);
  // Re-import: the track is unchanged by the waypoints, and the hazard comes back.
  const back = parseTrackFile(gpx, 'lap.gpx');
  assert.equal(back.length, pts.length);
  assert.ok(Number.isFinite(back[0].t));
  const hz = parseGPXHazards(gpx);
  assert.equal(hz.length, 1);
  assert.equal(hz[0].level, 'orange');
  assert.ok(Math.abs(hz[0].lat - hazards[0].lat) < 1e-6);
});

test('GPX short waypoint names', () => {
  const pts = toLatLon(
    buildPath([{ straight: 150 }, { radius: 60, angle: 45, dir: 'R' }, { radius: 20, angle: 70, dir: 'R' }, { straight: 150 }, { radius: 10, angle: 180, dir: 'L' }, { straight: 150 }]),
  );
  const a = analyzeCourse(pts);
  const gpx = toGPX('Short', pts, { corners: a.corners, names: 'short' });
  const names = [...gpx.matchAll(/<wpt[^>]*><name>([^<]*)<\/name>/g)].map((m) => m[1]);
  assert.deepEqual(names, ['R2 LG T', 'L1 HP']);
  assert.match(gpx, /<desc>Right 2 long tightens: \d+ m radius/, 'full wording kept in the description');
  // Full names remain the default.
  assert.match(toGPX('Full', pts, { corners: a.corners }), /<name>Right 2 long tightens<\/name>/);
});

test('GPX keeps GPS accuracy and speed so another phone analyses the course the same way', () => {
  const pts = [
    { lat: 52.1, lon: -7.1, t: Date.UTC(2026, 9, 1), acc: 48.5, speed: 0 },
    { lat: 52.1001, lon: -7.1001, t: Date.UTC(2026, 9, 1) + 1000, acc: 4.2, speed: 13.37 },
    { lat: 52.1002, lon: -7.1002, t: Date.UTC(2026, 9, 1) + 2000 },
  ];
  const gpx = toGPX('Acc', pts);
  assert.match(gpx, /xmlns:rcp="/);
  const back = parseTrackFile(gpx, 'a.gpx');
  assert.deepEqual(back.map((p) => p.acc), [48.5, 4.2, NaN]);
  assert.deepEqual(back.map((p) => p.speed), [0, 13.37, NaN]);
});
