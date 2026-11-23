// Reads one band with nearest-neighbour at full resolution and writes it out, for comparison with GDAL (tests/geometry_check.py).
import { readToGrid, signedHref, stacSearch } from '../js/io.js';
import { makeGrid } from '../js/engine.js';
import { writeFileSync } from 'node:fs';
const [coll, asset, day, x0, y1, crs, res, w, h, out] = process.argv.slice(2);
const items = await stacSearch({ collections: [coll], bbox: [6.70, 7.70, 6.85, 7.85], ...(day !== '-' ? { datetime: `${day}T00:00:00Z/${day}T23:59:59Z` } : {}) });
const grid = { crs: +crs, res: +res, x0: +x0, y1: +y1, w: +w, h: +h, n: w * h };
const a = await readToGrid(await signedHref(items[0].assets[asset].href, coll), grid, { method: 'nearest', fullRes: true, step: 1 });
writeFileSync(out, Buffer.from(a.buffer));
console.log(items[0].id);
