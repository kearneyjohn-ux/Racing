// Builds synthetic GPS tracks from a list of straights and arcs, for tests and the demo course.

import { makeProjection } from '../js/analysis.js';

// Deterministic PRNG so tests and the demo file are reproducible.
export function rng(seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.gauss = () => Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
  return next;
}

// Each part is { straight: metres } or { radius, angle (deg), dir: 'L'|'R' }.
// Returns dense points (every `step` metres) in local x/y with each point's curvature.
export function buildPath(parts, { step = 0.5, heading = 0 } = {}) {
  let x = 0;
  let y = 0;
  let h = heading * (Math.PI / 180);
  const pts = [{ x, y, k: 0 }];
  for (const p of parts) {
    if (p.straight) {
      const n = Math.max(1, Math.round(p.straight / step));
      for (let i = 0; i < n; i++) {
        x += Math.cos(h) * step;
        y += Math.sin(h) * step;
        pts.push({ x, y, k: 0 });
      }
    } else {
      const sign = p.dir === 'L' ? 1 : -1;
      const len = p.radius * p.angle * (Math.PI / 180);
      const n = Math.max(1, Math.round(len / step));
      const dh = (sign * (p.angle * Math.PI)) / 180 / n;
      const ds = len / n;
      for (let i = 0; i < n; i++) {
        h += dh / 2;
        x += Math.cos(h) * ds;
        y += Math.sin(h) * ds;
        h += dh / 2;
        pts.push({ x, y, k: 1 / p.radius });
      }
    }
  }
  return pts;
}

export function toLatLon(pts, { lat0 = 52.95, lon0 = -7.6 } = {}) {
  const proj = makeProjection(lat0, lon0);
  return pts.map((p) => {
    const [lat, lon] = proj.toLatLon(p.x, p.y);
    return { ...p, lat, lon };
  });
}

// Simple point-mass speed profile: corner limit, then forward (accel) and backward (brake) passes.
export function speedProfile(pts, { mu = 0.5, vmax = 33, accel = 3, brake = 6, step = 0.5, closed = false } = {}) {
  const n = pts.length;
  const v = pts.map((p) => Math.min(vmax, p.k > 0 ? Math.sqrt(mu * 9.81 / p.k) : vmax));
  const passes = closed ? 2 : 1;
  for (let r = 0; r < passes; r++) {
    for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * accel * step));
    if (closed) v[0] = Math.min(v[0], Math.sqrt(v[n - 1] ** 2 + 2 * accel * step));
  }
  for (let r = 0; r < passes; r++) {
    for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * brake * step));
    if (closed) v[n - 1] = Math.min(v[n - 1], Math.sqrt(v[0] ** 2 + 2 * brake * step));
  }
  if (!closed) v[0] = Math.max(v[0], 1);
  return v.map((s) => Math.max(s, 1));
}

// Sample the dense path like a GPS receiver would: every `hz`, with correlated noise.
export function simulateGPS(pts, speeds, { hz = 1, noise = 1.5, seed = 7, t0 = Date.UTC(2026, 9, 1, 10, 0, 0), step = 0.5 } = {}) {
  const rand = rng(seed);
  const dt = 1 / hz;
  const out = [];
  let t = 0;
  let nextFix = 0;
  let ex = 0;
  let ey = 0;
  for (let i = 0; i < pts.length; i++) {
    if (t >= nextFix) {
      // First-order random walk, which is how GPS error behaves (it drifts rather than jumps).
      ex = 0.8 * ex + noise * 0.6 * rand.gauss();
      ey = 0.8 * ey + noise * 0.6 * rand.gauss();
      out.push({ x: pts[i].x + ex, y: pts[i].y + ey, t: t0 + Math.round(t * 1000), speed: speeds[i], acc: 3 + Math.abs(rand.gauss()) });
      nextFix += dt;
    }
    t += step / speeds[i];
  }
  return out;
}
