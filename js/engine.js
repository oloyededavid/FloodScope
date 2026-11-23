/* FloodScope engine: pure functions on typed arrays, no DOM and no network.
   The same file runs in the browser (inside a Web Worker) and in Node for the tests.
   Every rule here is described in docs/methodology.md; parameter names match that document. */

export const DEFAULTS = Object.freeze({
  speckleWindow: 3,          // focal mean of linear gamma0, pixels (3 x 3 at 20 m = 60 m window)
  thresholdVV: -18,          // dB, used when the automatic threshold is switched off
  autoThreshold: true,       // Otsu threshold on post-event VV, bounded to [otsuMin, otsuMax]
  otsuMin: -24, otsuMax: -14,
  changeDb: -3,              // post minus pre, dB; flood needs at least this much darkening in VV
  slopeMax: 5,               // degrees; steeper pixels are excluded (radar shadow and layover, runoff)
  permanentOccurrence: 80,   // JRC GSW occurrence, %; at or above this the pixel is permanent water
});

// ---------------------------------------------------------------- speckle and dB
/** Focal mean over a square window, ignoring NaN. Input and output are Float32Array (row-major, w x h). */
export function focalMean(a, w, h, size) {
  const r = (size - 1) >> 1, out = new Float32Array(w * h);
  // two-pass box sum on a summed-area table, counting valid pixels so NaN edges are handled
  const W = w + 1, S = new Float64Array(W * (h + 1)), N = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rn = 0;
    for (let x = 0; x < w; x++) {
      const v = a[y * w + x];
      if (v === v) { rs += v; rn++; }
      S[(y + 1) * W + x + 1] = S[y * W + x + 1] + rs;
      N[(y + 1) * W + x + 1] = N[y * W + x + 1] + rn;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      if (!(a[y * w + x] === a[y * w + x])) { out[y * w + x] = NaN; continue; }
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0];
      const n = N[y1 * W + x1] - N[y0 * W + x1] - N[y1 * W + x0] + N[y0 * W + x0];
      out[y * w + x] = n > 0 ? s / n : NaN;
    }
  }
  return out;
}

/** Linear power to dB; zero, negative and NaN become NaN (no-data in Sentinel-1 RTC is 0 or NaN). */
export function toDb(a) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) { const v = a[i]; out[i] = v > 0 ? 10 * Math.log10(v) : NaN; }
  return out;
}

// ---------------------------------------------------------------- threshold
/** Otsu (1979) threshold of finite values within [lo, hi], 0.1 dB bins.
    Returns {t, separation, valleyRatio, minorShare, n}:
      separation  between-class variance / total variance (Otsu's criterion; high even for one normal peak, so not used alone)
      valleyRatio after smoothing the histogram with a 1 dB moving average, the lowest count between the highest bin below t
                  and the highest bin above t, divided by the lower of those two peaks. A single peak gives about 1; two
                  separate peaks give a value well below 1. This is the test for two modes.
      minorShare  share of values in the smaller class. */
export function otsu(a, lo = -30, hi = 0, step = 0.1) {
  const nb = Math.round((hi - lo) / step), hist = new Float64Array(nb);
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]; if (!(v === v) || v < lo || v >= hi) continue;
    hist[Math.min(nb - 1, Math.floor((v - lo) / step))]++; n++;
  }
  if (n < 100) return { t: NaN, separation: 0, valleyRatio: 1, minorShare: 0, n };
  const c = i => lo + (i + 0.5) * step;
  let sumAll = 0, sq = 0;
  for (let i = 0; i < nb; i++) { sumAll += hist[i] * c(i); sq += hist[i] * c(i) * c(i); }
  const mean = sumAll / n, varT = sq / n - mean * mean;
  // between-class variance for a split after each bin; where several splits tie (empty bins between the modes),
  // the threshold is the middle of the tied range
  const bv = new Float64Array(nb).fill(-1);
  let wB = 0, sumB = 0, best = -1;
  for (let i = 0; i < nb - 1; i++) {
    wB += hist[i]; sumB += hist[i] * c(i);
    if (wB === 0) continue;
    const wF = n - wB; if (wF === 0) break;
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    bv[i] = (wB / n) * (wF / n) * (mB - mF) ** 2;
    if (bv[i] > best) best = bv[i];
  }
  let first = -1, last = -1;
  for (let i = 0; i < nb; i++) if (bv[i] >= best * (1 - 1e-9)) { if (first < 0) first = i; last = i; }
  const t = lo + ((first + last) / 2 + 1) * step, ti = Math.round((t - lo) / step);
  const half = Math.round(0.5 / step), sm = new Float64Array(nb);
  for (let i = 0; i < nb; i++) { let s2 = 0, m2 = 0; for (let j = i - half; j <= i + half; j++) if (j >= 0 && j < nb) { s2 += hist[j]; m2++; } sm[i] = s2 / m2; }
  let pl = 0, il = 0, pr = 0, ir = nb - 1;
  for (let i = 0; i < ti; i++) if (sm[i] > pl) { pl = sm[i]; il = i; }
  for (let i = ti; i < nb; i++) if (sm[i] > pr) { pr = sm[i]; ir = i; }
  let valley = Infinity; for (let i = il; i <= ir; i++) if (sm[i] < valley) valley = sm[i];
  let below = 0; for (let i = 0; i < ti; i++) below += hist[i];
  return { t, separation: varT > 0 ? best / varT : 0, valleyRatio: Math.min(pl, pr) > 0 ? valley / Math.min(pl, pr) : 1,
           minorShare: Math.min(below, n - below) / n, n };
}

// ---------------------------------------------------------------- terrain
/** Slope in degrees by Horn's (1981) method on a grid with square pixels of size res (metres). Edges use clamped neighbours. */
export function slopeDeg(z, w, h, res) {
  const out = new Float32Array(w * h), at = (x, y) => z[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1), d = at(x - 1, y), f = at(x + 1, y),
          g = at(x - 1, y + 1), hh = at(x, y + 1), i = at(x + 1, y + 1);
    const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * res), dzdy = ((g + 2 * hh + i) - (a + 2 * b + c)) / (8 * res);
    const s = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
    out[y * w + x] = s === s ? s : NaN;
  }
  return out;
}

// ---------------------------------------------------------------- classification
/* class codes in the output grid */
export const CLS = Object.freeze({ NODATA: 0, DRY: 1, FLOOD_HIGH: 2, FLOOD_MEDIUM: 3, PERMANENT: 4, STEEP: 5, WATER_BEFORE: 6 });

/** Classify each pixel. Inputs are dB arrays after speckle filtering (VH arrays may be null), JRC occurrence (%), slope (deg).
    Rule (methodology section 4):
      no-data     any of preVV, postVV missing
      permanent   occurrence >= permanentOccurrence
      steep       slope > slopeMax
      flood       postVV < T  and  postVV - preVV <= changeDb
                  high confidence if VH also darkens by changeDb or more (where VH exists), otherwise medium
      water before  preVV < T and not flood (already water-like before the event; not counted as flood)
      dry         everything else */
export function classify({ preVV, postVV, preVH, postVH, occurrence, slope }, n, p) {
  const out = new Uint8Array(n), T = p.threshold;
  for (let i = 0; i < n; i++) {
    const a = preVV[i], b = postVV[i];
    if (!(a === a) || !(b === b)) { out[i] = CLS.NODATA; continue; }
    const occ = occurrence ? occurrence[i] : 0;
    if (occ === occ && occ >= p.permanentOccurrence && occ <= 100) { out[i] = CLS.PERMANENT; continue; }
    const s = slope ? slope[i] : 0;
    if (s === s && s > p.slopeMax) { out[i] = CLS.STEEP; continue; }
    if (b < T && b - a <= p.changeDb) {
      let high = false;
      if (preVH && postVH) { const c = preVH[i], d = postVH[i]; high = c === c && d === d && d - c <= p.changeDb; }
      out[i] = high ? CLS.FLOOD_HIGH : CLS.FLOOD_MEDIUM;
    } else out[i] = a < T ? CLS.WATER_BEFORE : CLS.DRY;
  }
  return out;
}

// ---------------------------------------------------------------- exposure
/** Area of one GHS-POP 30 arc-second cell centred at latitude lat (km^2) on the WGS 84 ellipsoid (exact formula for an
    ellipsoidal quadrangle: A = b^2 * dLon / 2 * [q(phi2) - q(phi1)], with q the authalic function). */
export function cellAreaKm2(lat, arcsec = 30) {
  const a = 6378.137, f = 1 / 298.257223563, e2 = f * (2 - f), e = Math.sqrt(e2), b2 = a * a * (1 - e2);
  const d = arcsec / 3600 * Math.PI / 180, phi = lat * Math.PI / 180;
  const q = p => { const s = Math.sin(p); return s / (1 - e2 * s * s) + Math.log((1 + e * s) / (1 - e * s)) / (2 * e); };
  return b2 * d / 2 * (q(phi + d / 2) - q(phi - d / 2));
}

/** UTM point scale factor at easting E (m), to first order: k = 0.9996 * (1 + (E - 500000)^2 / (2 R^2)), R = 6371 km.
    A UTM square of map area A covers A / k^2 on the ground. */
export function utmScale(easting) { const d = easting - 500000; return 0.9996 * (1 + d * d / (2 * 6371000 * 6371000)); }

/** Summaries over the classified grid.
    pixelAreaM2: area of one grid pixel (m^2). popDensity: persons per km^2 per grid pixel (Float32Array, NaN = no data).
    landcover: ESA WorldCover class per pixel (Uint8Array) or null. zones: Int32Array of zone index per pixel (-1 = none) or null. */
export function summarise(cls, { pixelAreaM2, colAreaKm2 = null, width = 0, popDensity, landcover, zones, nZones, inAoi = null }) {
  // ground area of each pixel: per column when a UTM scale correction is given, otherwise the map area
  const n = cls.length, km2 = pixelAreaM2 / 1e6, A = colAreaKm2 ? (i => colAreaKm2[i % width]) : (() => km2);
  const area = new Float64Array(7);
  let popFlood = 0, popHigh = 0, popAll = 0, popAoi = 0, popMissing = 0, nValid = 0;
  const lc = new Map(), zf = nZones ? new Float64Array(nZones) : null, zp = nZones ? new Float64Array(nZones) : null;
  for (let i = 0; i < n; i++) {
    const c = cls[i], a = A(i); area[c] += a;
    const d = popDensity ? popDensity[i] : NaN, pp = d === d ? d * a : 0;
    if (!inAoi || inAoi[i] >= 0) popAoi += pp;
    if (c !== CLS.NODATA) { nValid++; if (d === d) popAll += pp; else popMissing++; }
    const flood = c === CLS.FLOOD_HIGH || c === CLS.FLOOD_MEDIUM;
    if (!flood) continue;
    popFlood += pp; if (c === CLS.FLOOD_HIGH) popHigh += pp;
    if (landcover) { const k = landcover[i]; lc.set(k, (lc.get(k) || 0) + a); }
    if (zf) { const z = zones[i]; if (z >= 0) { zf[z] += a; zp[z] += pp; } }
  }
  const valid = area[1] + area[2] + area[3] + area[4] + area[5] + area[6];
  return {
    pixels: n, validPixels: nValid,
    areaKm2: { valid, flood: area[2] + area[3], floodHigh: area[2], floodMedium: area[3],
               permanent: area[4], steep: area[5], waterBefore: area[6], dry: area[1] },
    population: { inFlood: popFlood, inFloodHigh: popHigh, inValidArea: popAll, inAoi: popAoi, pixelsWithoutPopulation: popMissing },
    landcoverKm2: Object.fromEntries([...lc.entries()].sort((a, b) => b[1] - a[1])),
    zones: zf ? Array.from(zf, (v, z) => ({ zone: z, floodKm2: v, population: zp[z] })) : null,
  };
}

// ---------------------------------------------------------------- zones
/** Rasterise polygons onto the grid by scanline (pixel centres). rings: array per zone of arrays of rings in grid pixel coordinates.
    Returns Int32Array with zone index, -1 outside every zone. Even-odd rule, so holes are respected. */
export function rasterisePolygons(zonesRings, w, h) {
  const out = new Int32Array(w * h).fill(-1);
  zonesRings.forEach((rings, z) => {
    let ymin = Infinity, ymax = -Infinity;
    for (const r of rings) for (const [, y] of r) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
    const y0 = Math.max(0, Math.floor(ymin)), y1 = Math.min(h - 1, Math.ceil(ymax));
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5, xs = [];
      for (const r of rings) for (let k = 0, m = r.length - 1; k < r.length; m = k++) {
        const [xa, ya] = r[m], [xb, yb] = r[k];
        if ((ya <= cy && yb > cy) || (yb <= cy && ya > cy)) xs.push(xa + (cy - ya) / (yb - ya) * (xb - xa));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = xa; x <= xb; x++) out[y * w + x] = z;
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------- grid
/** Analysis grid in a projected CRS: origin snapped to multiples of res. bbox = [minx, miny, maxx, maxy] in that CRS. */
export function makeGrid(bbox, res, crs) {
  const x0 = Math.floor(bbox[0] / res) * res, y1 = Math.ceil(bbox[3] / res) * res;
  const w = Math.ceil((bbox[2] - x0) / res), h = Math.ceil((y1 - bbox[1]) / res);
  return { crs, res, x0, y1, w, h, n: w * h, bbox: [x0, y1 - h * res, x0 + w * res, y1] };
}

/** UTM EPSG code for a lon/lat point (WGS 84). */
export function utmEpsg(lon, lat) {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return (lat >= 0 ? 32600 : 32700) + zone;
}

/** Grid resolution for an area, keeping the work within browser memory. */
export function resolutionFor(areaKm2) {
  if (areaKm2 <= 900) return 20;
  if (areaKm2 <= 3600) return 40;
  return null; // too large for an in-browser run
}
