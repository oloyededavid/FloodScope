/* FloodScope analysis pipeline: from an area and two Sentinel-1 acquisitions to a classified grid and exposure summary.
   Runs in a Web Worker in the browser and directly in Node for tests. Progress messages report steps actually done. */
import { stacSearch, signedHref, readToGrid, readMosaic, defineEpsg, project } from './io.js';
import { DEFAULTS, focalMean, toDb, otsu, slopeDeg, classify, summarise, cellAreaKm2, utmScale, makeGrid, resolutionFor, rasterisePolygons, CLS } from './engine.js';

import { VERSION } from './version.js';
export { VERSION };

/** Sentinel-1 RTC acquisitions over a lon/lat bbox. Slices of one datatake (same day, platform, relative orbit and pass)
    are merged into one acquisition, so an area that straddles two slices is read from both. Scenes without VV (HH/HV over
    polar regions) are left out. Returns {list, truncated}. */
export async function listAcquisitions(bbox, start, end, signal) {
  const MAX = 400;
  const items = await stacSearch({ collections: ['sentinel-1-rtc'], bbox, datetime: `${start}/${end}`,
    sortby: [{ field: 'datetime', direction: 'asc' }] }, { signal, maxItems: MAX });
  const groups = new Map();
  for (const it of items) {
    if (!it.assets.vv) continue;
    const p = it.properties, key = `${p.datetime.slice(0, 10)}|${p.platform}|${p['sat:relative_orbit']}|${p['sat:orbit_state']}`;
    let g = groups.get(key);
    if (!g) {
      g = { id: it.id, ids: [], datetime: p.datetime, platform: p.platform, orbitState: p['sat:orbit_state'], relativeOrbit: p['sat:relative_orbit'],
            epsg: p['proj:epsg'], vv: [], vh: [] };
      groups.set(key, g);
    }
    g.ids.push(it.id); g.vv.push(it.assets.vv.href); if (it.assets.vh) g.vh.push(it.assets.vh.href);
  }
  const list = [...groups.values()].map(g => ({ ...g, vh: g.vh.length === g.vv.length ? g.vh : [] }));
  return { list, truncated: items.length >= MAX };
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
export async function runAnalysis({ aoi, pre, post, params = {}, base, zones = null, label = null, onProgress = () => {}, signal }) {
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
  // the permanent-water layer (JRC GSW) covers 56 S to 78 N; outside it permanent water could not be excluded
  if (bbox[1] < -56 || bbox[3] > 78) throw new Error('FloodScope works between 56° S and 78° N, where the permanent-water layer is available');

  // grid in the after-scene's UTM CRS
  const crs = post.epsg, crsName = defineEpsg(crs);
  const pr = project('EPSG:4326', crsName, ring);
  const grid = makeGrid([Math.min(...pr.map(q => q[0])), Math.min(...pr.map(q => q[1])), Math.max(...pr.map(q => q[0])), Math.max(...pr.map(q => q[1]))], res, crs);
  const toPx = ([x, y]) => [(x - grid.x0) / grid.res, (grid.y1 - y) / grid.res];
  const inAoi = rasterisePolygons([[pr.map(toPx)]], grid.w, grid.h);
  step(`Analysis grid: ${grid.w} × ${grid.h} pixels of ${res} m in EPSG:${crs}`);

  // radar
  const S = 'sentinel-1-rtc';
  const read = async (hrefs, label) => {
    step(`Reading ${label}${hrefs.length > 1 ? ` (${hrefs.length} slices)` : ''}`);
    return readMosaic(await Promise.all(hrefs.map(h => signedHref(h, S, signal))), grid, { method: 'average', signal });
  };
  const hasVH = pre.vh.length && post.vh.length;
  const lin = {
    preVV: await read(pre.vv, `VV before (${pre.datetime.slice(0, 10)})`),
    postVV: await read(post.vv, `VV after (${post.datetime.slice(0, 10)})`),
    preVH: hasVH ? await read(pre.vh, 'VH before') : null,
    postVH: hasVH ? await read(post.vh, 'VH after') : null,
  };
  step(`Speckle filter: ${p.speckleWindow} × ${p.speckleWindow} focal mean of linear backscatter (after averaging to ${res} m), then dB`);
  const db = {};
  for (const k of Object.keys(lin)) db[k] = lin[k] ? toDb(focalMean(lin[k], grid.w, grid.h, p.speckleWindow)) : null;
  for (const k of Object.keys(db)) if (db[k]) for (let i = 0; i < grid.n; i++) if (inAoi[i] < 0) db[k][i] = NaN;
  // scenes whose edge or a data gap lies on the area carry no values there: stop early with a clear message
  let nAoi = 0, nBoth = 0;
  for (let i = 0; i < grid.n; i++) if (inAoi[i] >= 0) { nAoi++; if (db.preVV[i] === db.preVV[i] && db.postVV[i] === db.postVV[i]) nBoth++; }
  if (!nBoth) throw new Error('The two images have no valid radar values over this area (the area lies outside the scene or in a data gap). Choose other images or move the box.');
  if (nBoth < 0.5 * nAoi) step(`Only ${(100 * nBoth / nAoi).toFixed(0)}% of the area is covered by both images; the rest is treated as no data`);

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
  // population is context, not part of the flood map: if its tiles cannot be read the run continues without residents
  let counts, populationNote = null;
  try {
    const urls = await popUrls(base, bbox);
    if (!urls.length) populationNote = 'No GHS-POP tile covers this area, so modelled residents are not available.';
    counts = await readMosaic(urls, grid, { method: 'nearest', signal });
  } catch (e) {
    if (e.name === 'AbortError' || (signal && signal.aborted)) throw e;
    populationNote = `Population data could not be read (${e.message}), so modelled residents are not available.`;
    counts = new Float32Array(grid.n).fill(NaN);
  }
  if (populationNote) step(populationNote);
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
    if (occ[i] === occ[i] && occ[i] >= p.permanentOccurrence && occ[i] <= 100) continue;
    if (slope[i] === slope[i] && slope[i] > p.slopeMax) continue;
    sample[m++] = v;
  }
  const ot = otsu(sample.subarray(0, m), -30, 0, 0.1);
  // the automatic threshold is used only when the histogram has two separate peaks, the smaller class is at least 2% of
  // pixels, and the split lies in the plausible range for water in VV gamma0
  const why = [];
  if (!(ot.t === ot.t)) why.push('too few pixels');
  else {
    if (ot.valleyRatio > 0.5) why.push(`no clear second peak (valley ratio ${ot.valleyRatio.toFixed(2)})`);
    if (ot.minorShare < 0.02) why.push(`smaller class only ${(ot.minorShare * 100).toFixed(1)}%`);
    if (ot.t < p.otsuMin || ot.t > p.otsuMax) why.push(`Otsu ${ot.t.toFixed(1)} dB outside ${p.otsuMin} to ${p.otsuMax} dB`);
  }
  let threshold = p.thresholdVV, thresholdSource = 'fixed';
  if (p.autoThreshold && !why.length) { threshold = ot.t; thresholdSource = 'otsu'; }
  else if (p.autoThreshold) thresholdSource = `default (automatic threshold not used: ${why.join('; ')})`;
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

  // ground area of each pixel: UTM map area divided by the square of the point scale factor at the column's easting
  const colAreaKm2 = new Float64Array(grid.w);
  for (let x = 0; x < grid.w; x++) { const k = utmScale(grid.x0 + (x + 0.5) * res); colAreaKm2[x] = res * res / (k * k) / 1e6; }
  const layers = { ...db, occurrence: occ, slope, landcover, popDensity, inAoi, zoneIdx, colAreaKm2 };
  const result = reclassify(layers, grid, { ...p, threshold }, zoneNames);
  step(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return {
    grid, layers, ...result, zoneNames,
    threshold: { value: threshold, source: thresholdSource, otsu: ot },
    params: { ...p, threshold },
    meta: {
      app: 'FloodScope', version: VERSION, runAt: new Date().toISOString(), label: label || null, aoi, aoiAreaKm2: area, resolutionM: res,
      populationNote,
      areas: 'ground areas: UTM pixel area corrected by the point scale factor at each column',
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
const strip = a => ({ id: a.id, slices: a.ids, datetime: a.datetime, platform: a.platform, orbitState: a.orbitState, relativeOrbit: a.relativeOrbit, epsg: a.epsg, polarisations: a.vh.length ? 'VV, VH' : 'VV' });

/** Classify and summarise again with new parameters (threshold, change, slope, permanence) without reading data. */
export function reclassify(layers, grid, p, zoneNames) {
  const cls = classify(layers, grid.n, p);
  const summary = summarise(cls, { pixelAreaM2: grid.res * grid.res, colAreaKm2: layers.colAreaKm2, width: grid.w, popDensity: layers.popDensity,
    landcover: layers.landcover, zones: layers.zoneIdx, nZones: zoneNames ? zoneNames.length : 0, inAoi: layers.inAoi });
  if (summary.zones) summary.zones = summary.zones.map(z => ({ ...z, name: zoneNames[z.zone] })).filter(z => z.floodKm2 > 0).sort((a, b) => b.floodKm2 - a.floodKm2);
  return { cls, summary };
}

export { CLS };
