# FloodScope test report

Run on 23 November 2026. Each row gives the test, the expected and actual result, and the file holding the evidence (under `docs/validation/` unless stated).

| # | Test | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| 1 | Engine unit tests: focal mean, dB, Otsu, slope, classification rule, summaries, cell area, grid, UTM zone, resolution cap, ring area, rasterisation | All hand-worked values reproduced | 30 of 30 pass | Pass | `unit-tests.txt` |
| 2 | Exact boundary tracing: block with a hole, an isolated pixel, a corner-touching pixel | Area equals pixel count; hole kept; corner-touching pixels separate | Area 26 of 26; 3 polygons, 1 hole | Pass | `unit-tests.txt` |
| 3 | Reader against GDAL: Sentinel-1 RTC VV (13 Oct 2022) and VH (2 Aug 2022), nearest neighbour, 400 × 300 pixels | Same values at every pixel | 100% identical, both bands | Pass | `reader-vs-gdal.txt` |
| 4 | Reader against GDAL: Copernicus DEM (pixel-is-point), JRC GSW and WorldCover (geographic) | Same values except where a pixel centre falls on a source pixel edge | 99.57%, 99.92% and 99.93% identical. GDAL's warper itself approximates the transform to 0.125 pixel by default | Pass | `reader-vs-gdal.txt` |
| 5 | Engine against the independent Python implementation, Lokoja 2 Aug → 13 Oct 2022 | Same grid; flood area and population within 1% | Identical grid (833 × 835, 20 m, EPSG:32632); class agreement 99.85%; flood IoU 0.9992; flood 22.4184 vs 22.4164 km²; residents in flood 4,969.5 vs 4,960.4 | Pass | `engine-vs-python.txt` |
| 6 | Acquisition dates match the archive | Only real Sentinel-1 RTC scenes listed | 11 ascending orbit-30 scenes, 9 Jul – 18 Nov 2022, as returned by the Planetary Computer STAC API | Pass | `browser-e2e.txt` and the STAC search |
| 7 | Pair rule | Before and after on different tracks or in the wrong order are refused | Enforced in `pipeline.runAnalysis`; the interface disables non-matching dates | Pass, by code review and in the interface | `js/pipeline.js`, `js/app.js` |
| 8 | Area cap | Over 3,600 km² refused | `resolutionFor(5000) === null`, unit-tested; the interface disables the run button | Pass | `unit-tests.txt` |
| 9 | Permanent-water filtering | GSW occurrence ≥ 80% becomes class 4 and is never flood | Unit test; 20.89 km² permanent water in the example | Pass | `unit-tests.txt`, `engine-vs-python.txt` |
| 10 | Area units | km² from pixel count × 400 m² | GeoTIFF flood pixels × 400 m² = 22.4184 km², equal to the figure shown | Pass | GeoTIFF check below |
| 11 | GeoTIFF export | Readable by GDAL, correct CRS, origin and pixel size | EPSG:32632, origin (246280, 868420), 20 m, UInt8, nodata 0 | Pass | `gdalinfo` |
| 12 | GeoJSON export | Valid geometry; area equals the class grid | Both classes valid (shapely); areas 19.3656 and 3.0528 km², equal to the grid | Pass | Check in this report's run |
| 13 | CSV, JSON and PNG exports | Contain the run's own values | CSV areas and population equal the summary; JSON holds scene IDs, parameters and the log | Pass | `tests/out/` from the browser run |
| 14 | Whole user journey in headless Chromium, 1440 × 960 | Example runs; figures, histogram, land cover, admin table, exports and inspect all work; no console errors | Run in 32.2 s; 4 LGAs; 5 downloads; threshold change to −20 dB updates figures (9.63 km²); pixel inspection shows values; no console errors | Pass | `browser-e2e.txt`, `docs/screenshots/` |
| 15 | Phone width, 390 px | No horizontal scrolling | 0 px overflow | Pass | `browser-e2e.txt` |
| 16 | Agreement with UNOSAT VIIRS water, 13–17 Oct 2022 | Reported as agreement, not accuracy | 99.9% of FloodScope water also in UNOSAT; FloodScope finds 50.2% of UNOSAT water at −18 dB and 63.4% at −15 dB | Reported | `lokoja-2022-unosat.json`, methodology section 9 |
| 17 | Failed data access gives an honest error | The step log shows the error; no result is drawn | Implemented (worker error → log line in red). Not forced in an automated test | Not tested | `js/worker.js`, `js/app.js` |
| 18 | Deployed site | Same journey on GitHub Pages | Not deployed yet; needs the owner's approval to push | Pending | — |

## Not tested
- Place search (Nominatim) and administrative boundaries for countries other than Nigeria.
- Areas crossing a UTM zone edge far from the after scene's zone. The grid uses the after scene's zone, so pixel areas are inexact there by the UTM scale error, under 0.1% within the zone.
- Mobile touch drawing on a real device; tested only with mouse events.
- Very old acquisitions (2014–2015) and polar regions.
