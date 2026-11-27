/* FloodScope page: welcome, three steps (place, radar images, result), export. All numbers shown come from the worker's run (js/pipeline.js). */
import { proj4 } from '../vendor/geo-libs.mjs';
import { defineEpsg } from './io.js';
import { CLASS_NAMES, WORLDCOVER } from './exports.js';
import { VERSION } from './version.js';

const $ = id => document.getElementById(id);
document.querySelectorAll('[data-ver]').forEach(e => { e.textContent = VERSION; });
const BASE = new URL('..', import.meta.url).href.replace(/\/$/, '');
const ok = v => typeof v === 'number' && v === v && Number.isFinite(v);
const fmt = (v, d = 1) => !ok(v) ? '—' : new Intl.NumberFormat('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtInt = v => !ok(v) ? '—' : new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(Math.round(v));
const neg = t => String(t).replace(/-(\d)/g, '−$1');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = (t, long) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' });
const COLORS = { 2: [21, 84, 192, 235], 3: [111, 163, 240, 220], 4: [11, 42, 74, 200], 5: [201, 198, 189, 150], 6: [143, 185, 179, 190] };
const LIMIT_KM2 = 3600, NOMINATIM = 'https://nominatim.openstreetmap.org';
const PHONE = matchMedia('(max-width: 860px)').matches;

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
worker.onerror = e => {
  const err = new Error(`The analysis engine stopped (${e.message || 'script error'}). Reload the page and try again.`);
  for (const [id, p] of pending) { pending.delete(id); p.reject(err); }
};
const ask = (cmd, payload = {}, onProgress) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ cmd, id, ...payload });
});

// ---------------------------------------------------------------- state and views
const S = { aoi: null, acq: [], pre: null, post: null, result: null, searched: null, view: 'place', example: false };
let running = false, runSeq = 0;
const STEP_OF = { place: 'place', images: 'images', running: 'images', error: 'images', result: 'result' };
const ORDER = ['place', 'images', 'result'];
function show(v) {
  S.view = v;
  document.querySelectorAll('[data-view]').forEach(el => { el.hidden = el.dataset.view !== v; });
  syncStepper();
  $('app').querySelector('.panel').scrollTop = 0;
  const h = document.querySelector(`[data-view="${v}"] h2`); if (h && $('welcome').hidden) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  if (v === 'images' && S.aoi && S.aoi.ok && !S.acq.length && !S.searched) listImages();
}
function syncStepper() {
  const cur = ORDER.indexOf(STEP_OF[S.view]);
  const can = { place: !running, images: !running && !!(S.aoi && S.aoi.ok), result: !running && !!S.result };
  document.querySelectorAll('#stepper li').forEach(li => {
    const k = ORDER.indexOf(li.dataset.s), b = li.querySelector('button');
    li.classList.toggle('on', k === cur); li.classList.toggle('done', k < cur);
    b.disabled = !can[li.dataset.s]; b.setAttribute('aria-current', k === cur ? 'step' : 'false');
  });
}
document.querySelectorAll('#stepper button').forEach(b => b.addEventListener('click', () => show(b.parentElement.dataset.s)));
document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => show(b.dataset.goto)));

// welcome and onboarding
function closeWelcome() { $('welcome').hidden = true; $('app').inert = false; $('home').hidden = false; document.body.classList.remove('welcoming'); map.resize(); }
function openWelcome() { if (running) return; $('welcome').hidden = false; $('app').inert = true; $('home').hidden = true; document.body.classList.add('welcoming'); $('w-q').value = ''; $('w-q').focus(); }
document.body.classList.add('welcoming'); $('app').inert = true;
$('w-skip').addEventListener('click', () => { closeWelcome(); show('place'); firstTour(); });
$('home').addEventListener('click', openWelcome);
$('how-open').addEventListener('click', () => openTour(0));
const TOUR = [
  { h: 'Choose a place', t: 'Search a town or river, or draw a box on the map. Any area from 0.5 to 3,600 km².',
    art: '<div class="mk"><div class="mk-field">Search a town or river</div><div class="mk-box"></div></div>' },
  { h: 'Pick two radar images', t: 'Set the dates around the flood, then choose one image before it and one after it on the same track.',
    art: '<div class="mk"><div class="mk-chips"><span>2 Aug</span><span style="background:#15171c;color:#fff;border-color:#15171c">14 Aug</span><span>26 Aug</span><span>7 Sep</span><span style="background:#2b55c7;color:#fff;border-color:#2b55c7">13 Oct</span></div><div class="mk-btn">Map the flood</div></div>' },
  { h: 'Read, tune and export', t: 'See the new water, the people modelled to live in it and the land it covered. Test the threshold, then export.',
    art: '<div class="mk"><div class="mk-verdict">22.4 km² of new water</div><div class="mk-chips"><span>Report</span><span>GeoJSON</span><span>GeoTIFF</span><span>CSV</span><span>Share link</span></div></div>' },
];
let tourAt = 0;
function renderTour() {
  const T = TOUR[tourAt];
  $('tour-art').innerHTML = T.art; $('tour-n').textContent = `Step ${tourAt + 1} of ${TOUR.length}`; $('tour-h').textContent = T.h; $('tour-t').textContent = T.t;
  document.querySelectorAll('#tour-dots i').forEach((d, i) => d.classList.toggle('on', i === tourAt));
  $('tour-next').textContent = tourAt === TOUR.length - 1 ? 'Start' : 'Next'; $('tour-skip').hidden = tourAt === TOUR.length - 1;
}
function openTour(k) { tourAt = k; renderTour(); if (!$('tour').open) $('tour').showModal(); $('tour-next').focus(); }
const remember = () => { try { localStorage.setItem('floodscope.tour', '1'); } catch { /* storage may be blocked */ } };
function closeTour() { $('tour').close(); remember(); }
function firstTour() { let seen = false; try { seen = localStorage.getItem('floodscope.tour') === '1'; } catch { /* treat as not seen */ } if (!seen) openTour(0); }
$('tour-next').addEventListener('click', () => { if (tourAt < TOUR.length - 1) { tourAt++; renderTour(); } else closeTour(); });
$('tour-skip').addEventListener('click', closeTour);
$('tour').addEventListener('cancel', remember);

// ---------------------------------------------------------------- map
const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: [10, 15], zoom: 2.2,
  attributionControl: false, preserveDrawingBuffer: true });
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
if (!PHONE) map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
if (PHONE) map.once('load', () => document.querySelectorAll('.maplibregl-ctrl-attrib').forEach(e => { e.classList.remove('maplibregl-compact-show'); e.removeAttribute('open'); }));
const ready = new Promise(r => map.on('load', r));
const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9ecef' } }] };
let styleFallback = false;
map.on('error', e => { if (styleFallback || map.isStyleLoaded() || (e && e.sourceId)) return; styleFallback = true; $('mapnote').hidden = false; map.setStyle(FALLBACK_STYLE); });
const EMPTY = { type: 'FeatureCollection', features: [] };
ready.then(() => {
  map.addSource('s2', { type: 'raster', tileSize: 256, maxzoom: 15, attribution: 'Sentinel-2 cloudless 2024 by <a href="https://s2maps.eu">EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data 2024)',
    tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'] });
  const first = map.getStyle().layers.find(l => l.type === 'symbol');
  map.addLayer({ id: 's2', type: 'raster', source: 's2', layout: { visibility: 'none' } }, first && first.id);
  map.addSource('aoi', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#2b55c7', 'fill-opacity': 0.05 } });
  map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#15171c', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
});
const fitBox = b => map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: PHONE ? 30 : { top: 60, bottom: 50, left: 50, right: 300 }, duration: 800, maxZoom: 13 });

// ---------------------------------------------------------------- place
const ringOf = b => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]];
function areaKm2(b) { const R = 6371.0088, r = Math.PI / 180; return R * R * Math.abs((b[2] - b[0]) * r) * Math.abs(Math.sin(b[3] * r) - Math.sin(b[1] * r)); }
let searchSeq = 0;
async function setAoi(b, label, note) {
  if (running) { worker.postMessage({ cmd: 'cancel', id: 0 }); runSeq++; running = false; if (S.view === 'running') show('place'); }   // a new place ends the running analysis
  S.example = false;
  const shift = Math.round(((b[0] + b[2]) / 2) / 360) * 360;   // the map repeats the world sideways
  b = [b[0] - shift, b[1], b[2] - shift, b[3]];
  const crosses = b[0] < -180 || b[2] > 180;   // a box over the 180° meridian cannot be one UTM grid
  b = [Math.max(-180, b[0]), Math.max(-85, b[1]), Math.min(180, b[2]), Math.min(85, b[3])];
  const a = areaKm2(b), outside = b[1] < -56 || b[3] > 78;
  const problem = crosses ? 'The box crosses the 180° meridian. Draw it on one side.'
    : a > LIMIT_KM2 ? `Larger than the ${fmtInt(LIMIT_KM2)} km² limit. Draw a smaller box.`
    : a < 0.5 ? 'Smaller than the 0.5 km² minimum. Draw a larger box.'
    : outside ? 'Outside 56° S to 78° N, where the permanent-water layer exists.' : '';
  if (S.result) clearResult();
  S.aoi = { bbox: b, ring: ringOf(b), area: a, label, ok: !problem };
  searchSeq++; S.acq = []; S.pre = S.post = null; S.searched = null; renderTimeline();
  const c = $('chosen'); c.hidden = false; c.classList.toggle('bad', !!problem);
  c.innerHTML = `<b>${esc(label)}</b><span class="meta">${problem ? esc(problem) : `${fmt(a, a < 10 ? 1 : 0)} km²${note ? ` · ${esc(note)}` : ''}`}</span>`;
  $('to-images').disabled = !!problem;
  $('img-place').textContent = `${label} · ${fmt(a, a < 10 ? 1 : 0)} km²`;
  syncStepper(); updateRun();
  await ready;
  map.getSource('aoi').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [S.aoi.ring] } });
  return !problem;
}
$('to-images').addEventListener('click', () => show('images'));

let drawing = false, start = null;
$('draw').addEventListener('click', () => setDraw(!drawing));
function setDraw(on) {
  drawing = on; $('draw').setAttribute('aria-pressed', String(on)); $('draw').textContent = on ? 'Cancel drawing' : 'Draw a box on the map';
  $('map-hint').hidden = !on;
  map.getCanvas().style.cursor = on ? 'crosshair' : ''; on ? map.dragPan.disable() : map.dragPan.enable();
  if (on && PHONE) $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
const boxFrom = e => [Math.min(start.lng, e.lngLat.lng), Math.min(start.lat, e.lngLat.lat), Math.max(start.lng, e.lngLat.lng), Math.max(start.lat, e.lngLat.lat)];
map.on('mousedown', e => { if (drawing) start = e.lngLat; });
map.on('touchstart', e => { if (drawing && e.points.length === 1) { start = e.lngLat; e.preventDefault(); } });
const drag = e => { if (drawing && start) map.getSource('aoi').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ringOf(boxFrom(e))] } }); };
map.on('mousemove', drag); map.on('touchmove', drag);
const finish = e => {
  if (!drawing || !start) return;
  const b = boxFrom(e); start = null; setDraw(false);
  if (b[2] - b[0] < 1e-4 || b[3] - b[1] < 1e-4) {   // a click, not a box
    map.getSource('aoi').setData(S.aoi ? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [S.aoi.ring] } } : EMPTY);
    $('map-hint').hidden = false; $('map-hint').textContent = 'Press and drag to draw a box';
    setTimeout(() => { if (!drawing) $('map-hint').hidden = true; $('map-hint').textContent = 'Drag across the map to draw your area'; }, 2200);
    return;
  }
  setAoi(b, 'Drawn area'); defaultDates();
};
map.on('mouseup', finish); map.on('touchend', finish);

// place search (Nominatim, on submit only, as its usage policy asks); welcome and step 1 share it
function bindSearch(form, input, list, after) {
  const msg = t => { list.hidden = false; list.innerHTML = `<li class="msg">${t}</li>`; };
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const q = input.value.trim();
    if (!q) { msg('Type a place name, for example a town or a river.'); input.focus(); return; }
    msg('Searching…');
    try {
      const r = await fetch(`${NOMINATIM}/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`search failed (${r.status})`);
      const found = await r.json();
      if (!found.length) { msg('No place found. Try a larger town nearby.'); return; }
      list.innerHTML = '';
      for (const p of found) {
        const li = document.createElement('li'), b = document.createElement('button'), parts = p.display_name.split(', ');
        b.type = 'button'; b.innerHTML = `<b>${esc(parts[0])}</b><span>${esc(parts.slice(1).join(', '))}</span>`;
        b.onclick = async () => {
          list.hidden = true; input.value = parts[0];
          const lat = +p.lat, lon = +p.lon, k = 0.09 / Math.cos(lat * Math.PI / 180);   // about 20 x 20 km around the place
          const box = [lon - k, lat - 0.09, lon + k, lat + 0.09], name = p.name || parts[0];
          const wide = ['country', 'state', 'region', 'province', 'county', 'administrative'].includes(p.addresstype || p.type);
          after();
          const good = await setAoi(box, `${name}, ${parts[parts.length - 1]}`, wide ? 'a box at its centre; draw to choose the part you need' : 'a 20 km box around it');
          fitBox(box); defaultDates();
          if (good) show('images');
        };
        li.append(b); list.append(li);
      }
      list.querySelector('button').focus();
    } catch (e) { msg(`Place search is unavailable (${esc(e.name === 'TimeoutError' ? 'no answer within 15 seconds' : e.message)}). Use the map to draw a box instead.`); }
  });
  document.addEventListener('click', e => { if (!form.contains(e.target)) list.hidden = true; });
}
bindSearch($('w-search'), $('w-q'), $('w-results'), () => { closeWelcome(); firstTour(); });
bindSearch($('search'), $('q'), $('results'), () => {});

// ---------------------------------------------------------------- radar images
const iso = d => d.toISOString().slice(0, 10);
function defaultDates() {   // the last 60 days: a recent flood is the common case; the hint says to change them
  const t = new Date(); $('d1').value = iso(t); $('d0').value = iso(new Date(t - 60 * 864e5));
  $('pick-info').textContent = 'Set the dates around the flood, then find the images.';
}
defaultDates();
['d0', 'd1'].forEach(id => $(id).addEventListener('change', () => { S.searched = null; S.acq = []; S.pre = S.post = null; if (S.result) clearResult(); renderTimeline(); updateRun(); }));
$('list').addEventListener('click', listImages);
async function listImages() {
  if (!S.aoi || !S.aoi.ok) return;
  const mine = ++searchSeq, aoiAtStart = S.aoi, d0 = $('d0').value, d1 = $('d1').value;
  if (!d0 || !d1 || d0 > d1) { $('pick-info').textContent = 'The start date must be before the end date.'; return; }
  $('timeline').innerHTML = '<p class="empty">Searching the Sentinel-1 archive…</p>'; $('pick-info').textContent = '';
  try {
    const { list, truncated } = await ask('acquisitions', { bbox: S.aoi.bbox, start: `${d0}T00:00:00Z`, end: `${d1}T23:59:59Z` });
    if (mine !== searchSeq || S.aoi !== aoiAtStart) return;   // the area or the dates changed while searching
    S.acq = list; S.pre = S.post = null; S.searched = { d0, d1, truncated }; renderTimeline(); updateRun();
  } catch (e) {
    if (mine !== searchSeq) return;
    S.acq = []; S.searched = null; $('timeline').innerHTML = `<p class="empty">Could not list the images: ${esc(e.message)}. Press Find radar images to try again.</p>`; updateRun();
  }
}
const trackKey = a => `${a.orbitState} · relative orbit ${a.relativeOrbit}`;
const short = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
function renderTimeline() {
  const el = $('timeline'), info = $('pick-info');
  $('pair').hidden = !(S.pre);
  if (!S.acq.length) {
    el.innerHTML = '';
    if (S.searched) info.innerHTML = `<span class="warn">No Sentinel-1 images between ${esc(S.searched.d0)} and ${esc(S.searched.d1)}. Widen the dates or move the box.</span>`;
    return;
  }
  const groups = new Map();
  for (const a of S.acq) { const k = trackKey(a); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  el.innerHTML = '';
  for (const [k, items] of groups) {
    const box = document.createElement('div'); box.className = 'track';
    box.innerHTML = `<span class="lbl">${esc(k[0].toUpperCase() + k.slice(1))} · ${items.length} image${items.length === 1 ? '' : 's'}</span>`;
    const t = document.createElement('div'); t.className = 'ticks';
    for (const a of items) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tick';
      b.textContent = short(a.datetime); b.title = `${a.platform}, ${a.datetime.replace('T', ' ').slice(0, 16)} UTC`;
      if (S.pre && S.pre.id === a.id) b.dataset.role = 'pre';
      if (S.post && S.post.id === a.id) b.dataset.role = 'post';
      if (S.pre && !S.post && (trackKey(a) !== trackKey(S.pre) || a.datetime <= S.pre.datetime)) b.classList.add('other');
      b.onclick = () => pick(a);
      t.append(b);
    }
    box.append(t); el.append(box);
  }
  const canPair = [...groups.values()].some(g => g.length > 1);
  info.innerHTML = (S.searched && S.searched.truncated ? '<span class="warn">Only the first 400 scenes are listed; shorten the dates to see later ones.</span> ' : '')
    + (!canPair ? '<span class="warn">Each track has only one image, so no pair can be made. Widen the dates.</span>'
    : !S.pre ? 'Tap the image <b>before</b> the flood.' : !S.post ? 'Now tap the image <b>after</b> the flood, on the same track.' : 'Ready. Tap any date to start the pair again.');
  if (S.pre) $('pair').innerHTML = `<div><span>Before</span><br><b>${day(S.pre.datetime)}</b></div><div><span>After</span><br><b>${S.post ? day(S.post.datetime) : '—'}</b></div>`
    + (S.post ? `<div class="gap">${Math.round((Date.parse(S.post.datetime) - Date.parse(S.pre.datetime)) / 864e5)} days apart · ${esc(trackKey(S.pre))}</div>` : '');
}
function pick(a) {
  // a later date on the same track completes the pair; any other date starts a new "before"
  if (S.pre && !S.post && trackKey(a) === trackKey(S.pre) && a.datetime > S.pre.datetime) S.post = a;
  else { S.pre = a; S.post = null; }
  if (S.result) clearResult();
  renderTimeline(); updateRun();
}
function updateRun() { $('run').disabled = running || !(S.aoi && S.aoi.ok && S.pre && S.post); syncStepper(); }

// ---------------------------------------------------------------- settings
// with the automatic threshold on, the fallback is always the documented default (-18 dB), never a value left on the slider
const P = () => ({ autoThreshold: $('p-auto').checked, thresholdVV: $('p-auto').checked ? -18 : +$('p-thr').value, changeDb: +$('p-chg').value, slopeMax: +$('p-slp').value, permanentOccurrence: +$('p-occ').value });
const outs = { 'p-thr': ['o-thr', v => `${fmt(v)} dB`], 'p-chg': ['o-chg', v => `${fmt(v)} dB`], 'p-slp': ['o-slp', v => `${v}°`], 'p-occ': ['o-occ', v => `${v}%`] };
for (const [id, [o, f]] of Object.entries(outs)) $(id).addEventListener('input', () => {
  $(o).textContent = neg(f(+$(id).value));
  if (id === 'p-thr') $('p-auto').checked = false;
  if (S.result && S.view !== 'result') { clearResult(); return; }   // changed in Advanced settings: run again rather than alter a result that is not on screen
  if (S.result) scheduleReclassify(id === 'p-thr' ? { threshold: +$('p-thr').value } : {});
});
['p-auto', 'p-zones'].forEach(id => $(id).addEventListener('change', () => { if (S.result) clearResult(); }));

// ---------------------------------------------------------------- run
const STAGES = ['read', 'layers', 'people', 'map'];
function stage(k) { const i = STAGES.indexOf(k); document.querySelectorAll('#stages li').forEach(li => { const j = STAGES.indexOf(li.dataset.k); li.className = j < i ? 'ok' : j === i ? 'on' : ''; }); }
const STEPS_EXPECTED = 14;   // progress messages in a typical run (pipeline.runAnalysis), used only for the bar
$('run').addEventListener('click', runNow);
$('cancel').addEventListener('click', () => { worker.postMessage({ cmd: 'cancel', id: 0 }); runSeq++; running = false; show('images'); });   // also ends a run still waiting for the administrative areas
async function runNow() {
  if (running || !S.aoi || !S.pre || !S.post) return;
  const aoi = S.aoi, pre = S.pre, post = S.post, mine = ++runSeq;   // fixed for this run, even if the inputs change while it runs
  clearTimeout(rcTimer); rcSeq++; if (S.result) clearResult();
  running = true; S.runDates = { d0: $('d0').value, d1: $('d1').value }; show('running'); stage('read'); $('bar').style.width = '3%';
  $('run-what').textContent = `${aoi.label} · ${day(pre.datetime)} to ${day(post.datetime)}`;
  if (PHONE) $('app').querySelector('.panel').scrollIntoView({ behavior: 'smooth' });
  let n = 0, zones = null; S.zonesError = $('p-zones').checked ? null : 'off'; S.log = [];
  if ($('p-zones').checked) zones = await loadZones(aoi).catch(e => { S.zonesError = /fetch|network|timeout|abort/i.test(e.name + ' ' + e.message) ? 'the boundary or place service did not answer' : e.message; return null; });
  if (mine !== runSeq) return;
  const onProgress = msg => {
    if (mine !== runSeq) return;
    S.log.push(msg); n++; $('bar').style.width = `${Math.min(97, 3 + n / STEPS_EXPECTED * 94)}%`;
    if (/Global Surface Water|DEM|WorldCover/.test(msg)) stage('layers');
    else if (/GHS-POP/.test(msg)) stage('people');
    else if (/threshold|Rasterising|^Done/.test(msg)) stage('map');
  };
  try {
    const r = await ask('run', { args: { aoi: { type: 'Polygon', coordinates: [aoi.ring] }, pre, post, params: P(), base: BASE, zones, label: aoi.label } }, onProgress);
    if (mine !== runSeq) return;
    running = false; S.result = r; S.zonesSource = zones ? zones.source : null; $('bar').style.width = '100%';
    $('p-thr').value = r.threshold.value; $('o-thr').textContent = neg(`${fmt(r.threshold.value)} dB`);
    await drawResult(r, true);
    show('result'); shareUrl();
    if (PHONE) window.scrollTo({ top: $('r-verdict').getBoundingClientRect().top + window.scrollY - 180, behavior: 'smooth' });
  } catch (e) {
    if (mine !== runSeq) return;
    running = false;
    if (e.message === 'Cancelled') { show('images'); return; }
    $('err-msg').textContent = e.message; show('error');
  }
}

let rcTimer = null, rcSeq = 0;
function scheduleReclassify(extra) {
  clearTimeout(rcTimer);
  if (running) return;
  rcTimer = setTimeout(async () => {
    if (running || !S.result) return;
    const p = P(), params = { changeDb: p.changeDb, slopeMax: p.slopeMax, permanentOccurrence: p.permanentOccurrence, ...extra };
    const mine = ++rcSeq;
    try { const r = await ask('reclassify', { params }); if (mine !== rcSeq || running) return; S.result = r; await drawResult(r, false); shareUrl(); } catch (e) { if (mine === rcSeq && !running) $('thr-note').textContent = e.message; }
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
    const m = await fetch(`https://www.geoboundaries.org/api/current/gbOpen/${iso3}/${lvl}/`, { signal: AbortSignal.timeout(20000) });
    if (!m.ok) continue;
    const meta = await m.json();
    const url = String(meta.simplifiedGeometryGeoJSON || '').replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\//, 'https://media.githubusercontent.com/media/$1/$2/');
    if (!url) continue;
    const g = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (!g.ok) continue;
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
let corners = null, radarCanvas = null, clsCanvas = null, swipeAt = 50;
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
  if (fit) { const lons = corners.map(c => c[0]), lats = corners.map(c => c[1]); fitBox([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]); renderLegend(); }
  renderSummary(r); renderLandcover(r); renderZones(r); renderRun(r); thresholdNote(r);
  requestAnimationFrame(() => drawHist(r));
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
function onSwipe(v) { swipeAt = v; if (!S.result) return; if (!visible.radar) { visible.radar = true; const c = $('legend').querySelector('[data-k="radar"]'); if (c) c.checked = true; applyVisibility(); } paintRadar(S.result); setImage('radar', radarCanvas); }
function applyVisibility() {
  if (map.getLayer('radar')) map.setLayoutProperty('radar', 'visibility', visible.radar ? 'visible' : 'none');
  if (map.getLayer('s2')) map.setLayoutProperty('s2', 'visibility', visible.s2 ? 'visible' : 'none');
}
function renderLegend() {
  const rows = [['flood', 'New water, high confidence', COLORS[2]], ['flood', 'New water, medium confidence', COLORS[3]], ['perm', 'Permanent water', COLORS[4]],
    ['before', 'Water before the flood', COLORS[6]], ['steep', 'Too steep to judge', COLORS[5]], ['radar', 'Radar images', null], ['s2', 'Satellite basemap', null]];
  const L = $('legend'); L.hidden = false;
  L.innerHTML = `<details ${PHONE ? '' : 'open'}><summary><h4 style="display:inline">Map layers</h4></summary>` + rows.map(([k, t, c], i) => i === 1
    ? `<label style="padding-left:21px"><i style="background:rgba(${c.slice(0, 3)},${c[3] / 255})"></i>${t}</label>`
    : `<label><input type="checkbox" data-k="${k}" ${visible[k] ? 'checked' : ''}>${c ? `<i style="background:rgba(${c.slice(0, 3)},${c[3] / 255})"></i>` : ''}${t}</label>`).join('') +
    `<div class="swipe"><label for="swipe">Radar: before ⟷ after</label><input type="range" id="swipe" min="0" max="100" value="${swipeAt}"></div></details>`;
  $('swipe').addEventListener('input', e => onSwipe(+e.target.value));
  L.querySelectorAll('input[data-k]').forEach(inp => inp.onchange = () => {
    visible[inp.dataset.k] = inp.checked;
    if (['flood', 'perm', 'before', 'steep'].includes(inp.dataset.k)) { clsCanvas = paintClasses(S.result.cls, S.result.grid); setImage('cls', clsCanvas); }
    applyVisibility();
  });
}
// click on the map: the values of that pixel
map.on('click', async e => {
  if (drawing || !S.result) return;
  const g = S.result.grid, [x, y] = proj4('EPSG:4326', defineEpsg(g.crs)).forward([e.lngLat.lng, e.lngLat.lat]);
  const c = Math.floor((x - g.x0) / g.res), r = Math.floor((g.y1 - y) / g.res), box = $('inspect');
  if (c < 0 || r < 0 || c >= g.w || r >= g.h) { box.hidden = true; return; }
  const { values: v } = await ask('inspect', { index: r * g.w + c });
  const dB = q => q == null ? '—' : neg(`${fmt(q)} dB`);
  box.hidden = false;
  box.innerHTML = `<button class="x" type="button">Close</button><div class="muted">${fmt(e.lngLat.lat, 4)}°, ${fmt(e.lngLat.lng, 4)}°</div><dl>
    <dt>Class</dt><dd>${esc(CLASS_NAMES[v.cls])}</dd>
    <dt>Radar before</dt><dd>${dB(v.preVV)}</dd><dt>Radar after</dt><dd>${dB(v.postVV)}</dd>
    <dt>Change (VV)</dt><dd>${v.preVV == null || v.postVV == null ? '—' : dB(v.postVV - v.preVV)}</dd>
    <dt>Change (VH)</dt><dd>${v.preVH == null || v.postVH == null ? '—' : dB(v.postVH - v.preVH)}</dd>
    <dt>Water in past years</dt><dd>${v.occurrence == null || v.occurrence > 100 ? '—' : fmt(v.occurrence, 0) + '%'}</dd>
    <dt>Slope</dt><dd>${v.slope == null ? '—' : fmt(v.slope) + '°'}</dd>
    <dt>Land cover</dt><dd>${esc(WORLDCOVER[v.landcover] || '—')}</dd>
    <dt>Residents</dt><dd>${v.popDensity == null ? '—' : fmtInt(v.popDensity) + ' /km²'}</dd></dl>`;
  box.querySelector('.x').onclick = () => { box.hidden = true; };
});

// ---------------------------------------------------------------- result
const EXAMPLES = [{ short: 'Lokoja, Nigeria', year: 2022, label: 'Lokoja, Kogi State, Nigeria: Niger–Benue confluence', bbox: [6.70, 7.70, 6.85, 7.85], d0: '2022-07-01', d1: '2022-11-30', pre: '2022-08-02', post: '2022-10-13' }];
const noPop = s => s.validPixels > 0 && s.population.pixelsWithoutPopulation >= s.validPixels;
function renderSummary(r) {
  const s = r.summary, a = s.areaKm2, m = r.meta, p = s.population, share = a.valid ? a.flood / a.valid * 100 : 0, vh = m.post.polarisations === 'VV, VH';
  $('r-where').textContent = `${m.label || 'Area'} · ${day(m.pre.datetime)} to ${day(m.post.datetime)}`;
  $('r-verdict').textContent = a.flood > 0 ? `${fmt(a.flood, a.flood < 10 ? 2 : 1)} km² of new water` : 'No new water found';
  const lc = Object.entries(s.landcoverKm2 || {}).filter(([k]) => +k !== 80).sort((x, y) => y[1] - x[1])[0];
  $('r-reading').textContent = a.flood > 0
    ? `${fmt(share)}% of the ground the radar could see turned to water${lc && lc[1] > 0 ? `, most of it on ${(WORLDCOVER[lc[0]] || 'unclassified land').toLowerCase()}` : ''}.${noPop(s) ? '' : ` About ${fmtInt(p.inFlood)} people are modelled to live inside it.`}`
    : 'No ground turned to open water between the two images with these rules. Try another pair, or drag the threshold below to the right (less negative) to count more water.';
  const stat = (l, v, d) => `<div class="stat"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  $('r-stats').innerHTML = stat('New water', `${fmt(a.flood, a.flood < 10 ? 2 : 1)}<small>km²</small>`, `${fmt(share)}% of the area`)
    + stat('High confidence', `${fmt(a.floodHigh, a.floodHigh < 10 ? 2 : 1)}<small>km²</small>`, vh ? 'both radar bands' : 'no VH band')
    + stat('Residents', noPop(s) ? '—' : fmtInt(p.inFlood), noPop(s) ? 'no population data' : 'modelled estimate');
  const ex = EXAMPLES[0], isExample = S.example && m.pre.datetime.startsWith(ex.pre) && m.post.datetime.startsWith(ex.post) && Math.abs(r.params.threshold + 18) < 1e-6 && r.params.changeDb === -3 && r.params.slopeMax === 5 && r.params.permanentOccurrence === 80;
  $('r-example').hidden = !isExample;
  if (isExample) $('r-example').textContent = 'Checked against UNOSAT: 99.9% of the water mapped here is also water in UNOSAT\'s independent VIIRS flood map of 13–17 October 2022, while FloodScope finds 50.2% of UNOSAT\'s water. Agreement is not accuracy.';
}
function renderLandcover(r) {
  const e = Object.entries(r.summary.landcoverKm2), max = Math.max(...e.map(x => x[1]), 1e-9);
  $('lc').innerHTML = e.length ? `<div class="bars">${e.sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `<div class="b"><span>${esc(WORLDCOVER[k] || k)}</span><span class="n">${fmt(v, 2)} km²</span><span class="tr"><i style="width:${(v / max * 100).toFixed(1)}%"></i></span></div>`).join('')}</div>`
    : '<p class="cap">No flood water with these settings.</p>';
}
function renderZones(r) {
  const z = r.summary.zones;
  $('zones').innerHTML = !z || !z.length
    ? `<p class="cap">${S.zonesSource ? 'No flood water inside the administrative areas found.' : S.zonesError === 'off' ? 'Switched off for this run (Advanced settings).' : `Administrative areas could not be loaded: ${esc(S.zonesError || 'unknown reason')}. The flood map and totals are not affected.`}</p>`
    : `<table class="zt"><thead><tr><th>Area</th><th class="n">Flooded km²</th><th class="n">Residents</th></tr></thead><tbody>${
      z.slice(0, 25).map(q => `<tr><td>${esc(q.name)}</td><td class="n">${fmt(q.floodKm2, 2)}</td><td class="n">${fmtInt(q.population)}</td></tr>`).join('')}</tbody></table>
      <p class="cap">Only the part of each area inside the box is counted. ${esc(S.zonesSource || '')}${z.length > 25 ? ` · ${z.length - 25} more in the CSV` : ''}</p>`;
}
function renderRun(r) {
  const s = r.summary, a = s.areaKm2, m = r.meta, p = s.population, part = p.pixelsWithoutPopulation / Math.max(1, s.validPixels);
  const rows = [
    ['Area', `${esc(m.label || '')}, ${fmt(m.aoiAreaKm2, 0)} km²; ${fmt(a.valid, 0)} km² with valid radar`],
    ['Images', `before ${esc(m.pre.datetime.slice(0, 16).replace('T', ' '))}, after ${esc(m.post.datetime.slice(0, 16).replace('T', ' '))} UTC; ${esc(m.post.platform)}, ${esc(m.post.orbitState)} orbit ${esc(m.post.relativeOrbit)}`],
    ['New water', `${fmt(a.flood, 2)} km²: ${fmt(a.floodHigh, 2)} high and ${fmt(a.floodMedium, 2)} medium confidence`],
    ['Set aside', `${fmt(a.permanent, 2)} km² permanent water, ${fmt(a.waterBefore, 2)} km² water before, ${fmt(a.steep, 2)} km² steep ground`],
    ['Residents', noPop(s) ? esc(m.populationNote || 'No GHS-POP population data for this area') : `${fmtInt(p.inFlood)} modelled (${fmtInt(p.inFloodHigh)} in high-confidence water), GHS-POP 2025${part > 0.005 ? `; no population data for ${fmt(part * 100, 0)}% of the pixels` : ''}`],
    ['Rule', neg(`radar after below ${fmt(r.params.threshold)} dB and at least ${fmt(-r.params.changeDb)} dB darker; slope up to ${r.params.slopeMax}°; permanent water from ${r.params.permanentOccurrence}% of years`)],
    ['Grid', `${m.resolutionM} m, ${esc(m.crs)}`],
    ['Software', `FloodScope ${esc(m.version)}, run ${esc(m.runAt.slice(0, 16).replace('T', ' '))} UTC`],
    ['Sources', Object.values(m.sources).filter(Boolean).map(esc).join('; ')],
  ];
  $('r-run').innerHTML = `<table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
}
// why the automatic threshold was or was not used, from the run's own histogram statistics (the rule in pipeline.js)
function thresholdNote(r) {
  const t = r.threshold, o = t.otsu || {}, pm = r.params, lo = pm.otsuMin ?? -24, hi = pm.otsuMax ?? -14, why = [];
  if (!(o.t === o.t)) why.push('there were too few pixels to find a split');
  else {
    if (o.valleyRatio > 0.5) why.push('the histogram has no clear second peak');
    if (o.minorShare < 0.02) why.push(`the darker group holds only ${fmt(o.minorShare * 100, 1)}% of pixels`);
    if (o.t < lo || o.t > hi) why.push(`its best split, ${fmt(o.t)} dB, lies outside ${lo} to ${hi} dB`);
  }
  $('thr-note').textContent = neg(t.source === 'otsu' ? `Set automatically at ${fmt(t.value)} dB: the histogram has two clear peaks.`
    : /^default/.test(t.source) ? `Standard ${fmt(t.value)} dB used, because ${why.join(', and ')}.`
    : `Set by you at ${fmt(t.value)} dB.`);
}

// histogram with a draggable threshold
const H = $('hist'), hctx = H.getContext('2d'), HIST_H = 160;
H.setAttribute('role', 'slider'); H.setAttribute('aria-label', 'Water threshold, radar after the flood, in dB'); H.setAttribute('aria-valuemin', '-26'); H.setAttribute('aria-valuemax', '-12');
function drawHist(r) {
  const W = H.clientWidth || H.parentElement.clientWidth || 340, Hh = HIST_H, dpr = window.devicePixelRatio || 1;
  if (H.width !== Math.round(W * dpr) || H.height !== Math.round(Hh * dpr)) { H.width = Math.round(W * dpr); H.height = Math.round(Hh * dpr); H.style.height = `${Hh}px`; }
  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  H.setAttribute('aria-valuenow', String(r.threshold.value)); H.setAttribute('aria-valuetext', neg(`${fmt(r.threshold.value)} dB; ${fmt(r.summary.areaKm2.flood, 2)} km² of new water`));
  const pad = { l: 6, r: 6, t: 20, b: 22 }, h = r.hist, max = Math.max(...h, 1);
  hctx.clearRect(0, 0, W, Hh);
  const X = db => pad.l + (db + 30) / 30 * (W - pad.l - pad.r), Y = v => Hh - pad.b - Math.sqrt(v / max) * (Hh - pad.t - pad.b), t = r.threshold.value;
  for (let i = 0; i < h.length; i++) { const db = -30 + i / 10; hctx.fillStyle = db < t ? '#1554c0' : '#cfd3da'; hctx.fillRect(X(db), Y(h[i]), Math.max(1, X(db + 0.1) - X(db)), Hh - pad.b - Y(h[i])); }
  hctx.strokeStyle = '#e2e5ea'; hctx.lineWidth = 1; hctx.beginPath(); hctx.moveTo(pad.l, Hh - pad.b + 0.5); hctx.lineTo(W - pad.r, Hh - pad.b + 0.5); hctx.stroke();
  hctx.strokeStyle = '#15171c'; hctx.lineWidth = 2; hctx.beginPath(); hctx.moveTo(X(t), pad.t - 4); hctx.lineTo(X(t), Hh - pad.b); hctx.stroke();
  hctx.fillStyle = '#5f6675'; hctx.font = '11.5px Satoshi, system-ui, sans-serif'; hctx.textAlign = 'center'; hctx.textBaseline = 'alphabetic';
  for (let d = -30; d <= 0; d += 5) hctx.fillText(`${neg(String(d))}${d === 0 ? ' dB' : ''}`, Math.min(Math.max(X(d), 12), W - 18), Hh - 6);
  hctx.fillStyle = '#15171c'; hctx.font = '600 12px Satoshi, system-ui, sans-serif';
  const lab = neg(`Water below ${fmt(t)} dB`); hctx.textAlign = X(t) > W - 130 ? 'right' : 'left'; hctx.fillText(lab, X(t) + (hctx.textAlign === 'left' ? 6 : -6), pad.t - 8);
  H.dataset.pad = JSON.stringify(pad);
}
let rz = null;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.result) drawHist(S.result); }, 150); });
let dragH = false;
const hDb = ev => { const b = H.getBoundingClientRect(), pad = JSON.parse(H.dataset.pad), x = ev.clientX - b.left; return -30 + (x - pad.l) / (b.width - pad.l - pad.r) * 30; };
H.addEventListener('pointerdown', ev => { if (!S.result) return; dragH = true; H.setPointerCapture(ev.pointerId); setThreshold(hDb(ev)); });
H.addEventListener('pointermove', ev => { if (dragH) setThreshold(hDb(ev)); });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(k => H.addEventListener(k, () => { dragH = false; }));
function setThreshold(t) {
  t = Math.max(-26, Math.min(-12, Math.round(t * 10) / 10));
  $('p-thr').value = t; $('o-thr').textContent = neg(`${fmt(t)} dB`); $('p-auto').checked = false;
  S.result.threshold.value = t; drawHist(S.result); scheduleReclassify({ threshold: t });
}
H.addEventListener('keydown', ev => {
  if (!S.result) return;
  const t = S.result.threshold.value, next = { ArrowLeft: t - 0.1, ArrowDown: t - 0.1, ArrowRight: t + 0.1, ArrowUp: t + 0.1, PageDown: t - 1, PageUp: t + 1, Home: -26, End: -12 }[ev.key];
  if (next === undefined) return; ev.preventDefault(); setThreshold(next);
});

function clearResult() {
  S.result = null;
  ['cls', 'radar'].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });
  $('legend').hidden = true; $('inspect').hidden = true; syncStepper();
  if (location.search) history.replaceState(null, '', location.pathname);
}
$('new-run').addEventListener('click', () => show('place'));

// ---------------------------------------------------------------- export
// a link that reproduces the analysis: area, label, dates, the two images and the rules; the data are read again when it opens
function shareUrl() {
  const r = S.result; if (!r) return location.href;
  const u = new URL(location.href.split('#')[0]); u.search = '';
  const q = { bbox: S.aoi.bbox.map(v => v.toFixed(5)).join(','), label: S.aoi.label || '', from: (S.runDates || {}).d0 || $('d0').value, to: (S.runDates || {}).d1 || $('d1').value, pre: r.meta.pre.id, post: r.meta.post.id,
    auto: $('p-auto').checked ? 1 : 0, thr: r.params.threshold, chg: r.params.changeDb, slope: r.params.slopeMax, occ: r.params.permanentOccurrence };
  Object.entries(q).forEach(([k, v]) => u.searchParams.set(k, v)); history.replaceState(null, '', u); return u.href;
}
const NAMES = { geojson: 'flood-extent.geojson', geotiff: 'flood-classes.tif', csv: 'flood-statistics.csv', json: 'processing-metadata.json' };
$('export-open').addEventListener('click', () => {
  const flood = S.result ? S.result.summary.areaKm2.flood : 0;
  document.querySelector('[data-export="geojson"]').disabled = !(flood > 0);
  $('x-note').textContent = flood > 0 ? '' : 'This result has no flood water, so there is no flood extent to download.';
  $('export').showModal();
});
document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', async () => {
  if (!S.result || b.disabled) return;
  const kind = b.dataset.export, stem = `floodscope_${S.result.meta.post.datetime.slice(0, 10)}`, note = $('x-note');
  try {
    b.disabled = true;
    if (kind === 'link') { const u = shareUrl(); try { await navigator.clipboard.writeText(u); note.textContent = 'Link copied. Opening it lists the same images and runs the analysis again.'; } catch { prompt('Copy this link:', u); } return; }
    if (kind === 'pdf') { $('export').close(); return await printReport(); }
    if (kind === 'png') { save(await mapPng(), `${stem}_map.png`); note.textContent = 'Map image saved.'; return; }
    note.textContent = 'Preparing the file…';
    const { blob } = await ask('export', { kind }); save(blob, `${stem}_${NAMES[kind]}`);
    note.textContent = `${b.querySelector('b').textContent} saved.`;
  } catch (e) { note.textContent = `Download failed: ${e.message}`; }
  finally { b.disabled = false; }
}));
function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
async function mapPng() {
  // the exported image carries what is needed to read it: legend, scale, dates, area, method line, sources and limits
  await new Promise(r => { map.once('render', r); map.triggerRepaint(); });
  const src = map.getCanvas(), c = document.createElement('canvas'), dpr = src.width / src.clientWidth || 1;
  const r = S.result, m = r.meta, a = r.summary.areaKm2, F = (px, w = 400) => `${w} ${px * dpr}px Satoshi, sans-serif`;
  const lines = [[F(13, 500), '#15171c', 17, `FloodScope · ${m.label || 'Area'} · new water between ${m.pre.datetime.slice(0, 10)} and ${m.post.datetime.slice(0, 10)}: ${fmt(a.flood, 2)} km²`],
    [F(10.5), '#4a505c', 14, neg(`Sentinel-1 ${m.post.orbitState} orbit ${m.post.relativeOrbit}; VV after below ${fmt(r.params.threshold)} dB and at least ${fmt(-r.params.changeDb)} dB darker; slope ≤ ${r.params.slopeMax}°; permanent water (JRC ≥ ${r.params.permanentOccurrence}%) excluded. FloodScope ${m.version}.`)],
    [F(10.5), '#4a505c', 14, 'Limits: water under canopy, between buildings or gone before the second image is missed; not confirmed on the ground.'],
    [F(10.5), '#4a505c', 14, `Data: Sentinel-1 RTC (Planetary Computer, modified Copernicus Sentinel data), JRC GSW, Copernicus DEM, ESA WorldCover. Basemap © OpenStreetMap contributors, OpenFreeMap${visible.s2 ? '; Sentinel-2 cloudless 2024 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024)' : ''}.`]];
  const meas = c.getContext('2d'), wrapped = [];
  for (const [font, col, lh, text] of lines) { meas.font = font; let cur = ''; for (const w of text.split(' ')) { const t = cur ? cur + ' ' + w : w; if (meas.measureText(t).width > src.width - 20 * dpr && cur) { wrapped.push([font, col, lh, cur]); cur = w; } else cur = t; } wrapped.push([font, col, lh, cur]); }
  const foot = (14 + wrapped.reduce((n, l) => n + l[2], 0)) * dpr;
  c.width = src.width; c.height = src.height + foot;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(src, 0, 0);
  const rows = [[COLORS[2], 'Flood, high confidence', visible.flood], [COLORS[3], 'Flood, medium confidence', visible.flood], [COLORS[4], 'Permanent water', visible.perm],
    [COLORS[6], 'Water before the event', visible.before], [COLORS[5], 'Excluded: slope', visible.steep], [[128, 128, 128, 255], `Radar, before | after (${swipeAt}% split)`, visible.radar]].filter(x => x[2]);
  const lw = 190 * dpr, lh = (14 + rows.length * 17) * dpr, lx = 10 * dpr, ly = src.height - lh - 10 * dpr;
  ctx.fillStyle = 'rgba(255,255,255,.94)'; ctx.fillRect(lx, ly, lw, lh); ctx.strokeStyle = '#d5d9de'; ctx.lineWidth = dpr; ctx.strokeRect(lx, ly, lw, lh);
  rows.forEach(([col, t], i) => { const y = ly + (10 + i * 17) * dpr; ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${col[3] / 255})`; ctx.fillRect(lx + 8 * dpr, y, 10 * dpr, 10 * dpr);
    ctx.fillStyle = '#15171c'; ctx.font = F(11.5); ctx.fillText(t, lx + 24 * dpr, y + 9 * dpr); });
  const lat = map.getCenter().lat, mpp = 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * Math.pow(2, map.getZoom()));
  const nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000], len = nice.reduce((b, v) => v <= 120 * mpp ? v : b, nice[0]);
  const bw = len / mpp * dpr, bx = c.width - bw - 16 * dpr, by = src.height - 18 * dpr;
  ctx.fillStyle = 'rgba(255,255,255,.94)'; ctx.fillRect(bx - 8 * dpr, by - 18 * dpr, bw + 16 * dpr, 26 * dpr);
  ctx.strokeStyle = '#15171c'; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(bx, by - 4 * dpr); ctx.lineTo(bx, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by - 4 * dpr); ctx.stroke();
  ctx.fillStyle = '#15171c'; ctx.font = F(11); ctx.textAlign = 'center'; ctx.fillText(len >= 1000 ? `${len / 1000} km` : `${len} m`, bx + bw / 2, by - 7 * dpr); ctx.textAlign = 'left';
  let y = src.height + 6 * dpr;
  for (const [font, col, lh, text] of wrapped) { y += lh * dpr; ctx.font = font; ctx.fillStyle = col; ctx.fillText(text, 10 * dpr, y); }
  return new Promise(res => c.toBlob(res, 'image/png'));
}
async function printReport() {
  const r = S.result, s = r.summary, a = s.areaKm2, m = r.meta, img = URL.createObjectURL(await mapPng());
  const lc = Object.entries(s.landcoverKm2).map(([k, v]) => `<tr><td>${esc(WORLDCOVER[k] || k)}</td><td>${fmt(v, 2)} km²</td></tr>`).join('');
  const zn = (s.zones || []).slice(0, 30).map(z => `<tr><td>${esc(z.name)}</td><td>${fmt(z.floodKm2, 2)} km²</td><td>${fmtInt(z.population)}</td></tr>`).join('');
  $('report').innerHTML = `<h1>${esc($('r-verdict').textContent)}</h1><p>${esc(m.label || 'Area')} · ${fmt(m.aoiAreaKm2, 0)} km² · ${day(m.pre.datetime)} to ${day(m.post.datetime)} · FloodScope report generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
    <img src="${img}" alt="Map of the flood extent">
    <h2>Result</h2><table>
    <tr><td>New water (flood)</td><td>${fmt(a.flood, 2)} km² (${fmt(a.floodHigh, 2)} high, ${fmt(a.floodMedium, 2)} medium confidence)</td></tr>
    <tr><td>Analysed area with valid radar</td><td>${fmt(a.valid, 1)} km²</td></tr>
    <tr><td>Permanent water (excluded)</td><td>${fmt(a.permanent, 2)} km²</td></tr><tr><td>Water before the event</td><td>${fmt(a.waterBefore, 2)} km²</td></tr>
    <tr><td>Excluded for slope</td><td>${fmt(a.steep, 2)} km²</td></tr>
    <tr><td>Modelled residents in the flood</td><td>${noPop(s) ? esc(m.populationNote || 'No GHS-POP population data for this area') : `${fmtInt(s.population.inFlood)} (GHS-POP 2025; not people affected)`}</td></tr></table>
    <h2>Flooded land cover</h2><table>${lc || '<tr><td>none</td></tr>'}</table>
    ${zn ? `<h2>By administrative area</h2><table><tr><th>Area</th><th>Flooded</th><th>Modelled residents</th></tr>${zn}</table>` : ''}
    <h2>Processing</h2><table>
    <tr><td>Before</td><td>${esc((m.pre.slices || [m.pre.id]).join(', '))}</td></tr><tr><td>After</td><td>${esc((m.post.slices || [m.post.id]).join(', '))}</td></tr>
    <tr><td>Grid</td><td>${m.resolutionM} m, ${esc(m.crs)}</td></tr>
    <tr><td>Rule</td><td>VV after &lt; ${fmt(r.params.threshold)} dB (${esc(r.threshold.source)}) and VV change ≤ ${fmt(r.params.changeDb)} dB; slope ≤ ${r.params.slopeMax}°; permanent water at ≥ ${r.params.permanentOccurrence}% occurrence excluded; ${r.params.speckleWindow} × ${r.params.speckleWindow} speckle mean</td></tr>
    <tr><td>Software</td><td>FloodScope ${esc(m.version)}, run ${esc(m.runAt)}</td></tr></table>
    <p>${Object.values(m.sources).filter(Boolean).map(esc).join(' · ')}</p>
    <p>Basemap © OpenStreetMap contributors, OpenFreeMap${visible.s2 ? '; Sentinel-2 cloudless 2024 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024)' : ''}.</p>
    <p>Limits: radar misses water under canopy and between buildings, and smooth dry surfaces can look like water. No ground truth was used.</p>`;
  await new Promise(res => { const im = $('report').querySelector('img'); im.complete ? res() : (im.onload = res); });
  window.print();
}

// ---------------------------------------------------------------- examples, dialogs, landing preview
$('examples').innerHTML = EXAMPLES.map((e, i) => `<button class="ex" type="button" data-ex="${i}" title="${esc(e.label)}">${esc(e.short)}<span>${e.year}</span></button>`).join('');
document.querySelectorAll('[data-ex]').forEach(b => b.addEventListener('click', () => runExample(EXAMPLES[+b.dataset.ex])));
async function runExample(e) {
  closeWelcome();
  await setAoi(e.bbox, e.label); S.example = true; fitBox(e.bbox);
  $('d0').value = e.d0; $('d1').value = e.d1;
  await listImages(); show('images');
  const pre = S.acq.find(a => a.datetime.startsWith(e.pre)), post = S.acq.find(a => a.datetime.startsWith(e.post));
  if (!pre || !post) { $('err-msg').textContent = 'The example images could not be found in the archive right now. Try again later, or choose another pair.'; show('error'); return; }
  pick(pre); pick(post); S.example = true;
  if (!S.post) { $('err-msg').textContent = 'The example images are not on the same track in the archive right now. Choose a pair yourself.'; show('error'); return; }
  runNow();
}
$('about-open').addEventListener('click', () => $('about').showModal());
document.querySelectorAll('dialog').forEach(d => {
  const x = d.querySelector('[data-close]'); if (x) x.addEventListener('click', () => d.close());
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawing) setDraw(false); });
document.addEventListener('click', e => { const mm = document.querySelector('.menu'); if (mm.open && !mm.contains(e.target)) mm.open = false; });
// landing preview: figures from a real run (assets/preview.json, written by tools/make_preview.py)
fetch('assets/preview.json').then(r => r.json()).then(p => {
  $('pv-place').textContent = p.label;
  $('pv-verdict').textContent = `${fmt(p.flood, 1)} km² of new water`;
  $('pv-stats').innerHTML = `<div><b>${fmt(p.floodHigh, 1)} km²</b>high confidence</div><div><b>${fmtInt(p.residents)}</b>residents (model)</div><div><b>${short(p.post)}</b>after image</div>`;
  $('pv-cap').textContent = `A real result: ${day(p.pre)} to ${day(p.post)}, FloodScope ${p.version}. Map © OpenStreetMap contributors, OpenFreeMap.`;
}).catch(() => { document.querySelector('.preview').hidden = true; });

// ---------------------------------------------------------------- start
show('place');
(async () => {
  const q = new URLSearchParams(location.search); if (!q.get('bbox') || !q.get('pre') || !q.get('post')) { $('w-q').focus(); return; }
  // a shared link: skip the welcome, restore the area, dates, images and rules, run again
  closeWelcome();
  const b = q.get('bbox').split(',').map(Number);
  if (b.length !== 4 || b.some(v => !ok(v))) { $('err-msg').textContent = 'The shared link has an area this page cannot read, so nothing was run. Choose a place instead.'; show('error'); return; }
  const good = await setAoi(b, q.get('label') || 'Shared area'); fitBox(b); if (!good) { show('place'); return; }
  if (q.get('from')) $('d0').value = q.get('from'); if (q.get('to')) $('d1').value = q.get('to');
  for (const [id, k] of [['p-thr', 'thr'], ['p-chg', 'chg'], ['p-slp', 'slope'], ['p-occ', 'occ']]) if (q.get(k) != null) { $(id).value = q.get(k); $(id).dispatchEvent(new Event('input')); }
  $('p-auto').checked = q.get('auto') !== '0';
  await listImages(); show('images');
  const pre = S.acq.find(a => a.id === q.get('pre')), post = S.acq.find(a => a.id === q.get('post'));
  if (!pre || !post) { $('pick-info').textContent = 'The images in this link are no longer listed in the archive. Choose a pair.'; return; }
  pick(pre); pick(post);
  if (!S.post) { $('pick-info').textContent = 'The images in this link no longer form a pair in the archive. Choose a pair.'; return; }
  runNow();
})();
