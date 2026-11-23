# FloodScope function reference

There is no server. The "API" is the set of functions in `js/pipeline.js`, plus the message protocol between the page and the worker (`js/worker.js`). Inputs are validated where they enter `runAnalysis`.

## `listAcquisitions(bbox, start, end, signal)` → `Acquisition[]`
- **Request:**
  - `bbox`: `[west, south, east, north]` in degrees;
  - `start`, `end`: ISO 8601 date-times.
- **Response:** Sentinel-1 RTC items intersecting the box, oldest first. Each has `{ id, datetime, platform, orbitState, relativeOrbit, epsg, bbox, geometry, polarisations, vv, vh }`, where `vv` and `vh` are unsigned asset URLs.
- **Errors:** `STAC search failed (status)`.

## `runAnalysis({ aoi, pre, post, params, base, zones, onProgress, signal })` → `Run`

| Field | Required | Rule |
|---|---|---|
| `aoi` | yes | GeoJSON Polygon in WGS 84. Area ≤ 3,600 km² (error otherwise) |
| `pre`, `post` | yes | Acquisitions from `listAcquisitions`. Same `relativeOrbit` and `orbitState`; `pre.datetime` < `post.datetime` (error otherwise) |
| `params` | no | Any of `speckleWindow` (3), `thresholdVV` (−18), `autoThreshold` (true), `otsuMin` (−24), `otsuMax` (−14), `changeDb` (−3), `slopeMax` (5), `permanentOccurrence` (80) |
| `base` | yes | URL of the app root, used to find `data/population/` |
| `zones` | no | GeoJSON FeatureCollection of polygons with `shapeName` or `name` |

**Response** `Run`:
- `grid`: `{ crs, res, x0, y1, w, h, n, bbox }`;
- `layers`: `preVV`, `postVV`, `preVH`, `postVH` (dB), `occurrence`, `slope`, `landcover`, `popDensity`, `inAoi`, `zoneIdx`;
- `cls`: `Uint8Array` of class codes 0–6;
- `summary`;
- `threshold`: `{ value, source, otsu }`;
- `params`;
- `meta`: inputs, sources, log and version.

**Errors:** "Choose a before and an after acquisition", the same-orbit rule, the order rule, the area limit, "Could not get a read token", "STAC search failed", and file or network errors from geotiff.js.

## `reclassify(layers, grid, params, zoneNames)` → `{ cls, summary }`
Applies `engine.classify` and `engine.summarise` with new parameters to the stored layers. No data are read.

## Worker messages
- **The page sends:** `{ cmd, id, ... }` where `cmd` is one of:
  - `acquisitions` `{ bbox, start, end }`
  - `run` `{ args }`
  - `reclassify` `{ params }`
  - `inspect` `{ index }`
  - `export` `{ kind: 'geotiff' | 'geojson' | 'csv' | 'json' }`
  - `cancel`
- **The worker replies with** `{ type, id, ... }` where `type` is one of: `acquisitions`, `progress`, `result`, `inspect`, `export` (with a `Blob`) or `error` (with a `message`).

## Class codes
| Code | Meaning |
|---|---|
| 0 | no data |
| 1 | dry |
| 2 | flood, high confidence |
| 3 | flood, medium confidence |
| 4 | permanent water |
| 5 | excluded: slope |
| 6 | water before the event |
