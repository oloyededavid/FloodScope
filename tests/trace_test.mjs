// Unit test: traceMask must reproduce pixel areas exactly, keep corner-touching pixels apart and assign holes.
import { traceMask } from '../js/exports.js';
const cases = [];
const W = 7, H = 6, m = new Uint8Array(W * H);
const set = (x, y) => m[y * W + x] = 1;
for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) set(x, y);  // 5x5 block
m[2 * W + 2] = 0;                                                  // hole in the middle
set(5, 5);                                                          // touches nothing
set(6, 4);                                                          // corner-touches (5,5)
const polys = traceMask(m, W, H);
const area = r => { let s = 0; for (let i = 0; i + 1 < r.length; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return s / 2; };
const total = polys.reduce((t, p) => t + Math.abs(area(p[0])) - p.slice(1).reduce((a, h) => a + Math.abs(area(h)), 0), 0);
const expected = m.reduce((a, b) => a + b, 0);
console.log('polygons', polys.length, 'holes', polys.map(p => p.length - 1), 'area', total, 'expected', expected);
if (total !== expected || polys.length !== 3 || polys.filter(p => p.length === 2).length !== 1) { console.error('FAIL'); process.exit(1); }
console.log('PASS');
