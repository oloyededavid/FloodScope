# FloodScope: interface notes

## Version 1.2.0: interface rebuilt as a guided product (27 November 2026)

Rebuilt to the same pattern as AgroSignal 1.2.0, so the tools read as one product family. The flood rule and every number are unchanged except for one engine fix (below); `tests/fixture_lokoja.mjs` checks this.

| Before | Now |
|---|---|
| Accordion steps, a four-tab evidence panel, an intro block and a downloads menu | An opening screen (headline, search, the Lokoja example, a card showing a real result), a three-screen tour on first use, and a stepper: Place, Images, Result |
| Dates fixed at July to November 2022 for every place | The last 60 days by default, so a recent flood needs no date change; the page says to set the dates around the flood |
| Image list in a separate tab | The image dates sit in the Images step as chips per track; a card shows the chosen pair and the days between them |
| Rules and the administrative-area switch on the main form | Under Advanced settings; moving the threshold slider switches the automatic threshold off, as dragging the histogram already did |
| A progress log | Four plain stages with a bar and Cancel |
| Reading, four figure boxes, a limits paragraph, four tabs | The area of new water as the headline, one sentence, three figures, the UNOSAT check for the example only, the threshold histogram (drag to test), the flooded land cover, then areas, limits and run details folded away |
| Legend chips over the map | One Map layers card, closed by default on phones |

Engine fix found while testing the rebuild: Sentinel-1 RTC items from 2025 on give their projection as `proj:code` ("EPSG:32632", STAC projection extension v2) instead of `proj:epsg`. The page read only `proj:epsg`, so any recent pair failed with "Unsupported CRS EPSG:undefined". `pipeline.js` now reads either (`epsgOf`, tested in `tests/stac_fields_test.mjs`). Every 2022 result is unchanged.

The landing card is built from a real Lokoja run's own exports by `tools/make_preview.py` (`assets/preview.json`, `assets/preview-map.webp`), so no figure on it is typed by hand.

## Version 1.1.0
Version 1.1.0, November 2026. What changed in the interface, why, and what is still open. The analysis (`js/engine.js`, `js/pipeline.js`) is unchanged; `tests/fixture_lokoja.mjs` replays fixed inputs and checks the class grid hash and the areas.

| Change | Why (audit finding) |
|---|---|
| The residents figure is labelled as an estimate ("GHS-POP 2025 model, not people affected") where it is read, and the Reading says it is exposure, not a count of people affected | The caveat was only in the Areas tab (FS-1) |
| A Reading under the figures: what changed, between which dates, how much, where most of it lies, the threshold and how to test it; for the Lokoja example the UNOSAT agreement and threshold sensitivity; what the map does not show | Results were labelled but not read (FS-3, FS-11) |
| A sentence under the histogram explains why the automatic threshold was used or not, rebuilt from the run's own statistics with the rule in `pipeline.js` | "Automatic split not usable here" looked arbitrary beside a two-peaked histogram (FS-2) |
| A searched place is labelled "20 × 20 km around …"; for countries and regions the box is explained as a box around the centre point, not the whole area | "Nigeria, 401 km²" read as the whole country (FS-4) |
| On phones the legend starts collapsed and the pixel card is a bottom sheet | The map was covered (FS-6) |
| Opening screen with what the tool returns and "Run the Lokoja example"; on phones the purpose comes first | Empty figures and form-first (FS-7) |
| Map image export: legend, scale bar, method line, limits and full attribution, wrapped to the image width | The image had no legend or scale and a cut-off attribution (EX-1) |
| Class codes and limits in the statistics CSV and the processing record | The GeoTIFF's values could not be read elsewhere (EX-2, EX-3); the bundled GeoTIFF writer cannot write description tags, so the key travels in those two files |
| "Link to this analysis": area, dates, the two image IDs and the rules in the address; opening it runs the analysis again | Runs could not be shared or reopened (EX-5) |
| Histogram slider announces its value and the resulting area | `aria-valuenow` was missing |
| Tools menu; "Back to portfolio" opens the tools | PI-1, PI-2 |

Still open: other validated examples outside Nigeria (each needs its own independent comparison before it can be called validated); administrative areas depend on geoboundaries.org.
