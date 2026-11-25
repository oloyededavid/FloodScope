// Deterministic end-to-end check on fixed inputs: a small box inside the Lokoja example (Niger-Benue confluence,
// 2 Aug -> 13 Oct 2022) runs through the whole pipeline with every network response replayed from tests/fixtures/lokoja-small/.
// The live archives can be reprocessed or reindexed; this test cannot change unless the code does.
//   node tests/fixture_lokoja.mjs            replay and compare with tests/fixtures/lokoja-small/expected.json (needs the repository served on BASE)
//   FIXTURE=record node tests/fixture_lokoja.mjs   re-record the inputs and the expected values (only after a deliberate change)
import { installFixtureFetch } from './fixture_fetch.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const DIR = fileURLToPath(new URL('./fixtures/lokoja-small/', import.meta.url)), MODE = process.env.FIXTURE || 'replay';
installFixtureFetch(DIR, MODE);
const { listAcquisitions, runAnalysis } = await import('../js/pipeline.js');
const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const bbox = [6.745, 7.775, 6.765, 7.795], ring = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]];
const { list } = await listAcquisitions(bbox, '2022-07-01', '2022-11-30');
const pre = list.find(a => a.datetime.startsWith('2022-08-02')), post = list.find(a => a.datetime.startsWith('2022-10-13'));
const r = await runAnalysis({ aoi: { type: 'Polygon', coordinates: [ring] }, pre, post, base: BASE, onProgress: () => {} });
const a = r.summary.areaKm2;
const got = { pre: pre.id, post: post.id, threshold: r.threshold.value, thresholdSource: r.threshold.source, grid: [r.grid.w, r.grid.h, r.grid.res, r.grid.crs],
  classHash: createHash('sha256').update(Buffer.from(r.cls.buffer, r.cls.byteOffset, r.cls.byteLength)).digest('hex'),
  flood: +a.flood.toFixed(6), floodHigh: +a.floodHigh.toFixed(6), permanent: +a.permanent.toFixed(6), valid: +a.valid.toFixed(6),
  residents: +r.summary.population.inFlood.toFixed(3) };
const exp = `${DIR}/expected.json`;
if (MODE === 'record') { writeFileSync(exp, JSON.stringify(got, null, 1)); console.log('recorded', got); process.exit(0); }
const want = JSON.parse(readFileSync(exp, 'utf8')); let bad = 0;
for (const k of Object.keys(want)) { const ok = JSON.stringify(want[k]) === JSON.stringify(got[k]); if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(got[k])}${ok ? '' : ` (expected ${JSON.stringify(want[k])})`}`); }
process.exit(bad ? 1 : 0);
