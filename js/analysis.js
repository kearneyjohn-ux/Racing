// Course geometry, corner detection and corner rating.
// Pure functions only (no DOM) so the same code runs in the browser and under `node --test`.

export const G = 9.80665;
const EARTH_R = 6371008.8;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// Typical usable lateral grip (friction coefficient) for road-legal / rally tyres.
export const SURFACES = {
  tarmac: { label: 'Tarmac / concrete', mu: 0.85 },
  hardpack: { label: 'Hard-packed dirt', mu: 0.65 },
  gravel: { label: 'Loose gravel', mu: 0.55 },
  grass: { label: 'Dry grass', mu: 0.45 },
  sand: { label: 'Sand', mu: 0.4 },
  mud: { label: 'Wet grass / mud', mu: 0.3 },
  snow: { label: 'Snow', mu: 0.22 },
};

// Pace-note grades, 1 (slowest) to 5 (fastest), chosen by estimated corner speed.
export const GRADES = [
  { id: '1', name: '1', maxKmh: 30, color: '#d73027', ink: '#fff' },
  { id: '2', name: '2', maxKmh: 45, color: '#fc8d59', ink: '#1b1b1b' },
  { id: '3', name: '3', maxKmh: 65, color: '#fee08b', ink: '#1b1b1b' },
  { id: '4', name: '4', maxKmh: 90, color: '#91cf60', ink: '#1b1b1b' },
  { id: '5', name: '5', maxKmh: Infinity, color: '#1a9850', ink: '#fff' },
];
export const GRADE = Object.fromEntries(GRADES.map((g) => [g.id, g]));

export const DEFAULTS = {
  surface: 'gravel',
  confidence: 0.8, // share of the available grip you are prepared to use
  topSpeedKmh: 140, // target speeds are capped at the vehicle's top speed
  smoothing: 5, // metres; gaussian sigma applied to the GPS trace
  curvatureWindow: 8, // metres over which heading change is measured
  straightRadius: 150, // bends gentler than this radius count as straight
  minAngle: 15, // degrees a bend must turn to be called a corner
  mergeGap: 12, // metres; same-direction pieces closer than this become one corner
  intoGap: 30, // metres; corners closer than this are called "into"
  hairpinAngle: 135,
  hairpinRadius: 20,
  courseType: 'auto', // auto | loop | open
  reverse: false,
  spacing: 1, // resample spacing in metres
  maxAccuracy: 30, // drop GPS fixes reporting worse accuracy than this (metres)
  overrides: [],
};

// ---------------------------------------------------------------------------
// Small geometry helpers

export function makeProjection(lat0, lon0) {
  const k = EARTH_R * D2R;
  const c = Math.cos(lat0 * D2R);
  return {
    toXY: (lat, lon) => [(lon - lon0) * k * c, (lat - lat0) * k],
    toLatLon: (x, y) => [lat0 + y / k, lon0 + x / (k * c)],
  };
}

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const mod = (a, n) => ((a % n) + n) % n;

// ---------------------------------------------------------------------------
// Physics

export function cornerSpeedKmh(radius, opts = DEFAULTS) {
  const mu = (SURFACES[opts.surface]?.mu ?? SURFACES.gravel.mu) * (opts.confidence ?? DEFAULTS.confidence);
  return Math.sqrt(mu * G * radius) * 3.6;
}

export function gradeFor({ radius, angle }, opts = DEFAULTS) {
  const o = { ...DEFAULTS, ...opts };
  const speedKmh = Math.min(cornerSpeedKmh(radius, o), o.topSpeedKmh);
  const g = GRADES.find((gr) => speedKmh < gr.maxKmh);
  return { grade: g.id, speedKmh, hairpin: angle >= o.hairpinAngle && radius <= o.hairpinRadius };
}

// ---------------------------------------------------------------------------
// Track preparation

export function cleanPoints(points, opts = DEFAULTS) {
  const out = [];
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) continue;
    if (Number.isFinite(p.acc) && p.acc > opts.maxAccuracy) continue;
    const prev = out.at(-1);
    if (prev) {
      const d = haversine(prev, p);
      if (d < 0.5) continue; // stationary jitter
      if (Number.isFinite(p.t) && Number.isFinite(prev.t)) {
        const dt = Math.abs(p.t - prev.t) / 1000;
        if (dt > 0 && d / dt > 90) continue; // > 320 km/h: a GPS glitch
      }
    }
    out.push(p);
  }
  return collapseStops(out);
}

// While the vehicle is parked the GPS keeps wandering a few metres, which looks like a tight
// tangle of turns. Treat as stopped any fix where the GPS reports (almost) no speed, or where the
// vehicle moved less than STOP_RADIUS over STOP_SECONDS, and keep one fix per stop.
const STOP_SECONDS = 10;
const STOP_RADIUS = 8; // metres
const STOP_SPEED = 0.5; // m/s reported by the GPS

export function collapseStops(pts) {
  const n = pts.length;
  const stopped = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (Number.isFinite(pts[i].speed) && pts[i].speed < STOP_SPEED) stopped[i] = 1;
  // Only fixes with a time take part, so a stretch without times (e.g. a gap filled in when two
  // recordings were joined) doesn't switch stop detection off for the whole course.
  const timed = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(pts[i].t)) timed.push(i);
  if (timed.length >= 2) {
    let b = 0;
    for (let a = 0; a < timed.length; a++) {
      b = Math.max(b, a);
      const ta = pts[timed[a]].t;
      while (b < timed.length - 1 && Math.abs(pts[timed[b]].t - ta) < STOP_SECONDS * 1000) b++;
      const i = timed[a];
      const j = timed[b];
      if (Math.abs(pts[j].t - ta) >= STOP_SECONDS * 1000 && haversine(pts[i], pts[j]) < STOP_RADIUS) {
        for (let k = a; k <= b; k++) stopped[timed[k]] = 1;
      }
    }
  } else {
    // No times (some imported files): just ignore fixes that barely moved from the last one kept.
    const kept = [];
    for (const p of pts) if (!kept.length || haversine(kept.at(-1), p) >= 2) kept.push(p);
    return kept;
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (stopped[i] && i > 0 && stopped[i - 1]) continue; // keep only where each stop begins
    out.push(pts[i]);
  }
  return out;
}

function startHeading(xy) {
  let j = 1;
  while (j < xy.length - 1 && dist(xy[0], xy[j]) < 10) j++;
  return Math.atan2(xy[j][1] - xy[0][1], xy[j][0] - xy[0][0]);
}

function endHeading(xy) {
  const last = xy.at(-1);
  let j = xy.length - 2;
  while (j > 0 && dist(last, xy[j]) < 10) j--;
  return Math.atan2(last[1] - xy[j][1], last[0] - xy[j][0]);
}

// If the recording covers more than one lap, return the index where the first lap ends.
function findLapEnd(xy) {
  const start = xy[0];
  const startDir = startHeading(xy);
  let cum = 0;
  let best = -1;
  let bestD = Infinity;
  for (let i = 1; i < xy.length; i++) {
    cum += dist(xy[i - 1], xy[i]);
    if (cum < 200) continue;
    const d0 = dist(xy[i], start);
    const dir = Math.atan2(xy[i][1] - xy[i - 1][1], xy[i][0] - xy[i - 1][0]);
    const sameWay = Math.abs(wrapAngle(dir - startDir)) < Math.PI / 3;
    if (d0 < 25 && sameWay) {
      if (d0 < bestD) {
        bestD = d0;
        best = i;
      }
    } else if (best >= 0 && d0 >= 25) {
      return best;
    }
  }
  return best;
}

function resample(xy, channels, step, closed) {
  const pts = closed ? [...xy, xy[0]] : xy;
  const ch = channels.map((c) => (closed ? [...c, NaN] : c));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = cum.at(-1);
  const n = closed ? Math.max(8, Math.round(total / step)) : Math.floor(total / step) + 1;
  const ds = closed ? total / n : step;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const outCh = channels.map(() => new Float64Array(n));
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const s = k * ds;
    while (seg < pts.length - 2 && cum[seg + 1] < s) seg++;
    const len = cum[seg + 1] - cum[seg];
    const f = len > 0 ? Math.min(1, Math.max(0, (s - cum[seg]) / len)) : 0;
    x[k] = pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * f;
    y[k] = pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * f;
    ch.forEach((c, ci) => {
      outCh[ci][k] = c[seg] + (c[seg + 1] - c[seg]) * f;
    });
  }
  return { x, y, channels: outCh, ds, total };
}

// Gaussian smoothing with a per-sample sigma (in samples).
function gaussianSmooth(arr, sigmas, closed) {
  const n = arr.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const sigma = sigmas[i];
    if (sigma <= 0.3) {
      out[i] = arr[i];
      continue;
    }
    let r = Math.ceil(3 * sigma);
    if (closed) r = Math.min(r, Math.floor((n - 1) / 2));
    let sum = 0;
    let wsum = 0;
    for (let j = -r; j <= r; j++) {
      let idx = i + j;
      if (closed) idx = mod(idx, n);
      else if (idx < 0 || idx >= n) continue;
      const w = Math.exp(-(j * j) / (2 * sigma * sigma));
      sum += arr[idx] * w;
      wsum += w;
    }
    out[i] = sum / wsum;
  }
  return out;
}

// Signed curvature (1/m, positive = left) from heading change over a window.
function curvature(x, y, closed, halfWindow) {
  const n = x.length;
  const m = closed ? n : n - 1; // number of segments
  const heading = new Float64Array(m);
  const segLen = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    const a = j;
    const b = (j + 1) % n;
    heading[j] = Math.atan2(y[b] - y[a], x[b] - x[a]);
    segLen[j] = Math.hypot(x[b] - x[a], y[b] - y[a]);
  }
  // turn[i] = heading change at vertex i (between segment i-1 and segment i)
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    turn[i] = wrapAngle(heading[i % m] - heading[mod(i - 1, m)]);
  }
  const k = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let lo = i - halfWindow;
    let hi = i + halfWindow;
    if (!closed) {
      lo = Math.max(lo, 0);
      hi = Math.min(hi, n - 1);
    }
    let ang = 0;
    for (let v = lo + 1; v <= hi - 1; v++) ang += turn[mod(v, n)];
    let len = 0;
    for (let sgi = lo; sgi < hi; sgi++) {
      const L = segLen[mod(sgi, m)];
      len += sgi === lo || sgi === hi - 1 ? L / 2 : L;
    }
    k[i] = len > 0 ? ang / len : 0;
  }
  return { k, turn };
}

// ---------------------------------------------------------------------------
// Corner detection

const meanAbsK = (k, list) => list.reduce((s, i) => s + Math.abs(k[i]), 0) / Math.max(1, list.length);

function detectCorners(k, turn, closed, o, ds) {
  const n = k.length;
  const enter = 1 / o.straightRadius;
  const exit = enter * 0.6;
  // On a loop, start scanning on the straightest sample so no corner is split at the seam.
  let first = 0;
  if (closed) {
    let m = Infinity;
    for (let i = 0; i < n; i++) {
      if (Math.abs(k[i]) < m) {
        m = Math.abs(k[i]);
        first = i;
      }
    }
  }
  const at = (p) => (first + p) % n;

  const pieces = [];
  let cur = null;
  for (let p = 0; p < n; p++) {
    const ki = k[at(p)];
    const sgn = Math.sign(ki);
    if (cur) {
      if (sgn === cur.dir && Math.abs(ki) > exit) {
        cur.end = p;
        continue;
      }
      pieces.push(cur);
      cur = null;
    }
    if (Math.abs(ki) > enter) cur = { dir: sgn, start: p, end: p };
  }
  if (cur) pieces.push(cur);

  const gapMax = Math.round(o.mergeGap / ds);
  const merged = [];
  for (const pc of pieces) {
    const last = merged.at(-1);
    if (last && last.dir === pc.dir && pc.start - last.end <= gapMax) last.end = pc.end;
    else merged.push({ ...pc });
  }

  const corners = [];
  for (const pc of merged) {
    const idx = [];
    for (let p = pc.start; p <= pc.end; p++) idx.push(at(p));
    let ang = 0;
    let apex = idx[0];
    for (const i of idx) {
      ang += turn[i];
      if (Math.abs(k[i]) > Math.abs(k[apex])) apex = i;
    }
    const angle = Math.abs(ang) * R2D;
    if (angle < o.minAngle) continue;
    // Radius from the mean curvature of the corner's core (>= 70% of peak): the peak alone
    // is pulled tight by GPS noise.
    const peak = Math.abs(k[apex]);
    const ap = idx.indexOf(apex);
    let lo = ap;
    let hi = ap;
    while (lo > 0 && Math.abs(k[idx[lo - 1]]) >= 0.7 * peak) lo--;
    while (hi < idx.length - 1 && Math.abs(k[idx[hi + 1]]) >= 0.7 * peak) hi++;
    const coreK = meanAbsK(k, idx.slice(lo, hi + 1));
    const half = Math.floor(idx.length / 2);
    const entryK = meanAbsK(k, idx.slice(0, half));
    const exitK = meanAbsK(k, idx.slice(half));
    corners.push({
      dir: pc.dir > 0 ? 'L' : 'R',
      indices: idx,
      startIdx: idx[0],
      endIdx: idx.at(-1),
      apexIdx: apex,
      angle,
      radius: 1 / coreK,
      length: (idx.length - 1) * ds,
      tightens: exitK > entryK * 1.35,
      opens: entryK > exitK * 1.35,
    });
  }
  corners.sort((a, b) => a.startIdx - b.startIdx);
  return corners;
}

// ---------------------------------------------------------------------------
// Main entry point

export function analyzeCourse(rawPoints, options = {}) {
  const o = { ...DEFAULTS, ...options };
  let pts = cleanPoints(rawPoints, o);
  if (pts.length < 3) throw new Error('Need at least 3 good GPS points to analyse a course.');

  const proj = makeProjection(pts[0].lat, pts[0].lon);
  let xy = pts.map((p) => proj.toXY(p.lat, p.lon));

  let closed = o.courseType === 'loop';
  let trimmed = false;
  if (o.courseType !== 'open') {
    const lapEnd = findLapEnd(xy);
    if (lapEnd > 0) {
      closed = true;
      trimmed = lapEnd < xy.length - 1;
      xy = xy.slice(0, lapEnd);
      pts = pts.slice(0, lapEnd);
    }
  }
  if (o.reverse) {
    xy = xy.slice().reverse();
    pts = pts.slice().reverse();
  }

  let rawLen = 0;
  for (let i = 1; i < xy.length; i++) rawLen += dist(xy[i - 1], xy[i]);
  if (rawLen < 30) throw new Error('Course is too short to analyse (under 30 m).');
  if (o.courseType === 'auto' && !closed) {
    // Ends close together and pointing the same way (an out-and-back is not a loop).
    const gap = dist(xy[0], xy.at(-1));
    const sameWay = Math.abs(wrapAngle(endHeading(xy) - startHeading(xy))) < Math.PI / 3;
    closed = rawLen > 300 && sameWay && gap < Math.min(60, Math.max(30, rawLen * 0.01));
  }

  const times = pts.map((p) => (Number.isFinite(p.t) ? p.t : NaN));
  const speeds = pts.map((p) => (Number.isFinite(p.speed) && p.speed >= 0 ? p.speed : NaN));
  const filledIn = pts.map((p) => (p.filled ? 1 : 0));
  // Gap to the neighbouring fixes, so smoothing can follow how densely each stretch was sampled.
  const gaps = xy.map((p, i) => {
    const a = i > 0 ? dist(xy[i - 1], p) : NaN;
    const b = i < xy.length - 1 ? dist(p, xy[i + 1]) : NaN;
    return Number.isFinite(a) && Number.isFinite(b) ? Math.max(a, b) : Number.isFinite(a) ? a : b;
  });
  const rs = resample(xy, [times, speeds, gaps, filledIn], o.spacing, closed);
  const { ds } = rs;
  const n = rs.x.length;
  if (n < 5) throw new Error('Course is too short to analyse.');

  // Sparse fixes (e.g. 1 Hz phone GPS at speed) need more smoothing to turn the straight-line
  // joins between fixes back into curves; slow, densely sampled corners need less.
  const gapCh = rs.channels[2];
  const sigmas = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = Number.isFinite(gapCh[i]) ? gapCh[i] : gapCh[mod(i - 1, n)];
    sigmas[i] = Math.max(o.smoothing, 0.6 * (Number.isFinite(g) ? g : 0)) / ds;
  }
  const smoothSig = gaussianSmooth(sigmas, sigmas.map(() => 10 / ds), closed);
  const sx = gaussianSmooth(rs.x, smoothSig, closed);
  const sy = gaussianSmooth(rs.y, smoothSig, closed);
  const halfWindow = Math.max(2, Math.round(o.curvatureWindow / 2 / ds));
  const { k, turn } = curvature(sx, sy, closed, halfWindow);

  const driven = drivenSpeeds(rs.channels[0], rs.channels[1], ds, closed);
  const length = closed ? rs.total : (n - 1) * ds;
  const samples = [];
  for (let i = 0; i < n; i++) {
    const [lat, lon] = proj.toLatLon(sx[i], sy[i]);
    samples.push({ lat, lon, s: i * ds, filled: rs.channels[3][i] > 0.5 });
  }

  const corners = detectCorners(k, turn, closed, o, ds)
    .map((c) => {
      const { grade, speedKmh, hairpin } = gradeFor(c, o);
      const drivenList = c.indices.map((j) => driven[j]).filter(Number.isFinite);
      return {
        ...c,
        startS: c.startIdx * ds,
        endS: c.endIdx * ds,
        apexS: c.apexIdx * ds,
        lat: samples[c.apexIdx].lat,
        lon: samples[c.apexIdx].lon,
        autoGrade: grade,
        grade,
        speedKmh,
        hairpin,
        drivenKmh: drivenList.length ? Math.min(...drivenList) : null,
        guessed: samples[c.apexIdx].filled,
        netTurn: netTurn(sx, sy, c.startIdx, c.endIdx, closed, Math.round(100 / ds)),
        long: c.angle >= 110 && !hairpin,
        into: false,
        note: '',
      };
    })
    .filter((c) => !isManoeuvre(c))
    .map((c, i) => ({ ...c, id: i + 1, number: i + 1 }));

  for (let i = 0; i < corners.length; i++) {
    const next = corners[i + 1] ?? (closed ? corners[0] : null);
    if (!next || next === corners[i]) continue;
    const gap = closed ? mod(next.startS - corners[i].endS, length) : next.startS - corners[i].endS;
    corners[i].into = gap < o.intoGap;
  }
  applyOverrides(corners, o.overrides, length, closed);

  return {
    closed,
    trimmed,
    length,
    ds,
    samples,
    curvature: k,
    corners,
    options: o,
    hasDriven: driven.some(Number.isFinite),
    _x: sx,
    _y: sy,
    _proj: proj,
  };
}

// Not a race corner: tighter than any vehicle can turn (GPS noise), or a tight turn taken at
// walking pace (pulling over, parking, turning round).
const NOISE_RADIUS = 2.5; // metres
const MANOEUVRE_RADIUS = 6; // metres
const MANOEUVRE_KMH = 4;

export function isManoeuvre(c) {
  if (c.radius < NOISE_RADIUS) return true;
  if (c.drivenKmh === null || c.drivenKmh >= MANOEUVRE_KMH) return false;
  if (c.radius < MANOEUVRE_RADIUS) return true;
  // Crawling into and out of a stop wobbles the track; if the road barely changes direction
  // when you look 100 m either side, it's that wobble rather than a bend.
  return Number.isFinite(c.netTurn) && c.netTurn < c.angle * 0.5;
}

// Change of direction (degrees) between the 100 m leading into a corner and the 100 m after it.
function netTurn(x, y, startIdx, endIdx, closed, span) {
  const n = x.length;
  const at = (i) => (closed ? mod(i, n) : Math.min(n - 1, Math.max(0, i)));
  const a = at(startIdx - span);
  const b = at(endIdx + span);
  const h1 = Math.atan2(y[startIdx] - y[a], x[startIdx] - x[a]);
  const h2 = Math.atan2(y[b] - y[endIdx], x[b] - x[endIdx]);
  if (a === startIdx || b === endIdx) return NaN;
  return Math.abs(wrapAngle(h2 - h1)) * R2D;
}

function drivenSpeeds(t, v, ds, closed) {
  const n = t.length;
  const out = new Float64Array(n).fill(NaN);
  const h = Math.max(2, Math.round(5 / ds));
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(v[i])) {
      out[i] = v[i] * 3.6;
      continue;
    }
    let a = i - h;
    let b = i + h;
    if (closed) {
      a = mod(a, n);
      b = mod(b, n);
    } else {
      a = Math.max(0, a);
      b = Math.min(n - 1, b);
    }
    const dt = Math.abs(t[b] - t[a]) / 1000;
    const span = closed ? 2 * h * ds : (b - a) * ds;
    if (Number.isFinite(dt) && dt > 0 && dt < 60) out[i] = (span / dt) * 3.6;
  }
  return out;
}

// Overrides are matched to corners by apex position so they survive re-analysis.
export function applyOverrides(corners, overrides = [], length = Infinity, closed = false) {
  for (const ov of overrides) {
    let best = null;
    let bestD = 25;
    for (const c of corners) {
      let d = Math.abs(c.apexS - ov.s);
      if (closed) d = Math.min(d, length - d);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) continue;
    if (ov.grade && GRADE[ov.grade]) best.grade = ov.grade;
    if (ov.note) best.note = ov.note;
  }
  return corners;
}

// ---------------------------------------------------------------------------
// Pace notes

function modifiers(c) {
  const mods = [];
  if (c.hairpin) mods.push('hairpin');
  if (c.long) mods.push('long');
  if (c.tightens) mods.push('tightens');
  if (c.opens) mods.push('opens');
  return mods;
}

export function noteText(c) {
  const dir = c.dir === 'L' ? 'Left' : 'Right';
  const parts = [`${dir} ${c.grade}`, ...modifiers(c)];
  if (c.note) parts.push(`(${c.note})`);
  return parts.join(' ');
}

export function shortLabel(c) {
  return `${c.dir}${c.grade}`;
}

// Compact note for devices with small screens: L/R + grade, then HP (hairpin), LG (long),
// T (tightens), O (opens). E.g. "L1 HP T", "R3 O".
export function shortNote(c) {
  return [shortLabel(c), c.hairpin && 'HP', c.long && 'LG', c.tightens && 'T', c.opens && 'O'].filter(Boolean).join(' ');
}

export function spokenNote(c) {
  const words = [c.dir === 'L' ? 'left' : 'right', c.grade, ...modifiers(c)];
  if (c.note) words.push(c.note);
  return words.join(' ');
}

// ---------------------------------------------------------------------------
// Live positioning (drive mode)

export function locate(analysis, lat, lon, hint = -1) {
  const { _x: x, _y: y, _proj: proj, closed, ds } = analysis;
  const n = x.length;
  const [px, py] = proj.toXY(lat, lon);
  let best = -1;
  let bd = Infinity;
  const test = (i) => {
    const d = (x[i] - px) ** 2 + (y[i] - py) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  };
  if (hint >= 0) {
    const back = Math.round(60 / ds);
    const ahead = Math.round(300 / ds);
    for (let j = -back; j <= ahead; j++) {
      const i = hint + j;
      if (closed) test(mod(i, n));
      else if (i >= 0 && i < n) test(i);
    }
  }
  if (best < 0 || Math.sqrt(bd) > 30) {
    for (let i = 0; i < n; i++) test(i);
  }
  return { index: best, s: best * ds, offset: Math.sqrt(bd) };
}

// Corners ahead of sample `index`, nearest first. A corner you are in counts
// (distance 0) until you pass its apex.
export function cornersAhead(analysis, index, count = 2) {
  const { corners, closed, ds, samples } = analysis;
  const n = samples.length;
  const list = [];
  for (const c of corners) {
    let d;
    if (closed) {
      const sinceStart = mod(index - c.startIdx, n);
      const span = mod(c.endIdx - c.startIdx, n);
      const toApex = mod(c.apexIdx - c.startIdx, n);
      if (sinceStart <= span) d = sinceStart <= toApex ? 0 : null;
      if (d === undefined) d = mod(c.startIdx - index, n) * ds;
    } else {
      if (index >= c.startIdx && index <= c.endIdx) d = index <= c.apexIdx ? 0 : null;
      else if (c.startIdx > index) d = (c.startIdx - index) * ds;
      else d = null;
    }
    if (d !== null) list.push({ corner: c, distance: d });
  }
  list.sort((a, b) => a.distance - b.distance);
  return list.slice(0, count);
}

// Runs of consecutive samples that share a corner (or straight), for drawing.
export function colourRuns(analysis) {
  const { samples, corners, closed } = analysis;
  const n = samples.length;
  const owner = new Int32Array(n).fill(-1);
  corners.forEach((c, ci) => c.indices.forEach((i) => (owner[i] = ci)));
  const runs = [];
  let cur = null;
  // On a loop, begin on a straight so a corner across the start line is drawn as one piece.
  const first = closed ? Math.max(0, owner.indexOf(-1)) : 0;
  const total = closed ? n + 1 : n;
  for (let p = 0; p < total; p++) {
    const i = (first + p) % n;
    const o = owner[i];
    const ll = [samples[i].lat, samples[i].lon];
    if (!cur || cur.corner !== o) {
      if (cur) cur.latlngs.push(ll);
      cur = { corner: o, latlngs: [ll] };
      runs.push(cur);
    } else {
      cur.latlngs.push(ll);
    }
  }
  return runs.map((r) => ({ corner: r.corner >= 0 ? corners[r.corner] : null, latlngs: r.latlngs }));
}

// ---------------------------------------------------------------------------
// Hazards: spots marked while recording, rated green, orange or red.

export const HAZARD_LEVELS = {
  green: { label: 'Green', color: '#22c55e', ink: '#062b14' },
  orange: { label: 'Orange', color: '#f97316', ink: '#2b1202' },
  red: { label: 'Red', color: '#ef4444', ink: '#fff' },
};

// Snap hazards onto the analysed course; ones more than `maxOffset` metres from it are dropped.
export function placeHazards(analysis, hazards = [], maxOffset = 40) {
  return hazards
    .map((h, i) => {
      const loc = locate(analysis, h.lat, h.lon);
      return { ...h, id: i, index: loc.index, s: loc.s, offset: loc.offset };
    })
    .filter((h) => h.offset <= maxOffset && HAZARD_LEVELS[h.level])
    .sort((a, b) => a.index - b.index);
}

export function hazardsAhead(analysis, placed, index, maxDistance) {
  const n = analysis.samples.length;
  const out = [];
  for (const h of placed) {
    const d = (analysis.closed ? mod(h.index - index, n) : h.index - index) * analysis.ds;
    if (d >= 0 && d <= maxDistance) out.push({ hazard: h, distance: d });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

// Where the vehicle was at time `t`, interpolated between recorded fixes (sorted by time).
// Used to place a spoken hazard where you started saying it, not where recognition finished.
export function positionAtTime(points, t) {
  const timed = points.filter((p) => Number.isFinite(p.t));
  if (!timed.length) return null;
  if (t <= timed[0].t) return { lat: timed[0].lat, lon: timed[0].lon };
  for (let i = 1; i < timed.length; i++) {
    const a = timed[i - 1];
    const b = timed[i];
    if (t <= b.t) {
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    }
  }
  const last = timed.at(-1);
  return { lat: last.lat, lon: last.lon };
}

// Spoken hazard calls. Includes the words speech recognisers commonly return instead.
const HAZARD_WORDS = [
  ['red', /\b(red|read|redd)\b/],
  ['orange', /\b(orange|oranges|amber)\b/],
  ['green', /\b(green|greene|greens)\b/],
];

// The first hazard colour said in `text`, or null.
export function hazardLevelFromSpeech(text) {
  const t = String(text).toLowerCase();
  let best = null;
  let at = Infinity;
  for (const [level, re] of HAZARD_WORDS) {
    const m = t.match(re);
    if (m && m.index < at) {
      at = m.index;
      best = level;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Joining a recording that was interrupted: part `a` then part `b`.
// If `b` restarts on top of the end of `a`, the overlap is trimmed. Otherwise the gap is filled
// with a smooth curve leaving `a` on its final heading and meeting `b` on its starting heading.
// Filled points are flagged `filled: true` and have no time, so they don't affect speeds.

export function joinTracks(a, b, { spacing = 5, maxAccuracy = DEFAULTS.maxAccuracy } = {}) {
  const good = (pts) => pts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && !(p.acc > maxAccuracy));
  const ga = good(a);
  const gb = good(b);
  if (ga.length < 2 || gb.length < 2) throw new Error('Each recording needs at least 2 good GPS points to join.');
  const proj = makeProjection(ga[0].lat, ga[0].lon);
  const xa = ga.map((p) => proj.toXY(p.lat, p.lon));
  const xb = gb.map((p) => proj.toXY(p.lat, p.lon));

  // Overlap: part b starts on (or very near) the tail end of part a.
  const tailFrom = Math.floor(xa.length * 0.6);
  let near = -1;
  let nearD = 20;
  for (let i = tailFrom; i < xa.length; i++) {
    const d = dist(xa[i], xb[0]);
    if (d < nearD) {
      nearD = d;
      near = i;
    }
  }
  if (near >= 0 && near < xa.length - 1) {
    return { points: [...ga.slice(0, near + 1), ...gb], gap: 0, overlapTrimmed: true };
  }

  const p0 = xa.at(-1);
  const p1 = xb[0];
  const gap = dist(p0, p1);
  if (gap < 3) return { points: [...ga, ...gb], gap, overlapTrimmed: false };

  // Unit headings from ~15 m of track either side of the gap.
  const headingOf = (from, to) => {
    const len = dist(from, to) || 1;
    return [(to[0] - from[0]) / len, (to[1] - from[1]) / len];
  };
  let i = xa.length - 2;
  while (i > 0 && dist(xa[i], p0) < 15) i--;
  let j = 1;
  while (j < xb.length - 1 && dist(xb[j], p1) < 15) j++;
  const t0 = headingOf(xa[i], p0);
  const t1 = headingOf(p1, xb[j]);

  // Cubic Hermite curve; tangent length equal to the gap gives a natural, unforced bend.
  const filled = [];
  const n = Math.max(1, Math.ceil(gap / spacing));
  for (let k = 1; k < n; k++) {
    const u = k / n;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
    const h10 = u ** 3 - 2 * u ** 2 + u;
    const h01 = -2 * u ** 3 + 3 * u ** 2;
    const h11 = u ** 3 - u ** 2;
    const x = h00 * p0[0] + h10 * gap * t0[0] + h01 * p1[0] + h11 * gap * t1[0];
    const y = h00 * p0[1] + h10 * gap * t0[1] + h01 * p1[1] + h11 * gap * t1[1];
    const [lat, lon] = proj.toLatLon(x, y);
    filled.push({ lat, lon, t: NaN, acc: NaN, speed: NaN, filled: true });
  }
  return { points: [...ga, ...filled, ...gb], gap, overlapTrimmed: false };
}
