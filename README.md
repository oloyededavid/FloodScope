# FloodScope

Flood extent and exposure from Sentinel-1 radar, for any place between 56° S and 78° N since October 2014, computed in the browser.

**Live:** https://oloyededavid.github.io/FloodScope/ (after publication)

Pick an area and two Sentinel-1 acquisitions from the same orbit, one before and one after a flood. FloodScope maps the ground that turned to open water, then sums the modelled population (GHS-POP 2025), the land cover (ESA WorldCover) and the administrative areas (geoBoundaries) inside that water.

The analysis runs in a Web Worker in your browser:
- **Read live:** Sentinel-1 RTC, JRC Global Surface Water, Copernicus DEM and ESA WorldCover, as Cloud Optimised GeoTIFF windows from Microsoft Planetary Computer.
- **Read from this site:** population tiles.
- **Server:** none.

Example: the Niger–Benue confluence at Lokoja, Nigeria.
- Inputs: 2 August → 13 October 2022, an analysed area of 274.5 km².
- Results: 22.4 km² of new water, 19.4 km² of it high confidence, with about 4,990 modelled residents.

## Use it

1. **Place.** Search a town or river on the opening screen, draw a box, or open the Lokoja example. A three-screen tour explains the steps on first use; "How it works" reopens it.
2. **Images.** The dates default to the last 60 days; set them around the flood. Tap a radar image before the flood, then one after it on the same track. Rules and the administrative-area switch are under Advanced settings.
3. **Result.** The area of new water, the modelled residents and the flooded land cover, with a histogram to drag the water threshold and test the result. Export: report, map PNG, GeoJSON, GeoTIFF, statistics CSV, processing record and a share link.

## How it decides

A pixel is flood water if both hold:
- VV backscatter after the event is below −18 dB (or an Otsu threshold, when the histogram has two separate peaks);
- the pixel darkened by at least 3 dB since before.

Pixels are excluded as permanent water (JRC occurrence ≥ 80%) or as too steep (slope > 5°). Confidence is high when VH also darkened. The full rule, with its limits, is in [docs/methodology.md](docs/methodology.md).

## Checks

- **Unit tests:** `npm test`.
- **Reader against GDAL:** identical radar values, nearest neighbour and averaged.
- **Engine against an independent Python implementation:** flood area 22.4034 vs 22.4012 km², IoU 0.9992.
- **Population conservation:** within 0.05% of the GHS-POP cells over the box.
- **Exports:**
  - the GeoTIFF is checked with GDAL;
  - the GeoJSON is checked for validity and exact area with shapely and pyproj.
- **Agreement with UNOSAT** satellite water for the same event.
- **End-to-end run** in headless Chromium.

Results are in [docs/test-report.md](docs/test-report.md).

## Files

| Path | What |
|---|---|
| `index.html`, `css/app.css`, `js/app.js` | Page: landing, three steps (place, radar images, result), map, export |
| `js/app.js` | Interface: map, steps, results, exports |
| `js/worker.js` | Web Worker that holds the arrays of the current run |
| `js/pipeline.js` | The analysis: acquisitions, reading, classification, summaries |
| `js/engine.js` | Pure functions (no network, no DOM): speckle, dB, Otsu, slope, classification, exposure, grids |
| `js/io.js` | STAC search, Planetary Computer tokens, COG windows onto the grid |
| `js/exports.js` | GeoTIFF, exact GeoJSON tracing, CSV, metadata |
| `vendor/` | MapLibre GL JS 4.7.1; geotiff.js 2.1.3, proj4 2.12.1 and d3-contour 4.0.2, bundled with esbuild into one ES module; licences alongside |
| `data/population/` | GHS-POP R2023A 2025, 30″, as 30° COG tiles (`pipeline/build_population.py`) |
| `pipeline/reference.py` | Independent Python implementation used to check the engine |
| `pipeline/compare_unosat.py` | Agreement with UNOSAT water extents |
| `tests/` | Unit, reader, end-to-end and sensitivity tests |
| `docs/` | Methodology, data register, test report, function reference, validation outputs, screenshots |

## Run locally

```bash
npx http-server . -p 8765 -s --cors -c-1   # a server with HTTP range requests is needed for the population tiles
# open http://127.0.0.1:8765
npm test                                    # unit tests (Node 18+)
```

## Data and licences

Code: MIT. Data stay under their own licences; see [docs/data-register.md](docs/data-register.md).
- Contains modified Copernicus Sentinel data, processed by Microsoft Planetary Computer.
- GHS-POP © European Union, CC BY 4.0.
- ESA WorldCover © ESA WorldCover project, CC BY 4.0.
- JRC Global Surface Water © EC JRC/Google.
- Copernicus DEM © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA.
- Boundaries: geoBoundaries.
- Basemap © OpenStreetMap contributors via OpenFreeMap.
- Sentinel-2 cloudless by EOX IT Services GmbH.
