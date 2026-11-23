import { stacSearch, signedHref, readToGrid, defineEpsg, project } from '../js/io.js';
import { makeGrid, utmEpsg } from '../js/engine.js';
const bbox = [6.70, 7.75, 6.80, 7.85];
const items = await stacSearch({ collections: ['sentinel-1-rtc'], bbox, datetime: '2022-10-10/2022-10-15' });
const it = items[0];
console.log(it.id, it.properties['proj:epsg'], it.properties['sat:relative_orbit']);
const crs = it.properties['proj:epsg'];
const c = project('EPSG:4326', defineEpsg(crs), [[bbox[0], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[2], bbox[1]]]);
const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
const grid = makeGrid([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], 20, crs);
console.log('grid', grid.w, grid.h);
const t0 = Date.now();
const vv = await readToGrid(await signedHref(it.assets.vv.href, 'sentinel-1-rtc'), grid, { method: 'bilinear' });
let n = 0, s = 0, mn = Infinity, mx = -Infinity; for (const v of vv) if (v === v) { n++; s += v; mn = Math.min(mn, v); mx = Math.max(mx, v); }
console.log('vv valid', n, 'mean', s / n, 'min', mn, 'max', mx, 'ms', Date.now() - t0);
