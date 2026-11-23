# FloodScope data register

All access was tested from the build environment on 23 November 2026. "Browser access" means the server returned CORS headers that let a web page read the data (`Access-Control-Allow-Origin: *`), and range requests worked.

| Layer | Product | Provider and access | Licence | Coverage | Resolution and CRS | Limitations | Status |
|---|---|---|---|---|---|---|---|
| Radar | Sentinel-1 RTC, VV and VH gamma0, linear | Microsoft Planetary Computer, STAC `sentinel-1-rtc`; COGs on Azure Blob with a token from `/api/sas/v1/token/sentinel-1-rtc` (no account). Browser access: yes | CC BY 4.0 (collection metadata); contains modified Copernicus Sentinel data | Global land, from 10 Oct 2014 | 10 m, UTM per scene | Terrain-corrected by the provider; one platform with a 12-day revisit from Dec 2021 until Sentinel-1C (2025) | Approved |
| Permanent water | JRC Global Surface Water v1.3, occurrence | PC STAC `jrc-gsw`, asset `occurrence`. Browser access: yes | Free use with attribution (EC JRC/Google; Pekel et al., 2016) | 56° S – 78° N (STAC extent), 1984–2020 | 30 m (0.00025°), EPSG:4326 | Ends 2020; rivers that moved since then are not masked | Approved |
| Terrain | Copernicus DEM GLO-30 | PC STAC `cop-dem-glo-30`, asset `data`. Browser access: yes | Copernicus DEM licence (free, with the attribution shown in the README) | Global | 1″ (~30 m), EPSG:4326, pixel-is-point | Surface model (includes trees and buildings) | Approved |
| Land cover | ESA WorldCover 2021 v200 | PC STAC `esa-worldcover`, asset `map`. Browser access: yes | CC BY 4.0 | 60° S – 82.75° N (STAC extent) | 10 m, EPSG:4326 | 2021 snapshot | Approved |
| Population | GHS-POP R2023A, epoch 2025 | Downloaded from the JRC FTP (`GHS_POP_E2025_GLOBE_R2023A_4326_30ss_V1_0.zip`); split into 56 tiles of 30° by `pipeline/build_population.py`; served with the app | CC BY 4.0 | Global; tiles total 8,191,988,442 persons | 30″ (~1 km), EPSG:4326 | 2025 is a modelled epoch; counts rounded to 0.1 person per cell | Approved |
| Boundaries | geoBoundaries gbOpen, ADM2 or ADM1 | API `www.geoboundaries.org/api/current/gbOpen/{ISO3}/{ADM}/` (browser access: yes); GeoJSON from `media.githubusercontent.com` (browser access: yes) | Per country, stated in the API response (Nigeria: GRID3, CC BY 4.0) | Global | Simplified polygons | Simplified; only the part inside the analysis box is counted | Approved |
| Country code | ISO 3166-1 alpha-2 to alpha-3 | `data/iso2-iso3.json`, generated from pycountry | ISO codes | 249 countries | — | — | Approved |
| Place search | Nominatim | `nominatim.openstreetmap.org` (browser access: yes); on submit only, per its usage policy | ODbL | Global | — | Rate-limited to one request per second | Approved |
| Basemap | OpenFreeMap Positron | `tiles.openfreemap.org` (browser access: yes) | ODbL (data); attribution shown | Global | Vector tiles | — | Approved |
| Satellite basemap (optional) | Sentinel-2 cloudless 2024, EOX | `tiles.maps.eox.at` (browser access: yes for this site's origin) | CC BY-NC-SA 4.0 | Global | 10 m mosaic | Non-commercial licence | Approved for this non-commercial site |
| Cross-check | UNOSAT FL20221019NGA, VIIRS water 13–17 Oct 2022 | unosat.org shapefile, via HDX | CC BY-SA | Nigeria | 375 m | Another satellite product, not ground truth | Used offline in `pipeline/compare_unosat.py` only |

## Rejected or deferred
- **Roads (OpenStreetMap or Overture Maps).** The Overpass API and Geofabrik were refused from the build environment, so a browser roads layer could not be tested. Overture's GeoParquet would need a large in-browser engine. Deferred to a later version.
- **Building footprints (Microsoft, Google).** Deferred for the same reason. The WorldCover built-up class is reported instead.
- **WorldPop.** Its global COGs did not return CORS headers for browser access. GHS-POP was used, served from this site.
