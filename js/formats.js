// Import and export of GPS tracks. Regex-based parsing keeps this DOM-free and testable in node.

import { GRADE, HAZARD_LEVELS, noteText, shortNote } from './analysis.js';

const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1] : undefined;
};
const child = (body, name) => {
  const m = body.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'));
  return m ? m[1].trim() : undefined;
};

export function parseTrackFile(text, filename = '') {
  const ext = filename.split('.').pop().toLowerCase();
  const head = text.trimStart().slice(0, 500);
  let points;
  if (ext === 'gpx' || /<gpx[\s>]/i.test(head)) points = parseGPX(text);
  else if (ext === 'kml' || /<kml[\s>]/i.test(head)) points = parseKML(text);
  else if (ext === 'geojson' || ext === 'json' || head.startsWith('{')) points = parseGeoJSON(text);
  else if (ext === 'nmea' || /^\$G[A-Z]{4},/m.test(head)) points = parseNMEA(text);
  else points = parseCSV(text);
  if (points.length < 3) throw new Error('No track found in that file (need at least 3 points).');
  return points;
}

export function parseGPX(text) {
  const read = (tag) => {
    const out = [];
    const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'gi');
    let m;
    while ((m = re.exec(text))) {
      const body = m[2] ?? '';
      const time = child(body, 'time');
      out.push({
        lat: num(attr(m[1], 'lat')),
        lon: num(attr(m[1], 'lon')),
        ele: num(child(body, 'ele')),
        t: time ? Date.parse(time) : NaN,
        speed: num(child(body, 'speed')),
        acc: num(child(body, 'acc')),
      });
    }
    return out;
  };
  const trk = read('trkpt');
  return trk.length ? trk : read('rtept');
}

export function parseKML(text) {
  // Google-style gx:Track (with timestamps) first.
  const whens = [...text.matchAll(/<when>([^<]+)<\/when>/gi)].map((m) => Date.parse(m[1]));
  const coords = [...text.matchAll(/<gx:coord>([^<]+)<\/gx:coord>/gi)].map((m) => m[1].trim().split(/\s+/).map(Number));
  if (coords.length >= 3) {
    return coords.map(([lon, lat, ele], i) => ({ lat, lon, ele, t: whens.length === coords.length ? whens[i] : NaN }));
  }
  let best = [];
  for (const m of text.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/gi)) {
    const pts = m[1]
      .trim()
      .split(/\s+/)
      .map((tuple) => tuple.split(',').map(Number))
      .filter((a) => a.length >= 2)
      .map(([lon, lat, ele]) => ({ lat, lon, ele, t: NaN }));
    if (pts.length > best.length) best = pts;
  }
  return best;
}

export function parseGeoJSON(text) {
  const gj = JSON.parse(text);
  const lines = [];
  const visit = (g) => {
    if (!g) return;
    if (g.type === 'FeatureCollection') g.features.forEach(visit);
    else if (g.type === 'Feature') {
      if (g.properties?.role === 'corner') return;
      visit(g.geometry);
    } else if (g.type === 'GeometryCollection') g.geometries.forEach(visit);
    else if (g.type === 'LineString') lines.push(g.coordinates);
    else if (g.type === 'MultiLineString') lines.push(g.coordinates.flat());
  };
  visit(gj);
  const best = lines.sort((a, b) => b.length - a.length)[0] ?? [];
  return best.map(([lon, lat, ele]) => ({ lat, lon, ele, t: NaN }));
}

export function parseNMEA(text) {
  const out = [];
  const dm = (v, hemi) => {
    if (!v) return NaN;
    const dot = v.indexOf('.');
    const deg = Number(v.slice(0, dot - 2));
    const min = Number(v.slice(dot - 2));
    const d = deg + min / 60;
    return hemi === 'S' || hemi === 'W' ? -d : d;
  };
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split('*')[0].split(',');
    if (!/^\$G[A-Z]RMC$/.test(f[0]) || f[2] !== 'A') continue;
    const [hh, mm, ss] = [f[1].slice(0, 2), f[1].slice(2, 4), f[1].slice(4)];
    const [d, mo, y] = [f[9].slice(0, 2), f[9].slice(2, 4), f[9].slice(4, 6)];
    out.push({
      lat: dm(f[3], f[4]),
      lon: dm(f[5], f[6]),
      speed: num(f[7]) * 0.514444,
      t: Date.parse(`20${y}-${mo}-${d}T${hh}:${mm}:${ss.padStart(2, '0')}Z`),
    });
  }
  return out;
}

export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const head = lines[0].split(delim).map((h) => h.trim().toLowerCase().replace(/["']/g, ''));
  const find = (...names) => head.findIndex((h) => names.includes(h));
  let iLat = find('lat', 'latitude', 'lat_deg', 'latitude_deg');
  let iLon = find('lon', 'lng', 'long', 'longitude', 'lon_deg', 'longitude_deg');
  const iTime = find('time', 'timestamp', 'datetime', 'utc', 'date_time');
  const iEle = find('ele', 'elevation', 'alt', 'altitude');
  let rows = lines.slice(1);
  if (iLat < 0 || iLon < 0) {
    iLat = 0;
    iLon = 1;
    rows = lines;
  }
  return rows.map((l) => {
    const c = l.split(delim).map((v) => v.trim().replace(/["']/g, ''));
    const t = iTime >= 0 ? c[iTime] : undefined;
    return {
      lat: num(c[iLat]),
      lon: num(c[iLon]),
      ele: iEle >= 0 ? num(c[iEle]) : NaN,
      t: t === undefined ? NaN : /^\d+(\.\d+)?$/.test(t) ? Number(t) * (Number(t) < 1e11 ? 1000 : 1) : Date.parse(t),
    };
  }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

// ---------------------------------------------------------------------------
// Export

const esc = (s) => String(s).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]);
const f7 = (v) => Number(v).toFixed(7);

// GPX 1.1 with the recorded track, plus corners and hazards as waypoints so they show up in
// other GPS apps. Hazard waypoints carry <type>hazard-LEVEL</type> so they can be re-imported.
// `names`: 'full' ("Left 2 tightens") or 'short' ("L2 T"; the full wording moves into the description).
export function toGPX(name, points, { corners = [], hazards = [], fmtSpeed = (k) => `${Math.round(k)} km/h`, names = 'full' } = {}) {
  const wpt = (lat, lon, title, desc, sym, type) =>
    `  <wpt lat="${f7(lat)}" lon="${f7(lon)}"><name>${esc(title)}</name>${desc ? `<desc>${esc(desc)}</desc>` : ''}<sym>${sym}</sym><type>${type}</type></wpt>`;
  const waypoints = [
    ...corners.map((c) => {
      const detail = `${Math.round(c.radius)} m radius, ${Math.round(c.angle)}°, target ${fmtSpeed(c.speedKmh)}`;
      return names === 'short'
        ? wpt(c.lat, c.lon, shortNote(c), `${noteText(c)}: ${detail}`, 'Flag, Blue', `corner-${c.grade}`)
        : wpt(c.lat, c.lon, noteText(c), detail, 'Flag, Blue', `corner-${c.grade}`);
    }),
    ...hazards.map((h) => wpt(h.lat, h.lon, `${HAZARD_LEVELS[h.level].label} hazard`, '', 'Danger Area', `hazard-${h.level}`)),
  ];
  const pts = points
    .map((p) => {
      const ele = Number.isFinite(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : '';
      const time = Number.isFinite(p.t) ? `<time>${new Date(p.t).toISOString()}</time>` : '';
      // Accuracy and speed ride along as extensions (ignored by other apps) so the course
      // analyses the same after it's imported on another phone.
      const ext = [Number.isFinite(p.acc) && `<rcp:acc>${p.acc.toFixed(1)}</rcp:acc>`, Number.isFinite(p.speed) && `<rcp:speed>${p.speed.toFixed(2)}</rcp:speed>`].filter(Boolean).join('');
      return `      <trkpt lat="${f7(p.lat)}" lon="${f7(p.lon)}">${ele}${time}${ext ? `<extensions>${ext}</extensions>` : ''}</trkpt>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Race Course Plotter" xmlns="http://www.topografix.com/GPX/1/1" xmlns:rcp="https://kearneyjohn-ux.github.io/Racing/gpx/1">
  <metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>
${waypoints.join('\n')}${waypoints.length ? '\n' : ''}  <trk><name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

// Hazards saved by toGPX (waypoints typed hazard-green / hazard-orange / hazard-red).
export function parseGPXHazards(text) {
  const out = [];
  for (const m of text.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/gi)) {
    const level = (child(m[2], 'type') ?? '').match(/^hazard-(green|orange|red)$/)?.[1];
    if (level) out.push({ lat: num(attr(m[1], 'lat')), lon: num(attr(m[1], 'lon')), level });
  }
  return out.filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon));
}

export function toGeoJSON(name, analysis, runs, hazards = []) {
  const features = [
    {
      type: 'Feature',
      properties: { name, role: 'course', length_m: Math.round(analysis.length), loop: analysis.closed },
      geometry: { type: 'LineString', coordinates: analysis.samples.map((p) => [+f7(p.lon), +f7(p.lat)]) },
    },
  ];
  for (const r of runs) {
    if (!r.corner) continue;
    const c = r.corner;
    features.push({
      type: 'Feature',
      properties: {
        role: 'corner',
        number: c.number,
        note: noteText(c),
        grade: c.grade,
        direction: c.dir,
        radius_m: Math.round(c.radius),
        angle_deg: Math.round(c.angle),
        speed_kmh: Math.round(c.speedKmh),
        stroke: GRADE[c.grade].color,
        'stroke-width': 6,
      },
      geometry: { type: 'LineString', coordinates: r.latlngs.map(([lat, lon]) => [+f7(lon), +f7(lat)]) },
    });
  }
  for (const h of hazards) {
    features.push({
      type: 'Feature',
      properties: { role: 'hazard', level: h.level, distance_m: Math.round(h.s), 'marker-color': HAZARD_LEVELS[h.level].color, 'marker-symbol': 'caution' },
      geometry: { type: 'Point', coordinates: [+f7(h.lon), +f7(h.lat)] },
    });
  }
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 1);
}

// KML colours are aabbggrr.
const kmlColour = (hex) => `ff${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`;

export function toKML(name, analysis, runs, fmtSpeed = (k) => `${Math.round(k)} km/h`, hazards = []) {
  const styles = Object.values(GRADE)
    .map((g) => `<Style id="g${g.id}"><LineStyle><color>${kmlColour(g.color)}</color><width>6</width></LineStyle></Style>`)
    .join('\n');
  const coords = (ll) => ll.map(([lat, lon]) => `${f7(lon)},${f7(lat)},0`).join(' ');
  const placemarks = runs
    .map((r) => {
      if (!r.corner) {
        return `<Placemark><styleUrl>#straight</styleUrl><LineString><tessellate>1</tessellate><coordinates>${coords(r.latlngs)}</coordinates></LineString></Placemark>`;
      }
      const c = r.corner;
      return `<Placemark><name>${esc(noteText(c))}</name><description>${Math.round(c.radius)} m radius, ${Math.round(c.angle)}°, ~${esc(fmtSpeed(c.speedKmh))}</description><styleUrl>#g${c.grade}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${coords(r.latlngs)}</coordinates></LineString></Placemark>`;
    })
    .join('\n');
  const hazardStyles = Object.entries(HAZARD_LEVELS)
    .map(([id, l]) => `<Style id="hz-${id}"><IconStyle><color>${kmlColour(l.color)}</color><Icon><href>https://maps.google.com/mapfiles/kml/shapes/caution.png</href></Icon></IconStyle></Style>`)
    .join('\n');
  const hazardMarks = hazards
    .map((h) => `<Placemark><name>${HAZARD_LEVELS[h.level].label} hazard</name><styleUrl>#hz-${h.level}</styleUrl><Point><coordinates>${f7(h.lon)},${f7(h.lat)},0</coordinates></Point></Placemark>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>
<Style id="straight"><LineStyle><color>ffffffff</color><width>4</width></LineStyle></Style>
${styles}
${hazardStyles}
${placemarks}
${hazardMarks}
</Document></kml>
`;
}

export function toPaceNotesCSV(analysis, fmtSpeed = (k) => Math.round(k), hazards = []) {
  const rows = [['#', 'note', 'grade', 'direction', 'distance_m', 'radius_m', 'angle_deg', 'target_speed', 'driven_speed', 'lat', 'lon']];
  for (const c of analysis.corners) {
    rows.push([
      c.number,
      `"${noteText(c).replace(/"/g, "'")}"`,
      c.grade,
      c.dir,
      Math.round(c.startS),
      Math.round(c.radius),
      Math.round(c.angle),
      fmtSpeed(c.speedKmh),
      c.drivenKmh === null ? '' : fmtSpeed(c.drivenKmh),
      f7(c.lat),
      f7(c.lon),
    ]);
  }
  for (const h of hazards) {
    rows.push(['hazard', `${HAZARD_LEVELS[h.level].label} hazard`, h.level, '', Math.round(h.s), '', '', '', '', f7(h.lat), f7(h.lon)]);
  }
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}
