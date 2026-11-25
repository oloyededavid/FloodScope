# FloodScope: interface notes

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
