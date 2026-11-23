/* FloodScope page: map, steps, results. All numbers shown come from the worker's run (js/pipeline.js). */
import { proj4 } from '../vendor/geo-libs.mjs';
import { defineEpsg } from './io.js';
import { CLASS_NAMES, WORLDCOVER } from './exports.js';

const $ = id => document.getElementById(id);
const BASE = new URL('..', import.meta.url).href.replace(/\/$/, '');
const fmt = (v, d = 1) => v == null || !(v === v) ? '—' : new Intl.NumberFormat('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtInt = v => v == null || !(v === v) ? '—' : new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(Math.round(v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLORS = { 2: [21, 84, 192, 235], 3: [111, 163, 240, 220], 4: [11, 42, 74, 200], 5: [201, 198, 189, 150], 6: [143, 185, 179, 190] };
const LIMIT_KM2 = 3600, NOMINATIM = 'https://nominatim.openstreetmap.org';

// ---------------------------------------------------------------- worker
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let seq = 0; const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (data.type === 'progress') { if (p && p.onProgress) p.onProgress(data.msg); return; }
  if (!p) return;
  pending.delete(data.id);
  data.type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data);
};
const ask = (cmd, payload = {}, onProgress) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ cmd, id, ...payload });
});

// ---------------------------------------------------------------- map
const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: [6.76, 7.8], zoom: 2.2,
  attributionControl: false, preserveDrawingBuffer: true, cooperativeGestures: false,
});
// bottom-left: the results drawer covers the bottom-right corner
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
const ready = new Promise(r => map.on('load', r));
ready.then(() => {
  map.addSource('s2', { type: 'raster', tileSize: 256, maxzoom: 15, attribution: 'Sentinel-2 cloudless 2024 by <a href="https://s2maps.eu">EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data 2024)',
    tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'] });
  const first = map.getStyle().layers.find(l => l.type === 'symbol');
  map.addLayer({ id: 's2', type: 'raster', source: 's2', layout: { visibility: 'none' } }, first && first.id);
  map.addSource('aoi', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#1554c0', 'fill-opacity': 0.05 } });
  map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#141412', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
});

// ---------------------------------------------------------------- state
const S = { aoi: null, acq: [], pre: null, post: null, result: null, zones: null };
const ringOf = b => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]];
function areaKm2(b) { // spherical rectangle
  const R = 6371.0088, r = Math.PI / 180;
  return R * R * Math.abs((b[2] - b[0]) * r) * Math.abs(Math.sin(b[3] * r) - Math.sin(b[1] * r));
}
async function setAoi(b, label) {
  const shift = Math.round(((b[0] + b[2]) / 2) / 360) * 360;   // the map repeats the world sideways
  b = [b[0] - shift, b[1], b[2] - shift, b[3]];
  b = [Math.max(-180, b[0]), Math.max(-85, b[1]), Math.min(180, b[2]), Math.min(85, b[3])];
  const a = areaKm2(b);
  S.aoi = { bbox: b, ring: ringOf(b), area: a, label };
  await ready;
  map.getSource('aoi').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [S.aoi.ring] } });
  const ok = a <= LIMIT_KM2 && a >= 0.5;
  S.aoi.ok = ok && b[1] >= -56 && b[3] <= 78;
  $('aoi-info').hidden = false;
  $('aoi-info').innerHTML = `<span>${esc(label || 'Area')}</span><span class="num${ok ? '' : ' warn'}">${fmt(a, 0)} km²</span>${ok ? '' : `<span class="warn small">${a > LIMIT_KM2 ? 'Too large' : 'Too small'}</span>`}`;
  searchSeq++; S.acq = []; S.pre = S.post = null; renderTimeline(); updateRun();
  if (b[1] < -56 || b[3] > 78) $('aoi-info').insertAdjacentHTML('beforeend', '<span class="warn small">Outside 56° S to 78° N, where the permanent-water layer exists</span>');
  return ok;
}

// draw a rectangle: press "Draw area", then drag
let drawing = false, start = null;
$('draw').addEventListener('click', () => setDraw(!drawing));
function setDraw(on) {
  drawing = on; $('draw').setAttribute('aria-pressed', String(on));
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
  on ? map.dragPan.disable() : map.dragPan.enable();
}
map.on('mousedown', e => { if (!drawing) return; start = e.lngLat; });
map.on('touchstart', e => { if (!drawing || e.points.length !== 1) return; start = e.lngLat; e.preventDefault(); });
const drag = e => {
  if (!drawing || !start) return;
  const b = [Math.min(start.lng, e.lngLat.lng), Math.min(start.lat, e.lngLat.lat), Math.max(start.lng, e.lngLat.lng), Math.max(start.lat, e.lngLat.lat)];
  map.getSource('aoi').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ringOf(b)] } });
};
map.on('mousemove', drag); map.on('touchmove', drag);
const finish = e => {
  if (!drawing || !start) return;
  const b = [Math.min(start.lng, e.lngLat.lng), Math.min(start.lat, e.lngLat.lat), Math.max(start.lng, e.lngLat.lng), Math.max(start.lat, e.lngLat.lat)];
  start = null; setDraw(false);
  if (b[2] - b[0] < 1e-4 || b[3] - b[1] < 1e-4) return;
  setAoi(b, 'Drawn area');
};
map.on('mouseup', finish); map.on('touchend', finish);

// place search (Nominatim, on submit only, as its usage policy asks)
$('search').addEventListener('submit', async ev => {
  ev.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  const ul = $('search-results'); ul.hidden = false; ul.innerHTML = '<li class="small" style="padding:.45rem .6rem">Searching…</li>';
  try {
    const r = await fetch(`${NOMINATIM}/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en' } });
    if (!r.ok) throw new Error(`search failed (${r.status})`);
    const list = await r.json();
    ul.innerHTML = list.length ? '' : '<li class="small" style="padding:.45rem .6rem">No place found.</li>';
    for (const p of list) {
      const li = document.createElement('li'), b = document.createElement('button');
      b.textContent = p.display_name; b.type = 'button';
      b.onclick = () => {
        ul.hidden = true;
        const lat = +p.lat, lon = +p.lon, k = 0.09 / Math.cos(lat * Math.PI / 180);   // about 20 x 20 km around the place
        const box = [lon - k, lat - 0.09, lon + k, lat + 0.09];
        setAoi(box, p.name || p.display_name.split(',')[0]);
        fitBox(box);
      };
      li.append(b); ul.append(li);
    }
  } catch (e) { ul.innerHTML = `<li class="small" style="padding:.45rem .6rem">Place search is unavailable (${esc(e.message)}). Draw an area instead.</li>`; }
});

// ---------------------------------------------------------------- acquisitions
$('list').addEventListener('click', listImages);
let searchSeq = 0;
async function listImages() {
  if (!S.aoi) { $('pick-info').textContent = 'Choose an area first.'; return; }
  const mine = ++searchSeq, aoiAtStart = S.aoi;
  const d0 = $('d0').value, d1 = $('d1').value;
  if (!d0 || !d1 || d0 > d1) { $('pick-info').textContent = 'The start date must be before the end date.'; return; }
  $('timeline').innerHTML = '<p class="small">Searching the Sentinel-1 archive…</p>';
  try {
    const { list, truncated } = await ask('acquisitions', { bbox: S.aoi.bbox, start: `${d0}T00:00:00Z`, end: `${d1}T23:59:59Z` });
    if (mine !== searchSeq || S.aoi !== aoiAtStart) return;   // the area or the dates changed while searching
    S.acq = list; S.pre = S.post = null; renderTimeline(); updateRun();
    if (truncated) $('pick-info').insertAdjacentHTML('afterbegin', '<span style="color:#a1271b">Only the first 400 scenes are listed; shorten the date range to see later ones.</span> ');
  } catch (e) { $('timeline').innerHTML = `<p class="small" style="color:#a1271b">Could not search the archive: ${esc(e.message)}</p>`; }
}
const trackKey = a => `${a.orbitState} · relative orbit ${a.relativeOrbit}`;
function renderTimeline() {
  const el = $('timeline');
  if (!S.acq.length) { el.innerHTML = S.aoi ? '' : ''; $('pick-info').textContent = S.aoi ? 'List the images available for this area.' : 'Choose an area first.'; return; }
  const groups = new Map();
  for (const a of S.acq) { const k = trackKey(a); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  el.innerHTML = '';
  for (const [k, items] of groups) {
    const box = document.createElement('div'); box.className = 'track';
    box.innerHTML = `<span class="lbl">${esc(k[0].toUpperCase() + k.slice(1))} · ${items.length} images</span>`;
    const t = document.createElement('div'); t.className = 'ticks';
    for (const a of items) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tick';
      b.textContent = a.datetime.slice(0, 10); b.title = `${a.platform}, ${a.datetime.replace('T', ' ').slice(0, 16)} UTC, ${trackKey(a)}`;
      if (S.pre && S.pre.id === a.id) b.dataset.role = 'pre';
      if (S.post && S.post.id === a.id) b.dataset.role = 'post';
      if (S.pre && !S.post && (trackKey(a) !== trackKey(S.pre) || a.datetime <= S.pre.datetime)) b.disabled = true;
      b.onclick = () => pick(a);
      t.append(b);
    }
    box.append(t); el.append(box);
  }
  $('pick-info').innerHTML = !S.pre ? 'Choose the <strong>before</strong> image.' : !S.post ? `Before: ${S.pre.datetime.slice(0, 10)}. Now choose the <strong>after</strong> image on the same track.`
    : `Before ${S.pre.datetime.slice(0, 10)} · after ${S.post.datetime.slice(0, 10)}, ${Math.round((Date.parse(S.post.datetime) - Date.parse(S.pre.datetime)) / 864e5)} days apart. Click a date to start again.`;
}
function pick(a) {
  if (!S.pre || S.post) { S.pre = a; S.post = null; }
  else if (trackKey(a) === trackKey(S.pre) && a.datetime > S.pre.datetime) S.post = a;
  renderTimeline(); updateRun();
}
function updateRun() {
  $('run').disabled = running || !(S.aoi && S.aoi.ok && S.pre && S.post);
  if (step === 0) $('next').disabled = !(S.aoi && S.aoi.ok);
  if (step === 1) $('next').disabled = !(S.pre && S.post);
}

// ---------------------------------------------------------------- steps
let step = 0;
function go(n) {
  step = n;
  document.querySelectorAll('[data-pane]').forEach(p => { p.hidden = +p.dataset.pane !== n; });
  document.querySelectorAll('.dots button').forEach(b => {
    const k = +b.dataset.step; if (k === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    b.classList.toggle('done', k < n);
  });
  $('back').hidden = n === 0; $('next').hidden = n === 2; $('run').hidden = n !== 2;
  if (n === 1 && S.aoi && !S.acq.length) listImages();
  updateRun();
}
document.querySelectorAll('.dots button').forEach(b => b.addEventListener('click', () => {
  const k = +b.dataset.step;
  if (k === 0 || (k === 1 && S.aoi && S.aoi.ok) || (k === 2 && S.pre && S.post)) go(k);
}));
$('back').addEventListener('click', () => go(step - 1));
$('next').addEventListener('click', () => go(step + 1));
const fitBox = b => map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: { top: 80, bottom: 140, left: window.innerWidth > 760 ? 380 : 40, right: 40 }, duration: 900 });

// ---------------------------------------------------------------- settings
// with the automatic threshold on, the fallback is always the documented default (-18 dB), never a value left on the slider
const P = () => ({ autoThreshold: $('p-auto').checked, thresholdVV: $('p-auto').checked ? -18 : +$('p-thr').value, changeDb: +$('p-chg').value, slopeMax: +$('p-slp').value, permanentOccurrence: +$('p-occ').value });
const outs = { 'p-thr': ['o-thr', v => `${fmt(v)} dB`], 'p-chg': ['o-chg', v => `${fmt(v)} dB`], 'p-slp': ['o-slp', v => `${v}°`], 'p-occ': ['o-occ', v => `${v}%`] };
for (const [id, [o, f]] of Object.entries(outs)) $(id).addEventListener('input', () => {
  $(o).textContent = f(+$(id).value).replace('-', '−');
  if (S.result) scheduleReclassify(id === 'p-thr' ? { threshold: +$('p-thr').value } : {});
});

// ---------------------------------------------------------------- run
const log = $('log');
function logLine(msg, cls = '') { log.querySelectorAll('li.now').forEach(li => li.classList.remove('now')); const li = document.createElement('li'); li.textContent = msg; if (cls) li.className = cls; log.append(li); li.scrollIntoView({ block: 'nearest' }); }
$('run').addEventListener('click', runNow);
let running = false;
async function runNow() {
  if (running || !S.aoi || !S.pre || !S.post) return;
  running = true; clearTimeout(rcTimer);
  $('run').disabled = true; $('demo').disabled = true; log.innerHTML = ''; $('log-box').hidden = false; $('log-box').open = true;
  S.result = null; $('results').hidden = true; $('inspect').hidden = true; $('exports').hidden = true;
  logLine('Starting', 'now');
  let zones = null;
  if ($('p-zones').checked) zones = await loadZones(S.aoi).catch(e => { logLine(`Administrative areas unavailable: ${e.message}`, 'err'); return null; });
  try {
    const r = await ask('run', { args: { aoi: { type: 'Polygon', coordinates: [S.aoi.ring] }, pre: S.pre, post: S.post, params: P(), base: BASE, zones, label: S.aoi.label } },
      msg => logLine(msg, msg.startsWith('Done') ? '' : 'now'));
    log.querySelectorAll('li.now').forEach(li => li.classList.remove('now'));
    S.result = r; S.zonesSource = zones ? zones.source : null; $('log-box').open = false;
    $('p-thr').value = r.threshold.value; $('o-thr').textContent = `${fmt(r.threshold.value)} dB`.replace('-', '−');
    await drawResult(r, true);
  } catch (e) { logLine(e.message, 'err'); }
  finally { running = false; $('demo').disabled = false; updateRun(); }
}

let rcTimer = null;
function scheduleReclassify(extra) {
  clearTimeout(rcTimer);
  if (running) return;
  rcTimer = setTimeout(async () => {
    if (running || !S.result) return;
    const p = P(), params = { changeDb: p.changeDb, slopeMax: p.slopeMax, permanentOccurrence: p.permanentOccurrence, ...extra };
    try { const r = await ask('reclassify', { params }); S.result = r; await drawResult(r, false); } catch (e) { logLine(e.message, 'err'); }
  }, 60);
}

// administrative areas from geoBoundaries (second level where available, else first)
async function loadZones(aoi) {
  const [cx, cy] = [(aoi.bbox[0] + aoi.bbox[2]) / 2, (aoi.bbox[1] + aoi.bbox[3]) / 2];
  const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=3&lat=${cy}&lon=${cx}`, { headers: { 'Accept-Language': 'en' } });
  if (!r.ok) throw new Error('country lookup failed');
  const j = await r.json(), iso2 = j.address && j.address.country_code;
  if (!iso2) throw new Error('the area is not inside a country');
  const iso3 = (await (await fetch(`${BASE}/data/iso2-iso3.json`)).json()).iso2_to_iso3[iso2];
  for (const lvl of ['ADM2', 'ADM1']) {
    const m = await fetch(`https://www.geoboundaries.org/api/current/gbOpen/${iso3}/${lvl}/`);
    if (!m.ok) continue;
    const meta = await m.json();
    const url = String(meta.simplifiedGeometryGeoJSON || '').replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\//, 'https://media.githubusercontent.com/media/$1/$2/');
    if (!url) continue;
    const g = await fetch(url); if (!g.ok) continue;
    const fc = await g.json();
    const [w, s, e, n] = aoi.bbox;
    fc.features = fc.features.filter(f => { const b = bboxOf(f.geometry); return b[0] < e && b[2] > w && b[1] < n && b[3] > s; });
    fc.source = `geoBoundaries gbOpen ${iso3} ${lvl} (${meta.boundarySource || 'source not stated'}, ${meta.boundaryLicense || 'licence not stated'})`;
    return fc;
  }
  throw new Error('no boundaries found');
}
function bboxOf(g) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = c => typeof c[0] === 'number' ? (b[0] = Math.min(b[0], c[0]), b[1] = Math.min(b[1], c[1]), b[2] = Math.max(b[2], c[0]), b[3] = Math.max(b[3], c[1])) : c.forEach(walk);
  walk(g.coordinates); return b;
}

// ---------------------------------------------------------------- drawing results
let corners = null, radarCanvas = null, clsCanvas = null;
const visible = { flood: true, perm: true, before: true, steep: false, radar: false, s2: false };
async function drawResult(r, fit) {
  await ready;
  const g = r.grid, toLL = proj4(defineEpsg(g.crs), 'EPSG:4326');
  corners = [[g.x0, g.y1], [g.x0 + g.w * g.res, g.y1], [g.x0 + g.w * g.res, g.y1 - g.h * g.res], [g.x0, g.y1 - g.h * g.res]].map(p => toLL.forward(p));
  clsCanvas = paintClasses(r.cls, g);
  radarCanvas = radarCanvas && radarCanvas.width === g.w && !fit ? radarCanvas : document.createElement('canvas');
  radarCanvas.width = g.w; radarCanvas.height = g.h; paintRadar(r);
  setImage('cls', clsCanvas); setImage('radar', radarCanvas, 'cls');
  applyVisibility();
  if (fit) {
    const lons = corners.map(c => c[0]), lats = corners.map(c => c[1]);
    fitBox([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]);
  }
  renderLegend(); renderFigures(r); drawHist(r); renderLandcover(r); renderZones(r);
  $('results').hidden = false; $('exports').hidden = false; $('r-title').textContent = 'Flood map';
}
function paintClasses(cls, g) {
  const c = document.createElement('canvas'); c.width = g.w; c.height = g.h;
  const ctx = c.getContext('2d'), img = ctx.createImageData(g.w, g.h);
  for (let i = 0; i < cls.length; i++) {
    const k = cls[i], col = COLORS[k];
    if (!col || (k <= 3 && !visible.flood) || (k === 4 && !visible.perm) || (k === 6 && !visible.before) || (k === 5 && !visible.steep)) continue;
    img.data.set(col, i * 4);
  }
  ctx.putImageData(img, 0, 0); return c;
}
function paintRadar(r) {
  const g = r.grid, ctx = radarCanvas.getContext('2d'), img = ctx.createImageData(g.w, g.h), cut = Math.round(g.w * swipeAt / 100);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const i = y * g.w + x, v = x < cut ? r.pre[i] : r.post[i];
    if (!(v === v)) continue;
    const t = Math.max(0, Math.min(1, (v + 25) / 25)), q = Math.round(255 * Math.sqrt(t));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = q; img.data[i * 4 + 3] = 255;
  }
  for (let y = 0; y < g.h; y++) { const i = (y * g.w + Math.min(g.w - 1, cut)) * 4; img.data.set([255, 200, 0, 255], i); }
  ctx.putImageData(img, 0, 0);
}
function setImage(id, canvas, below) {
  const url = canvas.toDataURL('image/png'), src = map.getSource(id);
  if (src) src.updateImage({ url, coordinates: corners });
  else {
    map.addSource(id, { type: 'image', url, coordinates: corners });
    map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, below && map.getLayer(below) ? below : 'aoi-fill');
  }
}
let swipeAt = 50;
function onSwipe(v) { swipeAt = v; if (!S.result) return; if (!visible.radar) { visible.radar = true; const c = $('legend').querySelector('[data-k="radar"]'); if (c) c.checked = true; applyVisibility(); } paintRadar(S.result); setImage('radar', radarCanvas); }
function applyVisibility() {
  if (map.getLayer('radar')) map.setLayoutProperty('radar', 'visibility', visible.radar ? 'visible' : 'none');
  if (map.getLayer('s2')) map.setLayoutProperty('s2', 'visibility', visible.s2 ? 'visible' : 'none');
}
function renderLegend() {
  const L = $('legend'); L.hidden = false;
  const rows = [['flood', 'Flood, high confidence', COLORS[2]], ['flood', 'Flood, medium confidence', COLORS[3]], ['perm', 'Permanent water', COLORS[4]],
    ['before', 'Water before the event', COLORS[6]], ['steep', 'Excluded: slope', COLORS[5]], ['radar', 'Radar image (swipe)', null], ['s2', 'Sentinel-2 cloudless basemap', null]];
  L.innerHTML = rows.map(([k, t, c], i) => `<label${i === 1 ? ' style="padding-left:21px"' : ''}><input type="checkbox" data-k="${k}" ${visible[k] ? 'checked' : ''} ${i === 1 ? 'hidden' : ''}>${c ? `<i style="background:rgba(${c.slice(0, 3)},${c[3] / 255})"></i>` : ''}${t}</label>`).join('') +
    `<div class="swipe"><label for="swipe" class="small">Radar: before ⟷ after</label><input type="range" id="swipe" min="0" max="100" value="${swipeAt}" aria-label="Swipe between the radar images before and after"></div>`;
  $('swipe').addEventListener('input', e => onSwipe(+e.target.value));
  L.querySelectorAll('input').forEach(inp => inp.onchange = () => {
    visible[inp.dataset.k] = inp.checked;
    if (['flood', 'perm', 'before', 'steep'].includes(inp.dataset.k)) { clsCanvas = paintClasses(S.result.cls, S.result.grid); setImage('cls', clsCanvas); }
    applyVisibility();
  });
}

// click on the map: the values of that pixel
map.on('click', async e => {
  if (drawing || !S.result) return;
  const g = S.result.grid, [x, y] = proj4('EPSG:4326', defineEpsg(g.crs)).forward([e.lngLat.lng, e.lngLat.lat]);
  const c = Math.floor((x - g.x0) / g.res), r = Math.floor((g.y1 - y) / g.res);
  const box = $('inspect');
  if (c < 0 || r < 0 || c >= g.w || r >= g.h) { box.hidden = true; return; }
  const { values: v } = await ask('inspect', { index: r * g.w + c });
  const dB = q => q == null ? '—' : `${fmt(q)} dB`.replace('-', '−');
  box.hidden = false;
  box.innerHTML = `<button class="link" type="button" style="float:right;font-size:12px" onclick="this.parentElement.hidden=true">Close</button><div class="meta">Pixel ${c}, ${r} · ${fmt(e.lngLat.lat, 4)}°, ${fmt(e.lngLat.lng, 4)}°</div><dl>
    <dt>Class</dt><dd>${esc(CLASS_NAMES[v.cls])}</dd>
    <dt>VV before</dt><dd>${dB(v.preVV)}</dd><dt>VV after</dt><dd>${dB(v.postVV)}</dd>
    <dt>VV change</dt><dd>${v.preVV == null || v.postVV == null ? '—' : dB(v.postVV - v.preVV)}</dd>
    <dt>VH change</dt><dd>${v.preVH == null || v.postVH == null ? '—' : dB(v.postVH - v.preVH)}</dd>
    <dt>Water occurrence</dt><dd>${v.occurrence == null || v.occurrence > 100 ? '—' : fmt(v.occurrence, 0) + '%'}</dd>
    <dt>Slope</dt><dd>${v.slope == null ? '—' : fmt(v.slope) + '°'}</dd>
    <dt>Land cover</dt><dd>${esc(WORLDCOVER[v.landcover] || '—')}</dd>
    <dt>Residents</dt><dd>${v.popDensity == null ? '—' : fmtInt(v.popDensity) + ' /km²'}</dd></dl>`;
});

// ---------------------------------------------------------------- numbers
function renderFigures(r) {
  const s = r.summary, a = s.areaKm2, m = r.meta;
  const d = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  $('r-sub').textContent = `${d(m.pre.datetime)} to ${d(m.post.datetime)}. Threshold ${fmt(r.threshold.value)} dB.`.replace(/-(\d)/g, '−$1');
  const share = a.valid ? a.flood / a.valid * 100 : 0;
  $('figures').innerHTML = [
    [fmt(a.flood, a.flood < 10 ? 2 : 1), `km² new water (${fmt(share)}% of ${fmt(a.valid, 0)} km²)`],
    [fmt(a.floodHigh, a.floodHigh < 10 ? 2 : 1), m.post.polarisations === 'VV, VH' ? 'km² high confidence (VV and VH)' : 'km² high confidence (no VH)'],
    [fmtInt(s.population.inFlood), 'modelled residents in it'],
    [fmt(a.permanent, 1), 'km² permanent water, excluded'],
  ].map(([v, u]) => `<div class="fig"><b class="num">${v}</b><span>${u}</span></div>`).join('');
}
function renderLandcover(r) {
  const e = Object.entries(r.summary.landcoverKm2), max = Math.max(...e.map(x => x[1]), 1e-9);
  $('lc').innerHTML = e.length ? e.map(([k, v]) => `<div class="bar"><span>${esc(WORLDCOVER[k] || k)}</span><span class="track-b"><span class="fill" style="display:block;width:${(v / max * 100).toFixed(1)}%"></span></span><span class="num">${fmt(v, 2)}</span></div>`).join('')
    : '<p class="small">No flood water found with these settings.</p>';
}
function renderZones(r) {
  const z = r.summary.zones;
  if (!z || !z.length) { $('zones').innerHTML = S.zonesSource ? '<p class="small">No flood water inside the administrative areas found.</p>' : ''; return; }
  $('zones').innerHTML = `<table class="t"><thead><tr><th>Area</th><th style="text-align:right">Flooded km²</th><th style="text-align:right">Modelled residents</th></tr></thead><tbody>${
    z.slice(0, 25).map(q => `<tr><td>${esc(q.name)}</td><td class="n">${fmt(q.floodKm2, 2)}</td><td class="n">${fmtInt(q.population)}</td></tr>`).join('')}</tbody></table>
    <p class="note">Only the part of each area inside the analysed box is counted. ${esc(S.zonesSource || '')}${z.length > 25 ? ` · ${z.length - 25} more in the CSV` : ''}</p>`;
}

// histogram with a draggable threshold
const H = $('hist'), hctx = H.getContext('2d');
function drawHist(r) {
  const W = H.width, Hh = H.height, pad = { l: 34, r: 8, t: 10, b: 28 }, h = r.hist, max = Math.max(...h, 1);
  hctx.clearRect(0, 0, W, Hh);
  const X = db => pad.l + (db + 30) / 30 * (W - pad.l - pad.r), Y = v => Hh - pad.b - Math.sqrt(v / max) * (Hh - pad.t - pad.b);
  const t = r.threshold.value;
  for (let i = 0; i < h.length; i++) {
    const db = -30 + i / 10; hctx.fillStyle = db < t ? '#1554c0' : '#bdbdb8';
    hctx.fillRect(X(db), Y(h[i]), Math.max(1, X(db + 0.1) - X(db)), Hh - pad.b - Y(h[i]));
  }
  hctx.strokeStyle = '#141412'; hctx.lineWidth = 2; hctx.beginPath(); hctx.moveTo(X(t), pad.t - 4); hctx.lineTo(X(t), Hh - pad.b); hctx.stroke();
  hctx.fillStyle = '#141412'; hctx.font = '12px "Geist Mono", monospace'; hctx.textAlign = 'center';
  for (let d = -30; d <= 0; d += 5) hctx.fillText(String(d).replace('-', '−'), X(d), Hh - 10);
  hctx.textAlign = 'left'; hctx.fillText(`${fmt(t)} dB`.replace('-', '−'), Math.min(X(t) + 6, W - 70), pad.t + 8);
  hctx.fillStyle = '#6a6963'; hctx.fillText('dB', 4, Hh - 10);
  H.dataset.pad = JSON.stringify(pad);
}
let dragH = false;
const hDb = ev => { const b = H.getBoundingClientRect(), pad = JSON.parse(H.dataset.pad), x = (ev.clientX - b.left) / b.width * H.width; return Math.max(-26, Math.min(-12, -30 + (x - pad.l) / (H.width - pad.l - pad.r) * 30)); };
H.addEventListener('pointerdown', ev => { if (!S.result) return; dragH = true; H.setPointerCapture(ev.pointerId); move(ev); });
H.addEventListener('pointermove', ev => dragH && move(ev));
H.addEventListener('pointerup', () => { dragH = false; });
function move(ev) {
  const t = Math.round(hDb(ev) * 10) / 10;
  $('p-thr').value = t; $('o-thr').textContent = `${fmt(t)} dB`.replace('-', '−');
  S.result.threshold.value = t; drawHist(S.result);
  scheduleReclassify({ threshold: t });
}
H.tabIndex = 0;
H.addEventListener('keydown', ev => {
  if (!S.result || !['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
  ev.preventDefault();
  const t = Math.max(-26, Math.min(-12, Math.round((S.result.threshold.value + (ev.key === 'ArrowRight' ? 0.1 : -0.1)) * 10) / 10));
  $('p-thr').value = t; S.result.threshold.value = t; drawHist(S.result); scheduleReclassify({ threshold: t });
});

// ---------------------------------------------------------------- exports
const NAMES = { geojson: 'flood-extent.geojson', geotiff: 'flood-classes.tif', csv: 'flood-statistics.csv', json: 'processing-metadata.json' };
document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', async () => {
  if (!S.result) return;
  const kind = b.dataset.export, stem = `floodscope_${S.result.meta.post.datetime.slice(0, 10)}`;
  try {
    if (kind === 'png') return save(await mapPng(), `${stem}_map.png`);
    if (kind === 'pdf') return printReport();
    const { blob } = await ask('export', { kind });
    save(blob, `${stem}_${NAMES[kind]}`);
  } catch (e) { alert(`Export failed: ${e.message}`); }
}));
function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
async function mapPng() {
  await new Promise(r => { map.once('render', r); map.triggerRepaint(); });
  const src = map.getCanvas(), c = document.createElement('canvas'), foot = 54;
  c.width = src.width; c.height = src.height + foot;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(src, 0, 0);
  const m = S.result.meta, dpr = window.devicePixelRatio || 1;
  ctx.fillStyle = '#141412'; ctx.font = `${13 * dpr}px Satoshi, sans-serif`;
  ctx.fillText(`FloodScope · flood ${m.pre.datetime.slice(0, 10)} → ${m.post.datetime.slice(0, 10)} · ${fmt(S.result.summary.areaKm2.flood, 2)} km² new water`, 10 * dpr, src.height + 20 * dpr);
  ctx.fillStyle = '#55544e'; ctx.font = `${10 * dpr}px Satoshi, sans-serif`;
  ctx.fillText('Sentinel-1 RTC (Planetary Computer; modified Copernicus Sentinel data), JRC GSW, Copernicus DEM, ESA WorldCover, GHS-POP. Basemap © OpenStreetMap contributors, OpenFreeMap.', 10 * dpr, src.height + 38 * dpr);
  return new Promise(r => c.toBlob(r, 'image/png'));
}
async function printReport() {
  const r = S.result, s = r.summary, a = s.areaKm2, m = r.meta, img = URL.createObjectURL(await mapPng());
  const lc = Object.entries(s.landcoverKm2).map(([k, v]) => `<tr><td>${esc(WORLDCOVER[k] || k)}</td><td>${fmt(v, 2)} km²</td></tr>`).join('');
  const zn = (s.zones || []).slice(0, 30).map(z => `<tr><td>${esc(z.name)}</td><td>${fmt(z.floodKm2, 2)} km²</td><td>${fmtInt(z.population)}</td></tr>`).join('');
  $('report').innerHTML = `<h1>FloodScope report</h1><p>${esc(m.label || 'Area')} · ${fmt(m.aoiAreaKm2, 0)} km² · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
    <img src="${img}" alt="Map of the flood extent">
    <h2>Result</h2><table>
    <tr><td>New water (flood)</td><td>${fmt(a.flood, 2)} km² (${fmt(a.floodHigh, 2)} high, ${fmt(a.floodMedium, 2)} medium confidence)</td></tr>
    <tr><td>Analysed area with valid radar</td><td>${fmt(a.valid, 1)} km²</td></tr>
    <tr><td>Permanent water (excluded)</td><td>${fmt(a.permanent, 2)} km²</td></tr><tr><td>Water before the event</td><td>${fmt(a.waterBefore, 2)} km²</td></tr>
    <tr><td>Excluded for slope</td><td>${fmt(a.steep, 2)} km²</td></tr>
    <tr><td>Modelled residents in the flood</td><td>${fmtInt(s.population.inFlood)} (GHS-POP 2025; not people affected)</td></tr></table>
    <h2>Flooded land cover</h2><table>${lc || '<tr><td>none</td></tr>'}</table>
    ${zn ? `<h2>By administrative area</h2><table><tr><th>Area</th><th>Flooded</th><th>Modelled residents</th></tr>${zn}</table>` : ''}
    <h2>Processing</h2><table>
    <tr><td>Before</td><td>${esc((m.pre.slices || [m.pre.id]).join(', '))}</td></tr><tr><td>After</td><td>${esc((m.post.slices || [m.post.id]).join(', '))}</td></tr>
    <tr><td>Grid</td><td>${m.resolutionM} m, ${esc(m.crs)}</td></tr>
    <tr><td>Rule</td><td>VV after &lt; ${fmt(r.params.threshold)} dB (${esc(r.threshold.source)}) and VV change ≤ ${fmt(r.params.changeDb)} dB; slope ≤ ${r.params.slopeMax}°; permanent water at ≥ ${r.params.permanentOccurrence}% occurrence excluded; ${r.params.speckleWindow} × ${r.params.speckleWindow} speckle mean</td></tr>
    <tr><td>Software</td><td>FloodScope ${esc(m.version)}, run ${esc(m.runAt)}</td></tr></table>
    <p class="src">${Object.values(m.sources).filter(Boolean).map(esc).join(' · ')}</p>
    <p class="src">Limits: radar misses water under canopy and between buildings, and smooth dry surfaces can look like water. No ground truth was used.</p>`;
  await new Promise(res => { const im = $('report').querySelector('img'); im.complete ? res() : (im.onload = res); });
  window.print();
}

// ---------------------------------------------------------------- example
$('demo').addEventListener('click', async () => {
  const b = [6.70, 7.70, 6.85, 7.85];
  await setAoi(b, 'Lokoja, Kogi State, Nigeria: Niger–Benue confluence');
  fitBox(b); go(1);
  $('d0').value = '2022-07-01'; $('d1').value = '2022-11-30';
  await listImages();
  const pre = S.acq.find(a => a.datetime.startsWith('2022-08-02')), post = S.acq.find(a => a.datetime.startsWith('2022-10-13'));
  if (!pre || !post) { logLine('The example images could not be found in the archive right now.', 'err'); return; }
  pick(pre); pick(post);
  go(2); runNow();
});

// ---------------------------------------------------------------- drawer and about
$('more').addEventListener('click', () => {
  const open = $('drawer-body').hidden; $('drawer-body').hidden = !open; $('more').setAttribute('aria-expanded', String(open)); $('more').textContent = open ? 'Hide' : 'Details';
});
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('[data-tabpane]').forEach(p => { p.hidden = p.dataset.tabpane !== b.dataset.tab; });
}));
$('ctl-toggle').addEventListener('click', () => { const o = $('mapctl').classList.toggle('open'); $('ctl-toggle').setAttribute('aria-expanded', String(o)); });
$('about-open').addEventListener('click', () => { $('about').hidden = false; $('about-close').focus(); });
$('about-close').addEventListener('click', () => { $('about').hidden = true; $('about-open').focus(); });
$('about').addEventListener('click', e => { if (e.target === $('about')) $('about').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('about').hidden = true; if (drawing) setDraw(false); } });
go(0);
