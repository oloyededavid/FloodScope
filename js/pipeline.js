/* FloodScope analysis pipeline: from an area and two Sentinel-1 acquisitions to a classified grid and exposure summary.
   Runs in a Web Worker in the browser and directly in Node for tests. Progress messages report steps actually done. */
import { stacSearch, signedHref, readToGrid, readMosaic, defineEpsg, project } from './io.js';
import { DEFAULTS, focalMean, toDb, otsu, slopeDeg, classify, summarise, cellAreaKm2, makeGrid, resolutionFor, rasterisePolygons, CLS } from './engine.js';

export const VERSION = '1.0.0';

/** Sentinel-1 RTC acquisitions over a lon/lat bbox, grouped so only comparable pairs (same relative orbit and pass) are offered. */
export async function listAcquisitions(bbox, start, end, signal) {
  const items = await stacSearch({ collections: ['sentinel-1-rtc'], bbox, datetime: `${start}/${end}`,
    sortby: [{ field: 'datetime', direction: 'asc' }] }, { signal, maxItems: 400 });
  return items.map(it => ({
    id: it.id, datetime: it.properties.datetime, platform: it.properties.platform,
    orbitState: it.properties['sat:orbit_state'], relativeOrbit: it.properties['sat:relative_orbit'],
    epsg: it.properties['proj:epsg'], bbox: it.bbox, geometry: it.geometry,
    polarisations: it.properties['sar:polarizations'] || Object.keys(it.assets).filter(k => k === 'vv' || k === 'vh').map(k => k.toUpperCase()),
    vv: it.assets.vv && it.assets.vv.href, vh: it.assets.vh && it.assets.vh.href,
  }));
}

/** Area of a lon/lat polygon ring in km^2 (spherical excess on a sphere of mean Earth radius). */
export function ringAreaKm2(ring) {
  const R = 6371.0088, rad = Math.PI / 180; let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    s += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
  }
  return Math.abs(s * R * R / 2);
}

async function itemsFor(collection, bbox, extra, signal) {
  return stacSearch({ collections: [collection], bbox, ...extra }, { signal, maxItems: 60 });
}

/** Population tiles hosted with the app (GHS-POP 2025); index.json lists tiles with population. */
async function popUrls(base, bbox) {
  const r = await fetch(`${base}/data/population/index.json`); if (!r.ok) throw new Error('Population index missing');
  const idx = await r.json();
  return idx.tiles.filter(t => t.west < bbox[2] && t.east > bbox[0] && t.south < bbox[3] && t.north > bbox[1])
    .map(t => `${base}/data/population/${t.file}`);
}

/** Run the analysis. aoi: {type:'Polygon', coordinates:[ring]} in lon/lat. pre/post: acquisitions from listAcquisitions.
    opts: {params, base (URL of the app root for the population tiles), zones (optional GeoJSON FeatureCollection), onProgress, signal}. */
export async function runAnalysis({ aoi, pre, post, params = {}, base, zones = null, onProgress = () => {}, signal }) {
  const p = { ...DEFAULTS, ...params };
  const t0 = Date.now(), log = [];
  const step = (msg) => { log.push({ t: (Date.now() - t0) / 1000, msg }); onProgress(msg); };
  if (!pre || !post) throw new Error('Choose a before and an after acquisition');
  if (pre.relativeOrbit !== post.relativeOrbit || pre.orbitState !== post.orbitState)
    throw new Error('Before and after must come from the same relative orbit and pass so the radar geometry matches');
  if (Date.parse(pre.datetime) >= Date.parse(post.datetime)) throw new Error('The before acquisition must be earlier than the after acquisition');

  const ring = aoi.coordinates[0], area = ringAreaKm2(ring), res = resolutionFor(area);
  if (!res) throw new Error(`The area is ${area.toFixed(0)} km²; the limit for an in-browser run is 3,600 km²`);
  const lons = ring.map(c => c[0]), lats = ring.map(c => c[1]);
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];

  // grid in the after-scene's UTM CRS
  const crs = post.epsg, crsName = defineEpsg(crs);
  const pr = project('EPSG:4326', crsName, ring);
  const grid = makeGrid([Math.min(...pr.map(q => q[0])), Math.min(...pr.map(q => q[1])), Math.max(...pr.map(q => q[0])), Math.max(...pr.map(q => q[1]))], res, crs);
  const toPx = ([x, y]) => [(x - grid.x0) / grid.res, (grid.y1 - y) / grid.res];
  const inAoi = rasterisePolygons([[pr.map(toPx)]], grid.w, grid.h);
  step(`Analysis grid: ${grid.w} × ${grid.h} pixels of ${res} m in EPSG:${crs}`);

  // radar
  const S = 'sentinel-1-rtc';
  const read = async (href, label) => { step(`Reading ${label}`); return readToGrid(await signedHref(href, S, signal), grid, { method: 'average', signal }); };
  const lin = {
    preVV: await read(pre.vv, `VV before (${pre.datetime.slice(0, 10)})`),
    postVV: await read(post.vv, `VV after (${post.datetime.slice(0, 10)})`),
    preVH: pre.vh ? await read(pre.vh, 'VH before') : null,
    postVH: post.vh ? await read(post.vh, 'VH after') : null,
  };
  step(`Speckle filter: ${p.speckleWindow} × ${p.speckleWindow} focal mean of linear backscatter (after averaging to ${res} m), then dB`);
  const db = {};
  for (const k of Object.keys(lin)) db[k] = lin[k] ? toDb(focalMean(lin[k], grid.w, grid.h, p.speckleWindow)) : null;
  for (const k of Object.keys(db)) if (db[k]) for (let i = 0; i < grid.n; i++) if (inAoi[i] < 0) db[k][i] = NaN;

  // permanent water
  step('Reading JRC Global Surface Water occurrence');
  const gsw = await itemsFor('jrc-gsw', bbox, {}, signal);
  const occ = await readMosaic(await Promise.all(gsw.map(it => signedHref(it.assets.occurrence.href, 'jrc-gsw', signal))), grid, { method: 'nearest', signal });

  // terrain
  step('Reading Copernicus DEM GLO-30 and computing slope');
  const dem = await itemsFor('cop-dem-glo-30', bbox, {}, signal);
  const z = await readMosaic(await Promise.all(dem.map(it => signedHref(it.assets.data.href, 'cop-dem-glo-30', signal))), grid, { method: 'bilinear', signal });
  const slope = slopeDeg(z, grid.w, grid.h, res);

  // land cover
  step('Reading ESA WorldCover 2021');
  const wc = await itemsFor('esa-worldcover', bbox, { datetime: '2021-01-01/2021-12-31' }, signal);
  const lcF = await readMosaic(await Promise.all(wc.map(it => signedHref(it.assets.map.href, 'esa-worldcover', signal))), grid, { method: 'nearest', signal });
  const landcover = new Uint8Array(grid.n); for (let i = 0; i < grid.n; i++) landcover[i] = lcF[i] === lcF[i] ? lcF[i] : 0;

  // population density (persons per km2) from GHS-POP counts per 30" cell
  step('Reading GHS-POP 2025 population');
  const counts = await readMosaic(await popUrls(base, bbox), grid, { method: 'nearest', signal });
  const popDensity = new Float32Array(grid.n).fill(NaN);
  const centres = [];
  for (let y = 0; y < grid.h; y += 32) centres.push([grid.x0 + grid.w * res / 2, grid.y1 - (y + 0.5) * res]);
  const latOfRow = project(crsName, 'EPSG:4326', centres).map(q => q[1]);
  for (let y = 0; y < grid.h; y++) {
    const a = cellAreaKm2(latOfRow[Math.min(latOfRow.length - 1, Math.floor(y / 32))]);
    for (let x = 0; x < grid.w; x++) { const i = y * grid.w + x, c = counts[i]; if (c === c && inAoi[i] >= 0) popDensity[i] = c / a; }
  }

  // threshold
  const sample = new Float32Array(grid.n); let m = 0;
  for (let i = 0; i < grid.n; i++) {
    const v = db.postVV[i]; if (!(v === v)) continue;
    if (occ[i] === occ[i] && occ[i] >= p.permanentOccurrence) continue;
    if (slope[i] === slope[i] && slope[i] > p.slopeMax) continue;
    sample[m++] = v;
  }
  const ot = otsu(sample.subarray(0, m), -30, 0, 0.1);
  let threshold = p.thresholdVV, thresholdSource = 'fixed';
  if (p.autoThreshold && ot.t === ot.t && ot.t >= p.otsuMin && ot.t <= p.otsuMax && ot.bimodality >= 0.5) { threshold = ot.t; thresholdSource = 'otsu'; }
  else if (p.autoThreshold) thresholdSource = 'fixed (automatic threshold rejected: ' + (ot.t === ot.t ? `Otsu ${ot.t.toFixed(1)} dB, bimodality ${ot.bimodality.toFixed(2)}` : 'too few pixels') + ')';
  step(`Water threshold on VV after: ${threshold.toFixed(1)} dB (${thresholdSource})`);

  // zones
  let zoneIdx = null, zoneNames = null;
  if (zones && zones.features && zones.features.length) {
    step('Rasterising administrative areas');
    const rings = [], names = [];
    for (const f of zones.features) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      const rr = []; for (const poly of polys) for (const r of poly) rr.push(project('EPSG:4326', crsName, r).map(toPx));
      if (rr.length) { rings.push(rr); names.push(f.properties.shapeName || f.properties.name || `Area ${names.length + 1}`); }
    }
    zoneIdx = rasterisePolygons(rings, grid.w, grid.h); zoneNames = names;
  }

  const layers = { ...db, occurrence: occ, slope, landcover, popDensity, inAoi, zoneIdx };
  const result = reclassify(layers, grid, { ...p, threshold }, zoneNames);
  step(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return {
    grid, layers, ...result, zoneNames,
    threshold: { value: threshold, source: thresholdSource, otsu: ot },
    params: { ...p, threshold },
    meta: {
      app: 'FloodScope', version: VERSION, runAt: new Date().toISOString(), aoi, aoiAreaKm2: area, resolutionM: res,
      crs: `EPSG:${crs}`, pre: strip(pre), post: strip(post), log,
      sources: {
        radar: 'Sentinel-1 RTC (gamma0, VV and VH), Microsoft Planetary Computer, CC BY 4.0; contains modified Copernicus Sentinel data',
        permanentWater: 'JRC Global Surface Water v1.3 occurrence 1984–2020, EC JRC/Google (Pekel et al., 2016)',
        terrain: 'Copernicus DEM GLO-30, ESA, © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018',
        landcover: 'ESA WorldCover 10 m 2021 v200, CC BY 4.0 (Zanaga et al., 2022)',
        population: 'GHS-POP R2023A epoch 2025, 30 arc-second, EC JRC, CC BY 4.0 (Schiavina et al., 2023)',
        zones: zones ? 'geoBoundaries gbOpen (Runfola et al., 2020)' : null,
      },
    },
  };
}
const strip = a => ({ id: a.id, datetime: a.datetime, platform: a.platform, orbitState: a.orbitState, relativeOrbit: a.relativeOrbit, epsg: a.epsg });

/** Classify and summarise again with new parameters (threshold, change, slope, permanence) without reading data. */
export function reclassify(layers, grid, p, zoneNames) {
  const cls = classify(layers, grid.n, p);
  const summary = summarise(cls, { pixelAreaM2: grid.res * grid.res, popDensity: layers.popDensity, landcover: layers.landcover,
    zones: layers.zoneIdx, nZones: zoneNames ? zoneNames.length : 0 });
  if (summary.zones) summary.zones = summary.zones.map(z => ({ ...z, name: zoneNames[z.zone] })).filter(z => z.floodKm2 > 0).sort((a, b) => b.floodKm2 - a.floodKm2);
  return { cls, summary };
}

export { CLS };
