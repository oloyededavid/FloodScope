/* FloodScope data access: STAC search on Microsoft Planetary Computer, SAS signing, and reading Cloud Optimised
   GeoTIFF windows onto the analysis grid. Works in a browser worker and in Node 18+ (global fetch). */
import { fromUrl, proj4 } from '../vendor/geo-libs.mjs';

export const PC = 'https://planetarycomputer.microsoft.com/api';

// ---------------------------------------------------------------- CRS
export function defineEpsg(code) {
  const name = `EPSG:${code}`;
  if (code === 4326 || proj4.defs(name)) return name;
  if (code > 32600 && code < 32661) proj4.defs(name, `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`);
  else if (code > 32700 && code < 32761) proj4.defs(name, `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`);
  else throw new Error(`Unsupported CRS EPSG:${code}`);
  return name;
}
export const project = (from, to, pts) => {
  if (from === to) return pts.map(p => p.slice());
  const t = proj4(from, to); return pts.map(p => t.forward(p));
};

// ---------------------------------------------------------------- STAC
export async function stacSearch(body, { signal, maxItems = 500 } = {}) {
  const items = [];
  let req = { url: `${PC}/stac/v1/search`, body: { limit: 100, ...body } };
  while (req && items.length < maxItems) {
    const r = await fetch(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body), signal });
    if (!r.ok) throw new Error(`STAC search failed (${r.status})`);
    const j = await r.json();
    items.push(...j.features);
    const next = (j.links || []).find(l => l.rel === 'next');
    req = next && next.body ? { url: next.href, body: next.body } : null;
  }
  return items;
}

const tokens = new Map();
/** Short-lived read token for a Planetary Computer collection (no account needed). Cached until 5 minutes before expiry. */
export async function signedHref(href, collection, signal) {
  let t = tokens.get(collection);
  if (!t || Date.parse(t.expiry) - Date.now() < 5 * 60e3) {
    const r = await fetch(`${PC}/sas/v1/token/${collection}`, { signal });
    if (!r.ok) throw new Error(`Could not get a read token for ${collection} (${r.status})`);
    const j = await r.json(); t = { token: j.token, expiry: j['msft:expiry'] }; tokens.set(collection, t);
  }
  return `${href}${href.includes('?') ? '&' : '?'}${t.token}`;
}

// ---------------------------------------------------------------- COG reading
const tiffCache = new Map();
async function openTiff(url) {
  const key = url.split('?')[0];
  let p = tiffCache.get(key);
  if (!p) { p = fromUrl(url, { allowFullFile: false, cacheSize: 200 }); tiffCache.set(key, p); }
  return p;
}
export function clearCache() { tiffCache.clear(); }

function imageEpsg(img) {
  const g = img.getGeoKeys() || {};
  const c = g.ProjectedCSTypeGeoKey || g.GeographicTypeGeoKey;
  if (!c || c === 32767) throw new Error('GeoTIFF without an EPSG code');
  return c;
}

/** Read one band of a COG onto the grid.
    grid: from engine.makeGrid (projected CRS, metres). method: 'nearest' | 'bilinear' | 'average' (mean of source pixels inside each grid pixel; used for radar power).
    Returns Float32Array (grid.n), NaN outside the file or at no-data. Coordinates of grid pixel centres are transformed
    to the file's CRS on a lattice every `step` pixels and interpolated in between (error well under one source pixel). */
export async function readToGrid(url, grid, { method = 'nearest', band = 0, into = null, step = 16, signal, fullRes = false } = {}) {
  const out = into || new Float32Array(grid.n).fill(NaN);
  const tiff = await openTiff(url);
  const img0 = await tiff.getImage(0);
  const srcCrs = defineEpsg(imageEpsg(img0)), gridCrs = defineEpsg(grid.crs);
  const [rx0, ry0] = img0.getResolution(), W0 = img0.getWidth(), H0 = img0.getHeight();
  let [ox, oy] = img0.getOrigin();
  // GTRasterTypeGeoKey 2 = PixelIsPoint (e.g. Copernicus DEM): the tie point is a pixel centre, so move it to the corner,
  // as GDAL does by default
  if ((img0.getGeoKeys() || {}).GTRasterTypeGeoKey === 2) { ox -= rx0 / 2; oy -= ry0 / 2; }
  const nodata = img0.getGDALNoData();

  // source coordinates of grid pixel centres, on a lattice
  const lw = Math.ceil(grid.w / step) + 1, lh = Math.ceil(grid.h / step) + 1, lat = [];
  for (let j = 0; j < lh; j++) for (let i = 0; i < lw; i++) {
    const x = grid.x0 + (Math.min(i * step, grid.w - 1) + 0.5) * grid.res, y = grid.y1 - (Math.min(j * step, grid.h - 1) + 0.5) * grid.res;
    lat.push([x, y]);
  }
  const src = project(gridCrs, srcCrs, lat);
  let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
  for (const [x, y] of src) { if (x < sx0) sx0 = x; if (x > sx1) sx1 = x; if (y < sy0) sy0 = y; if (y > sy1) sy1 = y; }
  // full-resolution pixel window, padded; stop if it misses the file
  const fx0 = Math.floor((sx0 - ox) / rx0) - 2, fx1 = Math.ceil((sx1 - ox) / rx0) + 2;
  const fy0 = Math.floor((sy1 - oy) / ry0) - 2, fy1 = Math.ceil((sy0 - oy) / ry0) + 2; // ry0 < 0
  if (fx1 < 0 || fy1 < 0 || fx0 >= W0 || fy0 >= H0) return out;

  // choose the coarsest overview that is still at least as fine as the grid
  const srcIsGeo = srcCrs === 'EPSG:4326';
  const midLat = (sy0 + sy1) / 2;
  const gridResInSrc = srcIsGeo ? grid.res / (111320 * Math.cos(midLat * Math.PI / 180)) : grid.res;
  let level = 0, scale = 1;
  const nImg = await tiff.getImageCount();
  for (let k = 1; k < nImg; k++) {
    const im = await tiff.getImage(k), s = W0 / im.getWidth();
    // 'average' keeps at least 2 x 2 source pixels per grid pixel so the mean is computed here, not inherited from an overview
    const limit = method === 'average' ? gridResInSrc / 2 : gridResInSrc;
    if (!fullRes && Math.abs(rx0) * s <= limit * 1.0001) { level = k; scale = s; }
  }
  const img = level ? await tiff.getImage(level) : img0;
  const Wl = img.getWidth(), Hl = img.getHeight(), rx = rx0 * scale, ry = ry0 * scale;
  const wx0 = Math.max(0, Math.floor(fx0 / scale)), wx1 = Math.min(Wl, Math.ceil(fx1 / scale));
  const wy0 = Math.max(0, Math.floor(fy0 / scale)), wy1 = Math.min(Hl, Math.ceil(fy1 / scale));
  if (wx1 <= wx0 || wy1 <= wy0) return out;
  const ras = await img.readRasters({ window: [wx0, wy0, wx1, wy1], samples: [band], interleave: false, signal });
  const data = ras[0], ww = wx1 - wx0, wh = wy1 - wy0;
  const val = (c, r) => {
    if (c < 0 || r < 0 || c >= ww || r >= wh) return NaN;
    const v = data[r * ww + c];
    return v === nodata || !(v === v) ? NaN : v;
  };

  // lattice node k sits at pixel min(k * step, size - 1); interpolate between the two nodes around each pixel
  const frac = (p, size, nNodes) => {
    const k = Math.max(0, Math.min(Math.floor(p / step), nNodes - 2));
    const a = Math.min(k * step, size - 1), b = Math.min((k + 1) * step, size - 1);
    return [k, b > a ? (p - a) / (b - a) : 0];
  };
  for (let y = 0; y < grid.h; y++) {
    const [ly, ty] = frac(y, grid.h, lh);
    for (let x = 0; x < grid.w; x++) {
      const [lx, tx] = frac(x, grid.w, lw);
      const a = src[ly * lw + lx], b = src[ly * lw + lx + 1], c = src[(ly + 1) * lw + lx], d = src[(ly + 1) * lw + lx + 1];
      const X = (1 - ty) * ((1 - tx) * a[0] + tx * b[0]) + ty * ((1 - tx) * c[0] + tx * d[0]);
      const Y = (1 - ty) * ((1 - tx) * a[1] + tx * b[1]) + ty * ((1 - tx) * c[1] + tx * d[1]);
      const fc = (X - ox) / rx - wx0, fr = (Y - oy) / ry - wy0; // continuous pixel coordinates in the window
      let v;
      if (method === 'average') {
        // mean of the source pixels whose centres fall inside the grid pixel (k x k sub-samples, NaN skipped)
        const span = gridResInSrc / Math.abs(rx), k = Math.max(1, Math.round(span));
        let s = 0, n = 0;
        for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
          const q = val(Math.floor(fc + ((i + 0.5) / k - 0.5) * span), Math.floor(fr + ((j + 0.5) / k - 0.5) * span));
          if (q === q) { s += q; n++; }
        }
        v = n ? s / n : NaN;
      } else if (method === 'bilinear') {
        const c0 = Math.floor(fc - 0.5), r0 = Math.floor(fr - 0.5), u = fc - 0.5 - c0, t = fr - 0.5 - r0;
        const v00 = val(c0, r0), v10 = val(c0 + 1, r0), v01 = val(c0, r0 + 1), v11 = val(c0 + 1, r0 + 1);
        v = (v00 === v00 && v10 === v10 && v01 === v01 && v11 === v11)
          ? (1 - t) * ((1 - u) * v00 + u * v10) + t * ((1 - u) * v01 + u * v11)
          : val(Math.floor(fc), Math.floor(fr));
      } else v = val(Math.floor(fc), Math.floor(fr));
      if (v === v) out[y * grid.w + x] = v;
    }
  }
  return out;
}

/** Read several tiles (e.g. 1-degree DEM tiles) into one grid; later tiles only fill pixels still NaN. */
export async function readMosaic(urls, grid, opts = {}) {
  let out = new Float32Array(grid.n).fill(NaN);
  for (const u of urls) {
    const part = await readToGrid(u, grid, opts);
    for (let i = 0; i < out.length; i++) if (!(out[i] === out[i]) && part[i] === part[i]) out[i] = part[i];
  }
  return out;
}
