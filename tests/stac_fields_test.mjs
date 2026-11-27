// STAC projection fields: older Sentinel-1 RTC items give proj:epsg, items from 2025 on give proj:code (projection extension v2).
import { epsgOf } from '../js/pipeline.js';
const cases = [[{ 'proj:epsg': 32632 }, 32632], [{ 'proj:code': 'EPSG:32632' }, 32632], [{ 'proj:epsg': 32631, 'proj:code': 'EPSG:32632' }, 32631], [{}, undefined], [{ 'proj:code': 'IAU_2015:30100' }, undefined]];
let bad = 0;
for (const [p, want] of cases) { const got = epsgOf(p); if (got !== want) { bad++; console.log('FAIL', JSON.stringify(p), got, want); } }
console.log(bad ? `${bad} FAILED` : `PASS  epsgOf: ${cases.length} cases`); process.exit(bad ? 1 : 0);
