import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrackFile, toGPX, toKML, toGeoJSON, toPaceNotesCSV } from '../js/formats.js';
import { analyzeCourse, colourRuns } from '../js/analysis.js';
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
  assert.ok(parseTrackFile(toGPX('Test <1>', pts), 'a.gpx').length > 100);
  const gj = toGeoJSON('Test', a, runs);
  assert.equal(parseTrackFile(gj, 'a.geojson').length, a.samples.length);
  assert.match(gj, /"stroke": "#/);
  const kml = toKML('Test', a, runs);
  assert.match(kml, /<styleUrl>#g\w<\/styleUrl>/);
  const csv = toPaceNotesCSV(a).trim().split('\n');
  assert.equal(csv.length, 2);
  assert.match(csv[1], /^1,"Left \d/);
});
