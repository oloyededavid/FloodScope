# FloodScope methodology

Version 1.0.0. The code that implements each step is named in brackets. The browser engine (`js/`) and the independent Python reference (`pipeline/reference.py`) implement the same rules. They are compared in `docs/test-report.md`.

## 1. Question

Which land became open water between two Sentinel-1 radar acquisitions? Of that water, how much falls on modelled population, on each land-cover class and in each administrative area?

FloodScope maps **change to open water seen by C-band radar**. Its outputs are not:
- a flood depth;
- a count of people affected;
- a damage estimate.

## 2. Inputs

| Input | Use | Access |
|---|---|---|
| Sentinel-1 RTC, VV and VH gamma0, linear power, 10 m, UTM | Before and after backscatter | Microsoft Planetary Computer STAC `sentinel-1-rtc`, read as COG windows with a short-lived token from the PC SAS API |
| JRC Global Surface Water v1.3 occurrence (1984–2020), 30 m | Permanent water mask | PC `jrc-gsw`, asset `occurrence` |
| Copernicus DEM GLO-30, 30 m (pixel-is-point) | Slope mask | PC `cop-dem-glo-30` |
| ESA WorldCover 2021 v200, 10 m | Land cover of flooded pixels | PC `esa-worldcover` |
| GHS-POP R2023A epoch 2025, 30″, persons per cell | Modelled residents | Tiles in `data/population/`, made by `pipeline/build_population.py` |
| geoBoundaries gbOpen ADM2 (else ADM1) | Breakdown by area | geoBoundaries API, GeoJSON via media.githubusercontent.com |

## 3. Pre-processing

1. **Comparable pair.** Before and after must share the relative orbit and pass, and before must be earlier (`pipeline.runAnalysis`). This keeps incidence angle and terrain geometry the same, so a change in backscatter is not an artefact of a different view. Slices of one datatake are merged into one acquisition (`pipeline.listAcquisitions`), so an area across a slice boundary is read from both slices. Scenes without VV (HH/HV over polar regions) are not offered. The analysis is limited to 56° S – 78° N, the coverage of the permanent-water layer.
2. **Grid.**
   - The grid uses the after scene's UTM zone (from the STAC `proj:epsg`), with its origin snapped to multiples of the resolution (`engine.makeGrid`).
   - Resolution is 20 m for areas up to 900 km² and 40 m up to 3,600 km². Larger areas are refused (`engine.resolutionFor`).
   - The area is the user's rectangle. Pixels whose centre lies outside it are no-data (`engine.rasterisePolygons`).
3. **Radar onto the grid.**
   - Linear power is averaged from the native 10 m pixels whose centres fall in each grid pixel (`io.readToGrid`, method `average`), at both 20 m and 40 m. The provider's overviews are not used, because their resampling is not documented.
   - Large grids are read in bands of rows to keep memory small.
   - Averaging power is the multilooking step of SAR processing. GDAL's `average` resampling gives the same values to 1e-7 relative at 20 m and at 40 m, banded reading included (`docs/validation/reader-vs-gdal.txt`).
4. **Other layers onto the grid.**
   - GSW, WorldCover and population use nearest neighbour; the DEM uses bilinear.
   - Grid pixel centres are transformed to each file's CRS with proj4 on a lattice every 16 pixels and interpolated in between.
   - Copernicus DEM tie points are pixel centres (GeoTIFF `PixelIsPoint`), so the origin is moved half a pixel, as GDAL does.
5. **Speckle.** A 3 × 3 focal mean of linear power, NaN-aware (`engine.focalMean`), then conversion to dB (`engine.toDb`). At 20 m the window is 60 m.
6. **Slope.** Horn's (1981) method on the DEM resampled to the grid, in degrees (`engine.slopeDeg`).

## 4. Classification rule (`engine.classify`)

Applied per pixel, in this order:

| Class | Rule |
|---|---|
| 0 no data | VV before or after missing |
| 4 permanent water | GSW occurrence ≥ 80% (values above 100, i.e. no data, are ignored) |
| 5 excluded: slope | slope > 5° |
| 2 flood, high confidence | VV after < T **and** VV after − VV before ≤ −3 dB **and** VH after − VH before ≤ −3 dB |
| 3 flood, medium confidence | as above, but the VH condition fails or VH is missing |
| 6 water before | VV before < T (dark before, without the flood change) |
| 1 dry | everything else |

**Threshold T:**
- The default is −18 dB on VV gamma0. It is a fixed, adjustable default, the threshold used in the author's Lower Niger–Benue flood study. Section 9 shows how much the result depends on it.
- With the automatic option, T is the Otsu (1979) threshold of VV after (0.1 dB bins, −30 to 0 dB). It is computed over pixels that are neither permanent water nor steep.
- The Otsu value is used only if all three hold:
  1. **Two peaks.** The histogram is smoothed with a 1 dB moving average. The lowest bin between the highest bin below T and the highest bin above T must be at most half the lower of those two peaks (the "valley ratio"). Otsu's between-class variance ratio is not used as the test, because a single normal peak already scores about 0.64 on it (unit test `otsu: one normal peak`).
  2. **Enough water.** The smaller class holds at least 2% of the pixels.
  3. **Plausible range.** T lies between −24 and −14 dB.

  Otherwise the default is used and the reasons are reported.
- Where the maximum of the between-class variance is a plateau, T is its middle.
- The user can change T, the change limit, the slope limit and the permanence limit after a run. Changing them reclassifies the stored arrays without reading the data again (`pipeline.reclassify`).

**Why change detection:**
- Calm water is a specular reflector and looks dark. So do smooth dry surfaces: sand, tarmac, some bare or burnt ground.
- Requiring a drop of at least 3 dB since before removes surfaces that were already dark. These are reported separately as "water before".
- The rule combines a post-event water threshold with a change test against a reference image of the same geometry. The VH test raises confidence, because cross-polarised backscatter over open water is very low and drops strongly when land floods.

## 5. Exposure (`engine.summarise`)

- **Areas:** ground areas. Each UTM pixel's map area (resolution²) is divided by k², where k is the UTM point scale factor at the column's easting, k = 0.9996 · (1 + (E − 500,000)² / (2R²)) (`engine.utmScale`). Without the correction the error would reach about 0.2% at the edge of the zone. GeoJSON and GeoTIFF outputs are in map units, so their areas in UTM are map areas.
- **Modelled residents:**
  - Each grid pixel takes the GHS-POP count of the 30″ cell containing its centre, divided by that cell's area. The cell area uses the exact formula for an ellipsoidal quadrangle on WGS 84, at the latitude of the pixel's row band of 32 rows (`engine.cellAreaKm2`).
  - Check: the modelled residents in the Lokoja box (554,219) match the GHS-POP cells over the same box, with edge cells weighted by the fraction inside (553,933), to 0.05% (`docs/validation/population-conservation.txt`).
  - This density is multiplied by the pixel area and summed over flood pixels.
  - This spreads each cell's population evenly within the cell. It estimates residents of the flooded ground, not people affected.
- **Land cover:** flood area by ESA WorldCover class.
- **Administrative areas:**
  - Polygons are rasterised on the grid by pixel centre with the even-odd rule.
  - Only the part of each area inside the analysis rectangle is counted.

## 6. Outputs

| Output | Content |
|---|---|
| GeoTIFF | UInt8 class grid, UTM CRS of the run, nodata 0 |
| GeoJSON | Flood classes 2 and 3 traced exactly along pixel edges (`exports.traceMask`), reprojected to WGS 84 vertex by vertex, outer rings counter-clockwise and holes clockwise. Pixels touching only at a corner become separate polygons, and pinched rings are split, so every polygon is valid. |
| CSV | Every summary figure and run parameter |
| JSON | Processing metadata: scene IDs and dates, CRS, resolution, parameters, threshold and its source, data sources, the step log with timings, software version |
| PNG | The map as shown, with a caption and the data sources |
| PDF | The browser's print of a report page built from the same summary |

## 7. Uncertainty and limits

- **Missed water:**
  - Under tree canopy, and among flooded crops or tall grass, radar double-bounce brightens the signal.
  - In built-up areas, building double-bounce does the same.
  - Shallow water with emerging vegetation.
- **False water:** surfaces that became smooth, dry or burnt between the dates; wet snow, which is outside the method's intended use.
- **Timing:** Sentinel-1 revisits every 12 days from December 2021, when Sentinel-1B failed, until Sentinel-1C entered service in 2025. A single after image can miss the peak.
- **Threshold sensitivity:** the result depends on T. For the Lokoja example the flood area runs from 9.6 km² at −20 dB to 39.9 km² at −14 dB (table in section 9).
- **Population:** 1 km cells and modelled 2025 estimates, uniform within each cell.
- **Areas are capped** at 3,600 km² to fit in browser memory.

## 8. Verification (summary; full results in `docs/test-report.md`)

1. **Unit tests** of every engine function, against values worked out by hand (`tests/engine_test.mjs`, `tests/trace_test.mjs`).
2. **Reader against GDAL:** the same grid read by `io.readToGrid` (nearest, full resolution) and by rasterio `WarpedVRT` (`tests/geometry_check.*`).
3. **Engine against an independent Python implementation** (rasterio, scipy and pyproj; projection factors from `pyproj.Proj.get_factors`, cell areas from `pyproj.Geod`) on the Lokoja case (`pipeline/reference.py`).
   - Population conservation against direct GHS-POP sums (`docs/validation/population-conservation.txt`).
4. **Exports:**
   - GeoTIFF read by GDAL;
   - GeoJSON validity and area checked with shapely and pyproj against the class grid.
5. **Agreement with UNOSAT** VIIRS water for 13–17 October 2022 (`pipeline/compare_unosat.py`). This is another satellite product, so the comparison measures agreement, not accuracy.
6. **The full user journey in headless Chromium** (`tests/browser_e2e.cjs`).

## 9. Lokoja example, threshold and date sensitivity

The analysis area is 6.70–6.85° E, 7.70–7.85° N. "Before" is 2 August 2022, from Sentinel-1A on ascending relative orbit 30. Agreement is measured against UNOSAT all water (flood plus permanent), at 20 m, over 220.2 km² observed by both products.

| After | T (dB) | Flood (km²) | FloodScope water confirmed by UNOSAT | UNOSAT water found by FloodScope |
|---|---|---|---|---|
| 13 Oct 2022 | −20 | 9.62 | 99.9% | 32.0% |
| 13 Oct 2022 | −18 (default) | 22.40 | 99.9% | 50.2% |
| 13 Oct 2022 | −16 | 32.52 | 99.8% | 59.9% |
| 13 Oct 2022 | −15 | 36.30 | 99.8% | 63.4% |
| 13 Oct 2022 | −14 | 39.94 | 99.7% | 66.6% |
| 25 Oct 2022 | −18 | 5.75 | 99.9% | 35.8% |

The full table, including 25 October at every threshold, is in `docs/validation/sensitivity-unosat.csv`. Flood areas are ground areas. Agreement is computed on pixel counts.

**Reading:**
- Nearly all of the water FloodScope maps is also water in UNOSAT's product.
- FloodScope misses part of UNOSAT's water. Four likely reasons:
  1. UNOSAT accumulates five days, while FloodScope uses one image.
  2. UNOSAT's 375 m pixels widen water edges.
  3. Flooded vegetation, which C-band radar does not see as dark.
  4. The conservative default threshold.
- The default stays at −18 dB rather than being tuned to this one comparison. The sensitivity is reported here and the threshold can be dragged in the interface.

## References

- Horn, B. K. P. (1981). Hill shading and the reflectance map. *Proceedings of the IEEE*, 69(1), 14–47.
- Otsu, N. (1979). A threshold selection method from gray-level histograms. *IEEE Transactions on Systems, Man, and Cybernetics*, 9(1), 62–66.
- Pekel, J.-F., Cottam, A., Gorelick, N., & Belward, A. S. (2016). High-resolution mapping of global surface water and its long-term changes. *Nature*, 540, 418–422.
- Runfola, D., et al. (2020). geoBoundaries: A global database of political administrative boundaries. *PLoS ONE*, 15(4), e0231866.
- Schiavina, M., Freire, S., Carioli, A., & MacManus, K. (2023). GHS-POP R2023A – GHS population grid multitemporal (1975–2030). European Commission, Joint Research Centre.
- Zanaga, D., et al. (2022). ESA WorldCover 10 m 2021 v200. Zenodo. https://doi.org/10.5281/zenodo.7254221
