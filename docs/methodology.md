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

1. **Comparable pair.** Before and after must share the relative orbit and pass, and before must be earlier (`pipeline.runAnalysis`). This keeps incidence angle and terrain geometry the same, so a change in backscatter is not an artefact of a different view.
2. **Grid.**
   - The grid uses the after scene's UTM zone (from the STAC `proj:epsg`), with its origin snapped to multiples of the resolution (`engine.makeGrid`).
   - Resolution is 20 m for areas up to 900 km² and 40 m up to 3,600 km². Larger areas are refused (`engine.resolutionFor`).
   - The area is the user's rectangle. Pixels whose centre lies outside it are no-data (`engine.rasterisePolygons`).
3. **Radar onto the grid.**
   - Linear power is averaged from the 10 m pixels whose centres fall in each grid pixel (`io.readToGrid`, method `average`). For a 40 m grid this uses the 20 m overview.
   - Averaging power is the multilooking step of SAR processing. GDAL's `average` resampling gives the same result (section 8).
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
| 4 permanent water | GSW occurrence ≥ 80% |
| 5 excluded: slope | slope > 5° |
| 2 flood, high confidence | VV after < T **and** VV after − VV before ≤ −3 dB **and** VH after − VH before ≤ −3 dB |
| 3 flood, medium confidence | as above, but the VH condition fails or VH is missing |
| 6 water before | VV before < T (dark before, without the flood change) |
| 1 dry | everything else |

**Threshold T:**
- The default is −18 dB on VV.
- With the automatic option, T is the Otsu (1979) threshold of VV after (0.1 dB bins, −30 to 0 dB). It is computed over pixels that are neither permanent water nor steep.
- The Otsu value is used only if both conditions hold:
  - it lies within −24 to −14 dB;
  - the between-class variance is at least half the total variance, which indicates a clearly bimodal histogram.

  Otherwise the default is used and the reason is reported.
- Where the maximum of the between-class variance is a plateau, T is its middle.
- The user can change T, the change limit, the slope limit and the permanence limit after a run. Changing them reclassifies the stored arrays without reading the data again (`pipeline.reclassify`).

**Why change detection:**
- Calm water is a specular reflector and looks dark. So do smooth dry surfaces: sand, tarmac, some bare or burnt ground.
- Requiring a drop of at least 3 dB since before removes surfaces that were already dark. These are reported separately as "water before".
- This follows common Sentinel-1 practice: a post-event water threshold combined with a change test against a reference image. The VH test raises confidence, because cross-polarised backscatter over open water is very low and drops strongly when land floods.

## 5. Exposure (`engine.summarise`)

- **Areas:** pixel count × resolution², in km². The pixels are exact squares in the UTM projection. The UTM scale error is under 0.1% within the zone.
- **Modelled residents:**
  - Each grid pixel takes the GHS-POP count of the 30″ cell containing its centre, divided by that cell's area. The cell area is computed on a sphere of radius 6,371.0088 km at the latitude of the pixel row band (`engine.cellAreaKm2`).
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
- **Threshold sensitivity:** the result depends on T. For the Lokoja example the flood area runs from 9.6 km² at −20 dB to 40.0 km² at −14 dB (table in section 9).
- **Population:** 1 km cells and modelled 2025 estimates, uniform within each cell.
- **Areas are capped** at 3,600 km² to fit in browser memory.

## 8. Verification (summary; full results in `docs/test-report.md`)

1. **Unit tests** of every engine function, against values worked out by hand (`tests/engine_test.mjs`, `tests/trace_test.mjs`).
2. **Reader against GDAL:** the same grid read by `io.readToGrid` (nearest, full resolution) and by rasterio `WarpedVRT` (`tests/geometry_check.*`).
3. **Engine against an independent Python implementation** (rasterio, scipy) on the Lokoja case (`pipeline/reference.py`).
4. **Exports:**
   - GeoTIFF read by GDAL;
   - GeoJSON validity and area checked with shapely and pyproj against the class grid.
5. **Agreement with UNOSAT** VIIRS water for 13–17 October 2022 (`pipeline/compare_unosat.py`). This is another satellite product, so the comparison measures agreement, not accuracy.
6. **The full user journey in headless Chromium** (`tests/browser_e2e.cjs`).

## 9. Lokoja example, threshold and date sensitivity

The analysis area is 6.70–6.85° E, 7.70–7.85° N. "Before" is 2 August 2022, from Sentinel-1A on ascending relative orbit 30. Agreement is measured against UNOSAT all water (flood plus permanent), at 20 m, over 220.2 km² observed by both products.

| After | T (dB) | Flood (km²) | FloodScope water confirmed by UNOSAT | UNOSAT water found by FloodScope |
|---|---|---|---|---|
| 13 Oct 2022 | −20 | 9.63 | 99.9% | 32.0% |
| 13 Oct 2022 | −18 (default) | 22.42 | 99.9% | 50.2% |
| 13 Oct 2022 | −16 | 32.54 | 99.8% | 59.9% |
| 13 Oct 2022 | −15 | 36.33 | 99.8% | 63.4% |
| 13 Oct 2022 | −14 | 39.97 | 99.7% | 66.6% |
| 25 Oct 2022 | −18 | 5.76 | 99.9% | 35.8% |

**Reading:**
- Nearly all of the water FloodScope maps is also water in UNOSAT's product.
- FloodScope misses part of UNOSAT's water. Four likely reasons:
  1. UNOSAT accumulates five days, while FloodScope uses one image.
  2. UNOSAT's 375 m pixels widen water edges.
  3. Flooded vegetation, which C-band radar does not see as dark.
  4. The conservative default threshold.
- The default stays at −18 dB, a common value for VV water, rather than being tuned to this one comparison. The sensitivity is reported here and the threshold can be dragged in the interface.

## References

- Horn, B. K. P. (1981). Hill shading and the reflectance map. *Proceedings of the IEEE*, 69(1), 14–47.
- Otsu, N. (1979). A threshold selection method from gray-level histograms. *IEEE Transactions on Systems, Man, and Cybernetics*, 9(1), 62–66.
- Pekel, J.-F., Cottam, A., Gorelick, N., & Belward, A. S. (2016). High-resolution mapping of global surface water and its long-term changes. *Nature*, 540, 418–422.
- Runfola, D., et al. (2020). geoBoundaries: A global database of political administrative boundaries. *PLoS ONE*, 15(4), e0231866.
- Schiavina, M., Freire, S., Carioli, A., & MacManus, K. (2023). GHS-POP R2023A – GHS population grid multitemporal (1975–2030). European Commission, Joint Research Centre.
- Zanaga, D., et al. (2022). ESA WorldCover 10 m 2021 v200. Zenodo. https://doi.org/10.5281/zenodo.7254221
