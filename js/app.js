/* FloodScope page: map, steps, results. All numbers shown come from the worker's run (js/pipeline.js). */
import { proj4 } from '../vendor/geo-libs.mjs';
import { defineEpsg } from './io.js';
import { CLASS_NAMES, WORLDCOVER } from './exports.js';
import { VERSION } from './version.js';

const $ = id => document.getElementById(id);
document.querySelectorAll('[data-ver]').forEach(e => { e.textContent = VERSION; });
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
worker.onerror = e => {   // the worker script itself failed to load or crashed: fail every waiting request with a message
  const err = new Error(`The analysis engine stopped (${e.message || 'script error'}). Reload the page and try again.`);
  for (const [id, p] of pending) { pending.delete(id); p.reject(err); }
};
const ask = (cmd, payload = {}, onProgress) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ cmd, id, ...payload });
});

// ---------------------------------------------------------------- map
const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: [6.76, 7.8], zoom: 2.2,
  attributionControl: false, preserveDrawingBuffer: true, cooperativeGestures: false,
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
const ready = new Promise(r => map.on('load', r));
// if the basemap style cannot be fetched (host down, blocked network) fall back to a plain background so the tool still works
const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9ecef' } }] };
let styleFallback = false;
map.on('error', e => { if (styleFallback || map.isStyleLoaded() || (e && e.sourceId)) return; styleFallback = true; $('mapnote').hidden = false; map.setStyle(FALLBACK_STYLE); });
function showLegend() { const L = $('legend'); L.hidden = false; if (!L.dataset.init) { L.dataset.init = '1'; L.open = !window.matchMedia('(max-width: 860px)').matches; } return $('legend-body'); }
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
  const crosses = b[0] < -180 || b[2] > 180;   // a box over the 180° meridian cannot be one UTM grid
  b = [Math.max(-180, b[0]), Math.max(-85, b[1]), Math.min(180, b[2]), Math.min(85, b[3])];
  const a = areaKm2(b), outside = b[1] < -56 || b[3] > 78;
  const problem = crosses ? 'The box crosses the 180° meridian; draw it on one side'
    : a > LIMIT_KM2 ? `${fmt(a, 0)} km² is larger than the ${fmt(LIMIT_KM2, 0)} km² limit; draw a smaller box`
    : a < 0.5 ? `${fmt(a, 2)} km² is smaller than the 0.5 km² minimum; draw a larger box`
    : outside ? 'Outside 56° S to 78° N, where the permanent-water layer exists' : '';
  S.aoi = { bbox: b, ring: ringOf(b), area: a, label, ok: !problem };
  $('aoi-info').hidden = false;
  $('aoi-info').innerHTML = `<span>${esc(label || 'Area')}</span><span class="num${problem ? ' warn' : ''}">${fmt(a, a < 10 ? 2 : 0)} km²</span>${problem ? `<span class="warn">${esc(problem)}</span>` : ''}`;
  summary(0, `${label || 'Area'}, ${fmt(a, a < 10 ? 2 : 0)} km²`); summary(1, 'Before and after the flood');
  searchSeq++; S.acq = []; S.pre = S.post = null; S.searched = null; if (!running && S.result) clearResult(); renderTimeline(); updateRun();
  await ready;
  map.getSource('aoi').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [S.aoi.ring] } });
  return !problem;
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
  if (b[2] - b[0] < 1e-4 || b[3] - b[1] < 1e-4) {   // a click or a line, not a box
    map.getSource('aoi').setData(S.aoi ? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [S.aoi.ring] } } : { type: 'FeatureCollection', features: [] });
    $('aoi-info').hidden = false; $('aoi-info').innerHTML = '<span class="warn">That box has no area. Press Draw a box, then drag across the map.</span>'; return;
  }
  setAoi(b, 'Drawn area');
};
map.on('mouseup', finish); map.on('touchend', finish);

// place search (Nominatim, on submit only, as its usage policy asks)
$('search').addEventListener('submit', async ev => {
  ev.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  const ul = $('search-results'); ul.hidden = false; ul.innerHTML = '<li class="small" style="padding:.45rem .6rem">Searching…</li>';
  try {
    const r = await fetch(`${NOMINATIM}/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en' }, signal: AbortSignal.timeout(15000) });
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
  } catch (e) { ul.innerHTML = `<li class="small" style="padding:.45rem .6rem">Place search is unavailable (${esc(e.name === 'TimeoutError' ? 'no answer within 15 seconds' : e.message)}). Draw a box on the map instead.</li>`; }
});

// ---------------------------------------------------------------- acquisitions
$('list').addEventListener('click', listImages);
let searchSeq = 0;
async function listImages() {
  if (!S.aoi) { $('pick-info').textContent = 'Choose an area first.'; return; }
  const mine = ++searchSeq, aoiAtStart = S.aoi;
  const d0 = $('d0').value, d1 = $('d1').value;
  if (!d0 || !d1 || d0 > d1) { $('pick-info').textContent = 'The start date must be before the end date.'; return; }
  showTab('images'); $('timeline').innerHTML = '<p class="empty-state">Searching the Sentinel-1 archive…</p>';
  try {
    const { list, truncated } = await ask('acquisitions', { bbox: S.aoi.bbox, start: `${d0}T00:00:00Z`, end: `${d1}T23:59:59Z` });
    if (mine !== searchSeq || S.aoi !== aoiAtStart) return;   // the area or the dates changed while searching
    S.acq = list; S.pre = S.post = null; S.searched = { d0, d1, truncated }; renderTimeline(); updateRun();
    if (truncated) $('pick-info').insertAdjacentHTML('afterbegin', '<span class="warn">Only the first 400 scenes are listed; shorten the date range to see later ones.</span> ');
  } catch (e) { if (mine !== searchSeq) return; S.acq = []; S.searched = null; $('timeline').innerHTML = `<p class="empty-state warn" role="alert">Could not list the images. ${esc(e.message)} Press List images to try again.</p>`; $('pick-info').textContent = ''; updateRun(); }
}
const trackKey = a => `${a.orbitState} · relative orbit ${a.relativeOrbit}`;
function renderTimeline() {
  const el = $('timeline');
  if (!S.acq.length) {
    if (S.searched) {   // a search ran and found nothing: say so, do not ask the user to search again
      const q = S.searched;
      el.innerHTML = `<p class="empty-state warn" role="status">No Sentinel-1 radar images were found for this area between ${esc(q.d0)} and ${esc(q.d1)}. Widen the dates in step 2, or move the box.</p>`;
      $('pick-info').textContent = 'No images found.'; summary(1, 'No images found'); return;
    }
    el.innerHTML = `<p class="empty-state">${S.aoi ? 'List the images for this area (step 2).' : 'Choose an area, then list the images.'}</p>`; $('pick-info').textContent = S.aoi ? 'List the images available for this area.' : 'Choose an area first.'; return;
  }
  const groups = new Map();
  for (const a of S.acq) { const k = trackKey(a); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  el.innerHTML = '';
  for (const [k, items] of groups) {
    const box = document.createElement('div'); box.className = 'track';
    box.innerHTML = `<span class="lbl">${esc(k[0].toUpperCase() + k.slice(1))} · ${items.length} image${items.length === 1 ? '; a second image on this track is needed to make a pair' : 's'}</span>`;
    const t = document.createElement('div'); t.className = 'ticks';
    for (const a of items) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tick';
      b.textContent = a.datetime.slice(0, 10); b.title = `${a.platform}, ${a.datetime.replace('T', ' ').slice(0, 16)} UTC, ${trackKey(a)}`;
      if (S.pre && S.pre.id === a.id) b.dataset.role = 'pre';
      if (S.post && S.post.id === a.id) b.dataset.role = 'post';
      if (S.pre && !S.post && (trackKey(a) !== trackKey(S.pre) || a.datetime <= S.pre.datetime)) b.classList.add('other');
      b.onclick = () => pick(a);
      t.append(b);
    }
    box.append(t); el.append(box);
  }
  const canPair = [...groups.values()].some(g => g.length > 1);
  if (!canPair) { $('pick-info').innerHTML = '<span class="warn">Every track has only one image, so no before and after pair can be made. Widen the dates in step 2.</span>'; summary(1, 'Only one image per track'); return; }
  $('pick-info').innerHTML = !S.pre ? 'Choose the <strong>before</strong> image.' : !S.post ? `Before: ${S.pre.datetime.slice(0, 10)}. Now choose the <strong>after</strong> image on the same track, or another date to change the before image.`
    : `Before ${S.pre.datetime.slice(0, 10)}, after ${S.post.datetime.slice(0, 10)}: ${Math.round((Date.parse(S.post.datetime) - Date.parse(S.pre.datetime)) / 864e5)} days apart. Click a date to start again.`;
  summary(1, S.pre && S.post ? `${S.pre.datetime.slice(0, 10)} to ${S.post.datetime.slice(0, 10)}` : S.pre ? `Before ${S.pre.datetime.slice(0, 10)}; choose after` : 'Before and after the flood');
}
function pick(a) {
  // a later date on the same track completes the pair; any other date starts a new "before"
  if (S.pre && !S.post && trackKey(a) === trackKey(S.pre) && a.datetime > S.pre.datetime) S.post = a;
  else { S.pre = a; S.post = null; }
  if (!running && S.result) clearResult();
  renderTimeline(); updateRun();
}
function updateRun() {
  $('run').disabled = running || !(S.aoi && S.aoi.ok && S.pre && S.post);
  $('next-0').disabled = !(S.aoi && S.aoi.ok);
  $('next-1').disabled = !(S.pre && S.post);
  setLocks();
}

// ---------------------------------------------------------------- steps (accordion in the rail)
let step = 0;
const reach = k => k === 0 || (k === 1 && S.aoi && S.aoi.ok) || (k === 2 && S.aoi && S.aoi.ok && S.pre && S.post);
function summary(k, t) { $(`sum-${k}`).textContent = t; }
const complete = k => k === 0 ? !!(S.aoi && S.aoi.ok) : k === 1 ? !!(S.pre && S.post) : !!S.result;
function setLocks() {
  document.querySelectorAll('.step').forEach(el => {
    const k = +el.dataset.step;
    el.classList.toggle('locked', !reach(k)); el.querySelector('.step-h').setAttribute('aria-disabled', String(!reach(k))); el.querySelector('.step-h').tabIndex = reach(k) ? 0 : -1;
    el.classList.toggle('done', k !== step && complete(k));
  });
}
function go(n) {
  step = n;
  document.querySelectorAll('.step').forEach(el => {
    const k = +el.dataset.step, open = k === n;
    el.classList.toggle('open', open); el.querySelector('[data-pane]').hidden = !open; el.querySelector('.step-h').setAttribute('aria-expanded', String(open));
  });
  if (n === 1 && S.aoi && !S.acq.length && !S.searched) listImages();
  if (n === 1) showTab('images');
  updateRun();
}
document.querySelectorAll('.step-h').forEach(h => h.addEventListener('click', () => { const k = +h.parentElement.dataset.step; if (reach(k)) go(k); }));
$('next-0').addEventListener('click', () => go(1));
$('next-1').addEventListener('click', () => go(2));
const fitBox = b => map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 900 });

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
const STEPS_EXPECTED = 14;   // progress messages in a typical run (pipeline.runAnalysis), used only for the bar
function logLine(msg, cls = '') {
  log.querySelectorAll('li.now').forEach(li => li.classList.remove('now'));
  const li = document.createElement('li'); li.textContent = msg; if (cls) li.className = cls; log.append(li);
  $('status').hidden = false; $('msg').textContent = msg; $('msg').className = cls === 'err' ? 'msg err' : 'msg';
  $('bar').style.width = `${Math.min(100, log.children.length / STEPS_EXPECTED * 100)}%`;
}
$('run').addEventListener('click', runNow);
let running = false;
async function runNow() {
  if (running || !S.aoi || !S.pre || !S.post) return;
  const aoi = S.aoi, pre = S.pre, post = S.post;   // fixed for this run, even if the inputs change while it runs
  running = true; clearTimeout(rcTimer); rcSeq++; clearResult();
  $('run').disabled = true; $('demo').disabled = true; log.innerHTML = '';
  S.result = null; $('inspect').hidden = true; $('figures').classList.add('empty'); summary(2, 'Running');
  logLine('Starting', 'now');
  let zones = null;
  if ($('p-zones').checked) zones = await loadZones(aoi).catch(e => { logLine(`Administrative areas could not be looked up (${/fetch|network/i.test(e.message) ? 'the place service did not answer' : e.message}), so the Areas tab stays empty. The flood map and totals are not affected.`, 'err'); return null; });
  try {
    const r = await ask('run', { args: { aoi: { type: 'Polygon', coordinates: [aoi.ring] }, pre, post, params: P(), base: BASE, zones, label: aoi.label } },
      msg => logLine(msg, msg.startsWith('Done') ? '' : 'now'));
    log.querySelectorAll('li.now').forEach(li => li.classList.remove('now'));
    S.result = r; S.zonesSource = zones ? zones.source : null; $('bar').style.width = '100%';
    $('p-thr').value = r.threshold.value; $('o-thr').textContent = `${fmt(r.threshold.value)} dB`.replace('-', '−');
    await drawResult(r, true);
  } catch (e) { logLine(e.message, 'err'); summary(2, 'Failed; see the message below'); }
  finally { running = false; $('demo').disabled = false; updateRun(); }
}

let rcTimer = null, rcSeq = 0;
function scheduleReclassify(extra) {
  clearTimeout(rcTimer);
  if (running) return;
  rcTimer = setTimeout(async () => {
    if (running || !S.result) return;
    const p = P(), params = { changeDb: p.changeDb, slopeMax: p.slopeMax, permanentOccurrence: p.permanentOccurrence, ...extra };
    const mine = ++rcSeq;
    try { const r = await ask('reclassify', { params }); if (mine !== rcSeq || running) return; S.result = r; await drawResult(r, false); } catch (e) { logLine(e.message, 'err'); }
  }, 60);
}

// administrative areas from geoBoundaries (second level where available, else first)
async function loadZones(aoi) {
  const [cx, cy] = [(aoi.bbox[0] + aoi.bbox[2]) / 2, (aoi.bbox[1] + aoi.bbox[3]) / 2];
  const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=3&lat=${cy}&lon=${cx}`, { headers: { 'Accept-Language': 'en' }, signal: AbortSignal.timeout(15000) });
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
  if (map.getLayer('cls')) map.setLayoutProperty('cls', 'visibility', 'visible');
  applyVisibility();
  if (fit) {
    const lons = corners.map(c => c[0]), lats = corners.map(c => c[1]);
    fitBox([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]);
  }
  renderLegend(); renderFigures(r); drawHist(r); renderLandcover(r); renderZones(r); syncExports();
  $('thr-empty').hidden = true;
  if (fit) { showTab('thr'); if (window.innerWidth <= 860) document.querySelector('.main').scrollIntoView({ behavior: 'smooth' }); }
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
  const L = showLegend();
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
  box.innerHTML = `<button class="x" type="button" onclick="this.parentElement.hidden=true">Close</button><div class="muted">Pixel ${c}, ${r} · ${fmt(e.lngLat.lat, 4)}°, ${fmt(e.lngLat.lng, 4)}°</div><dl>
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
  const neg = t => t.replace(/-(\d)/g, '−$1');
  $('r-title').textContent = m.label || 'Flood map';
  $('r-sub').textContent = neg(`${d(m.pre.datetime)} to ${d(m.post.datetime)}, ${m.post.platform} ${m.post.orbitState} orbit ${m.post.relativeOrbit}. Water threshold ${fmt(r.threshold.value)} dB, ${r.threshold.source === 'otsu' ? 'automatic (Otsu)' : /^default/.test(r.threshold.source) ? 'default; automatic split not usable here' : 'set by you'}.`);
  summary(2, neg(`Done: ${fmt(a.flood, a.flood < 10 ? 2 : 1)} km² at ${fmt(r.threshold.value)} dB`));
  const share = a.valid ? a.flood / a.valid * 100 : 0, vh = m.post.polarisations === 'VV, VH';
  const k = [
    ['New water', fmt(a.flood, a.flood < 10 ? 2 : 1), 'km²', `${fmt(share)}% of the ${fmt(a.valid, 0)} km² with valid radar`],
    ['High confidence', fmt(a.floodHigh, a.floodHigh < 10 ? 2 : 1), 'km²', vh ? `Plus ${fmt(a.floodMedium, 2)} km² where only VV darkened` : 'No VH in these images'],
    popKpi(s, m),
    ['Permanent water', fmt(a.permanent, 1), 'km²', `Excluded, plus ${fmt(a.waterBefore, 1)} km² wet before`],
  ];
  $('figures').classList.remove('empty');
  $('figures').innerHTML = k.map(([l, v, u, t]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}${u ? `<small>${u}</small>` : ''}</div><div class="d" title="${esc(t)}">${esc(t)}</div></div>`).join('');
}
function popKpi(s, m) {   // population is shown only where the GHS-POP tiles cover the analysed pixels
  const p = s.population, none = s.validPixels > 0 && p.pixelsWithoutPopulation >= s.validPixels, part = p.pixelsWithoutPopulation / Math.max(1, s.validPixels);
  if (none) return ['Modelled residents', '–', '', m.populationNote || 'No GHS-POP population data for this area'];
  return ['Modelled residents', fmtInt(p.inFlood), '', `${fmtInt(p.inFloodHigh)} of them in high-confidence water${part > 0.005 ? `; no population data for ${fmt(part * 100, 0)}% of the analysed pixels` : ''}`];
}
function renderLandcover(r) {
  const e = Object.entries(r.summary.landcoverKm2), max = Math.max(...e.map(x => x[1]), 1e-9);
  $('lc').innerHTML = e.length ? `<div class="bars">${e.sort((x, y) => y[1] - x[1]).map(([k, v]) => `<div class="b"><span>${esc(WORLDCOVER[k] || k)}</span><span class="n">${fmt(v, 2)} km²</span><span class="tr"><i style="width:${(v / max * 100).toFixed(1)}%"></i></span></div>`).join('')}</div>`
    : '<p class="empty-state">No flood water found with these settings.</p>';
}
function renderZones(r) {
  const z = r.summary.zones;
  if (!z || !z.length) { $('zones').innerHTML = S.zonesSource ? '<p class="empty-state">No flood water inside the administrative areas found.</p>' : '<p class="empty-state">Administrative areas were not loaded for this run.</p>'; return; }
  $('zones').innerHTML = `<table class="t"><thead><tr><th>Area</th><th class="n">Flooded km²</th><th class="n">Residents</th></tr></thead><tbody>${
    z.slice(0, 25).map(q => `<tr><td>${esc(q.name)}</td><td class="n">${fmt(q.floodKm2, 2)}</td><td class="n">${fmtInt(q.population)}</td></tr>`).join('')}</tbody></table>
    <p class="note">Only the part of each area inside the analysed box is counted. ${esc(S.zonesSource || '')}${z.length > 25 ? ` · ${z.length - 25} more in the CSV` : ''}</p>`;
}

// histogram with a draggable threshold
const H = $('hist'), hctx = H.getContext('2d');
// drawn in CSS pixels at the panel's width, sharp on high-density screens; axis in dB, bar height on a square-root scale
const HIST_H = 240;
function drawHist(r) {
  const W = H.clientWidth || H.parentElement.clientWidth || 340, Hh = HIST_H, dpr = window.devicePixelRatio || 1;
  if (H.width !== Math.round(W * dpr)) { H.width = Math.round(W * dpr); H.height = Math.round(Hh * dpr); H.style.height = `${Hh}px`; }
  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pad = { l: 8, r: 8, t: 22, b: 26 }, h = r.hist, max = Math.max(...h, 1);
  hctx.clearRect(0, 0, W, Hh);
  const X = db => pad.l + (db + 30) / 30 * (W - pad.l - pad.r), Y = v => Hh - pad.b - Math.sqrt(v / max) * (Hh - pad.t - pad.b);
  const t = r.threshold.value;
  for (let i = 0; i < h.length; i++) {
    const db = -30 + i / 10; hctx.fillStyle = db < t ? '#1f5fbf' : '#c4cad1';
    hctx.fillRect(X(db), Y(h[i]), Math.max(1, X(db + 0.1) - X(db)), Hh - pad.b - Y(h[i]));
  }
  hctx.strokeStyle = '#dde1e5'; hctx.lineWidth = 1; hctx.beginPath(); hctx.moveTo(pad.l, Hh - pad.b + 0.5); hctx.lineTo(W - pad.r, Hh - pad.b + 0.5); hctx.stroke();
  hctx.strokeStyle = '#16191d'; hctx.lineWidth = 2; hctx.beginPath(); hctx.moveTo(X(t), pad.t - 6); hctx.lineTo(X(t), Hh - pad.b); hctx.stroke();
  hctx.fillStyle = "#5f6772"; hctx.font = '12px Satoshi, system-ui, sans-serif'; hctx.textAlign = 'center'; hctx.textBaseline = 'alphabetic';
  for (let d = -30; d <= 0; d += 5) hctx.fillText(`${String(d).replace('-', '−')}${d === 0 ? ' dB' : ''}`, Math.min(Math.max(X(d), 14), W - 18), Hh - 8);
  hctx.fillStyle = '#16191d'; hctx.font = '600 12.5px Satoshi, system-ui, sans-serif';
  const lab = `Water below ${fmt(t)} dB`.replace('-', '−');
  hctx.textAlign = X(t) > W - 140 ? 'right' : 'left'; hctx.fillText(lab, X(t) + (hctx.textAlign === 'left' ? 6 : -6), pad.t - 8);
  H.dataset.pad = JSON.stringify(pad); H.dataset.w = W;
}
window.addEventListener('resize', () => { if (S.result && !document.querySelector('[data-tabpane="thr"]').hidden) drawHist(S.result); });
let dragH = false;
const hDb = ev => { const b = H.getBoundingClientRect(), pad = JSON.parse(H.dataset.pad), x = ev.clientX - b.left; return Math.max(-26, Math.min(-12, -30 + (x - pad.l) / (b.width - pad.l - pad.r) * 30)); };
H.addEventListener('pointerdown', ev => { if (!S.result) return; dragH = true; H.setPointerCapture(ev.pointerId); move(ev); });
H.addEventListener('pointermove', ev => dragH && move(ev));
H.addEventListener('pointerup', () => { dragH = false; });
H.addEventListener('pointercancel', () => { dragH = false; });
H.addEventListener('lostpointercapture', () => { dragH = false; });
function move(ev) { setThreshold(hDb(ev)); }
H.tabIndex = 0;
H.setAttribute('role', 'slider'); H.setAttribute('aria-label', 'Water threshold, VV after the event, in dB'); H.setAttribute('aria-valuemin', '-26'); H.setAttribute('aria-valuemax', '-12');
function setThreshold(t) {
  t = Math.max(-26, Math.min(-12, Math.round(t * 10) / 10));
  $('p-thr').value = t; $('o-thr').textContent = `${fmt(t)} dB`.replace('-', '−');
  H.setAttribute('aria-valuenow', String(t)); H.setAttribute('aria-valuetext', `${fmt(t)} dB`.replace('-', '−'));
  S.result.threshold.value = t; drawHist(S.result); scheduleReclassify({ threshold: t });
}
H.addEventListener('keydown', ev => {
  if (!S.result) return;
  const t = S.result.threshold.value;
  const next = { ArrowLeft: t - 0.1, ArrowDown: t - 0.1, ArrowRight: t + 0.1, ArrowUp: t + 0.1, PageDown: t - 1, PageUp: t + 1, Home: -26, End: -12 }[ev.key];
  if (next === undefined) return;
  ev.preventDefault(); setThreshold(next);
});

// ---------------------------------------------------------------- exports
// Download items are disabled until a result exists; the flood extent is also disabled when the result holds no flood water
function syncExports() {
  const has = !!S.result, flood = has ? S.result.summary.areaKm2.flood : 0;
  document.querySelectorAll('[data-export]').forEach(b => { b.disabled = !has || (b.dataset.export === 'geojson' && !(flood > 0)); });
  const note = $('dl-note');
  note.hidden = has && flood > 0;
  note.textContent = !has ? 'Downloads are available once a flood map exists.' : 'This result has no flood water, so there is no flood extent to download.';
}
const NAMES = { geojson: 'flood-extent.geojson', geotiff: 'flood-classes.tif', csv: 'flood-statistics.csv', json: 'processing-metadata.json' };
document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', async () => {
  if (!S.result) return;
  if (b.disabled) return;
  const kind = b.dataset.export, stem = `floodscope_${S.result.meta.post.datetime.slice(0, 10)}`;
  try {
    if (kind === 'png') return save(await mapPng(), `${stem}_map.png`);
    if (kind === 'pdf') return printReport();
    const { blob } = await ask('export', { kind });
    save(blob, `${stem}_${NAMES[kind]}`);
  } catch (e) { $('r-sub').textContent = `Download failed: ${e.message}`; }
}));
function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
async function mapPng() {
  await new Promise(r => { map.once('render', r); map.triggerRepaint(); });
  const src = map.getCanvas(), c = document.createElement('canvas'), dpr = window.devicePixelRatio || 1, foot = 50 * dpr;
  c.width = src.width; c.height = src.height + foot;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(src, 0, 0);
  const m = S.result.meta;
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

// the previous result is removed from the map, figures and tabs when a new run starts or the inputs change
const EMPTY_KPI = $('figures').innerHTML;
function clearResult() {
  S.result = null;
  ['cls', 'radar'].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });
  $('legend').hidden = true; $('inspect').hidden = true; syncExports();
  $('figures').classList.add('empty'); $('figures').innerHTML = EMPTY_KPI;
  $('thr-empty').hidden = false; hctx.setTransform(1, 0, 0, 1, 0, 0); hctx.clearRect(0, 0, H.width, H.height);
  $('lc').innerHTML = '<p class="empty-state">Map a flood to see its land cover.</p>';
  $('zones').innerHTML = '<p class="empty-state">Map a flood to see the areas it covers.</p>';
  $('r-title').textContent = 'Flood extent from Sentinel-1 radar';
  $('r-sub').textContent = 'Where open water appeared between two radar images, and who lived there.';
  summary(2, 'Rules and run');
}

// ---------------------------------------------------------------- tabs, downloads menu, about
function showTab(t) {
  document.querySelectorAll('.tabs button').forEach(x => { x.setAttribute('aria-selected', String(x.dataset.tab === t)); x.tabIndex = x.dataset.tab === t ? 0 : -1; });
  document.querySelectorAll('[data-tabpane]').forEach(p => { p.hidden = p.dataset.tabpane !== t; });
  if (t === 'thr' && S.result) drawHist(S.result);
}
const tabBtns = [...document.querySelectorAll('.tabs button')];
tabBtns.forEach(b => {
  const pane = document.querySelector(`[data-tabpane="${b.dataset.tab}"]`);
  b.id = `tab-${b.dataset.tab}`; pane.id = `pane-${b.dataset.tab}`; pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', b.id); b.setAttribute('aria-controls', pane.id);
  b.addEventListener('click', () => showTab(b.dataset.tab));
  b.addEventListener('keydown', e => {
    const i = tabBtns.indexOf(b), j = e.key === 'ArrowRight' ? (i + 1) % tabBtns.length : e.key === 'ArrowLeft' ? (i - 1 + tabBtns.length) % tabBtns.length : -1;
    if (j < 0) return; e.preventDefault(); tabBtns[j].focus(); showTab(tabBtns[j].dataset.tab);
  });
});
document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', () => { $('dl-menu').open = false; }));
document.addEventListener('click', e => { if ($('dl-menu').open && !$('dl-menu').contains(e.target)) $('dl-menu').open = false; });
const aboutOpen = () => { $('about').hidden = false; $('about-close').focus(); }, aboutClose = () => { $('about').hidden = true; $('about-open').focus(); };
$('about-open').addEventListener('click', aboutOpen);
$('about-close').addEventListener('click', aboutClose);
$('about').addEventListener('click', e => { if (e.target === $('about')) aboutClose(); });
$('about').addEventListener('keydown', e => {   // keep Tab inside the open dialog
  if (e.key !== 'Tab') return;
  const f = [...$('about').querySelectorAll('a[href], button:not([disabled])')], first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('about').hidden) aboutClose(); $('dl-menu').open = false; if (drawing) setDraw(false); } });
// new dates make the last search out of date: the next visit to step 2 or List images searches again
['d0', 'd1'].forEach(id => $(id).addEventListener('change', () => { S.searched = null; if (!S.acq.length) renderTimeline(); }));
renderTimeline(); go(0); syncExports();
