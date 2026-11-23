// Sensitivity of the Lokoja result to the threshold and the after date; writes class grids for compare_unosat.py.
import { listAcquisitions, runAnalysis, reclassify } from '../js/pipeline.js';
import { classGeoTiff } from '../js/exports.js';
import { writeFileSync } from 'node:fs';
const D = process.argv[2];
const ring = [[6.70, 7.70], [6.85, 7.70], [6.85, 7.85], [6.70, 7.85], [6.70, 7.70]];
const acq = await listAcquisitions([6.70, 7.70, 6.85, 7.85], '2022-07-01', '2022-11-30');
const pre = acq.find(a => a.datetime.startsWith('2022-08-02'));
for (const day of ['2022-10-13', '2022-10-25']) {
  const post = acq.find(a => a.datetime.startsWith(day));
  const r = await runAnalysis({ aoi: { type: 'Polygon', coordinates: [ring] }, pre, post, base: 'http://127.0.0.1:8765' });
  for (const t of [-20, -18, -16, -15, -14]) {
    const { cls, summary } = reclassify(r.layers, r.grid, { ...r.params, threshold: t }, null);
    writeFileSync(`${D}/cls_${day}_${-t}.tif`, Buffer.from(classGeoTiff(cls, r.grid)));
    console.log(day, t, 'flood', summary.areaKm2.flood.toFixed(2), 'water before', summary.areaKm2.waterBefore.toFixed(2));
  }
}
