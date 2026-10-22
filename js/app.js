import {
  analyzeCourse,
  colourRuns,
  cornersAhead,
  DEFAULTS,
  GRADE,
  GRADES,
  haversine,
  locate,
  noteText,
  shortLabel,
  spokenNote,
  SURFACES,
} from './analysis.js';
import { parseTrackFile, toGeoJSON, toGPX, toKML, toPaceNotesCSV } from './formats.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------------------
// Storage

const SETTINGS_KEY = 'rcp.settings';
const COURSES_KEY = 'rcp.courses';
const REC_KEY = 'rcp.recording';

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      toast('Could not save: browser storage is full or blocked. Export the course to keep it.');
      return false;
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  },
};

const r7 = (v) => (Number.isFinite(v) ? Math.round(v * 1e7) / 1e7 : null);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const pack = (pts) => pts.map((p) => [r7(p.lat), r7(p.lon), Number.isFinite(p.t) ? p.t : null, r1(p.acc), r1(p.speed)]);
const unpack = (rows) =>
  rows.map(([lat, lon, t, acc, speed]) => ({ lat, lon, t: t ?? NaN, acc: acc ?? NaN, speed: speed ?? NaN }));

const APP_DEFAULTS = {
  surface: DEFAULTS.surface,
  confidence: DEFAULTS.confidence,
  topSpeedKmh: DEFAULTS.topSpeedKmh,
  units: 'kmh',
  courseType: 'auto',
  reverse: false,
  smoothing: DEFAULTS.smoothing,
  straightRadius: DEFAULTS.straightRadius,
  minAngle: DEFAULTS.minAngle,
  voice: true,
  leadSeconds: 5,
  autoStop: false,
  lastCourse: null,
};

const state = {
  settings: { ...APP_DEFAULTS, ...store.get(SETTINGS_KEY, {}) },
  courses: store.get(COURSES_KEY, []),
  course: null,
  analysis: null,
  runs: [],
  markers: new Map(),
  rec: null,
  drive: null,
};

const saveSettings = () => store.set(SETTINGS_KEY, state.settings);
const saveCourses = () => store.set(COURSES_KEY, state.courses);

// ---------------------------------------------------------------------------
// Formatting

const isMph = () => state.settings.units === 'mph';
const speedUnit = () => (isMph() ? 'mph' : 'km/h');
const toUnit = (kmh) => (isMph() ? kmh / 1.609344 : kmh);
const fmtSpeed = (kmh) => `${Math.round(toUnit(kmh))} ${speedUnit()}`;
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Map

const map = L.map('map', { zoomControl: false }).setView([53.35, -7.6], 6);
L.control.zoom({ position: 'topleft' }).addTo(map);
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 21,
  maxNativeZoom: 19,
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
});
const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 21,
  maxNativeZoom: 19,
  attribution: '© OpenStreetMap contributors',
});
satellite.addTo(map);
L.control.layers({ Satellite: satellite, Map: streets }, null, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
const courseLayer = L.layerGroup().addTo(map);
const liveLayer = L.layerGroup().addTo(map);

function cornerIcon(c) {
  const g = GRADE[c.grade];
  return L.divIcon({
    className: '',
    html: `<div class="corner-marker" style="background:${g.color};color:${g.ink}">${esc(shortLabel(c))}</div>`,
    iconSize: [34, 24],
    iconAnchor: [17, 12],
  });
}
const startIcon = L.divIcon({ className: '', html: '<div class="start-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });

function renderMap(fit) {
  courseLayer.clearLayers();
  state.markers.clear();
  const a = state.analysis;
  if (!a) return;
  state.runs = colourRuns(a);
  const all = a.samples.map((p) => [p.lat, p.lon]);
  if (a.closed) all.push(all[0]);
  L.polyline(all, { color: '#000', weight: 11, opacity: 0.55, interactive: false }).addTo(courseLayer);
  for (const r of state.runs) {
    const color = r.corner ? GRADE[r.corner.grade].color : '#ffffff';
    const line = L.polyline(r.latlngs, { color, weight: r.corner ? 7 : 4, opacity: 1 }).addTo(courseLayer);
    if (r.corner) line.on('click', () => focusCorner(r.corner.number));
  }
  L.marker(all[0], { icon: startIcon, title: 'Start', zIndexOffset: -100 }).addTo(courseLayer);
  if (!a.closed) L.marker(all.at(-1), { icon: startIcon, title: 'Finish', zIndexOffset: -100 }).addTo(courseLayer);
  for (const c of a.corners) {
    const m = L.marker([c.lat, c.lon], { icon: cornerIcon(c), title: `${c.number}: ${noteText(c)}`, riseOnHover: true });
    m.bindPopup(() => popupHtml(c), { maxWidth: 270, autoPanPadding: [20, 20] });
    m.addTo(courseLayer);
    state.markers.set(c.number, m);
  }
  if (fit) map.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
}

function popupHtml(c) {
  const isOverride = c.grade !== c.autoGrade;
  const options = [`<option value="">Auto (${GRADE[c.autoGrade].name})</option>`]
    .concat(GRADES.map((g) => `<option value="${g.id}" ${isOverride && c.grade === g.id ? 'selected' : ''}>${g.name}</option>`))
    .join('');
  return `<div class="pop" data-corner="${c.number}">
    <h3>${c.number}. ${esc(noteText(c))}</h3>
    <dl>
      <dt>Target</dt><dd>${fmtSpeed(c.speedKmh)}</dd>
      ${c.drivenKmh !== null ? `<dt>Recorded</dt><dd>${fmtSpeed(c.drivenKmh)}</dd>` : ''}
      <dt>Radius</dt><dd>${Math.round(c.radius)} m</dd>
      <dt>Turns</dt><dd>${Math.round(c.angle)}°</dd>
      <dt>From start</dt><dd>${fmtDist(c.startS)}</dd>
    </dl>
    <div class="edit">
      <select data-f="grade" aria-label="Grade">${options}</select>
      <input data-f="note" maxlength="40" placeholder="Note: don't cut, jump, rut…" value="${esc(c.note)}">
      <button class="btn" data-f="save">Save</button>
    </div>
  </div>`;
}

map.on('popupopen', (e) => {
  const el = e.popup.getElement()?.querySelector('.pop');
  if (!el) return;
  const c = state.analysis?.corners.find((x) => x.number === Number(el.dataset.corner));
  el.querySelector('[data-f="save"]').addEventListener('click', () => {
    saveOverride(c, el.querySelector('[data-f="grade"]').value, el.querySelector('[data-f="note"]').value.trim());
    map.closePopup();
  });
  highlightListItem(c?.number);
});

// ---------------------------------------------------------------------------
// Course handling

const overrideKey = () => (state.settings.reverse ? 'rev' : 'fwd');

function saveOverride(c, grade, note) {
  const course = state.course;
  if (!course || !c) return;
  course.overrides ??= { fwd: [], rev: [] };
  const list = (course.overrides[overrideKey()] ?? []).filter((o) => Math.abs(o.s - c.apexS) > 25);
  if (grade || note) list.push({ s: Math.round(c.apexS), grade, note });
  course.overrides[overrideKey()] = list;
  saveCourses();
  analyse();
  toast(`Corner ${c.number} updated`);
}

function analyse(fit = false) {
  const s = state.settings;
  state.analysis = null;
  if (state.course) {
    try {
      state.analysis = analyzeCourse(unpack(state.course.points), {
        surface: s.surface,
        confidence: Number(s.confidence),
        topSpeedKmh: Number(s.topSpeedKmh),
        smoothing: Number(s.smoothing),
        straightRadius: Number(s.straightRadius),
        minAngle: Number(s.minAngle),
        courseType: s.courseType,
        reverse: s.reverse,
        overrides: state.course.overrides?.[overrideKey()] ?? [],
      });
    } catch (e) {
      toast(e.message);
    }
  }
  renderMap(fit);
  renderCorners();
  renderCourseList();
  $('courseName').textContent = state.course ? state.course.name : 'No course loaded';
}

function addCourse(name, points) {
  const course = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    created: Date.now(),
    points: pack(points),
    overrides: { fwd: [], rev: [] },
  };
  state.courses.unshift(course);
  if (!saveCourses()) state.courses.shift();
  selectCourse(course);
  return course;
}

function selectCourse(course, quiet = false) {
  state.course = course;
  state.settings.lastCourse = course?.id ?? null;
  saveSettings();
  analyse(true);
  if (state.analysis && !quiet) {
    showTab('corners');
    if (state.analysis.trimmed) toast('More than one lap was recorded, so the first full lap is used.');
  }
}

function renderCourseList() {
  const ul = $('courseList');
  if (!state.courses.length) {
    ul.innerHTML = '<li class="muted">Nothing saved yet.</li>';
    return;
  }
  ul.innerHTML = state.courses
    .map(
      (c) => `<li class="${state.course?.id === c.id ? 'active' : ''}" data-id="${c.id}">
        <span class="name" data-act="open"><b>${esc(c.name)}</b><small>${new Date(c.created).toLocaleDateString()} · ${c.points.length} fixes</small></span>
        <button class="icon-btn" data-act="rename" aria-label="Rename" title="Rename">✎</button>
        <button class="icon-btn" data-act="delete" aria-label="Delete" title="Delete">✕</button>
      </li>`,
    )
    .join('');
}

$('courseList').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const li = e.target.closest('li[data-id]');
  if (!act || !li) return;
  const course = state.courses.find((c) => c.id === li.dataset.id);
  if (act === 'open') selectCourse(course);
  if (act === 'rename') {
    const name = prompt('Course name', course.name);
    if (name?.trim()) {
      course.name = name.trim();
      saveCourses();
      renderCourseList();
      if (state.course === course) $('courseName').textContent = course.name;
    }
  }
  if (act === 'delete' && confirm(`Delete "${course.name}"? This can't be undone.`)) {
    state.courses = state.courses.filter((c) => c !== course);
    saveCourses();
    if (state.course === course) {
      state.course = null;
      analyse();
    } else renderCourseList();
  }
});

// ---------------------------------------------------------------------------
// Corners tab

function gradeRange(g, i) {
  if (g.id === 'H') return 'hairpin';
  if (g.id === 'F') return 'flat out';
  const lo = GRADES[i - 1]?.maxKmh;
  const u = (v) => Math.round(toUnit(v));
  if (!lo) return `< ${u(g.maxKmh)}`;
  if (g.maxKmh === Infinity) return `${u(lo)}+`;
  return `${u(lo)}–${u(g.maxKmh)}`;
}

function renderCorners() {
  const a = state.analysis;
  $('cornersEmpty').hidden = !!a;
  $('cornersBody').hidden = !a;
  if (!a) return;
  const slowest = a.corners.reduce((m, c) => (!m || c.speedKmh < m.speedKmh ? c : m), null);
  $('summary').innerHTML = `
    <div><small>${a.closed ? 'Loop' : 'Stage'} length</small><b>${fmtDist(a.length)}</b></div>
    <div><small>Corners</small><b>${a.corners.length}</b></div>
    <div><small>Slowest</small><b>${slowest ? `#${slowest.number} ${shortLabel(slowest)}` : '—'}</b></div>`;
  $('legend').innerHTML = GRADES.map(
    (g, i) => `<span><span class="chip" style="background:${g.color};color:${g.ink}">${g.id}</span>${gradeRange(g, i)}</span>`,
  ).join('');
  $('cornerList').innerHTML = a.corners
    .map((c) => {
      const g = GRADE[c.grade];
      const edited = c.grade !== c.autoGrade || c.note ? '<span class="edited">edited</span>' : '';
      const driven = c.drivenKmh !== null ? ` · you did ${Math.round(toUnit(c.drivenKmh))}` : '';
      return `<li data-n="${c.number}">
        <span class="n">${c.number}</span>
        <span class="chip" style="background:${g.color};color:${g.ink}">${esc(shortLabel(c))}</span>
        <span class="txt"><b>${esc(noteText(c))}${edited}</b><small>${Math.round(c.radius)} m radius · ${Math.round(c.angle)}° · at ${fmtDist(c.startS)}${driven}</small></span>
        <span class="spd"><b>${Math.round(toUnit(c.speedKmh))}</b><small>${speedUnit()}</small></span>
      </li>`;
    })
    .join('');
  $('replayBtn').hidden = !state.course;
}

function highlightListItem(n) {
  for (const li of $('cornerList').children) li.classList.toggle('sel', Number(li.dataset.n) === n);
}

function focusCorner(n) {
  const c = state.analysis?.corners.find((x) => x.number === n);
  if (!c) return;
  map.flyTo([c.lat, c.lon], Math.max(map.getZoom(), 17), { duration: 0.6 });
  setTimeout(() => state.markers.get(n)?.openPopup(), 650);
  highlightListItem(n);
}

$('cornerList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-n]');
  if (li) focusCorner(Number(li.dataset.n));
});

document.querySelectorAll('[data-export]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const a = state.analysis;
    if (!a) return;
    const base = state.course.name.replace(/[^\w-]+/g, '_');
    const kind = btn.dataset.export;
    if (kind === 'kml') download(`${base}.kml`, toKML(state.course.name, a, state.runs, fmtSpeed), 'application/vnd.google-earth.kml+xml');
    if (kind === 'geojson') download(`${base}.geojson`, toGeoJSON(state.course.name, a, state.runs), 'application/geo+json');
    if (kind === 'csv') download(`${base}-pace-notes.csv`, toPaceNotesCSV(a, (k) => Math.round(toUnit(k))), 'text/csv');
    if (kind === 'gpx') download(`${base}.gpx`, toGPX(state.course.name, unpack(state.course.points)), 'application/gpx+xml');
  }),
);

// ---------------------------------------------------------------------------
// Tabs and panel

function showTab(name) {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${name}`));
}
document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

$('panel').addEventListener('transitionend', (e) => e.target === $('panel') && map.invalidateSize());
$('panelGrip').addEventListener('click', () => {
  const p = $('panel');
  if (p.classList.contains('expanded')) {
    p.classList.replace('expanded', 'collapsed');
  } else if (p.classList.contains('collapsed')) {
    p.classList.remove('collapsed');
  } else {
    p.classList.add('expanded');
  }
});

// ---------------------------------------------------------------------------
// Settings

function initSettings() {
  const form = $('settingsForm');
  $('surfaceSelect').innerHTML = Object.entries(SURFACES)
    .map(([id, s]) => `<option value="${id}">${s.label} (grip ${s.mu})</option>`)
    .join('');
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!state.settings[el.name];
    else el.value = state.settings[el.name];
  }
  $('confOut').textContent = `${Math.round(state.settings.confidence * 100)}%`;
  form.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.name) return;
    let value = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' || el.type === 'range') {
      value = Number(value);
      if (!Number.isFinite(value)) return;
    }
    state.settings[el.name] = value;
    saveSettings();
    $('confOut').textContent = `${Math.round(state.settings.confidence * 100)}%`;
    if (el.name === 'units') {
      renderCorners();
    } else if (!['voice', 'leadSeconds', 'autoStop'].includes(el.name)) {
      analyse();
    }
  });
}

// ---------------------------------------------------------------------------
// Screen wake lock (keeps GPS running: most phones throttle location when the screen sleeps)

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (state.rec || state.drive)) keepAwake(true);
});

// ---------------------------------------------------------------------------
// GPS

function gpsSupported() {
  if (!('geolocation' in navigator)) {
    toast('This browser has no access to GPS.');
    return false;
  }
  if (!window.isSecureContext) {
    toast('GPS only works when this page is opened over https://');
    return false;
  }
  return true;
}

function watchGPS(onFix, onError, quiet = false) {
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      onFix({
        lat: c.latitude,
        lon: c.longitude,
        t: pos.timestamp,
        acc: c.accuracy,
        speed: Number.isFinite(c.speed) && c.speed !== null ? c.speed : NaN,
        ele: c.altitude ?? NaN,
      });
    },
    (err) => {
      // Brief outages are common; in quiet mode the screen's own status shows them instead.
      if (quiet && err.code !== err.PERMISSION_DENIED) return;
      if (err.code === err.PERMISSION_DENIED) toast('Location permission was denied. Allow it in your browser settings.');
      else if (err.code === err.TIMEOUT) toast('Waiting for a GPS fix… make sure you have a clear view of the sky.');
      else toast(err.message ? `GPS error: ${err.message}` : 'GPS signal lost, waiting for a fix…');
      onError?.(err);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

const accClass = (acc) => (acc <= 8 ? 'acc-good' : acc <= 20 ? 'acc-ok' : 'acc-bad');

// ---------------------------------------------------------------------------
// GPS warm-up: once location permission has been granted, watch GPS while idle so the
// record button shows signal quality and the first fix is ready the moment you tap it.

let warm = null;

function startWarmup() {
  if (warm || state.rec || state.drive || !('geolocation' in navigator) || !window.isSecureContext) return;
  warm = watchGPS((p) => showGpsReady(p.acc), null, true);
}

function stopWarmup() {
  warm?.();
  warm = null;
}

function showGpsReady(acc) {
  const el = $('fabGps');
  if (acc === null) {
    el.textContent = 'Tap to start';
    el.className = '';
    return;
  }
  el.textContent = `${acc <= 20 ? 'GPS ready' : 'GPS weak'} ±${Math.round(acc)} m`;
  el.className = accClass(acc);
}

async function initWarmup() {
  try {
    const perm = await navigator.permissions?.query({ name: 'geolocation' });
    if (!perm) return;
    if (perm.state === 'granted') startWarmup();
    perm.addEventListener('change', () => perm.state === 'granted' && startWarmup());
  } catch {
    /* Permissions API not supported (older Safari): GPS starts when you tap Record */
  }
}

// ---------------------------------------------------------------------------
// Recording

const LAP_MIN_DIST = 300; // metres driven before a return to the start counts as a lap
const LAP_ZONE = 25; // metres from the start point

function bearing(a, b) {
  const dx = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  return (Math.atan2(dx, b.lat - a.lat) * 180) / Math.PI;
}

function startRecording() {
  if (state.rec || state.drive || !gpsSupported()) return;
  stopWarmup();
  const rec = {
    points: [],
    started: Date.now(),
    lastFixAt: null,
    gaps: 0,
    dist: 0,
    speed: 0,
    lastAcc: null,
    lastGood: null,
    first: null,
    startDir: null,
    zoneMin: null,
    lapDone: false,
    line: L.polyline([], { color: '#ff3b30', weight: 5 }).addTo(liveLayer),
    dot: null,
  };
  state.rec = rec;
  rec.stop = watchGPS(
    onRecFix,
    (err) => {
      if (err.code === err.PERMISSION_DENIED) stopRecording(true);
    },
    true,
  );
  rec.timer = setInterval(updateRecStats, 1000);
  keepAwake(true);
  document.body.classList.add('fullmode');
  $('recScreen').hidden = false;
  $('rsLap').hidden = true;
  $('rsUnit').textContent = speedUnit();
  map.invalidateSize();
  updateRecStats();
}

function onRecFix(p) {
  const rec = state.rec;
  if (!rec) return;
  const now = Date.now();
  if (rec.lastFixAt && now - rec.lastFixAt > 10000) rec.gaps++;
  rec.lastFixAt = now;
  rec.lastAcc = p.acc;
  rec.points.push(p);

  if (p.acc <= DEFAULTS.maxAccuracy) {
    const prev = rec.lastGood;
    if (prev) {
      const d = haversine(prev, p);
      const dt = (p.t - prev.t) / 1000;
      rec.dist += d;
      rec.speed = Number.isFinite(p.speed) ? p.speed : dt > 0 ? d / dt : rec.speed;
    } else {
      rec.first = p;
    }
    rec.lastGood = p;
    rec.line.addLatLng([p.lat, p.lon]);
    if (prev) checkLap(rec, prev, p);
  }

  if (!rec.dot) {
    rec.dot = L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#ff3b30', fillOpacity: 1 }).addTo(liveLayer);
    map.setView([p.lat, p.lon], 17);
  } else {
    rec.dot.setLatLng([p.lat, p.lon]);
    map.panTo([p.lat, p.lon], { animate: true, duration: 0.4 });
  }
  if (rec.points.length % 5 === 0) store.set(REC_KEY, { started: rec.started, points: pack(rec.points) });
  updateRecStats();
}

// A lap is complete when, after driving a while, you pass back by the start heading the same
// way you set off. It fires at the closest point to the start, not on entering the zone.
function checkLap(rec, prev, p) {
  if (rec.lapDone) return;
  if (rec.startDir === null) {
    if (haversine(rec.first, p) >= 10) rec.startDir = bearing(rec.first, p);
    return;
  }
  const d = haversine(rec.first, p);
  const turn = Math.abs(((bearing(prev, p) - rec.startDir + 540) % 360) - 180);
  const inZone = rec.dist >= LAP_MIN_DIST && d <= LAP_ZONE && turn <= 60;
  if (inZone && d > 6 && (rec.zoneMin === null || d <= rec.zoneMin + 2)) {
    rec.zoneMin = Math.min(d, rec.zoneMin ?? d);
    return;
  }
  // Not near the start, and never was: nothing to do.
  if (!inZone && rec.zoneMin === null) return;
  // Otherwise the start has been passed: very close, moving away again, or out of the zone
  // (at speed with 1 Hz GPS there may be only one fix inside it).
  rec.lapDone = true;
  $('rsLap').hidden = false;
  navigator.vibrate?.([200, 100, 200]);
  if (state.settings.autoStop) {
    speak('Lap complete. Recording stopped.');
    stopRecording();
  } else {
    speak('Lap complete');
  }
}

function updateRecStats() {
  const rec = state.rec;
  if (!rec) return;
  const now = Date.now();
  const status = $('rsStatus');
  if (rec.lastFixAt === null) {
    status.textContent = 'Waiting for GPS… stay put until it locks on';
    status.className = 'rs-status';
  } else if (now - rec.lastFixAt > 5000) {
    status.textContent = 'GPS signal lost: keep the app open and the screen on';
    status.className = 'rs-status lost';
  } else {
    status.textContent = 'Recording';
    status.className = 'rs-status live';
  }
  $('rsTime').textContent = fmtTime(now - rec.started);
  $('rsDist').textContent = fmtDist(rec.dist);
  $('rsSpeed').textContent = Math.round(toUnit(rec.speed * 3.6));
  $('rsFixes').textContent = rec.points.length;
  const acc = $('rsAcc');
  acc.textContent = rec.lastAcc === null ? '—' : `±${Math.round(rec.lastAcc)} m`;
  acc.className = rec.lastAcc === null ? '' : accClass(rec.lastAcc);
}

function stopRecording(discard = false) {
  const rec = state.rec;
  if (!rec) return;
  rec.stop();
  clearInterval(rec.timer);
  liveLayer.clearLayers();
  state.rec = null;
  keepAwake(false);
  store.del(REC_KEY);
  $('recScreen').hidden = true;
  document.body.classList.remove('fullmode');
  map.invalidateSize();
  initWarmup();
  if (discard) return;
  if (rec.points.length < 10) {
    toast('Not enough GPS fixes were recorded to make a course.');
    return;
  }
  addCourse(`Recorded ${new Date(rec.started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`, rec.points);
  if (rec.gaps) toast('GPS paused during the recording (screen off or app in the background), so parts of the track may be straight-line guesses.', 6000);
}

// Stopping needs a deliberate 1-second press so a bump or stray tap can't end the recording.
function holdToActivate(btn, ms, action) {
  let timer = null;
  const release = (hint) => {
    if (timer && hint) toast('Hold the button to stop');
    clearTimeout(timer);
    timer = null;
    btn.classList.remove('holding');
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.classList.add('holding');
    timer = setTimeout(() => {
      timer = null;
      btn.classList.remove('holding');
      action();
    }, ms);
  });
  btn.addEventListener('pointerup', () => release(true));
  btn.addEventListener('pointerleave', () => release(false));
  btn.addEventListener('pointercancel', () => release(false));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action();
    }
  });
}

$('recFab').addEventListener('click', startRecording);
$('recBtn').addEventListener('click', startRecording);
holdToActivate($('rsStop'), 1000, () => stopRecording());
$('rsDiscard').addEventListener('click', () => {
  if (confirm('Discard this recording? The track will be lost.')) stopRecording(true);
});

function recoverRecording() {
  const saved = store.get(REC_KEY, null);
  if (!saved) return;
  store.del(REC_KEY);
  if (saved.points?.length >= 10 && confirm('An unfinished recording was found. Save it as a course?')) {
    addCourse(`Recovered ${new Date(saved.started).toLocaleString()}`, unpack(saved.points));
  }
}

// ---------------------------------------------------------------------------
// Import

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const points = parseTrackFile(await file.text(), file.name);
    addCourse(file.name.replace(/\.[^.]+$/, ''), points);
  } catch (err) {
    toast(`Couldn't read ${file.name}: ${err.message}`);
  }
});

$('demoBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('samples/demo-course.gpx');
    addCourse('Demo off-road loop', parseTrackFile(await res.text(), 'demo.gpx'));
  } catch (err) {
    toast(`Couldn't load the demo: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Drive mode

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.15;
  speechSynthesis.speak(u);
}

function replaySource(onFix, speedUp = 2) {
  let pts = unpack(state.course.points).filter((p) => !(p.acc > DEFAULTS.maxAccuracy));
  if (state.settings.reverse) pts = pts.reverse();
  const timed = pts.every((p) => Number.isFinite(p.t));
  let i = 0;
  let timer;
  const step = () => {
    if (i >= pts.length) {
      toast('Replay finished');
      return;
    }
    const p = pts[i];
    onFix({ ...p, acc: Number.isFinite(p.acc) ? p.acc : 3 });
    const next = pts[i + 1];
    i++;
    if (!next) return;
    const dt = timed ? Math.abs(next.t - p.t) : (haversine(p, next) / 15) * 1000;
    timer = setTimeout(step, Math.min(3000, Math.max(50, dt / speedUp)));
  };
  step();
  return () => clearTimeout(timer);
}

function startDrive(replay = false) {
  const a = state.analysis;
  if (!a || !a.corners.length) {
    toast('No corners to call on this course.');
    return;
  }
  if (state.rec || (!replay && !gpsSupported())) return;
  stopWarmup();
  const d = {
    replay,
    hint: -1,
    prevIdx: null,
    lap: 0,
    last: null,
    announced: new Set(),
    voice: !!state.settings.voice,
    marker: L.circleMarker([a.samples[0].lat, a.samples[0].lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#3fa7ff', fillOpacity: 1 }).addTo(liveLayer),
  };
  state.drive = d;
  document.body.classList.add('fullmode');
  $('drive').hidden = false;
  $('dcUnit').textContent = speedUnit();
  setVoiceButton();
  map.invalidateSize();
  map.setView([a.samples[0].lat, a.samples[0].lon], 17);
  showCard(null);
  if (d.voice) speak('Pace notes ready');
  d.stop = replay ? replaySource(onDriveFix) : watchGPS(onDriveFix, null, true);
  keepAwake(true);
}

function stopDrive() {
  const d = state.drive;
  if (!d) return;
  d.stop?.();
  state.drive = null;
  liveLayer.clearLayers();
  keepAwake(false);
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  $('drive').hidden = true;
  document.body.classList.remove('fullmode');
  map.invalidateSize();
  initWarmup();
}

function setVoiceButton() {
  const on = state.drive?.voice;
  $('dcVoice').textContent = on ? 'Voice on' : 'Voice off';
  $('dcVoice').setAttribute('aria-pressed', String(!!on));
}

function onDriveFix(fix) {
  const d = state.drive;
  const a = state.analysis;
  if (!d || !a) return;
  const n = a.samples.length;
  const loc = locate(a, fix.lat, fix.lon, d.hint);
  d.hint = loc.index;

  let v = fix.speed;
  if (!Number.isFinite(v) && d.last && Number.isFinite(fix.t) && Number.isFinite(d.last.t)) {
    const dt = Math.abs(fix.t - d.last.t) / 1000;
    if (dt > 0) v = haversine(d.last, fix) / dt;
  }
  d.last = fix;
  if (!Number.isFinite(v)) v = 0;

  if (a.closed && d.prevIdx !== null) {
    if (d.prevIdx - loc.index > n / 2) d.lap++;
    else if (loc.index - d.prevIdx > n / 2) d.lap--;
  }
  d.prevIdx = loc.index;

  d.marker.setLatLng([fix.lat, fix.lon]);
  map.panTo([fix.lat, fix.lon], { animate: true, duration: 0.4 });
  $('dcSpeed').textContent = Math.round(toUnit(v * 3.6));
  $('dcGps').textContent = `${d.replay ? 'Replay ×2 · ' : ''}GPS ±${Math.round(fix.acc)} m`;
  $('dcGps').className = `dc-gps ${accClass(fix.acc)}`;

  if (loc.offset > 40) {
    showCard(null, `${Math.round(loc.offset)} m off course`);
    return;
  }
  const ahead = cornersAhead(a, loc.index, 2);
  const [next, after] = ahead;
  const lead = Math.max(60, v * Number(state.settings.leadSeconds || 5));
  showCard(next, null, after, v * 3.6, lead);

  if (!next) return;
  const key = (item) => {
    if (!a.closed) return item.corner.number;
    let lap = d.lap;
    if (item.distance > 0 && item.corner.startIdx < loc.index) lap++;
    if (item.distance === 0 && item.corner.startIdx > loc.index) lap--;
    return `${item.corner.number}:${lap}`;
  };
  if (next.distance <= lead && !d.announced.has(key(next))) {
    d.announced.add(key(next));
    let text = spokenNote(next.corner);
    if (next.corner.into && after) {
      d.announced.add(key(after));
      text += `, into ${spokenNote(after.corner)}`;
    }
    if (d.voice) speak(text);
  }
}

const arrowFor = (c) => (c.dir === 'L' ? (c.grade === 'H' ? '↶' : '↰') : c.grade === 'H' ? '↷' : '↱');

function showCard(item, message, after, kmh = 0, lead = 0) {
  const card = $('dcCard');
  card.classList.toggle('offcourse', !item);
  card.classList.remove('over');
  if (!item) {
    card.style.background = '';
    card.style.color = '';
    $('dcDist').textContent = message ?? 'Waiting for GPS…';
    $('dcNum').textContent = '';
    $('dcArrow').textContent = '';
    $('dcGrade').textContent = message ? 'Off course' : '—';
    $('dcGrade').style.fontSize = '';
    $('dcMods').textContent = '';
    $('dcTarget').textContent = '—';
    $('dcNext').textContent = '';
    return;
  }
  const c = item.corner;
  const g = GRADE[c.grade];
  card.style.background = g.color;
  card.style.color = g.ink;
  $('dcDist').textContent = item.distance === 0 ? 'NOW' : `${Math.round(item.distance / 10) * 10} m`;
  $('dcNum').textContent = `#${c.number}`;
  $('dcArrow').textContent = arrowFor(c);
  $('dcGrade').textContent = g.id === 'H' || g.id === 'F' ? g.name.toUpperCase() : g.name;
  $('dcGrade').style.fontSize = g.name.length > 2 ? 'clamp(44px, 11vh, 100px)' : '';
  const mods = [c.long && 'long', c.tightens && 'tightens', c.opens && 'opens', c.into && after && 'into'].filter(Boolean);
  if (c.note) mods.push(c.note);
  $('dcMods').textContent = mods.join(' · ');
  $('dcTarget').textContent = fmtSpeed(c.speedKmh);
  card.classList.toggle('over', item.distance <= lead && kmh > c.speedKmh * 1.1);
  $('dcNext').innerHTML = after
    ? `then <span class="chip" style="background:${GRADE[after.corner.grade].color};color:${GRADE[after.corner.grade].ink}">${esc(shortLabel(after.corner))}</span> ${esc(noteText(after.corner))} in ${fmtDist(after.distance)}`
    : state.analysis.closed
      ? ''
      : 'then finish';
}

$('driveBtn').addEventListener('click', () => startDrive(false));
$('replayBtn').addEventListener('click', () => startDrive(true));
$('dcExit').addEventListener('click', stopDrive);
$('dcVoice').addEventListener('click', () => {
  if (!state.drive) return;
  state.drive.voice = !state.drive.voice;
  state.settings.voice = state.drive.voice;
  saveSettings();
  setVoiceButton();
  if (state.drive.voice) speak('Voice on');
  else speechSynthesis.cancel();
});

// ---------------------------------------------------------------------------
// Start-up

initSettings();
renderCourseList();
renderCorners();
const last = state.courses.find((c) => c.id === state.settings.lastCourse) ?? state.courses[0];
if (last) selectCourse(last, true);
recoverRecording();
initWarmup();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for debugging from the console.
window.rcp = { state, analyse };
