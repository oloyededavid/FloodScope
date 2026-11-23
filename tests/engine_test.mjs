// Unit tests for js/engine.js with values worked out by hand. Run: node tests/engine_test.mjs
import { focalMean, toDb, otsu, slopeDeg, classify, summarise, cellAreaKm2, makeGrid, utmEpsg, resolutionFor, rasterisePolygons, CLS } from '../js/engine.js';
import { ringAreaKm2 } from '../js/pipeline.js';
let fails = 0;
const ok = (name, cond, info = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); if (!cond) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// focal mean: 3x3 on a 3x3 grid; centre is the mean of all 9; a corner is the mean of its 4 neighbours; NaN is skipped
{ const a = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]); const m = focalMean(a, 3, 3, 3);
  ok('focalMean centre', near(m[4], 5, 1e-6), m[4]); ok('focalMean corner', near(m[0], (1 + 2 + 4 + 5) / 4, 1e-6), m[0]);
  const b = Float32Array.from([1, NaN, 3, 4, 5, 6, 7, 8, 9]); const n = focalMean(b, 3, 3, 3);
  ok('focalMean skips NaN', near(n[4], (45 - 2) / 8, 1e-6), n[4]); ok('focalMean keeps NaN pixel NaN', Number.isNaN(n[1])); }
// dB
{ const d = toDb(Float32Array.from([1, 0.1, 0, -1, NaN])); ok('toDb values', d[0] === 0 && near(d[1], -10, 1e-5) && Number.isNaN(d[2]) && Number.isNaN(d[3]) && Number.isNaN(d[4])); }
// Otsu on two separated groups: threshold falls between them
{ const a = new Float32Array(2000); for (let i = 0; i < 1000; i++) { a[i] = -22 + (i % 10) * 0.1; a[1000 + i] = -8 + (i % 10) * 0.1; }
  const r = otsu(a); ok('otsu threshold in the middle of the gap', near(r.t, -14.5, 0.11), `t=${r.t.toFixed(2)}`); ok('otsu bimodality high', r.bimodality > 0.95, r.bimodality.toFixed(3));
  ok('otsu too few pixels', Number.isNaN(otsu(new Float32Array(10)).t)); }
// slope: a plane rising 1 m per 1 m in x gives 45 degrees; a flat plane gives 0
{ const w = 5, h = 5, z = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) z[y * w + x] = x * 20;
  const s = slopeDeg(z, w, h, 20); ok('slope 45 deg', near(s[12], 45, 1e-4), s[12]);
  ok('slope flat', slopeDeg(new Float32Array(25).fill(7), 5, 5, 20).every(v => v === 0)); }
// classification rule
{ const n = 7, f = a => Float32Array.from(a);
  const L = { preVV: f([-10, -10, -10, -20, -10, -10, NaN]), postVV: f([-20, -20, -10, -20, -20, -20, -20]),
              preVH: f([-15, -15, -15, -25, -15, -15, -15]), postVH: f([-25, -16, -15, -25, -25, -25, -25]),
              occurrence: f([0, 0, 0, 0, 95, 0, 0]), slope: f([0, 0, 0, 0, 0, 10, 0]) };
  const c = classify(L, n, { threshold: -18, changeDb: -3, slopeMax: 5, permanentOccurrence: 80 });
  ok('classify flood high', c[0] === CLS.FLOOD_HIGH); ok('classify flood medium (VH barely changed)', c[1] === CLS.FLOOD_MEDIUM);
  ok('classify dry', c[2] === CLS.DRY); ok('classify water before (no change)', c[3] === CLS.WATER_BEFORE);
  ok('classify permanent first', c[4] === CLS.PERMANENT); ok('classify steep', c[5] === CLS.STEEP); ok('classify no data', c[6] === CLS.NODATA); }
// summary: areas and population
{ const cls = Uint8Array.from([2, 3, 1, 4]), dens = Float32Array.from([1000, 500, 100, NaN]);
  const s = summarise(cls, { pixelAreaM2: 400, popDensity: dens, landcover: Uint8Array.from([40, 50, 40, 80]), zones: Int32Array.from([0, 1, 0, -1]), nZones: 2 });
  ok('summary flood area', near(s.areaKm2.flood, 0.0008, 1e-12)); ok('summary population', near(s.population.inFlood, 1000 * 4e-4 + 500 * 4e-4, 1e-9), s.population.inFlood);
  ok('summary land cover', near(s.landcoverKm2[40], 4e-4, 1e-12) && near(s.landcoverKm2[50], 4e-4, 1e-12));
  ok('summary zones', near(s.zones[0].floodKm2, 4e-4, 1e-12) && near(s.zones[1].population, 0.2, 1e-9));
  ok('summary missing population counted', s.population.pixelsWithoutPopulation === 1); }
// geometry helpers (1 x 1 degree at the equator on a sphere of 6371.0088 km: R^2 * (pi/180) * sin(1 deg) = 12363.7 km2)
{ ok('cell area at equator', near(cellAreaKm2(0), 0.8588, 1e-3), cellAreaKm2(0).toFixed(4));
  ok('cell area shrinks with latitude', near(cellAreaKm2(60) / cellAreaKm2(0), 0.5, 1e-4));
  const g = makeGrid([1001, 2001, 1099, 2099], 20, 32632); ok('grid snapped', g.x0 === 1000 && g.y1 === 2100 && g.w === 5 && g.h === 5);
  ok('utm zone Lokoja', utmEpsg(6.75, 7.8) === 32632); ok('utm zone south', utmEpsg(-47, -15) === 32723);
  ok('resolution choice', resolutionFor(500) === 20 && resolutionFor(2000) === 40 && resolutionFor(5000) === null);
  const sq = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]; ok('ring area 1x1 degree at equator', near(ringAreaKm2(sq), 12363.7, 0.5), ringAreaKm2(sq).toFixed(1));
  const z = rasterisePolygons([[[[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]]], 4, 4);
  ok('rasterise square', [5, 6, 9, 10].every(i => z[i] === 0) && z.filter(v => v === 0).length === 4); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
