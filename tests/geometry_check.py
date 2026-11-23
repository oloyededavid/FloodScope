"""Compare the browser reader (nearest neighbour, full resolution) with GDAL on the same grid. Usage: see test_report.md."""
import sys, numpy as np, rasterio, planetary_computer as pc, pystac_client
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from rasterio.transform import from_origin
coll, asset, day, x0, y1, crs, res, w, h, js = sys.argv[1:11]
method = sys.argv[11] if len(sys.argv) > 11 else 'nearest'
x0, y1, res, w, h = float(x0), float(y1), float(res), int(w), int(h)
cat = pystac_client.Client.open("https://planetarycomputer.microsoft.com/api/stac/v1", modifier=pc.sign_inplace)
kw = {} if day == "-" else {"datetime": f"{day}T00:00:00Z/{day}T23:59:59Z"}
it = list(cat.search(collections=[coll], bbox=[6.70, 7.70, 6.85, 7.85], **kw).items())[0]
with rasterio.open(it.assets[asset].href) as src, WarpedVRT(src, crs=f"EPSG:{crs}", transform=from_origin(x0, y1, res, res), width=w, height=h,
                                                        resampling=getattr(Resampling, method), src_nodata=src.nodata, nodata=np.nan, dtype="float32") as v:
    g = v.read(1)
a = np.fromfile(js, dtype="float32").reshape(h, w)
both = ~np.isnan(a) & ~np.isnan(g)
rel = np.abs(a[both] - g[both]) / np.maximum(np.abs(g[both]), 1e-12)
print(it.id, method, f"{res:g} m", "valid js", (~np.isnan(a)).sum(), "gdal", (~np.isnan(g)).sum(), "identical values", round(float((a[both] == g[both]).mean()), 5),
      "max relative difference", float(rel.max()), "median", float(np.median(rel)))
