"""Split the GHS-POP R2023A 2025 epoch (30 arc-second, WGS 84) into 30 x 30 degree Cloud Optimised GeoTIFF tiles that the
browser reads directly from GitHub Pages. Source: European Commission JRC, GHS_POP_E2025_GLOBE_R2023A_4326_30ss V1-0,
CC BY 4.0 (Schiavina et al., 2023). Values are persons per cell, rounded to 0.1 (at most 0.05 persons per 1 km cell).
Tiles with no population are skipped. Usage: python3 pipeline/build_population.py data/ghs_pop_2025_30ss.tif data/population"""
import json, sys
from pathlib import Path
import numpy as np, rasterio
from rasterio.windows import from_bounds

src_path, out_dir = sys.argv[1], Path(sys.argv[2]); out_dir.mkdir(parents=True, exist_ok=True)
index = {"source": "GHS-POP R2023A, epoch 2025, 30 arc-second, WGS 84 (EC JRC, CC BY 4.0)", "tile_deg": 30, "rounding": 0.1,
         "units": "persons per cell", "tiles": []}
with rasterio.open(src_path) as src:
    for lat0 in range(-90, 90, 30):
        for lon0 in range(-180, 180, 30):
            win = from_bounds(lon0, lat0, lon0 + 30, lat0 + 30, src.transform).round_offsets().round_lengths()
            a = src.read(1, window=win, boundless=True, fill_value=0).astype("float32")
            a[~np.isfinite(a) | (a < 0)] = 0
            total = float(a.sum())
            if total <= 0: continue
            a = np.round(a, 1)
            name = f"pop2025_{'N' if lat0 >= 0 else 'S'}{abs(lat0):02d}_{'E' if lon0 >= 0 else 'W'}{abs(lon0):03d}.tif"
            prof = dict(driver="COG", dtype="float32", count=1, width=a.shape[1], height=a.shape[0], crs="EPSG:4326",
                        transform=src.window_transform(win), compress="DEFLATE", predictor=3, level=9, blocksize=256,
                        overviews="NONE", nodata=None)
            with rasterio.open(out_dir / name, "w", **prof) as dst: dst.write(a, 1)
            index["tiles"].append({"file": name, "west": lon0, "south": lat0, "east": lon0 + 30, "north": lat0 + 30,
                                   "persons": round(total)})
            print(name, round(total), (out_dir / name).stat().st_size // 1024, "KB", flush=True)
(out_dir / "index.json").write_text(json.dumps(index, indent=1))
print("total persons", sum(t["persons"] for t in index["tiles"]))
