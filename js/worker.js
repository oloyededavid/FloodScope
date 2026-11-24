/* FloodScope Web Worker: keeps the arrays of the current run and answers the page's requests. */
import { listAcquisitions, runAnalysis, reclassify } from './pipeline.js';
import { classGeoTiff, floodGeoJSON, summaryCsv, metadataJson } from './exports.js';

let run = null, controller = null;

const send = (type, data, transfer) => self.postMessage({ type, ...data }, transfer || []);

self.onmessage = async ({ data: m }) => {
  try {
    if (m.cmd === 'acquisitions') {
      const { list, truncated } = await listAcquisitions(m.bbox, m.start, m.end);   // each request has its own time limit (io.pcFetch)
      send('acquisitions', { id: m.id, list, truncated });
    } else if (m.cmd === 'run') {
      if (controller) controller.abort();
      controller = new AbortController();
      run = null;
      run = await runAnalysis({ ...m.args, signal: controller.signal, onProgress: msg => send('progress', { id: m.id, msg }) });
      send('result', { id: m.id, ...view(run) });
    } else if (m.cmd === 'cancel') {
      if (controller) controller.abort();
    } else if (m.cmd === 'reclassify') {
      if (!run) throw new Error('No analysis to update');
      const p = { ...run.params, ...m.params };
      const r = reclassify(run.layers, run.grid, p, run.zoneNames);
      Object.assign(run, r, { params: p, threshold: { ...run.threshold, value: p.threshold, source: m.params.threshold !== undefined ? 'set by user' : run.threshold.source } });
      send('result', { id: m.id, ...view(run) });
    } else if (m.cmd === 'inspect') {
      if (!run) throw new Error('No analysis to inspect');
      const i = m.index, L = run.layers, g = (a) => a ? (a[i] === a[i] ? a[i] : null) : null;
      send('inspect', { id: m.id, values: { preVV: g(L.preVV), postVV: g(L.postVV), preVH: g(L.preVH), postVH: g(L.postVH),
        occurrence: g(L.occurrence), slope: g(L.slope), landcover: L.landcover[i], popDensity: g(L.popDensity), cls: run.cls[i] } });
    } else if (m.cmd === 'export') {
      if (!run) throw new Error('No analysis to export');
      const meta = { ...run.meta, parameters: run.params, threshold: run.threshold };
      let blob;
      if (m.kind === 'geotiff') blob = new Blob([classGeoTiff(run.cls, run.grid)], { type: 'image/tiff' });
      else if (m.kind === 'geojson') blob = new Blob([JSON.stringify(floodGeoJSON(run.cls, run.grid, meta))], { type: 'application/geo+json' });
      else if (m.kind === 'csv') blob = new Blob([summaryCsv(run.summary, run.meta, run.params)], { type: 'text/csv' });
      else if (m.kind === 'json') blob = new Blob([metadataJson(run.meta, run.params, run.threshold)], { type: 'application/json' });
      send('export', { id: m.id, kind: m.kind, blob });
    }
  } catch (e) {
    send('error', { id: m.id, message: e.name === 'AbortError' ? 'Cancelled' : (e.message || String(e)) });
  }
};

/** What the page needs to draw: class grid, radar dB images and the histogram of VV after over the pixels the threshold
    applies to (not permanent water, not steep, not no-data), i.e. the same pixels Otsu uses. Copies are sent. */
function view(r) {
  const hist = new Uint32Array(300); // -30..0 dB, 0.1 dB bins
  const a = r.layers.postVV;
  for (let i = 0; i < a.length; i++) { const v = a[i], c = r.cls[i]; if (c !== 0 && c !== 4 && c !== 5 && v === v && v >= -30 && v < 0) hist[Math.floor((v + 30) * 10)]++; }
  const cls = r.cls.slice(), pre = r.layers.preVV.slice(), post = r.layers.postVV.slice();
  return { grid: r.grid, cls, pre, post, hist, summary: r.summary, threshold: r.threshold, params: r.params, meta: r.meta,
           transfer: undefined };
}
