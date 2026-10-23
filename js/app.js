import {
  analyzeCourse,
  colourRuns,
  cornersAhead,
  DEFAULTS,
  GRADE,
  GRADES,
  HAZARD_LEVELS,
  haversine,
  hazardLevelFromSpeech,
  hazardsAhead,
  locate,
  joinTracks,
  noteText,
  placeHazards,
  positionAtTime,
  shortLabel,
  spokenNote,
  SURFACES,
} from './analysis.js';
import { parseGPXHazards, parseTrackFile, toGeoJSON, toGPX, toKML, toPaceNotesCSV } from './formats.js';

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
// Points are stored as [lat, lon, time, accuracy, speed] plus a trailing 1 for gap-filled points.
const pack = (pts) =>
  pts.map((p) => {
    const row = [r7(p.lat), r7(p.lon), Number.isFinite(p.t) ? p.t : null, r1(p.acc), r1(p.speed)];
    if (p.filled) row.push(1);
    return row;
  });
const unpack = (rows) =>
  rows.map(([lat, lon, t, acc, speed, filled]) => ({ lat, lon, t: t ?? NaN, acc: acc ?? NaN, speed: speed ?? NaN, filled: filled === 1 }));

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
  voiceChoice: 'default',
  gpxNames: 'full',
  cornerSort: 'track',
  leadSeconds: 5,
  callMode: 'distance',
  callDistance: 100,
  sayDistance: true,
  driveZoom: 17,
  autoStop: false,
  listen: true,
  lastCourse: null,
};

const state = {
  settings: { ...APP_DEFAULTS, ...store.get(SETTINGS_KEY, {}) },
  courses: store.get(COURSES_KEY, []),
  course: null,
  analysis: null,
  runs: [],
  hazards: [],
  markers: new Map(),
  hazardMarkers: new Map(),
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

// On phones that support it, open the share sheet (Save to Files, AirDrop, WhatsApp…);
// otherwise download the file.
async function shareOrDownload(name, text, type) {
  try {
    const file = new File([text], name, { type });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return; // share sheet closed
  }
  download(name, text, type);
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
function hazardIcon(level) {
  const h = HAZARD_LEVELS[level];
  return L.divIcon({
    className: 'hazard-marker',
    html: `<div style="background:${h.color};color:${h.ink}">!</div>`,
    iconSize: [28, 25],
    iconAnchor: [14, 20],
  });
}
const hzChip = (level) => `<span class="hz-chip" style="background:${HAZARD_LEVELS[level].color};color:${HAZARD_LEVELS[level].ink}">!</span>`;
// Chequered flag on a pole with a label; the pole's foot sits on the start/finish point.
function flagIcon(label) {
  const cell = 5;
  let squares = '';
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 6; c++) {
      squares += `<rect x="${6 + c * cell}" y="${3 + r * cell}" width="${cell}" height="${cell}" fill="${(r + c) % 2 ? '#fff' : '#000'}"/>`;
    }
  }
  const svg = `<svg width="38" height="48" viewBox="0 0 38 48" aria-hidden="true">
    <line x1="5" y1="2" x2="5" y2="47" stroke="#000" stroke-width="5" stroke-linecap="round"/>
    <line x1="5" y1="2" x2="5" y2="47" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
    ${squares}
    <rect x="6" y="3" width="30" height="20" fill="none" stroke="#000" stroke-width="1.5"/>
  </svg>`;
  return L.divIcon({ className: '', html: `<div class="flag-marker">${svg}<span>${label}</span></div>`, iconSize: [150, 48], iconAnchor: [5, 47] });
}

// A chequered bar across the track at the start line, square to the direction of travel.
function startLine(a, layer) {
  const { _x: x, _y: y, _proj: proj } = a;
  const k = Math.min(5, x.length - 1);
  const dx = x[k] - x[0];
  const dy = y[k] - y[0];
  const len = Math.hypot(dx, dy) || 1;
  const [nx, ny] = [-dy / len, dx / len];
  const half = 12;
  const ends = [proj.toLatLon(x[0] + nx * half, y[0] + ny * half), proj.toLatLon(x[0] - nx * half, y[0] - ny * half)];
  L.polyline(ends, { color: '#fff', weight: 9, opacity: 1, interactive: false }).addTo(layer);
  L.polyline(ends, { color: '#000', weight: 9, opacity: 1, dashArray: '4 4', lineCap: 'butt', interactive: false }).addTo(layer);
}

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
  // Gap-filled stretches (from joining two recordings) are dotted: they weren't driven with GPS on.
  let gapRun = null;
  for (const p of a.closed ? [...a.samples, a.samples[0]] : a.samples) {
    if (p.filled) {
      gapRun ??= [];
      gapRun.push([p.lat, p.lon]);
    } else if (gapRun) {
      gapRun.push([p.lat, p.lon]);
      L.polyline(gapRun, { color: '#000', weight: 7, dashArray: '2 10', opacity: 0.9, interactive: false }).addTo(courseLayer);
      gapRun = null;
    }
  }
  if (gapRun) L.polyline(gapRun, { color: '#000', weight: 7, dashArray: '2 10', opacity: 0.9, interactive: false }).addTo(courseLayer);
  startLine(a, courseLayer);
  const sameSpot = a.closed || map.distance(all[0], all.at(-1)) < 40;
  const startLabel = sameSpot ? 'START / FINISH' : 'START';
  L.marker(all[0], { icon: flagIcon(startLabel), title: startLabel, zIndexOffset: 1000 }).addTo(courseLayer);
  if (!sameSpot) L.marker(all.at(-1), { icon: flagIcon('FINISH'), title: 'Finish', zIndexOffset: 1000 }).addTo(courseLayer);
  for (const c of a.corners) {
    const m = L.marker([c.lat, c.lon], { icon: cornerIcon(c), title: `${c.number}: ${noteText(c)}`, riseOnHover: true });
    m.bindPopup(() => popupHtml(c), { maxWidth: 270, autoPanPadding: [20, 20] });
    m.addTo(courseLayer);
    state.markers.set(c.number, m);
  }
  state.hazardMarkers.clear();
  (state.course.hazards ?? []).forEach((h, i) => {
    const m = L.marker([h.lat, h.lon], { icon: hazardIcon(h.level), title: `${HAZARD_LEVELS[h.level].label} hazard`, zIndexOffset: 200 });
    m.bindPopup(() => hazardPopupHtml(i), { maxWidth: 240 });
    m.addTo(courseLayer);
    state.hazardMarkers.set(i, m);
  });
  // Leave room at the bottom for the Record button so the start flag isn't hidden under it.
  if (fit) map.fitBounds(L.latLngBounds(all), { paddingTopLeft: [30, 40], paddingBottomRight: [30, 110] });
}

function hazardPopupHtml(i) {
  const h = state.course.hazards[i];
  const placed = state.hazards.find((x) => x.id === i);
  const options = Object.entries(HAZARD_LEVELS)
    .map(([id, l]) => `<option value="${id}" ${h.level === id ? 'selected' : ''}>${l.label}</option>`)
    .join('');
  return `<div class="pop" data-hazard="${i}">
    <h3>${HAZARD_LEVELS[h.level].label} hazard</h3>
    <dl><dt>From start</dt><dd>${placed ? fmtDist(placed.s) : 'off the course line'}</dd></dl>
    <div class="edit">
      <select data-f="level" aria-label="Hazard level">${options}</select>
      <button class="btn" data-f="save">Save</button>
      <button class="btn btn-ghost" data-f="delete">Delete hazard</button>
    </div>
  </div>`;
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
      ${c.guessed ? '<dt>Note</dt><dd class="guessed">In a filled gap: shape is a guess</dd>' : ''}
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
  if (el.dataset.hazard !== undefined) {
    const i = Number(el.dataset.hazard);
    el.querySelector('[data-f="save"]').addEventListener('click', () => {
      state.course.hazards[i].level = el.querySelector('[data-f="level"]').value;
      saveCourses();
      map.closePopup();
      analyse();
    });
    el.querySelector('[data-f="delete"]').addEventListener('click', () => {
      state.course.hazards.splice(i, 1);
      saveCourses();
      map.closePopup();
      analyse();
      toast('Hazard deleted');
    });
    return;
  }
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

function analysisOptions(course) {
  const s = state.settings;
  return {
    surface: s.surface,
    confidence: Number(s.confidence),
    topSpeedKmh: Number(s.topSpeedKmh),
    smoothing: Number(s.smoothing),
    straightRadius: Number(s.straightRadius),
    minAngle: Number(s.minAngle),
    courseType: s.courseType,
    reverse: s.reverse,
    overrides: course.overrides?.[overrideKey()] ?? [],
  };
}

function analyse(fit = false) {
  state.analysis = null;
  if (state.course) {
    try {
      state.analysis = analyzeCourse(unpack(state.course.points), analysisOptions(state.course));
    } catch (e) {
      toast(e.message);
    }
  }
  state.hazards = state.analysis ? placeHazards(state.analysis, state.course.hazards ?? []) : [];
  renderMap(fit);
  renderCorners();
  renderCourseList();
  $('courseName').textContent = state.course ? state.course.name : 'No course loaded';
}

// GPX of a saved course: its recorded track plus corners and hazards as waypoints.
function exportGPX(course) {
  let corners = [];
  try {
    corners = (course === state.course && state.analysis ? state.analysis : analyzeCourse(unpack(course.points), analysisOptions(course))).corners;
  } catch {
    /* too short to analyse: export the track alone */
  }
  const gpx = toGPX(course.name, unpack(course.points), { corners, hazards: course.hazards ?? [], fmtSpeed, names: state.settings.gpxNames });
  shareOrDownload(`${course.name.replace(/[^\w-]+/g, '_')}.gpx`, gpx, 'application/gpx+xml');
}

function addCourse(name, points, hazards = []) {
  const course = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    created: Date.now(),
    points: pack(points),
    hazards: hazards.map((h) => ({ lat: r7(h.lat), lon: r7(h.lon), level: h.level, t: h.t ?? null })),
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

function renderJoinCard() {
  $('joinCard').hidden = state.courses.length < 2;
  if (state.courses.length < 2) return;
  const label = (c) => `${new Date(c.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${c.points.length} fixes · ${c.name}`;
  const options = state.courses.map((c) => `<option value="${c.id}">${esc(label(c))}</option>`).join('');
  const keepA = $('joinA').value;
  const keepB = $('joinB').value;
  $('joinA').innerHTML = options;
  $('joinB').innerHTML = options;
  // Default: the two newest recordings, older one first.
  const has = (id) => state.courses.some((c) => c.id === id);
  $('joinA').value = has(keepA) ? keepA : state.courses[1].id;
  $('joinB').value = has(keepB) ? keepB : state.courses[0].id;
}

$('joinBtn').addEventListener('click', () => {
  const a = state.courses.find((c) => c.id === $('joinA').value);
  const b = state.courses.find((c) => c.id === $('joinB').value);
  if (!a || !b || a === b) {
    toast('Pick two different recordings to join.');
    return;
  }
  try {
    const res = joinTracks(unpack(a.points), unpack(b.points));
    const when = new Date(a.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    addCourse(`Joined lap ${when}`, res.points, [...(a.hazards ?? []), ...(b.hazards ?? [])]);
    $('joinA').value = '';
    $('joinB').value = '';
    renderJoinCard();
    toast(
      res.overlapTrimmed
        ? 'Joined. The two parts overlapped, so the overlap was trimmed.'
        : res.gap >= 3
          ? `Joined. A ${Math.round(res.gap)} m gap was filled in (dotted on the map); any corner in it is a guess.`
          : 'Joined into one course.',
      7000,
    );
  } catch (e) {
    toast(e.message);
  }
});

function renderCourseList() {
  renderJoinCard();
  const ul = $('courseList');
  if (!state.courses.length) {
    ul.innerHTML = '<li class="muted">Nothing saved yet.</li>';
    return;
  }
  ul.innerHTML = state.courses
    .map(
      (c) => `<li class="${state.course?.id === c.id ? 'active' : ''}" data-id="${c.id}">
        <span class="name" data-act="open"><b>${esc(c.name)}</b><small>${new Date(c.created).toLocaleDateString()} · ${c.points.length} fixes${c.hazards?.length ? ` · ${c.hazards.length} hazards` : ''}</small></span>
        <button class="icon-btn gpx-btn" data-act="gpx" aria-label="Export GPX" title="Export GPX">GPX</button>
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
  if (act === 'gpx') exportGPX(course);
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
    <div><small>Slowest</small><b>${slowest ? `#${slowest.number} ${shortLabel(slowest)}` : '—'}</b></div>
    <div><small>Hazards</small><b>${state.course.hazards?.length ?? 0}</b></div>`;
  $('legend').innerHTML = GRADES.map(
    (g, i) => `<span><span class="chip" style="background:${g.color};color:${g.ink}">${g.id}</span>${gradeRange(g, i)}</span>`,
  ).join('');
  const tight = state.settings.cornerSort === 'tight';
  document.querySelectorAll('#cornerSort [data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === state.settings.cornerSort)));
  const km = (m) => `${(m / 1000).toFixed(2)} km`;
  const list = tight ? [...a.corners].sort((x, y) => x.radius - y.radius) : a.corners;
  $('cornerList').classList.toggle('tight', tight);
  $('cornerList').innerHTML = list
    .map((c, i) => {
      const g = GRADE[c.grade];
      const edited = c.grade !== c.autoGrade || c.note ? '<span class="edited">edited</span>' : '';
      const guessed = c.guessed ? ' · <span class="guessed">guessed (filled gap)</span>' : '';
      if (tight) {
        // Tightest first: rank, rating, where it is on the track, and the radius up front.
        return `<li data-n="${c.number}">
        <span class="n">${i + 1}</span>
        <span class="chip" style="background:${g.color};color:${g.ink}">${esc(shortLabel(c))}</span>
        <span class="txt"><b>${esc(noteText(c))}${edited}</b><small>at ${km(c.startS)} · ${Math.round(c.angle)}° · target ${fmtSpeed(c.speedKmh)}${guessed}</small></span>
        <span class="spd"><b>${Math.round(c.radius)} m</b><small>radius</small></span>
      </li>`;
      }
      const driven = c.drivenKmh !== null ? ` · you did ${Math.round(toUnit(c.drivenKmh))}` : '';
      return `<li data-n="${c.number}">
        <span class="n">${c.number}</span>
        <span class="chip" style="background:${g.color};color:${g.ink}">${esc(shortLabel(c))}</span>
        <span class="txt"><b>${esc(noteText(c))}${edited}</b><small>${Math.round(c.radius)} m radius · ${Math.round(c.angle)}° · at ${fmtDist(c.startS)}${driven}${guessed}</small></span>
        <span class="spd"><b>${Math.round(toUnit(c.speedKmh))}</b><small>${speedUnit()}</small></span>
      </li>`;
    })
    .join('');
  const hz = state.course.hazards ?? [];
  $('hazardTitle').hidden = !hz.length;
  $('hazardList').innerHTML = hz
    .map((h, i) => {
      const placed = state.hazards.find((x) => x.id === i);
      return `<li data-hz="${i}"><span class="n">${i + 1}</span>${hzChip(h.level)}<span class="txt"><b>${HAZARD_LEVELS[h.level].label} hazard</b><small>${placed ? `at ${fmtDist(placed.s)}` : 'off the course line'}</small></span></li>`;
    })
    .join('');
  $('replayBtn').hidden = !state.course;
}

$('hazardList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-hz]');
  if (!li) return;
  const i = Number(li.dataset.hz);
  const h = state.course.hazards[i];
  map.flyTo([h.lat, h.lon], Math.max(map.getZoom(), 17), { duration: 0.6 });
  setTimeout(() => state.hazardMarkers.get(i)?.openPopup(), 650);
});

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

$('cornerSort').addEventListener('click', (e) => {
  const sort = e.target.closest('[data-sort]')?.dataset.sort;
  if (!sort || sort === state.settings.cornerSort) return;
  state.settings.cornerSort = sort;
  saveSettings();
  renderCorners();
  $('cornerSort').scrollIntoView({ block: 'nearest' });
});

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
    const hz = state.hazards;
    if (kind === 'kml') download(`${base}.kml`, toKML(state.course.name, a, state.runs, fmtSpeed, hz), 'application/vnd.google-earth.kml+xml');
    if (kind === 'geojson') download(`${base}.geojson`, toGeoJSON(state.course.name, a, state.runs, hz), 'application/geo+json');
    if (kind === 'csv') download(`${base}-pace-notes.csv`, toPaceNotesCSV(a, (k) => Math.round(toUnit(k)), hz), 'text/csv');
    if (kind === 'gpx') exportGPX(state.course);
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
  populateVoices();
  $('surfaceSelect').innerHTML = Object.entries(SURFACES)
    .map(([id, s]) => `<option value="${id}">${s.label} (grip ${s.mu})</option>`)
    .join('');
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!state.settings[el.name];
    else el.value = state.settings[el.name];
  }
  $('confOut').textContent = `${Math.round(state.settings.confidence * 100)}%`;
  showCallRows();
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
    } else if (el.name === 'callMode') {
      showCallRows();
    } else if (el.name === 'gpxNames') {
      // Used at export time only.
    } else if (el.name === 'voiceChoice') {
      updateVoiceInfo();
    } else if (!['voice', 'leadSeconds', 'callDistance', 'sayDistance', 'autoStop', 'listen'].includes(el.name)) {
      analyse();
    }
  });
}

// Only show the setting for the chosen way of timing calls.
function showCallRows() {
  document.querySelectorAll('[data-call]').forEach((el) => (el.hidden = el.dataset.call !== state.settings.callMode));
}

// ---------------------------------------------------------------------------
// Map follow while recording or driving. The map tracks your position, but pauses while you
// pinch or zoom so the gesture isn't fought, and stops if you drag it away until Re-centre.

const follow = { on: true, holdUntil: 0, touching: false };

function followTo(latlng, animate = true) {
  if (!follow.on || follow.touching || map._animatingZoom || Date.now() < follow.holdUntil) return;
  map.panTo(latlng, animate ? { animate: true, duration: 0.4 } : { animate: false });
}

function resetFollow() {
  follow.on = true;
  follow.holdUntil = 0;
  recentreControl.getContainer().hidden = true;
}

const followActive = () => !!(state.rec || state.drive);
const mapEl = map.getContainer();
mapEl.addEventListener('touchstart', () => (follow.touching = true), { passive: true });
mapEl.addEventListener('touchend', () => {
  follow.touching = false;
  follow.holdUntil = Date.now() + 800;
});
map.on('zoomstart', () => (follow.holdUntil = Date.now() + 800));
map.on('zoomend', () => {
  follow.holdUntil = Date.now() + 400;
  if (followActive()) {
    state.settings.driveZoom = map.getZoom();
    saveSettings();
  }
});
map.on('dragstart', () => {
  if (!followActive()) return;
  follow.on = false;
  recentreControl.getContainer().hidden = false;
});

const RecentreControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const btn = L.DomUtil.create('button', 'recentre-btn');
    btn.type = 'button';
    btn.textContent = 'Re-centre';
    btn.hidden = true;
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, 'click', () => {
      resetFollow();
      const at = state.drive?.last ?? state.rec?.points.at(-1);
      if (at) map.panTo([at.lat, at.lon]);
    });
    return btn;
  },
});
const recentreControl = new RecentreControl().addTo(map);

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
    hazards: [],
    hazardMarkers: [],
    line: L.polyline([], { color: '#ff3b30', weight: 5 }).addTo(liveLayer),
    dot: null,
  };
  state.rec = rec;
  resetFollow();
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
  document.body.classList.add('recording-on');
  map.invalidateSize();
  unlockAudio();
  updateHazardInfo();
  if (state.settings.listen) startListening();
  updateMic();
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
      L.marker([p.lat, p.lon], { icon: flagIcon('START'), interactive: false, zIndexOffset: 1000 }).addTo(liveLayer);
    }
    rec.lastGood = p;
    rec.line.addLatLng([p.lat, p.lon]);
    if (prev) checkLap(rec, prev, p);
    if (state.rec !== rec) return; // the lap check stopped the recording
  }

  if (!rec.dot) {
    rec.dot = L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#ff3b30', fillOpacity: 1 }).addTo(liveLayer);
    map.setView([p.lat, p.lon], state.settings.driveZoom || 17);
  } else {
    rec.dot.setLatLng([p.lat, p.lon]);
    followTo([p.lat, p.lon]);
  }
  if (rec.points.length % 5 === 0) saveRecordingDraft(rec);
  updateRecStats();
}

const saveRecordingDraft = (rec) => store.set(REC_KEY, { started: rec.started, points: pack(rec.points), hazards: rec.hazards });

// ---------------------------------------------------------------------------
// Hazards while recording: big colour buttons, or say the colour.

let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

// Confirmation tones: one beep for green, two for orange, three lower beeps for red. Tones
// rather than speech, so the recogniser can't hear the app saying a colour and mark it again.
function hazardBeep(level) {
  if (!audioCtx) return;
  const { freq, count } = { green: { freq: 880, count: 1 }, orange: { freq: 660, count: 2 }, red: { freq: 440, count: 3 } }[level];
  for (let i = 0; i < count; i++) {
    const t = audioCtx.currentTime + i * 0.18;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.14);
  }
}

let flashTimer;
function markHazard(level, at = Date.now(), how = 'tap') {
  const rec = state.rec;
  if (!rec) return;
  const good = rec.points.filter((p) => p.acc <= DEFAULTS.maxAccuracy);
  const pos = positionAtTime(good, at);
  if (!pos) {
    toast('Waiting for GPS before hazards can be marked');
    return;
  }
  rec.hazards.push({ lat: pos.lat, lon: pos.lon, level, t: at });
  rec.hazardMarkers.push(L.marker([pos.lat, pos.lon], { icon: hazardIcon(level), interactive: false }).addTo(liveLayer));
  saveRecordingDraft(rec);
  hazardBeep(level);
  navigator.vibrate?.(level === 'red' ? [80, 60, 80, 60, 80] : level === 'orange' ? [80, 60, 80] : 80);
  const screen = $('recScreen');
  screen.classList.remove('flash-green', 'flash-orange', 'flash-red');
  screen.classList.add(`flash-${level}`);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => screen.classList.remove(`flash-${level}`), 900);
  updateHazardInfo(`${HAZARD_LEVELS[level].label} marked${how === 'voice' ? ' (voice)' : ''}`);
}

function undoHazard() {
  const rec = state.rec;
  if (!rec?.hazards.length) return;
  const h = rec.hazards.pop();
  rec.hazardMarkers.pop()?.remove();
  saveRecordingDraft(rec);
  updateHazardInfo(`${HAZARD_LEVELS[h.level].label} hazard removed`);
}

function updateHazardInfo(message) {
  const rec = state.rec;
  const n = rec?.hazards.length ?? 0;
  $('rsHzCount').textContent = n;
  $('rsUndo').disabled = !n;
  $('rsHzInfo').textContent = message ?? (n ? `${n} hazard${n > 1 ? 's' : ''} marked` : 'Tap a colour or say it to mark a hazard');
}

document.querySelectorAll('.rs-hazards .hz').forEach((btn) =>
  btn.addEventListener('click', () => markHazard(btn.dataset.level, Date.now(), 'tap')),
);
$('rsUndo').addEventListener('click', undoHazard);

// Voice: continuous speech recognition while recording. Phones end recognition sessions after
// silence, so it restarts itself until the recording stops.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const listen = { recognizer: null, blocked: false, warned: false };

function startListening() {
  if (!SpeechRec || listen.recognizer || listen.blocked || !state.rec) return;
  const r = new SpeechRec();
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 3;
  r.lang = navigator.language || 'en-GB';
  const handled = new Set();
  let speechAt = null;
  r.onspeechstart = () => (speechAt = Date.now());
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (handled.has(i)) continue;
      const res = e.results[i];
      const level = hazardLevelFromSpeech(Array.from(res, (alt) => alt.transcript).join(' '));
      if (!level) continue;
      handled.add(i);
      // Place it where you started speaking; recognition lags the words by about a second.
      const at = speechAt && Date.now() - speechAt < 6000 ? speechAt : Date.now() - 1000;
      speechAt = null;
      markHazard(level, at, 'voice');
    }
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      listen.blocked = true;
      toast('Microphone not allowed: use the colour buttons, or allow the microphone in your browser settings.', 6000);
    } else if (e.error === 'network' && !listen.warned) {
      listen.warned = true;
      toast('Voice hazard calls need mobile data on this phone. Use the colour buttons until signal returns.', 6000);
    }
  };
  r.onend = () => {
    if (listen.recognizer !== r) return;
    listen.recognizer = null;
    if (state.rec && state.settings.listen && !listen.blocked) setTimeout(startListening, 400);
    updateMic();
  };
  try {
    r.start();
    listen.recognizer = r;
  } catch {
    /* already started or not allowed yet */
  }
  updateMic();
}

function stopListening() {
  const r = listen.recognizer;
  listen.recognizer = null;
  try {
    r?.abort();
  } catch {
    /* ignore */
  }
  updateMic();
}

function updateMic() {
  const btn = $('rsMic');
  if (!SpeechRec) {
    btn.hidden = true;
    return;
  }
  const on = !!listen.recognizer || (state.settings.listen && !!state.rec && !listen.blocked);
  btn.textContent = listen.blocked ? 'Mic blocked' : on ? 'Listening' : 'Voice off';
  btn.setAttribute('aria-pressed', String(on && !listen.blocked));
}

$('rsMic').addEventListener('click', () => {
  listen.blocked = false;
  state.settings.listen = !(state.settings.listen && listen.recognizer);
  saveSettings();
  $('settingsForm').elements.listen.checked = state.settings.listen;
  if (state.settings.listen) startListening();
  else stopListening();
  updateMic();
});

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
  $('rsDist').innerHTML = rec.dist >= 1000 ? `${(rec.dist / 1000).toFixed(2)} <span class="unit">km</span>` : `${Math.round(rec.dist)} <span class="unit">m</span>`;
  $('rsSpeed').textContent = Math.round(toUnit(rec.speed * 3.6));
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
  resetFollow();
  stopListening();
  keepAwake(false);
  store.del(REC_KEY);
  $('recScreen').hidden = true;
  document.body.classList.remove('fullmode', 'recording-on');
  map.invalidateSize();
  initWarmup();
  if (discard) return;
  if (rec.points.length < 10) {
    toast('Not enough GPS fixes were recorded to make a course.');
    return;
  }
  addCourse(`Recorded ${new Date(rec.started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`, rec.points, rec.hazards);
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
    addCourse(`Recovered ${new Date(saved.started).toLocaleString()}`, unpack(saved.points), saved.hazards ?? []);
  }
}

// ---------------------------------------------------------------------------
// Import

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const points = parseTrackFile(text, file.name);
    // GPX files exported from this app also bring their hazards back.
    const hazards = /<gpx[\s>]/i.test(text.slice(0, 500)) ? parseGPXHazards(text) : [];
    addCourse(file.name.replace(/\.[^.]+$/, ''), points, hazards);
    if (hazards.length) toast(`Imported with ${hazards.length} hazard${hazards.length > 1 ? 's' : ''}.`);
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

// ---------------------------------------------------------------------------
// Voices. Speech uses the voices installed on the phone. Browsers don't say whether a voice is
// male or female, so the presets match well-known voice names (iPhone, Android, Windows, Mac).

const VOICE_PRESETS = {
  'us-female': {
    label: 'American female',
    lang: 'en-us',
    prefer: ['Samantha', 'Ava', 'Allison', 'Susan', 'Zoe', 'Nicky', 'Evelyn', 'Google US English', 'Aria', 'Jenny', 'Zira', 'Michelle', 'Joanna', 'Salli', 'Kendra', 'Kimberly', 'Ivy', 'en-us-x-sfg', 'en-us-x-iob', 'en-us-x-tpf', 'en-us-x-iog'],
    avoid: ['Alex', 'Fred', 'Tom', 'Aaron', 'Evan', 'Nathan', 'David', 'Mark', 'Guy', 'Ryan', 'Christopher', 'Eric', 'Steffan', 'Roger', 'Daniel', 'Junior', 'Ralph', 'en-us-x-iol', 'en-us-x-iom', 'en-us-x-tpd'],
  },
  'in-male': {
    label: 'Indian male',
    lang: 'en-in',
    prefer: ['Rishi', 'Prabhat', 'Ravi', 'Hemant', 'Kunal', 'Aarav', 'en-in-x-end', 'en-in-x-ene', 'en-in-x-cxx'],
    avoid: ['Veena', 'Lekha', 'Isha', 'Heera', 'Neerja', 'Aditi', 'Raveena', 'Kajal', 'Priya', 'Swara', 'Sangeeta', 'en-in-x-ena', 'en-in-x-enc', 'en-in-x-ahp'],
  },
};

const voiceLang = (v) => v.lang.replace('_', '-').toLowerCase();
const nameHas = (v, list) => list.some((n) => `${v.name} ${v.voiceURI}`.toLowerCase().includes(n.toLowerCase()));
const allVoices = () => ('speechSynthesis' in window ? speechSynthesis.getVoices() : []);

// The voice to use for the current setting, and whether we're sure it matches (male/female).
function resolveVoice(choice = state.settings.voiceChoice) {
  const voices = allVoices();
  if (choice?.startsWith('uri:')) {
    const v = voices.find((x) => x.voiceURI === choice.slice(4));
    return { voice: v ?? null, sure: !!v };
  }
  const preset = VOICE_PRESETS[choice];
  if (!preset) return { voice: null, sure: true };
  const same = voices.filter((v) => voiceLang(v) === preset.lang);
  const named = same.find((v) => nameHas(v, preset.prefer));
  if (named) return { voice: named, sure: true };
  const fallback = same.find((v) => !nameHas(v, preset.avoid));
  return { voice: fallback ?? null, sure: false };
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.15;
  const { voice, sure } = resolveVoice();
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
    // A male preset that fell back to a voice of unknown gender is pitched down a little.
    if (!sure && state.settings.voiceChoice === 'in-male') u.pitch = 0.8;
  }
  speechSynthesis.speak(u);
}

function populateVoices() {
  const sel = $('voiceSelect');
  const english = allVoices().filter((v) => voiceLang(v).startsWith('en'));
  const presets = Object.entries(VOICE_PRESETS).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');
  const others = english
    .map((v) => `<option value="uri:${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`)
    .join('');
  sel.innerHTML = `<option value="default">Phone default</option>${presets}${others ? `<optgroup label="All English voices on this phone">${others}</optgroup>` : ''}`;
  sel.value = state.settings.voiceChoice;
  if (sel.value !== state.settings.voiceChoice) sel.value = 'default';
  updateVoiceInfo();
}

function updateVoiceInfo() {
  const info = $('voiceInfo');
  if (!('speechSynthesis' in window)) {
    info.textContent = 'This browser cannot speak.';
    return;
  }
  const choice = state.settings.voiceChoice;
  const { voice, sure } = resolveVoice(choice);
  const preset = VOICE_PRESETS[choice];
  if (!preset) {
    info.textContent = voice ? `Using ${voice.name}.` : 'Using the phone\'s default voice.';
    return;
  }
  const install =
    choice === 'in-male'
      ? 'iPhone: Settings → Accessibility → Spoken Content → Voices → English → India → Rishi. Android: Settings → Text-to-speech → Google → Install voice data → English (India).'
      : 'iPhone: Settings → Accessibility → Spoken Content → Voices → English → United States → Samantha or Ava. Android: Settings → Text-to-speech → Google → Install voice data → English (United States).';
  if (!voice) info.textContent = `No ${preset.label} voice is installed on this phone, so the default is used. To add one: ${install}`;
  else if (!sure) info.textContent = `Using ${voice.name} (${voice.lang}); it may not be ${choice === 'in-male' ? 'male' : 'female'}. For a better match: ${install}`;
  else info.textContent = `Using ${voice.name} (${voice.lang}).`;
}

if ('speechSynthesis' in window) speechSynthesis.addEventListener?.('voiceschanged', populateVoices);
$('voiceTest').addEventListener('click', () => speak('100 metres, left 3 tightens, into right 4'));

const REPLAY_SPEEDS = [1, 2, 4, 8, 16];

// Plays the recorded lap back through drive mode. `getSpeed()` is read before every fix so the
// speed button takes effect immediately; `kick()` cuts short the current wait after a change.
function replaySource(onFix, getSpeed) {
  let pts = unpack(state.course.points).filter((p) => !(p.acc > DEFAULTS.maxAccuracy) && !p.filled);
  if (state.settings.reverse) pts = pts.reverse();
  const timed = pts.every((p) => Number.isFinite(p.t));
  let i = 0;
  let timer;
  const step = () => {
    timer = null;
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
    timer = setTimeout(step, Math.min(3000, Math.max(40, dt / getSpeed())));
  };
  step();
  return {
    stop: () => clearTimeout(timer),
    kick: () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = setTimeout(step, 40);
    },
  };
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
    replaySpeed: 2,
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
  resetFollow();
  map.setView([a.samples[0].lat, a.samples[0].lon], state.settings.driveZoom || 17);
  showCard(null);
  if (d.voice) speak('Pace notes ready');
  $('dcReplaySpeed').hidden = !replay;
  setReplaySpeedButton();
  if (replay) {
    const src = replaySource(onDriveFix, () => d.replaySpeed);
    d.stop = src.stop;
    d.kick = src.kick;
  } else {
    d.stop = watchGPS(onDriveFix, null, true);
  }
  keepAwake(true);
}

function stopDrive() {
  const d = state.drive;
  if (!d) return;
  d.stop?.();
  state.drive = null;
  resetFollow();
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
  const fast = d.replay && d.replaySpeed >= 4;
  followTo([fix.lat, fix.lon], !fast);
  $('dcSpeed').textContent = Math.round(toUnit(v * 3.6));
  $('dcGps').textContent = d.replay ? '' : `GPS ±${Math.round(fix.acc)} m`;
  $('dcGps').className = `dc-gps ${accClass(fix.acc)}`;

  if (loc.offset > 40) {
    showCard(null, `${Math.round(loc.offset)} m off course`);
    showHazard(null);
    return;
  }
  const ahead = cornersAhead(a, loc.index, 2);
  const [next, after] = ahead;
  const s = state.settings;
  let lead;
  if (s.callMode === 'time') {
    // When replaying faster, call corners proportionally earlier so the voice still finishes
    // before the corner (capped so a fast replay doesn't call half the lap at once).
    const timeScale = d.replay ? d.replaySpeed : 1;
    lead = Math.min(Math.max(60, v * Number(s.leadSeconds || 5) * timeScale), 400);
  } else {
    lead = Number(s.callDistance) || 100;
  }
  const say = (dist) => (s.sayDistance && dist >= 10 ? `${Math.round(dist / 10) * 10} metres` : '');
  showCard(next, null, after, v * 3.6, lead);
  const hazards = hazardsAhead(a, state.hazards, loc.index, lead);
  showHazard(hazards[0]);

  // Each corner and hazard is called once per lap; keys carry the lap they belong to.
  const lapOf = (idx, inside = false) => {
    if (!a.closed) return 0;
    if (inside) return idx > loc.index ? d.lap - 1 : d.lap;
    return idx < loc.index ? d.lap + 1 : d.lap;
  };
  const key = (item) => `c${item.corner.number}:${lapOf(item.corner.startIdx, item.distance === 0)}`;
  const calls = [];
  for (const { hazard, distance } of hazards) {
    const k = `h${hazard.id}:${lapOf(hazard.index)}`;
    if (d.announced.has(k)) continue;
    d.announced.add(k);
    calls.push([`${hazard.level} hazard`, say(distance)].filter(Boolean).join(', '));
  }
  if (next && next.distance <= lead && !d.announced.has(key(next))) {
    d.announced.add(key(next));
    let text = [say(next.distance), spokenNote(next.corner)].filter(Boolean).join(', ');
    if (next.corner.into && after) {
      d.announced.add(key(after));
      text += `, into ${spokenNote(after.corner)}`;
    }
    calls.push(text);
  }
  if (calls.length && d.voice) speak(calls.join(', '));
}

function showHazard(item) {
  const el = $('dcHazard');
  el.hidden = !item;
  if (!item) return;
  const h = HAZARD_LEVELS[item.hazard.level];
  el.style.background = h.color;
  el.style.color = h.ink;
  el.textContent = `⚠ ${h.label} hazard · ${Math.round(item.distance / 10) * 10} m`;
}

const arrowFor = (c) => (c.dir === 'L' ? (c.hairpin ? '↶' : '↰') : c.hairpin ? '↷' : '↱');

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
    $('dcGrade').style.fontSize = message ? 'clamp(40px, 9vh, 80px)' : '';
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
  $('dcGrade').textContent = g.name;
  $('dcGrade').style.fontSize = '';
  const mods = [c.hairpin && 'hairpin', c.long && 'long', c.tightens && 'tightens', c.opens && 'opens', c.into && after && 'into'].filter(Boolean);
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

function setReplaySpeedButton() {
  const d = state.drive;
  if (!d?.replay) return;
  $('dcReplaySpeed').textContent = `Speed ×${d.replaySpeed}`;
  $('dcReplaySpeed').setAttribute('aria-label', `Replay speed ${d.replaySpeed} times. Tap to change.`);
}

$('dcReplaySpeed').addEventListener('click', () => {
  const d = state.drive;
  if (!d?.replay) return;
  d.replaySpeed = REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(d.replaySpeed) + 1) % REPLAY_SPEEDS.length];
  setReplaySpeedButton();
  d.kick?.();
});
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

// Shown in Settings so you can check a phone has picked up the latest update.
const APP_VERSION = '17';
$('appVersion').textContent = APP_VERSION;

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
window.rcp = { state, analyse, map };
