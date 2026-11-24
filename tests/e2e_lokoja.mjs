import { listAcquisitions, runAnalysis } from '../js/pipeline.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// outputs go to OUT_DIR, default tests/out/ (ignored by git); the population tiles are read from BASE, default the local server on 8766
const OUT = process.env.OUT_DIR || fileURLToPath(new URL('./out/', import.meta.url)); mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const ring = [[6.70, 7.70], [6.85, 7.70], [6.85, 7.85], [6.70, 7.85], [6.70, 7.70]];
const bbox = [6.70, 7.70, 6.85, 7.85];
const { list: acq } = await listAcquisitions(bbox, '2022-07-01', '2022-11-30');
console.log(acq.map(a => a.datetime.slice(0, 10) + ' ' + a.orbitState + ' ' + a.relativeOrbit).join('\n'));
const pre = acq.find(a => a.datetime.startsWith('2022-08-02')), post = acq.find(a => a.datetime.startsWith('2022-10-13'));
const r = await runAnalysis({ aoi: { type: 'Polygon', coordinates: [ring] }, pre, post, base: BASE, onProgress: m => console.log('  ·', m) });
console.log(JSON.stringify({ threshold: r.threshold, summary: r.summary }, null, 1));
writeFileSync(`${OUT}/lokoja_js.json`, JSON.stringify({ grid: r.grid, summary: r.summary, threshold: r.threshold.value, cls: Array.from(r.cls) }));
import { floodGeoJSON } from '../js/exports.js';
writeFileSync(`${OUT}/lokoja.geojson`, JSON.stringify(floodGeoJSON(r.cls, r.grid, {})));
