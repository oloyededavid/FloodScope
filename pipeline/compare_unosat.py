"""Compare a FloodScope class grid with UNOSAT's VIIRS satellite-detected water for 13-17 October 2022 (FL20221019NGA).

UNOSAT is another satellite product (VIIRS, 375 m), not ground truth, so the output reports agreement, not accuracy.
Inputs: the class grid exported by FloodScope (GeoTIFF) and the unzipped UNOSAT shapefile folder
(https://unosat.org/static/unosat_filesystem/3418/FL20221019NGA_SHP.zip, CC BY-SA).
Usage: python3 pipeline/compare_unosat.py CLASSES.tif UNOSAT_SHP_DIR OUT.json"""
import json, sys
import numpy as np, rasterio, geopandas as gpd
from rasterio.features import rasterize
from shapely.geometry import box

tif, shp_dir, out = sys.argv[1:4]
with rasterio.open(tif) as src:
    cls, T, crs, (h, w) = src.read(1), src.transform, src.crs, src.shape
    bounds = src.bounds
def layer(name):
    g = gpd.read_file(f"{shp_dir}/VIIRS_20221013_20221017_{name}_Nigeria.shp").to_crs(crs)
    g = g.clip(box(*bounds))
    if g.empty: return np.zeros((h, w), bool)
    return rasterize([(geom, 1) for geom in g.geometry if geom is not None and not geom.is_empty], out_shape=(h, w), transform=T, fill=0).astype(bool)
u_flood, u_perm, u_cloud, u_extent = layer("MaximumFloodWaterExtent"), layer("PermanentWater"), layer("CloudObstruction"), layer("AnalysisExtent")

valid = (cls != 0) & (cls != 5) & u_extent & ~u_cloud          # both products observed the pixel; slopes excluded by FloodScope
ours_flood = np.isin(cls, [2, 3, 6])                              # water now and not permanent: new flood plus water already there in August
ours_water = np.isin(cls, [2, 3, 4, 6])
km2 = abs(T.a * T.e) / 1e6
def cmp(a, b, block=1):
    if block > 1:  # compare water fractions in block x block cells, both rounded to presence at >= 50 %
        H, W = (h // block) * block, (w // block) * block
        f = lambda m: m[:H, :W].reshape(H // block, block, W // block, block).mean(axis=(1, 3))
        v = f(valid) >= 0.5
        a, b = (f(a & valid) >= 0.5 * f(valid)) & v, (f(b & valid) >= 0.5 * f(valid)) & v
        msk = v
    else:
        a, b, msk = a & valid, b & valid, valid
    tp, fp, fn = int((a & b).sum()), int((a & ~b & msk).sum()), int((~a & b & msk).sum())
    tn = int(msk.sum()) - tp - fp - fn
    return {"cells": int(msk.sum()), "both": tp, "floodscope_only": fp, "unosat_only": fn, "neither": tn,
            "agreement": round((tp + tn) / max(1, msk.sum()), 4), "iou": round(tp / max(1, tp + fp + fn), 4),
            "share_of_unosat_found": round(tp / max(1, tp + fn), 4), "share_of_floodscope_confirmed": round(tp / max(1, tp + fp), 4)}
res = {
    "reference": "UNOSAT FL20221019NGA, VIIRS cumulative satellite-detected water 13-17 Oct 2022 (CC BY-SA). Not ground truth.",
    "floodscope_grid": {"file": tif, "resolution_m": abs(T.a), "crs": str(crs)},
    "compared_area_km2": round(float(valid.sum() * km2), 3),
    "area_km2": {"floodscope_flood_and_water_before": round(float((ours_flood & valid).sum() * km2), 3),
                 "unosat_flood": round(float((u_flood & valid).sum() * km2), 3),
                 "floodscope_all_water": round(float((ours_water & valid).sum() * km2), 3),
                 "unosat_flood_and_permanent": round(float(((u_flood | u_perm) & valid).sum() * km2), 3)},
    "flood_20m": cmp(ours_flood, u_flood),
    "all_water_20m": cmp(ours_water, u_flood | u_perm),
    "all_water_400m_blocks": cmp(ours_water, u_flood | u_perm, block=20),
}
json.dump(res, open(out, "w"), indent=1); print(json.dumps(res, indent=1))
