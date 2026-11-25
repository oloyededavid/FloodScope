# FloodScope test report

Run on 23 November 2026. Each row gives the test, the expected and actual result, and the file holding the evidence (under `docs/validation/` unless stated).

| # | Test | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| 1 | Engine unit tests (focal mean, dB, Otsu with the valley test, slope, classification rule, summaries with ground areas, ellipsoidal cell area, UTM scale factor, grid, UTM zone, resolution cap, ring area, rasterisation) | All hand-worked or independently computed values reproduced | All pass | Pass | `unit-tests.txt` |
| 2 | Otsu two-peak test | Two separated groups pass; one normal peak (separation ratio 0.64) fails | Valley ratio < 0.05 and > 0.5 respectively | Pass | `unit-tests.txt` |
| 3 | Exact boundary tracing | Area equals pixel count; hole kept; corner-touching pixels separate | Area 26 of 26; 3 polygons, 1 hole. The independent review also fuzzed 3,000 random masks with 0 invalid geometries | Pass | `unit-tests.txt` |
| 4 | Reader against GDAL, nearest neighbour: Sentinel-1 VV and VH | Same values | 100% identical | Pass | `reader-vs-gdal.txt` |
| 5 | Reader against GDAL, nearest neighbour: Copernicus DEM (pixel-is-point), JRC GSW, WorldCover | Same except where a pixel centre falls on a source pixel edge | 99.57%, 99.92% and 99.93% identical. GDAL's warper approximates the transform to 0.125 pixel by default | Pass | `reader-vs-gdal.txt` |
| 6 | Reader against GDAL, radar power averaging at 20 m, at 40 m, and at 40 m over 1200 × 600 pixels (banded reading) | Same values as GDAL `average` | Maximum relative difference 1.2e-7 in all three | Pass | `reader-vs-gdal.txt` |
| 7 | Engine against the independent Python implementation, Lokoja 2 Aug → 13 Oct 2022 | Same grid; areas and population within 1% | Identical grid; class agreement 99.85%; flood IoU 0.9992; flood 22.4034 vs 22.4012 km² (ground area); residents in flood 4,987.1 vs 4,977.9 | Pass | `engine-vs-python.txt` |
| 8 | Population conservation | Residents in the box equal GHS-POP cells over the box | 554,219 vs 553,933 (0.05%) | Pass | `population-conservation.txt` |
| 9 | Acquisition list | Only real Sentinel-1 RTC acquisitions; slices of a datatake merged; truncation warned | 11 ascending orbit-30 acquisitions, 9 Jul – 18 Nov 2022 | Pass | `browser-e2e.txt` |
| 10 | Pair rule, area cap and latitude limit | Refused with a message | Enforced in `pipeline.runAnalysis`; the interface disables the run button. The cap is unit-tested; the latitude limit was checked by code review only | Pass (latitude limit by review) | `js/pipeline.js`, `unit-tests.txt` |
| 11 | Automatic threshold fallback | Falls back to −18 dB, never a previous run's value | The interface sends −18 as the fallback whenever the automatic threshold is on | Pass, by code review | `js/app.js` |
| 12 | GeoTIFF export | Readable by GDAL with the right CRS, origin and pixel size | EPSG:32632, origin (246280, 868420), 20 m, Byte, nodata 0 | Pass | `exports-check.txt` |
| 13 | GeoJSON export | Valid; area equals the class grid | Valid; 19.3656 and 3.0528 km² map area, equal to the grid | Pass | `exports-check.txt` |
| 14 | CSV and JSON exports | The run's own values | Flood 22.4034 km², residents 4,987.1, equal to the run | Pass | `exports-check.txt` |
| 15 | Whole user journey in headless Chromium, 1440 × 960 | Example runs; figures, histogram, land cover, admin table, exports and inspection work; no console errors | Run in 38.6 s (redesigned full-screen page); 4 LGAs; 5 downloads; threshold −20 dB updates the figures (9.62 km²); inspection shows values; no console errors | Pass | `browser-e2e.txt`, `docs/screenshots/` |
| 16 | Phone width, 390 px | No horizontal scrolling | 0 px | Pass | `browser-e2e.txt` |
| 17 | Agreement with UNOSAT VIIRS water, 13–17 Oct 2022 | Reported as agreement | 99.9% of FloodScope water confirmed; FloodScope finds 50.2% of UNOSAT water at −18 dB and 63.4% at −15 dB | Reported | `lokoja-2022-unosat.json`, `sensitivity-unosat.csv` |
| 18 | Honest error on failed data access | Error in the step log; no stale result shown | Results are cleared when a run starts; errors go to the log. Not forced in an automated test | Not tested | `js/app.js` |
| 19 | Deployed site | Same journey on GitHub Pages | Not deployed yet; pushing needs the owner's approval | Pending | — |

## Independent review
A separate review agent read the code and docs and fuzzed the tracer. It found no critical bug, and its findings were fixed:
- the Otsu gate now tests for two peaks;
- the fallback threshold can no longer leak from a previous run;
- coverage limits are stated and enforced;
- radar averaging is verified against GDAL at both resolutions;
- the token-safe file cache;
- interface race conditions;
- slice merging and truncation warnings;
- the GSW no-data guard;
- UTM area correction;
- ellipsoidal cell areas and the conservation check;
- wording fixes;
- the CSV formula guard.

## Not tested
- Place search and administrative boundaries outside Nigeria.
- Mobile touch drawing on a real device.
- Acquisitions from 2014–2015 and areas near 56° S or 78° N.
- An area across two datatake slices (the merging code path is reviewed, not run).

## Version 1.1.0 (interface upgrade), 25 November 2026

| # | Test | Expected | Actual | Result |
|---|---|---|---|---|
| 20 | `tests/fixture_lokoja.mjs`: whole pipeline on a 2 × 2 km box inside the Lokoja example, every network response replayed from `tests/fixtures/lokoja-small/` (18 MB) | identical scene IDs, threshold, grid, class-grid SHA-256, areas and residents | 11 of 11 identical, offline | Pass |
| 21 | Engine and tracing unit tests after the upgrade | pass | pass | Pass |
| 22 | Lokoja example in headless Chromium, 1440 × 900, live archive | 22.4 km², 4,987 modelled residents, Reading, threshold note, residents marked as an estimate | as expected, 32 s | Pass |
| 23 | "Link to this analysis" opened in a new page | same images and result | 22.4 / 19.4 km², 4,987, 20.9 km² | Pass |
| 24 | Map image and GeoTIFF downloads | legend, scale, limits on the image; GeoTIFF readable | as expected | Pass |
| 25 | axe before and after a run; phone 390 px | 0 violations; legend collapsed; no overflow | 0; collapsed; 0 px | Pass |
| 26 | Search "Nigeria" | box labelled as 20 × 20 km around the centre point | "20 × 20 km around Nigeria … not the whole country" | Pass |

### 1.1.1 (after the independent review)

| # | Check | Expected | Result | Status |
|---|---|---|---|---|
| 27 | Fixed-input Lokoja test after the 1.1.1 changes | all 11 values and the class-grid hash unchanged | identical | Pass |
| 28 | Unit tests (`npm test`) | pass | all passed | Pass |
| 29 | Example button in the side panel at 1440 px | label not cut off | "Example", 103 of 103 px, accessible name "Run the Lokoja example" | Pass |

Changes in 1.1.1: the Areas tab gives the reason when administrative areas could not be loaded, and the boundary requests time out (20 s and 30 s); the land-cover sentence says "the largest share" rather than "most"; the minus sign is applied to the threshold only, so the satellite name keeps its hyphen; summary CSV numbers are written to six decimal places at most; the medium-confidence legend row says it is shown with the row above. The analysis is unchanged.

Phone map overlays (after 1.1.1, same version): at 860 px and below the scale bar sits bottom-left above the Legend chip, the map credits start closed behind the i button, and layer chips stay in one scrolling row. Checked at 390 px after an example run: no overlapping overlays; axe 0 violations.
