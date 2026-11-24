/* FloodScope exports, built from the arrays of the actual run. No values are recomputed or rounded for display here. */
import { writeArrayBuffer, proj4 } from '../vendor/geo-libs.mjs';
import { CLS } from './engine.js';
import { defineEpsg } from './io.js';

export const CLASS_NAMES = { 0: 'no data', 1: 'dry', 2: 'flood, high confidence', 3: 'flood, medium confidence', 4: 'permanent water', 5: 'excluded: slope', 6: 'water before the event' };
export const WORLDCOVER = { 10: 'Tree cover', 20: 'Shrubland', 30: 'Grassland', 40: 'Cropland', 50: 'Built-up', 60: 'Bare or sparse vegetation',
  70: 'Snow and ice', 80: 'Permanent water bodies', 90: 'Herbaceous wetland', 95: 'Mangroves', 100: 'Moss and lichen', 0: 'No data' };

/** Classification grid as a GeoTIFF (UInt8, projected CRS of the run). */
export function classGeoTiff(cls, grid) {
  return writeArrayBuffer(cls, {
    width: grid.w, height: grid.h, BitsPerSample: [8], SampleFormat: [1],
    ModelPixelScale: [grid.res, grid.res, 0], ModelTiepoint: [0, 0, 0, grid.x0, grid.y1, 0],
    GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: grid.crs, GDAL_NODATA: '0',
  });
}

/** Split a closed vertex list (without the repeated last point) wherever a vertex occurs twice. */
function splitPinches(ring) {
  const out = [], stack = [], seen = new Map();
  for (const p of ring) {
    const k = p[0] + ',' + p[1];
    if (seen.has(k)) {
      const at = seen.get(k), loop = stack.splice(at);
      for (const q of loop) seen.delete(q[0] + ',' + q[1]);
      if (loop.length >= 3) out.push(loop);
    }
    seen.set(k, stack.length); stack.push(p);
  }
  if (stack.length >= 3) out.push(stack);
  return out;
}

/** Trace the boundary of a binary mask exactly along pixel edges. Returns polygons (outer ring + holes) in pixel-corner
    coordinates. Pixels touching only at a corner are kept as separate polygons (8-connected corners are split), so every
    ring is simple and the result is a valid MultiPolygon. */
export function traceMask(mask, w, h) {
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  // directed boundary edges with the filled pixel on the left: E=0, S=1, W=2, N=3 (y grows downward)
  const edges = new Map(), key = (x, y, d) => (y * (w + 1) + x) * 4 + d;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!on(x, y)) continue;
    if (!on(x, y - 1)) edges.set(key(x + 1, y, 2), 1);     // top edge, walked westward from (x+1,y) to (x,y)
    if (!on(x - 1, y)) edges.set(key(x, y, 1), 1);         // left edge, southward from (x,y) to (x,y+1)
    if (!on(x, y + 1)) edges.set(key(x, y + 1, 0), 1);     // bottom edge, eastward from (x,y+1) to (x+1,y+1)
    if (!on(x + 1, y)) edges.set(key(x + 1, y + 1, 3), 1); // right edge, northward from (x+1,y+1) to (x+1,y)
  }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1], rings = [];
  // at a vertex with two candidate outgoing edges (pixels touching at a corner), turn so the filled pixel stays left:
  // prefer a left turn, then straight, then right
  for (const k0 of edges.keys()) {
    if (!edges.get(k0)) continue;
    let k = k0; const ring = [];
    while (edges.get(k)) {
      edges.set(k, 0);
      const d = k % 4, v = (k - d) / 4, x = v % (w + 1), y = (v - x) / (w + 1);
      ring.push([x, y]);
      const nx = x + DX[d], ny = y + DY[d];
      let next = null;
      for (const nd of [(d + 3) % 4, d, (d + 1) % 4]) { const kk = key(nx, ny, nd); if (edges.get(kk)) { next = kk; break; } }
      if (next === null) break;
      k = next;
    }
    // drop collinear points
    const r = ring.filter((p, i) => { const a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length];
      return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1])); });
    // a ring that passes the same vertex twice (two holes touching at a corner) is split there into simple rings
    for (const sr of splitPinches(r)) { sr.push(sr[0]); rings.push(sr); }
  }
  // signed area in pixel space (y down): outer rings come out negative (counter-clockwise as seen on screen), holes positive
  const signed = r => { let s = 0; for (let i = 0; i + 1 < r.length; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return s / 2; };
  const outers = [], holes = [];
  for (const r of rings) (signed(r) < 0 ? outers : holes).push(r);
  const polys = outers.map(o => [o]);
  // assign each hole to the smallest outer ring that contains its first vertex's pixel
  const inside = (pt, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
  const absA = r => Math.abs(signed(r));
  for (const hle of holes) {
    // the midpoint of a hole edge lies on the border of a filled pixel, strictly inside the ring that encloses the hole
    const p = [(hle[0][0] + hle[1][0]) / 2, (hle[0][1] + hle[1][1]) / 2];
    let best = -1, ba = Infinity;
    for (let i = 0; i < outers.length; i++) { const o = outers[i]; if (absA(o) > absA(hle) && inside(p, o) && absA(o) < ba) { best = i; ba = absA(o); } }
    if (best >= 0) polys[best].push(hle);
  }
  return polys;
}

/** Flood extent as GeoJSON (WGS 84), traced exactly along pixel edges and reprojected vertex by vertex. Exterior rings are
    written counter-clockwise and holes clockwise (RFC 7946). */
export function floodGeoJSON(cls, grid, meta, classes = [CLS.FLOOD_HIGH, CLS.FLOOD_MEDIUM]) {
  const toLL = proj4(defineEpsg(grid.crs), 'EPSG:4326');
  const features = classes.map(c => {
    const mask = new Uint8Array(grid.n); for (let i = 0; i < grid.n; i++) mask[i] = cls[i] === c ? 1 : 0;
    const coordinates = traceMask(mask, grid.w, grid.h).map(poly => poly.map((ring, k) => {
      const ll = ring.map(([px, py]) => {
        const [lon, lat] = toLL.forward([grid.x0 + px * grid.res, grid.y1 - py * grid.res]);
        return [Math.round(lon * 1e8) / 1e8, Math.round(lat * 1e8) / 1e8];
      });
      return ll;
    }));
    return { type: 'Feature', properties: { class: c, name: CLASS_NAMES[c] }, geometry: { type: 'MultiPolygon', coordinates } };
  });
  return { type: 'FeatureCollection', name: 'FloodScope flood extent', floodscope: meta, features };
}

// text cells that start with = + - @ are prefixed with ' so spreadsheet programs do not run them as formulas
const csvCell = v => { let s = String(v ?? ''); if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = rows => rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';

/** Summary statistics as CSV: one block per table, each with a header row. */
export function summaryCsv(summary, meta, params) {
  const a = summary.areaKm2, none = summary.validPixels > 0 && summary.population.pixelsWithoutPopulation >= summary.validPixels;
  const p = none ? { ...summary.population, inFlood: '', inFloodHigh: '', inValidArea: '', inAoi: '' } : summary.population;
  const rows = [['section', 'item', 'value', 'unit'],
    ['run', 'before', meta.pre.datetime, 'UTC'], ['run', 'after', meta.post.datetime, 'UTC'],
    ['run', 'relative orbit', meta.post.relativeOrbit, ''], ['run', 'grid resolution', meta.resolutionM, 'm'], ['run', 'CRS', meta.crs, ''],
    ['run', 'VV water threshold', params.threshold, 'dB'], ['run', 'change threshold', params.changeDb, 'dB'],
    ['run', 'slope limit', params.slopeMax, 'degrees'], ['run', 'permanent water occurrence', params.permanentOccurrence, '%'],
    ['area', 'analysed (valid radar)', a.valid, 'km2'], ['area', 'flood (all)', a.flood, 'km2'], ['area', 'flood, high confidence', a.floodHigh, 'km2'],
    ['area', 'flood, medium confidence', a.floodMedium, 'km2'], ['area', 'permanent water', a.permanent, 'km2'], ['area', 'water before the event', a.waterBefore, 'km2'],
    ['area', 'excluded for slope', a.steep, 'km2'],
    ['population', 'modelled residents in flood', p.inFlood, 'persons (GHS-POP 2025)'], ['population', 'of which high-confidence flood', p.inFloodHigh, 'persons'],
    ['population', 'modelled residents in analysed area', p.inValidArea, 'persons'], ['population', 'modelled residents in the drawn area', p.inAoi, 'persons'],
    ['population', 'analysed pixels without population data', p.pixelsWithoutPopulation, 'pixels'],
    ...(meta.populationNote ? [['population', 'note', meta.populationNote, '']] : []), ['run', 'area basis', 'ground area: UTM pixel area / k^2 per column', '']];
  for (const [k, v] of Object.entries(summary.landcoverKm2)) rows.push(['flooded land cover', WORLDCOVER[k] || k, v, 'km2']);
  for (const z of summary.zones || []) rows.push(['administrative area', z.name, z.floodKm2, 'km2 flooded'], ['administrative area', z.name, z.population, 'persons in flood']);
  return csv(rows);
}

/** Processing metadata: everything needed to rerun the analysis. */
export function metadataJson(meta, params, threshold) {
  return JSON.stringify({ ...meta, parameters: params, threshold }, null, 2);
}
